// SENTRY — the watch.
//
// Duty: every night, decide who on the list is a human being and who is a mail scanner, and move
// the humans out of the marketing drip so they get written to like people instead of waiting for
// the next drip touch.
//
// This exists because the platform got it wrong once and it cost real credibility. Fifty-eight
// percent of all funnel events are corporate mail scanners. Mimecast, Proofpoint and Safe Links
// open every link in every message and render the page to check it is safe, reporting one hundred
// percent scroll in four to ten seconds. funnel-track.ts detects them well and already refuses to
// let a tracking pixel feed the score, but the ROLLUP COLUMNS on the provider row were counting bot
// events, and behaviorScore() reads those columns. So a lead whose every event was a machine still
// carried a score of 84 and looked like the hottest name on the book. Twenty-two leads were
// promoted on a bare click. Nineteen of them were machines.
//
// THE HUMAN BAR, set by the board on 10 September 2026 and not to be loosened without Eric:
//   a CLEAN click (not flagged suspected_bot), 30 seconds of real dwell, and activity on two or
//   more SEPARATE days.
// The last clause is the one that does the work. A scanner reads once, on the day of delivery, and
// never comes back. A physician comes back.
//
// A scanner click is still worth something: it is a delivery receipt. It only fires on mail that
// reached the company gateway, so it proves the message got through. It is not intent, and it never
// promotes anybody.
//
// Sentry never sends anything and never writes copy. It moves a lead into Engaged and hands it to
// the Chair. Nothing leaves the building without Eric.
import fs from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const local = () => {
  const f = 'C:/Users/eweis/.mdconcierge-assistant/supabase.env';
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
};
const env = (SUPABASE_URL && SERVICE_KEY) ? { SUPABASE_URL, SUPABASE_SERVICE_KEY: SERVICE_KEY } : local();
const H = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY };
const HW = { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const REST = env.SUPABASE_URL + '/rest/v1/';
const API = REST + 'mdrx_providers';
const WRITE = process.argv.includes('--write') || process.env.SENTRY_WRITE === '1';

const AGENT = 'Sentry';
const HUMAN_SECONDS = 30;
const HUMAN_DAYS = 2;
const IN_DRIP = ['New', 'Queued', 'Contacted'];

// Verbatim from funnel-track.ts. Do not "improve" it here. A rescored number has to mean exactly
// what the live number means, or the two disagree and neither can be trusted.
function behaviorScore(p) {
  let s = 0;
  if (p.funnel_clicked) s += 10;
  s += Math.min(Number(p.funnel_open_count) || 0, 5) * 3;
  const scroll = Number(p.funnel_max_scroll) || 0;
  s += scroll >= 90 ? 15 : scroll >= 50 ? 8 : scroll >= 25 ? 4 : 0;
  const secs = Number(p.funnel_total_seconds) || 0;
  s += secs >= 180 ? 20 : secs >= 60 ? 12 : secs >= 20 ? 6 : 0;
  const cta = String(p.funnel_last_cta || '');
  if (p.funnel_booked || cta === 'book') s += 40;
  else if (cta === 'request-info') s += 25;
  else if (cta.startsWith('doc-')) s += 10;
  else if (cta) s += 8;
  if (p.funnel_booked) s += 20;
  return s;
}

async function all(path) {
  let out = [], from = 0;
  for (;;) {
    const r = await fetch(`${REST}${path}&limit=1000&offset=${from}`, { headers: H });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    const b = await r.json();
    out = out.concat(b);
    if (b.length < 1000) return out;
    from += 1000;
  }
}

const logs = [];
const note = (action, detail, provider_id = null, meta = null) =>
  logs.push({ agent: AGENT, action, detail, provider_id, meta });

async function flushLog() {
  if (!logs.length || !WRITE) return;
  const r = await fetch(REST + 'mdrx_desk_log', { method: 'POST', headers: HW, body: JSON.stringify(logs) });
  if (!r.ok) console.error('desk log write failed:', r.status, await r.text());
}

// ── the watch ──────────────────────────────────────────────────────────────────────────────────
const events = await all('mdrx_funnel_events?select=provider_id,event,scroll,seconds,cta,created_at,suspected_bot&order=id.asc');
const people = await all(`${API}?select=*&lead_type=eq.funnel&order=id.asc`.replace(REST, ''));

const clean = {};
let botEvents = 0;
for (const e of events) {
  if (!e.provider_id) continue;
  if (e.suspected_bot) { botEvents++; continue; }
  (clean[e.provider_id] = clean[e.provider_id] || []).push(e);
}

const rows = [];
for (const p of people) {
  const ev = clean[p.id] || [];
  const clicks = ev.filter(e => e.event === 'click');
  const opens = ev.filter(e => e.event === 'open');
  const seconds = ev.reduce((s, e) => s + (Number(e.seconds) || 0), 0);
  const days = new Set(ev.map(e => String(e.created_at).slice(0, 10))).size;

  const roll = {
    funnel_clicked: clicks.length > 0,
    funnel_open_count: opens.length,
    funnel_max_scroll: Math.max(0, ...ev.map(e => Number(e.scroll) || 0)),
    funnel_total_seconds: seconds,
    funnel_last_cta: [...ev].reverse().find(e => e.cta)?.cta || null,
    funnel_booked: !!p.funnel_booked,
    funnel_last_seen_at: ev.length ? ev[ev.length - 1].created_at : null,
    funnel_first_open_at: opens.length ? opens[0].created_at : null,
  };
  roll.funnel_score = behaviorScore(roll);

  rows.push({
    p, roll, days, seconds,
    clicks: clicks.length,
    human: clicks.length > 0 && seconds >= HUMAN_SECONDS && days >= HUMAN_DAYS,
    was: Number(p.funnel_score) || 0,
  });
}

// Only leads still sitting in the drip get promoted, and never one Eric has parked. suppressed,
// on_hold and unsubscribed are his decisions and this job does not overrule them.
const moved = rows.filter(r => r.roll.funnel_score !== r.was);
const humans = rows.filter(r => r.human);
const promote = humans.filter(r =>
  IN_DRIP.includes(r.p.funnel_stage) && !r.p.suppressed && !r.p.on_hold && !r.p.unsubscribed_at && !r.p.bounced_at);

console.log(`Sentry, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
console.log(`  events read              ${events.length}  (${botEvents} were scanners, ignored)`);
console.log(`  leads on the book        ${people.length}`);
console.log(`  scores changing tonight  ${moved.length}`);
console.log(`  clear the human bar      ${humans.length}`);
console.log(`  promoting out of drip    ${promote.length}`);

if (promote.length) {
  console.log('\n  moving to Engaged:');
  for (const r of promote) {
    console.log(`    ${String(r.p.id).padStart(4)}  ` +
      `${((r.p.first_name || '') + ' ' + (r.p.last_name || '')).padEnd(24)}` +
      `${r.clicks} clean click${r.clicks === 1 ? '' : 's'}, ${r.seconds}s across ${r.days} days` +
      `   ${r.p.practice_name || ''}`);
  }
}

if (!WRITE) { console.log('\nNothing written. Add --write.'); process.exit(0); }

const now = new Date().toISOString();
let rescored = 0, promoted = 0, failed = 0;
for (const r of rows) {
  const body = { ...r.roll };
  const isPromo = promote.includes(r);
  if (isPromo) {
    const why = `${r.clicks} clean click${r.clicks === 1 ? '' : 's'}, ${r.seconds}s across ${r.days} days`;
    body.funnel_stage = 'Engaged';
    body.engaged_at = now;
    body.funnel_next_date = null;
    body.next_step = 'Chair to rule, human engagement confirmed';
    body.hot_touch = r.p.touch_count || 0;
    body.hot_since = now;
    body.hot_reason = why;
    note('promoted to Engaged', why, r.p.id, { seconds: r.seconds, days: r.days, clicks: r.clicks });
  }
  const res = await fetch(`${API}?id=eq.${r.p.id}`, { method: 'PATCH', headers: HW, body: JSON.stringify(body) });
  if (!res.ok) { console.error(`  FAILED ${r.p.id}: ${res.status}`); failed++; continue; }
  rescored++;
  if (isPromo) promoted++;
}

note('nightly watch', `${rescored} rescored, ${promoted} promoted, ${botEvents} scanner events ignored`, null,
  { rescored, promoted, humans: humans.length, botEvents, failed });
await flushLog();
console.log(`\nrescored ${rescored}, promoted ${promoted}${failed ? `, ${failed} failed` : ''}`);
