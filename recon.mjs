// RECON — the researcher.
//
// Duty: study the physician before anybody writes to them. Who they actually are, what they treat,
// where they trained, what their practice is, whether injured workers walk through their door, and
// the one true specific thing that makes an email unmistakably about that person.
//
// This is the job Eric was doing by hand and is done doing by hand. A hundred and four of the
// physicians on this book show no signal at all after being emailed. That is a reach problem, not
// a copy problem, and you do not solve a reach problem by sending the same note again. You solve it
// by knowing something about the person.
//
// HARD RULES, all of them Eric's and none of them negotiable:
//   * Never invent. Every fact in a dossier carries the URL it came from. No source, no fact.
//     A blank field is correct and useful. A guess is a liability that ends up in an email.
//   * The opener Recon writes is RAW MATERIAL, not approved copy. Nothing Recon produces goes into
//     a live template, a page or a send until Eric has approved that exact wording.
//   * Never tell a physician what to prescribe. Recon reports and observes; it does not advise
//     clinically, and it never writes a line that instructs a doctor on care.
//   * Never write anything that reveals opens, clicks or reading are tracked.
//   * Eric is a consultant, not a rep. The dossier exists so he arrives informed, not so he can
//     flatter somebody.
//
// Recon writes to mdrx_providers.dossier and never sends, drafts or moves a lead.
import Anthropic from '@anthropic-ai/sdk';
import { doctrine } from './doctrine.mjs';

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error(`recon: missing ${k}`); process.exit(1); }
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY };
const HW = { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const REST = SUPABASE_URL + '/rest/v1/';

const AGENT = 'Recon';
const WRITE = process.argv.includes('--write') || process.env.RECON_WRITE === '1';
const LIMIT = Number(process.env.RECON_LIMIT || process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 6);
const ONLY = process.argv.find(a => a.startsWith('--id='))?.split('=')[1];
// A dossier goes stale. Ninety days is long enough that nothing is re-researched for no reason and
// short enough that a physician who changed practices does not stay wrong on the record forever.
const STALE_DAYS = 90;

// Recon's brief describes what Eric sells and how he positions himself, which is playbook, not
// code. It lives in the private mdrx_doctrine table. See doctrine.mjs for why.
const SYSTEM = await doctrine('recon.system');

async function sb(path, init) {
  const r = await fetch(REST + path, { headers: H, ...init });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return init && init.method && init.method !== 'GET' ? null : r.json();
}

const logs = [];
async function flushLog() {
  if (!logs.length || !WRITE) return;
  const r = await fetch(REST + 'mdrx_desk_log', { method: 'POST', headers: HW, body: JSON.stringify(logs) });
  if (!r.ok) console.error('desk log write failed:', r.status, await r.text());
}

async function study(p) {
  const known = [
    `Name: ${[p.first_name, p.last_name].filter(Boolean).join(' ')}${p.credentials ? ', ' + p.credentials : ''}`,
    p.specialty && `Specialty on file: ${p.specialty}`,
    p.practice_name && `Practice on file: ${p.practice_name}`,
    [p.city, p.state].filter(Boolean).length && `Location on file: ${[p.city, p.state].filter(Boolean).join(', ')}`,
    p.npi && `NPI on file: ${p.npi}`,
    p.profile_url && `A page we already have: ${p.profile_url}`,
    p.relationship && `WHAT ERIC ALREADY KNOWS, which outranks anything you find: ${p.relationship}`,
  ].filter(Boolean).join('\n');

  const m = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    system: SYSTEM,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    messages: [{ role: 'user', content: `Study this physician and return the dossier JSON.\n\n${known}` }],
  });

  const raw = (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no json in output: ' + raw.slice(0, 200));
  return JSON.parse(raw.slice(s, e + 1));
}

// ── the round ──────────────────────────────────────────────────────────────────────────────────
const cutoff = new Date(Date.now() - STALE_DAYS * 864e5).toISOString();

