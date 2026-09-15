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

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { emailFaults, linkLabel } from './check.mjs';

// A lead Eric answered by hand is his conversation for the next ten days. sent-scan.mjs stamps
// manual_touch_at from his own Sent folder; the machine stays off the thread until it lapses.
const MANUAL_PAUSE_DAYS = Number(process.env.MANUAL_PAUSE_DAYS || 10);
const manualCutoff = () => new Date(Date.now() - MANUAL_PAUSE_DAYS * 86400000).toISOString();

const SITE = 'https://mdconcierge.net';

// Touch 1 = the approved DESIGNED email. body_text below stays as the plain-text
// alternative; send-outreach sends body_html when present and falls back to text.
const TOUCH_HTML = {
  1: readFileSync(new URL('./email-templates/touch1.html', import.meta.url), 'utf8'),
  2: readFileSync(new URL('./email-templates/touch2.html', import.meta.url), 'utf8'),
  3: readFileSync(new URL('./email-templates/touch3.html', import.meta.url), 'utf8'),
  4: readFileSync(new URL('./email-templates/touch4.html', import.meta.url), 'utf8'),
  5: readFileSync(new URL('./email-templates/touch5.html', import.meta.url), 'utf8'),
};
// Eric's signature lives INSIDE the card, not appended after it. send-outreach sees the
// <!--signature-inline--> marker and skips its own append so it never doubles up.
const SIGNATURE_HTML = readFileSync(new URL('./email-templates/signature.html', import.meta.url), 'utf8');
// Engaged follow-ups use the same card, header and signature block as the cold touches, so every
// email that leaves here looks like the same company wrote it.
const ENGAGED_HTML = readFileSync(new URL('./email-templates/engaged.html', import.meta.url), 'utf8');
const P = 'style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 14px;"';
// Turn the plain-text body into the card's paragraph markup, keeping links clickable.
// Link names come from check.mjs so this file and the sender cannot disagree about what a
// destination is called. The local copy that used to live here knew four destinations and called
// everything else "See the details".

