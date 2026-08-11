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
// "saw you" was too narrow: "Saw that you and Monica spent some time in the dispensing model this
// week" sailed through and would have told a physician we watch him. Match the act of observing,
// not one phrasing of it.
const TRACKING = /\b(saw|noticed|see)\b[^.]{0,40}\byou\b|took a (close )?look|chance to look|going back through|been (looking|in|spending time)|thanks for taking a look|you (have been|and your team) (looking|reading|spent|in)|spent (some )?time in the/i;
const BANNED = /own volume|favorable opinion in writing|what it comes to against/i;
const DISPENSING = /prohibit\w* (physicians )?from dispensing|dispens\w+ (in|at) (the|your) office|office dispensing|\b2014\b/i;
const BRITISH = /\b(authoris|organis|recognis|realis)\w*/i;
const NAG = /checking in|circling back|following up on|touching base|any thoughts/i;
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
 * Every reason this email must not go out. Empty array means it may.
 * @param {{html?:string, text?:string, lastName?:string, toEmail?:string}} m
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
  const last = String(m.lastName || '').trim();
  if (!last) f.push('no surname on the record');
  else {
    const want = `Dr. ${last},`;
    if (text.trim() && !text.trim().startsWith(want)) f.push('plain text does not open on the greeting');
    if (html.trim() && !vis.startsWith(want)) f.push('designed email does not open on the greeting');
  }

  // The opt-out has to exist in both halves, and must never be the first thing he reads. It once
  // rendered above the greeting in every email for two days because a <p> sat outside its <td>.
  const OPTOUT = /aren't interested|don't wish to hear/i;
  if (html.trim() && !OPTOUT.test(vis)) f.push('no opt-out in the designed email');
  if (text.trim() && !OPTOUT.test(text)) f.push('no opt-out in the plain text');
  if (html.trim()) {
    const o = vis.search(OPTOUT), d = vis.indexOf('Dr. ');
    if (o > -1 && d > -1 && o < d) f.push('opt-out appears above the greeting');
  }

  // Signature in both halves.
  if (html.trim() && !/FOUNDER/i.test(html)) f.push('no signature in the designed email');
  if (text.trim() && !/Eric Weiscarger/.test(text)) f.push('no signature in the plain text');

  // Copy rules Eric has had to state more than once.
  if (DASH.test(both)) f.push('contains a dash');
  if (TRACKING.test(both)) f.push('reveals that we track him');
  if (BANNED.test(both)) f.push('contains banned wording');
  if (DISPENSING.test(vis)) f.push('raises in-office dispensing');
  if (BRITISH.test(both)) f.push('British spelling');
  if (NAG.test(both)) f.push('banned follow-up phrase');

  // Tracking that cannot work is worse than none: the click is dropped and the lead never moves.
  if (BLIND_TOKEN.test(html + text)) f.push('tracking token is empty');
  if (URL_AS_TEXT.test(html)) f.push('a link shows a raw URL as its text');

  // A button has to say where it goes. "See the details" was the fallback label for any destination
  // the renderer had no name for, so physicians got a button that told them nothing.
  if (/UNKNOWN LINK:/.test(html)) f.push('a link has no label for its destination');
  if (/see the details/i.test(vis)) f.push('a button says nothing');
  if (/signature attaches here/i.test(vis)) f.push('preview placeholder left in the body');

  return f;
}

/** True when the email is fit to be queued or sent. */
export const emailPasses = (m) => emailFaults(m).length === 0;
