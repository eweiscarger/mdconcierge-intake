// npi.mjs — shared NPPES registry lookup. Used by enrich.mjs (fill in thin leads) and
// bounce-scan.mjs (find where a doctor went after their address bounced).
// NPPES is free and public: npiregistry.cms.hhs.gov. No key, no credits.

export const REGION_PA = /\bpa\b|philad|pennsylvania|lancaster|allentown|harrisburg|pittsburgh|western pa|lehigh|reading|scranton|wynnewood|malvern/i;

export function deriveState(p) {
  if (p.state) return String(p.state).toUpperCase();
  if (REGION_PA.test(p.region || p.city || '')) return 'PA';
  return null;
}

export function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] != null) r[k] = o[k]; return r; }

// Search NPPES by last name, constrained by state when we can infer it.
export async function npiLookup({ last_name, first_name, state }) {
  const params = new URLSearchParams({ version: '2.1', last_name, limit: '50' });
  if (state) params.set('state', state);                 // catches legal-name variants (pro name != registered name)
  else if (first_name) params.set('first_name', first_name.split(' ')[0]);
  const r = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map((m) => {
    const b = m.basic || {};
    const tax = (m.taxonomies || []).find((t) => t.primary) || (m.taxonomies || [])[0] || {};
    const loc = (m.addresses || []).find((a) => a.address_purpose === 'LOCATION') || (m.addresses || [])[0] || {};
    return {
      npi: String(m.number), credentials: (b.credential || '').replace(/\./g, ''),
      first_name: b.first_name, last_name: b.last_name, specialty: tax.desc || null,
      address: [loc.address_1, loc.address_2].filter(Boolean).join(' '),
      city: loc.city || null, state: loc.state || null, zip: (loc.postal_code || '').slice(0, 5) || null,
      office_phone: loc.telephone_number || null,
    };
  });
}

// Score a candidate. Specialty is the strongest signal when the name is registered differently.
export function score(cand, prov, stateUsed) {
  let s = 0;
  const cs = stateUsed || prov.state;
  if (cs && cand.state) s += (String(cs).toUpperCase() === String(cand.state).toUpperCase()) ? 2 : -2;
  if (prov.city && cand.city && prov.city.toLowerCase() === cand.city.toLowerCase()) s += 2;
  const w = (prov.specialty || '').toLowerCase().split(' ')[0];
  if (w && cand.specialty && cand.specialty.toLowerCase().includes(w)) s += 2;
  if (prov.first_name && cand.first_name && prov.first_name.toLowerCase().slice(0, 3) === cand.first_name.toLowerCase().slice(0, 3)) s += 1;
  return s >= 3 ? 'high' : s >= 1 ? 'medium' : 'low';
}

// Did they move? Compare a registry hit against what we have on file.
// Returns null when the registry tells us nothing new.
export function relocationDelta(cand, prov) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const changes = [];
  if (cand.city && norm(cand.city) !== norm(prov.city)) changes.push(`city ${prov.city || 'unknown'} to ${cand.city}`);
  if (cand.address && norm(cand.address) !== norm(prov.address)) changes.push('a different practice address on file');
  if (cand.office_phone && norm(cand.office_phone) !== norm(prov.office_phone)) changes.push('a different office phone');
  if (!changes.length) return null;
  return changes;
}