function engagedHtmlBody(text){
  const NL = String.fromCharCode(10);
  // Drop the trailing sign-off: the card prints its own above the signature block.
  const trimmed = String(text || '').trim().replace(/(\r?\n)+Best,\s*$/, '');
  const paras = trimmed.split(NL + NL);
  return paras.map(function(par){
    const line = par.trim();
    // A paragraph that is only a link reads as a naked URL in an email. Make it the button.
    if (/^https?:\/\/\S+$/.test(line)) {
      return '<p style="margin:22px 0;"><a href="' + line + '" style="background:#08214C;color:#ffffff;'
        + 'text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:9px;'
        + 'display:inline-block;">' + linkLabel(line) + '</a></p>';
    }
    // A link inside a sentence used to print the URL as its own anchor text.
    const withLinks = esc(line)
      .replace(new RegExp('(https?://\\S+)', 'g'), (u) => '<a href="' + u + '" style="color:#2F5EA8;font-weight:600;">' + linkLabel(u) + '</a>')
      .split(NL).join('<br>');
    return '<p ' + P + '>' + withLinks + '</p>';
  }).join(NL + '        ');
}
function mergeEngaged(n, p, bodyFn){
  return ENGAGED_HTML
    .split('{{body}}').join(engagedHtmlBody(bodyFn(n, p)))
    .split('{{signature}}').join(SIGNATURE_HTML)
    .split('{{last}}').join(p.last_name || '')
    .split('{{optout}}').join('I don\'t want to bother you if not interested, <a href="' + STOP(p.funnel_token || '') + '" style="color:#9aa3af;">click here</a> if you would no longer like to hear from me.')
    .split('{{token}}').join(p.funnel_token || '');
}
// No per-lead opener line. A generic specialty statement reads as filler to a physician
// who already knows it, so Touch 1 opens on the news itself.
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// `hook` is an APPROVED news opener from mdrx_content_queue. It leads the designed email
// for recycled leads instead of replacing it, so a recycled send still looks like us.
const mergeTouch = (touch, p, hook) => {
  const tpl = TOUCH_HTML[touch];
  if (!tpl) return null;
  const h = (hook || '').trim();
  const withHook = h
    ? tpl.replace(/\{\{newshook\}\}/g, esc(h))
    : tpl.replace(/\s*<p[^>]*>\{\{newshook\}\}<\/p>/, '');
  return withHook
    .replace(/\{\{signature\}\}/g, SIGNATURE_HTML)
    .replace(/\{\{last\}\}/g, p.last_name || '')
    .replace(/\{\{token\}\}/g, p.funnel_token || '');
};
// No email may leave with an empty tracking token. A blank token silently destroys attribution:
// funnel-track drops the click, the lead never promotes, and the drip never fires.
async function ensureToken(p) {
  if (p.funnel_token && String(p.funnel_token).trim()) return p.funnel_token;
  const tok = randomUUID().replace(/-/g, '');
  await sPatch(`mdrx_providers?id=eq.${p.id}`, { funnel_token: tok });
  p.funnel_token = tok;
  console.log(`  minted tracking token for ${p.last_name} (#${p.id}) - was blank`);
  return tok;
}

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row, prefer = 'return=minimal') => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };
// Nothing reaches the approval queue without passing the gate. A refusal is loud: it names the
// physician and the reason, so a broken template is obvious in the run log rather than in Eric's
// inbox three days later.
let refused = 0;
// Everything this builder queues is campaign mail: the cold cadence touches and the news drip,
// both of which carry the opt-out on purpose. emailFaults branches on that flag, and it was never
// passed, so `undefined` read as personal and the gate refused those emails for carrying the very
// opt-out they are required to carry. Thirteen of thirteen were thrown out on 25 Aug 2026 for it.
// Anything genuinely one to one must pass campaign:false rather than rely on the default.
async function queueEmail(row, campaign = true) {
  const f = emailFaults({ campaign, html: row.body_html, text: row.body_text, lastName: row._last, toEmail: row.to_email });
  delete row._last;
  if (f.length) { refused++; console.error('  REFUSED ' + row.to_email + ': ' + f.join(', ')); return false; }
  await sPost('mdrx_outbox', row);
  return true;
}
const today = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Clean, personal plain-text touches, ending at "Best," with the signature attached at send
// time by send-outreach. Each carries a soft opt-out in Eric's own words: this is targeted
// sales mail, not a marketing blast, so it reads as a personal offer to stop rather than a
// compliance footer. It hits the same suppression plumbing either way.
const link = (t, to) => `${SITE}/go.html?p=${t}&to=${to}`;
// Soft opt-out. Same suppression plumbing as any opt-out link, worded as a personal
// offer to stop rather than a marketing footer.
// Plain-text signature. The designed HTML carries the full block; the text alternative used to
// end on a bare "Eric", which gave a doctor replying from a phone no way to reach him.
const TEXT_SIG = `Eric Weiscarger
Founder, MDconcierge
(570) 817-7569
eric@mdconcierge.net
mdconcierge.net`;
const STOP = (t) => `${SITE}/unsubscribe.html?p=${t}`;
// ---- Three tiers -------------------------------------------------------------------------------
// Cold, warm and hot are the same machine at different speeds. What changes is the message and the
// interval, never whether Eric has to write it. Everything lands in the one approval queue.
//
// The routing ask, "who else should I be speaking to", only appears at the end of a tier. Asking a
// physician who is actively engaging reads as though we have given up on him, and asking a managing
// partner reads as though we never looked him up. It is suppressed on decision_authority='sole'.

const PEER = {
  orthopedics: 'orthopedic groups', orthopedic: 'orthopedic groups',
  'orthopaedic surgery (sports medicine)': 'orthopedic groups',
  podiatry: 'foot and ankle practices', 'foot & ankle': 'foot and ankle practices',
  neurology: 'neurology practices', pain: 'pain practices',
  'pain medicine, interventional pain medicine': 'interventional pain practices',
  'interventional spine': 'interventional spine practices',
  'physical medicine & rehabilitation': 'physiatry practices',
  'occupational medicine': 'occupational medicine practices',
  'psychiatry & neurology, neurology': 'neurology practices',
};
const peerPhrase = (s) => PEER[String(s || '').toLowerCase().trim()] || 'practices';

// Only asked once a physician has stopped engaging, and never of someone who decides alone.
function routingAsk(p) {
  if (String(p.decision_authority || '') === 'sole') return '';
  return `\n\nMany physicians take this on individually. Some larger groups handle it as a whole instead. If it is the group in your case, who should I be speaking to?`;
}

