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

STAGE, absolute. If stage is Engaged, Hot, Closing or Won, this lead is already in conversation with us, or his practice is. NEVER use talk_link for them. Asking a man whose practice manager has been on a call with us to fill in a form saying how to reach him throws the relationship away and reads as though nobody here remembers who he is. booking_link is DIFFERENT and is always welcome: it is not a pitch for a first call, it is where he picks a time, and it belongs in any email that offers time no matter what stage he is at. For these leads the move is the next real step: answer what was actually asked, send what was actually requested, confirm what was already discussed.

THEIR REPLIES come first. their_replies holds what this lead and his practice actually wrote to us, and the practice manager or PA writing on his behalf IS this lead replying. Read them before anything else and write to what they said. Never draft a message that ignores an open question they put to us.

BOOKING. The email is written BY Eric, in the first person, so it says "I am easy to book with", never "Eric is easy to book with". You are drafting as him, and any sentence that talks about Eric in the third person is wrong on its face. Never name a time on the clock. Not "Tuesday at 10", not "10:15", not "between 9 and 11:30", not a range of any kind. open_slots holds whole blocks read off his calendar, like "Tuesday, open most of the day", and that is the most precise you are ever allowed to be. Name at most two of those days. Then give him both ways to answer, and ALWAYS BOTH: he can propose whatever time suits him, and he can pick one himself off Eric's calendar. The calendar is booking_link. Whenever you offer time you MUST put booking_link in the email, on a line of its own with nothing else on that line, which is what turns it into a button. An email that offers to meet without that link will be refused, and it deserves to be: it leaves the man to write back and ask where to go. Whatever he proposes or picks comes back with a calendar invitation and a Zoom link, so never promise to "send details over" afterwards and never ask him to confirm twice. If open_slots is empty, say plainly that Eric is wide open, ask what suits him, and still give the link.

WRITE TO WHAT WAS ACTUALLY SAID. the_thread holds the real correspondence, newest first, both what was sent to him and anything he sent back. Read it before you write a word. If Eric last sent him the formulary, the follow-up is about the formulary. If Eric wrote by hand about injection kits at his specific practice, the follow-up continues THAT, not a generic offer of a call. Anything marked "written by hand" is Eric choosing his own words for this person and matters more than any cadence touch. A follow-up that could have been sent to anyone on the list is a failed follow-up.

DO NOT REFER BACK TO EARLIER EMAILS he never answered. "As I mentioned", "I said I would be back in touch", "the week I told you about" all assume he read and remembers a message he never replied to. He probably does not. Make the offer stand on its own: here are times, do any of them work. If the timing happens to line up with something Eric wrote before, that is a happy accident, not something to point at.

NEVER CLAIM A CONVERSATION THAT DID NOT HAPPEN. Most of these physicians have never replied to Eric. Saying he would be available in a cold email is not a promise and not an agreement. Do not write "as promised", "as discussed", "as agreed", "following up on our call", "when we spoke", or anything implying a prior exchange, unless their_replies actually shows they wrote to us. If they have never replied, the email opens on the offer itself, not on a relationship. Offering times is welcome; pretending they were owed is not.

COPY RULES, absolute: no em dashes or en dashes anywhere. American spelling. Never reveal that opens, clicks or reading are tracked: no "I saw you", no "you had a chance to look", no reference to anything he read or clicked. Never mention in-office dispensing. Never offer to estimate his opportunity from his own volume. Never invent a number, a name or a legal conclusion.

