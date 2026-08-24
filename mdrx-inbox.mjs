// MDRx inbox assistant (SEPARATE from the referrals@ engine).
// Reads eric@mdconcierge.net INBOX read-only, finds MDRx-related replies, classifies
// sentiment, ROUTES the contact to the correct home automatically, and drafts a reply
// in Eric's voice for his approval. It SENDS NOTHING and never modifies the mailbox.
// Routing rules (Eric's spec):
//   workable (positive/neutral, anything not a clear decline or opt-out) -> Pipeline (Engaged), flag Eric, draft reply
//   clear decline ("not interested")                                     -> Not Interested (no draft)
//   opt-out ("unsubscribe","stop","take me off")                         -> Suppression, permanent (no draft)
//   unsure between decline and opt-out                                   -> flag for Eric's review (never auto-suppress on doubt)
// Runs on a schedule via GitHub Actions.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ERIC_PASS, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
async function sGet(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function sPost(table, row, prefer = 'return=minimal') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(row) });
  if (!r.ok) console.error(`insert ${table} ${r.status}: ${await r.text()}`);
}
async function sPatch(path, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) console.error(`patch ${path} ${r.status}: ${await r.text()}`);
}

const NOISE = /dmarc|no-?reply|noreply|postmaster|mailer-daemon|notification/i;
// Eric's own side of the table: the MDRx360 team are PARTNERS, not prospects.
const TEAM = /@mdrx360\.com$|@therapointmedical\.com$/i;
const TEAM_DESC = "Phil D'Adderio (MDRx Managing Partner), Brian, Joseph, Rishin, Thomas, and Stefanos at MDRx360, plus partners like Dr. Ostrowski at Therapoint";
// Cold stages a workable reply is allowed to advance to Engaged (never downgrade a warmer lead).
const COLD = new Set(['New', 'Queued', 'Contacted', null, undefined, '']);

// "Thursday at 2 works" used to be the end of the road. The scanner read it, filed it as a warm
// reply, and left Eric to notice, check his calendar, write back, make the Zoom and send the
// invitation. Every hour that took is an hour a physician who said yes sat waiting.
//
// So a firmly named time is checked against the calendar and, if it is genuinely free, booked
// through the same function the booking page calls: same Zoom meeting, same calendar invitation
// to both of them, same confirmation wording. Nothing new is composed here.
//
// It books ONLY on an exact match to a real opening. A time that is taken, outside working hours
// or past the horizon books nothing and lands on Eric's desk instead, because the failure that
// matters is a physician holding an invitation for a call Eric cannot take.
const ET = 'America/New_York';
// Eastern wall clock to a real instant, without pulling in a date library. Guess at UTC, ask what
// that instant reads as in New York, and correct by the difference; one pass settles it except
// across a DST boundary, where the second does.
function etToUTC(local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  let t = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (shown === Date.UTC(y, mo - 1, d, h, mi)) break;
    t += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return new Date(t);
}

