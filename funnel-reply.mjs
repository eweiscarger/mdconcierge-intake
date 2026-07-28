// Funnel reply agent (SEPARATE from the referrals@ engine and the MDRx inbox).
// Reads eric@mdconcierge.net INBOX read-only, finds replies from FUNNEL leads
// (mdrx_providers.lead_type='funnel'), classifies each per the reply playbook,
// auto-handles opt-outs + stage transitions (pauses cadence), and drafts a
// grounded reply into funnel_replies for Eric to approve/send. SENDS NOTHING
// and never modifies the mailbox. Runs on a schedule via GitHub Actions.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Anthropic from '@anthropic-ai/sdk';

const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ERIC_PASS, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}
const SITE = 'https://mdconcierge.net';
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
async function sGet(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function sPost(table, row, prefer = 'return=minimal') { const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${table} ${r.status}: ${await r.text()}`); }
async function sPatch(path, row) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`patch ${path} ${r.status}: ${await r.text()}`); }

const NOISE = /dmarc|no-?reply|noreply|postmaster|mailer-daemon|notification/i;
const OPTOUT = /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop emailing|do not (email|contact)|leave me alone)\b/i;
const addMonthsISO = (m) => { const d = new Date(); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };

const OFFER = `The program is a Pharmacy Claims Purchasing (factoring) model, NOT physician dispensing and NOT a physician-owned pharmacy. A physician e-prescribes for a work-comp patient in their normal EHR. An independent licensed mail-order pharmacy ships to the patient next day at zero cost, no denials while the claim is open. The pharmacy sells that claim at fair market value to a physician-owned LLC that carries the collection risk; a separate billing company (MDRx) bills the payer and remits a share of collections to the LLC. Workers-comp and auto claims only, never Medicare/Medicaid/federal, not lab. Legal grounding: 700 Pharmacy v. Bureau of WC Fee Review (Pa., June 16 2026), won by Daniel Siegel; Alice Gosfield's analysis says the model is worth reconsidering.`;

async function classifyAndDraft(who, fromAddr, subject, body, bookLink) {
  const sys = `You triage and draft replies for Eric Weiscarger of MDconcierge, about the work-comp pharmacy claims-purchasing program. FACTS you may rely on (never invent beyond these): ${OFFER}
Writing rules for any draft: brief and warm, peer to peer, sounds like a real person not a pitch. NO em dashes or en dashes ever, use commas or periods. Never say "gray area". Never mention commission or invent numbers/names/legal conclusions. Workers-comp only. Sign off "Best," newline "Eric" newline "MDconcierge".
Classify the physician's reply into exactly one class: wants_call, wants_materials, compliance, how_it_works, economics, not_now, not_interested, unsubscribe, other.
Suggested action is one of: send_book_link, send_materials, reply, suppress, note.
If they want to talk or pick a time -> wants_call / send_book_link; include this booking link in the draft: ${bookLink}
If they ask for info/materials/the overview -> wants_materials / send_materials (draft says the one page overview and the two legal write-ups from Siegel and Gosfield are attached).
compliance/how_it_works/economics -> reply, grounded in the facts, and offer a short call.
not interested -> not_interested / note (brief, gracious). not now -> not_now / note. opt out -> unsubscribe / suppress (no draft needed).
Return ONLY compact JSON: {"classification":"...","action":"...","draft":"<email body, or empty string if suppress>"}`;
  try {
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, system: sys, messages: [{ role: 'user', content: `Reply from ${who} (${fromAddr}), subject "${subject}":\n"""\n${String(body || '').slice(0, 2500)}\n"""` }] });
    const txt = (m.content?.[0]?.text || '').replace(/^```json\s*|\s*```$/g, '').trim();
    return JSON.parse(txt);
  } catch (e) { console.error('classify failed: ' + e.message); return { classification: 'other', action: 'reply', draft: '' }; }
}

