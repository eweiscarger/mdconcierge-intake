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
function engagedHtmlBody(text){
  const NL = String.fromCharCode(10);
  const paras = String(text || '').trim().split(NL + NL);
  return paras.map(function(par){
    const withLinks = esc(par.trim())
      .replace(new RegExp('(https?://\\S+)', 'g'), '<a href="$1" style="color:#2F5EA8;">$1</a>')
      .split(NL).join('<br>');
    return '<p ' + P + '>' + withLinks + '</p>';
  }).join(NL + '        ');
}
function mergeEngaged(n, p){
  return ENGAGED_HTML
    .split('{{body}}').join(engagedHtmlBody(engagedBody(n, p)))
    .split('{{signature}}').join(SIGNATURE_HTML)
    .split('{{last}}').join(p.last_name || '')
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
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row, prefer = 'return=minimal') => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };
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
// ---- Engaged drip -----------------------------------------------------------------------------
// Marketing, not selling. Email is traffic: it educates, shows them what physicians like them are
// doing, and drives one action. The selling happens on the Zoom.
//
// Three rules it is built to:
//   Phone length. Nothing longer than a thumb-scroll, so one idea per email and no scaffolding.
//   Custom to what they actually engaged with. The pillar is chosen by their last click and the
//   peer line by their specialty, so it reads as though it was written for them, which it was.
//   A reason to book that is a deliverable, not a meeting. "Fifteen minutes" is a cost. "You will
//   see your own number on screen" is a thing they receive, and it is the one thing email cannot
//   give them, which is precisely why it earns the call.
//
// Nothing references what they opened or how often. The customisation is silent.

// What a physician in this specialty calls his own kind. Peer proof only works in their language.
const PEER = {
  orthopedics: 'orthopedic groups',
  orthopedic: 'orthopedic groups',
  podiatry: 'foot and ankle practices',
  'foot & ankle': 'foot and ankle practices',
  neurology: 'neurology practices',
  pain: 'pain practices',
  'pain medicine, interventional pain medicine': 'interventional pain practices',
  'interventional spine': 'interventional spine practices',
  'physical medicine & rehabilitation': 'physiatry practices',
  'occupational medicine': 'occupational medicine practices',
  'psychiatry & neurology, neurology': 'neurology practices',
};
const peerPhrase = (s) => PEER[String(s || '').toLowerCase().trim()] || 'practices';

// One pillar per email, chosen by the last thing they clicked. Each is the single most useful next
// fact for someone who just consumed that material, in two sentences or fewer.
const PILLAR = {
  decision: (p) => `The June 16 ruling means a Pennsylvania physician can hold a financial interest in the pharmacy filling his workers' compensation prescriptions. An insurer cannot refuse to pay because of it.`,
  siegel: (p) => `Siegel argued the case, and his read is the practical one: you can refer work comp prescriptions to a pharmacy you have an interest in, and the insurer still has to pay.`,
  gosfield: (p) => `Gosfield's firm in Philadelphia put a favorable opinion in writing. It covers workers' compensation only and leaves imaging, therapy and the rest exactly as they were.`,
  program: (p) => `Nothing changes clinically, and nothing changes for your staff. The pharmacy handles fulfillment, billing and collections. The work comp scripts you already write simply stop leaving the practice.`,
  writeups: (p) => `Nothing changes clinically, and nothing changes for your staff. The pharmacy handles fulfillment, billing and collections. The work comp scripts you already write simply stop leaving the practice.`,
  book: (p) => `You had the calendar open, so I will keep this to one line: fifteen minutes is all it takes to see what this is worth for your own volume.`,
  'request-info': (p) => `You have the overview. The one thing it cannot show you is what this is worth against your own volume and your own formulary.`,
};
const pillarFor = (p) => (PILLAR[String(p.funnel_last_cta || '').toLowerCase()] || PILLAR.decision)(p);

// The reason to take the call, stated as something they receive.
const DELIVERABLE = `On a fifteen minute Zoom I will put your own volume into it and show you the number on screen.`;

