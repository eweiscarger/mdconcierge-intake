// MDconcierge referral intake: reads new emails in referrals@ (Zoho IMAP),
// uses Claude to extract the client + firm, and creates a lead in Supabase.
// Anything unclear is created as status='review' (never dropped, never mis-routed).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import Anthropic from '@anthropic-ai/sdk';

const { ZOHO_USER, ZOHO_APP_PASSWORD, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY } = process.env;
for (const [k, v] of Object.entries({ ZOHO_USER, ZOHO_APP_PASSWORD, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const FREE_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','live.com','proton.me','me.com','msn.com'];

function fmtPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return String(raw || '').trim();
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}
function title(s){ return String(s||'').toLowerCase().replace(/\b[a-z]/g,m=>m.toUpperCase()).replace(/\s+/g,' ').trim(); }

async function extract(subject, fromAddr, body) {
  const prompt = `You are extracting a personal-injury / disability CLIENT REFERRAL from an email that an attorney, paralegal, or medical coordinator sent to an intake inbox. The client is ALREADY REPRESENTED by the sender's firm.

From: ${fromAddr}
Subject: ${subject}
Body:
${String(body || '').slice(0, 6000)}

Return ONLY a JSON object (no prose, no code fence):
{
 "is_referral": true/false,         // false if this clearly isn't a client referral (spam, newsletter, auto-reply)
 "client_first": "", "client_last": "",
 "client_phone": "", "client_email": "",
 "city": "", "state": "",            // state as 2-letter code if determinable
 "zip": "",
 "dob": "",                          // MM/DD/YYYY or ""
 "case_type": "",                    // one of: auto, truck, wc, slip, pi, malpractice, ssd, ltd, other
 "injury_description": "",
 "needs": "",                        // what the client needs (medical provider, imaging, surgery, funding, etc.)
 "referring_firm": "",               // the law firm / organization name
 "referring_contact": "",            // the person who sent it
 "confidence": "high|medium|low",    // confidence the core client info is present and unambiguous
 "missing": ""                       // comma-separated important fields missing/unclear, or ""
}
Use "" for anything not present. Never invent data.`;
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  let txt = (msg.content?.[0]?.text || '').trim();
  txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  return JSON.parse(txt);
}

async function insertLead(payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cases`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Supabase insert ${res.status}: ${await res.text()}`);
}

function buildLead(d, fromAddr, subject) {
  const domain = (fromAddr.split('@')[1] || '').toLowerCase();
  const firmFromDomain = domain && !FREE_DOMAINS.includes(domain) ? domain : '';
  const firm = d.referring_firm || firmFromDomain;
  const freeDomain = FREE_DOMAINS.includes(domain) || !domain;
  const lowConf = String(d.confidence || '').toLowerCase() === 'low' || !!(d.missing && d.missing.trim());
  const noFirm = !d.referring_firm && freeDomain;
  const thin = !d.client_first && !d.client_last && !d.client_phone && !d.client_email;
  const needsReview = lowConf || noFirm || thin || !d.client_phone;
  const year = 2026; // stamped server-side; refId only needs to be unique-ish
  const refId = `MDC-A-${year}-${Math.floor(100000 + Math.random() * 900000)}`;
  const notes = [
    'Represented: YES',
    `Referring firm: ${firm || '(unknown — confirm)'}`,
    d.referring_contact ? `Referring contact: ${d.referring_contact}` : '',
    `Sender: ${fromAddr}`,
    d.needs ? `Needs: ${d.needs}` : '',
    d.client_email ? `Client email: ${String(d.client_email).toLowerCase()}` : '',
    d.dob ? `Client DOB: ${d.dob}` : '',
    (d.city || d.state) ? `Location: ${title(d.city) || ''}, ${String(d.state||'').toUpperCase()}` : '',
    d.injury_description ? `Details: ${d.injury_description}` : '',
    needsReview ? `NEEDS REVIEW: ${[lowConf?'low confidence':'', noFirm?'confirm firm':'', thin?'sparse — verify':'', d.missing||''].filter(Boolean).join('; ')}` : '',
    `Source: referrals@ email — "${(subject||'').slice(0,80)}" (auto-parsed)`,
    'Raw: ' + JSON.stringify(d),
  ].filter(Boolean).join(' | ');
  return {
    case_id: refId,
    patient_first: d.client_first ? title(d.client_first) : null,
    patient_last: d.client_last ? title(d.client_last) : null,
    patient_phone: d.client_phone ? fmtPhone(d.client_phone) : null,
    patient_zip: (String(d.zip||'').replace(/\D/g,'').slice(0,5)) || null,
    injury_type: (d.injury_description || d.needs || '').slice(0, 80) || null,
    case_type: d.case_type || null,
    status: needsReview ? 'review' : 'new',
    lead_source: 'attorney_referral_email',
    notes,
  };
}

function fallbackLead(fromAddr, subject, body) {
  const domain = (fromAddr.split('@')[1] || '').toLowerCase();
  const firm = domain && !FREE_DOMAINS.includes(domain) ? domain : '(unknown — confirm)';
  const refId = `MDC-A-2026-${Math.floor(100000 + Math.random() * 900000)}`;
  const notes = [
    'Represented: YES',
    `Referring firm: ${firm}`,
    `Sender: ${fromAddr}`,
    'NEEDS REVIEW: auto-parse failed — open original email in referrals@',
    `Source: referrals@ email — "${(subject||'').slice(0,80)}"`,
    'Body: ' + String(body || '').replace(/\s+/g, ' ').slice(0, 500),
  ].join(' | ');
  return { case_id: refId, patient_first: null, patient_last: null, patient_phone: null, patient_zip: null,
    injury_type: (subject||'').slice(0,80) || null, case_type: null, status: 'review', lead_source: 'attorney_referral_email', notes };
}

// ── Gracious auto-acknowledgment (coordinator reply: #1 acknowledge, #2 chase missing info) ──
const transporter = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ZOHO_USER, pass: ZOHO_APP_PASSWORD } });