async function main() {
  const provs = await sGet("mdrx_providers?select=id,first_name,last_name,email,funnel_token&lead_type=eq.funnel");
  const existing = await sGet('funnel_replies?select=message_uid');
  const seen = new Set((existing || []).map(d => d.message_uid));
  const byEmail = {}; (provs || []).forEach(p => { if (p.email) byEmail[p.email.toLowerCase()] = p; });

  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  let created = 0, scanned = 0, drafted = 0;
  try {
    const total = client.mailbox?.exists || 0;
    const start = Math.max(1, total - 40);
    for await (const m of client.fetch(`${start}:*`, { envelope: true, source: true })) {
      scanned++;
      const env = m.envelope || {};
      const from = env.from?.[0] || {};
      const fromAddr = (from.address || '').toLowerCase();
      const subject = env.subject || '';
      const mid = env.messageId || ('uid:' + m.uid);
      if (seen.has(mid)) continue;
      if (NOISE.test(fromAddr) || fromAddr === 'referrals@mdconcierge.net' || fromAddr === 'eric@mdconcierge.net') continue;
      const prov = byEmail[fromAddr];
      if (!prov) continue; // only funnel leads
      let bodyText = '';
      try { const parsed = await simpleParser(m.source); bodyText = (parsed.text || '').trim(); } catch (e) {}
      const who = 'Dr. ' + (prov.last_name || '');
      const bookLink = `${SITE}/book.html?p=${prov.funnel_token}`;

      // Opt-out is handled automatically, no draft, no model call needed.
      const hardOptout = OPTOUT.test(bodyText) || OPTOUT.test(subject);
      let cls;
      if (hardOptout) cls = { classification: 'unsubscribe', action: 'suppress', draft: '' };
      else if (drafted < 10) { cls = await classifyAndDraft(who, fromAddr, subject, bodyText, bookLink); drafted++; }
      else cls = { classification: 'other', action: 'note', draft: '' };

      // Stage + cadence transitions (pause cadence on any reply).
      const patch = { priority: 'high', funnel_last_seen_at: new Date().toISOString() };
      let status = 'pending';
      if (cls.classification === 'unsubscribe') {
        if (prov.email) await sPost('suppressions', { email: prov.email, reason: 'reply opt-out', source: 'reply_stop', provider_id: prov.id }, 'resolution=ignore-duplicates,return=minimal');
        patch.suppressed = true; patch.funnel_stage = 'Unsubscribed'; patch.unsubscribed_at = new Date().toISOString(); patch.funnel_next_date = null; patch.next_step = null;
        status = 'auto_handled';
      } else if (cls.classification === 'not_interested') { patch.funnel_stage = 'Lost'; patch.funnel_next_date = null; patch.next_step = null; }
      else if (cls.classification === 'not_now') { patch.funnel_stage = 'Not Now'; patch.recycle_date = addMonthsISO(3); patch.funnel_next_date = addMonthsISO(3); patch.next_step = 'Recycle'; }
      else { patch.funnel_stage = 'Replied'; patch.funnel_next_date = null; patch.next_step = 'Respond'; }
      await sPatch(`mdrx_providers?id=eq.${prov.id}`, patch);

      await sPost('funnel_replies', {
        message_uid: mid, provider_id: prov.id, from_addr: fromAddr, from_name: from.name || '',
        subject, received_at: env.date || null, snippet: bodyText.replace(/\s+/g, ' ').slice(0, 400),
        classification: cls.classification, suggested_action: cls.action, draft_reply: cls.draft || '', status,
      });
      seen.add(mid); created++;
    }
  } finally { lock.release(); }
  await client.logout();
  console.log(`Funnel reply scan: ${scanned} scanned, ${created} new, ${drafted} drafted.`);
}
main().catch(e => {
  const msg = String(e?.message || e);
  if (/greeting|connection|timeout|econnreset|econnrefused|enotfound|socket|network/i.test(msg)) {
    console.warn('Transient mail connection issue, skipping this run: ' + msg);
    process.exit(0); // do not fail the workflow (and email Eric) on a transient blip
  }
  console.error('Fatal: ' + (e?.stack || e));
  process.exit(1);
});
