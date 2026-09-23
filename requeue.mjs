// requeue.mjs - the way OUT of 'held'.
//
// Why this exists. Nothing in this codebase, or in the deployed sender, ever sets an mdrx_outbox
// row back to 'pending'. The sender sets 'held' in exactly two places (send-outreach.ts: the
// !item.proofed door, and the outboundFaults copy gate) and 'skipped' in several more, and there
// the row stays for good. So when a hold was caused by a fault in OUR OWN code - the renderer
// stripping the opt-out, linkLabel having no name for to=pdrxone, the ReferenceError on `lead`
// that 500'd every send between 17 and 23 Sep 2026 - fixing the fault does not release the work.
// It sits there, and the next run reports {"sent":0,"failed":[]}, which reads exactly like
// "nothing was due". 38 rows are sitting in that state as this is written, 33 of them proofed:
// fully approved, fully gated, and unreachable, because redo-queue.mjs and stamp-proofed.mjs both
// filter status=eq.pending and so cannot see them.
//
// This script does one thing: it puts SYSTEM-held rows back in the queue. It never sends, it
// never edits a body, and it changes nothing at all unless --write is passed.
//
//   node requeue.mjs                 list every held row with its class and the reasoning (DRY RUN)
//   node requeue.mjs --write         requeue the class B rows
//   node requeue.mjs --ids=794,795   look at those rows only
//   node requeue.mjs --ids=794 --write
//
// THE CLASSIFICATION, and be honest about how much it can know.
//
// The row does not record WHY it was held. There is no failure_class column and no last_error
// column; the reason existed only as a string in the failed[] array of a run that finished days
// ago, and in the digest email that run sent. Verified against the live table: the columns are
// id, provider_id, touch_no, to_email, subject, body_html, body_text, status, scheduled_date,
// created_at, sent_at, content_id, plain_retry, objective, template_key, channel, send_after,
// contact_id, cc, proofed, proofed_at. Nothing there says why.
//
// So the class is INFERRED, from the one thing that can still be tested: re-run the copy gate on
// the stored body now.
//
//   A  BUSINESS / COMPLIANCE. The copy itself is still faulty, so whatever held it is a real
//      fault a human has to fix in the wording. Requeueing it would just hold it again.
//      Also every row with proofed=false, whatever its copy looks like: not proofed is not a
//      system fault, it is work that never cleared approval, and the sender's first door will
//      hold it again anyway.
//
//   B  SYSTEM / INFRASTRUCTURE. The row is proofed AND its stored copy passes the gate clean
//      today. The gate is deterministic: if this copy passes now and the row is nonetheless
//      held, then either the rule that held it has since been corrected (three were, on 17 and
//      23 Sep, all of them cases where the gate was refusing perfectly good copy), or the
//      renderer manufactured the fault out of good copy, or the run died before it got to the
//      wire. All three are our fault, none of them are his, and all three are fixed by letting
//      the row go round again - where the CURRENT gate will judge it afresh and hold it once
//      more if it really is bad. Requeueing is therefore not a bypass of the gate. It is a
//      second trip through it.
//
// This signal is good but not perfect, and the ways it is imperfect all point the same way, which
// is the way it should. The wire gate (outboundFaults, inside the Deno function) runs on the
// FINISHED email - signature appended, tokens expanded, text-to-HTML conversion done - and this
// script runs check.mjs's emailFaults on the stored body, because the renderers live in a Deno
// TypeScript file this repo cannot import and copying them here would put a third copy of rules
// that have already drifted twice into circulation. The two rule sets are siblings, not twins:
// emailFaults is the stricter of the two (it also catches repeated paragraphs, unfilled
// placeholders, lunch-and-learns, "undefined" printed into a body), so copy that passes here has
// cleared a higher bar than the wire will hold it to. What this cannot see is a fault that exists
// only in the rendering. Such a row comes back clean here, gets requeued, and is held again by the
// wire - no email goes out, nothing is damaged, and the hold is now a live signal on a fresh run
// instead of a fossil. That is the failure mode worth having.
//
// Everything that is not provably class B is class A. In doubt, leave it alone.
import { emailFaults } from './check.mjs';
import fs from 'node:fs';

