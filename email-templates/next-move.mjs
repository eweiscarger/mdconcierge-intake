// next-move.mjs writes emails from scratch, a fresh angle every time: 176 distinct angles across
// 196 moves, which is why no two sounded like the same person. Stripped of the wording there are
// six real situations, and these are Eric's words for them.
//
// The agent keeps deciding WHO, WHICH situation, and WHEN. It no longer decides what to say.
// A move that maps to none of these stays a recommendation in the Cockpit rather than becoming
// something invented.
//
// No signature here. The sender appends it, so a template that carried one would double it up.
// Plain text on purpose: Eric took HTML out of everything that goes out.
//
// Tokens: {{last}} {{first}} {{days}} {{booklink}} {{when}} {{introducer}} {{state}}

export const NEXT_MOVE_TEMPLATES = {

  // He has the information and just needs a time. The commonest move by far.
  offer_times: {
    label: 'Offer times',
    subjectHints: ['a time this week', 'finding a time'],
    body: `Hi Dr. {{last}},

I wanted to make it easy to find a time. I am open {{days}}.

{{booklink}}

If none of those work, tell me a day that does and I will work around it.

Anything at all, just reply or call me.`,
  },

  // Eric told him a date. Turning up on it is the whole point, and it is the one move the agent
  // gets right on its own, because the date is in the thread rather than inferred from a click.
  promised_date: {
    label: 'The date I promised',
    subjectHints: ['as promised', 'the date I promised'],
    body: `Hi Dr. {{last}},

Reaching back out on the date I promised.

Whenever you are ready, the next step is a 30 to 60 minute zoom to walk through the program and answer whatever came up. I am open {{days}}. Send me a couple of times and I will get the invite out.

Anything at all, just reply or call me.`,
  },

  // He said he would take it to the practice. Do not chase, and give him a way to say no.
  after_review: {
    label: 'After an internal review',
    subjectHints: ['where you landed', 'whenever you are ready'],
    body: `Hi Dr. {{last}},

You mentioned you were going to look at this with the practice. No rush at all, I just did not want to leave you waiting on me.

If it is worth a conversation, I am open {{days}}. If it is not the right time, tell me and I will leave it with you.

Anything at all, just reply or call me.`,
  },

  // A call already exists. Confirm it and get out of the way.
  confirm_call: {
    label: 'Confirm a booked call',
    subjectHints: ['confirming {{when}}', 'our call'],
    body: `Hi Dr. {{last}},

Confirming our call {{when}}.

Nothing to prepare. I will cover the program and we can spend the time on your own numbers.

If something comes up, tell me and we will move it, no problem at all.`,
  },

  // He has had enough to read. Stop sending documents and ask for the phone.
  ask_call: {
    label: 'Ask for a call, no new pitch',
    subjectHints: ['15 minutes', 'a quick call'],
    body: `Hi Dr. {{last}},

Rather than send you more to read, can we get 15 minutes on the phone?

I am open {{days}}. Tell me what works and I will call you.

Anything at all, just reply or call me.`,
  },

  // Somebody introduced them. Thank the introducer and say what this is, once.
  intro_followup: {
    label: 'First contact after an introduction',
    subjectHints: ['good to meet you', 'the introduction'],
    body: `Hi Dr. {{last}},

Thank you to {{introducer}} for the introduction, and good to meet you by email.

The mail order pharmacy and the injection kits are the two easiest places to start, because almost nothing changes in how you work today. The script is written as it is now, the medication is mailed to the patient, and it is billed on {{state}}'s workers' compensation pharmacy fee schedule.

Can we get 30 minutes on a zoom? I am open {{days}}.

Anything at all, just reply or call me.`,
  },
};

// The agent's own free-text angle is matched to one of the six. Anything unmatched returns null,
// which is the signal to leave it as a recommendation rather than send.
export function templateForAngle(angle) {
  const a = String(angle || '').toLowerCase();
  if (/promis|reconnect|return|follow through|the date/.test(a))      return 'promised_date';
  if (/confirm|pre-call|reminder/.test(a))                            return 'confirm_call';
  if (/review|internal|discuss with|take it to/.test(a))              return 'after_review';
  if (/intro|introduction|first contact|initial/.test(a))             return 'intro_followup';
  if (/call ask|phone|no new pitch|direct call/.test(a))              return 'ask_call';
  if (/book|time|schedul|calendar|friction|availab/.test(a))          return 'offer_times';
  return null;
}

export function renderTemplate(key, vars) {
  const t = NEXT_MOVE_TEMPLATES[key];
  if (!t) return null;
  let out = t.body;
  for (const [k, v] of Object.entries(vars || {})) out = out.split(`{{${k}}}`).join(String(v ?? ''));
  // A token left unfilled would print braces at a physician. Refuse instead.
  if (/\{\{[a-z_]+\}\}/.test(out)) return null;
  return out;
}
