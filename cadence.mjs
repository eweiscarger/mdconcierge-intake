// Outreach cadence sequencer (the sales team running itself) - MANUAL TRIGGER ONLY.
// Advances funnel leads through the touch cadence and sends each touch from eric@.
// STOPS the instant a lead engages / replies / books (handled elsewhere), checks
// suppression before every send, recycles Not-Now leads.
//
// DOUBLE-GATED so it can never fire by accident:
//   1) there is NO schedule - it only runs when you press "Run workflow" (or Claude triggers it)
//   2) it only actually sends when outreach_config.sending_enabled = true AND a real
//      physical_address is set. Otherwise it does a DRY preview (logs who it would send to).
//
// Optional slice inputs (env): SLICE_TIER (A|B|C), SLICE_SPECIALTY, SLICE_LIMIT.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ERIC_USER, MDRX_ERIC_PASS
import nodemailer from 'nodemailer';

const SITE = 'https://mdconcierge.net';
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ERIC_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY })) { if (!v) { console.error('Missing env: ' + k); process.exit(1); } }

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };
const today = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const addMonthsISO = (m) => { const d = new Date(); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };

const SUBJECTS = [
  "injured workers getting their meds, and the practice's side of it",
  "the 700 Pharmacy decision, in one page",
  "a cleaner way to handle your work-comp scripts",
];
const links = (t) => ({ overview: `${SITE}/go.html?p=${t}&to=brief`, book: `${SITE}/book.html?p=${t}`, unsub: `${SITE}/unsubscribe.html?p=${t}` });
const footer = (cfg, t) => { const l = links(t); return `\n\n${cfg.from_name}\n${cfg.physical_address}\nUnsubscribe: ${l.unsub}`; };
function body(touch, p, cfg) {
  const l = links(p.funnel_token); const first = p.first_name || 'there';
  const opener = p.personalized_opener || `Dr. ${p.last_name || ''},`;
  if (touch === 1) return `${opener}\n\nQuick context on why I'm reaching out. MDconcierge works with Pennsylvania practices that treat injured workers. The problem we handle is a familiar one: nearly a third of workers-comp patients hit delays or outright denials filling their prescriptions at the big-box pharmacies, which slows recovery and comes back on your staff.\n\nThere's an independent mail-order pharmacy network that ships those medications straight to the patient's door, next-day, at no cost to them, routed through your EHR like any other script. And since the Pennsylvania Supreme Court's 700 Pharmacy decision this June, there is now a compliant way for physicians or the practice to share in the economics of those claims, vetted by some of the largest health-law firms in the country.\n\nThe overview lays it out on one page, with the two authoritative write-ups right there: Dan Siegel, the attorney who won the case, and Alice Gosfield, whose analysis calls the model worth reconsidering. Have a look whenever it suits you.\n\nWhichever is easier for you:\n\n  See the overview and the legal write-ups: ${l.overview}\n  Book 15 minutes with me: ${l.book}\n\nNo obligation on either. If you'd rather I just send the details by email, reply with "info" and I'll pass them along.` + footer(cfg, p.funnel_token);
  if (touch === 2) return `${first}, following up on the note about the 700 Pharmacy decision and the work-comp pharmacy overview. No agenda, I just think it's relevant to how ${p.practice_name || 'your practice'} already handles injured workers. The one-pager is here whenever you have a minute: ${l.overview}` + footer(cfg, p.funnel_token);
  if (touch === 3) return `${first}, I'll leave it here so I'm not cluttering your inbox. If it's ever useful, the overview and the two legal write-ups answer most of the questions on their own: ${l.overview}. And if you'd rather talk it through, my calendar's open: ${l.book}.` + footer(cfg, p.funnel_token);
  return `${first}, I'll close the loop here since I don't want to crowd your inbox. If the timing isn't right, no problem at all. If it's ever worth a look, the overview and the two legal write-ups are here: ${l.overview}, and my calendar's open if you'd rather talk: ${l.book}. Either way, I wish you and your patients well.` + footer(cfg, p.funnel_token);
}