// ---- connection -------------------------------------------------------------------------------
// The other scripts here are handed SUPABASE_URL / SUPABASE_SERVICE_KEY by the workflow. Run by
// hand on Eric's machine there is no workflow, so fall back to the file the key already lives in
// rather than making anyone paste one on a command line.
if (!process.env.SUPABASE_SERVICE_KEY) {
  const envFile = `${process.env.USERPROFILE || process.env.HOME}/.mdconcierge-assistant/supabase.env`;
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set, and no supabase.env to read them from. Refusing to run blind.');
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const rest = (p) => `${URL_}/rest/v1/${p}`;

// Loudly. The `r.ok ? r.json() : []` pattern turns an outage into an empty list, which reads as
// "nothing held" - the same silence this script exists to break. An unreachable database is an
// error, not a result.
async function sGet(path) {
  let r;
  try { r = await fetch(rest(path), { headers: H }); }
  catch (e) { throw new Error(`Supabase unreachable on GET ${path}: ${String(e)}`); }
  if (!r.ok) throw new Error(`Supabase GET ${path} failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function sPatch(path, body) {
  let r;
  try { r = await fetch(rest(path), { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error(`Supabase unreachable on PATCH ${path}: ${String(e)}`); }
  if (!r.ok) throw new Error(`Supabase PATCH ${path} failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ---- arguments --------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const idsArg = (argv.find((a) => a.startsWith('--ids=')) || '').slice('--ids='.length);
const ONLY = idsArg ? idsArg.split(',').map((s) => Number(s.trim())).filter(Number.isFinite) : null;
if (idsArg && !ONLY.length) throw new Error(`--ids=${idsArg} contains no usable row ids.`);

// ---- the rows ---------------------------------------------------------------------------------
const rows = await sGet('mdrx_outbox?select=id,provider_id,contact_id,to_email,subject,touch_no,template_key,objective,proofed,proofed_at,scheduled_date,send_after,created_at,body_text,body_html&status=eq.held&order=id');
const held = ONLY ? rows.filter((r) => ONLY.includes(r.id)) : rows;
if (ONLY) {
  const missing = ONLY.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) console.log(`note: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the held queue (already sent, skipped, or pending). Ignored.\n`);
}

console.log(`${rows.length} row${rows.length === 1 ? '' : 's'} held in mdrx_outbox`
  + (ONLY ? `, ${held.length} selected by --ids` : '')
  + `.  MODE: ${WRITE ? 'WRITE' : 'DRY RUN, nothing will change'}\n`);

// One lookup per provider, not per row: the same physician appears on several held rows.
const provIds = [...new Set(held.map((r) => r.provider_id).filter(Boolean))];
const provs = new Map();
if (provIds.length) {
  for (const p of await sGet(`mdrx_providers?select=id,first_name,last_name,credentials,funnel_stage,on_hold&id=in.(${provIds.join(',')})`)) provs.set(p.id, p);
}
// Has he ever written back. Same question the sender asks, asked of the messages rather than of
// engaged_at, because the stage-dependent rules in the gate turn on it and getting it wrong here
// would make the classifier stricter or looser than the wire.
const replied = new Set();
if (provIds.length) {
  for (const m of await sGet(`mdrx_messages?select=provider_id&direction=eq.in&provider_id=in.(${provIds.join(',')})&limit=5000`)) replied.add(m.provider_id);
}

// ---- classify ---------------------------------------------------------------------------------
const PERSONAL_KEYS = ['personal', 'next_move', 'reply', 'assistant'];
const NON_PHYSICIAN = /administrator|manager|coordinator|director|staff|office/i;

function classify(r) {
  // Rule 4, absolute and checked before anything else: a row that never cleared approval is not
  // this script's business. Not proofed is not an outage.
  if (!r.proofed) return { cls: 'A', why: 'proofed=false. Never approved, so the hold is not a system fault and the sender would hold it again at the first door.' };

  const p = provs.get(r.provider_id) || {};
  // The sender's own test, copied in intent: anything that did not come out of the cadence queue,
  // plus the one to one template keys, is a personal letter and must NOT carry an opt-out. Getting
  // this backwards is the difference between "no opt-out in the plain text" and "opt-out line on a
  // personal email", and either one would be a fabricated fault.
  const fromQueue = Number(r.touch_no || 0) > 0;
  const personal = !fromQueue || PERSONAL_KEYS.includes(String(r.template_key || ''));
  const addressAs = NON_PHYSICIAN.test(String(p.credentials || '')) ? String(p.first_name || '') : '';

  let faults = emailFaults({
    html: r.body_html || '',
    text: r.body_text || '',
    lastName: String(p.last_name || ''),
    addressAs,
    campaign: !personal,
    stage: String(p.funnel_stage || ''),
    neverReplied: !replied.has(r.provider_id),
  }).map(String);

  // A contact-addressed row has no provider record, so there is no surname to check a greeting
  // against. The wire stands its greeting rules down for those; standing them up here would
  // classify every contact row A for a fault the sender never raised.
  if (!r.provider_id) faults = faults.filter((f) => !/greeting|no surname on the record/i.test(f));

  // A hold that is neither the copy's fault nor safely requeueable, and it has to be named rather
  // than lumped in with "fix the wording", because the wording is fine.
  //
  // The gate's opt-out pattern knows the literal strings "not interested" and "reply stop". The ten
  // "79 percent" drip rows say `If you don't treat work comp or aren't interested, reply "stop" and
  // I won't contact you again.` - a perfectly good opt-out that matches NEITHER: "aren't interested"
  // is not "not interested", and `reply "stop"` has a quotation mark between the two words. So the
  // gate reports an email with no opt-out while it is looking straight at one, and holds it.
  //
  // This is the same defect that was found and fixed on 17 Sep 2026, when Eric reworded the line to
  // "you're not interested" and the then-pattern wanted the literal "are not interested". It was
  // widened once; it was not widened enough.
  //
  // These rows are left where they are ON PURPOSE. The pattern lives in check.mjs and, separately,
  // in the deployed send-outreach.ts, and until BOTH are widened the wire will hold these again the
  // moment they are requeued. Requeueing them now would move 10 rows and change nothing. Flagged,
  // not touched, and not blamed on the copy.
  const OPTOUT_NEAR_MISS = /aren.t interested|not interested|reply\s*["“']?\s*stop|won.t contact you again|no longer like to hear|don.t wish to hear/i;
  if (faults.length === 1 && /no opt-out in the plain text|no opt-out in the designed email/i.test(faults[0])
      && OPTOUT_NEAR_MISS.test(String(r.body_text || '') + ' ' + String(r.body_html || ''))) {
    return { cls: 'A', why: 'GATE DEFECT, NOT WORDING. This email carries a working opt-out, and the gate cannot see it: its pattern knows the literal "not interested" and "reply stop", and this copy says "aren\'t interested" and reply "stop" in quotation marks. The fix is the opt-out pattern in check.mjs AND in the deployed send-outreach.ts, not the email. Left held, because requeueing before that fix would simply hold it again.' };
  }
  if (faults.length) return { cls: 'A', why: `the copy still fails the gate: ${faults.join(' | ')}` };
  return { cls: 'B', why: 'proofed, and the stored copy passes the gate clean today, so nothing about the WORDING is holding it. Whatever held it was ours.' };
}

const results = held.map((r) => ({ r, ...classify(r) }));

// ---- the list ---------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
for (const { r, cls, why } of results) {
  console.log(`#${pad(r.id, 5)} ${cls}  ${pad(r.to_email, 38)} touch ${pad(r.touch_no ?? '-', 3)} proofed=${pad(r.proofed, 6)} sched ${pad(r.scheduled_date || '-', 11)}`);
  console.log(`        ${r.subject || '(no subject)'}`);
  console.log(`        ${cls === 'B' ? 'REQUEUE' : 'LEAVE ALONE'}: ${why}`);
  if (r.send_after) console.log(`        send_after ${r.send_after} would be cleared so it gets a fresh in-window slot rather than going out in a stale clump.`);
  console.log('');
}

const A = results.filter((x) => x.cls === 'A');
const B = results.filter((x) => x.cls === 'B');
const notProofed = A.filter((x) => !x.r.proofed);
// Held by a fault in the gate rather than in the email. Counted apart because sending anyone to
// "fix the wording" on these would waste their time: the wording is already right.
const gateDefect = A.filter((x) => x.why.startsWith('GATE DEFECT'));
const badCopy = A.filter((x) => x.r.proofed && !x.why.startsWith('GATE DEFECT'));

// ---- act --------------------------------------------------------------------------------------
let requeued = 0;
if (WRITE && B.length) {
  for (const { r } of B) {
    // Scoped on status=eq.held as well as the id, so a row someone released or sent between the
    // read above and this write is not dragged back out of whatever state it reached.
    const out = await sPatch(`mdrx_outbox?id=eq.${r.id}&status=eq.held`, { status: 'pending', send_after: null });
    if (!out.length) { console.log(`#${r.id}: no longer held, left as it is.`); continue; }
    requeued++;
    console.log(`#${r.id} ${r.to_email}: requeued, status=pending, send_after cleared.`);
  }
  console.log('');
}

// ---- summary ----------------------------------------------------------------------------------
console.log('-'.repeat(78));
console.log(`held rows examined:            ${results.length}`);
console.log(`class A, left alone:           ${A.length}`);
console.log(`    never proofed:             ${notProofed.length}   (never cleared approval; not a system fault)`);
console.log(`    wording needs Eric:        ${badCopy.length}`);
console.log(`    gate defect, copy is fine: ${gateDefect.length}   (the opt-out pattern cannot see the opt-out these carry)`);
console.log(`class B, system-held:          ${B.length}`);
if (WRITE) console.log(`class B actually requeued:     ${requeued}`);
else if (B.length) console.log(`\nDRY RUN. Nothing was changed. Re-run with --write to requeue those ${B.length}.`);
else console.log('\nDRY RUN. Nothing was changed, and nothing here is safely requeueable anyway.');
if (badCopy.length) console.log(`\n${badCopy.length} row${badCopy.length === 1 ? '' : 's'} will never send until the WORDING is fixed. Requeueing them would only hold them again.`);
if (gateDefect.length) {
  console.log(`\n${gateDefect.length} row${gateDefect.length === 1 ? '' : 's'} are held by the GATE, not by the copy: they carry an opt-out the pattern does not recognise`);
  console.log('("aren\'t interested", reply "stop" in quotation marks). Widen the opt-out pattern in check.mjs AND in the');
  console.log('deployed send-outreach.ts, then run this again and they become class B. Nothing here can fix them, and');
  console.log('requeueing them first would only hold them a second time.');
}
