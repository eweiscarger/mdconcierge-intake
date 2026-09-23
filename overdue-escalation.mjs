// overdue-escalation.mjs — the manager's safety net.
// Every lead carries a next step and a date. If one goes 3 days past due, nobody is working it,
// and a red banner on a page nobody opened is not a control. This escalates to the manager.
// Grouped by owner, so it reads as "who is behind on what" the moment there is more than one rep.
// Each lead escalates once, then goes quiet for 14 days so the digest never becomes noise.
// Outbound goes through the shared capped transport: every notification path here is already
// one-shot per lead with a 14 day quiet window, and the cap is what catches the case where that
// bookkeeping fails and the same lead escalates in a loop. See mailer.mjs.
import { transporter } from './mailer.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) { if (!v) { console.error('Missing env: ' + k); process.exit(1); } }
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`supabase GET ${p} -> ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300)); return r.json(); };
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

  // Eric, 23 Sep 2026: a recommendation for Dr. Teichman sat pending for thirteen days and nothing
  // in the system could see it, because this job only ever looked at funnel_next_date. A drafted
  // move nobody ruled on is exactly as overdue as a lead nobody worked, and it now escalates too.
  const staleMoves = await sGet(
    `mdrx_next_moves?select=id,provider_id,subject,angle,recommended_date&status=eq.pending`
    + `&recommended_date=lt.${cutoff}&order=recommended_date.asc&limit=200`);
  const moveIds = [...new Set(staleMoves.map((m) => m.provider_id).filter(Boolean))];
  const movePro = moveIds.length
    ? await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name&id=in.(${moveIds.join(',')})&limit=200`)
    : [];
  const moveBy = new Map(movePro.map((p) => [p.id, p]));

  if (!rows.length && !staleMoves.length) { console.log(`overdue-escalation: nothing more than ${DAYS_LATE} days past due.`); return; }

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

  // Every name is a link that opens that record with the draft already on screen. Acting on this
  // mail is one click, never a search.
  const COCKPIT = 'https://mdconcierge.net/admin-v2.html';
  let movesBlock = '';
  if (staleMoves.length) {
    const rowsHtml = staleMoves.map((m) => {
      const p = moveBy.get(m.provider_id) || {};
      const nm = `${p.first_name || ''} ${p.last_name || ''}`.trim() || ('lead ' + m.provider_id);
      const age = days(String(m.recommended_date).slice(0, 10));
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;"><a href="${COCKPIT}?open=${m.provider_id}" style="color:#08214C;font-weight:600;">${esc(nm)}</a><div style="color:#6b7a90;font-size:11.5px;">${esc(p.practice_name || '')}</div></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;">${esc(String(m.angle || '').slice(0, 70))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e6ecf5;color:#c0392b;font-weight:700;white-space:nowrap;">${age} days waiting</td>
      </tr>`;
    }).join('');
    movesBlock = `<p style="font-size:14px;margin:18px 0 6px;"><b>Drafted moves nobody has ruled on</b> &middot; ${staleMoves.length}</p>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
      <tr style="text-align:left;color:#6b7a90;font-size:11.5px;"><th style="padding:4px 10px;">Who</th><th style="padding:4px 10px;">The move</th><th style="padding:4px 10px;">Waiting</th></tr>
      ${rowsHtml}</table>`;
  }

  // The subject leads with the worst age, not a count, because age is the thing that turns a lead
  // into a person who stopped waiting.
  const worstMove = staleMoves.length ? days(String(staleMoves[0].recommended_date).slice(0, 10)) : 0;
  const worstLead = rows.length ? days(rows[0].funnel_next_date) : 0;
  const worstAge = Math.max(worstMove, worstLead);
  const worstName = (() => {
    if (worstMove >= worstLead && staleMoves.length) {
      const p = moveBy.get(staleMoves[0].provider_id) || {};
      return `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'a lead';
    }
    if (rows.length) return `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim() || 'a lead';
    return 'a lead';
  })();

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a2233;">
    <p style="font-size:15px;">${worstName} has been waiting ${worstAge} days.</p>
    ${rows.length ? `<p style="font-size:14px;">${rows.length} lead(s) are more than ${DAYS_LATE} days past their next step and nobody has worked them.</p>` : ''}
    ${sections}
    ${movesBlock}
    <p style="font-size:12.5px;color:#6b7a90;margin-top:18px;">Each lead here escalates once, then goes quiet for ${QUIET_DAYS} days. Working the lead or changing its date clears it.</p></div>`;

  if (!ERIC_PASS) { console.log(`overdue-escalation: would alert on ${rows.length} lead(s) and ${staleMoves.length} stranded move(s) but no mail password is set.`); return; }
  const t = transporter;   // shared capped transport; credentials resolved inside mailer.mjs
  // Both header sets used to be passed as two `headers` keys on the same object, so the second
  // silently replaced the first and X-MDC-Bot never went out. Merged.
  await t.sendMail({ headers: { 'X-MDC-Bot': 'engine', 'X-MDC-Auto': 'escalation' }, from: `"MDconcierge" <${ERIC_USER}>`, to: manager, subject: `[MDconcierge] ${worstName} waiting ${worstAge} days${rows.length + staleMoves.length > 1 ? ` and ${rows.length + staleMoves.length - 1} more` : ''}`, html });

  const now = new Date().toISOString();
  for (const r of rows) await sPatch(`mdrx_providers?id=eq.${r.id}`, { escalated_at: now });
  console.log(`overdue-escalation: escalated ${rows.length} lead(s) to ${manager}.`);
}

main().catch((e) => { console.error('Fatal: ' + (e?.stack || e)); process.exit(1); });