async function bookProposedTime(prov, local, name, email) {
  const want = etToUTC(local);
  if (!want || isNaN(want)) return { booked: false, why: 'could not read that as a time' };
  if (want.getTime() < Date.now()) return { booked: false, why: 'that time has already passed' };
  let slots;
  try {
    const r = await fetch('https://pjdbzrzadlldojuvdrfj.supabase.co/functions/v1/booking-slots?type=intro');
    slots = await r.json();
  } catch (e) { return { booked: false, why: 'could not read the calendar: ' + e.message }; }
  // The same test booking-create applies: the whole call has to fit inside a genuinely free window.
  const dur = (slots.duration || 15) * 60000;
  const fits = Object.values(slots.windows || {}).flat()
    .some((w) => want.getTime() >= Date.parse(w.start) && want.getTime() + dur <= Date.parse(w.end));
  if (!fits) return { booked: false, why: 'he is not free then' };
  if (want.getTime() % (5 * 60000) !== 0) return { booked: false, why: 'that reads as an odd time, worth confirming' };
  const label = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(want);
  const hit = { start: want.toISOString(), label };
  try {
    const r = await fetch('https://pjdbzrzadlldojuvdrfj.supabase.co/functions/v1/booking-create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'intro', mode: 'video', start: hit.start, name, email, token: prov.funnel_token || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { booked: false, why: j.error || ('booking refused, ' + r.status) };
    return { booked: true, when: hit.label, start: hit.start };
  } catch (e) { return { booked: false, why: 'booking failed: ' + e.message }; }
}

// One model call: classify sentiment AND (when useful) draft a reply. Returns
// { sentiment: 'workable'|'decline'|'optout', hot: bool, draft: string }.
async function analyzeAndDraft(who, fromAddr, subject, body, isTeam) {
  const sys = `You are Eric Weiscarger's inbox agent for MDconcierge. Eric partners WITH the MDRx360 team to bring physicians into the MDRx Workers' Compensation Pharmacy Program.

WHO IS WHO (get this right):
- The MDRx360 team (${TEAM_DESC}; anyone @mdrx360.com or @therapointmedical.com) are Eric's PARTNERS and teammates, on Eric's side. NEVER pitch them or treat them as a lead.
- Physicians and their practice staff (practice managers, coordinators) are the PROSPECTS.

You do TWO things and return STRICT JSON only, no prose:
1) Classify the sender's reply sentiment as exactly one of:
   - "workable": positive or neutral. Interested, asking a question, scheduling, requesting materials, "tell me more", "let me check with my partner", or any internal teammate coordination. Anything that is NOT a clear decline or opt-out is workable.
   - "decline": a clear, polite no to the opportunity ("not interested", "we'll pass", "not a fit right now"), but WITHOUT asking to be removed from the list.
   - "optout": EXPLICITLY asks to stop being contacted ("unsubscribe","take me off","stop emailing","remove me"). Only use optout when the request to stop is unmistakable and explicit.
   If you cannot clearly tell whether a reply is a soft decline or a real opt-out, classify it "workable" and set hot=true so Eric reviews it himself. NEVER auto-suppress a contact on doubt; a permanent opt-out must be earned by an explicit request.
   A teammate message is always "workable".
2) Set "hot": true if the reply is time-sensitive, high-intent (ready to move/sign/book), OR touches legal/compliance/regulatory matters that need Eric's careful eye. Otherwise false.
3) "draft": Only for "workable" senders, write the reply body in Eric's voice. For "decline" or "optout", return "".

ADDRESSING: Address physicians as "Dr. [last name]", never by first name. Address office staff, practice managers, coordinators, and champions by their first name. If the sender is a doctor, it is "Dr. Lastname"; if the sender is a teammate or office staff, use their first name.

Draft voice: brief and human, never templated or salesy, NO em dashes or en dashes (use commas or periods), never mention commission or tie economics to prescribing, never invent facts, numbers, names, or legal conclusions. Name it in full: "MDRx Workers' Compensation Pharmacy Program". Always close with EXACTLY this signature, each part on its own line:
Best,
Eric Weiscarger
Founder, MDconcierge
Referral Management • Work Comp Pharmacy • Ancillary Coordination
(570) 817-7569 • eric@mdconcierge.net • mdconcierge.net

4) "proposed_time": if the sender names a specific time they want the call, return it as "YYYY-MM-DDTHH:MM" in Eastern wall-clock time. Resolve relative days ("Thursday", "tomorrow", "next week") against TODAY, given below, and always resolve forward: a weekday already past this week means the next one. Business hours are meant, so a bare "2" or "2 o'clock" is 14:00, and only take a morning reading when they say morning or am. Return "" unless they have named a time firmly enough to put in a diary: "Thursday at 2" and "how about 10am Tuesday" qualify, "sometime next week", "an afternoon works" and "I am free Thursdays" do not. If they offer several, return the first. If they are moving or cancelling an existing call rather than making one, return "".

Return ONLY: {"sentiment":"...","hot":true|false,"draft":"...","proposed_time":"..."}`;
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  const todayISO = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
  const user = `TODAY is ${today} (${todayISO}), Eastern time. This email is from ${who} <${fromAddr}>${isTeam ? ' (an MDRx360 TEAMMATE, not a prospect)' : ''}. Subject: "${subject}".\n\nFull thread (most recent on top):\n"""\n${String(body || '').slice(0, 4500)}\n"""`;
  try {
    const m = await anthropic.messages.create({ model: 'claude-sonnet-5', max_tokens: 650, system: sys, messages: [{ role: 'user', content: user }] });
    const raw = (m.content?.[0]?.text || '').trim();
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const o = JSON.parse(json);
    let s = String(o.sentiment || '').toLowerCase();
    if (!['workable', 'decline', 'optout'].includes(s)) s = 'workable'; // parse safety: leave for human, never auto-suppress on doubt
    if (isTeam) s = 'workable';
    return { sentiment: s, hot: !!o.hot, draft: (o.draft || '').trim(), proposedTime: String(o.proposed_time || '').trim() };
  } catch (e) {
    console.error('analyze failed: ' + e.message);
    return { sentiment: 'workable', hot: false, draft: '', proposedTime: '' }; // safe default: surfaced to Eric, no auto-routing side effects beyond flag
  }
}

async function main() {
  // One reply agent for ALL leads (mdrx + funnel). funnel-reply.mjs was merged in here.
  const provs = await sGet('mdrx_providers?select=id,first_name,last_name,email,funnel_stage,suppressed,engaged_at,lead_type,cell,office_phone,funnel_token');
  const existing = await sGet('mdrx_inbox_drafts?select=message_uid');
  const seen = new Set((existing || []).map(d => d.message_uid));
  const supp = await sGet('suppressions?select=email');
  const suppressed = new Set((supp || []).map(s => (s.email || '').toLowerCase()));
  const byEmail = {}; (provs || []).forEach(p => { if (p.email) byEmail[p.email.toLowerCase()] = p; });

  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true }); // read-only: never touch the mailbox
  let created = 0, scanned = 0, routed = 0;
  try {
    const total = client.mailbox?.exists || 0;
    const start = Math.max(1, total - 24);
    for await (const m of client.fetch(`${start}:*`, { envelope: true, source: true })) { // BODY.PEEK, no \Seen
      scanned++;
      const env = m.envelope || {};
      const from = env.from?.[0] || {};
      const fromAddr = (from.address || '').toLowerCase();
      const subject = env.subject || '';
      const mid = env.messageId || ('uid:' + m.uid);
      if (seen.has(mid)) continue;
      if (NOISE.test(fromAddr) || fromAddr === 'referrals@mdconcierge.net' || fromAddr === 'eric@mdconcierge.net') continue;
      const prov = byEmail[fromAddr];
      const isTeam = TEAM.test(fromAddr);
      // What counts as our mail. The old test looked for "workers comp" and Jackie Tillou writes
      // "Workcomp", one word, in every introduction she makes. Amanda Dowdy of Bone & Joint
      // Institute of South Georgia replied to one on 20 August and this line dropped her on the
      // floor: no record, no draft, no trace anywhere, and she sat waiting four days.
      //
      // Referrers are named explicitly. A introduction from someone who sends us business is the
      // single most valuable email that arrives here, and it must never depend on a subject line.
      const REFERRERS = /@(mountainvalleyortho|mdrx360|therapointmedical)\.com$/i;
      const OURS = /mdrx|work\s?comp|workers.?comp|workers compensation|pharmacy program|injection kit|ancillar|DME/i;
      const isMdrx = isTeam || prov || REFERRERS.test(fromAddr) || OURS.test(subject) || OURS.test(String(bodyText || '').slice(0, 2000));
      if (!isMdrx) continue;

      let bodyText = '';
      try { const parsed = await simpleParser(m.source); bodyText = (parsed.text || '').trim(); } catch (e) {}
      const who = prov ? ('Dr. ' + (prov.last_name || '')) : (from.name || fromAddr);

      // Classify + draft (cap the model spend per run).
      const a = created < 10 ? await analyzeAndDraft(who, fromAddr, subject, bodyText, isTeam)
                             : { sentiment: 'workable', hot: false, draft: '', proposedTime: '' };

      // ---- Better ways to reach him -------------------------------------------------------
      // Every touch now asks: if phone or text is easier, send your cell or a personal email.
      // The answers arrive in ordinary replies and in out-of-office autoresponders, which is
      // where Joy Long's new address sat for four days before anyone went looking. Anything
      // found goes on the record, so it is never buried in a draft queue.
      if (prov && bodyText) {
        const found = {};
        // A US number, however he writes it. Ignore anything that is already on his record.
        const phones = (bodyText.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [])
          .map((s) => s.replace(/\D/g, '').replace(/^1/, ''))
          .filter((d) => d.length === 10);
        const known = new Set([prov.cell, prov.office_phone].map((v) => String(v || '').replace(/\D/g, '').replace(/^1/, '')));
        const newPhone = phones.find((d) => !known.has(d));
        if (newPhone && /cell|mobile|text|call me|reach me|my number/i.test(bodyText)) {
          found.cell = newPhone.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
        // An address that is not the one he wrote from and not ours.
        const addrs = (bodyText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
          .map((a) => a.toLowerCase())
          .filter((a) => a !== fromAddr && !a.endsWith('mdconcierge.net') && !a.endsWith('mdrx360.com')
                      && !/noreply|no-reply|postmaster|mailer-daemon/.test(a));
        const altEmail = addrs[0];
        if (altEmail && /new (e-?mail|address)|personal|please use|reach me at|contact me at|better/i.test(bodyText)) {
          found.alt_email = altEmail;
        }
        if (found.cell || found.alt_email) {
          const bits = [];
          if (found.cell) { bits.push(`cell ${found.cell}`); }
          if (found.alt_email) { bits.push(`email ${found.alt_email}`); }
          await sPatch(`mdrx_providers?id=eq.${prov.id}`, {
            ...(found.cell ? { cell: found.cell } : {}),
            needs_attention: true,
            next_step: `He gave a better way to reach him: ${bits.join(', ')}. Use it.`,
          });
          await sPost('mdrx_activity', {
            provider_id: prov.id, type: 'note', occurred_at: new Date().toISOString(),
            subject: 'Gave a better way to reach him',
            notes: `${bits.join('\n')}\n\nFrom his reply: "${bodyText.slice(0, 400)}"`,
            created_by: 'inbox agent',
          });
          console.log(`  ${who}: captured ${bits.join(' and ')}`);
        }
      }

      // ---- Automatic home routing (prospects only; teammates are never routed) ----
      let routedAction = 'none';
      if (!isTeam) {
        if (a.sentiment === 'optout') {
          routedAction = 'Suppressed';
          if (!suppressed.has(fromAddr)) {
            await sPost('suppressions', { email: fromAddr, reason: 'reply opt-out', source: 'mdrx-inbox', provider_id: prov ? prov.id : null }, 'resolution=merge-duplicates,return=minimal');
            suppressed.add(fromAddr);
          }
          if (prov) await sPatch(`mdrx_providers?id=eq.${prov.id}`, { suppressed: true, funnel_stage: 'Unsubscribed', unsubscribed_at: new Date().toISOString(), funnel_next_date: null });
          routed++;
        } else if (a.sentiment === 'decline') {
          routedAction = 'Not Interested';
          if (prov) { await sPatch(`mdrx_providers?id=eq.${prov.id}`, { funnel_stage: 'Not Interested', funnel_next_date: null }); routed++; }
        } else { // workable
          routedAction = 'Replied/flagged';
          if (prov) {
            // A reply ends the sequence. Not just for cold leads: the old rule only moved
            // New/Queued/Contacted, so a physician who was already Engaged or Hot stayed on an
            // active track and could be emailed again by the machine after writing to Eric.
            // That is the single worst thing this system can do, so the stop is unconditional
            // for anyone still being pursued. Stages past the pursuit (booked, closing, won)
            // keep their place; a reply there is part of the conversation, not the start of one.
            const KEEP = new Set(['Meeting Booked', 'Closing', 'Won', 'Unsubscribed', 'Not Interested']);
            const patch = { needs_attention: true, funnel_last_seen_at: new Date().toISOString() };
            if (!KEEP.has(String(prov.funnel_stage || ''))) {
              patch.funnel_stage = 'Replied';
              patch.priority = 'high';
              patch.funnel_next_date = null;          // nothing is due; Eric answers a human
              patch.next_step = 'They replied. Answer them.';
              if (!prov.engaged_at) patch.engaged_at = new Date().toISOString();
            }
            await sPatch(`mdrx_providers?id=eq.${prov.id}`, patch); routed++;

            // They named a time. Take it if it is really free.
            if (a.proposedTime) {
              const nm = (from.name || `${prov.first_name || ''} ${prov.last_name || ''}`).trim() || fromAddr;
              const res = await bookProposedTime(prov, a.proposedTime, nm, fromAddr);
              if (res.booked) {
                await sPatch(`mdrx_providers?id=eq.${prov.id}`, {
                  funnel_stage: 'Meeting Booked', needs_attention: false, priority: 'normal',
                  next_step: `Call booked for ${res.when}. Invitation and Zoom link are with him.`,
                  funnel_next_date: null,
                });
                await sPost('mdrx_activity', {
                  provider_id: prov.id, type: 'note', occurred_at: new Date().toISOString(),
                  subject: 'Booked the time he asked for',
                  notes: `He proposed ${a.proposedTime} Eastern and it was free, so it is booked for ${res.when}. Calendar invitation and Zoom link sent to you both.`,
                  created_by: 'inbox agent',
                });
                console.log(`  ${who}: proposed ${a.proposedTime}, booked for ${res.when}`);
              } else {
                // Wanted a specific time we cannot give. That is Eric's to answer, today, and the
                // reason has to be on the record or he is guessing at why it did not take.
                await sPatch(`mdrx_providers?id=eq.${prov.id}`, {
                  needs_attention: true, priority: 'high',
                  next_step: `He asked for ${a.proposedTime} Eastern and it did not take (${res.why}). Offer him the nearest thing.`,
                });
                console.log(`  ${who}: proposed ${a.proposedTime}, not booked (${res.why})`);
              }
            }
          }
        }
      }

      // The whole message, kept once, so anything downstream can read what was actually said
      // rather than the first 400 characters of it.
      await sPost('mdrx_messages', {
        ext_id: String(mid), direction: 'in', by_hand: true,
        from_addr: fromAddr, from_name: from.name || '', to_addrs: ERIC_USER,
        subject, body_text: String(bodyText || '').slice(0, 20000),
        sent_at: env.date || new Date().toISOString(),
        provider_id: prov ? prov.id : null, matched_by: prov ? 'address' : null,
      });

      await sPost('mdrx_inbox_drafts', {
        message_uid: mid, from_addr: fromAddr, from_name: from.name || '', subject,
        received_at: env.date || null, snippet: bodyText.replace(/\s+/g, ' ').slice(0, 400),
        draft_reply: a.draft, in_reply_to: mid, provider_id: prov ? prov.id : null, status: 'pending',
        sentiment: a.sentiment, hot: a.hot, routed_action: routedAction,
      });
      seen.add(mid); created++;
    }
  } finally { lock.release(); }
  await client.logout();
  console.log(`MDRx inbox scan: ${scanned} scanned, ${created} new draft(s), ${routed} contact(s) routed.`);
}

// Notify Eric ONLY on a genuine (non-transient) failure, at most once per 3 hours.
async function alertFailure(job, msg) {
  try {
    const rows = await sGet(`job_alerts?select=last_alert_at&job=eq.${job}`);
    const last = rows[0]?.last_alert_at ? new Date(rows[0].last_alert_at).getTime() : 0;
    if (Date.now() - last < 3 * 3600 * 1000) return; // throttle
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: `[MDconcierge] the ${job} job hit a problem`, text: `The ${job} job failed with a non-transient error:\n\n${msg}\n\nIt retries on its schedule. Check the GitHub Actions logs if it persists.` });
    await fetch(`${SUPABASE_URL}/rest/v1/job_alerts`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ job, last_alert_at: new Date().toISOString(), last_msg: msg.slice(0, 300) }) });
    console.log(`alerted Eric about ${job} failure`);
  } catch (e) { console.error('alertFailure error: ' + e.message); }
}

main().catch(async e => {
  const msg = String(e?.message || e);
  if (/greeting|connection|timeout|econnreset|econnrefused|enotfound|socket|network/i.test(msg)) {
    console.warn('Transient mail connection issue, skipping this run: ' + msg);
    process.exit(0); // transient blip, no alert
  }
  console.error('Fatal: ' + (e?.stack || e));
  await alertFailure('mdrx-inbox', msg);
  process.exit(0); // we alert Eric ourselves; do not also trigger a GitHub failure email
});
