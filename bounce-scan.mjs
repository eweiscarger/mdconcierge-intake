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

const BOUNCE_FROM = /mailer-daemon|mailerdaemon|postmaster|mail delivery (subsystem|system)|delivery.?(status|failure)|no-?reply/i;
const BOUNCE_SUBJ = /undeliverable|delivery status notification|failure notice|returned mail|delivery has failed|mail delivery failed|address not found|delivery incomplete|could ?n.?t be delivered|message not delivered/i;
const COMPLAINT = /\bspam\b|abuse report|feedback loop|complaint|reported as (spam|junk)/i;
const HARD = /\b5\.\d\.\d\b|\b55[0-4]\b|does not exist|user unknown|no such user|mailbox (unavailable|not found|does not exist)|address rejected|recipient (rejected|not found)|account.*(disabled|closed)|no mailbox|invalid recipient|unknown recipient/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

async function alertEric(subject, text) {
  try {
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject, text });
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
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  const newHard = []; const complaints = []; const relocate = [];
  try {
    const total = client.mailbox?.exists || 0;
    const start = Math.max(1, total - 60);
    for await (const m of client.fetch(`${start}:*`, { envelope: true, source: true })) {
      const env = m.envelope || {};
      const from = (env.from?.[0]?.address || '').toLowerCase();
      const subject = env.subject || '';
      const mid = env.messageId || ('uid:' + m.uid);
      if (seen.has(mid)) continue;
      const looksBounce = BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject) || COMPLAINT.test(subject);
      if (!looksBounce) continue;
      let bodyText = '';
      try { const parsed = await simpleParser(m.source); bodyText = (parsed.text || '') + ' ' + (parsed.subject || ''); } catch (e) {}
      const blob = (subject + ' ' + bodyText);
      const isComplaint = COMPLAINT.test(blob);
      const isHard = HARD.test(blob);
      const targets = [...new Set((bodyText.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].filter((e) => ours.has(e));
      const type = isComplaint ? 'complaint' : isHard ? 'hard' : 'soft';
      await sPost('bounce_events', { email: targets[0] || null, bounce_type: type, message_uid: mid, subject: subject.slice(0, 200), occurred_at: env.date || new Date().toISOString() }, 'resolution=ignore-duplicates,return=minimal');
      seen.add(mid);
      if (type === 'soft') continue; // temporary failures: log, do not suppress
      for (const e of targets) {
        if (!suppressed.has(e)) {
          await sPost('suppressions', { email: e, reason: `${type} bounce`, source: 'bounce-scan', provider_id: emailToId[e] || null }, 'resolution=merge-duplicates,return=minimal');
          suppressed.add(e);
        }
        if (emailToId[e]) await sPatch(`mdrx_providers?id=eq.${emailToId[e]}`, { suppressed: true, funnel_stage: 'Unsubscribed', unsubscribed_at: new Date().toISOString(), funnel_next_date: null });
        if (type === 'hard' && emailToId[e]) relocate.push(emailToId[e]);   // a hard bounce usually means they moved
        if (type === 'hard') newHard.push(e); else complaints.push(e);
      }
    }
  } finally { lock.release(); }
  await client.logout();

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
  const rate = sends7 >= 10 ? hard7 / sends7 : 0;
  let paused = false, reason = '';
  if (complaints.length) { paused = true; reason = `spam complaint from ${complaints.join(', ')}`; }
  else if (rate >= 0.05) { paused = true; reason = `hard-bounce rate ${(rate * 100).toFixed(1)}% (${hard7}/${sends7}) over 7 days`; }
  if (paused && !cfg.sending_paused) {
    await sPatch('outreach_config?id=eq.1', { sending_paused: true, pause_reason: reason });
    await alertEric('[MDconcierge] outreach AUTO-PAUSED', `Sending was auto-paused to protect your deliverability.\n\nReason: ${reason}\n\nHard bounces and complaints have been suppressed automatically. Review, then un-pause from the Cockpit when ready.`);
  }
  console.log(`bounce-scan: hard=${newHard.length} complaints=${complaints.length} | 7d rate ${(rate * 100).toFixed(1)}% (${hard7}/${sends7})${paused ? ' | PAUSED' : ''}`);
}

main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/greeting|connection|timeout|econnreset|econnrefused|enotfound|socket|network/i.test(msg)) { console.warn('transient, skipping: ' + msg); process.exit(0); }
  console.error('bounce-scan fatal: ' + (e?.stack || e));
  process.exit(0);
});