ADDRESSING: use the address_as value given to you, exactly. Most leads are physicians and it will say "Dr. Rao". Some are practice administrators or managers who came in through a referral, and for them it will say a first name. Calling an administrator "Dr." is as wrong as calling a physician by his first name. Never substitute your own guess for address_as.

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
      // The model thinks before it answers, and thinking comes out of this budget. At 1600 and
      // again at 3000 it spent the lot reasoning and returned nothing at all: stop=max_tokens with
      // only thinking blocks and no text. The draft itself is a few hundred tokens; the headroom
      // is for the thinking in front of it.
      model: 'claude-sonnet-5', max_tokens: 8000, system: SYSTEM,
      messages: [{ role: 'user', content: 'Plan the next move for this lead:\n\n' + JSON.stringify(ctx) }],
    });
    let raw = ((m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s < 0 || e < 0) {
      // Say why it came back unusable rather than printing an empty string. An empty response and
      // a truncated one need opposite fixes, and 'no json:' told us which was happening: neither.
      console.error(`no json: stop=${m.stop_reason} blocks=${(m.content || []).map((c) => c.type).join(',') || 'none'}`
        + ` in=${m.usage?.input_tokens} out=${m.usage?.output_tokens} raw="${raw.slice(0, 200)}"`);
      return null;
    }
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
    const [p] = await sGet(`mdrx_providers?select=id,first_name,last_name,credentials,email,funnel_token,funnel_stage,suppressed,on_hold&id=eq.${mv.provider_id}`);
    // A recommendation made last week must not go out to a lead Eric has since pulled off
    // automation. The hold is checked at the moment of queueing, not only at the moment of drafting.
    if (!p || !p.email || p.suppressed || p.on_hold) continue;
    // The model sometimes writes a subject line into the body. The row already carries its own
    // subject, so left in it would print "Subject: A couple of times this week" above the greeting.
    const draft = String(mv.draft || '').replace(/^[ \t]*subject:[^\n]*\n+/i, '').trim();
    if (!draft) continue;
    // These are not marketing. A follow-up Eric sends to one physician he is talking to gets no
    // unsubscribe line and no campaign card: an opt-out at the bottom announces the email as a
    // mailshot, which is untrue and is the impression a letter exists to avoid. The sender renders
    // it as a letter with his real signature, so nothing is built here.
    const text = draft;
    const html = '';
    // A draft is written by a model, so it is exactly the thing that has to be checked before it
    // reaches Eric's queue. The recommendation stays pending and says why, rather than queueing
    // something he then has to notice is wrong.
    // The gate refuses invented history, but only when the physician has genuinely never written.
    const { count: replyCount } = { count: (await sGet(`mdrx_inbox_drafts?select=id&provider_id=eq.${p.id}&limit=1`) || []).length };
    // Check the draft against the name it should actually use, not against a Dr. it may not be.
    const isStaff = /administrator|manager|coordinator|director|staff|office/i.test(String(p.credentials || ''));
    const faults = emailFaults({ html, text,
      lastName: isStaff ? '' : p.last_name,
      addressAs: isStaff ? (p.first_name || p.last_name || '') : '',
      toEmail: p.email, stage: p.funnel_stage, neverReplied: replyCount === 0, campaign: false });
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
      objective: mv.angle || null, template_key: 'personal', channel: 'email',
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

// Real openings from Eric's calendar, not times the model imagines. Proposing "Tuesday at 10am"
// to a physician who says yes, when Eric is booked, is worse than sending no times at all: he has
// to walk it back, and the one thing the follow-up was buying was the impression of being organized.
async function openSlots() {
  try {
    const r = await fetch('https://pjdbzrzadlldojuvdrfj.supabase.co/functions/v1/booking-slots?type=intro');
    const j = await r.json();
    const tz = j.timezone || 'America/New_York';
    // No clock times leave this function. A range like "4:30 PM to 8:00 PM" is accurate and still
    // reads as a machine reciting a database, and quoting a specific time invites a physician to
    // accept one Eric never meant to single out. He is easy to book with; the honest shape of that
    // is a day and a part of the day, and then let the man choose.
    const hourIn = (iso) => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(iso));
      return Number((p.find((x) => x.type === 'hour') || {}).value || 0);
    };
    const out = [];
    for (const day of Object.keys(j.windows || {}).sort().slice(0, 3)) {
      const win = j.windows[day] || [];
      if (!win.length) continue;
      const dayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(win[0].start));
      // Which parts of an ordinary working day he actually has free.
      let morning = false, afternoon = false;
      for (const w of win) {
        const from = hourIn(w.start), to = hourIn(w.end);
        if (from < 12 && to > 9) morning = true;
        if (to > 13 && from < 17) afternoon = true;
      }
      if (morning && afternoon) out.push(`${dayName}, open most of the day`);
      else if (morning) out.push(`${dayName}, open in the morning`);
      else if (afternoon) out.push(`${dayName}, open in the afternoon`);
      // Free only after five is not an offer worth making to a physician, so that day is skipped.
    }
    return out;
  } catch (e) { console.error('could not read the calendar: ' + e.message); return []; }
}

