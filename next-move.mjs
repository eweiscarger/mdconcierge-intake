// next-move.mjs — smart hot-lead cadence agent.
// For each active Pipeline lead that is due (or newly engaged) and has no pending
// recommendation, it reads the lead's real behavior (opens, clicks, tool views,
// replies, last touch, stage) and asks Claude to decide the single best NEXT MOVE:
// the channel, the angle, the DATE to do it, and a drafted message. It queues that
// in mdrx_next_moves for Eric to approve. It SENDS NOTHING (auto-send is gated on the
// deliverability unlock). Runs on a schedule via GitHub Actions.
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}
const PER_RUN = Number(process.env.NEXTMOVE_PER_RUN || 10);
const today = new Date().toISOString().slice(0, 10);

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`); };

const SYSTEM = `You are the follow-up strategist for Eric Weiscarger's MDRx Workers' Compensation Pharmacy Program. Eric partners with the MDRx360 team to bring physicians into a pharmacy dispensing program. You decide the SINGLE best next move for one lead based on their actual behavior, so Eric never has to think about follow-up timing or wording.

Given the lead's behavior, return STRICT JSON only:
{"recommended_date":"YYYY-MM-DD","channel":"email|call|text","angle":"short label of the approach","reason":"one line: why this move, why now, from their behavior","draft":"the message to send (for email/text) or 2-3 call talking points (for call)"}

Timing logic (today is ${today}):
- Just engaged / opened the tool / clicked in the last day or two: move fast, 1-2 days out.
- Opened but went quiet: 3-5 days out, gentle nudge or a new angle.
- Booked a meeting: pre-call nurture a day or two before.
- Sent the Executive Brief (brief_sent_at is set) but has NOT requested a meeting (meeting_requested_at is null) after about 3 or more days: a short, warm nudge that re-offers the 15-minute call and points back to the brief. Do not resend the brief, just prompt the next step.
- Cold for a while: longer gap and a genuinely different angle, do not repeat the last touch.
Pick a real date on or after ${today}.

SCHEDULING (email and text drafts): asking a physician to send times, with no way to just book, is a run-around. Whenever the move involves talking, give BOTH options in the same breath: invite them to reply with times that suit them AND paste the lead's booking_link from the context so they can drop straight onto Eric's calendar. Never ask for times without including that link. If booking_link is null, ask for times only. Phrase it as an either/or, for example: "Reply with a few times that suit you and I'll work around your schedule, or grab a slot directly here: <booking_link>".

ADDRESSING: The lead is a physician. ALWAYS address them as "Dr. [last name]" in the greeting (e.g., "Hi Dr. Rao,"), NEVER by first name. Only office staff, practice managers, and champions are addressed by first name, and those are not the lead here.

Draft voice: brief, human, never templated or salesy. NO em dashes or en dashes (use commas or periods). Never mention commission or tie economics to prescribing. Never invent facts, numbers, names, or legal conclusions. Name it in full: "MDRx Workers' Compensation Pharmacy Program". Keep the body short.

