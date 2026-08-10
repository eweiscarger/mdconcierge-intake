// bounce-scan.mjs — deliverability guardrail.
// Reads eric@ (read-only) for bounce notifications and spam complaints. Hard bounces
// and complaints are auto-suppressed silently (never emailed again). If the hard-bounce
// rate over the last 7 days crosses 5% (with enough volume), or any spam complaint
// lands, it AUTO-PAUSES sending (outreach_config.sending_paused) and alerts Eric.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { deriveState, pick, npiLookup, score, relocationDelta } from './npi.mjs';

const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ERIC_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY })) { if (!v) { console.error('Missing env: ' + k); process.exit(1); } }

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row, prefer = 'return=minimal') => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(row) }); if (!r.ok && r.status !== 409) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };
const daysAgoISO = (n) => new Date(Date.now() - n * 86400000).toISOString();

// Senders that actually report delivery failures. "no-reply" used to be in here and it was
// catastrophic: noreply-dmarc-support@google.com sends the daily DMARC aggregate report because
// our own DMARC record asks for it, and noreply@zohocalendar.com sends meeting reminders. Both
// were being filed as hard bounces, which invented a 5.2% failure rate out of nothing and
// auto-paused the entire campaign.
const BOUNCE_FROM = /mailer-daemon|mailerdaemon|postmaster|mail delivery (subsystem|system)|delivery.?(status|failure)/i;
// Routine machine mail that is emphatically not a bounce, regardless of who it came from.
const NOT_A_BOUNCE = /^report domain:|dmarc|aggregate report|invitation to .* accepted|^reminder:|^invitation:|^accepted:|^declined:|calendar/i;
const BOUNCE_SUBJ = /undeliverable|delivery status notification|failure notice|returned mail|delivery has failed|mail delivery failed|address not found|delivery incomplete|could ?n.?t be delivered|message not delivered/i;
const COMPLAINT = /\bspam\b|abuse report|feedback loop|complaint|reported as (spam|junk)/i;
const HARD = /\b5\.\d\.\d\b|\b55[0-4]\b|does not exist|user unknown|no such user|mailbox (unavailable|not found|does not exist)|address rejected|recipient (rejected|not found)|account.*(disabled|closed)|no mailbox|invalid recipient|unknown recipient/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Why did it bounce? The remedy is completely different per cause, so classify before acting.
//   dead      - the mailbox does not exist. No format change helps. Suppress + look up where they went.
//   content   - the message was refused on content/format grounds. A plain-text retry is a
//               legitimate fallback here, so queue ONE for Eric to approve.
//   blocked   - the organisation has deliberately blocked us. We respect that: suppress, never retry.
//   soft      - temporary (mailbox full, greylisting, throttling). Leave it; the next cadence run retries.
function classifyBounce(blob) {
  const code = (blob.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/) || [])[1] || '';
  if (/^4\./.test(code) || /\b4\d\d\b[^\d]{0,20}(temporar|try again|greylist|throttl|deferred)/i.test(blob)
      || /mailbox full|over quota|quota exceeded|too many messages|rate limit/i.test(blob)) return { cause: 'soft', code };
  if (/blocked using|blacklist|blocklist|denied by policy|policy reasons|rejected due to policy|access denied for this sender|sender blocked|not authorized to send/i.test(blob)) return { cause: 'blocked', code };
  if (/^5\.6\./.test(code) || /content.?(filter|reject)|spam.?(score|content|filter)|message (content|body) rejected|high probability of spam|considered spam|virus|malformed|message size|too large/i.test(blob)) return { cause: 'content', code };
  if (/^5\.[15]\./.test(code) || /does not exist|user unknown|no such user|mailbox (unavailable|not found|does not exist)|recipient (address )?rejected|invalid recipient|unknown recipient|no mailbox|account.*(disabled|closed)/i.test(blob)) return { cause: 'dead', code };
  return { cause: 'dead', code };   // unclassified 5.x: treat as dead, which is the safe default
}

async function alertEric(subject, text) {
  try {
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject, text });
  } catch (e) { console.error('alert failed: ' + e.message); }
}

