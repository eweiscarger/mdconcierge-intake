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

async function sendReply(to, origSubject, text, inReplyTo) {
  const subject = /^re:/i.test(origSubject || '') ? origSubject : `Re: ${origSubject || 'Your referral'}`;
  await transporter.sendMail({
    from: `MDconcierge Coordination <${ZOHO_USER}>`,
    to, subject, text,
    headers: Object.assign({ 'X-MDC-Auto': 'ack' }, inReplyTo ? { 'In-Reply-To': inReplyTo, 'References': inReplyTo } : {}),
  });
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
            await sendReply(fromAddr, subject, replyText, msg.envelope?.messageId);
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
  console.log(`Done. Created ${created} lead(s), skipped ${skipped} non-referral(s).`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
