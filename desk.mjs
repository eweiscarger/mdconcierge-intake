// desk.mjs — the keeper.
//
// Eric, 15 September 2026: "we need to get to functionality ... for actually managing and running
// sales cycles and not letting things through the cracks ... nothing is happening besides shitty
// cold email and then i have to tell you to do everything."
//
// This runs first every weekday morning, before the cadence queues anything, and it does the job a
// sales manager does at eight o'clock: it reads the book, makes sure every live lead has a next step
// and a date, notices who has gone quiet, notices who is waiting on an answer, and finds the things
// Eric promised somebody in his own sent mail and has not done. Each one becomes a row in
// desk_items, and morning-digest reads those rows back to him once a day.
//
// IT SENDS NOTHING TO A PROSPECT. The only address anything in this file may write to is Eric's own,
// and only to say the job failed.
//
// DRY=1 makes it read-only: every write is printed and nothing is written.
// Outbound goes through the shared capped transport - see mailer.mjs for why.
import { transporter } from './mailer.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}
// Hard-pinned. Nothing here takes a recipient from data, so no code path can reach a physician.
const ERIC_USER = 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const DRY = /^(1|true|yes|on)$/i.test(String(process.env.DRY || ''));
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.DESK_DEBUG || ''));

const QUIET_DAYS = Number(process.env.DESK_QUIET_DAYS || 7);
const PROMISE_DAYS = Number(process.env.DESK_PROMISE_DAYS || 21);
const HISTORY_DAYS = 90;

// A lead in one of these is finished. Not Interested is a decline, so it is finished too; giving a
// declined physician a next step is how a book fills up with work nobody should do.
const TERMINAL = ['Won', 'Lost', 'Not Interested', 'Unsubscribed'];
// Stages where silence is a problem rather than the normal state of a cold lead.
const LIVE_STAGES = ['Engaged', 'Replied', 'Meeting Booked', 'Meeting Requested', 'Closing', 'Won'];
// Eric's own flag. Read-the-thread rule: these leads stay out of anything automatic.
const BY_HAND = /handles? by hand|no automated touch/i;

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };

