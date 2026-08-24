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
import { emailFaults, linkLabel, optOutLine } from './check.mjs';

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}
const PER_RUN = Number(process.env.NEXTMOVE_PER_RUN || 10);
// Matches sent-scan.mjs: a lead Eric answered himself is left alone for this long.
const MANUAL_PAUSE_DAYS = Number(process.env.MANUAL_PAUSE_DAYS || 10);
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
- Sent the Executive Brief (brief_sent_at is set) but has NOT requested a meeting (meeting_requested_at is null) after 2 days: follow up. The brief email promised "I will follow up in a day or two", so this is keeping a promise, not chasing. Short, warm, do not resend the brief. Two physicians asked for the brief and then heard nothing for a week, which is the failure this rule exists to prevent.
- Cold for a while: longer gap and a genuinely different angle, do not repeat the last touch.
Pick a real date on or after ${today}.

CHANNEL: email, unless the lead's record actually holds a cell number. Eric cannot call a physician he has no number for, and the office line reaches a receptionist. Never recommend "call him" for a lead whose only number is the practice switchboard.

SCHEDULING, for leads who have NOT yet started a conversation: the calendar has produced zero bookings from over a hundred emails, so it is the alternative, never the ask. Whenever the move involves talking, lead with the lead's talk_link, which is a short form where he gives a better email, a cell, how he prefers to be contacted and when. Offer booking_link second, as "or pick a time on my calendar". Never ask him to reply with times as the only route. If talk_link is null, ask for a better number and time in the body.

STAGE, absolute. If stage is Engaged or Closing, this lead is already in conversation with us, or his practice is. Use NEITHER talk_link NOR booking_link. Asking a man whose practice manager has been on a call with us to fill in a form saying how to reach him, or to book a first call, throws the relationship away and reads as though nobody here remembers who he is. For those leads the move is the next real step: answer what was actually asked, send what was actually requested, confirm what was already discussed. If you truly need time with him, propose it in the body against what was last discussed, with no link.

THEIR REPLIES come first. their_replies holds what this lead and his practice actually wrote to us, and the practice manager or PA writing on his behalf IS this lead replying. Read them before anything else and write to what they said. Never draft a message that ignores an open question they put to us.

COPY RULES, absolute: no em dashes or en dashes anywhere. American spelling. Never reveal that opens, clicks or reading are tracked: no "I saw you", no "you had a chance to look", no reference to anything he read or clicked. Never mention in-office dispensing. Never offer to estimate his opportunity from his own volume. Never invent a number, a name or a legal conclusion.

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
      // Every such button said "See my calendar", including the ones that went to the talk form.
      return '<p style="margin:22px 0;"><a href="' + line + '" style="background:#08214C;color:#ffffff;'
        + 'text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:9px;'
        + 'display:inline-block;">' + linkLabel(line) + '</a></p>';
    }
    return '<p ' + PSTYLE + '>' + escHtml(line)
      .replace(new RegExp('(https?://\\S+)', 'g'), (u) => '<a href="' + u + '" style="color:#2F5EA8;font-weight:600;">' + linkLabel(u) + '</a>')
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
  const due = await sGet(`mdrx_next_moves?select=id,provider_id,recommended_date,channel,angle,reason,draft&status=eq.pending&recommended_date=lte.${today}&order=recommended_date.asc`);
  if (!due || !due.length) return 0;
  // One pending email per physician. Two in the queue for the same doctor is how he gets two.
  const open = await sGet('mdrx_outbox?select=provider_id&status=eq.pending');
  const already = new Set((open || []).map((x) => x.provider_id));
  let n = 0;
  for (const mv of due) {
    if (String(mv.channel || 'email') !== 'email') continue;   // calls stay recommendations
    if (already.has(mv.provider_id)) continue;
    const [p] = await sGet(`mdrx_providers?select=id,last_name,email,funnel_token,funnel_stage,suppressed,on_hold&id=eq.${mv.provider_id}`);
    // A recommendation made last week must not go out to a lead Eric has since pulled off
    // automation. The hold is checked at the moment of queueing, not only at the moment of drafting.
    if (!p || !p.email || p.suppressed || p.on_hold) continue;
    const draft = String(mv.draft || '').trim();
    if (!draft) continue;
    // The card injected the opt-out and the plain text did not, so every drafted follow-up failed
    // the gate on arrival and sat in the queue as held. Both halves carry it, same wording.
    const text = draft + '\n\n' + optOutLine(`${SITE}/unsubscribe.html?p=${p.funnel_token || ''}`);
    const html = draftToCard(draft, p);
    // A draft is written by a model, so it is exactly the thing that has to be checked before it
    // reaches Eric's queue. The recommendation stays pending and says why, rather than queueing
    // something he then has to notice is wrong.
    const faults = emailFaults({ html, text, lastName: p.last_name, toEmail: p.email, stage: p.funnel_stage });
    if (faults.length) {
      console.error(`next-move: refused to queue move ${mv.id} for ${p.email}: ${faults.join(', ')}`);
      await sPatch(`mdrx_next_moves?id=eq.${mv.id}`, {
        status: 'refused',
        reason: [mv.reason, 'refused: ' + faults.join(', ')].filter(Boolean).join(' | '),
        resolved_at: new Date().toISOString(),
      });
      continue;
    }
    await sPost('mdrx_outbox', {
      provider_id: p.id, touch_no: 0, to_email: p.email, subject: SUBJECT,
      body_text: text, body_html: html,
      status: 'pending', scheduled_date: today,
      objective: mv.angle || null, template_key: 'next_move', channel: 'email',
    });
    await sPatch(`mdrx_next_moves?id=eq.${mv.id}`, { status: 'queued', resolved_at: new Date().toISOString() });
    already.add(p.id);
    n++;
  }
  return n;
}

