// morning-digest.mjs — one email a weekday morning, to Eric, and nothing else.
//
// This replaces the scatter. He was getting a past due escalation, a send report, a news nudge and
// an access nag, each from a different job, none of which told him what to actually do today.
// This is the desk read back to him: what went out, who wrote in, who is hot, what he promised and
// has not done, who went quiet, what is queued, and the two or three things only he can decide.
//
// Plain text on purpose. It is a note from his own desk, not a newsletter. It links nothing he
// would have to log in to reach, and names people by name and practice.
//
// It sends to eric@mdconcierge.net and to no other address, ever. If there is nothing worth saying,
// it sends nothing.
// Outbound goes through the shared capped transport - see mailer.mjs for why.
import { transporter } from './mailer.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}
// Hard-pinned. No recipient in this file comes from data, so nothing here can reach a physician.
const ERIC_USER = 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const DRY = /^(1|true|yes|on)$/i.test(String(process.env.DRY || ''));

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`GET ${p.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json(); };

const ET = 'America/New_York';
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const ymd = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
// Midnight Eastern as a real instant, so "this morning" is his morning and not the runner's.
const etMidnight = (d) => {
  const probe = new Date(d + 'T12:00:00Z');
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ET, hour: '2-digit', hourCycle: 'h23' }).formatToParts(probe).find((x) => x.type === 'hour').value;
  return new Date(Date.parse(d + 'T00:00:00Z') + (12 - Number(p)) * 3600000);
};
const prevBusinessDay = (d) => { let x = addDays(d, -1); while (dow(x) === 0 || dow(x) === 6) x = addDays(x, -1); return x; };
const at = (t) => new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(t));
const dayName = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(d + 'T12:00:00Z'));
const shortDate = (d) => (d ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(ymd(d) + 'T12:00:00Z')) : '');

const TERMINAL = ['Won', 'Lost', 'Not Interested', 'Unsubscribed'];

async function main() {
  const today = etToday();
  const since = etMidnight(prevBusinessDay(today)).toISOString();
  const todayStart = etMidnight(today).toISOString();

  const [sent, held, queued, replies, items, drafts, moves] = await Promise.all([
    sGet(`mdrx_outbox?select=id,provider_id,touch_no,to_email,subject,sent_at&status=eq.sent&sent_at=gte.${since}&order=sent_at.asc&limit=500`),
    sGet('mdrx_outbox?select=id,provider_id,touch_no,to_email,subject&status=eq.held&limit=200'),
    sGet('mdrx_outbox?select=id,provider_id,touch_no,to_email,subject,scheduled_date&status=eq.pending&limit=500'),
    sGet(`mdrx_messages?select=id,provider_id,from_addr,from_name,subject,sent_at&direction=eq.in&sent_at=gte.${since}&order=sent_at.asc&limit=200`),
    sGet('desk_items?select=id,provider_id,kind,title,detail,due_date,created_at&status=eq.open&order=due_date.asc&limit=400'),
    sGet('mdrx_inbox_drafts?select=id,provider_id,from_name,from_addr,subject,sentiment,hot,received_at&status=eq.pending&order=received_at.desc&limit=50'),
    sGet('mdrx_next_moves?select=id,provider_id,subject,recommended_date&status=eq.pending&order=recommended_date.asc&limit=50'),
  ]);

  const dueToday = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,funnel_stage,next_step,funnel_next_date&suppressed=eq.false&on_hold=eq.false&funnel_stage=not.in.(${TERMINAL.map(encodeURIComponent).join(',')})&funnel_next_date=lte.${today}&order=funnel_next_date.asc&limit=500`);
  const active = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,funnel_stage,next_step,needs_attention,priority&suppressed=eq.false&on_hold=eq.false&funnel_stage=not.in.(${TERMINAL.map(encodeURIComponent).join(',')})&limit=1000`);

  // One lookup for every person named anywhere in the mail.
  const ids = [...new Set([...sent, ...held, ...queued, ...replies, ...items, ...drafts, ...moves].map((r) => r.provider_id).filter(Boolean))];
  const provs = ids.length ? await sGet(`mdrx_providers?select=id,first_name,last_name,credentials,practice_name,funnel_stage,state,lead_type&id=in.(${ids.join(',')})&limit=1000`) : [];
  const by = new Map(provs.map((p) => [p.id, p]));
  const name = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim() || ('lead ' + p.id);
  const who = (pid, fallback) => {
    const p = by.get(pid);
    if (!p) return fallback || 'someone not on the book';
    return name(p) + (p.practice_name ? `, ${p.practice_name}` : '');
  };

  const promises = items.filter((i) => i.kind === 'promise');
  const quiet = items.filter((i) => i.kind === 'quiet');
  const waiting = items.filter((i) => i.kind === 'reply_waiting');
  const newSteps = items.filter((i) => i.kind === 'no_next_step');
  const overdue = promises.filter((i) => i.due_date && i.due_date < today);

  const L = [];
  const section = (head, lines) => { if (!lines.length) return; L.push(head, ...lines, ''); };

  // ---- what went out ---------------------------------------------------------------------------
  const outLines = [];
  const thisMorning = sent.filter((s) => s.sent_at >= todayStart);
  const earlier = sent.filter((s) => s.sent_at < todayStart);
  if (thisMorning.length) {
    outLines.push(`${thisMorning.length} went out this morning.`);
    for (const s of thisMorning.slice(0, 15)) outLines.push(`  ${at(s.sent_at)}  touch ${s.touch_no || '-'}  ${who(s.provider_id, s.to_email)}`);
    if (thisMorning.length > 15) outLines.push(`  and ${thisMorning.length - 15} more.`);
  }
  if (earlier.length) outLines.push(`${earlier.length} went out ${dayName(prevBusinessDay(today))}.`);
  if (!sent.length) outLines.push(`Nothing has gone out since ${dayName(prevBusinessDay(today))}. If the queue is not empty, that is a fault.`);
  if (held.length) {
    outLines.push(`${held.length} held by the gate and not sent:`);
    for (const h of held.slice(0, 8)) outLines.push(`  touch ${h.touch_no || '-'}  ${who(h.provider_id, h.to_email)}`);
    if (held.length > 8) outLines.push(`  and ${held.length - 8} more.`);
    outLines.push('Held means the copy gate refused it. It needs wording you approve or it never goes.');
  }
  section('WHAT WENT OUT', outLines);

  // ---- who replied -----------------------------------------------------------------------------
  // People on the book only. His partners and the VeroMed thread write to him all day and none of
  // that is a sales cycle. One person who wrote four times is one line, not four.
  const repliedBy = new Map();
  for (const r of replies) if (r.provider_id && by.has(r.provider_id)) repliedBy.set(r.provider_id, r);
  section('WHO WROTE IN', [...repliedBy.values()].slice(0, 20).map((r) => `  ${who(r.provider_id)}: "${String(r.subject || '').slice(0, 90)}" on ${shortDate(r.sent_at)}`));

  // ---- who is hot ------------------------------------------------------------------------------
  // Hot means real signal: they wrote back, a time is on the calendar, or a deal is closing.
  // Not simply that the desk flagged them this morning, which would make this section a second
  // copy of GONE QUIET, and the two lists did read identically the first time this ran.
  const HOT_STAGES = ['Replied', 'Meeting Requested', 'Meeting Booked', 'Closing'];
  const quietIds = new Set(quiet.map((i) => i.provider_id));
  const hotLeads = active
    .filter((p) => !quietIds.has(p.id))
    .filter((p) => HOT_STAGES.includes(String(p.funnel_stage || '')) || p.priority === 'high')
    .sort((a, b) => HOT_STAGES.indexOf(String(b.funnel_stage)) - HOT_STAGES.indexOf(String(a.funnel_stage)));
  const hotDrafts = drafts.filter((d) => d.hot);
  const hotLines = [];
  for (const p of hotLeads.slice(0, 12)) hotLines.push(`  ${name(p)}${p.practice_name ? ', ' + p.practice_name : ''} (${p.funnel_stage}): ${String(p.next_step || 'no next step').slice(0, 110)}`);
  for (const d of hotDrafts.slice(0, 6)) hotLines.push(`  ${who(d.provider_id, d.from_name || d.from_addr)} came in hot: "${String(d.subject || '').slice(0, 80)}"`);
  section('WHO IS HOT', hotLines);

  // ---- promises --------------------------------------------------------------------------------
  section('WHAT YOU SAID YOU WOULD DO AND HAVE NOT', promises.slice(0, 15).map((i) => {
    const late = i.due_date && i.due_date < today ? ` (was due ${shortDate(i.due_date)})` : i.due_date ? ` (due ${shortDate(i.due_date)})` : '';
    return `  ${who(i.provider_id)}${late}\n    ${String(i.detail || i.title).slice(0, 300)}`;
  }));

  // ---- waiting on an answer --------------------------------------------------------------------
  section('WAITING ON AN ANSWER FROM YOU', waiting.slice(0, 12).map((i) => `  ${who(i.provider_id)}: ${String(i.detail || '').slice(0, 200)}`));

  // ---- gone quiet ------------------------------------------------------------------------------
  const quietLines = quiet.slice(0, 15).map((i) => `  ${who(i.provider_id)}: ${String(i.detail || '').slice(0, 200)}`);
  if (quiet.length > 15) quietLines.push(`  and ${quiet.length - 15} more.`);
  section('GONE QUIET', quietLines);

  // ---- queued today ----------------------------------------------------------------------------
  const queueLines = [];
  if (queued.length) queueLines.push(`${queued.length} email${queued.length === 1 ? '' : 's'} queued in the outbox.`);
  if (dueToday.length) {
    queueLines.push(`${dueToday.length} lead${dueToday.length === 1 ? '' : 's'} have a next step due today or earlier. The first few:`);
    for (const p of dueToday.slice(0, 8)) queueLines.push(`  ${name(p)}${p.practice_name ? ', ' + p.practice_name : ''}: ${String(p.next_step || '').slice(0, 100)} (${p.funnel_next_date})`);
  }
  if (newSteps.length) queueLines.push(`${newSteps.length} lead${newSteps.length === 1 ? '' : 's'} had no next step at all this morning and the desk gave them one.`);
  section('QUEUED TODAY', queueLines);

  // ---- only he can decide ----------------------------------------------------------------------
  // Two or three, ranked. A list of ten decisions is the thing he already has.
  const decisions = [];
  if (drafts.length) decisions.push(`${drafts.length} repl${drafts.length === 1 ? 'y is' : 'ies are'} drafted and waiting on your yes or no. Oldest: ${who(drafts[drafts.length - 1].provider_id, drafts[drafts.length - 1].from_name)}, "${String(drafts[drafts.length - 1].subject || '').slice(0, 70)}".`);
  if (overdue.length) decisions.push(`You are past the date on ${overdue.length} thing${overdue.length === 1 ? '' : 's'} you told someone you would do. First one: ${who(overdue[0].provider_id)}.`);
  if (moves.length) decisions.push(`${moves.length} next move${moves.length === 1 ? ' is' : 's are'} drafted on records and nobody has ruled on ${moves.length === 1 ? 'it' : 'them'}.`);
  if (held.length) decisions.push(`${held.length} email${held.length === 1 ? '' : 's'} sat held by the copy gate. They need wording you approve or they never go.`);
  if (waiting.length) decisions.push(`${waiting.length} ${waiting.length === 1 ? 'person is' : 'people are'} waiting on an answer from you, longest ${who(waiting[0].provider_id)}.`);
  section('ONLY YOU CAN DECIDE', decisions.slice(0, 3).map((d, i) => `  ${i + 1}. ${d}`));

  if (!L.length) { console.log('morning-digest: nothing worth saying, sending nothing.'); return; }

  const headline = [
    thisMorning.length ? `${thisMorning.length} out` : null,
    repliedBy.size ? `${repliedBy.size} in` : null,
    promises.length ? `${promises.length} owed` : null,
    quiet.length ? `${quiet.length} quiet` : null,
  ].filter(Boolean).join(', ');
  const subject = `the desk, ${dayName(today).slice(0, 3)} ${shortDate(today)}${headline ? ': ' + headline : ''}`;
  const text = L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  console.log(subject);
  console.log(text);
  if (DRY) { console.log('morning-digest: DRY, nothing sent.'); return; }
  if (!ERIC_PASS) { console.log('morning-digest: no mail password set, printed only.'); return; }

  const t = transporter;   // shared capped transport
  await t.sendMail({ headers: { 'X-MDC-Bot': 'engine', 'X-MDC-Auto': 'desk-digest' }, from: `"The desk" <${ERIC_USER}>`, to: ERIC_USER, subject, text });
  console.log(`morning-digest: sent to ${ERIC_USER}.`);
}

main().catch(async (e) => {
  const msg = String(e?.stack || e?.message || e);
  console.error('morning-digest failed: ' + msg);
  if (/timeout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|502|503|504/i.test(msg)) process.exit(1);
  if (ERIC_PASS && !DRY) {
    try {
      const t = transporter;   // shared capped transport
      await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: '[MDconcierge] the morning digest hit a problem', text: msg.slice(0, 2000) });
    } catch (_) {}
  }
  process.exit(1);
});