async function sGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
// PostgREST caps a page, and the message table is well past one page.
async function sGetAll(path, pageSize = 1000) {
  const out = [];
  for (let offset = 0; offset <= 60000; offset += pageSize) {
    const rows = await sGet(`${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
async function sPatch(path, row) {
  if (DRY) { console.log(`  [dry] PATCH ${path} ${JSON.stringify(row)}`); return; }
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) console.error(`patch ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
async function sPost(table, row) {
  if (DRY) { console.log(`  [dry] INSERT ${table} ${JSON.stringify(row)}`); return; }
  // resolution=ignore-duplicates makes the unique dedupe_key the real guard, so two runs of this
  // job on the same morning cannot put the same promise on the desk twice.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok && r.status !== 409) console.error(`insert ${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---------------------------------------------------------------- dates, in Eric's timezone
const ET = 'America/New_York';
const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ymd = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();              // 0 Sunday .. 6 Saturday
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// RULES section 6: weekends never. Five rows were once dated for a Sunday because a due date was
// taken literally without asking what day it landed on.
const businessDay = (d) => { let x = d; while (dow(x) === 0 || dow(x) === 6) x = addDays(x, 1); return x; };
const addBusinessDays = (d, n) => { let x = d; for (let i = 0; i < n; i++) { x = businessDay(addDays(x, 1)); } return x; };
const daysSince = (t) => (t ? Math.floor((Date.parse(etToday() + 'T12:00:00Z') - Date.parse(ymd(t) + 'T12:00:00Z')) / 86400000) : null);
const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const niceDate = (d) => (d ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(ymd(d) + 'T12:00:00Z')) : '');

// ---------------------------------------------------------------- the plan for a lead with none
// The funnel lane is the Pennsylvania cold sequence, and only it may carry a touch number.
// Anything else is MDRx or PDRx by hand, and RULES section 5 keeps the PA material away from it.
const FUNNEL_PLAN = {
  New: { step: 'Touch 1: the ruling', days: 0 },
  Queued: { step: 'Touch 1: the ruling', days: 0 },
  Contacted: { step: 'Next cadence touch', days: 3 },
  Engaged: { step: 'Personal follow-up, he engaged with the last one', days: 1 },
  Replied: { step: 'Answer his reply', days: 0 },
  'Materials Sent': { step: 'Check he read the materials', days: 3 },
  'Meeting Requested': { step: 'Confirm the meeting time', days: 0 },
  'Meeting Booked': { step: 'Pre-call brief and prep', days: 1 },
  Met: { step: 'Send the recap and the next step', days: 1 },
  'Follow-up': { step: 'Follow up on the open question', days: 2 },
  Closing: { step: 'Chase the agreement', days: 2 },
  'Not Now': { step: 'Recycle when the window opens', days: 90 },
};
const LANE_PLAN = {
  New: { step: 'Decide the opening move on this lane. Not the PA cold cadence.', days: 1 },
  Queued: { step: 'Decide the opening move on this lane. Not the PA cold cadence.', days: 1 },
  Contacted: { step: 'Decide whether to follow up by hand', days: 3 },
  Engaged: { step: 'Personal follow-up, he engaged with the last one', days: 1 },
  Replied: { step: 'Answer his reply', days: 0 },
  'Meeting Requested': { step: 'Confirm the meeting time', days: 0 },
  'Meeting Booked': { step: 'Pre-call brief and prep', days: 1 },
  Met: { step: 'Send the recap and the next step', days: 1 },
  Closing: { step: 'Chase the agreement', days: 2 },
  'Not Now': { step: 'Revisit when the window opens', days: 90 },
};
// RULES section 6: the sequence is the spacing, measured from the later of the last send and
// last_touch_at, and the spacing widens as the sequence goes on.
const TOUCH_GAP = { 1: 3, 2: 5, 3: 7 };

function planFor(p, ctx) {
  const stage = String(p.funnel_stage || '');
  const funnel = String(p.lead_type || '') === 'funnel';

  // History beats the stage table wherever history says something plainer.
  if (ctx.waitingOnUs) return { step: `Answer ${ctx.who}. Wrote in on ${niceDate(ctx.lastInbound)} and has had no answer.`, date: businessDay(etToday()) };
  if (ctx.pendingMove) return { step: 'A reply is drafted on this record. Approve it, change it, or refuse it.', date: businessDay(etToday()) };
  if (funnel && Number(p.touch_count || 0) >= 4 && ['Contacted', 'New', 'Queued'].includes(stage)) {
    return { step: 'The four cold touches are done. Decide: rest him for 90 days, or work him by hand.', date: businessDay(etToday()) };
  }
  if (funnel && stage === 'Contacted' && Number(p.touch_count || 0) >= 1) {
    const gap = TOUCH_GAP[Number(p.touch_count)] || 7;
    const from = ymd(p.last_touch_at) || etToday();
    return { step: `Touch ${Number(p.touch_count) + 1}`, date: businessDay(addDays(from, gap)) };
  }
  const plan = (funnel ? FUNNEL_PLAN : LANE_PLAN)[stage] || { step: 'Review the thread and decide the next move', days: 1 };
  return { step: plan.step, date: businessDay(addDays(etToday(), plan.days)) };
}

// ---------------------------------------------------------------- promises in Eric's own mail
// Everything below the first quote marker is the thread he was replying to, not what he wrote. The
// bodies are stored with the whitespace collapsed, so none of these can be anchored to a newline.
function ownWords(text) {
  let t = String(text || '');
  for (const cut of [/On\s.{0,140}?\swrote:/i, /-{3,}\s*Original Message/i, /\bFrom:\s+[^<]{0,80}<[^>]+>/, /_{10,}/, /CONFIDENTIALITY NOTICE/i]) {
    const m = t.search(cut);
    if (m > 0) t = t.slice(0, m);
  }
  return t.replace(/^\s*>.*$/gm, '').trim().slice(0, 8000);
}
const VERB = '(send|sending|get|getting|have|put|forward|share|email|call|follow up|pull|draft|price|check|ask|introduce|connect|set up|schedule|write|look|run|bring|drop|stop by|reach out|circle|confirm|find)';
const PROMISE_RES = [
  new RegExp(`\\bI(?:'|’)?ll\\s+(?:${VERB})\\b`, 'i'),
  new RegExp(`\\bI will\\s+(?:${VERB})\\b`, 'i'),
  new RegExp(`\\bI(?:'|’)?m going to\\s+(?:${VERB})\\b`, 'i'),
  new RegExp(`\\bwe(?:'|’)?ll\\s+(?:${VERB})\\b`, 'i'),
  new RegExp(`\\blet me\\s+(?:${VERB})\\b`, 'i'),
  /\bI owe you\b/i,
  /\bI(?:'|’)?ll\s+(?:get|have|send)\s+(?:that|it|this|them|those|you)\b/i,
];
// A commitment that waits on the physician doing something first is an offer, not a debt. The
// cadence and the booking notes are full of them: "just tell me a day and I'll send the invite",
// "let me know and I'll send you some information". Eric owes nothing until they answer, so none of
// these belong on his desk. A sentence carrying a link is campaign copy for the same reason.
const CONDITIONAL_RE = /\bif\b|\bjust (?:tell|reply|send|let|grab)\b|\bsend me\b|\breply with\b|\blet me know\b|\btell me\b|\beither way\b|\bwhichever\b|\bor grab\b|\bonce you\b|\bwhen you\b/i;
const LINK_RE = /https?:\/\//i;
const TIMEFRAME_RE = /\b(today|tomorrow|this week|next week|by the end of (?:the )?(?:day|week)|by (?:monday|tuesday|wednesday|thursday|friday)|(?:on|by) (?:mon|tues|wednes|thurs|fri)day|in a few days|first thing|shortly|this afternoon)\b/i;
const WEEKDAY = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };

function dueFromTimeframe(sentYmd, sentence) {
  const m = sentence.match(TIMEFRAME_RE);
  if (!m) return addBusinessDays(sentYmd, 3);
  const t = m[1].toLowerCase();
  if (/today|first thing|this afternoon|shortly/.test(t)) return businessDay(sentYmd);
  if (t === 'tomorrow') return addBusinessDays(sentYmd, 1);
  if (t === 'this week' || /end of (the )?week/.test(t)) { let d = sentYmd; while (dow(d) !== 5) d = addDays(d, 1); return d; }
  if (t === 'next week') { let d = addDays(sentYmd, 7); while (dow(d) !== 5) d = addDays(d, 1); return d; }
  if (/end of (the )?day/.test(t)) return businessDay(sentYmd);
  if (t === 'in a few days') return addBusinessDays(sentYmd, 3);
  const wd = Object.keys(WEEKDAY).find((k) => t.includes(k.slice(0, 5)));
  if (wd) { let d = addDays(sentYmd, 1); for (let i = 0; i < 8 && dow(d) !== WEEKDAY[wd]; i++) d = addDays(d, 1); return d; }
  return addBusinessDays(sentYmd, 3);
}

const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
// The approved cold opener. Anything carrying it is the cadence's own words, not Eric's promise.
const COLD_MARKER = /don'?t love sending cold emails/i;

function findPromises(body, sentAt) {
  const text = ownWords(body);
  if (!text || COLD_MARKER.test(text)) return [];
  const out = [];
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 12 || s.length > 300) continue;
    if (CONDITIONAL_RE.test(s) || LINK_RE.test(s)) continue;
    if (!PROMISE_RES.some((re) => re.test(s))) continue;
    out.push({ sentence: s, due: dueFromTimeframe(ymd(sentAt), s), key: normalize(s) });
  }
  // One email can restate the same commitment twice. One promise is one item.
  const seen = new Set();
  return out.filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
}

// ---------------------------------------------------------------- run
async function main() {
  const today = etToday();
  const notTerminal = TERMINAL.map((s) => encodeURIComponent(s)).join(',');

  const leads = await sGetAll(
    'mdrx_providers?select=id,first_name,last_name,credentials,practice_name,email,state,lead_type,funnel_stage,next_step,funnel_next_date,touch_count,last_touch_at,manual_touch_at,engaged_at,needs_attention,priority,on_hold,suppressed,decision_authority'
    + `&suppressed=eq.false&on_hold=eq.false&funnel_stage=not.in.(${notTerminal})&order=id.asc`);
  const byId = new Map(leads.map((p) => [p.id, p]));

  // A promise is a personal debt and does not care what stage a lead sits in. Lauren Bechtold is on
  // the PDRx lane and out of the cadence, and Eric still told her he would get her the injection kit
  // costs. So promises are matched against everybody on the book, held and finished included.
  // Suppressed and unsubscribed people are the one exception: nothing is owed to somebody we may
  // not write to at all.
  const people = await sGetAll('mdrx_providers?select=id,first_name,last_name,practice_name,email,funnel_stage,lead_type,on_hold,next_step,funnel_next_date&suppressed=eq.false&order=id.asc');
  const anyoneById = new Map(people.map((p) => [p.id, p]));

  const msgs = await sGetAll(`mdrx_messages?select=id,provider_id,direction,subject,sent_at&sent_at=gte.${isoDaysAgo(HISTORY_DAYS)}&order=sent_at.asc`);
  const outMsgs = await sGetAll(`mdrx_messages?select=id,provider_id,subject,sent_at,body_text&direction=eq.out&sent_at=gte.${isoDaysAgo(PROMISE_DAYS)}&order=sent_at.asc`, 200);
  const outboxSent = await sGetAll(`mdrx_outbox?select=id,provider_id,touch_no,subject,sent_at&status=eq.sent&sent_at=gte.${isoDaysAgo(HISTORY_DAYS)}&order=sent_at.asc`);
  const outboxBodies = await sGetAll(`mdrx_outbox?select=id,provider_id,subject,sent_at,body_text&status=eq.sent&sent_at=gte.${isoDaysAgo(PROMISE_DAYS)}&order=sent_at.asc`, 200);
  const acts = await sGetAll(`mdrx_activity?select=provider_id,type,occurred_at,subject&occurred_at=gte.${isoDaysAgo(HISTORY_DAYS)}&order=occurred_at.asc`);
  const moves = await sGetAll('mdrx_next_moves?select=id,provider_id,status&status=eq.pending');
  const openItems = await sGetAll('desk_items?select=id,provider_id,kind,title,due_date,source,dedupe_key,status,created_at&status=eq.open');

  // Last time anything happened on a lead, from every place the platform records one.
  const lastIn = new Map(), lastOut = new Map(), lastAny = new Map(), lastInMsg = new Map();
  const bump = (m, id, t) => { if (!id || !t) return; const prev = m.get(id); if (!prev || Date.parse(t) > Date.parse(prev)) m.set(id, t); };
  for (const m of msgs) {
    bump(lastAny, m.provider_id, m.sent_at);
    if (m.direction === 'in') { bump(lastIn, m.provider_id, m.sent_at); const p = lastInMsg.get(m.provider_id); if (!p || Date.parse(m.sent_at) > Date.parse(p.sent_at)) lastInMsg.set(m.provider_id, m); }
    else bump(lastOut, m.provider_id, m.sent_at);
  }
  for (const o of outboxSent) { bump(lastAny, o.provider_id, o.sent_at); bump(lastOut, o.provider_id, o.sent_at); }
  for (const a of acts) { bump(lastAny, a.provider_id, a.occurred_at); if (a.type === 'email_out' || a.type === 'call') bump(lastOut, a.provider_id, a.occurred_at); }
  const pendingMove = new Set(moves.map((m) => m.provider_id));

  const nameOf = (p) => `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || ('lead ' + p.id);
  const whoOf = (p) => nameOf(p) + (p.practice_name ? ` (${p.practice_name})` : '');

  const wanted = new Map();   // dedupe_key -> row we want on the desk
  const want = (row) => { if (!wanted.has(row.dedupe_key) && !openItems.some((i) => i.dedupe_key === row.dedupe_key)) wanted.set(row.dedupe_key, row); };
  let filled = 0, flaggedQuiet = 0, flaggedWaiting = 0;

  // ---- 1. every live lead carries a next step and a date --------------------------------------
  for (const p of leads) {
    bump(lastAny, p.id, p.last_touch_at); bump(lastAny, p.id, p.manual_touch_at); bump(lastAny, p.id, p.engaged_at);
    const byHand = BY_HAND.test(String(p.next_step || ''));
    const li = lastIn.get(p.id), lo = lastOut.get(p.id);
    const waitingOnUs = !!li && (!lo || Date.parse(li) > Date.parse(lo));
    const ctx = { who: p.first_name || nameOf(p), lastInbound: li, waitingOnUs, pendingMove: pendingMove.has(p.id) };

    // "Eric handles by hand. No automated touch." is the flag that keeps a lead out of the machine,
    // and a null funnel_next_date is what keeps it out of every past due query. Writing a date onto
    // one of those rows is exactly how a PDRx lead ended up queued for the Pennsylvania cold touch.
    // So a by-hand lead is left alone here, date and all.
    if ((!p.next_step || !p.funnel_next_date) && !byHand) {
      const plan = planFor(p, ctx);
      const patch = {};
      if (!p.next_step) patch.next_step = plan.step;
      if (!p.funnel_next_date) patch.funnel_next_date = plan.date;
      await sPatch(`mdrx_providers?id=eq.${p.id}`, patch);
      filled++;
      want({
        provider_id: p.id, kind: 'no_next_step',
        title: `${whoOf(p)} had ${p.next_step ? 'no date on the next step' : 'no next step'}`,
        detail: `${p.funnel_stage || 'no stage'} on the ${p.lead_type || 'unknown'} lane. Given: ${patch.next_step || p.next_step}, due ${patch.funnel_next_date || p.funnel_next_date}.`,
        due_date: patch.funnel_next_date || p.funnel_next_date, source: null,
        dedupe_key: `no_next_step:${p.id}:${today}`, status: 'open',
      });
    }

    // ---- 2. somebody wrote in and has had no answer ------------------------------------------
    if (waitingOnUs) {
      const m = lastInMsg.get(p.id);
      const days = daysSince(li);
      if (m && days >= 1) {
        want({
          provider_id: p.id, kind: 'reply_waiting',
          title: `${whoOf(p)} is waiting on an answer`,
          detail: `He wrote on ${niceDate(li)} about "${String(m.subject || '').slice(0, 120)}" and nothing has gone back. ${days} day${days === 1 ? '' : 's'} now.`,
          due_date: businessDay(today), source: `message:${m.id}`,
          dedupe_key: `reply_waiting:${p.id}:${m.id}`, status: 'open',
        });
        flaggedWaiting++;
        if (!byHand && !p.needs_attention) await sPatch(`mdrx_providers?id=eq.${p.id}`, { needs_attention: true });
      }
    }

    // ---- 3. gone quiet -----------------------------------------------------------------------
    if (LIVE_STAGES.includes(String(p.funnel_stage || ''))) {
      const last = lastAny.get(p.id);
      const days = daysSince(last);
      if (days === null || days >= QUIET_DAYS) {
        // No pronouns. Half this book is women, and the credentials on the record are the reason
        // three people were addressed wrongly once already.
        const owed = waitingOnUs
          ? `Answer ${p.first_name || nameOf(p)}. Wrote in on ${niceDate(li)} and has had no reply.`
          : pendingMove.has(p.id)
            ? 'A reply is drafted on this record and nobody has ruled on it.'
            : `Nothing has moved since ${last ? niceDate(last) : 'the record was created'}. Decide the next move or rest the lead.`;
        want({
          provider_id: p.id, kind: 'quiet',
          title: `${whoOf(p)} has gone quiet`,
          detail: `${p.funnel_stage} and ${days === null ? 'no activity on the record at all' : days + ' days with no activity'}. ${owed}`,
          due_date: businessDay(today), source: null,
          dedupe_key: `quiet:${p.id}:${ymd(last) || 'never'}`, status: 'open',
        });
        flaggedQuiet++;
        const patch = { needs_attention: true };
        // Never write over a next step he or another agent already put there. A blank one gets the
        // owed line, and so does a lead that is concretely owed an answer. Anything else keeps the
        // step it has, and the desk item carries what is owed instead.
        if (!byHand && (!p.next_step || waitingOnUs || pendingMove.has(p.id))) patch.next_step = owed.slice(0, 400);
        await sPatch(`mdrx_providers?id=eq.${p.id}`, patch);
      }
    }
  }

  // ---- 4. what Eric promised in his own sent mail ----------------------------------------------
  const candidates = [];
  for (const m of outMsgs) for (const pr of findPromises(m.body_text, m.sent_at)) candidates.push({ ...pr, pid: m.provider_id, sent_at: m.sent_at, subject: m.subject, source: `message:${m.id}` });
  for (const o of outboxBodies) for (const pr of findPromises(o.body_text, o.sent_at)) candidates.push({ ...pr, pid: o.provider_id, sent_at: o.sent_at, subject: o.subject, source: `outbox:${o.id}` });

  if (DEBUG) for (const c of candidates) console.log(`  [debug] candidate pid=${c.pid} ${ymd(c.sent_at)} due ${c.due} "${c.sentence}"`);

  // The same sentence to several physicians is template wording, not a promise to any one of them.
  const spread = new Map();
  for (const c of candidates) { const s = spread.get(c.key) || new Set(); s.add(c.pid); spread.set(c.key, s); }

  let promises = 0, templated = 0, alreadyDone = 0;
  for (const c of candidates) {
    if ((spread.get(c.key) || new Set()).size > 2) { templated++; continue; }
    if (!c.pid) continue;                       // a promise to nobody on the book is not actionable
    const p = anyoneById.get(c.pid);
    if (!p) continue;                           // suppressed or unsubscribed, so nothing is owed
    // Satisfied already: something went out to him after he was promised it.
    const lo = lastOut.get(c.pid);
    if (lo && Date.parse(lo) > Date.parse(c.sent_at)) { alreadyDone++; continue; }
    want({
      provider_id: c.pid, kind: 'promise',
      title: `You told ${whoOf(p)} you would do something`,
      detail: `On ${niceDate(c.sent_at)}, in "${String(c.subject || '').slice(0, 120)}", you wrote: "${c.sentence}" Nothing has gone out to him since.`,
      due_date: c.due, source: c.source,
      dedupe_key: `promise:${c.source}:${c.key}`, status: 'open',
    });
    promises++;
  }

  // ---- 5. close what has been satisfied ---------------------------------------------------------
  let closed = 0, dismissed = 0;
  for (const it of openItems) {
    const p = it.provider_id ? anyoneById.get(it.provider_id) : null;
    const live = it.provider_id ? byId.get(it.provider_id) : null;
    // Off the book or suppressed since. Nothing is owed to somebody we may not write to.
    if (it.provider_id && !p) {
      await sPatch(`desk_items?id=eq.${it.id}`, { status: 'dismissed', resolved_at: new Date().toISOString() });
      dismissed++; continue;
    }
    // Put on hold or closed out since. That ends a next step and a follow-up, but a promise Eric
    // made to a person is still a promise, so it stays on the desk.
    if (it.provider_id && !live && it.kind !== 'promise') {
      await sPatch(`desk_items?id=eq.${it.id}`, { status: 'dismissed', resolved_at: new Date().toISOString() });
      dismissed++; continue;
    }
    const lo = lastOut.get(it.provider_id), la = lastAny.get(it.provider_id);
    let done = false;
    if (it.kind === 'reply_waiting') {
      const mid = Number(String(it.source || '').replace('message:', ''));
      const m = msgs.find((x) => x.id === mid);
      done = !!(lo && m && Date.parse(lo) > Date.parse(m.sent_at));
    } else if (it.kind === 'promise') {
      // Recorded before the answer went out, so anything outbound since settles it.
      done = !!(lo && Date.parse(lo) > Date.parse(it.created_at));
    } else if (it.kind === 'quiet') {
      done = !!(la && Date.parse(la) > Date.parse(it.created_at));
    } else if (it.kind === 'no_next_step') {
      done = !!(p && p.next_step && p.funnel_next_date);
    }
    if (done) { await sPatch(`desk_items?id=eq.${it.id}`, { status: 'done', resolved_at: new Date().toISOString() }); closed++; }
  }

  // ---- 6. write the new items -------------------------------------------------------------------
  const rows = [...wanted.values()];
  for (const row of rows) await sPost('desk_items', row);

  const counts = rows.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {});
  console.log(`desk${DRY ? ' [DRY RUN, nothing written]' : ''}: ${leads.length} live leads read.`);
  console.log(`  next steps filled: ${filled}`);
  console.log(`  waiting on an answer: ${flaggedWaiting}`);
  console.log(`  gone quiet (${QUIET_DAYS}+ days): ${flaggedQuiet}`);
  console.log(`  promises found in ${PROMISE_DAYS} days of sent mail: ${promises} new, ${alreadyDone} already answered, ${templated} template wording ignored`);
  console.log(`  new desk items: ${rows.length} ${JSON.stringify(counts)}`);
  console.log(`  items closed: ${closed} done, ${dismissed} dismissed`);
  if (DRY) for (const r of rows) console.log(`  [dry] would add ${r.kind}: ${r.title} | due ${r.due_date} | ${String(r.detail || '').slice(0, 220)}`);

  if (!DRY) {
    await sPost('mdrx_desk_log', {
      agent: 'Desk', provider_id: null, action: 'morning pass',
      detail: `${leads.length} live leads. ${filled} next steps filled, ${flaggedQuiet} quiet, ${flaggedWaiting} waiting on us, ${promises} promises. ${closed} items closed.`,
      meta: { leads: leads.length, filled, quiet: flaggedQuiet, waiting: flaggedWaiting, promises, closed, dismissed, new_items: rows.length },
    });
  }
}

main().catch(async (e) => {
  const msg = String(e?.stack || e?.message || e);
  console.error('desk failed: ' + msg);
  // Transient network trouble is not an incident; the next weekday morning picks up the same book.
  if (/timeout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|502|503|504/i.test(msg)) { process.exit(1); }
  // Anything else goes to Eric rather than finishing green, which is how the AI jobs went dark for
  // days in September. This is the only mail this file can send, and only to him.
  if (ERIC_PASS && !DRY) {
    try {
      const t = transporter;   // shared capped transport
      await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: '[MDconcierge] the desk job hit a problem', text: msg.slice(0, 2000) });
    } catch (_) {}
  }
  process.exit(1);
});