For emails and texts, always close with EXACTLY this signature, each part on its own line (for a call, skip the signature and give talking points instead):
Best,
Eric Weiscarger
Founder, MDconcierge
Referral Management • Work Comp Pharmacy • Ancillary Coordination
(570) 817-7569 • eric@mdconcierge.net • mdconcierge.net`;

async function decide(ctx) {
  try {
    const m = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 1600, system: SYSTEM,
      messages: [{ role: 'user', content: 'Plan the next move for this lead:\n\n' + JSON.stringify(ctx) }],
    });
    let raw = ((m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s < 0 || e < 0) { console.error('no json: ' + raw.slice(0, 120)); return null; }
    const o = JSON.parse(raw.slice(s, e + 1));
    if (!o.draft || !o.recommended_date) return null;
    if (o.recommended_date < today) o.recommended_date = today;
    return o;
  } catch (e) { console.error('decide failed: ' + e.message); return null; }
}

// ---- Deliver the recommendation into the one approval queue ------------------------------------
// A recommendation Eric has to go and find is a recommendation he does not action. On the day it
// comes due, the drafted email is rendered into the same card every other email uses and dropped
// into mdrx_outbox alongside the cold touches, so there is one screen to review and approve.
// Nothing sends. The subject follows COPY-RULES: Touch 1's subject unless Eric names another.
const SUBJECT = 'PA Court Opens Up Significant Revenue Opportunity for Physicians';
const ENGAGED_HTML = readFileSync(new URL('./email-templates/engaged.html', import.meta.url), 'utf8');
const SIGNATURE_HTML = readFileSync(new URL('./email-templates/signature.html', import.meta.url), 'utf8');
const SITE = 'https://mdconcierge.net';
const escHtml = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const PSTYLE = 'style="font-size:14px;line-height:1.6;color:#33404f;margin:0 0 14px;"';

function draftToCard(draft, p) {
  const NL = String.fromCharCode(10);
  const body = String(draft || '').trim().replace(/(\r?\n)+Best,?\s*$/, '');
  const paras = body.split(NL + NL).map((par) => {
    const line = par.trim();
    if (/^https?:\/\/\S+$/.test(line)) {
      return '<p style="margin:22px 0;"><a href="' + line + '" style="background:#08214C;color:#ffffff;'
        + 'text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:9px;'
        + 'display:inline-block;">See my calendar</a></p>';
    }
    return '<p ' + PSTYLE + '>' + escHtml(line)
      .replace(new RegExp('(https?://\\S+)', 'g'), '<a href="$1" style="color:#2F5EA8;">$1</a>')
      .split(NL).join('<br>') + '</p>';
  }).join(NL + '        ');
  const tok = p.funnel_token || '';
  return ENGAGED_HTML
    .split('{{body}}').join(paras)
    .split('{{signature}}').join(SIGNATURE_HTML)
    .split('{{last}}').join(p.last_name || '')
    .split('{{token}}').join(tok)
    .split('{{optout}}').join('If you aren\'t interested, or don\'t wish to hear from me anymore, <a href="'
      + SITE + '/unsubscribe.html?p=' + tok + '" style="color:#9aa3af;">click here</a> and I won\'t write again.');
}

async function promoteDueMoves() {
  const due = await sGet(`mdrx_next_moves?select=id,provider_id,recommended_date,channel,angle,draft&status=eq.pending&recommended_date=lte.${today}&order=recommended_date.asc`);
  if (!due || !due.length) return 0;
  // One pending email per physician. Two in the queue for the same doctor is how he gets two.
  const open = await sGet('mdrx_outbox?select=provider_id&status=eq.pending');
  const already = new Set((open || []).map((x) => x.provider_id));
  let n = 0;
  for (const mv of due) {
    if (String(mv.channel || 'email') !== 'email') continue;   // calls stay recommendations
    if (already.has(mv.provider_id)) continue;
    const [p] = await sGet(`mdrx_providers?select=id,last_name,email,funnel_token,suppressed&id=eq.${mv.provider_id}`);
    if (!p || !p.email || p.suppressed) continue;
    const text = String(mv.draft || '').trim();
    if (!text) continue;
    await sPost('mdrx_outbox', {
      provider_id: p.id, touch_no: 0, to_email: p.email, subject: SUBJECT,
      body_text: text, body_html: draftToCard(text, p),
      status: 'pending', scheduled_date: today,
      objective: mv.angle || null, template_key: 'next_move', channel: 'email',
    });
    await sPatch(`mdrx_next_moves?id=eq.${mv.id}`, { status: 'queued', resolved_at: new Date().toISOString() });
    already.add(p.id);
    n++;
  }
  return n;
}

async function main() {
  // Anything already recommended and now due goes into the approval queue first.
  const promoted = await promoteDueMoves();
  if (promoted) console.log(`next-move: promoted ${promoted} due recommendation(s) into the approval queue.`);

  // Active pipeline leads worth a move: in Pipeline, not won/lost, due or freshly flagged.
  const P = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,specialty,funnel_stage,funnel_score,intent_tier,funnel_last_cta,funnel_open_count,funnel_clicked,funnel_booked,behavior_flag,touch_count,last_touch_at,next_step,funnel_next_date,engaged_at,email,brief_sent_at,meeting_requested_at,funnel_token&contact_home=eq.Pipeline&funnel_stage=not.in.(Won,Lost)`);
  const openMoves = await sGet('mdrx_next_moves?select=provider_id&status=eq.pending');
  const pending = new Set((openMoves || []).map((x) => x.provider_id));

  // Prioritize: due today/overdue, or flagged for attention, or no next date set. Hottest first.
  const candidates = (P || [])
    .filter((p) => !pending.has(p.id))
    .filter((p) => !p.funnel_next_date || p.funnel_next_date <= today || p.behavior_flag)
    .sort((a, b) => (Number(b.funnel_score) || 0) - (Number(a.funnel_score) || 0))
    .slice(0, PER_RUN);

  let queued = 0;
  for (const p of candidates) {
    const [events, replies, quotes, acts] = await Promise.all([
      sGet(`mdrx_funnel_events?select=event,page,link,cta,scroll,seconds,created_at&provider_id=eq.${p.id}&order=created_at.desc&limit=15`),
      sGet(`mdrx_inbox_drafts?select=subject,snippet,sentiment,received_at&provider_id=eq.${p.id}&order=received_at.desc&limit=5`),
      sGet(`quote_links?select=view_count,first_viewed_at,last_viewed_at&provider_id=eq.${p.id}`),
      sGet(`mdrx_activity?select=type,subject,notes,occurred_at&provider_id=eq.${p.id}&order=occurred_at.desc&limit=5`),
    ]);
    const ctx = {
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), last_name: p.last_name, address_as: `Dr. ${p.last_name || ''}`.trim(), practice: p.practice_name, specialty: p.specialty,
      stage: p.funnel_stage, score: p.funnel_score, tier: p.intent_tier, behavior_flag: p.behavior_flag,
      last_cta: p.funnel_last_cta, opens: p.funnel_open_count, clicked: p.funnel_clicked, booked: p.funnel_booked,
      touches_so_far: p.touch_count, last_touch_at: p.last_touch_at, current_next_step: p.next_step,
      engaged_at: p.engaged_at, has_email: !!p.email,
      // Eric's tracked booking link for THIS lead. Any draft that offers a call must carry it.
      booking_link: p.funnel_token ? `https://mdconcierge.net/go.html?p=${p.funnel_token}&to=book` : null,
      brief_sent_at: p.brief_sent_at, meeting_requested_at: p.meeting_requested_at,
      engagement_events: (events || []).map((e) => ({ event: e.event, page: e.page, link: e.link, cta: e.cta, when: e.created_at })),
      their_replies: (replies || []).map((r) => ({ said: r.snippet, sentiment: r.sentiment, when: r.received_at })),
      tool_views: (quotes || []).map((q) => ({ views: q.view_count, first: q.first_viewed_at, last: q.last_viewed_at })),
      logged_touches: acts || [],
    };
    const mv = await decide(ctx);
    if (!mv) continue;
    await sPost('mdrx_next_moves', { provider_id: p.id, recommended_date: mv.recommended_date, channel: mv.channel || 'email', angle: mv.angle || null, reason: mv.reason || null, draft: mv.draft, status: 'pending' });
    // reflect the recommendation on the record so nothing sits with no plan
    await sPatch(`mdrx_providers?id=eq.${p.id}`, { next_step: mv.angle || p.next_step, funnel_next_date: mv.recommended_date });
    queued++;
  }
  console.log(`next-move: considered ${candidates.length}, queued ${queued} recommendation(s).`);
  await ensureEveryLeadHasAPlan();
}

