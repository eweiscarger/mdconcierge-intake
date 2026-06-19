// One-off test harness: simulate FOLLOW-UP scenarios so they can be watched in minutes, not days.
// Run via the "Test scenario" GitHub workflow: node test-scenario.mjs seed|bump|cleanup
//
// seed → creates three routed test cases, all aimed at TEST_RECIPIENT so you can watch the emails:
//   A) TEST-NR-…      practice didn't respond to schedule → reminder #1 (then bump for #2, #3, escalation)
//   B) TEST-SCHED-…   provider scheduled the patient → appointment relayed to the attorney
//   C) TEST-UNREACH-… provider can't reach the patient → "ring the bell" escalation to the attorney
// bump    → resets the TEST-NR check-in so the NEXT reminder/escalation fires (~90s). Run repeatedly.
// cleanup → deletes the test cases and the test contact.

const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SB || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const get = async p => { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`GET ${p} → ${r.status} ${await r.text()}`); return r.json(); };
const post = async (t, b) => { const r = await fetch(`${SB}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`POST ${t} → ${r.status} ${await r.text()}`); };
const patch = async (p, b) => { const r = await fetch(`${SB}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`PATCH ${p} → ${r.status} ${await r.text()}`); };
const del = async p => { const r = await fetch(`${SB}/rest/v1/${p}`, { method: 'DELETE', headers: H }); if (!r.ok) throw new Error(`DEL ${p} → ${r.status} ${await r.text()}`); };
const rndhex = () => Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);

const RECIPIENT = process.env.TEST_RECIPIENT || 'eweiscarger@gmail.com';
const past = new Date(Date.now() - 86400000).toISOString();
const mode = (process.argv[2] || 'seed').toLowerCase();

if (mode === 'seed') {
  const provs = await get('providers?select=id,practice_id,doctor_name&practice_id=not.is.null&limit=1');
  if (!provs.length) throw new Error('No provider with a practice found — import a practice first.');
  const prov = provs[0];
  // make sure the practice has a referral contact = RECIPIENT (for the practice-facing scenario)
  const existing = await get(`contacts?select=id&practice_id=eq.${prov.practice_id}&email=eq.${encodeURIComponent(RECIPIENT)}`);
  if (existing.length) await patch(`contacts?id=eq.${existing[0].id}`, { receives_referrals: true });
  else await post('contacts', { practice_id: prov.practice_id, name: 'Test Scheduler (TEST)', email: RECIPIENT, role: 'scheduler', receives_referrals: true, source: 'test' });

  const tmpl = (await get('cases?select=*&order=created_at.desc&limit=1'))[0];
  if (!tmpl) throw new Error('No existing case to template from.');
  const stamp = Date.now().toString().slice(-6);
  const senderNote = `Sender: ${RECIPIENT}`;   // resolveOwnerEmails(attorney) reads this from notes
  const base = () => { const c = { ...tmpl }; delete c.id; delete c.created_at; delete c.updated_at;
    c.accept_token = rndhex(); c.accept_token_exp = new Date(Date.now() + 14 * 86400000).toISOString();
    c.status_token = rndhex(); c.status_token_exp = new Date(Date.now() + 30 * 86400000).toISOString();
    c.routed_provider_id = prov.id; c.routed_practice_id = prov.practice_id; c.case_type = 'wc';
    c.patient_phone = '(570) 000-0000'; c.followup_count = 0; c.appointment_at = null;
    c.appt_relayed = true; c.unreachable_relayed = true; c.next_checkin = null; c.schedule_status = null;
    return c; };

  // A) practice didn't respond to schedule → reminder sequence
  const a = base();
  Object.assign(a, { case_id: `TEST-NR-${stamp}`, status: 'routed', provider_notified: true, next_checkin: past,
    patient_first: 'Avery', patient_last: 'NoResponse', injury_type: 'low back (TEST)',
    notes: `TEST: practice did not respond to schedule. | ${senderNote}` });

  // B) provider scheduled → relay to attorney
  const b = base();
  Object.assign(b, { case_id: `TEST-SCHED-${stamp}`, status: 'in_coordination', provider_notified: true,
    schedule_status: 'scheduled', appt_relayed: false, appointment_at: 'next Tuesday at 10:30 AM',
    patient_first: 'Blair', patient_last: 'Scheduled', injury_type: 'right shoulder (TEST)',
    notes: `TEST: provider scheduled the patient. | ${senderNote}` });

  // C) can't reach patient → ring the bell to attorney
  const c = base();
  Object.assign(c, { case_id: `TEST-UNREACH-${stamp}`, status: 'in_coordination', provider_notified: true,
    schedule_status: 'unable', unreachable_relayed: false,
    patient_first: 'Casey', patient_last: 'Unreachable', injury_type: 'neck (TEST)',
    notes: `TEST: provider can't reach patient to schedule. | ${senderNote}` });

  for (const cse of [a, b, c]) await post('cases', cse);
  console.log(`SEEDED 3 scenarios (all emails → ${RECIPIENT}), routed at practice ${prov.practice_id} / "${prov.doctor_name || prov.id}":`);
  console.log(`  A ${a.case_id}  — practice didn't respond → reminder #1 within ~90s (use "bump" for #2, #3, escalation)`);
  console.log(`  B ${b.case_id}  — scheduled → appointment relayed to attorney within ~90s`);
  console.log(`  C ${c.case_id}  — can't reach patient → escalation to attorney within ~90s`);
} else if (mode === 'bump') {
  const cs = await get('cases?select=id,case_id,followup_count&case_id=like.TEST-NR-*');
  if (!cs.length) console.log('No TEST-NR cases to bump.');
  for (const c of cs) { await patch(`cases?id=eq.${c.id}`, { next_checkin: past }); console.log(`Bumped ${c.case_id} (reminders so far: ${c.followup_count}) → next one fires within ~90s.`); }
} else if (mode === 'cleanup') {
  const cs = await get('cases?select=id,case_id&case_id=like.TEST-*');
  for (const c of cs) { await del(`cases?id=eq.${c.id}`); console.log(`Deleted ${c.case_id}`); }
  const ct = await get(`contacts?select=id&name=eq.${encodeURIComponent('Test Scheduler (TEST)')}`);
  for (const x of ct) { await del(`contacts?id=eq.${x.id}`); console.log('Deleted test contact'); }
  console.log('Cleanup done.');
} else if (mode === 'status') {
  const cs = await get('cases?select=case_id,status,followup_count,appt_relayed,unreachable_relayed,next_checkin&case_id=like.TEST-*&order=case_id');
  if (!cs.length) console.log('No TEST-* cases found.');
  for (const c of cs) {
    let verdict = '';
    if (c.case_id.startsWith('TEST-NR-')) verdict = c.followup_count > 0 ? `✓ engine sent ${c.followup_count} reminder(s)` : '… not yet picked up';
    else if (c.case_id.startsWith('TEST-SCHED-')) verdict = c.appt_relayed ? '✓ appointment relayed to attorney' : '… not yet relayed';
    else if (c.case_id.startsWith('TEST-UNREACH-')) verdict = (c.unreachable_relayed || c.status === 'escalated') ? '✓ escalation relayed to attorney' : '… not yet escalated';
    console.log(`${c.case_id}  [status=${c.status} followups=${c.followup_count} appt_relayed=${c.appt_relayed} unreachable_relayed=${c.unreachable_relayed}]  → ${verdict}`);
  }
} else { console.error(`Unknown mode "${mode}" — use seed | bump | status | cleanup`); process.exit(1); }
