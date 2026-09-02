// check.mjs — the one gate every outbound email has to pass.
//
// This exists because the same defects kept reaching Eric's queue: an email with no greeting in
// the designed half, an opener that told a physician we had watched him read, a naked tracking URL
// where a link should be, a missing opt-out in the plain text. Each time it was caught by eye and
// fixed with a one-off script, and each time a fresh one-off script missed the next thing.
//
// So the rules live here, once, and both the queue builder and the sender import them. A rule
// added here is enforced everywhere from that moment. Nothing calls this "a check I ran"; it is
// the condition of being queued at all.
//
// Every rule below is here because it actually happened.

const DASH = /[–—]/;                                    // en dash, em dash
// Match the CLAIM that we watched him, not any mention of him looking at something. "Saw that you
// and Monica spent time in the dispensing model this week" tells a physician we watch him. "If you
// have had a chance to look at the injection kits" tells him nothing at all: it is the ordinary
// polite way to raise a thing you sent someone, and it was being refused, which is why a perfectly
// good draft for Justin Gulden came back held.
//
// So the giveaway is asserting it as fact. "If you have had a chance" passes; "now that you have
// had a chance" does not, because only one of those could have been written without the tracking.
const TRACKING = /\b(saw|noticed)\b[^.]{0,40}\byou\b|\byou (?:have been|and your team) (?:looking|reading|spent|in)\b|spent (?:some )?time in the|thanks for taking a look|going back through|\b(?:since|now that|after|given)\b[^.]{0,45}\b(?:had a chance to look|looked (?:at|through)|been through|went through|ran the numbers|worked through)\b/i;
const BANNED = /own volume|favorable opinion in writing|what it comes to against/i;
const DISPENSING = /prohibit\w* (physicians )?from dispensing|dispens\w+ (in|at) (the|your) office|office dispensing|\b2014\b/i;
// American spelling. The old list knew only the -ise verbs, so "programme" reached two queued
// emails and "modelled" reached a live page before anyone caught them by eye.
// One literal rather than strings joined together: the escaping has to be right only once, and a
// regex literal cannot be silently degraded by a stray backslash the way a string can.
//
// 'analys' was a stem too far. It matches "analysis", which is how American English spells it and
// how both legal write-ups in touch 1 are described, so this rule refused every cold email for six
// days while Eric was away. Only the British inflections are listed now.
const BRITISH = /\b(authoris|organis|recognis|realis|apologis|prioritis|minimis|maximis)\w*|\banalys(e|es|ed|ing)\b|\bprogramme\b|\b(modell|labell|cancell|travell|fuell|signall)(ed|ing)\b|\b(colour|behaviour|favour|honour|labour|flavour)\w*|\b(centre|licence|defence|offence|practise|enrolment|judgement)\b|\b(whilst|amongst|towards)\b/i;
const NAG = /checking in|circling back|following up on|touching base|any thoughts/i;
// Language that claims a prior agreement. Saying you would be available in a cold email is
// not a promise, and 'following up as promised' to a physician who has never replied invents
// a relationship. Only refused when he has never written back.
const CLAIMS_A_DEAL = /as promised|as discussed|as we discussed|per our (conversation|call|discussion)|following up on our|as agreed|you asked me to|when we spoke|after our (call|conversation)|good (talking|speaking) (to|with) you/i;
// Pointing back at an email he never answered. Softer than claiming a deal and just as wrong:
// it assumes he read it and remembers. The model kept reaching for this after being told not
// to, twice, which is why it is a rule and not a preference.
// Eric's holiday is not news to a physician who has never replied to him. He does not know Eric
// was away, was not waiting, and does not care. Announcing a return implies he was.
// A time on the clock: "10am", "2 pm", "10:30", "at 4". Deliberately not matching a bare number,
// so "8 to 5" and "570 817 7569" pass, and not matching a date.
// The language of offering to meet. Kept to phrases that only appear when time is being offered,
// so a passing mention of a call in a different sort of email does not demand a booking link.
const OFFERS_TO_MEET = /\bopen (?:most of the day|in the morning|in the afternoon)\b|\b(?:pick|choose|grab) a time\b|\bwhatever time suits\b|\btime that suits\b|\bpropose a time\b|\b(?:here is|here's|off|from) my calendar\b/i;
// "Eric is", "Eric will", "Eric has". Not "Eric Weiscarger" in the signature, and not a possessive
// like "Eric's calendar", which is how a person does refer to their own diary in writing.
const THIRD_PERSON_ERIC = /\bEric\s+(?:is|was|will|would|can|could|has|had|does|did|wants|prefers|thinks|said|asked|works|runs)\b/i;
const CLOCK_TIME = /\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?(?!\d)|\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i;
const ANNOUNCES_A_RETURN = /i'?m back|i am back|now that i'?m back|back from (my|a) |while i was away|before i went away|on my return|back in the office|returned from/i;
const POINTS_BACK = /I mentioned|I had mentioned|I said I would|as planned|I told you|the (day|week) I (said|mentioned)|like I said|as I noted|my last (email|note) said/i;
const BLIND_TOKEN = /[?&]p=(&|"|'|\s|$)/;
const URL_AS_TEXT = /<a\s[^>]*>\s*https?:\/\//i;

const visibleText = (html) => String(html || '')
  .replace(/<div style="display:none[\s\S]*?<\/div>/gi, '')       // preheader is not visible
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&zwnj;/g, '')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * What a link calls itself. Every renderer imports this one, because the labels drifted: the
 * sender learned the names of the talk and jortho destinations while the two queue builders kept
 * their own shorter lists and fell back to "See the details" for anything else. A destination with
 * no name here fails the gate below instead of shipping a button that tells the physician nothing.
 * @param {string} url
 */
export function linkLabel(url) {
  // The renderers escape the body before they linkify it, so the destination arrives as
  // "&amp;to=book" and a matcher looking for "&to=" reads it as having no destination at all.
  const u = String(url || '').replace(/&amp;/gi, '&');
  const to = (u.match(/[?&]to=([a-z_]+)/i) || ['', ''])[1].toLowerCase();
  if (/unsubscribe/i.test(u)) return 'click here';
  if (to === 'book' || /calendar|meeting/i.test(u)) return 'See my calendar';
  if (to === 'model' || /pharmacy-model/i.test(u)) return 'Open the model';
  if (to === 'talk') return 'Have someone reach out';
  if (to === 'jortho') return 'Read the study';
  if (to === 'pdrx') return 'Open the PDRx formulary and calculator';
  if (to === 'pdrxdeck') return 'the PDRx mail order presentation';
  if (to === 'kits') return 'the injection kit list';
  // Wording lifted from touch1.html, where these three already carry approved anchor text. The
  // fallback renderer knew none of them, so an edited email would have printed the raw URL.
  if (to === 'decision') return "Pennsylvania Supreme Court decision (700 Pharmacy)";
  if (to === 'siegel') return "Daniel Siegel's practical analysis for Pennsylvania physicians";
  if (to === 'gosfield') return "Alice Gosfield's legal analysis";
  if (to === 'execbrief') return 'Read the brief';
  if (to === 'program' || to === 'brief' || to === 'overview') return 'Read the one page overview';
  return to ? 'UNKNOWN LINK: ' + to : 'Read the one page overview';
}

/** The opt-out sentence, in the plain-text half. Same wording the designed half carries. */
export const optOutLine = (stopUrl) =>
  `If you aren't interested, or don't wish to hear from me anymore, click here and I won't write again: ${stopUrl}`;

/**
 * Every reason this email must not go out. Empty array means it may.
 * @param {{html?:string, text?:string, lastName?:string, toEmail?:string, stage?:string, behaviorFlag?:string}} m
 */
export function emailFaults(m) {
  const html = String(m.html || '');
  const text = String(m.text || '');
  const vis = visibleText(html);
  const both = vis + ' ' + text;
  const f = [];

  if (!text.trim() && !html.trim()) f.push('empty email');

  // Addressed by name, in BOTH halves. A greeting in the plain text and a cold open in the
  // designed version is the same email arriving two different ways.
  // Not every recipient is a physician. Practice administrators, managers and champions are
  // addressed by first name, and demanding "Dr. Reed," of a practice administrator would be the
  // same failure as calling a physician by his first name, only in the other direction.
  const addressAs = String(m.addressAs || '').trim();
  const last = String(m.lastName || '').trim();
  if (addressAs) {
    const want = new RegExp('^(?:(?:hi|hey|hello|dear|good (?:morning|afternoon|evening|day)|morning|afternoon)[,]?\\s+)?'
      + addressAs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',', 'i');
    if (text.trim() && !want.test(text.trim())) f.push('plain text does not open on the greeting');
    if (html.trim() && !want.test(vis)) f.push('designed email does not open on the greeting');
  }
  else if (!last) f.push('no surname on the record');
  else {
    // "Hi Dr. Dempsey," is a greeting. The rule was written against the cold templates, which open
    // on a bare surname, and it held six correctly addressed follow-ups for saying hello first.
    // What matters is that he is named as a physician before anything else, not the exact opener.
    const want = new RegExp('^(?:(?:hi|hey|hello|dear|good (?:morning|afternoon|evening|day)|morning|afternoon)[,]?\\s+)?Dr\\. '
      + last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',', 'i');
    if (text.trim() && !want.test(text.trim())) f.push('plain text does not open on the greeting');
    if (html.trim() && !want.test(vis)) f.push('designed email does not open on the greeting');
  }

  // The opt-out has to exist in both halves, and must never be the first thing he reads. It once
  // rendered above the greeting in every email for two days because a <p> sat outside its <td>.
  // Both wordings. The footer the queue builder appends says "If you are not interested" and this
  // pattern only knew the contraction, so every touch 1 to 4 built after 27 Aug 2026 was refused
  // for having no opt-out while carrying a perfectly good one: 11 of 11 on 28 Aug, 20 of 20 on
  // 31 Aug, 26 of 26 on 1 Sep, 27 of 27 on 2 Sep. Touch 5 says "aren't" in its body and passed
  // throughout, which is what made the failure look like a template problem rather than a regex.
  const OPTOUT = /no longer like to hear|(?:are not|aren.t) interested|don.t wish to hear|rather i stop|unsubscribe\.html/i;
  // Only campaign mail carries an opt-out. A one to one email Eric writes to a physician he is in
  // conversation with is not marketing, and an unsubscribe line at the bottom of it announces that
  // it is, which is both untrue and the exact impression the letter format exists to avoid. The
  // rule was written when everything this system sent was a cadence touch, and it stayed applied to
  // everything after that stopped being true.
  if (m.campaign) {
    if (html.trim() && !OPTOUT.test(vis)) f.push('no opt-out in the designed email');
    if (text.trim() && !OPTOUT.test(text)) f.push('no opt-out in the plain text');
  }
  // And the rule the other way, which was missing. Eric said it plainly: a one to one email is not
  // marketing and carries no opt-out. Only the requirement existed, never the prohibition, so a
  // personal note could sit there with an unsubscribe line under the signature and pass clean.
  else if (OPTOUT.test(both)) f.push('opt-out line on a personal email, which is not marketing');
  if (html.trim()) {
    const o = vis.search(OPTOUT), d = vis.indexOf('Dr. ');
    if (o > -1 && d > -1 && o < d) f.push('opt-out appears above the greeting');
  }

  // Signature in both halves.
  if (html.trim() && !/FOUNDER/i.test(html)) f.push('no signature in the designed email');
  if (text.trim() && !/Eric Weiscarger/.test(text)) f.push('no signature in the plain text');

  // Copy rules Eric has had to state more than once.
  if (DASH.test(both)) f.push('contains a dash');
  // Tracking check removed 2026-08-26 at Eric's instruction. It was firing on ordinary sentences,
  // holding emails he had written himself, and he is the one deciding what his own mail may say.
  if (BANNED.test(both)) f.push('contains banned wording');
  if (DISPENSING.test(vis)) f.push('raises in-office dispensing');
  if (BRITISH.test(both)) f.push('British spelling');
  if (NAG.test(both)) f.push('banned follow-up phrase');
  if (m.neverReplied && CLAIMS_A_DEAL.test(both)) f.push('claims a conversation that never happened');
  if (m.neverReplied && POINTS_BACK.test(both)) f.push('points back at an email he never answered');
  if (m.neverReplied && ANNOUNCES_A_RETURN.test(both)) f.push('announces a return to someone who never knew he was away');
  // Eric said it twice: stop throwing clock times at people. He is easy to book with, so an offer
  // names whole blocks of a day and then lets the physician choose, either by proposing a time or
  // picking one off the calendar. "Tuesday at 10" invites a yes to a slot nobody singled out.
  //
  // Scoped to people who have never written back, because that is where we are OFFERING times. A
  // man who proposed Thursday at two must be answered with Thursday at two, and no rule of Eric's
  // gets to stand in the way of a reply.
  if (m.neverReplied && CLOCK_TIME.test(both)) f.push('names a clock time instead of offering whole blocks of a day');

  // Tracking that cannot work is worse than none: the click is dropped and the lead never moves.
  if (BLIND_TOKEN.test(html + text)) f.push('tracking token is empty');
  if (URL_AS_TEXT.test(html)) f.push('a link shows a raw URL as its text');

  // A lead who is already in conversation does not get asked to book a first call or to fill in a
  // form saying how to reach him. His practice manager has been on a Zoom with us. Sending him the
  // opening move again reads as though nobody here remembers who he is.
  // Hot belongs in that list too. A draft to Dr. Jacoby, who had clicked both links twelve days
  // earlier and used neither, offered him both again. The carve-out that used to allow that was
  // written for exactly those people and had it backwards: a man who walked up to the calendar
  // twice and did not book has told us the link is the obstacle. He gets times in the body.
  // Offering to meet and not saying where to pick a time leaves the man to write back and ask. Eric
  // has had to say this more times than it is worth: if the email offers time, the calendar link
  // goes in it. Wanting it on its own line so it renders as a button is a matter for the drafter;
  // this only insists it is there at all.
  if (OFFERS_TO_MEET.test(both) && !/[?&](?:amp;)?to=book\b/i.test(html + text)) {
    f.push('offers to meet without giving him the calendar link');
  }
  // The email is from Eric. A draft that says "Eric is easy to book with" reads as though somebody
  // else wrote it on his behalf, which is exactly what happened, and the physician can tell. His own
  // name in the sign-off is fine; his name as the subject of a sentence is not.
  if (THIRD_PERSON_ERIC.test(both)) f.push('talks about Eric in the third person in an email from Eric');
  // The reach-me form asks a man in mid conversation how to get hold of him. That stays refused.
  // The CALENDAR does not: an email that offers to meet has to hand him the link, whatever stage he
  // is at, and this rule used to strip it from exactly the people closest to booking. Blocking a
  // link that says "or pick a time yourself" was never what Eric asked for. He asked to stop
  // pitching a first call to someone already talking to us.
  if (/^(engaged|hot|closing|won)$/i.test(String(m.stage || '').trim())
      && /[?&](?:amp;)?to=talk\b/i.test(html + text)) {
    f.push('offers a reach-me form to a lead who is already talking to us');
  }

  // A button has to say where it goes. "See the details" was the fallback label for any destination
  // the renderer had no name for, so physicians got a button that told them nothing.
  if (/UNKNOWN LINK:/.test(html)) f.push('a link has no label for its destination');
  if (/see the details/i.test(vis)) f.push('a button says nothing');
  if (/signature attaches here/i.test(vis)) f.push('preview placeholder left in the body');

  return f;
}

/** True when the email is fit to be queued or sent. */
export const emailPasses = (m) => emailFaults(m).length === 0;
