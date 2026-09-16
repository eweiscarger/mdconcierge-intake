// One capped transport for every script in this repo.
//
// Why this exists: on 16 Sep 2026 Eric received 18 emails in 22 minutes while testing a referral
// by hand. Nothing was looping - each was a separate test, one email each, working as designed -
// but it made the real risk obvious. Every notification path is one-shot, gated by its own flag
// (provider_notified, appt_relayed, claim_info_forwarded and the rest), and chasing is spaced 48
// hours with a hard cap. This does not replace any of that. It is what catches the case where one
// of those flags fails to set, or a future change introduces a loop.
//
// The cap wraps the TRANSPORT, not a sendMail() helper, because several scripts call
// transporter.sendMail directly - including document forwarding with attachments and the
// InjuredGuide confirmation to the injured person. A guard on the helpers would leave those open.
//
// The count is read from audit_log rather than held in memory: these scripts are short-lived and
// the intake engine relaunches itself roughly every 54 minutes, so an in-process tally resets
// constantly and would never see a slow loop.
//
// Fail-open by design: if the count cannot be read, the send PROCEEDS. A monitoring failure must
// never silence a real referral. The cap exists to stop a runaway, not to become a new single
// point of failure.
//
// DELIBERATELY NOT USED BY watchdog.mjs OR dns-watchdog.mjs, and that is not an oversight.
// Those two are alarms. watchdog.mjs says so in its own header: it runs as its own workflow "so an
// engine crash can't silence it". Importing this module would make the alarm depend on the same
// Supabase the alarm exists to report on, so one outage would take out the engine AND the ability
// to tell Eric about it. Both already self-limit - watchdog sends one alert per outage tracked in
// audit_log, dns-watchdog runs weekly - so there is nothing for a cap to protect against. Leave
// them standalone.
import nodemailer from 'nodemailer';

// The scripts in this repo do not agree on what the mailbox variable is called: intake, access-nag
// and watchdog are handed ZOHO_USER, the other thirteen are handed ERIC_USER, and booking-reminders
// uses ZOHO_ERIC_USER. They all resolve to the same mailbox. Reading only one of them would leave
// the shared transport with no credentials on most runs, so every send would fail at once.
const ADMIN_EMAIL = 'eric@mdconcierge.net';
const MAIL_USER = process.env.ZOHO_USER
  || process.env.ERIC_USER
  || process.env.ZOHO_ERIC_USER
  || ADMIN_EMAIL;
const MAIL_PASS = process.env.ZOHO_APP_PASSWORD
  || process.env.ERIC_PASS
  || process.env.MDRX_ERIC_PASS
  || process.env.ZOHO_ERIC_APP_PASSWORD;
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

export const SEND_CAP_PER_HOUR = 6;   // a real case sends one notice + at most 3 reminders over ~6 business days
export const SEND_CAP_PER_DAY = 25;

const _raw = nodemailer.createTransport({
  host: 'smtp.zoho.com', port: 465, secure: true,
  auth: { user: MAIL_USER, pass: MAIL_PASS },
});

const _alerted = new Set();   // alert Eric once per address per run, never once per blocked message

const _headers = SUPABASE_SERVICE_KEY
  ? { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' }
  : null;

// Returns -1 when the count is unknown, which callers treat as "allow the send".
async function _countSince(addr, sinceIso) {
  if (!_headers || !SUPABASE_URL) return -1;
  try {
    const url = `${SUPABASE_URL}/rest/v1/audit_log?select=id&action=eq.mail_sent`
      + `&detail=eq.${encodeURIComponent(addr)}&created_at=gte.${sinceIso}`;
    const r = await fetch(url, { headers: _headers });
    if (!r.ok) return -1;
    return (await r.json()).length;
  } catch (e) { return -1; }
}

async function _record(addr) {
  if (!_headers || !SUPABASE_URL) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { ..._headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ case_id: null, action: 'mail_sent', detail: addr, source: 'automation' }),
    });
  } catch (e) { /* recording must never break a send */ }
}

function _recipients(to) {
  return String(to || '')
    .split(/[,;]/)
    .map((s) => (s.match(/<([^>]+)>/) || [null, s])[1].trim().toLowerCase())
    .filter((a) => a && /@/.test(a));
}

export const transporter = {
  async sendMail(msg) {
    const addrs = _recipients(msg.to);
    for (const addr of addrs) {
      const inHour = await _countSince(addr, new Date(Date.now() - 3600000).toISOString());
      if (inHour < 0) break;                     // unknown -> allow
      const inDay = await _countSince(addr, new Date(Date.now() - 86400000).toISOString());
      if (inHour >= SEND_CAP_PER_HOUR || (inDay >= 0 && inDay >= SEND_CAP_PER_DAY)) {
        const why = `${addr}: ${inHour}/h, ${inDay}/d - over the cap, send BLOCKED`;
        console.error(`MAIL CAP: ${why}`);
        if (!_alerted.has(addr)) {
          _alerted.add(addr);
          try {
            await _raw.sendMail({
              from: `MDconcierge <${MAIL_USER}>`, to: ADMIN_EMAIL,
              subject: 'MDconcierge: mail cap hit - sending to one address was stopped',
              text: `The engine tried to send more than ${SEND_CAP_PER_HOUR} emails in an hour to one address and was stopped.\n\n${why}\n\nNothing further goes to that address this run. This usually means a notification flag is not being set, so the same case is being picked up again and again. Worth looking at before it resumes.`,
              headers: { 'X-MDC-Auto': 'cap-alert' },
            });
          } catch (e) { /* an alert failure must not throw inside a send path */ }
        }
        return { blocked: true, reason: why };
      }
    }
    const res = await _raw.sendMail(msg);
    for (const addr of addrs) await _record(addr);   // record only after a successful send
    return res;
  },
};

export default transporter;