async function main() {
  const provs = await sGet('mdrx_providers?select=id,email&email=not.is.null');
  const emailToId = {}; const ours = new Set();
  for (const p of provs) { const e = (p.email || '').toLowerCase(); if (e) { emailToId[e] = p.id; ours.add(e); } }
  const seenRows = await sGet('bounce_events?select=message_uid');
  const seen = new Set((seenRows || []).map((r) => r.message_uid));
  const suppRows = await sGet('suppressions?select=email');
  const suppressed = new Set((suppRows || []).map((s) => (s.email || '').toLowerCase()));

  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS }, logger: false });
  await client.connect();
  // read-write: Eric does not want bounce notifications sitting in his inbox, so once a DSN
  // is logged we file it away. Nothing else in the mailbox is touched.
  const lock = await client.getMailboxLock('INBOX');
  const newHard = []; const complaints = []; const relocate = []; const fileAway = []; const retryPlain = [];
  try {
    const total = client.mailbox?.exists || 0;
    const start = Math.max(1, total - 60);
    for await (const m of client.fetch(`${start}:*`, { envelope: true, source: true })) {
      const env = m.envelope || {};
      const from = (env.from?.[0]?.address || '').toLowerCase();
      const subject = env.subject || '';
      const mid = env.messageId || ('uid:' + m.uid);
      if (seen.has(mid)) continue;
      if (NOT_A_BOUNCE.test(subject)) continue;   // DMARC reports, calendar traffic, and the like
      const looksBounce = BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject) || COMPLAINT.test(subject);
      if (!looksBounce) continue;
      let bodyText = '';
      try { const parsed = await simpleParser(m.source); bodyText = (parsed.text || '') + ' ' + (parsed.subject || ''); } catch (e) {}
      const blob = (subject + ' ' + bodyText);
      const isComplaint = COMPLAINT.test(blob);
      const isHard = HARD.test(blob);
      const targets = [...new Set((bodyText.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].filter((e) => ours.has(e));
      const { cause, code } = classifyBounce(blob);
      const type = isComplaint ? 'complaint' : cause === 'soft' ? 'soft' : 'hard';
      // A real delivery failure always names the address that failed. If we cannot find one of
      // ours in the message, this is not a bounce we can act on, and counting it would poison the
      // rate that governs the circuit breaker. Log nothing, file it away, move on.
      if (!targets.length && !isComplaint) { fileAway.push(m.uid); seen.add(mid); continue; }
      await sPost('bounce_events', { email: targets[0] || null, bounce_type: type, message_uid: mid, subject: subject.slice(0, 200), occurred_at: env.date || new Date().toISOString(), cause, status_code: code || null }, 'resolution=ignore-duplicates,return=minimal');
      seen.add(mid);
      fileAway.push(m.uid);         // logged, so get it out of Eric's inbox either way
      if (type === 'soft') continue; // temporary failures: log, do not suppress, cadence retries on its own

      for (const e of targets) {
        // CONTENT rejection: the address is fine, the message was refused on format grounds.
        // Queue ONE plain-text retry for Eric to approve. Do not suppress the lead.
        if (cause === 'content' && !isComplaint && emailToId[e]) {
          retryPlain.push({ id: emailToId[e], email: e, code });
          continue;
        }
        if (!suppressed.has(e)) {
          await sPost('suppressions', { email: e, reason: `${cause} bounce${code ? ' ' + code : ''}`, source: 'bounce-scan', provider_id: emailToId[e] || null }, 'resolution=merge-duplicates,return=minimal');
          suppressed.add(e);
        }
        // A complaint is a refusal and belongs in Unsubscribed. A hard bounce is a data error:
        // the physician never saw anything and never said no, so filing him as unsubscribed buries
        // a live prospect and inflates the opt-out rate with typos. He comes out of the sending
        // pool either way, but a bounce is routed for a corrected address instead.
        if (emailToId[e]) {
          const patch = type === 'complaint'
            ? { suppressed: true, funnel_stage: 'Unsubscribed', unsubscribed_at: new Date().toISOString(), funnel_next_date: null, next_step: null }
            : { suppressed: true, funnel_stage: 'Bad Address', bounced_at: new Date().toISOString(), funnel_next_date: null,
                needs_attention: true, email_confidence: 'X_bounced',
                next_step: 'Address bounced. Find a current one, then it re-enters the cadence' };
          await sPatch(`mdrx_providers?id=eq.${emailToId[e]}`, patch);
        }
        // Only chase a DEAD mailbox. A deliberate block is their decision, and we honour it.
        if (cause === 'dead' && emailToId[e]) relocate.push(emailToId[e]);
        if (type === 'hard') newHard.push(e); else complaints.push(e);
      }
    }
    // File every processed DSN out of the inbox. Trash keeps it recoverable for 30 days,
    // and bounce_events already holds the durable record.
    if (fileAway.length) {
      try { await client.messageMove(fileAway.join(','), 'Trash', { uid: true }); console.log(`filed ${fileAway.length} bounce notice(s) out of the inbox.`); }
      catch (e) { console.error('could not file bounce notices: ' + e.message); }
    }
  } finally { lock.release(); }
  await client.logout();

  // Content rejections get ONE plain-text retry, queued for approval like any other send.
  // body_html stays null so send-outreach falls back to the plain-text rendering.
  let requeued = 0; const retryLines = [];
  for (const r of retryPlain) {
    try {
      const open = await sGet(`mdrx_outbox?select=id&provider_id=eq.${r.id}&status=eq.pending`);
      if (open && open.length) continue;                                     // already waiting on him
      const prior = await sGet(`mdrx_outbox?select=id,touch_no,subject,body_text,plain_retry&provider_id=eq.${r.id}&status=eq.sent&order=id.desc&limit=1`);
      const last = prior && prior[0];
      if (!last || last.plain_retry) continue;                               // never retry a retry
      const who = await sGet(`mdrx_providers?select=last_name,email&id=eq.${r.id}`);
      await sPost('mdrx_outbox', {
        provider_id: r.id, touch_no: last.touch_no, to_email: (who[0] || {}).email || r.email,
        subject: last.subject, body_text: last.body_text, body_html: null,
        status: 'pending', scheduled_date: new Date().toISOString().slice(0, 10), plain_retry: true,
      });
      requeued++;
      retryLines.push(`- Dr. ${(who[0] || {}).last_name || r.email} (${r.code || 'content reject'})`);
    } catch (e) { console.error(`plain-text requeue failed for ${r.email}: ${e.message}`); }
  }
  if (requeued) {
    await alertEric(`[MDconcierge] ${requeued} message(s) refused on content, plain-text retry queued`,
      `These were not dead addresses. The receiving server refused the formatted message, so a plain-text version is queued for your approval in the Cockpit:\n\n${retryLines.join('\n')}\n\n`
      + `Nothing was sent. Nobody was suppressed. If a plain-text retry also fails, that address is left alone.`);
  }

  // A hard bounce usually means the doctor left that practice. Check the NPI registry for
  // where they are now, constrained to PA. Anything found is QUEUED for Eric to confirm in
  // enrichment_suggestions; nothing is written onto the lead and nothing is unsuppressed.
  let relocFound = 0;
  const relocLines = [];
  for (const pid of [...new Set(relocate)]) {
    try {
      const rows = await sGet(`mdrx_providers?select=id,first_name,last_name,specialty,city,state,region,address,office_phone,practice_name,npi&id=eq.${pid}`);
      const p = rows && rows[0];
      if (!p || !p.last_name) continue;
      const st = deriveState(p) || 'PA';
      if (st !== 'PA') continue;                       // Eric asked: only chase them if they are in PA
      const open = await sGet(`enrichment_suggestions?select=id&provider_id=eq.${p.id}&status=eq.pending`);
      if (open && open.length) continue;               // already waiting on him
      const cands = await npiLookup({ last_name: p.last_name, first_name: p.first_name, state: st });
      if (!cands.length) continue;
      const ranked = cands.map((c) => ({ c, conf: score(c, p, st) }))
        .sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.conf] - { high: 3, medium: 2, low: 1 }[a.conf]));
      const best = ranked[0];
      if (best.conf === 'low') continue;
      const c = best.c;
      const moved = relocationDelta(c, p);
      const where = [c.city, c.state].filter(Boolean).join(', ');
      const summary = `${p.first_name || ''} ${p.last_name} bounced at ${p.practice_name || 'the practice on file'}. `
        + `The NPI registry currently lists NPI ${c.npi}, ${c.specialty || 'specialty n/a'}, ${where}`
        + `${c.office_phone ? ' · ' + c.office_phone : ''}${c.address ? ' · ' + c.address : ''}. `
        + (moved ? `That is ${moved.join(', ')} versus what we have, so they likely moved. ` : 'Same location as our record, so the address may just be dead. ')
        + 'Confirm before we try a new email. No address is guessed here.';
      await sPost('enrichment_suggestions', {
        provider_id: p.id, found: { ...pick(c, ['npi', 'credentials', 'specialty', 'address', 'city', 'state', 'zip', 'office_phone']), alternates: ranked.slice(1, 4).map((r) => r.c) },
        summary, confidence: best.conf, source: 'bounce_relocation', status: 'pending',
      });
      relocFound++;
      relocLines.push(`- Dr. ${p.last_name}: now ${where}${c.office_phone ? ', ' + c.office_phone : ''}${moved ? ' (moved)' : ''}`);
    } catch (e) { console.error(`relocation check failed for provider ${pid}: ${e.message}`); }
  }
  if (relocFound) {
    await alertEric(`[MDconcierge] ${relocFound} bounced doctor(s) located in PA`,
      `These addresses hard-bounced. The NPI registry has current information for them:\n\n${relocLines.join('\n')}\n\n`
      + `They are queued in the Cockpit for you to confirm. Nothing was changed on the lead and no email address was guessed.`);
  }
  console.log(`bounce-scan: relocation checks queued ${relocFound}.`);

  // Circuit breaker: high hard-bounce rate or any complaint -> auto-pause + alert.
  const cfg = (await sGet('outreach_config?id=eq.1'))[0] || {};
  const sends7 = (await sGet(`mdrx_outbox?select=id&status=eq.sent&sent_at=gte.${daysAgoISO(7)}`)).length;
  const hard7 = (await sGet(`bounce_events?select=id&bounce_type=eq.hard&occurred_at=gte.${daysAgoISO(7)}`)).length;
  // Need a real sample before a rate means anything. At 17 sends one guessed address is 6%,
  // which would pause a healthy campaign over nothing. Complaints still pause instantly below.
  const MIN_SAMPLE = 50;
  const rate = sends7 >= MIN_SAMPLE ? hard7 / sends7 : 0;
  let paused = false, reason = '';
  if (complaints.length) { paused = true; reason = `spam complaint from ${complaints.join(', ')}`; }
  else if (rate >= 0.05) { paused = true; reason = `hard-bounce rate ${(rate * 100).toFixed(1)}% (${hard7}/${sends7}) over 7 days`; }
  // A manual resume has to survive this job. Otherwise the guard deadlocks: the only thing that
  // lowers a bounce RATE is sending more mail, which it will not allow, so a campaign that trips
  // the threshold once can never clear it and is re-paused every three hours forever. While a
  // snooze is live the watchdog still watches and still alerts, it simply does not overrule Eric.
  const snoozed = cfg.pause_snooze_until && new Date(cfg.pause_snooze_until) > new Date();
  if (paused && !cfg.sending_paused && !snoozed) {
    await sPatch('outreach_config?id=eq.1', { sending_paused: true, pause_reason: reason });
    await alertEric('[MDconcierge] outreach AUTO-PAUSED', `Sending was auto-paused to protect your deliverability.\n\nReason: ${reason}\n\nHard bounces and complaints have been suppressed automatically. Review, then un-pause from the Cockpit when ready.`);
  } else if (paused && snoozed) {
    await alertEric('[MDconcierge] deliverability still poor, not re-pausing', `You resumed sending, so this is a warning rather than a pause.

Reason: ${reason}

The override holds until ${cfg.pause_snooze_until}. Address quality is the fix; the guard is only the alarm.`);
  }
  console.log(`bounce-scan: hard=${newHard.length} complaints=${complaints.length} | 7d rate ${(rate * 100).toFixed(1)}% (${hard7}/${sends7})${paused ? ' | PAUSED' : ''}`);
}

main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/greeting|connection|timeout|econnreset|econnrefused|enotfound|socket|network/i.test(msg)) { console.warn('transient, skipping: ' + msg); process.exit(0); }
  console.error('bounce-scan fatal: ' + (e?.stack || e));
  process.exit(0);
});