// Plain text, and nothing else. Ninety of the designed emails went to physicians and two humans
// engaged with them: nine hrefs, four remote images and a token redirector read as a mailshot to
// every filter they passed through, and eighteen near identical copies into one practice's mail
// server did the rest. What survives here is what a person would actually type.
//
// Touch 1 carries no link at all. A reply is the only signal worth having and links are what is
// being scored. The later touches carry the full https URL so every client makes them clickable,
// and the visible text is the destination, so nothing can read as cloaked.
// What the program actually is, in one paragraph. Eric's wording, and it belongs in every touch:
// a physician who reads only one of these emails should still learn who ships the medication, who
// bills it, and what the practice gets, with the detail a click away rather than in the letter.
// Defined once so it is edited once.
// One paragraph, because splitting it made the reader assemble the answer himself: what it means,
// what he does not have to become, who ships and who bills, and who is already doing it.
const PROGRAM = () =>
  `What that means: the revenue those prescriptions already generate comes back to the practice instead of a pharmacy benefits manager with no role in the treatment. You do not own or run the pharmacy and you prescribe exactly as you do today. Our in-network pharmacy overnights the medication to the patient at no cost to them, and MDRx manages the billing and collections, remitting the majority of what is collected to you or the practice. Over 400 providers are doing this with us now.`;
// Kept separate so the block can sit early in a letter while the call to action stays at the end.
// For a physician whose employer will not let him take part in the economics. Written as a
// condition rather than aimed at a segment, because nothing in the record reliably says who is
// employed and who is not: `independent` reads false on 314 of 315 funnel leads. A physician in
// private practice reads past it in a second; an employed one recognises himself.
const HOSPITAL = () =>
  `If your system restricts economic participation, I would still ask you to consider it for the patient side alone. Your patients receive one hundred percent of their medication at no cost, delivered next day. I would be glad to discuss that avenue if it is the more appropriate one.`;
// The same offer without the employment premise, for the last note. A physician who simply does
// not want the revenue can still want his patients to get their medication, and that is a
// conversation worth having rather than a silence.
const PATIENTS_ONLY = () =>
  `And if participating in the economics is not for you, I would still ask you to consider it for the patient side alone. Your patients receive one hundred percent of their medication at no cost, delivered next day. I would be glad to discuss that avenue if it is the more appropriate one.`;
const OVERVIEW = (t) =>
  `[Here is an overview of how it works](https://mdconcierge.net/brief.html?p=${t}), and you can have more sent to you from that page.`;