async function main() {
  // Anything already recommended and now due goes into the approval queue first.
  const promoted = await promoteDueMoves();
  if (promoted) console.log(`next-move: promoted ${promoted} due recommendation(s) into the approval queue.`);

  // Active pipeline leads worth a move: in Pipeline, not won/lost, due or freshly flagged.
  // on_hold means Eric took this lead off automation by hand. It was not checked here, so a lead
  // he had already pulled out kept getting drafted for, three times in a week.
  const P = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,specialty,funnel_stage,credentials,funnel_score,intent_tier,funnel_last_cta,funnel_open_count,funnel_clicked,funnel_booked,behavior_flag,touch_count,last_touch_at,next_step,funnel_next_date,engaged_at,email,cell,brief_sent_at,meeting_requested_at,manual_touch_at,funnel_token&contact_home=eq.Pipeline&funnel_stage=not.in.(Won,Lost)&on_hold=eq.false&suppressed=eq.false`);
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
    // Anyone carrying a behavior flag has done something and is waiting on a response to it, so
    // they go first. Sorting by score alone meant a flagged lead sitting at position twenty seven
    // never came up: the run took the top ten by score, every run, and the tail was never worked.
    .sort((a, b) => {
      const fa = a.behavior_flag ? 1 : 0, fb = b.behavior_flag ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (Number(b.funnel_score) || 0) - (Number(a.funnel_score) || 0);
    })
    .slice(0, PER_RUN);

  const slots = await openSlots();
  if (slots.length) console.log('next-move: offering real openings ' + slots.join(' | '));
  else console.log('next-move: calendar unavailable, drafts will ask for their times instead');

  let queued = 0;
  for (const p of candidates) {
    // The words that actually passed between them. Behaviour says he looked; only the thread says
    // what he was looking at and what Eric last told him. Without this the agent writes a generic
    // "here are some times" to a man who was last sent a formulary and a legal summary, and the
    // follow-up reads as though nobody remembers what was sent.
    const [events, replies, quotes, acts, sentMail, handMail] = await Promise.all([
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
      // What the machine sent him, in full.
      sGet(`mdrx_outbox?select=subject,body_text,sent_at&provider_id=eq.${p.id}&status=eq.sent&order=sent_at.desc&limit=4`),
      // What Eric sent him with his own hands, which is usually the more important half.
      sGet(`mdrx_messages?select=direction,subject,body_text,sent_at,from_name&provider_id=eq.${p.id}&order=sent_at.desc&limit=6`),
    ]);
    // One thread, newest first, so the model reads it the way a person would.
    const strip = (t) => String(t || '')
      .replace(/If you aren't interested[\s\S]*$/i, '')      // the opt-out is not conversation
      .replace(/Best,[\s\S]*$/i, '')                          // nor is the signature block
      .replace(/https?:\/\/\S+/g, '[link]')
      .replace(/\s+/g, ' ').trim();
    const thread = [
      ...(sentMail || []).map((m) => ({ when: m.sent_at, who: 'Eric, automated', subject: m.subject, said: strip(m.body_text) })),
      ...(handMail || []).map((m) => ({ when: m.sent_at,
        who: m.direction === 'in' ? (m.from_name || 'them') : 'Eric, written by hand',
        subject: m.subject, said: strip(m.body_text) })),
    ].filter((m) => m.said)
     .sort((a, b) => String(b.when).localeCompare(String(a.when)))
     .slice(0, 6)
     .map((m) => ({ ...m, said: m.said.slice(0, 700) }));
    const ctx = {
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), last_name: p.last_name,
      // Administrators and managers come in through referrals and are not physicians.
      address_as: /administrator|manager|coordinator|director|staff|office/i.test(String(p.credentials || ''))
        ? (p.first_name || p.last_name || '') : `Dr. ${p.last_name || ''}`.trim(), practice: p.practice_name, specialty: p.specialty,
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
      // Newest first. Anything marked "written by hand" is Eric himself and carries more weight
      // than a cadence touch: he chose those words for this person.
      the_thread: thread,
      // Genuinely free, checked against the calendar at run time. Offer only from this list.
      open_slots: slots,
    };
    // A lead who has written to us and not been answered does not get an automated follow-up. The
    // answer is a reply to what he actually said, and that is Eric's to write. Drafting over the
    // top of it is how a physician gets a generic nudge two days after asking a direct question.
    const newestReply = (replies || [])[0];
    // Against what we actually sent, not against a cached field. last_touch_at was being stamped
    // backwards by the sent-folder scan, so a physician who had been answered twice still read as
    // waiting and was skipped every run.
    const answeredAt = Math.max(
      Date.parse(String(p.last_touch_at || '')) || 0,
      ...(sentMail || []).map((m) => Date.parse(String(m.sent_at || '')) || 0),
      ...(handMail || []).filter((m) => m.direction === 'out')
        .map((m) => Date.parse(String(m.sent_at || '')) || 0),
    );
    const unanswered = newestReply
      && (Date.parse(String(newestReply.received_at || '')) || 0) > answeredAt;
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
    // Check the draft the moment it is written, not days later when it comes due. A bad
    // recommendation that sits for a week is a bad recommendation Eric has to read and reject.
    const everReplied = (replies || []).length > 0;
    const draftFaults = emailFaults({ text: mv.draft, lastName: '', addressAs: '', neverReplied: !everReplied, campaign: false });
    const blocking = draftFaults.filter((f) => /never happened|never answered|dash|British|tracking|banned/i.test(f));
    if (blocking.length) {
      console.error(`next-move: discarded a draft for ${p.last_name}: ${blocking.join(', ')}`);
      continue;
    }
    await sPost('mdrx_next_moves', { provider_id: p.id, recommended_date: mv.recommended_date, channel: mv.channel || 'email', angle: mv.angle || null, reason: mv.reason || null, draft: mv.draft, status: 'pending' });
    // reflect the recommendation on the record so nothing sits with no plan
    // The flag has been answered: a move is planned against it. Leaving it up meant thirty six
    // records permanently reading "needs attention", which is the same as none of them doing so.
    // The behavior is still on the timeline; only the outstanding-work marker comes down.
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
