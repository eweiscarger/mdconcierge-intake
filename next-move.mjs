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
{"recommended_date":"YYYY-MM-DD","channel":"email|call|text","angle":"short label of the approach","reason":"one line: why this move, why now, from their behavior","draft":"the message to send (for email/text) or 2-3 call talking points (for call)","content_id":<the id of the story from news_angles you used, or null>,"subject":"the subject line"}

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

SUBJECT. Return a "subject". If reply_subject is set, this physician is already on a thread with Eric and your subject MUST be exactly reply_subject, unchanged, so the email lands in the conversation he remembers instead of arriving as something new. Only when reply_subject is empty do you write your own, and then keep it short, specific to him, and never a campaign headline about another state.

NEWS. news_angles holds stories Eric has read and approved himself, already filtered to the ones that apply where this practice actually is. You may lead the email with ONE of them when it genuinely bears on this physician and what he has been looking at, and you must then return its id as content_id. Use the story to say something he did not already know, in your own words, never pasted. Do not reach for one just because it is there: an angle that does not fit is worse than no angle, and a second one in the same email turns a note into a newsletter. Never state a fact that is not in the story you were given, never name a court, a ruling or a number that is not there, and if news_angles is empty then simply write the email without any of this. Return content_id null when you use none.

WHAT IS AND IS NOT ON OFFER. Eric grew Mountain Valley Ortho's work comp payer mix from 5 percent to 18 percent through referral connections he has in PENNSYLVANIA. He does not have those connections in other states. So outside Pennsylvania the offer is to monetise the work comp volume a practice ALREADY has, not to increase it, and you must never imply, promise or hint that Eric can send them more injured workers, grow their payer mix, or open referral channels for them. Referrers repeat the payer mix number in their introductions because it is true of their own practice; that does not make it available to the practice being introduced. If someone outside Pennsylvania raises it, the honest answer is that the referral side was Pennsylvania specific and what travels is the ancillary economics on the work comp they already see. Never promise otherwise to win a call.

WHAT TO LEAD WITH. Work comp pharmacy and the injection kits are the two to lead with, always. They come from the same vendor, both are turnkey, and the kits are not available elsewhere. DME is the second conversation, never the opening one, and the reason matters because it is the honest one: pharmacy and kits change NOTHING about how a practice already works, while DME does. The modalities are specific, they have to become part of the treatment plan, and there is prior authorization, so it takes longer to stand up. It is real money and worth having, it simply is not where anyone starts. Say that plainly if it comes up and move on. Most established practices are already using somebody for the pharmacy or the kits, and that is not an objection to argue with. It decides the starting point: if they are committed to someone on one, start with the one they are not doing. So the single most useful question to ask a new practice is which of the two they run today, if either, because the answer picks the program.

INTRODUCTIONS. When someone has been introduced to Eric by a referrer, the referrer has usually already explained the programs, often at length and better than a cold email could, because they run them themselves. Do NOT explain those programs back. Repeating what the introducer just said is redundant, it reads as though nobody read the thread, and it wastes the one thing a referral gives you, which is that the person already believes it. Thank them, acknowledge the referrer by name, and then add only what the referrer could not: what is true in THIS practice's state, what depends on their own payer mix or setup, what the sequence should be, what Eric needs from them. Then ask for the call. Short. The referrer has already spent their credibility; do not spend their time. Never invite the new contact to go back and interrogate the referrer, and never put the referrer on the first call. If a peer conversation would help, offer it AFTER Eric has spoken to them, where it reinforces a decision instead of standing in for a pitch, and where it costs the referrer twenty minutes only when it is going to close something. A referrer whose time gets spent on every introduction stops making them.

BOOKING. The email is written BY Eric, in the first person, so it says "I am easy to book with", never "Eric is easy to book with". You are drafting as him, and any sentence that talks about Eric in the third person is wrong on its face. Never name a time on the clock. Not "Tuesday at 10", not "10:15", not "between 9 and 11:30", not a range of any kind. open_slots holds whole blocks read off his calendar, like "Tuesday, open most of the day", and that is the most precise you are ever allowed to be. Name at most two of those days. Then give him both ways to answer, and ALWAYS BOTH: he can propose whatever time suits him, and he can pick one himself off Eric's calendar. The calendar is booking_link. Whenever you offer time you MUST put booking_link in the email, on a line of its own with nothing else on that line, which is what turns it into a button. An email that offers to meet without that link will be refused, and it deserves to be: it leaves the man to write back and ask where to go. Whatever he proposes or picks comes back with a calendar invitation and a Zoom link, so never promise to "send details over" afterwards and never ask him to confirm twice. If open_slots is empty, say plainly that Eric is wide open, ask what suits him, and still give the link.

