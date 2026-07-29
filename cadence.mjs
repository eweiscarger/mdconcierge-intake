// Outreach queue builder (behavior-aware). Populates mdrx_outbox with the day's
// due touches for Eric to APPROVE and send (via the send-outreach edge function).
// It SENDS NOTHING itself. The sequence is behavior-driven, not a dumb timer:
//   - It only queues leads in Queued/New/Contacted whose next touch is due.
//   - Leads who replied, engaged, opted out, or booked are Engaged/Replied/
//     Not Interested/Unsubscribed/Won and are EXCLUDED here (handled by the reply
//     agent + next-move agent). That is the automatic stop.
//   - Suppressed and no-email leads are skipped. Warm-up ramp + per-practice pacing.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) { if (!v) { console.error('Missing env: ' + k); process.exit(1); } }

const SITE = 'https://mdconcierge.net';
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };
const today = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Clean, personal plain-text touches. No address, no unsubscribe. End at "Best,"
// (the signature is attached at send time by the send-outreach function).
const link = (t, to) => `${SITE}/go.html?p=${t}&to=${to}`;
function touchBody(touch, p) {
  const dr = `Dr. ${p.last_name || ''}`.trim();
  const t = p.funnel_token || '';
  if (touch === 1) {
    return `${dr},\n\nIf you treat workers' compensation patients, a recent Pennsylvania Supreme Court decision has significantly expanded physicians' ability to participate financially in workers' compensation pharmacy.\n\nOn June 16, 2026, in 700 Pharmacy v. Bureau of Workers' Compensation Fee Review, the Court confirmed that physicians may have a financial interest in a workers' compensation pharmacy, and that insurers cannot deny payment for covered prescriptions on that basis.\n\nOur Workers' Compensation Pharmacy Platform lets physicians share in that pharmacy revenue without owning, operating, staffing, or purchasing a pharmacy, and without changing how you prescribe.\n\nWhat it means for you:\n- Medications shipped directly to injured workers at no cost to them while the claim is open, which helps adherence.\n- Ancillary pharmacy revenue from the work-comp prescriptions you already write.\n- No workflow or administrative change for you or your staff.\n\nA few resources if you want to review the legal foundation first:\n- Pennsylvania Supreme Court decision: ${link(t, 'decision')}\n- Daniel Siegel's analysis for PA physicians: ${link(t, 'siegel')}\n- Overview of the platform: ${link(t, 'program')}\n\nIf you would like to explore whether participating is right for your practice, I am happy to answer your compliance questions and walk you through the model. Grab 15 minutes here: ${link(t, 'book')}, or just reply with any questions.\n\nBest,`;
  }
  if (touch === 2) return `${dr},\n\nFollowing up on my note about the Pennsylvania Supreme Court's 700 Pharmacy decision and what it means for practices that treat injured workers. I think it is directly relevant to the work-comp scripts your practice already writes. The decision and a short overview are here whenever you have a minute: ${link(t, 'program')}\n\nBest,`;
  if (touch === 3) return `${dr},\n\nKeeping this short. If it is useful, the decision and our program overview answer most questions on their own: ${link(t, 'program')}. And if you would rather talk it through, my calendar is open: ${link(t, 'book')}\n\nBest,`;
  return `${dr},\n\nI will close the loop here so I am not crowding your inbox. If the timing is not right, no problem at all. If it is ever worth a look, the decision and program details are here: ${link(t, 'program')}, and my calendar is open if you would prefer to talk: ${link(t, 'book')}. Either way, I wish you and your patients well.\n\nBest,`;
}
const SUBJECTS = {
  1: "Pennsylvania Supreme Court Confirms Physicians May Have a Financial Interest in Workers' Compensation Pharmacy",
  2: "Following up: the 700 Pharmacy decision and your work-comp scripts",
  3: "A cleaner way to handle your work-comp pharmacy",
  4: "Closing the loop",
};

async function run() {
  const cfg = (await sGet('outreach_config?id=eq.1'))[0] || {};
  if (!cfg.warmup_started_at) await sPatch('outreach_config?id=eq.1', { warmup_started_at: today() });
  // Batch size: explicit BATCH_SIZE override (manual first batch), else the daily cap. Eric self-throttles by approving fewer.
  const cap = Number(process.env.BATCH_SIZE) || Number(cfg.daily_send_cap) || 20;

  // Recycle Not-Now leads whose recycle date arrived.
  const rec = await sGet(`mdrx_providers?select=id&lead_type=eq.funnel&funnel_stage=eq.Not%20Now&recycle_date=lte.${today()}`);
  for (const r of rec) await sPatch(`mdrx_providers?id=eq.${r.id}`, { funnel_stage: 'Queued', touch_count: 0, next_step: 'Touch 1', funnel_next_date: today(), recycle_date: null });

  // Already-queued leads (avoid duplicates).
  const openBox = await sGet('mdrx_outbox?select=provider_id&status=eq.pending');
  const queued = new Set((openBox || []).map((x) => x.provider_id));
  const supp = await sGet('suppressions?select=email');
  const suppressed = new Set((supp || []).map((s) => (s.email || '').toLowerCase()));

  // Behavior-aware pool: only Queued/New/Contacted (NOT Engaged/Replied/Not Interested/Unsubscribed/Won/Lost),
  // due today, with an email, not suppressed. Hottest-first is not needed; go by due date.
  const pool = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,funnel_token,email,touch_count,funnel_next_date&lead_type=eq.funnel&funnel_stage=in.(New,Queued,Contacted)&email=not.is.null&suppressed=eq.false&or=(funnel_next_date.is.null,funnel_next_date.lte.${today()})&order=funnel_next_date.asc.nullsfirst&limit=400`);

  let queuedCount = 0; const practicesToday = new Set();
  for (const p of pool) {
    if (queuedCount >= cap) break;
    if (queued.has(p.id)) continue;
    if (suppressed.has((p.email || '').toLowerCase())) continue;
    const prac = (p.practice_name || '').toLowerCase();
    if (prac && practicesToday.has(prac)) continue; // pace by practice: max one per office per run
    const touch = (p.touch_count || 0) + 1;
    if (touch > 4) { await sPatch(`mdrx_providers?id=eq.${p.id}`, { funnel_stage: 'Not Now', next_step: 'Recycle', recycle_date: addDaysISO(90), funnel_next_date: addDaysISO(90) }); continue; }
    await sPost('mdrx_outbox', {
      provider_id: p.id, touch_no: touch, to_email: p.email,
      subject: SUBJECTS[touch] || SUBJECTS[4], body_text: touchBody(touch, p), body_html: null,
      status: 'pending', scheduled_date: today(),
    });
    if (prac) practicesToday.add(prac);
    queued.add(p.id); queuedCount++;
  }
  console.log(`queue builder ${today()}: warmup day ${daysIn} cap ${cap}, queued ${queuedCount} touch(es) for approval. Recycled ${rec.length}.`);
}
run().catch((e) => { console.error('Fatal: ' + (e?.stack || e)); process.exit(1); });