// Eric, 15 Sep 2026: the sequence is his own email and three standalone follow-ups, approved word
// for word. Every touch has to make sense to a physician who never saw the one before it, so each
// one says what the program is. Plain text, no links: the ask is a reply. Do not edit COLD_OPENER
// or COLD_BODIES without Eric's approval of the exact wording.
const COLD_OPENER = "I don't love sending cold emails, but I truly believe it's worth 30 seconds of your time.";
const COLD_BODIES = {
  "1": "If you ever prescribed meds for a work comp patient to a retail pharmacy that didn't get filled and caused a setback for the patient, it is not uncommon. 30% of work comp patients have difficulty getting their medication from this traditional method.\n\nA work comp mail order pharmacy can solve that. Patients receive their medication overnight at home, at no cost to them. All you or your staff do is change the pharmacy in the EHR. And many physicians are not aware that in June, the PA Supreme Court ruled the anti-referral law does not apply to prescription drugs, so carriers cannot deny pharmacy payment on that basis (700 Pharmacy, 6/16/26).\n\nFor years, PBMs that have no involvement in patient care have generated the majority of revenue from prescriptions you write. The Work Comp Research Institute (WCRI) estimates prescription spend at $2,262 per work comp claim. You do all of the work, generate those scripts and never see any of that revenue. A mail order pharmacy program like ours gives you a compliant way to improve patient satisfaction and participate in the pharmacy revenue from scripts you already write. For those 2 reasons alone, wouldn't this be worth considering? Reply send and I will email you more about the PA Supreme Court Ruling and our program by MDRx.\n\nIf this is interesting and there's someone else within the practice I should talk to, I would appreciate the guidance.\n\nIf there is a better email to reach you on or if you would like to discuss in person, I would be happy to stop by the office with coffee.",
  "2": "I don't love sending cold emails, but I truly believe it's worth 30 seconds of your time.\n\nMany physicians are not aware that in June, the PA Supreme Court ruled the anti-referral law does not apply to prescription drugs, so carriers cannot deny pharmacy payment on that basis (700 Pharmacy, 6/16/26).\n\nThat matters for a work comp mail order pharmacy program like ours by MDRx. Patients receive their medication overnight at home, at no cost to them. All you or your staff do is change the pharmacy in the EHR. And it gives you a compliant way to participate in the pharmacy revenue from scripts you already write, revenue that has gone to PBMs with no involvement in patient care.\n\nReply send and I will email you more about the ruling and our program.",
  "3": "I don't love sending cold emails, but I truly believe it's worth 30 seconds of your time.\n\nIf you have ever sent a work comp script to a retail pharmacy and it didn't get filled, it is not uncommon. 30% of work comp patients have difficulty getting their medication from retail, and it can cause a setback.\n\nA work comp mail order pharmacy solves that. Patients receive their medication overnight at home, at no cost to them. All you or your staff do is change the pharmacy in the EHR.\n\nOur program by MDRx also gives you a compliant way to participate in the pharmacy revenue from scripts you already write.\n\nReply send and I will email you more about the program, or name a day and I will stop by the office with coffee.",
  "4": "I don't love sending cold emails, but I truly believe it's worth 30 seconds of your time.\n\nFor years, PBMs that have no involvement in patient care have generated the majority of the revenue from prescriptions you write. WCRI estimates prescription spend at $2,262 per work comp claim. You do the work and never see any of it.\n\nOur work comp mail order pharmacy program by MDRx gives you a compliant way to participate in the pharmacy revenue from scripts you already write. Patients receive their medication overnight at home, at no cost to them. All you or your staff do is change the pharmacy in the EHR.\n\nIf this is interesting and there's someone else within the practice I should talk to, I would appreciate the guidance. Or reply send and I will email you more about the program."
};
const COLD_OPTOUT = "If you are not interested or you do not treat work comp patients, simply let me know or reply stop and I will not contact you anymore.";


// Eric, 15 Sep 2026: his mail to a partner landed in junk and the campaign shares his domain, so
// cold touches must look like a letter he typed. This builds the HTML half here rather than letting
// send-outreach do it, because the sender appends a signature block carrying a remote logo image
// whenever the body has no signature of its own. The marker tells it this body already has one.
// No images, no links, no card. Paragraphs and his typed signature, and that is all.
const htmlLetter = (text) => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = String(text).trim().split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const quiet = /(?:are not|aren't) interested|reply stop/i;
  const body = paras.map((p) => {
    const style = quiet.test(p)
      ? 'margin:0 0 12px;font-size:12px;line-height:1.5;color:#8a93a1;'
      : 'margin:0 0 12px;';
    return `<p style="${style}">${esc(p).replace(/\n/g, '<br>')}</p>`;
  }).join('');
  return '<!--signature-inline--><div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
    + `font-size:15px;line-height:1.55;color:#1a2233;max-width:640px;">${body}</div>`;
};

function touchBody(touch, p, hook) {
  const staff = /administrator|manager|coordinator|director|staff|office/i.test(String(p.credentials || ''));
  const to = staff ? `Hi ${p.first_name || ''},`.trim() : `Hi Dr. ${p.last_name || ''},`.trim();
  const lead = (hook || '').trim() ? `${String(hook).trim()}\n\n` : '';
  const sig = '\n\nBest,\n\nEric Weiscarger\nFounder, MDconcierge\nReferral management, work comp pharmacy, ancillary coordination\n(570) 817-7569\neric@mdconcierge.net\nmdconcierge.net';
  const body = COLD_BODIES[touch] || COLD_BODIES[4];
  // The opt-out sits just above "Best,". send-outreach cuts everything from the sign-off down when
  // it builds the HTML half and only rescues a line carrying an unsubscribe link, so a reply-stop
  // line under the signature vanished from the HTML and the wire held the email for having no
  // opt-out. Above the sign-off it survives, and the sender moves it under the signature itself.
  return `${to}\n\n${COLD_OPENER}\n\n${lead}${body}\n\n${COLD_OPTOUT}` + sig;
}

