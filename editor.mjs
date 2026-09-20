// The managing editor. A model reads the finished email the way a physician would and blocks it
// if anything is redundant, wrong, or does not make sense.
//
// Eric, 17 Sep 2026, after ten cold emails went out with the opening line printed twice:
//   "There has to be a proofreading agent or a managing editor that signs off on everything before
//    it goes out - it can't wait on my approval that's ridiculous - this can never happen again."
//   "And there cannot be any redundancy, mistakes or things that don't make sense."
//
// This runs AFTER the deterministic rules in check.mjs. Those catch exact repeats and the specific
// failures Eric has already lived through; this catches the ones no regex can: a near-repeat, a
// sentence that contradicts the one before it, a greeting that does not match the recipient, copy
// that reads as though someone else wrote it on his behalf.
//
// IT FAILS CLOSED. No key, no network, a malformed answer, a timeout: the email does not queue.
// A gate that waves mail through when it cannot do its job is not a gate.

const MODEL = 'claude-opus-4-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You are the managing editor for MDconcierge. Eric Weiscarger signs every email you
review. Your only job is to decide whether this email is fit to send to a physician or an attorney.

BLOCK the email if any of these is true:
- Anything is said twice: a repeated sentence, a repeated paragraph, or the same point made twice
  in different words.
- A sentence contradicts another, or does not follow from what came before.
- The greeting does not match the recipient, or a name is wrong, missing, or malformed.
- A placeholder, template variable, stray bracket, "undefined", or other machinery is visible.
- A sentence is incomplete, garbled, or does not make sense on its own.
- It claims a conversation, relationship, or prior email that is not evidenced in the email itself.
- It reads as though written about Eric by somebody else rather than by Eric.
- The formatting is broken: a paragraph run together, a signature printed twice, an opt-out sitting
  in the middle of the letter rather than under the signature.

Do NOT block for style, tone, length, or word choice you merely dislike. Eric approves his own
wording and it is not yours to improve. You are checking that the email is CORRECT, not that it is
to your taste. A clean email must pass.

Answer with JSON only, no prose, no code fence:
{"verdict":"send"} or {"verdict":"block","reasons":["...","..."]}
Each reason names the exact defect and quotes the offending text.`;

/**
 * @returns {Promise<{ok: boolean, reasons: string[]}>} ok:false means DO NOT SEND.
 */
export async function editorReview({ subject, text, html, to, addressAs }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reasons: ['managing editor unavailable: no ANTHROPIC_API_KEY, failing closed'] };

  const body = String(text || '').trim() || String(html || '').replace(/<[^>]+>/g, ' ').trim();
  if (!body) return { ok: false, reasons: ['empty email'] };

  const prompt = [
    to ? `Recipient: ${to}` : '',
    addressAs ? `Should be addressed as: ${addressAs}` : '',
    `Subject: ${subject || '(none)'}`,
    '',
    'EMAIL AS IT WILL BE RECEIVED:',
    '---',
    body,
    '---',
  ].filter(Boolean).join('\n');

  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    }).finally(() => clearTimeout(timer));
  } catch (e) {
    return { ok: false, reasons: [`managing editor unreachable (${e.name === 'AbortError' ? 'timed out' : e.message}), failing closed`] };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, reasons: [`managing editor returned ${res.status}, failing closed: ${detail.slice(0, 200)}`] };
  }

  let verdict;
  try {
    const data = await res.json();
    const said = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    verdict = JSON.parse(said.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    return { ok: false, reasons: ['managing editor gave an unreadable answer, failing closed'] };
  }

  if (verdict && verdict.verdict === 'send') return { ok: true, reasons: [] };
  const reasons = Array.isArray(verdict?.reasons) && verdict.reasons.length
    ? verdict.reasons.map(String)
    : ['managing editor blocked it without giving a reason'];
  return { ok: false, reasons };
}