function engagedBody(n, p) {
  const dr = `Dr. ${p.last_name || ''}`.trim();
  const t = p.funnel_token || '';
  const peers = peerPhrase(p.specialty);
  const book = link(t, 'book');
  if (n === 1) {
    return `${dr},\n\n${pillarFor(p)}\n\nHundreds of physicians are participating, ${peers} among them.\n\n${DELIVERABLE} Most decide from that one screen.\n\n${book}\n\nBest,`;
  }
  if (n === 2) {
    return `${dr},\n\nThe usual question is how to try this without disrupting anything.\n\nYou don't have to commit the practice. Most start with a modest rollout, one office or a handful of providers, and evaluate from there.\n\nFifteen minutes on Zoom and I'll show you what that looks like against your own numbers.\n\n${book}\n\nOr reply "info" and I'll send the detail instead.\n\nBest,`;
  }
  return `${dr},\n\nLast note from me on this.\n\nIf workers' compensation is a meaningful part of your practice, the fifteen minutes pays for itself: you see your own number and decide from there.\n\n${book}\n\nIf it isn't for you, no reply needed. And if there's someone else I should be speaking to, an introduction would be appreciated.\n\nBest,`;
}

// Subjects are the ad. Short, lower case where it reads more like a person, and specific to the
// one idea inside. No brackets, no emoji, nothing that smells of a campaign.
const ENGAGED_SUBJECT = {
  1: 'What this is worth for your volume',
  2: 'You can start with one office',
  3: 'Closing this out',
};

