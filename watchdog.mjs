// Independent watchdog / dead-man's switch.
// Runs as its OWN workflow (separate from the engine) so an engine crash can't silence it.
// Reads the engine's heartbeat (system_health.last_run_at). If it's stale, emails Eric ONCE
// per outage, and emails again when the engine recovers. State is tracked in audit_log (no new columns).
import nodemailer from 'nodemailer';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ZOHO_USER, ZOHO_APP_PASSWORD } = process.env;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'eric@mdconcierge.net';
const STALE_MIN = Number(process.env.STALE_MIN || 20);   // loop heartbeats every ~90s; 20 min = clearly down
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const get = async p => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`GET ${p} → ${r.status} ${await r.text()}`); return r.json(); };
const post = async (t, b) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`POST ${t} → ${r.status} ${await r.text()}`); };

async function lastId(action) { try { return ((await get(`audit_log?select=id&action=eq.${action}&order=id.desc&limit=1`))[0] || {}).id || 0; } catch (e) { return 0; } }
async function email(subject, body) {
  if (!ZOHO_USER || !ZOHO_APP_PASSWORD) { console.log('(no Zoho creds — would have emailed: ' + subject + ')'); return; }
  const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ZOHO_USER, pass: ZOHO_APP_PASSWORD } });
  await t.sendMail({ from: `MDconcierge Watchdog <${ZOHO_USER}>`, to: ADMIN_EMAIL, subject, text: body });
}

const row = (await get('system_health?select=*&id=eq.1'))[0];
const last = row && row.last_run_at ? new Date(row.last_run_at) : null;
const ageMin = last ? (Date.now() - last.getTime()) / 60000 : Infinity;
console.log(`Heartbeat: ${last ? last.toISOString() + ' (' + ageMin.toFixed(1) + ' min ago)' : 'NONE on record'}; threshold ${STALE_MIN} min.`);

const downId = await lastId('watchdog_down_alert');
const recId = await lastId('watchdog_recovered');
const alreadyAlerted = downId && downId > recId;   // we're in a known-down state we already reported

if (ageMin > STALE_MIN) {
  if (alreadyAlerted) { console.log('Still down — already alerted this outage. Staying quiet.'); }
  else {
    const ageTxt = ageMin === Infinity ? 'an unknown period (no heartbeat on record)' : `${ageMin.toFixed(0)} minutes`;
    await email('🚨 MDconcierge engine may be DOWN — no heartbeat',
      `ALERT from the independent watchdog.\n\nYour coordination engine has not checked in for ${ageTxt} (last heartbeat: ${last ? last.toUTCString() : 'none'}).\n\nNew referrals may NOT be processing right now. Check the "Referral intake" workflow:\nhttps://github.com/eweiscarger/mdconcierge-intake/actions\n\nYou'll get ONE alert per outage, plus a note when it recovers.`);
    await post('audit_log', { case_id: null, action: 'watchdog_down_alert', detail: `age ${ageMin === Infinity ? 'inf' : ageMin.toFixed(0)}min`, source: 'watchdog' });
    console.log('ALERT SENT.');
  }
} else {
  if (alreadyAlerted) {
    await email('✓ MDconcierge engine RECOVERED', `Good news — the coordination engine is checking in again (heartbeat ${ageMin.toFixed(1)} min ago). The earlier outage is over. No action needed.`);
    await post('audit_log', { case_id: null, action: 'watchdog_recovered', detail: `age ${ageMin.toFixed(0)}min`, source: 'watchdog' });
    console.log('RECOVERY noted + emailed.');
  } else { console.log('Engine healthy.'); }
}