WRITE TO WHAT WAS ACTUALLY SAID. the_thread holds the real correspondence, newest first, both what was sent to him and anything he sent back. Read it before you write a word. If Eric last sent him the formulary, the follow-up is about the formulary. If Eric wrote by hand about injection kits at his specific practice, the follow-up continues THAT, not a generic offer of a call. Anything marked "written by hand" is Eric choosing his own words for this person and matters more than any cadence touch. A follow-up that could have been sent to anyone on the list is a failed follow-up.

DO NOT REFER BACK TO EARLIER EMAILS he never answered. "As I mentioned", "I said I would be back in touch", "the week I told you about" all assume he read and remembers a message he never replied to. He probably does not. Make the offer stand on its own: here are times, do any of them work. If the timing happens to line up with something Eric wrote before, that is a happy accident, not something to point at.

NEVER CLAIM A CONVERSATION THAT DID NOT HAPPEN. Most of these physicians have never replied to Eric. Saying he would be available in a cold email is not a promise and not an agreement. Do not write "as promised", "as discussed", "as agreed", "following up on our call", "when we spoke", or anything implying a prior exchange, unless their_replies actually shows they wrote to us. If they have never replied, the email opens on the offer itself, not on a relationship. Offering times is welcome; pretending they were owed is not.

COPY RULES, absolute: no em dashes or en dashes anywhere. American spelling. Never reveal that opens, clicks or reading are tracked: no "I saw you", no "you had a chance to look", no reference to anything he read or clicked. Never mention in-office dispensing. Never offer to estimate his opportunity from his own volume. Never invent a number, a name or a legal conclusion.

ADDRESSING: use the address_as value given to you, exactly. Most leads are physicians and it will say "Dr. Rao". Some are practice administrators or managers who came in through a referral, and for them it will say a first name. Calling an administrator "Dr." is as wrong as calling a physician by his first name. Never substitute your own guess for address_as.

Draft voice: brief, human, never templated or salesy. NO em dashes or en dashes (use commas or periods). Never mention commission or tie economics to prescribing. Never invent facts, numbers, names, or legal conclusions. Name it in full: "MDRx Workers' Compensation Pharmacy Program". Keep the body short. Write the way Eric writes, which means contractions: I'm, you'll, let's, don't, it's. Spelling out "I am back" and "let us just talk" is how a machine writes a letter, and every draft that avoids them arrives sounding stiff and slightly foreign.

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
  const due = await sGet(`mdrx_next_moves?select=id,provider_id,recommended_date,channel,angle,reason,draft,subject&status=eq.pending&recommended_date=lte.${today}&order=recommended_date.asc`);
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
      provider_id: p.id, touch_no: 0, to_email: p.email, subject: await subjectFor(p, mv),
      body_text: text, body_html: html,
      status: 'pending', scheduled_date: today,
      // plain, not personal. Personal renders a letter with the designed signature, which is an
      // HTML part and a remote image, and Eric has taken HTML out of everything that goes out.
      objective: mv.angle || null, template_key: 'plain', channel: 'email',
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
// Stories Eric has read and approved, in mdrx_content_queue. Seven have sat there since before he
// went away with used_count zero: approved and never once put in front of anybody.
//
// A story about the Pennsylvania Supreme Court is worth a great deal to a practice in Allentown and
// nothing at all to one in Duluth, and sending it there says plainly that nobody looked. So a story
// that names states belongs only to those states. One that does not name any, an FTC settlement, a
// PBM consolidation figure, travels anywhere.
const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const statesNamedIn = (story) => {
  const t = [story.headline, story.draft_hook, story.source_title, story.angle].join(' ').toLowerCase();
  const found = new Set();
  for (const [name, code] of Object.entries(STATES)) {
    if (new RegExp(String.raw`\b${name}\b`).test(t)) found.add(code);
  }
  // "PA" alone is too easy to hit by accident, so only the full name counts.
  return found;
};
// SUBJECT was one stock campaign headline stamped on every follow-up the engine sent. Justin Gulden
// came in through an introduction from Jackie and has never had a cold email from us, and he was
// about to receive "PA Court Opens Up Significant Revenue Opportunity for Physicians": the wrong
// state, and a headline from a campaign he was never on, sitting on top of a conversation he had
// already started. A follow-up belongs on the thread it follows.
async function subjectFor(p, mv) {
  if (String(mv.subject || '').trim()) return mv.subject.trim();
  // Whatever this conversation is actually called. His own words first, then ours.
  const [hand] = await sGet(`mdrx_messages?select=subject,sent_at&provider_id=eq.${p.id}&subject=not.is.null&order=sent_at.desc&limit=1`);
  const [past] = await sGet(`mdrx_outbox?select=subject,id&provider_id=eq.${p.id}&status=eq.sent&subject=not.is.null&order=id.desc&limit=1`);
  const prior = String((hand && hand.subject) || (past && past.subject) || '').trim();
  if (prior) return /^re:/i.test(prior) ? prior : 'Re: ' + prior;
  // Nobody has written to him yet. A plain line about the thing itself, not a campaign headline.
  return 'The work comp pharmacy program';
}