function touchBody(touch, p, hook) {
  const dr = `Dr. ${p.last_name || ''}`.trim();
  const t = p.funnel_token || '';
  const lead = (hook || '').trim() ? `${String(hook).trim()}\n\n` : '';
  if (touch === 1) {
    // Plain-text alternative. Must mirror email-templates/touch1.html: the ruling material is
    // sourced to the opinion and to Siegel's takeaways; the program claims stay separate.
    return `${dr},\n\n${lead}On June 16, 2026, the Pennsylvania Supreme Court ruled that Pennsylvania's workers' compensation anti-referral law does not apply to prescription drugs. The Court's stated concern was continuity of care, so that injured workers keep receiving medication from a pharmacy that knows their history and treatment plan rather than having that care interrupted. A physician may now refer workers' compensation prescriptions to a pharmacy in which they hold a financial interest, and an insurer cannot refuse to pay because of that interest. The case is 700 Pharmacy v. Bureau of Workers' Compensation Fee Review Hearing Office. If you care for injured workers, it affects how their prescriptions can be handled.\n\nFor years, the revenue generated by workers' compensation prescriptions has gone to parties with no role in treating the patient. The physician actually caring for the injured worker was the one party who could not participate. That is what this decision changes.\n\nDaniel Siegel, who argued the case before the Court, summarized the practical takeaways this way:\n\n- For physicians. They can refer patients to a pharmacy they own or have a financial interest in for prescription drugs, supporting continuity of care.\n- For pharmacies. Pharmacies owned by physicians can seek payment for prescriptions provided to workers' compensation claimants, even if the referring doctor has a financial interest.\n- For insurers. Insurers cannot deny payment for prescription drugs on the grounds of prohibited self-referral under the current law.\n\nIf you'd like to review the legal foundation before we speak, I've included several resources below:\n- Pennsylvania Supreme Court decision: ${link(t, 'decision')}\n- Daniel Siegel's practical analysis for Pennsylvania physicians: ${link(t, 'siegel')}\n- Alice Gosfield's legal analysis: ${link(t, 'gosfield')}\n- Overview of our Workers' Compensation Pharmacy Platform: ${link(t, 'program')}\n\nWe operate a Workers' Compensation Pharmacy Platform for individual physicians or practices that want to participate. For those that do, it means better access to medication for the injured worker, less administrative burden on your staff, and meaningful revenue from the workers' compensation prescriptions you are already writing.\n\nMore about our program: ${link(t, 'program')}\nBook a call: ${link(t, 'book')}\n\nOr simply reply to this email with any questions.\n\nBest,`;
  }
  if (touch === 2) return `${dr},\n\nI sent you a note about the June 16 Pennsylvania Supreme Court decision on workers' compensation prescriptions. The practical question it raises is how a physician participates without dispensing or running a pharmacy, so here is how the model actually works.\n\nAlice Gosfield, a Philadelphia health law attorney, described the structure in her June 2026 analysis:\n\n- The physician, or an entity the physician owns, buys the workers' compensation claim from the provider that supplied the goods.\n- The claim is submitted showing the actual provider who supplied the goods, with the physician's entity as the payee.\n- The selling provider takes a discounted rate and avoids insurance billing. The physician's entity takes the risk of the insurer paying.\n\nThere is a reason the model is built around the claim rather than dispensing. In 2014 the Pennsylvania legislature adopted a provision essentially prohibiting physicians from dispensing drugs to workers' compensation patients. That has not changed. Participation comes through the claim, which is why no one needs to own, staff, or operate a pharmacy.\n\nGosfield is direct about the standing of the model: it is not prohibited in Pennsylvania, although no court has ruled on it either.\n\nThe source material again, for reference:\n- Alice Gosfield, Factoring and Self-Referral: ${link(t, 'gosfield')}\n- Pennsylvania Supreme Court decision (700 Pharmacy): ${link(t, 'decision')}\n- Daniel Siegel's practical analysis: ${link(t, 'siegel')}\n\nIf you'd like to talk it through, reply with a few times that suit you and I'll work around your schedule, or pick a time on my calendar. Questions by email are just as welcome.\n\nMore about our program: ${link(t, 'program')}\nBook a call: ${link(t, 'book')}\n\nBest,`;
  if (touch === 3) return `${dr},\n\nTwo notes ago I sent you the June 16 Pennsylvania Supreme Court decision. The limits matter as much as the opening, so this one covers where it stops.\n\n- The named services are still restricted. Self-referral remains prohibited for laboratory, physical therapy, rehabilitation, chiropractic, radiation oncology, psychometric, home infusion therapy, and diagnostic imaging. If your practice has an interest in any of those, nothing here changes it.\n- It does not reach federal claims. Federal reassignment rules, often called the anti-factoring rules, do not permit this structure. Workers' compensation only.\n- It does not reach laboratory services. The Eliminating Kickbacks in Recovery Act carries its own prohibitions that extend beyond federal payers to private insurance.\n- The legislature could change it. The Court noted that if lawmakers want prescription drugs on the prohibited list, they can add them.\n\nThe decision was 5 to 2. The Court held that the services the statute names are the only ones the prohibition reaches, and that if the legislature had meant to include pharmacy and drugs, it could have said so as it did elsewhere in the same statute.\n\nBoth analyses cover the limits in full:\n- Daniel Siegel's practical analysis: ${link(t, 'siegel')}\n- Alice Gosfield, Factoring and Self-Referral: ${link(t, 'gosfield')}\n- Pennsylvania Supreme Court decision: ${link(t, 'decision')}\n\nIf you'd like to talk it through, reply with a few times that suit you and I'll work around your schedule, or pick a time on my calendar. Questions by email are just as welcome.\n\nMore about our program: ${link(t, 'program')}\nBook a call: ${link(t, 'book')}\n\nBest,`;
  return `${dr},\n\nI'll close the loop here so I'm not crowding your inbox. If workers' compensation isn't a meaningful part of your practice, this simply isn't relevant, and that's a perfectly good answer.\n\nThe materials stay available whenever they're useful:\n- Pennsylvania Supreme Court decision (700 Pharmacy): ${link(t, 'decision')}\n- Daniel Siegel's practical analysis: ${link(t, 'siegel')}\n- Alice Gosfield, Factoring and Self-Referral: ${link(t, 'gosfield')}\n- Overview of our Workers' Compensation Pharmacy Platform: ${link(t, 'program')}\n\nWe work with physicians individually and as groups, so if there is someone else at the practice I should be speaking to, would you kindly make an introduction or pass along their details?\n\nIf your situation changes, or a colleague is looking at this, I'm easy to reach. Reply with a few times that suit you and I'll work around your schedule, or pick a time on my calendar. Either way, I wish you and your patients well.\n\nBook a call: ${link(t, 'book')}\n\nBest,`;
}
const SUBJECTS = {
  1: "PA Court Opens Up Significant Revenue Opportunity for Physicians",
  2: "How physicians participate without running a pharmacy",
  3: "Where the PA ruling stops",
  4: "Closing the loop on the PA pharmacy ruling",
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

  // Behavior-aware pool: only Queued/New/Contacted (NOT Engaged/Replied/Not Interested/Unsubscribed/Won/Lost),
  // due today, with an email, not suppressed. Hottest-first is not needed; go by due date.
  const pool = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,funnel_token,email,touch_count,funnel_next_date,recycle_round,personalized_opener,email_confidence&lead_type=eq.funnel&funnel_stage=in.(New,Queued,Contacted)&email=not.is.null&suppressed=eq.false&or=(funnel_next_date.is.null,funnel_next_date.lte.${today()})&order=funnel_next_date.asc.nullsfirst&limit=400`);

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
    const prac = (p.practice_name || '').toLowerCase();
    // Each physician is his own deal, not a seat on a practice contract, so pacing at one per
    // office per run throttled the biggest and best-fit practices to a trickle: Premier's 54
    // physicians would have taken eleven weeks to reach once. Three keeps a same-domain burst
    // small enough to stay clean while the daily cap still governs total volume.
    const pracCount = practicesToday.get(prac) || 0;
    if (prac && pracCount >= 3) continue;
    const touch = (p.touch_count || 0) + 1;
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
    const bodyText = touchBody(touch, p, hook)
      + `
${TEXT_SIG}

If you aren't interested, or don't wish to hear from me anymore, click here and I won't write again: ${STOP(p.funnel_token || '')}`;
    await sPost('mdrx_outbox', {
      provider_id: p.id, touch_no: touch, to_email: p.email,
      subject: SUBJECTS[touch] || SUBJECTS[4], body_text: bodyText,
      body_html: mergeTouch(touch, p, hook),
      status: 'pending', scheduled_date: today(), content_id: contentId,
    });
    if (contentId) { const cur = await sGet(`mdrx_content_queue?select=used_count&id=eq.${contentId}`); await sPatch(`mdrx_content_queue?id=eq.${contentId}`, { used_count: ((cur[0] && cur[0].used_count) || 0) + 1 }); }
    if (prac) practicesToday.set(prac, (practicesToday.get(prac) || 0) + 1);
    queued.add(p.id); queuedCount++;
  }
  // Engaged leads run their own track, queued into the same outbox so there is one place to
  // approve from. E1 goes the morning after they click, E2 three days later, E3 a week after
  // that. Replying, booking or opting out still takes them out entirely, as before.
  const eng = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,specialty,funnel_token,email,engaged_touch,engaged_at,funnel_next_date,funnel_last_cta&lead_type=eq.funnel&funnel_stage=eq.Engaged&email=not.is.null&suppressed=eq.false&order=engaged_at.asc`);
  let engCount = 0;
  for (const p of eng) {
    if (queued.has(p.id)) continue;
    if (suppressed.has((p.email || '').toLowerCase())) continue;
    const done = p.engaged_touch || 0;
    if (done >= 3) {
      await sPatch(`mdrx_providers?id=eq.${p.id}`, { funnel_stage: 'Not Now', next_step: 'Recycle after engaged track', recycle_date: addDaysISO(90), funnel_next_date: addDaysISO(90) });
      continue;
    }
    // E1 waits three days after the click. Same-day or next-day reads as surveillance to a
    // physician evaluating a compliance-sensitive program, and the click has already done its
    // job by raising them on the Cockpit for a call today if Eric wants one.
    const engagedOn = String(p.engaged_at || '').slice(0, 10);
    const due = done === 0
      ? (engagedOn && addDaysISO(-3) >= engagedOn)
      : !p.funnel_next_date || p.funnel_next_date <= today();
    if (!due) continue;
    const n = done + 1;
    const bodyText = engagedBody(n, p)
      + `