// No lead should ever sit with a blank next step. The AI writes the plan for hot leads above;
// this fills in everyone else deterministically, so a rep opening any record sees what happens
// next and when, without having to decide or record anything.
const TERMINAL = ['Won', 'Lost', 'Not Interested', 'Unsubscribed'];
const PLAN_BY_STAGE = {
  New:              { step: 'Touch 1: the ruling',            days: 0 },
  Queued:           { step: 'Touch 1: the ruling',            days: 0 },
  Contacted:        { step: 'Next cadence touch',             days: 3 },
  Engaged:          { step: 'Personal follow-up, they clicked', days: 1 },
  Replied:          { step: 'Answer their reply',             days: 0 },
  'Materials Sent': { step: 'Check they read the materials',  days: 3 },
  'Meeting Requested': { step: 'Confirm the meeting time',    days: 0 },
  'Meeting Booked': { step: 'Pre-call brief and prep',        days: 1 },
  Met:              { step: 'Send recap and next step',       days: 1 },
  'Follow-up':      { step: 'Follow up on the open question', days: 2 },
  Closing:          { step: 'Chase the agreement',            days: 2 },
  'Not Now':        { step: 'Recycle when the window opens',  days: 90 },
};
async function ensureEveryLeadHasAPlan() {
  const dateIn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const blanks = await sGet(`mdrx_providers?select=id,funnel_stage,next_step,funnel_next_date,suppressed&suppressed=eq.false&funnel_stage=not.in.(${TERMINAL.map(encodeURIComponent).join(',')})&or=(next_step.is.null,funnel_next_date.is.null)&limit=1000`);
  let filled = 0;
  for (const p of blanks || []) {
    const plan = PLAN_BY_STAGE[p.funnel_stage] || { step: 'Review and decide the next move', days: 1 };
    await sPatch(`mdrx_providers?id=eq.${p.id}`, {
      next_step: p.next_step || plan.step,
      funnel_next_date: p.funnel_next_date || dateIn(plan.days),
    });
    filled++;
  }
  console.log(`next-move: filled a plan for ${filled} lead(s) that had none.`);
}

async function alertFailure(job, msg) {
  try {
    const rows = await sGet(`job_alerts?select=last_alert_at&job=eq.${job}`);
    const last = rows[0]?.last_alert_at ? new Date(rows[0].last_alert_at).getTime() : 0;
    if (Date.now() - last < 3 * 3600 * 1000) return;
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: `[MDconcierge] the ${job} job hit a problem`, text: msg });
    await fetch(`${SUPABASE_URL}/rest/v1/job_alerts`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ job, last_alert_at: new Date().toISOString(), last_msg: msg.slice(0, 300) }) });
  } catch (e) { console.error('alertFailure error: ' + e.message); }
}

main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/timeout|econnreset|econnrefused|enotfound|socket|network|fetch failed|overloaded|529|503/i.test(msg)) { console.warn('transient, skipping run: ' + msg); process.exit(0); }
  console.error('next-move fatal: ' + (e?.stack || e));
  await alertFailure('next-move', msg);
  process.exit(0);
});