// A physician's practice answers on his behalf. Nine replies from the Hatgis practice, his manager
// and his PA, were on file and none of them were attached to his record, so the agent read him as
// silent and drafted a first-contact nudge to a lead who was mid-conversation. A reply from the
// practice domain is a reply from the lead. Free mail cannot be matched this way, several leads
// share gmail.com, and our own domains are us talking to ourselves.
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com', 'live.com', 'msn.com', 'comcast.net', 'verizon.net']);
const OUR_DOMAINS = new Set(['mdconcierge.net', 'mdrx360.com']);
function practiceDomain(email) {
  const d = String(email || '').split('@')[1];
  if (!d) return null;
  const dom = d.toLowerCase().trim();
  return (FREE_MAIL.has(dom) || OUR_DOMAINS.has(dom)) ? null : dom;
}

async function main() {
  // Anything already recommended and now due goes into the approval queue first.
  const promoted = await promoteDueMoves();
  if (promoted) console.log(`next-move: promoted ${promoted} due recommendation(s) into the approval queue.`);

  // Active pipeline leads worth a move: in Pipeline, not won/lost, due or freshly flagged.
  // on_hold means Eric took this lead off automation by hand. It was not checked here, so a lead
  // he had already pulled out kept getting drafted for, three times in a week.
  const P = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,specialty,funnel_stage,funnel_score,intent_tier,funnel_last_cta,funnel_open_count,funnel_clicked,funnel_booked,behavior_flag,touch_count,last_touch_at,next_step,funnel_next_date,engaged_at,email,cell,brief_sent_at,meeting_requested_at,manual_touch_at,funnel_token&contact_home=eq.Pipeline&funnel_stage=not.in.(Won,Lost)&on_hold=eq.false&suppressed=eq.false`);
  const openMoves = await sGet('mdrx_next_moves?select=provider_id&status=eq.pending');
  const pending = new Set((openMoves || []).map((x) => x.provider_id));

  // Prioritize: due today/overdue, or flagged for attention, or no next date set. Hottest first.
  // A lead Eric wrote to by hand is his conversation for the next ten days. behavior_flag is
  // deliberately not an override here: the flag is exactly what a hot lead carries, so letting it
  // through would put the machine on top of the very conversations that matter most.
  const pauseCutoff = new Date(Date.now() - MANUAL_PAUSE_DAYS * 86400000);
  const candidates = (P || [])
    .filter((p) => !pending.has(p.id))
    .filter((p) => {
      if (!p.manual_touch_at) return true;
      if (new Date(p.manual_touch_at) > pauseCutoff) {
        console.log(`next-move: ${p.last_name} was answered by hand on ${String(p.manual_touch_at).slice(0, 10)}. Leaving him to Eric.`);
        return false;
      }
      return true;
    })
    .filter((p) => !p.funnel_next_date || p.funnel_next_date <= today || p.behavior_flag)
    // Anyone carrying a behaviour flag has done something and is waiting on a response to it, so
    // they go first. Sorting by score alone meant a flagged lead sitting at position twenty seven
    // never came up: the run took the top ten by score, every run, and the tail was never worked.
    .sort((a, b) => {
      const fa = a.behavior_flag ? 1 : 0, fb = b.behavior_flag ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (Number(b.funnel_score) || 0) - (Number(a.funnel_score) || 0);
    })
    .slice(0, PER_RUN);

  let queued = 0;
  for (const p of candidates) {
    const [events, replies, quotes, acts] = await Promise.all([
      sGet(`mdrx_funnel_events?select=event,page,link,cta,scroll,seconds,created_at&provider_id=eq.${p.id}&order=created_at.desc&limit=15`),
      (() => {
        const dom = practiceDomain(p.email);
        const cols = 'select=from_addr,from_name,subject,snippet,sentiment,received_at';
        return sGet(dom
          ? `mdrx_inbox_drafts?${cols}&or=(provider_id.eq.${p.id},from_addr.ilike.*@${dom})&order=received_at.desc&limit=8`
          : `mdrx_inbox_drafts?${cols}&provider_id=eq.${p.id}&order=received_at.desc&limit=5`);
      })(),
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
      talk_link: p.funnel_token ? `https://mdconcierge.net/go.html?p=${p.funnel_token}&to=talk` : null,
      has_cell: !!(p.cell && String(p.cell).trim()),
      brief_sent_at: p.brief_sent_at, meeting_requested_at: p.meeting_requested_at,
      engagement_events: (events || []).map((e) => ({ event: e.event, page: e.page, link: e.link, cta: e.cta, when: e.created_at })),
      // Who said it matters: "Monica, his practice manager" is not the physician, and a draft that
      // ignores what she already asked for reads as though nobody is listening.
      their_replies: (replies || []).map((r) => ({ from: r.from_name || r.from_addr, said: r.snippet, subject: r.subject, sentiment: r.sentiment, when: r.received_at })),
      tool_views: (quotes || []).map((q) => ({ views: q.view_count, first: q.first_viewed_at, last: q.last_viewed_at })),
      logged_touches: acts || [],
    };
    // A lead who has written to us and not been answered does not get an automated follow-up. The
    // answer is a reply to what he actually said, and that is Eric's to write. Drafting over the
    // top of it is how a physician gets a generic nudge two days after asking a direct question.
    const newestReply = (replies || [])[0];
    const unanswered = newestReply
      && (!p.last_touch_at || new Date(newestReply.received_at) > new Date(p.last_touch_at));
    if (unanswered) {
      console.log(`next-move: ${p.last_name} has an unanswered reply from ${newestReply.from_name || newestReply.from_addr} (${String(newestReply.received_at).slice(0, 10)}). No draft; it needs a real answer.`);
      await sPatch(`mdrx_providers?id=eq.${p.id}`, {
        behavior_flag: 'replied, waiting on us',
        next_step: `answer ${newestReply.from_name || newestReply.from_addr} by hand`,
      });
      continue;
    }

    const mv = await decide(ctx);
    if (!mv) continue;
    await sPost('mdrx_next_moves', { provider_id: p.id, recommended_date: mv.recommended_date, channel: mv.channel || 'email', angle: mv.angle || null, reason: mv.reason || null, draft: mv.draft, status: 'pending' });
    // reflect the recommendation on the record so nothing sits with no plan
    // The flag has been answered: a move is planned against it. Leaving it up meant thirty six
    // records permanently reading "needs attention", which is the same as none of them doing so.
    // The behaviour is still on the timeline; only the outstanding-work marker comes down.
    await sPatch(`mdrx_providers?id=eq.${p.id}`, {
      next_step: mv.angle || p.next_step,
      funnel_next_date: mv.recommended_date,
      behavior_flag: null,
      needs_attention: false,
    });
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
    await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: `[MDconcierge] the ${job} job hit a problem`, text: msg });
    await fetch(`${SUPABASE_URL}/rest/v1/job_alerts`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ job, last_alert_at: new Date().toISOString(), last_msg: msg.slice(0, 300) }) });
  } catch (e) { console.error('alertFailure error: ' + e.message); }
}

// Importable so the rendering can be checked against a real draft without running the agent.
export { draftToCard };
if (process.env.NEXTMOVE_NO_RUN) { /* imported for inspection, do not run */ } else
main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/timeout|econnreset|econnrefused|enotfound|socket|network|fetch failed|overloaded|529|503/i.test(msg)) { console.warn('transient, skipping run: ' + msg); process.exit(0); }
  console.error('next-move fatal: ' + (e?.stack || e));
  await alertFailure('next-move', msg);
  process.exit(0);
});