async function run() {
  const cfg = (await sGet('outreach_config?id=eq.1'))[0];
  if (!cfg) { console.log('no outreach_config'); return; }
  const addrOk = cfg.physical_address && !/SET PHYSICAL ADDRESS/i.test(cfg.physical_address);
  const DRY = !cfg.sending_enabled || !addrOk;
  const cad = cfg.cadence || { t1_day: 1, t2_day: 4, t3_day: 9, breakup_day: 16, recycle_months: 3 };
  console.log(`cadence ${today()} | mode=${DRY ? 'DRY PREVIEW (no send)' : 'LIVE'} | cap=${cfg.daily_send_cap}${addrOk ? '' : ' | reason: no real address'}${cfg.sending_enabled ? '' : ' | reason: sending_enabled off'}`);

  // Recycle Not-Now leads whose recycle_date arrived.
  const rec = await sGet(`mdrx_providers?select=id&lead_type=eq.funnel&funnel_stage=eq.Not%20Now&recycle_date=lte.${today()}`);
  for (const r of rec) await sPatch(`mdrx_providers?id=eq.${r.id}`, { funnel_stage: 'Queued', touch_count: 0, next_step: 'Touch 1', funnel_next_date: today(), recycle_date: null });
  if (rec.length) console.log(`recycled ${rec.length} Not-Now -> Queued`);

  // Optional slice filters for the manual trigger.
  let q = `mdrx_providers?select=id,first_name,last_name,practice_name,personalized_opener,funnel_token,email,touch_count&lead_type=eq.funnel&funnel_stage=in.(Queued,Contacted)&funnel_next_date=lte.${today()}&email=not.is.null&suppressed=eq.false&order=funnel_next_date.asc`;
  if (process.env.SLICE_TIER) q += `&intent_tier=eq.${encodeURIComponent(process.env.SLICE_TIER)}`;
  if (process.env.SLICE_SPECIALTY) q += `&target_specialty=eq.${encodeURIComponent(process.env.SLICE_SPECIALTY)}`;
  const cap = Number(process.env.SLICE_LIMIT) || cfg.daily_send_cap || 40;
  q += `&limit=${cap}`;
  const leads = await sGet(q);
  console.log(`${leads.length} lead(s) due (cap ${cap})`);

  const transport = DRY ? null : nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
  let sent = 0, skipped = 0;
  for (const p of leads) {
    const sup = await sGet(`suppressions?select=email&email=ilike.${encodeURIComponent(p.email)}`);
    if (sup.length) { skipped++; continue; }
    const touch = (p.touch_count || 0) + 1;
    if (touch > 4) { await sPatch(`mdrx_providers?id=eq.${p.id}`, { funnel_stage: 'Not Now', next_step: 'Recycle', recycle_date: addMonthsISO(cad.recycle_months || 3), funnel_next_date: null }); continue; }
    const subject = SUBJECTS[(touch - 1) % SUBJECTS.length];
    const text = body(touch, p, cfg);
    if (DRY) { console.log(`[dry] touch ${touch} -> ${p.email} (${p.first_name} ${p.last_name})`); sent++; continue; }
    try { await transport.sendMail({ from: `"${cfg.from_name}" <${ERIC_USER}>`, to: p.email, subject, text }); }
    catch (e) { console.error(`send failed ${p.email}: ${e.message}`); skipped++; continue; }
    const nextDate = touch === 1 ? addDaysISO(cad.t2_day - cad.t1_day) : touch === 2 ? addDaysISO(cad.t3_day - cad.t2_day) : touch === 3 ? addDaysISO(cad.breakup_day - cad.t3_day) : null;
    const patch = { touch_count: touch, last_touch_at: new Date().toISOString(), funnel_stage: 'Contacted', next_step: `Touch ${touch + 1}`, funnel_next_date: nextDate };
    if (touch === 4) { patch.funnel_stage = 'Not Now'; patch.next_step = 'Recycle'; patch.recycle_date = addMonthsISO(cad.recycle_months || 3); patch.funnel_next_date = patch.recycle_date; }
    await sPatch(`mdrx_providers?id=eq.${p.id}`, patch);
    sent++;
  }
  console.log(`done. ${DRY ? 'would-send' : 'SENT'}=${sent} skipped=${skipped}`);
}
run().catch(e => { console.error('Fatal: ' + (e?.stack || e)); process.exit(1); });
