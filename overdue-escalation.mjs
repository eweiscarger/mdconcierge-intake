// overdue-escalation.mjs — the manager's safety net.
// Every lead carries a next step and a date. If one goes 3 days past due, nobody is working it,
// and a red banner on a page nobody opened is not a control. This escalates to the manager.
// Grouped by owner, so it reads as "who is behind on what" the moment there is more than one rep.
// Each lead escalates once, then goes quiet for 14 days so the digest never becomes noise.
import nodemailer from 'nodemailer';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) { if (!v) { console.error('Missing env: ' + k); process.exit(1); } }
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };

const DAYS_LATE = Number(process.env.OVERDUE_DAYS || 3);
const QUIET_DAYS = 14;                       // do not re-escalate the same lead inside this window
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function main() {
  const cfg = (await sGet('outreach_config?id=eq.1'))[0] || {};
  const manager = cfg.manager_email || ERIC_USER;
  const cutoff = iso(-DAYS_LATE);
  const quiet = new Date(Date.now() - QUIET_DAYS * 86400000).toISOString();

  const rows = await sGet(
    `mdrx_providers?select=id,first_name,last_name,practice_name,owner,funnel_stage,next_step,funnel_next_date,email,escalated_at`
    + `&suppressed=eq.false&funnel_stage=not.in.(Won,Lost,Not%20Interested,Unsubscribed)`
    + `&funnel_next_date=lt.${cutoff}&or=(escalated_at.is.null,escalated_at.lt.${quiet})&order=funnel_next_date.asc&limit=500`);

  if (!rows.length) { console.log(`overdue-escalation: nothing more than ${DAYS_LATE} days past due.`); return; }

  const byOwner = {};
  for (const r of rows) (byOwner[r.owner || 'unassigned'] = byOwner[r.owner || 'unassigned'] || []).push(r);

  const today = new Date().toISOString().slice(0, 10);
  const days = (d) => Math.floor((new Date(today) - new Date(d)) / 86400000);
  let sections = '';
  for (const [owner, list] of Object.entries(byOwner)) {
    const items = list.map((r) => {
      const who = `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email || ('lead ' + r.id);
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;">${esc(who)}<div style="color:#6b7a90;font-size:11.5px;">${esc(r.practice_name || '')}</div></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;">${esc(r.funnel_stage || '')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;">${esc(r.next_step || 'no step set')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;color:#c0392b;font-weight:700;white-space:nowrap;">${days(r.funnel_next_date)} days late</td>
      </tr>`;
    }).join('');
    sections += `<p style="font-size:14px;margin:18px 0 6px;"><b>${esc(owner)}</b> &middot; ${list.length} lead(s) past due</p>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
      <tr style="text-align:left;color:#6b7a90;font-size:11.5px;"><th style="padding:4px 10px;">Lead</th><th style="padding:4px 10px;">Stage</th><th style="padding:4px 10px;">Next step</th><th style="padding:4px 10px;">Overdue</th></tr>
      ${items}</table>`;
  }

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2233;">
    <p style="font-size:15px;">${rows.length} lead(s) are more than ${DAYS_LATE} days past their next step and nobody has worked them.</p>
    ${sections}
    <p style="font-size:12.5px;color:#6b7a90;margin-top:18px;">Each lead here escalates once, then goes quiet for ${QUIET_DAYS} days. Working the lead or changing its date clears it.</p></div>`;

  if (!ERIC_PASS) { console.log(`overdue-escalation: would alert on ${rows.length} lead(s) but no mail password is set.`); return; }
  const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
  await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: manager, subject: `[MDconcierge] ${rows.length} lead(s) past due by ${DAYS_LATE}+ days`, html, headers: { 'X-MDC-Auto': 'escalation' } });

  const now = new Date().toISOString();
  for (const r of rows) await sPatch(`mdrx_providers?id=eq.${r.id}`, { escalated_at: now });
  console.log(`overdue-escalation: escalated ${rows.length} lead(s) to ${manager}.`);
}

main().catch((e) => { console.error('Fatal: ' + (e?.stack || e)); process.exit(1); });
