// sent-scan.mjs — the other half of the mailbox.
//
// mdrx-inbox.mjs reads what people write TO Eric. Nothing read what Eric writes BACK, so the
// platform knew only about the mail the machine sent itself. It watched Dr. Hatgis go silent while
// his practice manager was mid-thread with Eric, and it would have gone on flagging a lead as
// "waiting on us" for a reply Eric had already answered by hand.
//
// This reads the Sent folder read-only, matches each message to a lead, logs it as a real touch on
// that lead's timeline, and pauses automation for that lead for ten days so nothing lands on top of
// a live conversation. If the thread goes quiet, the cadence picks it back up knowing what was said.
//
// It SENDS NOTHING and never modifies the mailbox. Runs on a schedule via GitHub Actions.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ERIC_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}

// How far back to look. The scan is idempotent, so overlapping runs cost nothing.
const LOOKBACK_DAYS = Number(process.env.SENT_LOOKBACK_DAYS || 14);
// A hand-sent email buys this much quiet before the machine writes to that lead again.
const PAUSE_DAYS = Number(process.env.MANUAL_PAUSE_DAYS || 10);

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  // A duplicate is the normal case on an overlapping run, not a failure worth shouting about.
  if (!r.ok && r.status !== 409) console.error(`insert ${t} ${r.status}: ${await r.text()}`);
  return r.ok;
};
const sPatch = async (p, row) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`);
};

// Mail the machine sent carries these. Counting them as Eric's own would pause the cadence on the
// strength of the cadence's own email.
const AUTOMATED = ['x-mdc-auto', 'x-mdc-bot'];
// A physician's practice writes on his behalf, so a reply from his practice domain is his reply.
// Free mail cannot be matched that way, several leads share gmail.com, and our own domains are us.
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com', 'live.com', 'msn.com', 'comcast.net', 'verizon.net']);
const OUR_DOMAINS = new Set(['mdconcierge.net', 'mdrx360.com', 'therapointmedical.com']);
const domainOf = (email) => String(email || '').split('@')[1]?.toLowerCase().trim() || '';
const addrsOf = (parsed) => [parsed.to, parsed.cc]
  .flatMap((f) => (f?.value || []))
  .map((v) => String(v.address || '').toLowerCase().trim())
  .filter((a) => a && domainOf(a) !== 'mdconcierge.net');

const iso = (d) => new Date(d).toISOString();
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);

async function main() {
  const leads = await sGet('mdrx_providers?select=id,first_name,last_name,email,practice_name,funnel_stage,behavior_flag&email=not.is.null');
  const byEmail = new Map();
  const byDomain = new Map();
  for (const p of leads || []) {
    const e = String(p.email).toLowerCase().trim();
    byEmail.set(e, p);
    const d = domainOf(e);
    // Domain matching is only safe where the domain belongs to one practice. Where several leads
    // share it, an email to one of them must never be logged against another.
    if (d && !FREE_MAIL.has(d) && !OUR_DOMAINS.has(d)) {
      if (byDomain.has(d)) byDomain.set(d, null); else byDomain.set(d, p);
    }
  }

  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS }, logger: false });
  await client.connect();

  // Zoho names it "Sent", but ask the server rather than assume it.
  let sentBox = 'Sent';
  try {
    for (const box of await client.list()) {
      if ((box.specialUse === '\\Sent') || /^sent( items| mail)?$/i.test(box.path)) { sentBox = box.path; break; }
    }
  } catch { /* fall back to the default name */ }

  const since = addDays(new Date(), -LOOKBACK_DAYS);
  const lock = await client.getMailboxLock(sentBox, { readOnly: true });   // read-only: never touch the mailbox
  const touched = new Map();   // provider id -> the most recent hand-sent message to them
  let seen = 0, automated = 0, unmatched = 0;
  try {
    for await (const msg of client.fetch({ since }, { source: true, uid: true })) {
      seen++;
      const parsed = await simpleParser(msg.source);
      const hdr = parsed.headers;
      if (AUTOMATED.some((h) => hdr.has(h))) { automated++; continue; }

      const recipients = addrsOf(parsed);
      if (!recipients.length) continue;

      // One message can go to a physician and his manager at once. It is one touch for that lead,
      // not two, so the first real match wins.
      let lead = null, how = '';
      for (const a of recipients) {
        if (byEmail.has(a)) { lead = byEmail.get(a); how = 'to the lead'; break; }
      }
      if (!lead) {
        for (const a of recipients) {
          const d = byDomain.get(domainOf(a));
          if (d) { lead = d; how = `to ${a} at his practice`; break; }
        }
      }
      if (!lead) { unmatched++; continue; }

      const when = parsed.date || new Date();
      const extId = String(parsed.messageId || `${sentBox}:${msg.uid}`);
      const body = String(parsed.text || '').replace(/\s+/g, ' ').trim();
      await sPost('mdrx_activity', {
        provider_id: lead.id, type: 'email_out', created_by: 'eric', ext_id: extId,
        occurred_at: iso(when),
        subject: parsed.subject || '(no subject)',
        notes: `Sent by hand ${how}. ${body.slice(0, 400)}`,
      });
      const prev = touched.get(lead.id);
      if (!prev || new Date(when) > new Date(prev.when)) touched.set(lead.id, { lead, when, how, subject: parsed.subject });
    }
  } finally {
    lock.release();
    await client.logout();
  }

  // One update per lead, from their most recent hand-sent message.
  for (const { lead, when, how } of touched.values()) {
    const patch = {
      manual_touch_at: iso(when),
      last_touch_at: iso(when),
      funnel_next_date: addDays(when, PAUSE_DAYS).toISOString().slice(0, 10),
    };
    // He answered. The lead is no longer waiting on us.
    if (/waiting on us/i.test(String(lead.behavior_flag || ''))) patch.behavior_flag = null;
    await sPatch(`mdrx_providers?id=eq.${lead.id}`, patch);
    console.log(`sent-scan: ${lead.last_name || lead.email} answered by hand ${how} on ${iso(when).slice(0, 10)}. Automation paused ${PAUSE_DAYS} days.`);
  }

  console.log(`sent-scan: ${seen} sent messages in the last ${LOOKBACK_DAYS} days, ${automated} from the machine, ${unmatched} to nobody in the pipeline, ${touched.size} lead(s) updated.`);
}

main().catch((e) => {
  const msg = String(e?.message || e);
  // The mailbox being briefly unreachable is not an incident. The next run picks up the same window.
  if (/timeout|econnreset|econnrefused|enotfound|socket|network|fetch failed/i.test(msg)) {
    console.warn('transient, skipping run: ' + msg);
    process.exit(0);
  }
  console.error('sent-scan fatal: ' + (e?.stack || e));
  process.exit(1);
});