async function draftReply(d, payload, toAddr) {
  const refId = payload.case_id;
  const clientName = [payload.patient_first, payload.patient_last].filter(Boolean).join(' ') || 'your client';
  const contact = (d && d.referring_contact) || '';
  const firm = (d && d.referring_firm) || '';
  const missing = (d && d.missing) ? String(d.missing).trim() : '';
  try {
    const prompt = `Write a brief, very polite and gracious acknowledgment email replying to a law-firm contact who just referred a client to MDconcierge, a medical-legal coordination service.

Referring contact: ${contact || '(unknown)'}
Firm: ${firm || '(unknown)'}
Client referred: ${clientName}
Reference number: ${refId}
Information we still need (may be 'none'): ${missing || 'none'}

Rules:
- Warm, gracious, genuinely appreciative, professional, concise (~90-130 words).
- Sincerely thank them for the referral and for trusting MDconcierge; confirm it is received and our coordination team is already on it.
- Include the reference number.
- If information is still needed, politely and graciously ask them to reply with those specific items.
- Do NOT give legal or medical advice. Do NOT promise specific timelines, outcomes, or guarantees.
- End with "With gratitude," on one line, then "The MDconcierge Coordination Team" on the next.
Return ONLY the email body text (no subject line).`;
    const msg = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    const t = (msg.content?.[0]?.text || '').trim();
    if (t) return t;
  } catch (e) { console.error('  ↳ AI draft failed, using template: ' + e.message); }
  const ask = missing ? ` When you have a moment, could you kindly reply with the following so we can move quickly: ${missing}.` : ' We will be in touch shortly with next steps.';
  return `Hello${contact ? ' ' + contact : ''},\n\nThank you so much for your referral — we are truly grateful you thought of MDconcierge. We have received it for ${clientName} (reference ${refId}), and our coordination team is already getting to work.${ask}\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
}

function escEmail(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function emailHtml(bodyText, buttons){
  const para='<p style="margin:0 0 14px;">'+escEmail(bodyText).replace(/\n\n+/g,'</p><p style="margin:0 0 14px;">').replace(/\n/g,'<br>')+'</p>';
  const btns=(buttons&&buttons.length)?('<div style="margin-top:6px;">'+buttons.map(b=>`<a href="${b.href}" style="display:inline-block;padding:11px 20px;margin:6px 10px 6px 0;background:${b.color};color:${b.text};text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">${escEmail(b.label)}</a>`).join('')+'</div>'):'';
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:'Segoe UI',Arial,sans-serif;">`
    +`<div style="max-width:560px;margin:0 auto;padding:22px;">`
    +`<div style="background:#0b0f14;border-radius:12px 12px 0 0;padding:18px 24px;"><span style="font-size:20px;font-weight:800;color:#ffffff;">MD<span style="color:#c8922a;">concierge</span></span><div style="color:#8e97a3;font-size:12px;margin-top:2px;">Medical-Legal Coordination</div></div>`
    +`<div style="background:#ffffff;border:1px solid #e3e6ea;border-top:none;border-radius:0 0 12px 12px;padding:22px 24px;color:#1a2230;font-size:14px;line-height:1.6;">${para}${btns}</div>`
    +`<div style="text-align:center;color:#9aa3af;font-size:11px;padding:14px;">MDconcierge &middot; referrals@mdconcierge.net</div>`
    +`</div></body></html>`;
}
function mailtoBtn(label, subject, body, color, text){return {label,href:`mailto:referrals@mdconcierge.net?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,color:color||'#c8922a',text:text||'#1a1305'};}
async function sendReply(to, origSubject, text, html, inReplyTo) {
  const subject = /^re:/i.test(origSubject || '') ? origSubject : `Re: ${origSubject || 'Your referral'}`;
  await transporter.sendMail({
    from: `MDconcierge Coordination <${ZOHO_USER}>`,
    to, subject, text, html,
    headers: Object.assign({ 'X-MDC-Auto': 'ack' }, inReplyTo ? { 'In-Reply-To': inReplyTo, 'References': inReplyTo } : {}),
  });
}
async function sendMail(to, subject, text, html) {
  await transporter.sendMail({ from: `MDconcierge Coordination <${ZOHO_USER}>`, to, subject, text, html, headers: { 'X-MDC-Auto': 'notify' } });
}

// ── #3 Notify provider contacts when a lead is routed (uses service key; runs each cycle) ──
const SVC = process.env.SUPABASE_SERVICE_KEY;
function addBusinessDays(n) { const d = new Date(); let added = 0; while (added < n) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) added++; } return d.toISOString(); }
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'PATCH', headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${path} ${r.status}: ${await r.text()}`);
}
async function draftProviderEmail(cs, prov, recipients) {
  const clientName = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || 'a patient';
  const firmM = (cs.notes || '').match(/Referring firm:\s*([^|]+)/); const firm = firmM ? firmM[1].trim() : '';
  const locM = (cs.notes || '').match(/Location:\s*([^|]+)/); const location = locM ? locM[1].trim() : '';
  try {
    const prompt = `Write a brief, very polite and gracious email to a medical provider's office, notifying them that MDconcierge (a medical-legal coordination service) is referring a patient to them for care coordination.
Provider: ${prov.doctor_name}
Patient: ${clientName}
Injury / needs: ${cs.injury_type || 'details in portal'}
Location: ${location || '(on file)'}
Patient is represented by counsel${firm ? ` (${firm})` : ''}.
Reference: ${cs.case_id || ''}
Recipient roles: ${recipients.map(r => r.role).filter(Boolean).join(', ') || 'office'}

Rules: warm, gracious, professional, concise (~110 words). Ask them to reach out to begin coordinating scheduling. Note the patient is represented and MDconcierge will support coordination. Do NOT give medical or legal advice; do NOT include PII beyond the patient's name; do NOT promise timelines. Include the reference number. End with "With gratitude," then "The MDconcierge Coordination Team". Return only the body text.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    const t = (m.content?.[0]?.text || '').trim(); if (t) return t;
  } catch (e) { console.error('  provider draft failed, using template: ' + e.message); }
  return `Hello,\n\nWe're grateful to connect with your office. MDconcierge is coordinating care for a patient, ${clientName} (reference ${cs.case_id || 'N/A'}), who is represented by counsel. We would be most grateful if your team could reach out to begin coordinating scheduling — our coordination team is happy to help with anything you need.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
}
async function notifyRoutedProviders() {
  if (!SVC) { console.log('No service key set; skipping provider notifications.'); return; }
  let cases = [];
  try { cases = await sbGet(`cases?select=*&status=eq.routed&provider_notified=is.false&routed_provider_id=not.is.null`); }
  catch (e) { console.error('notify: cases query failed: ' + e.message); return; }
  console.log(`Provider notifications: ${cases.length} routed case(s) pending.`);
  for (const cs of cases) {
    try {
      const provId = cs.routed_provider_id;
      const provs = await sbGet(`providers?select=*&id=eq.${provId}`);
      const prov = provs[0];
      if (!prov) { await sbPatch(`cases?id=eq.${cs.id}`, { provider_notified: true }); continue; }
      const contacts = await sbGet(`contacts?select=name,email,role&receives_referrals=is.true&or=(provider_id.eq.${provId},and(provider_id.is.null,practice_id.eq.${prov.practice_id}))`);
      const recipients = (contacts || []).filter(c => c.email && /@/.test(c.email));
      if (!recipients.length) {
        console.log(`  case ${cs.case_id}: provider "${prov.doctor_name}" has no referral-contact email — marking notified, flag for manual follow-up.`);
        await sbPatch(`cases?id=eq.${cs.id}`, { provider_notified: true, notes: (cs.notes || '') + ' | PROVIDER NOTIFY: no referral-contact email on file — contact provider manually' });
        continue;
      }
      const text = await draftProviderEmail(cs, prov, recipients);
      const to = recipients.map(r => r.email).join(', ');
      const patient = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || cs.case_id;
      const btns = [
        mailtoBtn('✅ Accept referral', `ACCEPT ${cs.case_id} — ${patient}`, `We can accept ${patient} (${cs.case_id}). Please send the full case details and we'll coordinate scheduling.`, '#2ecc8a', '#06351f'),
        mailtoBtn('Decline', `DECLINE ${cs.case_id} — ${patient}`, `Unfortunately we're unable to take ${patient} (${cs.case_id}) at this time.`, '#e0556b', '#ffffff'),
        mailtoBtn('Reply to coordinate', `RE ${cs.case_id} — ${patient}`, `Hello, regarding ${patient} (${cs.case_id}):\n\n`),
      ];
      await sendMail(to, `New patient referral — ${patient}`, text, emailHtml(text, btns));
      await sbPatch(`cases?id=eq.${cs.id}`, { provider_notified: true, followup_count: 0, next_checkin: addBusinessDays(2) });
      console.log(`  notified ${prov.doctor_name} -> ${to} (case ${cs.case_id})`);
    } catch (e) { console.error(`  notify case ${cs.id} failed: ${e.message}`); }
  }
}

async function draftFollowUp(cs, prov, count) {
  const clientName = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || 'the patient';
  try {
    const prompt = `Write a brief, very polite and gracious FOLLOW-UP email to a medical provider's office, gently checking on scheduling for a patient MDconcierge referred. This is reminder #${count} of up to 3 — keep it light and no-pressure.
Provider: ${prov.doctor_name}
Patient: ${clientName}
Reference: ${cs.case_id || ''}
Rules: warm, gracious, light-touch (~70-90 words). Politely ask whether they've been able to schedule ${clientName}, or if there's anything MDconcierge can help with. No medical/legal advice, no extra PII. Include the reference. End "With gratitude," then "The MDconcierge Coordination Team". Return only the body.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    const t = (m.content?.[0]?.text || '').trim(); if (t) return t;
  } catch (e) { console.error('  follow-up draft failed: ' + e.message); }
  return `Hello,\n\nJust a gentle note to check in on scheduling for ${clientName} (reference ${cs.case_id || 'N/A'}). Whenever it's convenient, we'd be grateful for a quick update — and please let us know if there's anything MDconcierge can help with.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
}
async function followUpRouted() {
  if (!SVC) return;
  const nowIso = new Date().toISOString();
  let cases = [];
  try { cases = await sbGet(`cases?select=*&status=eq.routed&provider_notified=is.true&followup_count=lt.3&next_checkin=lte.${nowIso}`); }
  catch (e) { console.error('follow-up: query failed: ' + e.message); return; }
  console.log(`Follow-ups: ${cases.length} case(s) due.`);
  for (const cs of cases) {
    try {
      const provs = await sbGet(`providers?select=*&id=eq.${cs.routed_provider_id}`); const prov = provs[0];
      if (!prov) { await sbPatch(`cases?id=eq.${cs.id}`, { next_checkin: null }); continue; }
      const contacts = await sbGet(`contacts?select=name,email,role&receives_referrals=is.true&or=(provider_id.eq.${cs.routed_provider_id},and(provider_id.is.null,practice_id.eq.${prov.practice_id}))`);
      const recipients = (contacts || []).filter(c => c.email && /@/.test(c.email));
      const count = (cs.followup_count || 0) + 1;
      if (recipients.length) {
        const text = await draftFollowUp(cs, prov, count);
        const patient = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || cs.case_id;
        const btns = [
          mailtoBtn('Update us on scheduling', `UPDATE ${cs.case_id} — ${patient}`, `Hello, an update on ${patient} (${cs.case_id}):\n\n`),
          mailtoBtn('✅ Accept referral', `ACCEPT ${cs.case_id} — ${patient}`, `We can accept ${patient} (${cs.case_id}).`, '#2ecc8a', '#06351f'),
        ];
        await sendMail(recipients.map(r => r.email).join(', '), `Following up — ${patient}`, text, emailHtml(text, btns));
      }
      if (count >= 3) {
        await sbPatch(`cases?id=eq.${cs.id}`, { followup_count: count, next_checkin: null, notes: (cs.notes || '') + ' | FOLLOW-UP: 3 reminders sent, no scheduling confirmed — please review' });
        console.log(`  case ${cs.case_id}: 3rd reminder sent — flagged for review.`);
      } else {
        await sbPatch(`cases?id=eq.${cs.id}`, { followup_count: count, next_checkin: addBusinessDays(2) });
        console.log(`  case ${cs.case_id}: follow-up ${count} sent; next in 2 business days.`);
      }
    } catch (e) { console.error(`  follow-up case ${cs.id} failed: ${e.message}`); }
  }
}

async function main() {
  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: ZOHO_USER, pass: ZOHO_APP_PASSWORD }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  let created = 0, skipped = 0;
  try {
    const uids = await client.search({ seen: false }, { uid: true });
    console.log(`Found ${uids?.length || 0} new message(s).`);
    for (const uid of (uids || [])) {
      let fromAddr = '', subject = '', body = '';
      try {
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        fromAddr = msg.envelope?.from?.[0]?.address || '';
        subject = msg.envelope?.subject || '';
        const parsed = await simpleParser(msg.source);
        // loop guard: never process our own automated acknowledgments
        if (parsed.headers && parsed.headers.get('x-mdc-auto')) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          continue;
        }
        body = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '');
        let payload, extracted = null;
        try {
          extracted = await extract(subject, fromAddr, body);
          if (extracted && extracted.is_referral === false) {
            console.log(`Skipping non-referral from ${fromAddr}: "${subject}"`);
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            skipped++;
            continue;
          }
          payload = buildLead(extracted, fromAddr, subject);
        } catch (e) {
          console.error(`Parse failed for "${subject}" from ${fromAddr}: ${e.message} — creating review lead.`);
          payload = fallbackLead(fromAddr, subject, body);
          extracted = null;
        }
        await insertLead(payload);
        console.log(`Created ${payload.case_id} [${payload.status}] from ${fromAddr} — "${subject}"`);
        created++;
        // gracious auto-acknowledgment back to the referrer
        if (fromAddr) {
          try {
            const replyText = await draftReply(extracted, payload, fromAddr);
            const pName = [payload.patient_first, payload.patient_last].filter(Boolean).join(' ') || payload.case_id;
            const ackHtml = emailHtml(replyText, [mailtoBtn('Reply to coordinate', `Re: referral — ${pName} (${payload.case_id})`, `Hello,\n\nRegarding ${pName} (${payload.case_id}):\n\n`)]);
            await sendReply(fromAddr, subject, replyText, ackHtml, msg.envelope?.messageId);
            console.log(`  ↳ acknowledged ${fromAddr}`);
          } catch (e) { console.error(`  ↳ reply failed: ${e.message}`); }
        }
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } catch (e) {
        console.error(`Error on uid ${uid} (${fromAddr}): ${e.message} — left unread for retry.`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  await notifyRoutedProviders();
  await followUpRouted();
  console.log(`Done. Created ${created} lead(s), skipped ${skipped} non-referral(s).`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