// Short and lowercase. "PA Court Opens Up Significant Revenue Opportunity for Physicians" reads
// as a press release, which is what it was.
const SUBJECTS = {
  1: "work comp scripts that don't get filled",
  2: "Re: work comp scripts that don't get filled",
  3: "Re: work comp scripts that don't get filled",
  4: "Re: work comp scripts that don't get filled",
};

async function run() {
  const cfg = (await sGet('outreach_config?id=eq.1'))[0] || {};
  if (!cfg.warmup_started_at) await sPatch('outreach_config?id=eq.1', { warmup_started_at: today() });
  // Batch size: explicit BATCH_SIZE override (manual first batch), else the daily cap. Eric self-throttles by approving fewer.
  const cap = Number(process.env.BATCH_SIZE) || Number(cfg.daily_send_cap) || 20;

  // Publish the touch templates so the CRM compose box can offer them as a dropdown.
  // The cadence stays the single source of truth; this is a one-way mirror with the merge
  // tokens left in, so the CRM can substitute the doctor it is actually looking at.
  const TOUCH_LABELS = { 1: 'Touch 1 · Eric\'s email', 2: 'Touch 2 · the June ruling', 3: 'Touch 3 · patients and retail pharmacies', 4: 'Touch 4 · PBMs and the right person' };
  for (const n of [1, 2, 3, 4]) {
    const stub = { last_name: '{{last}}', funnel_token: '{{token}}' };
    await sPost('mdrx_templates',
      { touch_no: n, label: TOUCH_LABELS[n], subject: SUBJECTS[n] || '', body_text: touchBody(n, stub), updated_at: new Date().toISOString() },
      'resolution=merge-duplicates,return=minimal');
  }

  // Recycle Not-Now leads whose recycle date arrived.
  const rec = await sGet(`mdrx_providers?select=id,recycle_round&lead_type=eq.funnel&funnel_stage=eq.Not%20Now&recycle_date=lte.${today()}`);
  for (const r of rec) await sPatch(`mdrx_providers?id=eq.${r.id}`, { funnel_stage: 'Queued', touch_count: 0, next_step: 'Touch 1', funnel_next_date: today(), recycle_date: null, recycle_round: (r.recycle_round || 0) + 1 });

  // Already-queued leads (avoid duplicates).
  const openBox = await sGet('mdrx_outbox?select=provider_id&status=eq.pending');
  const queued = new Set((openBox || []).map((x) => x.provider_id));
  // The cap is a ceiling on what is WAITING for approval, not on what this run adds. Without
  // this, a manual trigger on top of the scheduled run would silently double the batch.
  const room = Math.max(0, cap - queued.size);
  if (room === 0) { console.log(`queue builder ${today()}: ${queued.size} already awaiting approval, at the cap of ${cap}. Nothing queued.`); return; }
  const supp = await sGet('suppressions?select=email');
  const suppressed = new Set((supp || []).map((s) => (s.email || '').toLowerCase()));
  // Whole practices Eric has ruled out. Address-level suppression only covers the people already
  // on the list; a domain block also catches the partner who gets added next month.
  const domRows = await sGet('suppressed_domains?select=domain');
  const blockedDomains = new Set((domRows || []).map((d) => String(d.domain || '').toLowerCase()));
  const domainBlocked = (email) => {
    const at = String(email || '').toLowerCase().split('@')[1] || '';
    if (!at) return false;
    // Match the domain and anything under it, so a subdomain cannot slip through.
    return [...blockedDomains].some((d) => at === d || at.endsWith('.' + d));
  };

  // Behavior-aware pool: only Queued/New/Contacted (NOT Engaged/Replied/Not Interested/Unsubscribed/Won/Lost),
  // due today, with an email, not suppressed. Hottest-first is not needed; go by due date.
  const pool = await sGet(`mdrx_providers?select=id,first_name,last_name,credentials,practice_name,funnel_token,email,touch_count,funnel_next_date,recycle_round,personalized_opener,email_confidence&lead_type=eq.funnel&funnel_stage=in.(New,Queued,Contacted)&email=not.is.null&suppressed=eq.false&on_hold=eq.false&or=(manual_touch_at.is.null,manual_touch_at.lt.${manualCutoff()})&or=(funnel_next_date.is.null,funnel_next_date.lte.${today()})&order=funnel_next_date.asc.nullslast&limit=400`);

  // What each of them has ACTUALLY been sent, taken from the outbox rather than from touch_count.
  // On 26 Aug 2026 seventeen providers were sitting at touch_count 0 with cold touches already in
  // their history, six of them queued to receive Touch 1 a second time. Nothing in this repo had
  // reset them: recycle_round was 0, so it was not the recycle path, it was done by hand. A field
  // anything can overwrite is not a safe place to keep the one fact that decides what a physician
  // receives next, so the sent history decides and touch_count is only a fallback.
  const sentTouches = new Map();
  for (const row of await sGet(`mdrx_outbox?select=provider_id,touch_no&status=eq.sent&touch_no=gt.0&limit=5000`)) {
    const id = row.provider_id, n = Number(row.touch_no) || 0;
    if (id && n > (sentTouches.get(id) || 0)) sentTouches.set(id, n);
  }

  // Approved news openers, for A/B-rotating a fresh angle into recycled leads' first touch.
  const openers = await sGet(`mdrx_content_queue?select=id,draft_hook&status=eq.approved&kind=eq.opener&order=id.desc`);
  let openerIdx = 0;
  // Verified addresses go first. Pattern-derived guesses are what hard-bounce, and a bounce on
  // a young sending domain costs far more than the delay. Same pool, safer order.
  const CONF_RANK = (c) => {
    const s = String(c || '').toLowerCase();
    if (/spot_verified|seamless_valid|pattern_confirmed/.test(s)) return 0;
    if (/high_sampled/.test(s)) return 1;
    if (/acceptall|risky/.test(s)) return 3;
    if (/pattern_initials|pattern/.test(s)) return 4;
    return 2;                                   // unknown confidence sits mid-pack
  };
  // Confidence used to lead this sort, and it starved the backlog. A lead with no email_confidence
  // on the record ranks mid-pack and one guessed from an initials pattern ranks last, so David
  // Rubenstein, due 14 Aug with a null confidence, sat behind every verified address in the pool
  // every single morning and was nineteen days late by 2 Sep, with thirty three others fifteen or
  // more days overdue behind him. How long a man has been waiting decides who goes first now.
  // Confidence still breaks ties, so at equal staleness the safer address is still preferred and
  // the bounce protection it was put here for is kept.
  pool.sort((a, b) => String(a.funnel_next_date || '9999-12-31').localeCompare(String(b.funnel_next_date || '9999-12-31'))
    || (CONF_RANK(a.email_confidence) - CONF_RANK(b.email_confidence)));

  let queuedCount = 0; const practicesToday = new Map();
  for (const p of pool) {
    if (queuedCount >= room) break;
    if (queued.has(p.id)) continue;
    if (suppressed.has((p.email || '').toLowerCase())) continue;
    if (domainBlocked(p.email)) continue;
    // Eric, 15 Sep 2026: restart slowly on verified addresses only. Guessed initials and accept-all
    // domains produced an 11.7 percent bounce rate, which is what gets a sender foldered.
    if (!/spot_verified|seamless_valid|pattern_confirmed|high_sampled|hunter_(8[5-9]|9\d|100)/i.test(String(p.email_confidence || ''))) continue;
    const prac = (p.practice_name || '').toLowerCase();
    // Each physician is his own deal, not a seat on a practice contract, so pacing at one per
    // office per run throttled the biggest and best-fit practices to a trickle: Premier's 54
    // physicians would have taken eleven weeks to reach once. Three keeps a same-domain burst
    // small enough to stay clean while the daily cap still governs total volume.
    const pracCount = practicesToday.get(prac) || 0;
    if (prac && pracCount >= 3) continue;
    // Whichever is further along wins. A physician who has had two cold touches gets the third,
    // never the first again, no matter what the record claims about him.
    const alreadySent = sentTouches.get(p.id) || 0;
    const touch = Math.max(Number(p.touch_count) || 0, alreadySent) + 1;
    if (alreadySent > (Number(p.touch_count) || 0)) {
      console.log(`  touch_count repaired from outbox: ${p.email} says ${p.touch_count || 0}, has been sent ${alreadySent}, queueing touch ${touch}`);
      await sPatch(`mdrx_providers?id=eq.${p.id}`, { touch_count: alreadySent });
    }
    if (touch > 4) { await sPatch(`mdrx_providers?id=eq.${p.id}`, { funnel_stage: 'Not Now', next_step: 'Recycle', recycle_date: addDaysISO(90), funnel_next_date: addDaysISO(90) }); continue; }
    // A/B: a recycled lead's first touch leads with a fresh, approved news opener instead of repeating Touch 1.
    // A/B: a recycled lead's first touch LEADS with a fresh, approved news opener. The rest of
    // the designed email is unchanged, so it still carries the sources, buttons, and signature.
    let hook = null, contentId = null;
    if (touch === 1 && (p.recycle_round || 0) > 0 && openers.length) {
      const op = openers[openerIdx % openers.length]; openerIdx++;
      if (op && op.draft_hook) { hook = op.draft_hook; contentId = op.id; }
    }
    // The soft opt-out rides on the plain-text alternative too, so it is there however the
    // mail renders. Clicking it suppresses them and moves them to Unsubscribed, which drops
    // them out of the cadence pool for good.
    await ensureToken(p);
    // touchBody already closes with the soft opt-out and the signature. All that is
    // missing is the real unsubscribe link, so only that is added. Appending the
    // signature again here is what put two of them, and two opt-outs, on every email.
    // Touch five already said it in the body, so its footer is only the link.
    // Eric, 2026-09-02. One line, his words, under the signature, the same on all five. It used to
    // be two wordings and neither matched what the gates were looking for, which is what stopped
    // the cold mail for six days.
    const footer = ''; // the reply-stop opt-out is inside touchBody, above the sign-off
    const bodyText = touchBody(touch, p, hook) + footer;
    await queueEmail({
      _last: p.last_name, provider_id: p.id, touch_no: touch, to_email: p.email,
      subject: SUBJECTS[touch] || SUBJECTS[4], body_text: bodyText,
      objective: ['intro','ruling','access','economics'][touch-1] || 'economics',
      template_key: `cold_${touch}`, channel: 'email',
      // The letter above is the HTML half, with his typed signature inside it, so the sender adds
      // no card and no logo image.
      body_html: htmlLetter(bodyText),
      status: 'pending', scheduled_date: today(), content_id: contentId,
      // Not 'plain': that key makes the sender rebuild the HTML itself and append its logo block.
      template_key: 'cold',
    });
    if (contentId) { const cur = await sGet(`mdrx_content_queue?select=used_count&id=eq.${contentId}`); await sPatch(`mdrx_content_queue?id=eq.${contentId}`, { used_count: ((cur[0] && cur[0].used_count) || 0) + 1 }); }
    if (prac) practicesToday.set(prac, (practicesToday.get(prac) || 0) + 1);
    queued.add(p.id); queuedCount++;
  }
  // Warm and hot run their own tracks into the same outbox, so there is one place to approve from.
  // A tier is just a speed: hot moves in days because he asked for something, warm moves in weeks
  // because he only looked. Neither asks Eric to write anything.
  // ---- News drips --------------------------------------------------------------------------
  // A physician who has had every cold touch and said nothing is not finished. A drip gives him a
  // different reason to look. Eric, 15 Sep 2026: not every news story deserves one. He approves a
  // story, Claude writes a short comment on it, and he approves that email. Only stories with an
  // approved email (email_status = 'approved') ever go out, a physician gets a given story at most
  // once, and under the comment sits DRIP_PITCH, Eric's own pitch, approved word for word. Do not
  // edit DRIP_PITCH or DRIP_OPTOUT without his approval of the exact wording.
  //
  // touch_no is the lead's own touch_count, not 0. send-outreach reads touch_no 0 as a personal
  // one to one note: it would hold the email for carrying an opt-out and append a second
  // signature. Reusing the count the lead already has keeps a drip campaign mail without moving
  // him along the cold sequence.
  const DRIP_PITCH = "If you ever prescribed meds for a work comp patient to a retail pharmacy that didn't get filled and caused a setback for the patient, it is not uncommon. 30% of work comp patients have difficulty getting their medication from this traditional method.\n\nA work comp mail order pharmacy can solve that. Patients receive their medication overnight at home, at no cost to them. All you or your staff do is change the pharmacy in the EHR. And many physicians are not aware that in June, the PA Supreme Court ruled the anti-referral law does not apply to prescription drugs, so carriers cannot deny pharmacy payment on that basis (700 Pharmacy, 6/16/26).\n\nFor years, PBMs that have no involvement in patient care have generated the majority of revenue from prescriptions you write. The Work Comp Research Institute (WCRI) estimates prescription spend at $2,262 per work comp claim. You do all of the work, generate those scripts and never see any of that revenue. A mail order pharmacy program like ours gives you a compliant way to improve patient satisfaction and participate in the pharmacy revenue from scripts you already write. For those 2 reasons alone, wouldn't this be worth considering? Reply send and I will email you more about the PA Supreme Court Ruling and our program by MDRx.\n\nIf there is a better email to reach you on or if you would like to discuss in person, I would be happy to stop by the office with coffee.";
  const DRIP_OPTOUT = "If you are not interested or you do not treat work comp patients, simply let me know or reply stop and I will not contact you anymore.";
  const dripRun = async () => {
    const DRIP_GAP_DAYS = 14;              // never within a fortnight of the last thing he got
    const stories = await sGet("mdrx_content_queue?select=id,email_subject,email_intro,used_count&email_status=eq.approved&email_subject=not.is.null&email_intro=not.is.null&order=used_count.asc,id.asc");
    if (!stories.length) return 0;
    // Which approved stories each physician already has, queued or sent, so nobody gets one twice.
    const already = new Map();
    for (const row of await sGet('mdrx_outbox?select=provider_id,content_id&content_id=not.is.null&status=in.(pending,sent,held)&limit=10000')) {
      if (!already.has(row.provider_id)) already.set(row.provider_id, new Set());
      already.get(row.provider_id).add(Number(row.content_id));
    }

    const pool = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,email,funnel_token,touch_count,last_touch_at,funnel_stage&lead_type=eq.funnel&email=not.is.null&suppressed=eq.false&on_hold=eq.false&or=(manual_touch_at.is.null,manual_touch_at.lt.${manualCutoff()})&touch_count=gte.4&funnel_stage=in.(Contacted,Not Now)&order=last_touch_at.asc`);
    let n = 0;
    for (const p of pool) {
      if (queued.has(p.id)) continue;
      if (suppressed.has((p.email || '').toLowerCase())) continue;
      if (domainBlocked(p.email)) continue;
      const since = p.last_touch_at ? (Date.now() - new Date(p.last_touch_at).getTime()) / 86400000 : 999;
      if (since < DRIP_GAP_DAYS) continue;
      if (n >= 10) break;                  // a drip is a trickle, not a second campaign

      const got = already.get(p.id) || new Set();
      const s = stories.find((x) => !got.has(Number(x.id)));
      if (!s) continue;                    // he has had every approved story; wait for a new one rather than repeat
      const body = `Hi Dr. ${p.last_name || ''},\n\n${String(s.email_intro).trim()}\n\n${DRIP_PITCH}\n\n${DRIP_OPTOUT}\n\nBest,\n${TEXT_SIG}`;

      const ok = await queueEmail({
        _last: p.last_name, provider_id: p.id, touch_no: Number(p.touch_count) || 4, to_email: p.email,
        subject: s.email_subject,
        // Plain text, like the cold touches: the body already carries the signature and the opt-out.
        body_text: body, body_html: null, template_key: 'plain',
        status: 'pending', scheduled_date: today(),
        objective: 'drip', channel: 'email', content_id: s.id,
      });
      if (!ok) continue;
      await sPatch(`mdrx_content_queue?id=eq.${s.id}`, { used_count: (Number(s.used_count) || 0) + 1 });
      s.used_count = (Number(s.used_count) || 0) + 1;
      stories.sort((a, b) => (Number(a.used_count) || 0) - (Number(b.used_count) || 0) || a.id - b.id);
      await sPatch(`mdrx_providers?id=eq.${p.id}`, { funnel_next_date: addDaysISO(DRIP_GAP_DAYS) });
      queued.add(p.id); n++;
    }
    return n;
  };
  const dripCount = await dripRun();

  const hotCount = 0;
  const engCount = 0;

  const daysIn = cfg.warmup_started_at ? Math.floor((Date.now() - new Date(cfg.warmup_started_at).getTime()) / 86400000) + 1 : 1;
  console.log(`queue builder ${today()}: warmup day ${daysIn} cap ${cap}, queued ${queuedCount} cold and ${dripCount} drip(s) for approval, refused ${refused}. Recycled ${rec.length}.`);
}
run().catch((e) => { console.error('Fatal: ' + (e?.stack || e)); process.exit(1); });
