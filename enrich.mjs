// enrich.mjs — always-on data-enrichment agent.
// Sweeps the CRM for contacts missing an NPI, looks each up in the free NPPES NPI
// registry, and QUEUES a confirmation for Eric in enrichment_suggestions. Writes
// NOTHING to a contact directly — Eric confirms each match (human-in-the-loop).
//
// Matching strategy: search by LAST NAME + STATE (not first name), because doctors
// often register their NPI under a legal name that differs from the professional
// name they use. Rank candidates by specialty + city + first-name similarity.
// Never re-suggest an NPI Eric already rejected for that contact.
// Runs on a schedule via GitHub Actions. No API key needed (NPPES is free/public).
import nodemailer from 'nodemailer';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const PER_RUN = Number(process.env.ENRICH_PER_RUN || 15);

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };

import { deriveState, pick, npiLookup, score } from './npi.mjs';

async function main() {
  const thin = await sGet(`mdrx_providers?select=id,first_name,last_name,specialty,city,state,region,practice_name,npi,suppressed&or=(npi.is.null,npi.eq.)&last_name=not.is.null&suppressed=not.eq.true&limit=400`);
  const open = await sGet('enrichment_suggestions?select=provider_id&status=eq.pending');
  const pending = new Set((open || []).map((x) => x.provider_id));
  const rejected = await sGet('enrichment_suggestions?select=provider_id,found&status=eq.rejected');
  const rejSet = new Set((rejected || []).map((x) => `${x.provider_id}:${x.found && x.found.npi}`)); // never re-suggest a rejected match

  let checked = 0, queued = 0;
  for (const p of thin) {
    if (queued >= PER_RUN) break;
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
    if (best.conf === 'low') continue; // with state + specialty ranking, a 'low' best means no real match; don't spam Eric
    const c = best.c;
    // Same last name in the same state is NOT enough (lots of Smiths in PA). Require the
    // specialty OR the city to actually match, or we surface a same-name stranger. Leads
    // that fail this need web-search enrichment, not the registry.
    const specW = (p.specialty || '').toLowerCase().split(' ')[0];
    const specOK = specW && c.specialty && c.specialty.toLowerCase().includes(specW);
    const cityOK = p.city && c.city && p.city.toLowerCase() === c.city.toLowerCase();
    if (!specOK && !cityOK) continue;
    const nameNote = (p.first_name && c.first_name && p.first_name.toLowerCase().slice(0, 3) !== c.first_name.toLowerCase().slice(0, 3))
      ? ` Registered as "${c.first_name} ${c.last_name}" (differs from the name on file).` : '';
    const summary = `Found NPI ${c.npi} — ${c.first_name || ''} ${c.last_name || ''} ${c.credentials || ''}, ${c.specialty || 'specialty n/a'}, ${[c.city, c.state].filter(Boolean).join(', ')}${c.office_phone ? ' · ' + c.office_phone : ''}.` +
      nameNote + (best.conf === 'high' ? ' State and specialty line up.' : ' Please verify this is the right person.');
    const found = { ...pick(c, ['npi', 'credentials', 'specialty', 'address', 'city', 'state', 'zip', 'office_phone']), alternates: ranked.slice(1, 4).map((r) => r.c) };
    await sPost('enrichment_suggestions', { provider_id: p.id, found, summary, confidence: best.conf, source: 'npi_registry', status: 'pending' });
    queued++;
  }
  console.log(`enrich: checked ${checked}, queued ${queued} suggestion(s) for confirmation.`);
}

main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/timeout|econnreset|econnrefused|enotfound|socket|network|fetch failed/i.test(msg)) { console.warn('transient, skipping run: ' + msg); process.exit(0); }
  console.error('enrich fatal: ' + (e?.stack || e));
  try {
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: '[MDconcierge] enrich agent error', text: msg });
  } catch (_e) {}
  process.exit(0);
});
