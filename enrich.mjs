// enrich.mjs — always-on data-enrichment agent.
// Sweeps the CRM for contacts missing an NPI, looks each up in the free NPPES NPI
// registry, and fills in a clear match on its own. Eric, 15 Sep 2026: the confirmation
// queue grew to 41 matches nobody clicked, so a match that is certain is applied and one
// that is not is dropped. Only empty fields are filled, and every write is logged in
// enrichment_suggestions as auto_applied so it can be traced or undone.
//
// Matching strategy: search by LAST NAME + STATE (not first name), because doctors
// often register their NPI under a legal name that differs from the professional
// name they use. Rank candidates by specialty + city + first-name similarity.
// Never re-suggest an NPI Eric already rejected for that contact.
// Runs on a schedule via GitHub Actions. No API key needed (NPPES is free/public).
// Outbound goes through the shared capped transport - see mailer.mjs for why.
import { transporter } from './mailer.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const PER_RUN = Number(process.env.ENRICH_PER_RUN || 15);

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`supabase GET ${p} -> ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300)); return r.json(); };
const sPost = async (t, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, patch) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) }); if (!r.ok) throw new Error(`patch ${p} ${r.status}: ${await r.text()}`); };
const FIELDS = ['npi', 'credentials', 'specialty', 'address', 'city', 'state', 'zip', 'office_phone'];

import { deriveState, pick, npiLookup, score } from './npi.mjs';

async function main() {
  const thin = await sGet(`mdrx_providers?select=id,first_name,last_name,specialty,city,state,region,practice_name,npi,credentials,address,zip,office_phone,suppressed&or=(npi.is.null,npi.eq.)&last_name=not.is.null&suppressed=not.eq.true&limit=400`);
  const open = await sGet('enrichment_suggestions?select=provider_id&status=eq.pending');
  const pending = new Set((open || []).map((x) => x.provider_id));
  const rejected = await sGet('enrichment_suggestions?select=provider_id,found&status=eq.rejected');
  const rejSet = new Set((rejected || []).map((x) => `${x.provider_id}:${x.found && x.found.npi}`)); // never re-suggest a rejected match

  let checked = 0, applied = 0;
  for (const p of thin) {
    if (applied >= PER_RUN) break;
    if (pending.has(p.id)) continue;
    const st = deriveState(p);
    if (!st && !p.first_name) continue; // need at least a state to search on, or a first name to narrow
    checked++;
    let cands = [];
    try { cands = await npiLookup({ last_name: p.last_name, first_name: p.first_name, state: st }); } catch (e) { continue; }
    cands = cands.filter((c) => !rejSet.has(`${p.id}:${c.npi}`));
    if (!cands.length) continue;
    const ranked = cands.map((c) => ({ c, conf: score(c, p, st) })).sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.conf] - { high: 3, medium: 2, low: 1 }[a.conf]));
    const best = ranked[0];
    // Nobody reviews a maybe any more, so only a clear match is written. Anything less needs
    // web-search enrichment, not a guess on the record.
    if (best.conf !== 'high') continue;
    const c = best.c;
    // Same last name in the same state is NOT enough (lots of Smiths in PA). Require the
    // specialty OR the city to actually match, or we surface a same-name stranger. Leads
    // that fail this need web-search enrichment, not the registry.
    const specW = (p.specialty || '').toLowerCase().split(' ')[0];
    const specOK = specW && c.specialty && c.specialty.toLowerCase().includes(specW);
    const cityOK = p.city && c.city && p.city.toLowerCase() === c.city.toLowerCase();
    if (!specOK && !cityOK) continue;
    // A different first name is sometimes the doctor's legal name and sometimes a different
    // doctor. A stranger's NPI on the record is worse than no NPI, so these are left alone.
    if (p.first_name && c.first_name && p.first_name.toLowerCase().slice(0, 3) !== c.first_name.toLowerCase().slice(0, 3)) continue;
    const found = { ...pick(c, FIELDS), alternates: ranked.slice(1, 4).map((r) => r.c) };
    const patch = {};
    for (const k of FIELDS) if (found[k] && !String(p[k] ?? '').trim()) patch[k] = found[k];
    if (!patch.npi) continue;
    await sPatch(`mdrx_providers?id=eq.${p.id}`, patch);
    const summary = `Filled in NPI ${c.npi}: ${c.first_name || ''} ${c.last_name || ''} ${c.credentials || ''}, ${c.specialty || 'specialty n/a'}, ${[c.city, c.state].filter(Boolean).join(', ')}. Fields written: ${Object.keys(patch).join(', ')}.`;
    await sPost('enrichment_suggestions', { provider_id: p.id, found, summary, confidence: best.conf, source: 'npi_registry', status: 'auto_applied', resolved_at: new Date().toISOString() });
    applied++;
  }
  console.log(`enrich: checked ${checked}, filled in ${applied} record(s).`);
}

main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/timeout|econnreset|econnrefused|enotfound|socket|network|fetch failed/i.test(msg)) { console.warn('transient, skipping run: ' + msg); process.exit(0); }
  console.error('enrich fatal: ' + (e?.stack || e));
  try {
    const t = transporter;   // shared capped transport
    await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: '[MDconcierge] enrich agent error', text: msg });
  } catch (_e) {}
  process.exit(0);
});