${TEXT_SIG}

If you aren't interested, or don't wish to hear from me anymore, click here and I won't write again: ${STOP(p.funnel_token || '')}`;
    await sPost('mdrx_outbox', {
      provider_id: p.id, touch_no: n, to_email: p.email,
      subject: ENGAGED_SUBJECT[n], body_text: bodyText, body_html: mergeEngaged(n, p),
      status: 'pending', scheduled_date: today(),
    });
    await sPatch(`mdrx_providers?id=eq.${p.id}`, {
      engaged_touch: n,
      funnel_next_date: addDaysISO(n === 1 ? 7 : 14),
      next_step: n === 3 ? 'Engaged track finished, recycle if silent' : `Engaged follow-up ${n + 1}`,
    });
    queued.add(p.id); engCount++;
  }

  const daysIn = cfg.warmup_started_at ? Math.floor((Date.now() - new Date(cfg.warmup_started_at).getTime()) / 86400000) + 1 : 1;
  console.log(`queue builder ${today()}: warmup day ${daysIn} cap ${cap}, queued ${queuedCount} cold touch(es) and ${engCount} engaged follow-up(s) for approval. Recycled ${rec.length}.`);
}
run().catch((e) => { console.error('Fatal: ' + (e?.stack || e)); process.exit(1); });
