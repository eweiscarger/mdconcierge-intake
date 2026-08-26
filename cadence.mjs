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
    .split('{{optout}}').join('If you aren\'t interested, or don\'t wish to hear from me anymore, <a href="' + STOP(p.funnel_token || '') + '" style="color:#9aa3af;">click here</a> and I won\'t write again.')
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

function touchBody(touch, p, hook) {
  const t = p.funnel_token || '';
  const staff = /administrator|manager|coordinator|director|staff|office/i.test(String(p.credentials || ''));
  const to = staff ? `${p.first_name || ''},`.trim() : `Dr. ${p.last_name || ''},`.trim();
  const lead = (hook || '').trim() ? `${String(hook).trim()}\n\n` : '';
  const optout = "\n\nIf you aren't interested, just reply and say so and I won't write again.";
  // A letter that ends on a bare name and a phone number reads like a note passed in a corridor.
  // The text half carries the same details the signature block shows, typed out.
  const sig = "\n\nBest,\n\nEric Weiscarger\nFounder, MDconcierge\nReferral Management • Work Comp Pharmacy • Ancillary Coordination\n(570) 817-7569 • eric@mdconcierge.net • mdconcierge.net";

  if (touch === 1) {
    return `${to}\n\n${lead}On June 16 the Pennsylvania Supreme Court decided a case called 700 Pharmacy. If you treat injured workers it is worth two minutes.\n\nDaniel Siegel argued the case and won it. His own summary puts it in three lines.\n\nA physician can refer patients to a pharmacy he owns, or has a financial interest in, for prescription drugs, supporting continuity of care.\n\nA pharmacy owned by physicians can be paid for prescriptions provided to workers' compensation claimants, even where the referring doctor has a financial interest.\n\nAn insurer cannot deny payment for prescription drugs on the grounds of prohibited self referral under the current law.\n\nThat is the whole decision. You can read [his write-up here](https://mdconcierge.net/go.html?p=${t}&to=siegel).\n\n${PROGRAM()}

${HOSPITAL()}\n\n${OVERVIEW(t)}\n\nWhere do your work comp scripts go now?` + optout + sig;
  }
  if (touch === 2) {
    return `${to}

I wrote to you earlier about the 700 Pharmacy decision. The part that matters practically is what it did to the insurers, so here it is.

Before, a carrier could refuse to pay for a work comp prescription by pointing at the anti-referral statute. That argument is gone. The Court held the statute does not reach prescription drugs, so payment cannot be denied on those grounds.

${PROGRAM()}

Alice Gosfield's June newsletter puts factoring, where the physician's entity buys the claim from the provider and submits it on its own number, as not prohibited in Pennsylvania and worth considering. She adds that no court has ruled on it either way. You can read it here: [Factoring and Self-Referral](https://mdconcierge.net/go.html?p=${t}&to=gosfield).

If you would rather not take my word for it, read [the 700 Pharmacy decision, Pennsylvania Supreme Court](https://mdconcierge.net/decision.html?p=${t}).

${OVERVIEW(t)}` + optout + sig;
  }
  if (touch === 3) {
    return `${to}\n\nTwo notes ago I sent you the June ruling on work comp prescriptions. This one covers how work comp pharmacy is actually reimbursed in Pennsylvania, since that is what determines whether any of it is worth a practice's attention.\n\nPennsylvania reimburses work comp pharmacy at average wholesale price plus ten percent. That is set by the state fee schedule, not negotiated, and it is materially better than what commercial plans pay.\n\nIt is entirely mail order. There are no denials while the claim is open, nothing is stocked in your office, and your staff handles none of it.\n\n${PROGRAM()}

${OVERVIEW(t)}\n\nWhat it comes to for any given practice depends on how much work comp you actually see.` + optout + sig;
  }
  return `${to}

Last note from me, and I would rather tell you where this does not reach than let you find it later.

It is workers compensation only. Not Medicare, not Medicaid, not any federal program, and not laboratory work, where a different federal statute applies. If work comp is not a real part of your practice, none of this was ever relevant and that is a perfectly good answer.

Where it is relevant, here is what it looks like. Nothing is stocked in your office. Pennsylvania pays work comp pharmacy at average wholesale price plus ten percent, set by the state fee schedule rather than negotiated with a carrier.

${PROGRAM()}

${PATIENTS_ONLY()}

${OVERVIEW(t)}

${routingAsk(p).trim()}` + optout + sig;
}
// Short and lowercase. "PA Court Opens Up Significant Revenue Opportunity for Physicians" reads
// as a press release, which is what it was.
const SUBJECTS = {
  1: "PA Court OKs Rx Revenue for Work Comp",
  2: "What the PA Court Actually Held",
  3: "Where Compliant Work Comp Revenue Comes From",
  4: "where this does not apply",
};

