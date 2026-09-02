// morning-report.mjs — one email, after the morning send window closes, saying what actually left.
//
// Eric asked for this on 2 Sep 2026, the day the cold cadence came back after six days of the gate
// refusing every touch while every run reported success. The per-run "Outreach sent: N, M held"
// notes are written from inside a single pass and say nothing about the morning as a whole, which
// is the thing he wants to know: did they go out.
//
// It reports what the outbox says, not what any job claims. A row with a sent_at is mail that left.
import nodemailer from 'nodemailer';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, ERIC_PASS })) {
  if (!v) { console.error('Missing env: ' + k); process.exit(1); }
}
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const get = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };

// Midnight Eastern, expressed as the instant it happened, so "this morning" means his morning and
// not the runner's. Everything the engine schedules is computed in the physician's timezone too.
const easternMidnight = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  const offsetMs = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`) - now.getTime();
  return new Date(Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`) - offsetMs);
};

const since = easternMidnight().toISOString();
const sent = await get(`mdrx_outbox?select=provider_id,touch_no,to_email,subject,sent_at&status=eq.sent&sent_at=gte.${since}&order=sent_at.asc&limit=500`);
const waiting = await get('mdrx_outbox?select=provider_id,touch_no,to_email,status&status=in.(pending,held)&limit=500');
const held = waiting.filter((r) => r.status === 'held');

const ids = [...new Set([...sent, ...waiting].map((r) => r.provider_id).filter(Boolean))];
const provs = ids.length ? await get(`mdrx_providers?select=id,first_name,last_name,credentials,practice_name&id=in.(${ids.join(',')})`) : [];
const by = Object.fromEntries(provs.map((p) => [p.id, p]));
const who = (r) => {
  const p = by[r.provider_id];
  if (!p) return r.to_email;
  const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() + (p.credentials ? ', ' + p.credentials : '');
  return `${name} (${p.practice_name || 'practice unknown'})`;
};
const at = (iso) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
}).format(new Date(iso));

const lines = [];
if (sent.length) {
  lines.push(`${sent.length} went out this morning.`, '');
  for (const r of sent) lines.push(`  ${at(r.sent_at).padStart(8)}  touch ${r.touch_no}  ${who(r)}`);
} else {
  lines.push('Nothing went out this morning.', '',
    waiting.length
      ? `${waiting.length} are still in the queue. If that number does not move by lunchtime, something is wrong.`
      : 'The queue is empty, so there was nothing to send.');
}
if (held.length) {
  lines.push('', `${held.length} held by the gate and NOT sent:`, '');
  for (const r of held) lines.push(`  touch ${r.touch_no}  ${who(r)}`);
  lines.push('', 'Held means the email was refused on its content. Worth looking at today.');
}
const stillPending = waiting.length - held.length;
if (stillPending > 0) lines.push('', `${stillPending} more are queued for later today or tomorrow morning.`);

const subject = sent.length
  ? `[MDconcierge] ${sent.length} went out this morning`
  : held.length
    ? `[MDconcierge] nothing sent this morning, ${held.length} held`
    : '[MDconcierge] nothing sent this morning';

const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject, text: lines.join('\n') });
console.log(subject + ` | sent=${sent.length} held=${held.length} pending=${stillPending}`);