async function approvedStoriesFor(state) {
  const st = String(state || '').trim().toUpperCase();
  const all = await sGet('mdrx_content_queue?select=id,kind,theme,headline,draft_hook,source_title,source_url,angle,used_count&status=eq.approved&order=used_count.asc,id.desc');
  const fit = (all || []).filter((c) => {
    const named = statesNamedIn(c);
    if (!named.size) return true;                 // national, goes anywhere
    if (!st) return false;                        // a state story needs to know where he is
    return named.has(st);
  });
  // Least used first, so an approved story is not left sitting while one gets sent to everybody.
  return fit.slice(0, 4).map((c) => ({
    id: c.id, theme: c.theme, headline: c.headline, the_story: c.draft_hook, source: c.source_title,
  }));
}

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
  const P = await sGet(`mdrx_providers?select=id,first_name,last_name,practice_name,specialty,funnel_stage,credentials,state,funnel_score,intent_tier,funnel_last_cta,funnel_open_count,funnel_clicked,funnel_booked,behavior_flag,touch_count,last_touch_at,next_step,funnel_next_date,engaged_at,email,cell,brief_sent_at,meeting_requested_at,manual_touch_at,funnel_token&contact_home=eq.Pipeline&funnel_stage=not.in.(Won,Lost)&on_hold=eq.false&suppressed=eq.false`);
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
    // A follow-up to a physician Eric has already written to belongs ON that thread, under its
    // subject, so it lands in the conversation he remembers rather than arriving as a new email
    // about something else. The queue was putting a stock campaign subject on these: Justin Gulden
    // in Duluth was about to get one headed "PA Court Opens Up Significant Revenue Opportunity",
    // which is the wrong state and the wrong conversation at once.
    const lastSubject = (thread.find((m) => String(m.subject || '').trim()) || {}).subject || '';
    const replySubject = lastSubject
      ? (/^re:/i.test(lastSubject.trim()) ? lastSubject.trim() : 'Re: ' + lastSubject.trim())
      : '';
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
      // Approved by Eric, and already narrowed to what applies where this practice actually is.
      news_angles: await approvedStoriesFor(p.state),
      // The thread this belongs on, if there is one.
      reply_subject: replySubject,
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
    // {{calendar}} becomes a real tracked link at send time, not here, so the gate would otherwise
    // read a draft that does offer the calendar as one that offers to meet and gives no way to do
    // it. Stand a representative link in its place for the check only; mv.draft keeps the token.
    const forCheck = String(mv.draft || '').replace(/\{\{calendar\}\}/g,
      'https://mdconcierge.net/go.html?p=' + '0'.repeat(32) + '&to=book');
    const draftFaults = emailFaults({ text: forCheck, lastName: '', addressAs: '', neverReplied: !everReplied, campaign: false });
    // A fault means the draft breaks a rule, so a fault discards it. This used to run the other
    // way round, keeping only faults whose text matched a hand written list, and the list had
    // drifted: it did not mention clock times, in office dispensing, an unlabelled link or Eric
    // written about in the third person, so the gate found those and the draft was queued anyway.
    // Two emails proposing "Tuesday, August 25 at 9:00am or 2:00pm Eastern" reached the front of
    // the queue that way, to physicians who have never once written back.
    //
    // The exceptions are the faults this call cannot judge and the send path repairs anyway: the
    // greeting and surname are checked against an empty record here, and the signature is attached
    // when the email is actually sent.
    const REPAIRED_AT_SEND = /surname on the record|open on the greeting|no signature|no opt-out/i;
    const blocking = draftFaults.filter((f) => !REPAIRED_AT_SEND.test(f));
    if (blocking.length) {
      console.error(`next-move: discarded a draft for ${p.last_name}: ${blocking.join(', ')}`);
      continue;
    }
    // Only credit a story the model was actually offered. Asking it to report its own source is
    // the cheapest way to know, and the cheapest way to be told the wrong thing, so the id is
    // checked against what went in rather than trusted.
    const offered = new Set((ctx.news_angles || []).map((a) => a.id));
    const usedId = offered.has(Number(mv.content_id)) ? Number(mv.content_id) : null;
    // Where there is a thread, its subject wins outright. Asking the model to copy it exactly is
    // asking for a paraphrase eventually, and a paraphrased subject starts a new thread.
    const subject = replySubject || String(mv.subject || '').trim() || null;
    await sPost('mdrx_next_moves', { provider_id: p.id, recommended_date: mv.recommended_date, channel: mv.channel || 'email', angle: mv.angle || null, reason: mv.reason || null, draft: mv.draft, status: 'pending', content_id: usedId, subject });
    if (usedId) {
      const [cur] = await sGet(`mdrx_content_queue?select=used_count&id=eq.${usedId}`);
      await sPatch(`mdrx_content_queue?id=eq.${usedId}`, { used_count: ((cur && cur.used_count) || 0) + 1 });
      console.log(`next-move: ${p.last_name || p.email} leads on approved story ${usedId}`);
    }
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