async function run() {
  const cfg = (await sGet('outreach_config?id=eq.1'))[0] || {};
  if (!cfg.warmup_started_at) await sPatch('outreach_config?id=eq.1', { warmup_started_at: today() });
  // Batch size: explicit BATCH_SIZE override (manual first batch), else the daily cap. Eric self-throttles by approving fewer.
  const cap = Number(process.env.BATCH_SIZE) || Number(cfg.daily_send_cap) || 20;

  // Publish the touch templates so the CRM compose box can offer them as a dropdown.
  // The cadence stays the single source of truth; this is a one-way mirror with the merge
  // tokens left in, so the CRM can substitute the doctor it is actually looking at.
  const TOUCH_LABELS = { 1: 'Touch 1 · the ruling', 2: 'Touch 2 · how the model works', 3: 'Touch 3 · where the ruling stops', 4: 'Touch 4 · closing the loop' };
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
  const pool = await sGet(`mdrx_providers?select=id,first_name,last_name,credentials,practice_name,funnel_token,email,touch_count,funnel_next_date,recycle_round,personalized_opener,email_confidence&lead_type=eq.funnel&funnel_stage=in.(New,Queued,Contacted)&email=not.is.null&suppressed=eq.false&on_hold=eq.false&or=(manual_touch_at.is.null,manual_touch_at.lt.${manualCutoff()})&or=(funnel_next_date.is.null,funnel_next_date.lte.${today()})&order=funnel_next_date.asc.nullsfirst&limit=400`);

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
  pool.sort((a, b) => (CONF_RANK(a.email_confidence) - CONF_RANK(b.email_confidence))
    || String(a.funnel_next_date || '').localeCompare(String(b.funnel_next_date || '')));

  let queuedCount = 0; const practicesToday = new Map();
  for (const p of pool) {
    if (queuedCount >= room) break;
    if (queued.has(p.id)) continue;
    if (suppressed.has((p.email || '').toLowerCase())) continue;
    if (domainBlocked(p.email)) continue;
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
    const bodyText = touchBody(touch, p, hook)
      + `
${TEXT_SIG}

If you aren't interested, or don't wish to hear from me anymore, click here and I won't write again: ${STOP(p.funnel_token || '')}`;
    await queueEmail({
      _last: p.last_name, provider_id: p.id, touch_no: touch, to_email: p.email,
      subject: SUBJECTS[touch] || SUBJECTS[4], body_text: bodyText,
      objective: ['education','consequence','risk_reduction','breakup'][touch-1] || 'breakup',
      template_key: `cold_${touch}`, channel: 'email',
      // No HTML part. The designed card is what was being filtered.
      body_html: null,
      status: 'pending', scheduled_date: today(), content_id: contentId,
      // plain: the sender omits the HTML part entirely for this key.
      template_key: 'plain',
    });
    if (contentId) { const cur = await sGet(`mdrx_content_queue?select=used_count&id=eq.${contentId}`); await sPatch(`mdrx_content_queue?id=eq.${contentId}`, { used_count: ((cur[0] && cur[0].used_count) || 0) + 1 }); }
    if (prac) practicesToday.set(prac, (practicesToday.get(prac) || 0) + 1);
    queued.add(p.id); queuedCount++;
  }
  // Warm and hot run their own tracks into the same outbox, so there is one place to approve from.
  // A tier is just a speed: hot moves in days because he asked for something, warm moves in weeks
  // because he only looked. Neither asks Eric to write anything.
  // ---- News drips --------------------------------------------------------------------------
  // A physician who has had all four touches and said nothing is not finished, he is just not
  // interested in the ruling as an opening. A drip gives him a different reason to look: one
  // approved news opener, then the same single ask. Touch 1 keeps the ruling; this is what comes
  // after the sequence, not instead of it.
  //
  // Openers come from mdrx_content_queue, approved by Eric, and rotate by least-used so a theme
  // is not repeated to the same list. Engagement is already tracked per opener, so over time the
  // themes that earn replies rise on their own.
  const dripRun = async () => {
    const DRIP_GAP_DAYS = 14;              // never within a fortnight of the last thing he got
    const openers = await sGet("mdrx_content_queue?select=id,headline,draft_hook,used_count&status=eq.approved&kind=eq.opener&order=used_count.asc,id.asc");
    if (!openers.length) return 0;

    const pool = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,email,funnel_token,touch_count,last_touch_at,funnel_stage&lead_type=eq.funnel&email=not.is.null&suppressed=eq.false&on_hold=eq.false&or=(manual_touch_at.is.null,manual_touch_at.lt.${manualCutoff()})&touch_count=gte.4&funnel_stage=in.(Contacted,Not Now)&order=last_touch_at.asc`);
    let n = 0, oi = 0;
    for (const p of pool) {
      if (queued.has(p.id)) continue;
      if (suppressed.has((p.email || '').toLowerCase())) continue;
      if (domainBlocked(p.email)) continue;
      const since = p.last_touch_at ? (Date.now() - new Date(p.last_touch_at).getTime()) / 86400000 : 999;
      if (since < DRIP_GAP_DAYS) continue;
      if (n >= 10) break;                  // a drip is a trickle, not a second campaign

      const o = openers[oi % openers.length]; oi++;
      await ensureToken(p);
      const t = p.funnel_token;
      const dr = `Dr. ${p.last_name || ''}`.trim();
      const body = `${dr},\n\n${String(o.draft_hook || '').trim()}\n\n`
        + `You can participate individually or through the practice, whichever suits.\n\n`
        + `If you would like someone to reach out directly, tell us the best way to reach you here: ${link(t, 'talk')}\n\n`
        + `Or if you would rather pick a time yourself, see my calendar: ${link(t, 'book')}\n\n`
        + `Best,\n${TEXT_SIG}\n\nIf you aren't interested, or don't wish to hear from me anymore, click here and I won't write again: ${STOP(t)}`;

      await queueEmail({
        _last: p.last_name, provider_id: p.id, touch_no: 0, to_email: p.email,
        subject: o.headline || SUBJECTS[1],
        // Plain text here too. A recycled lead is a cold lead who has already ignored four
        // designed emails, so sending a fifth in the same format is the definition of doing the
        // same thing again.
        body_text: body, body_html: null, template_key: 'plain',
        status: 'pending', scheduled_date: today(),
        objective: 'drip', template_key: 'drip', channel: 'email', content_id: o.id,
      });
      await sPatch(`mdrx_content_queue?id=eq.${o.id}`, { used_count: (Number(o.used_count) || 0) + 1 });
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