// Who gets studied first. Engaged and Hot before the drip, because those are the people Eric is
// about to write to. Inside that, highest score first.
const q = ONLY
  ? `mdrx_providers?select=*&id=eq.${ONLY}`
  : `mdrx_providers?select=*&lead_type=eq.funnel&suppressed=is.false&on_hold=is.false` +
    `&unsubscribed_at=is.null&bounced_at=is.null` +
    `&or=(dossier_at.is.null,dossier_at.lt.${cutoff})` +
    `&funnel_stage=in.(Engaged,Hot,Closing)` +
    `&order=funnel_score.desc&limit=${LIMIT}`;

let queue = await sb(q);

// Nobody engaged left to study: fall back to the drip, so Recon is never idle. These are the 104
// who have shown nothing at all, and knowing something about them is the only way that changes.
if (!ONLY && !queue.length) {
  queue = await sb(`mdrx_providers?select=*&lead_type=eq.funnel&suppressed=is.false&on_hold=is.false` +
    `&unsubscribed_at=is.null&bounced_at=is.null` +
    `&or=(dossier_at.is.null,dossier_at.lt.${cutoff})` +
    `&order=funnel_score.desc,id.asc&limit=${LIMIT}`);
}

console.log(`Recon, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
console.log(`  ${queue.length} physician${queue.length === 1 ? '' : 's'} to study this round\n`);

let done = 0, blank = 0;
for (const p of queue) {
  const who = `${String(p.id).padStart(4)}  ${[p.first_name, p.last_name].filter(Boolean).join(' ')}`;
  let d;
  try { d = await study(p); }
  catch (err) { console.error(`${who}  FAILED: ${err.message}`); continue; }

  const val = f => (d[f] && typeof d[f] === 'object' ? d[f].value : d[f]) || null;
  console.log(`${who}  ${d.found ? d.confidence : 'not found'}`);
  if (d.found) {
    if (val('specialty')) console.log(`        treats:    ${val('specialty')}`);
    if (val('leadership')) console.log(`        leads:     ${val('leadership')}`);
    if (val('work_comp')) console.log(`        work comp: ${val('work_comp')}`);
    if (d.the_one_thing) console.log(`        the one thing: ${d.the_one_thing}`);
  }
  if ((d.unresolved || []).length) console.log(`        unresolved: ${d.unresolved.join('; ')}`);
  if (!d.found) blank++;

  if (!WRITE) continue;

  // What Eric knows OUTRANKS the internet and Recon must never step on it. Teichman is the case
  // that proved it: the web says nothing about work comp at PA Foot and Ankle, and Recon honestly
  // recorded that it could not tell. Eric knew the man from Alikai, knew he sees work comp, and
  // knew they had run DME together. None of that is findable. A wholesale overwrite of the dossier
  // column would have erased it on the next run.
  //
  // So: anything under eric_knows is carried forward untouched, and any field Eric has already
  // sourced (source is "Eric") survives whatever Recon found this time.
  const prev = p.dossier || {};
  if (prev.eric_knows) d.eric_knows = prev.eric_knows;
  for (const [k, v] of Object.entries(prev)) {
    if (v && typeof v === 'object' && v.source === 'Eric') d[k] = v;
  }
  const patch = { dossier: d, dossier_at: new Date().toISOString(), dossier_by: prev.eric_knows ? AGENT + ' + Eric' : AGENT };
  // Only fill a column we do not already have. Recon adds to the record, it does not overwrite
  // what Eric or the NPI load put there.
  if (!p.profile_url && d.profile_url) patch.profile_url = d.profile_url;
  if (!p.specialty && val('specialty')) patch.specialty = val('specialty');

  const r = await fetch(`${REST}mdrx_providers?id=eq.${p.id}`, { method: 'PATCH', headers: HW, body: JSON.stringify(patch) });
  if (!r.ok) { console.error(`        write failed: ${r.status}`); continue; }
  done++;
  logs.push({
    agent: AGENT, provider_id: p.id,
    action: d.found ? 'dossier written' : 'could not find them',
    detail: d.the_one_thing || (d.unresolved || []).join('; ') || null,
    meta: { confidence: d.confidence, linkedin: d.linkedin || null },
  });
}

if (WRITE) {
  logs.push({ agent: AGENT, action: 'research round', detail: `${done} studied, ${blank} not found`, meta: { studied: done, blank } });
  await flushLog();
}
console.log(`\n${WRITE ? `wrote ${done} dossier${done === 1 ? '' : 's'}` : 'Nothing written. Add --write.'}`);
