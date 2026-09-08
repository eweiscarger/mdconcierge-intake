// pdrx-intake-watch.mjs — a completed PDRx account intake has to reach Eric, in a shape he can
// forward to the pharmacy without retyping it.
//
// The form (pdrx-intake.html) writes a row through the submit_signup RPC. Nothing then told
// anybody. A physician could complete every field, get a thank-you screen, and the form sat in a
// table nobody was watching. This is the missing half.
//
// It emails Eric one message per intake, formatted as the pharmacy needs to read it, and stamps
// flagged_reason so the same intake is never sent twice. The row stays 'pending' so it still
// appears for review in the dashboard.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, MDRX_ERIC_PASS (or ERIC_APP_PASSWORD).

import nodemailer from 'nodemailer';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY }))
  if (!v) { console.error('Missing env: ' + k); process.exit(1); }
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPatch = async (p, b) => fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(b) });

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const val = (s) => (s == null || s === '') ? '<span style="color:#b0453a;">not given</span>' : esc(s);

function card(p) {
  const row = (k, v) => `<tr><td style="padding:5px 14px 5px 0;color:#5c6b85;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:5px 0;color:#14213d;font-weight:600;">${v}</td></tr>`;
  const pr = p.practice || {}, pay = p.payment || {}, sub = p.submitter || {};
  const locs = (p.locations || []).map((l, i) =>
    row('Location ' + (i + 1), `${val(l.address)}<br><span style="font-weight:400;color:#5c6b85;">phone ${val(l.phone)} &nbsp; fax ${val(l.fax)}</span>`)).join('');
  // Licence and DEA are what the pharmacy has to check, so a blank one is called out in red
  // rather than left as an empty cell somebody has to notice.
  const provs = (p.providers || []).map((v, i) =>
    row('Provider ' + (i + 1), `${val(v.name)}<br><span style="font-weight:400;color:#5c6b85;">licence ${val(v.license)} exp ${val(v.license_exp)} &nbsp; DEA ${val(v.dea)} exp ${val(v.dea_exp)}</span>`)).join('');

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;color:#14213d;">
    <p style="font-size:15px;line-height:1.6;">A PDRx account intake has come in. Everything below is exactly as it was entered. Forward this message to the pharmacy as it stands.</p>
    <!-- Rides at the top of the forwarded mail so the pharmacy never has the account without
         the person who opened it. -->
    <div style="border:1px solid #dce6f2;border-left:3px solid #2f5ea8;border-radius:0 10px 10px 0;padding:12px 16px;margin:0 0 18px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:#8b97ac;font-weight:700;">Submitted by</div>
      <div style="font-size:15px;font-weight:700;color:#14213d;margin-top:2px;">Eric Weiscarger</div>
      <div style="font-size:13px;color:#5c6b85;">MDconcierge</div>
      <div style="font-size:12.5px;color:#5c6b85;margin-top:5px;">(570) 817-7569 &nbsp;&middot;&nbsp;
        <a href="mailto:eric@mdconcierge.net" style="color:#2f5ea8;text-decoration:none;font-weight:600;">eric@mdconcierge.net</a>
        &nbsp;&middot;&nbsp; mdconcierge.net</div>
    </div>
    <table style="border-collapse:collapse;font-size:14px;line-height:1.55;">
      ${row('Program', val(p.program))}
      ${row('Practice', val(pr.legal_name))}
      ${row('Signer', `${val(pr.signer_name)}${pr.signer_title ? ', ' + esc(pr.signer_title) : ''}`)}
      ${row('Signer email', val(pr.signer_email))}
      ${row('Signer cell', val(pr.signer_cell))}
      ${row('EIN', val(pay.ein))}
      ${row('Remittance email', val(pay.remittance_email))}
      ${row('Payment address', val(pay.address))}
      ${locs}
      ${provs}
      ${row('Submitted by', `${val(sub.name)} &lt;${val(sub.email)}&gt;`)}
    </table>
    <p style="font-size:12px;color:#8b97ac;line-height:1.6;margin-top:18px;">
      Anything marked <span style="color:#b0453a;">not given</span> was left blank on the form and the
      pharmacy will ask for it. This went only to you; the physician was not copied.</p>
  </div>`;
}

async function main() {
  // Only intakes, only ones not already sent. flagged_reason is the marker: the row stays
  // 'pending' so it still shows up for review in the dashboard.
  const rows = await sGet('signup_submissions?select=id,org_name,submitter_email,payload,created_at'
    + '&payload->>kind=eq.pdrx_intake&flagged_reason=is.null&order=created_at.asc&limit=25');
  if (!rows.length) { console.log('pdrx-intake-watch: nothing new.'); return; }

  if (!ERIC_PASS) {
    console.error(`pdrx-intake-watch: ${rows.length} intake(s) waiting but no mail password is set. NOT marking them, so they send once it is.`);
    process.exit(1);
  }
  const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });

  for (const r of rows) {
    const p = r.payload || {};
    const name = (p.practice && p.practice.legal_name) || r.org_name || 'a practice';
    try {
      await t.sendMail({
        from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER,
        subject: `PDRx intake, ${name}`,
        html: card(p),
        headers: { 'X-MDC-Bot': 'engine', 'X-MDC-Auto': 'pdrx-intake' },
      });
      // Stamped only after the send succeeds, so a mail failure means it goes out next run
      // rather than being lost.
      await sPatch(`signup_submissions?id=eq.${r.id}`,
        { flagged_reason: `PDRx intake emailed to Eric ${new Date().toISOString().slice(0, 16).replace('T', ' ')}, ready to forward to the pharmacy` });
      console.log(`pdrx-intake-watch: sent intake ${r.id} (${name}).`);
    } catch (e) {
      console.error(`pdrx-intake-watch: intake ${r.id} failed to send: ${e.message}. Left unmarked for the next run.`);
    }
  }
}

main().catch((e) => { console.error('pdrx-intake-watch fatal: ' + (e && e.message)); process.exit(1); });
