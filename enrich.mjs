// enrich.mjs — always-on data-enrichment agent.
// Sweeps the CRM for contacts missing an NPI (and, when found, fills phone/address/
// specialty/credential too), looks each one up in the free NPPES NPI registry,
// and QUEUES a confirmation for Eric in enrichment_suggestions. It writes NOTHING
// to a contact directly — Eric confirms each match in the dashboard (human-in-the-loop).
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

function normPhone(s) { return (s || '').replace(/[^\d]/g, ''); }
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] != null) r[k] = o[k]; return r; }

// Query NPPES for a person; return normalized candidates.
async function npiLookup({ first_name, last_name, state, city }) {
  const params = new URLSearchParams({ version: '2.1', last_name, limit: '30' });
  if (first_name) params.set('first_name', first_name.split(' ')[0]);
  const r = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map((m) => {
    const b = m.basic || {};
    const tax = (m.taxonomies || []).find((t) => t.primary) || (m.taxonomies || [])[0] || {};
    const loc = (m.addresses || []).find((a) => a.address_purpose === 'LOCATION') || (m.addresses || [])[0] || {};
    return {
      npi: String(m.number), credentials: (b.credential || '').replace(/\./g, ''),
      first_name: b.first_name, last_name: b.last_name,
      specialty: tax.desc || null,
      address: [loc.address_1, loc.address_2].filter(Boolean).join(' '),
      city: loc.city || null, state: loc.state || null, zip: (loc.postal_code || '').slice(0, 5) || null,
      office_phone: loc.telephone_number || null,
    };
  });
}

// Score a candidate against the CRM record. Returns 'high' | 'medium' | 'low'.
function score(cand, prov) {
  let s = 0;
  if (prov.state && cand.state) s += (prov.state.toUpperCase() === cand.state.toUpperCase()) ? 2 : -1;
  if (prov.city && cand.city) s += (prov.city.toLowerCase() === cand.city.toLowerCase()) ? 2 : 0;
  if (prov.first_name && cand.first_name && prov.first_name.toLowerCase().startsWith(cand.first_name.toLowerCase().slice(0, 3))) s += 1;
  if (prov.specialty && cand.specialty && cand.specialty.toLowerCase().includes((prov.specialty || '').toLowerCase().split(' ')[0])) s += 1;
  return s >= 3 ? 'high' : s >= 1 ? 'medium' : 'low';
}

async function main() {
  // Thin = has a usable name but no NPI. Need at least a last name to search.
  const thin = await sGet(`mdrx_providers?select=id,first_name,last_name,specialty,city,state,practice_name,npi,suppressed&or=(npi.is.null,npi.eq.)&last_name=not.is.null&suppressed=not.eq.true&limit=400`);
  const open = await sGet('enrichment_suggestions?select=provider_id&status=eq.pending');
  const pending = new Set((open || []).map((x) => x.provider_id));

  let checked = 0, queued = 0;
  for (const p of thin) {
    if (queued >= PER_RUN) break;
    if (pending.has(p.id)) continue;
    if (!p.last_name || (!p.state && !p.city && !p.practice_name)) continue; // nothing to disambiguate on
    checked++;
    let cands = [];
    try { cands = await npiLookup(p); } catch (e) { continue; }
    if (!cands.length) continue;
    const ranked = cands.map((c) => ({ c, conf: score(c, p) })).sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.conf] - { high: 3, medium: 2, low: 1 }[a.conf]));
    const best = ranked[0];
    if (best.conf === 'low' && ranked.length > 3) continue; // too ambiguous, skip rather than spam Eric
    const c = best.c;
    const summary = `Found NPI ${c.npi} — ${c.first_name || ''} ${c.last_name || ''} ${c.credentials || ''}, ${c.specialty || 'specialty n/a'}, ${[c.city, c.state].filter(Boolean).join(', ')}${c.office_phone ? ' · ' + c.office_phone : ''}. ` +
      (best.conf === 'high' ? 'Location and details line up.' : 'Location does not fully match the record — please verify this is the right person.');
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
