// MDconcierge referral intake: reads new emails in referrals@ (Zoho IMAP),
// uses Claude to extract the client + firm, and creates a lead in Supabase.
// Anything unclear is created as status='review' (never dropped, never mis-routed).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
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
 "client_address": "",               // full street address if stated
 "city": "", "state": "",            // state as 2-letter code if determinable
 "zip": "",
 "dob": "",                          // MM/DD/YYYY or ""
 "case_type": "",                    // one of: auto, truck, wc, slip, pi, malpractice, ssd, ltd, other
 "injury_description": "",
 "needs": "",                        // what the client needs (medical provider, imaging, surgery, funding, etc.)
 "claim_number": "",                 // WC/PI claim number if stated
 "claim_status": "",                 // NCP / TNCP / NCD / litigated / accepted / denied / unknown
 "date_of_injury": "",               // as stated; may be vague or ""
 "date_first_treatment": "",         // as stated or ""
 "adjuster_name": "", "adjuster_phone": "",
 "panel_posted": "",                 // yes / no / unknown
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
    d.client_address ? `Address: ${d.client_address}` : '',
    (d.city || d.state) ? `Location: ${title(d.city) || ''}, ${String(d.state||'').toUpperCase()}` : '',
    d.injury_description ? `Details: ${d.injury_description}` : '',
    needsReview ? `NEEDS REVIEW: ${[lowConf?'low confidence':'', noFirm?'confirm firm':'', thin?'sparse — verify':'', d.missing||''].filter(Boolean).join('; ')}` : '',
    `Source: referrals@ email — "${(subject||'').slice(0,80)}" (auto-parsed)`,
    'Raw: ' + JSON.stringify(d),
  ].filter(Boolean).join(' | ');
  return {
    case_id: refId,
    status_token: randomBytes(24).toString('hex'),
    status_token_exp: new Date(Date.now() + 30*86400000).toISOString(),
    patient_first: d.client_first ? title(d.client_first) : null,
    patient_last: d.client_last ? title(d.client_last) : null,
    patient_phone: d.client_phone ? fmtPhone(d.client_phone) : null,
    patient_zip: (String(d.zip||'').replace(/\D/g,'').slice(0,5)) || null,
    injury_type: (d.injury_description || d.needs || '').slice(0, 80) || null,
    case_type: d.case_type || null,
    claim_number: d.claim_number || null,
    claim_status: d.claim_status || null,
    date_of_injury: d.date_of_injury || null,
    date_first_treatment: d.date_first_treatment || null,
    adjuster_name: d.adjuster_name || null,
    adjuster_phone: d.adjuster_phone || null,
    panel_posted: d.panel_posted || null,
    representation_status: 'represented',
    billing_pathway: deriveBillingPathway({ claim_status: d.claim_status }),
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
function emailHtml(bodyText, buttons, extra){
  const para='<p style="margin:0 0 14px;">'+escEmail(bodyText).replace(/\n\n+/g,'</p><p style="margin:0 0 14px;">').replace(/\n/g,'<br>')+'</p>';
  const btns=(buttons&&buttons.length)?('<div style="margin-top:6px;">'+buttons.map(b=>`<a href="${b.href}" style="display:inline-block;padding:11px 20px;margin:6px 10px 6px 0;background:${b.color};color:${b.text};text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">${escEmail(b.label)}</a>`).join('')+'</div>'):'';
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:'Segoe UI',Arial,sans-serif;">`
    +`<div style="max-width:560px;margin:0 auto;padding:22px;">`
    +`<div style="background:#0b0f14;border-radius:12px 12px 0 0;padding:18px 24px;"><span style="font-size:20px;font-weight:800;color:#ffffff;">MD<span style="color:#c8922a;">concierge</span></span><div style="color:#8e97a3;font-size:12px;margin-top:2px;">Medical-Legal Coordination</div></div>`
    +`<div style="background:#ffffff;border:1px solid #e3e6ea;border-top:none;border-radius:0 0 12px 12px;padding:22px 24px;color:#1a2230;font-size:14px;line-height:1.6;">${para}${btns}${extra||''}</div>`
    +`<div style="text-align:center;color:#9aa3af;font-size:11px;padding:14px;">MDconcierge &middot; referrals@mdconcierge.net</div>`
    +`</div></body></html>`;
}
function mailtoBtn(label, subject, body, color, text){return {label,href:`mailto:referrals@mdconcierge.net?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,color:color||'#c8922a',text:text||'#1a1305'};}
function actionPills(ref){
  const items=[['🔬 Imaging / MRI','Imaging / MRI'],['🏃 Physical Therapy','Physical Therapy'],['🧠 Pain Management','Pain Management'],['🦴 Orthopaedic','Orthopaedic'],['🔄 Chiropractic','Chiropractic'],['💊 Pharmacy','Pharmacy'],['📋 Request records','Medical records'],['📄 Request bills','Billing'],['📡 Carrier relay','Carrier relay'],['➕ Other','Other ancillary service']];
  return '<div style="margin-top:16px;border-top:1px solid #e3e6ea;padding-top:12px;"><div style="font-size:12px;color:#6b7583;margin-bottom:8px;font-weight:600;">One-click requests — we handle the rest:</div>'
    + items.map(([label,req])=>{const href='mailto:referrals@mdconcierge.net?subject='+encodeURIComponent('Request: '+req+' — '+(ref||''))+'&body='+encodeURIComponent('Please coordinate '+req+' for referral '+(ref||'')+'.\n\n');return `<a href="${href}" style="display:inline-block;font-size:12px;padding:5px 11px;margin:3px 6px 3px 0;background:#eef5fc;border:1px solid #b8d4ee;border-radius:12px;color:#1a2230;text-decoration:none;">${label}</a>`;}).join('')
    + '</div>';
}
// ── Phase H: per-party live-status portal link ──
async function statusToken(cs) {
  const exp = daysFromNow(STATUS_TTL_DAYS); // refresh on each send so active cases stay live, stale links die
  if (cs.status_token) {
    try { if (SVC) await sbPatch(`cases?id=eq.${cs.id}`, { status_token_exp: exp }); } catch (e) {}
    cs.status_token_exp = exp; return cs.status_token;
  }
  const tok = randomBytes(24).toString('hex');
  try { if (SVC) await sbPatch(`cases?id=eq.${cs.id}`, { status_token: tok, status_token_exp: exp }); } catch (e) {}
  cs.status_token = tok; cs.status_token_exp = exp; return tok;
}
function statusBtn(tok) { return { label: '📊 View live status', href: 'https://mdconcierge.net/status.html?t=' + tok, color: '#1a2230', text: '#ffffff' }; }
function reportPills(ref){
  const items=[['Report UR','UR'],['Report IME','IME'],['Report IRE','IRE']];
  return '<div style="margin-top:12px;border-top:1px solid #e3e6ea;padding-top:10px;"><div style="font-size:12px;color:#6b7583;margin-bottom:6px;font-weight:600;">Report a case event — one tap and we handle the deadline:</div>'
    + items.map(([label,t])=>{const href='mailto:referrals@mdconcierge.net?subject='+encodeURIComponent('Report '+t+' — '+(ref||''))+'&body='+encodeURIComponent('Reporting a '+t+' for referral '+(ref||'')+'.\nDeadline / details: \n\n');return `<a href="${href}" style="display:inline-block;font-size:12px;padding:5px 11px;margin:3px 6px 3px 0;background:#1a2230;border-radius:12px;color:#ffffff;text-decoration:none;">${label}</a>`;}).join('')
    + '</div>';
}
// Standard footer on EVERY case email: action bar (requests + report) + a link to review all their cases.
// (The case-specific magic link is the email's primary button — accept link for providers, status link for attorneys.)
function portalLinkHtml() {
  return '<div style="margin-top:14px;border-top:1px solid #e3e6ea;padding-top:12px;text-align:center;">'
    + '<a href="https://mdconcierge.net/portal.html" style="color:#1a4e8a;font-weight:700;text-decoration:none;font-size:13px;">📋 Review all your cases in the MDconcierge portal</a></div>';
}
function caseFooter(ref) { return actionPills(ref) + reportPills(ref) + portalLinkHtml(); }

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
const ACCEPT_TTL_DAYS = 14, STATUS_TTL_DAYS = 30, PORTAL_SETUP_TTL_DAYS = 14; // magic-link / invite lifetimes
function daysFromNow(n){ return new Date(Date.now() + n*86400000).toISOString(); }
async function logAudit(caseId, action, detail){ if(!SVC||!caseId)return; try{ await sbPost('audit_log', { case_id: caseId, action, detail: detail||null, source: 'automation' }); }catch(e){} }
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
  const locM = (cs.notes || '').match(/Location:\s*([^|]+)/); const location = locM ? locM[1].trim() : '';
  try {
    const prompt = `Write a brief, very polite and gracious email to a medical provider's office notifying them of a NEW patient referral from MDconcierge (a medical-legal coordination service). IMPORTANT: this is PRE-ACCEPTANCE — do NOT include the patient's name or any contact info. Only mention case type, injury/area, and general location.
Provider: ${prov.doctor_name}
Case type: ${cs.case_type || 'injury'}
Injury / area: ${cs.injury_type || 'see details'}
General location: ${location || '(unlocks on acceptance)'}
Reference: ${cs.case_id || ''}
Rules: warm, gracious, concise (~80-100 words). Invite them to review and accept; explain that full patient details and EHR/case-management import unlock once they accept. The patient is represented by counsel. No medical/legal advice, NO patient name, NO contact info. End with "With gratitude," then "The MDconcierge Coordination Team". Return only the body text.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 350, messages: [{ role: 'user', content: prompt }] });
    const t = (m.content?.[0]?.text || '').trim(); if (t) return t;
  } catch (e) { console.error('  provider draft failed, using template: ' + e.message); }
  return `Hello,\n\nWe have a new ${cs.case_type || ''} patient referral${location ? (' in ' + location) : ''} we'd be grateful to coordinate with your office (reference ${cs.case_id || 'N/A'}). Injury / area: ${cs.injury_type || 'details on acceptance'}. The patient is represented by counsel.\n\nPlease review and accept below to unlock the full patient details and EHR / case-management import.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
}
// ── In-network referrals: when a provider/attorney sends a patient onward, the NEW provider is
// notified by notifyRoutedProviders (it's a routed child case); here we FYI the attorney so all are looped in. ──
async function announceInNetworkReferrals() {
  if (!SVC) return;
  let kids = [];
  try { kids = await sbGet(`cases?select=*&parent_case_id=not.is.null&referral_announced=is.false`); }
  catch (e) { console.error('announce: query failed: ' + e.message); return; }
  for (const cs of kids) {
    try {
      const patient = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || cs.case_id;
      const svc = cs.service_label || 'additional care';
      let provName = '';
      if (cs.routed_provider_id) { try { provName = ((await sbGet(`providers?select=doctor_name&id=eq.${cs.routed_provider_id}`))[0] || {}).doctor_name || ''; } catch (e) {} }
      const attyEmails = await resolveOwnerEmails(cs, 'attorney');
      if (attyEmails.length) {
        const stok = await statusToken(cs);
        const text = `Hello,\n\nKeeping you in the loop: ${patient} has been referred within the MDconcierge network${provName ? (' to ' + provName) : ''} for ${svc} (reference ${cs.case_id}). Our team is coordinating it and we'll keep you posted.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
        await sendMail(attyEmails.join(', '), `New in-network referral — ${patient} · ${svc} (${cs.case_id})`, text, emailHtml(text, [statusBtn(stok)], caseFooter(cs.case_id)));
      }
      await sbPatch(`cases?id=eq.${cs.id}`, { referral_announced: true });
      await logAudit(cs.id, 'in_network_referral_announced', provName || cs.service_label || null);
      console.log(`  announced in-network referral ${cs.case_id} (${svc}) to attorney`);
    } catch (e) { console.error(`  announce referral ${cs.id} failed: ${e.message}`); }
  }
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
      const token = cs.accept_token || randomBytes(24).toString('hex');
      const locM = (cs.notes || '').match(/Location:\s*([^|]+)/); const location = locM ? locM[1].trim() : '';
      const text = await draftProviderEmail(cs, prov, recipients);
      const to = recipients.map(r => r.email).join(', ');
      const base = 'https://mdconcierge.net/respond.html?t=' + token;
      const stok = await statusToken(cs);
      const btns = [
        { label: '✅ Accept & view case', href: base + '&a=accept', color: '#2ecc8a', text: '#06351f' },
        { label: 'Decline', href: base + '&a=decline', color: '#e0556b', text: '#ffffff' },
        statusBtn(stok),
        mailtoBtn('Reply to coordinate', `RE ${cs.case_id}`, `Hello, regarding referral ${cs.case_id}:\n\n`),
      ];
      const subj = `New patient referral — ${cs.case_type || 'case'}${location ? (' · ' + location) : ''} (${cs.case_id})`;
      await sendMail(to, subj, text, emailHtml(text, btns, caseFooter(cs.case_id)));
      await sbPatch(`cases?id=eq.${cs.id}`, { provider_notified: true, accept_token: token, accept_token_exp: daysFromNow(ACCEPT_TTL_DAYS), followup_count: 0, next_checkin: addBusinessDays(2) });
      await logAudit(cs.id, 'provider_notified', `${prov.doctor_name} (${to})`);
      for (const rc of recipients) await sendPortalInvite('provider', provId, rc.email, rc.name, prov.practice_id); // first-time only; dedupes; practice-scoped
      console.log(`  notified ${prov.doctor_name} -> ${to} (case ${cs.case_id})`);
    } catch (e) { console.error(`  notify case ${cs.id} failed: ${e.message}`); }
  }
}

async function draftFollowUp(cs, prov, count) {
  try {
    const prompt = `Write a brief, very polite and gracious FOLLOW-UP email to a medical provider's office, gently checking on a patient referral from MDconcierge. This is reminder #${count} of up to 3 — keep it light and no-pressure. IMPORTANT: do NOT include any patient name or contact info (pre-acceptance); refer to it only by the reference number.
Provider: ${prov.doctor_name}
Reference: ${cs.case_id || ''}
Rules: warm, gracious, light-touch (~70-90 words). Politely ask whether they've had a chance to review/accept the referral, or if there's anything MDconcierge can help with. No medical/legal advice, no patient name, no PII. Include the reference. End "With gratitude," then "The MDconcierge Coordination Team". Return only the body.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    const t = (m.content?.[0]?.text || '').trim(); if (t) return t;
  } catch (e) { console.error('  follow-up draft failed: ' + e.message); }
  return `Hello,\n\nJust a gentle note about referral ${cs.case_id || 'N/A'} — whenever convenient, we'd be grateful to know if you've had a chance to review and accept it, or if there's anything MDconcierge can help with.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
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
        const btns = [];
        if (cs.accept_token) {
          const link = 'https://mdconcierge.net/respond.html?t=' + cs.accept_token;
          btns.push({ label: '✅ Accept & view case', href: link + '&a=accept', color: '#2ecc8a', text: '#06351f' });
          btns.push({ label: 'Scheduled', href: link + '&a=scheduled', color: '#eef5fc', text: '#1a2230' });
          btns.push({ label: "Can't reach patient", href: link + '&a=unable', color: '#eef5fc', text: '#1a2230' });
        }
        btns.push(mailtoBtn('Reply with an update', `UPDATE ${cs.case_id}`, `Hello, an update on referral ${cs.case_id}:\n\n`));
        await sendMail(recipients.map(r => r.email).join(', '), `Following up — referral ${cs.case_id}`, text, emailHtml(text, btns, caseFooter(cs.case_id)));
      }

      if (count >= 3) {
        await sbPatch(`cases?id=eq.${cs.id}`, { followup_count: count, next_checkin: null, accept_token_exp: daysFromNow(ACCEPT_TTL_DAYS), notes: (cs.notes || '') + ' | FOLLOW-UP: 3 reminders sent, no scheduling confirmed — please review' });
        console.log(`  case ${cs.case_id}: 3rd reminder sent — flagged for review.`);
      } else {
        await sbPatch(`cases?id=eq.${cs.id}`, { followup_count: count, next_checkin: addBusinessDays(2), accept_token_exp: daysFromNow(ACCEPT_TTL_DAYS) });
        console.log(`  case ${cs.case_id}: follow-up ${count} sent; next in 2 business days.`);
      }
    } catch (e) { console.error(`  follow-up case ${cs.id} failed: ${e.message}`); }
  }
}

// ── Phase B: billing-pathway label + punch-list (case_gaps) for IN-COORDINATION cases only ──
function deriveBillingPathway(cs) {
  const s = String(cs.claim_status || '').toLowerCase();
  if (/ncd|denied/.test(s)) return 'lien';
  if (/litig/.test(s)) return 'litigation';
  if (/tncp|temporary|provisional/.test(s)) return 'tncp_watch';
  if (/ncp|accepted|agreement|medical.?only/.test(s)) return 'wc_direct';
  return 'establish';
}
const GAP_FIELDS = [
  { field: 'claim_number',        label: 'Claim number',           owner: 'attorney', filled: c => !!c.claim_number },
  { field: 'claim_status',        label: 'Claim status / NCP',     owner: 'attorney', filled: c => !!c.claim_status },
  { field: 'date_of_injury',      label: 'Date of injury',         owner: 'attorney', filled: c => !!c.date_of_injury },
  { field: 'adjuster',            label: 'Adjuster contact',       owner: 'attorney', filled: c => !!(c.adjuster_name || c.adjuster_phone) },
  { field: 'date_first_treatment',label: 'Date of first treatment',owner: 'provider', filled: c => !!c.date_first_treatment },
];
async function sbPost(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: 'POST', headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path} ${r.status}: ${await r.text()}`);
}
async function ensureGaps() {
  if (!SVC) return;
  let cases = [];
  // IN-COORDINATION only: attorney-referral, attorney attached, or routed. InjuredGuide pre-referral leads are excluded.
  try { cases = await sbGet(`cases?select=*&or=(lead_source.ilike.*attorney*,attorney_id.not.is.null,routed_provider_id.not.is.null)`); }
  catch (e) { console.error('gaps: cases query failed: ' + e.message); return; }
  let allGaps = [];
  try { allGaps = await sbGet(`case_gaps?select=*`); } catch (e) { console.error('gaps: gaps query failed: ' + e.message); return; }
  let created = 0;
  for (const cs of cases) {
    try {
      const bp = deriveBillingPathway(cs);
      if ((cs.billing_pathway || '') !== bp) await sbPatch(`cases?id=eq.${cs.id}`, { billing_pathway: bp });
      const gapsFor = allGaps.filter(g => g.case_id === cs.id);
      for (const gf of GAP_FIELDS) {
        const existing = gapsFor.find(g => g.field === gf.field);
        if (gf.filled(cs)) {
          if (existing && existing.status !== 'received') await sbPatch(`case_gaps?id=eq.${existing.id}`, { status: 'received', updated_at: new Date().toISOString() });
        } else if (!existing) {
          await sbPost('case_gaps', { case_id: cs.id, field: gf.field, label: gf.label, owner: gf.owner, status: 'open', next_touch: addBusinessDays(3), touches: 0 });
          created++;
        }
      }
    } catch (e) { console.error(`  gaps case ${cs.id} failed: ${e.message}`); }
  }
  if (created) console.log(`Punch list: created ${created} new gap item(s).`);
}

// ── Once we retrieve the claim details from the attorney, forward them to the provider who accepted ──
async function forwardCompletedInfo() {
  if (!SVC) return;
  let cases = [];
  // routed + provider has accepted + the essentials are now present + not yet forwarded
  try {
    cases = await sbGet(`cases?select=*&routed_provider_id=not.is.null&claim_info_forwarded=is.false&claim_number=not.is.null&claim_status=not.is.null&or=(provider_response.eq.accepted,status.eq.scheduled,status.eq.accepted)`);
  } catch (e) { console.error('forward-info: query failed: ' + e.message); return; }
  let sent = 0;
  for (const cs of cases) {
    try {
      const emails = await resolveOwnerEmails(cs, 'provider');
      if (!emails.length) { await sbPatch(`cases?id=eq.${cs.id}`, { claim_info_forwarded: true }); continue; }
      const lines = [
        cs.claim_number ? `Claim #: ${cs.claim_number}` : '',
        cs.claim_status ? `Claim status: ${cs.claim_status}` : '',
        cs.date_of_injury ? `Date of injury: ${cs.date_of_injury}` : '',
        (cs.adjuster_name || cs.adjuster_phone) ? `Adjuster: ${[cs.adjuster_name, cs.adjuster_phone].filter(Boolean).join(' · ')}` : '',
        cs.panel_posted ? `Panel posted: ${cs.panel_posted}` : '',
      ].filter(Boolean).join('\n');
      const text = `Hello,\n\nGood news — we've received the insurance/claim details for referral ${cs.case_id} from the attorney's office. Here's what you'll need for billing and authorization:\n\n${lines}\n\nPlease reply if anything else would help. Thank you for taking great care of this patient.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
      await sendMail(emails.join(', '), `Claim details — ${cs.case_id}`, text, emailHtml(text, [mailtoBtn('Reply', `RE ${cs.case_id}`, `Hello,\n\nRegarding ${cs.case_id}:\n\n`)], caseFooter(cs.case_id)));
      await sbPatch(`cases?id=eq.${cs.id}`, { claim_info_forwarded: true });
      await logAudit(cs.id, 'claim_info_forwarded', cs.claim_number || null);
      sent++;
      console.log(`  forwarded claim details to provider for ${cs.case_id}`);
    } catch (e) { console.error(`  forward-info case ${cs.id} failed: ${e.message}`); }
  }
  if (sent) console.log(`Claim details forwarded to providers: ${sent}.`);
}

// ── Phase C: the chase — batched, escalating follow-up on open gaps ──
async function resolveOwnerEmails(cs, owner) {
  if (owner === 'attorney') {
    const notes = cs.notes || '';
    const m1 = notes.match(/Referring email:\s*([^\s|]+)/i);
    const m2 = notes.match(/Sender:\s*([^\s|]+)/i);
    const e = (m1 && m1[1]) || (m2 && m2[1]) || '';
    return /@/.test(e) ? [e.toLowerCase()] : [];
  }
  if (owner === 'provider') {
    if (!cs.routed_provider_id) return [];
    try {
      const provs = await sbGet(`providers?select=*&id=eq.${cs.routed_provider_id}`); const prov = provs[0]; if (!prov) return [];
      const contacts = await sbGet(`contacts?select=email&receives_referrals=is.true&or=(provider_id.eq.${cs.routed_provider_id},and(provider_id.is.null,practice_id.eq.${prov.practice_id}))`);
      return (contacts || []).map(c => c.email).filter(e => e && /@/.test(e));
    } catch (e) { return []; }
  }
  return [];
}
async function draftChase(byCase) {
  const lines = Object.entries(byCase).map(([ref, items]) => `Case ${ref}: ${items.join(', ')}`).join('\n');
  try {
    const prompt = `Write a brief, warm, professional follow-up email from MDconcierge (medical-legal coordination) gently requesting the outstanding items we still need to keep the case(s) moving. Batch everything into ONE message.
Outstanding by case:
${lines}
Rules: warm, brief, appreciative; no guilt or manufactured urgency. Present the asks as a tight bulleted list grouped by case reference. One clear reply path (just reply to this email). No legal/medical advice. Reference cases by their reference code only — NO patient names or PII. End with "With gratitude," then "The MDconcierge Coordination Team". Return only the body text.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 450, messages: [{ role: 'user', content: prompt }] });
    const t = (m.content?.[0]?.text || '').trim(); if (t) return t;
  } catch (e) { console.error('  chase draft failed: ' + e.message); }
  return `Hello,\n\nA quick follow-up on the items we still need to keep things moving:\n\n${lines}\n\nWhenever convenient, just reply with whatever you have — no rush, and thank you.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
}
async function chaseGaps() {
  if (!SVC) return;
  const nowIso = new Date().toISOString();
  let due = [], escal = [];
  try { due = await sbGet(`case_gaps?select=*&status=eq.open&next_touch=lte.${nowIso}&touches=lt.2`); } catch (e) { console.error('chase: query failed: ' + e.message); return; }
  try { escal = await sbGet(`case_gaps?select=*&status=eq.open&next_touch=lte.${nowIso}&touches=gte.2`); } catch (e) {}
  const now = new Date();
  const active = due.filter(g => !g.snooze_until || new Date(g.snooze_until) <= now);
  const caseIds = [...new Set(active.concat(escal).map(g => g.case_id))];
  const cases = {};
  for (const cid of caseIds) { try { const c = (await sbGet(`cases?select=*&id=eq.${cid}`))[0]; if (c) cases[cid] = c; } catch (e) {} }
  // group due gaps by resolved recipient email(s) -> one digest per contact, across cases
  const groups = {};
  for (const g of active) {
    const cs = cases[g.case_id]; if (!cs) continue;
    const emails = await resolveOwnerEmails(cs, g.owner);
    if (!emails.length) continue; // no one to ask yet — hold the gap
    const key = emails.slice().sort().join(',');
    (groups[key] = groups[key] || { emails, items: [] }).items.push({ g, cs });
  }
  let sent = 0;
  for (const key of Object.keys(groups)) {
    const grp = groups[key];
    const byCase = {};
    for (const it of grp.items) (byCase[it.cs.case_id] = byCase[it.cs.case_id] || []).push(it.g.label || it.g.field);
    const nCases = Object.keys(byCase).length;
    const subj = nCases > 1 ? `MDconcierge — outstanding items (${nCases} cases)` : `MDconcierge — outstanding items (${Object.keys(byCase)[0]})`;
    try {
      const text = await draftChase(byCase);
      await sendMail(grp.emails.join(', '), subj, text, emailHtml(text, [mailtoBtn('Reply with the details', subj, 'Hello,\n\n')], portalLinkHtml()));
      for (const it of grp.items) await sbPatch(`case_gaps?id=eq.${it.g.id}`, { touches: (it.g.touches || 0) + 1, next_touch: addBusinessDays(5), updated_at: new Date().toISOString() });
      sent++;
    } catch (e) { console.error('  chase send failed: ' + e.message); }
  }
  // T+15 escalation: due gaps already at the cap -> hand to Eric
  let escalated = 0;
  for (const g of escal) {
    if (g.snooze_until && new Date(g.snooze_until) > now) continue;
    try { await sbPatch(`case_gaps?id=eq.${g.id}`, { status: 'escalated', next_touch: null, updated_at: new Date().toISOString() }); escalated++; } catch (e) {}
  }
  console.log(`Chase: sent ${sent} digest(s); escalated ${escalated} item(s) to human.`);
}

// ── Phase D: relay confirmed appointments to the attorney/firm POC ──
async function relayAppointments() {
  if (!SVC) return;
  let cases = [];
  try { cases = await sbGet(`cases?select=*&schedule_status=eq.scheduled&appt_relayed=is.false`); }
  catch (e) { console.error('relay: query failed: ' + e.message); return; }
  let sent = 0;
  for (const cs of cases) {
    try {
      const emails = await resolveOwnerEmails(cs, 'attorney');
      if (!emails.length) { await sbPatch(`cases?id=eq.${cs.id}`, { appt_relayed: true, notes: (cs.notes || '') + ' | APPT: scheduled but no attorney email on file to relay' }); continue; }
      const patient = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || cs.case_id;
      let provName = '';
      if (cs.routed_provider_id) { try { provName = ((await sbGet(`providers?select=doctor_name&id=eq.${cs.routed_provider_id}`))[0] || {}).doctor_name || ''; } catch (e) {} }
      const text = `Hello,\n\nGood news — your client ${patient} (reference ${cs.case_id}) has been scheduled${cs.appointment_at ? (' for ' + cs.appointment_at) : ''}${provName ? (' with ' + provName) : ''}. We'll keep you posted as things progress, and please let us know if there's anything you need from the provider.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
      const rStok = await statusToken(cs);
      await sendMail(emails.join(', '), `Scheduled — ${patient} (${cs.case_id})`, text, emailHtml(text, [statusBtn(rStok), mailtoBtn('Reply', `RE ${cs.case_id}`, 'Hello,\n\n')], caseFooter(cs.case_id)));
      await sbPatch(`cases?id=eq.${cs.id}`, { appt_relayed: true });
      await logAudit(cs.id, 'appointment_relayed', cs.appointment_at || null);
      sent++;
      console.log(`  relayed appointment to attorney for ${cs.case_id}`);
    } catch (e) { console.error(`  relay case ${cs.id} failed: ${e.message}`); }
  }
  if (sent) console.log(`Appointments relayed: ${sent}.`);
}

// ── "Ring the bell": provider's office can't reach / hasn't scheduled the patient -> alert the attorney ──
// We can't schedule (we don't see their calendar), but we relay the failure to the party who can fix it.
async function escalateUnreachable() {
  if (!SVC) return;
  let cases = [];
  try { cases = await sbGet(`cases?select=*&schedule_status=in.(pending,unable)&unreachable_relayed=is.false`); }
  catch (e) { console.error('unreachable: query failed: ' + e.message); return; }
  let sent = 0;
  for (const cs of cases) {
    try {
      const emails = await resolveOwnerEmails(cs, 'attorney');
      let provName = '';
      if (cs.routed_provider_id) { try { provName = ((await sbGet(`providers?select=doctor_name&id=eq.${cs.routed_provider_id}`))[0] || {}).doctor_name || ''; } catch (e) {} }
      const patient = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || cs.case_id;
      const office = provName || "the provider's office";
      if (!emails.length) {
        await sbPatch(`cases?id=eq.${cs.id}`, { unreachable_relayed: true, status: 'escalated', notes: (cs.notes || '') + ` | UNREACHABLE: ${office} can't reach patient to schedule — no attorney email to relay` });
        continue;
      }
      const why = cs.schedule_status === 'unable' ? `${office} has been unable to reach your client to schedule` : `${office} is trying to reach your client to schedule but hasn't connected yet`;
      const text = `Hello,\n\nA quick heads-up on referral ${cs.case_id}: ${why} (${patient}). Could you please ask ${patient} to call the office, or reply with the best phone number and time to reach them? We'd like to get this scheduled and keep the treatment moving.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
      await sendMail(emails.join(', '), `Action needed — can't reach your client to schedule (${cs.case_id})`, text, emailHtml(text, [mailtoBtn('Reply with the best number', `RE ${cs.case_id} — scheduling`, `Hello,\n\nBest way to reach ${patient}:\n\n`)], caseFooter(cs.case_id)));
      await sbPatch(`cases?id=eq.${cs.id}`, { unreachable_relayed: true, status: 'escalated' });
      await logAudit(cs.id, 'unreachable_escalated', cs.schedule_status);
      sent++;
      console.log(`  rang the bell: can't-reach relayed to attorney for ${cs.case_id}`);
    } catch (e) { console.error(`  unreachable case ${cs.id} failed: ${e.message}`); }
  }
  if (sent) console.log(`Unreachable-patient escalations: ${sent}.`);
}

// ── Phase E: email artifact requests to the holder (records/bills/narratives — tracking only, never the doc) ──
async function emailArtifactRequests() {
  if (!SVC) return;
  let arts = [];
  try { arts = await sbGet(`case_artifacts?select=*&status=eq.requested&notified=is.false`); }
  catch (e) { console.error('artifacts: query failed: ' + e.message); return; }
  let sent = 0;
  for (const a of arts) {
    try {
      const cs = (await sbGet(`cases?select=*&id=eq.${a.case_id}`))[0];
      if (!cs) { await sbPatch(`case_artifacts?id=eq.${a.id}`, { notified: true }); continue; }
      const emails = await resolveOwnerEmails(cs, a.holder);
      if (!emails.length) continue; // hold until we can reach the holder
      const recip = a.recipient === 'attorney' ? 'the attorney' : 'the provider';
      const label = a.label || a.type;
      const text = `Hello,\n\nWhen you have a moment, could you please send the ${label} for referral ${cs.case_id} directly to ${recip}? Just reply here once it's on its way and we'll note it as sent. We truly appreciate it.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
      await sendMail(emails.join(', '), `Request: ${label} — ${cs.case_id}`, text, emailHtml(text, [mailtoBtn('Confirm sent', `SENT: ${label} — ${cs.case_id}`, `We've sent the ${label} to ${recip} for ${cs.case_id}.`)], caseFooter(cs.case_id)));
      await sbPatch(`case_artifacts?id=eq.${a.id}`, { notified: true });
      await logAudit(a.case_id, 'artifact_requested', label);
      sent++;
    } catch (e) { console.error(`  artifact ${a.id} failed: ${e.message}`); }
  }
  if (sent) console.log(`Artifact requests sent: ${sent}.`);
}

// ── Phase F: act on reported UR / IME / IRE events ──
// UR -> chase the PROVIDER to get records to the reviewer by the deadline (missing = automatic denial).
// IME / IRE -> flag the ATTORNEY (it can affect benefits); we don't have system visibility, so we surface, not advise.
async function handleEvents() {
  if (!SVC) return;
  let evs = [];
  try { evs = await sbGet(`events?select=*&status=eq.open&notified=is.false`); }
  catch (e) { console.error('events: query failed: ' + e.message); return; }
  let sent = 0;
  for (const ev of evs) {
    try {
      const cs = (await sbGet(`cases?select=*&id=eq.${ev.case_id}`))[0];
      if (!cs) { await sbPatch(`events?id=eq.${ev.id}`, { notified: true }); continue; }
      const type = String(ev.event_type || '').toUpperCase();
      if (type === 'UR') {
        const emails = await resolveOwnerEmails(cs, 'provider');
        if (!emails.length) { await sbPatch(`events?id=eq.${ev.id}`, { notified: true, note: (ev.note || '') + ' [no provider email — Eric to handle]' }); continue; }
        const due = ev.deadline ? (' by ' + ev.deadline) : ' as soon as possible';
        const text = `Hello,\n\nA Utilization Review (UR) has been opened on referral ${cs.case_id}. To protect the claim, the treating records and any supporting narrative need to reach the reviewer${due} — when records arrive late, the review typically results in a denial. Could you please make sure they're submitted on time? Just reply here once they're sent, or if there's anything we can do to help.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
        await sendMail(emails.join(', '), `Time-sensitive — UR records due${ev.deadline ? (' ' + ev.deadline) : ''} (${cs.case_id})`, text, emailHtml(text, [mailtoBtn('Confirm records sent', `UR RECORDS SENT — ${cs.case_id}`, `Records have been submitted to the reviewer for ${cs.case_id}.`)], caseFooter(cs.case_id)));
      } else { // IME / IRE -> attorney flag
        const emails = await resolveOwnerEmails(cs, 'attorney');
        if (!emails.length) { await sbPatch(`events?id=eq.${ev.id}`, { notified: true, note: (ev.note || '') + ' [no attorney email — Eric to handle]' }); continue; }
        const longName = type === 'IRE' ? 'an Impairment Rating Evaluation (IRE)' : type === 'IME' ? 'an Independent Medical Examination (IME)' : ('a ' + type);
        const note = type === 'IRE' ? 'IREs can affect the duration of benefits, so the timing may be worth a look.' : type === 'IME' ? 'You may want to prepare your client and confirm representation at the exam.' : '';
        const text = `Hello,\n\nFlagging for your attention: ${longName} has been reported on referral ${cs.case_id}${ev.deadline ? (' (date: ' + ev.deadline + ')') : ''}. ${note} Please let us know if there's anything you'd like us to coordinate with the provider.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
        await sendMail(emails.join(', '), `${type} reported — ${cs.case_id}`, text, emailHtml(text, [mailtoBtn('Reply', `RE ${type} — ${cs.case_id}`, `Hello,\n\nRegarding the ${type} on ${cs.case_id}:\n\n`)], caseFooter(cs.case_id)));
      }
      await sbPatch(`events?id=eq.${ev.id}`, { notified: true });
      await logAudit(cs.id, 'event_' + type + '_actioned', ev.deadline || null);
      sent++;
    } catch (e) { console.error(`  event ${ev.id} failed: ${e.message}`); }
  }
  if (sent) console.log(`Case events handled: ${sent}.`);
}

// ── Phase E(b): conduit document forwarding — NEVER STORED ──
// We forward inbound documents to the case's counterparty in-memory and discard them.
// Nothing is written to disk or the database; we only record that a transmission occurred.
async function markArtifactTransmitted(caseId, labelHint, autoCreate = true) {
  try {
    const arts = await sbGet(`case_artifacts?select=*&case_id=eq.${caseId}&status=eq.requested&order=created_at.asc`);
    let target = null;
    if (labelHint) target = (arts || []).find(a => (a.label || a.type || '').toLowerCase().includes(String(labelHint).toLowerCase().slice(0, 6)));
    target = target || (arts || [])[0];
    if (target) { await sbPatch(`case_artifacts?id=eq.${target.id}`, { status: 'transmitted', transmitted_at: new Date().toISOString() }); return true; }
    if (autoCreate) { await sbPost('case_artifacts', { case_id: caseId, type: 'records', label: labelHint || 'Forwarded document(s)', holder: 'provider', recipient: 'attorney', status: 'transmitted', notified: true, transmitted_at: new Date().toISOString() }); return true; }
  } catch (e) { console.error('  markArtifactTransmitted: ' + e.message); }
  return false;
}
async function forwardDocuments(cs, fromAddr, subject, bodyText, docs) {
  // Only ever forward to a KNOWN party on this case — never an arbitrary address.
  const provEmails = (await resolveOwnerEmails(cs, 'provider')).map(e => e.toLowerCase());
  const attyEmails = (await resolveOwnerEmails(cs, 'attorney')).map(e => e.toLowerCase());
  const fromLc = (fromAddr || '').toLowerCase();
  let senderRole, recipientRole, recipients;
  if (provEmails.includes(fromLc)) { senderRole = 'the provider'; recipientRole = 'attorney'; recipients = attyEmails; }
  else if (attyEmails.includes(fromLc)) { senderRole = 'the attorney'; recipientRole = 'provider'; recipients = provEmails; }
  else { senderRole = 'the originating office'; recipientRole = 'attorney'; recipients = attyEmails; } // default: records flow to counsel (a known party)
  if (!recipients || !recipients.length) {
    if (SVC) await sbPost('case_artifacts', { case_id: cs.id, type: 'records', label: `Inbound document(s) — no ${recipientRole} email on file; forward manually`, holder: 'provider', recipient: recipientRole, status: 'requested', notified: true });
    return { forwarded: false, reason: 'no-recipient' };
  }
  const attachments = docs.map((a, i) => ({ filename: a.filename || `document-${i + 1}`, content: a.content, contentType: a.contentType || 'application/octet-stream' }));
  const patient = [cs.patient_first, cs.patient_last].filter(Boolean).join(' ') || cs.case_id;
  const fileList = docs.map(a => a.filename || 'document').join(', ');
  const note = `Hello,\n\nPlease find the attached document(s) for referral ${cs.case_id} (${patient}), forwarded on behalf of ${senderRole}: ${fileList}.\n\nMDconcierge acts only as a coordination conduit under our mutual agreements and does not retain a copy of these records. Please let us know if anything is missing.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
  await transporter.sendMail({
    from: `MDconcierge Coordination <${ZOHO_USER}>`,
    to: recipients.join(', '),
    subject: `Documents for referral ${cs.case_id}`,
    text: note,
    html: emailHtml(note, [mailtoBtn('Acknowledge receipt', `RECEIVED: ${cs.case_id}`, `We've received the documents for ${cs.case_id}.`)], caseFooter(cs.case_id)),
    attachments,
    headers: { 'X-MDC-Auto': 'forward' },
  });
  if (SVC) await markArtifactTransmitted(cs.id, null);
  await logAudit(cs.id, 'document_forwarded', `to ${recipientRole}: ${fileList}`);
  return { forwarded: true, role: recipientRole };
}

// ── Self-serve onboarding: send the sign-up-form link to people Eric invites from the dashboard ──
async function draftSignupInvite(name, type) {
  const what = type === 'attorney' ? 'attorney network' : 'provider network';
  try {
    const prompt = `Write a brief, warm, professional invitation email from MDconcierge (a medical-legal coordination service) inviting someone to join our ${what} by completing a short online onboarding form.
Recipient name: ${name || '(unknown)'}
Rules: warm, gracious, concise (~70-90 words). Invite them to complete a quick form so we have everything we need to coordinate smoothly (no back-and-forth later). Mention it only takes a few minutes and they can add their team/contacts. Do NOT give legal/medical advice. End with "With gratitude," then "The MDconcierge Coordination Team". Return only the body text.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    const t = (m.content?.[0]?.text || '').trim(); if (t) return t;
  } catch (e) { console.error('  signup-invite draft failed: ' + e.message); }
  return `Hello${name ? (' ' + name) : ''},\n\nWe'd be delighted to have you join the MDconcierge ${what}. To get started, please take a few minutes to complete our short onboarding form — you can add your team and points of contact so we have everything we need to coordinate smoothly from day one.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
}
async function sendSignupInvites() {
  if (!SVC) return;
  let invites = [];
  try { invites = await sbGet(`signup_invites?select=*&status=eq.pending`); }
  catch (e) { console.error('signup-invites: query failed: ' + e.message); return; }
  let sent = 0;
  for (const inv of invites) {
    try {
      if (!inv.email || !/@/.test(inv.email)) { await sbPatch(`signup_invites?id=eq.${inv.id}`, { status: 'failed', sent_at: new Date().toISOString() }); continue; }
      const link = `https://mdconcierge.net/signup.html?type=${inv.type === 'attorney' ? 'attorney' : 'provider'}`;
      const text = await draftSignupInvite(inv.name, inv.type);
      await sendMail(inv.email, 'Welcome to MDconcierge — quick onboarding', text,
        emailHtml(text, [{ label: '📝 Complete onboarding', href: link, color: '#c8922a', text: '#1a1305' }]));
      await sbPatch(`signup_invites?id=eq.${inv.id}`, { status: 'sent', sent_at: new Date().toISOString() });
      try { await sbPost('audit_log', { case_id: null, action: 'signup_invite_sent', detail: `${inv.type}: ${inv.email}`, source: 'automation' }); } catch (e) {}
      sent++;
      console.log(`  signup invite sent to ${inv.type} ${inv.email}`);
    } catch (e) { console.error(`  signup invite ${inv.id} failed: ${e.message} — left pending for retry.`); }
  }
  if (sent) console.log(`Sign-up invites sent: ${sent}.`);
}

// ── Signature → contact: Eric forwards a business email to referrals@ with subject "Contact …" ──
async function scrapeSignature(fromAddr, subject, body) {
  const prompt = `Extract the BUSINESS CONTACT from this email's signature. The email may be a FORWARDED message — extract the ORIGINAL person/office, NOT the forwarder (${fromAddr}) and NOT MDconcierge. Return ONLY this JSON (no prose, no code fence):
{"found": true/false, "name":"", "title":"", "company":"", "email":"", "phone":"", "address":"", "type":"medical_office|law_firm|vendor|other"}

Subject: ${subject}
Body:
${String(body || '').slice(0, 5000)}

Use "" for anything not present. found=false if there's no clear business person/office in the text. Prefer the most complete signature block.`;
  let d;
  try {
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    let txt = (m.content?.[0]?.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    d = JSON.parse(txt);
  } catch (e) { console.error('  signature parse failed: ' + e.message); return { created: false }; }
  if (!d || d.found === false || (!d.name && !d.email && !d.phone)) return { created: false };
  const row = {
    name: d.name || null, title: d.title || null, role: d.title || null,
    company: d.company || null, email: (d.email || '').toLowerCase() || null,
    phone: d.phone || null, address: d.address || null,
    source: 'signature', receives_referrals: false,
    notes: d.type ? ('Type: ' + d.type) : null,
  };
  try { await sbPost('contacts', row); }
  catch (e) { console.error('  contact insert failed: ' + e.message); return { created: false }; }
  try { await sbPost('audit_log', { case_id: null, action: 'contact_scraped', detail: `${d.name || ''}${d.company ? (' — ' + d.company) : ''}`.trim(), source: 'automation' }); } catch (e) {}
  return { created: true, name: d.name, company: d.company };
}

// ── Website → provider draft: fetch a practice site, extract with Claude, land it in the Sign-ups queue ──
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
async function fetchPage(url) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MDconcierge-Importer/1.0)' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(to); }
}
function findSubpages(html, baseUrl) {
  const out = new Set(); let base;
  try { base = new URL(baseUrl); } catch (e) { return []; }
  const re = /href\s*=\s*["']([^"'#]+)["']/gi; let m;
  while ((m = re.exec(html)) && out.size < 30) {
    let href = m[1]; if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (!/(provider|physician|doctor|our-?team|staff|locations?|offices?|services?|about|specialt|find-?a-?)/i.test(href)) continue;
    try { const u = new URL(href, base); if (u.hostname === base.hostname) out.add(u.origin + u.pathname); } catch (e) {}
  }
  return [...out].filter(u => u !== baseUrl).slice(0, 4);
}
async function extractPractice(combinedText, url) {
  const prompt = `You are extracting a MEDICAL PRACTICE's details from the text of its public website, to onboard them into a medical-legal coordination network. Be accurate; use "" or [] when something isn't clearly stated. Do NOT invent doctors, phone numbers, or services.

Website: ${url}
Site text (may include multiple pages):
${combinedText.slice(0, 16000)}

Return ONLY this JSON (no prose, no code fence):
{
 "practice": {"name":"", "specialty":"", "states":"", "address":"", "website":"${url}", "phone":""},
 "providers": [{"doctor_name":"", "specialty":"", "provider_type":"", "phone":"", "fax":""}],
 "contacts": [{"name":"", "role":"", "email":"", "phone":"", "receives_referrals": true}],
 "services": [],            // e.g. "Orthopaedics","Pain Management","Physical Therapy on-site","MRI on-site","Imaging on-site","Chiropractic","Surgery"
 "locations": [],           // office addresses if multiple
 "confidence": "high|medium|low"
}
Rules: provider_type is one of Orthopaedic Surgeon, Pain Management, Physical Therapy, Chiropractic, Neurology, Imaging / Radiology, Primary Care, Podiatry, Other. List EVERY doctor you can find by name. For services, note especially if they advertise PT on-site, MRI/imaging on-site, or surgery. Put the main office phone in practice.phone and, if there's a general intake/referral email, add it as a contact with receives_referrals true.`;
  const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1800, messages: [{ role: 'user', content: prompt }] });
  let txt = (m.content?.[0]?.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(txt);
}
async function processImportJobs() {
  if (!SVC) return;
  let jobs = [];
  try { jobs = await sbGet(`import_jobs?select=*&status=eq.pending&order=created_at.asc`); }
  catch (e) { console.error('import: query failed: ' + e.message); return; }
  for (const job of jobs) {
    try {
      let url = String(job.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const mainHtml = await fetchPage(url);
      const subs = findSubpages(mainHtml, url);
      const texts = [htmlToText(mainHtml)];
      for (const s of subs) { try { texts.push(htmlToText(await fetchPage(s))); } catch (e) {} }
      const combined = texts.join('\n--- PAGE ---\n');
      const ex = await extractPractice(combined, url);
      const payload = {
        practice: ex.practice || { website: url },
        providers: Array.isArray(ex.providers) ? ex.providers.filter(d => d && d.doctor_name) : [],
        contacts: Array.isArray(ex.contacts) ? ex.contacts.filter(c => c && (c.name || c.email)) : [],
        services: Array.isArray(ex.services) ? ex.services : [],
        locations: Array.isArray(ex.locations) ? ex.locations : [],
        submitter: { name: 'Website import', email: '' },
        source_url: url,
      };
      const org = (ex.practice && ex.practice.name) || url.replace(/^https?:\/\//, '').split('/')[0];
      const sub = await sbPost('signup_submissions', {
        type: 'provider', payload, org_name: org, submitter_email: '',
        flagged_reason: 'Imported from website — verify details before approving',
      });
      // fetch the new submission id (sbPost returns minimal); look it up by org + recent
      let subId = null;
      try { const rows = await sbGet(`signup_submissions?select=id&org_name=eq.${encodeURIComponent(org)}&order=created_at.desc&limit=1`); subId = rows[0] && rows[0].id; } catch (e) {}
      await sbPatch(`import_jobs?id=eq.${job.id}`, { status: 'done', submission_id: subId, result: ex, done_at: new Date().toISOString() });
      try { await sbPost('audit_log', { case_id: null, action: 'website_imported', detail: `${org} (${(payload.providers || []).length} doctors)`, source: 'automation' }); } catch (e) {}
      console.log(`  imported ${org} from ${url} -> submission ${subId} (${payload.providers.length} doctors)`);
    } catch (e) {
      await sbPatch(`import_jobs?id=eq.${job.id}`, { status: 'error', error: String(e.message || e).slice(0, 300), done_at: new Date().toISOString() });
      console.error(`  import job ${job.id} (${job.url}) failed: ${e.message}`);
    }
  }
}

// ── Magic-link portal access: email a registered partner a passwordless sign-in link ──
async function sendPortalLinks() {
  if (!SVC) return;
  let reqs = [];
  try { reqs = await sbGet(`portal_link_requests?select=*&status=eq.pending`); }
  catch (e) { console.error('portal-links: query failed: ' + e.message); return; }
  for (const r of reqs) {
    try {
      const accts = await sbGet(`portal_accounts?select=*&id=eq.${r.account_id}&status=eq.active`);
      const a = accts[0];
      if (a && a.email && /@/.test(a.email)) {
        const key = randomBytes(24).toString('hex');              // fresh key each request → prior links expire
        await sbPatch(`portal_accounts?id=eq.${a.id}`, { login_key: key });
        const link = 'https://mdconcierge.net/portal.html?key=' + key;
        const text = `Hello${a.name ? (' ' + a.name) : ''},\n\nHere's your secure sign-in link for the MDconcierge portal — just click to see your cases (no password needed):\n\n${link}\n\nThis link is just for you. If you didn't request it, you can safely ignore this email.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
        await sendMail(a.email, 'Your MDconcierge sign-in link', text, emailHtml(text, [{ label: '🔓 Open my portal', href: link, color: '#c8922a', text: '#1a1305' }]));
        console.log(`  portal sign-in link sent to ${a.email}`);
      }
      await sbPatch(`portal_link_requests?id=eq.${r.id}`, { status: 'sent', sent_at: new Date().toISOString() });
    } catch (e) { console.error(`  portal link ${r.id} failed: ${e.message}`); }
  }
}

// ── Self-service profile edits: notify Eric (no approval) + confirm the editor ──
async function sendProfileChangeNotices() {
  if (!SVC) return;
  let changes = [];
  try { changes = await sbGet(`profile_changes?select=*&status=eq.pending`); }
  catch (e) { console.error('profile-notices: query failed: ' + e.message); return; }
  let sent = 0;
  for (const ch of changes) {
    try {
      // Eric is notified IN THE DASHBOARD (a 🔔 bell reading profile_changes), not by email — per his request.
      // Here we only send the editor their confirmation, then mark the row as editor-notified.
      if (ch.editor_email && /@/.test(ch.editor_email)) {
        const confText = `Hello${ch.editor_name ? (' ' + ch.editor_name) : ''},\n\nThis confirms your MDconcierge information was updated successfully — ${ch.summary.toLowerCase()}. The changes are now live. If you didn't make this change, please reply to this email right away.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
        await sendMail(ch.editor_email, 'Your MDconcierge info was updated', confText, emailHtml(confText, []));
      }
      await sbPatch(`profile_changes?id=eq.${ch.id}`, { status: 'sent', sent_at: new Date().toISOString() });
      sent++;
      console.log(`  profile-change notice sent (${ch.role}: ${ch.editor_email})`);
    } catch (e) { console.error(`  profile notice ${ch.id} failed: ${e.message} — left pending for retry.`); }
  }
  if (sent) console.log(`Profile-change notices sent: ${sent}.`);
}

// ── Partner portal: AI as traffic cop — auto-invite ONLY on-file parties, hold free-domain for Eric ──
// Safety: an account is auto-linked to one provider/attorney (or just an email) and the scoped
// SECURITY DEFINER RPCs return ONLY that party's cases — a wrong account sees nothing it shouldn't.
function portalDomainHold(email) {
  const d = (String(email || '').split('@')[1] || '').toLowerCase();
  return FREE_DOMAINS.includes(d) || !d; // free / no domain → hold for Eric to confirm
}
async function ensurePortalAccount(role, recordId, email, name, practiceId) {
  if (!SVC) return null;
  const em = String(email || '').trim().toLowerCase();
  if (!em || !/@/.test(em)) return null;
  let existing = [];
  try { existing = await sbGet(`portal_accounts?select=id,status&email=eq.${encodeURIComponent(em)}`); } catch (e) { return null; }
  if (existing.length) return null; // already invited / active / held / disabled — never spam a second invite
  const hold = portalDomainHold(em);
  const setup = randomBytes(24).toString('hex');
  const row = {
    role, email: em, name: name || null,
    setup_token: setup, setup_exp: daysFromNow(PORTAL_SETUP_TTL_DAYS),
    status: hold ? 'hold' : 'invited',
    flagged_reason: hold ? 'free-domain email — confirm identity before granting access' : null,
  };
  // provider accounts scope by PRACTICE when the provider belongs to one (front desk sees every doctor);
  // solo providers (no practice) fall back to the single provider_id.
  if (role === 'provider') { row.provider_id = recordId || null; row.practice_id = practiceId || null; }
  if (role === 'attorney') row.attorney_id = recordId || null;
  try { await sbPost('portal_accounts', row); }
  catch (e) { console.error('  portal account create failed: ' + e.message); return null; }
  try { await sbPost('audit_log', { case_id: null, action: 'portal_account_created', detail: `${role} ${em}${hold ? ' (held: free domain)' : ''}`, source: 'automation' }); } catch (e) {}
  return hold ? { held: true, email: em } : { held: false, email: em, link: `https://mdconcierge.net/portal.html?setup=${setup}` };
}
async function sendPortalInvite(role, recordId, email, name, practiceId) {
  const r = await ensurePortalAccount(role, recordId, email, name, practiceId);
  if (!r) return;                       // existing account → nothing to do
  if (r.held) { console.log(`  portal invite HELD (free domain) for ${role} ${r.email} — review in dashboard.`); return; }
  const what = role === 'provider' ? 'your MDconcierge referrals' : "the cases we're coordinating for your clients";
  const text = `Hello${name ? (' ' + name) : ''},\n\nYou can now manage ${what} from one secure portal — no more searching your inbox for the right link. Set a password below and you'll be able to sign in anytime to see your cases and act on them.\n\nThis setup link is unique to you and expires in ${PORTAL_SETUP_TTL_DAYS} days. If you weren't expecting this, you can safely ignore it.\n\nWith gratitude,\nThe MDconcierge Coordination Team`;
  try {
    await sendMail(r.email, 'Set up your MDconcierge portal login', text, emailHtml(text, [{ label: '🔐 Set up my login', href: r.link, color: '#c8922a', text: '#1a1305' }]));
    console.log(`  portal invite sent to ${role} ${r.email}`);
  } catch (e) { console.error('  portal invite send failed: ' + e.message); }
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
        // Signature import: Eric forwards a business email from @mdconcierge.net with subject starting "Contact"
        if (/^\s*contacts?\b/i.test(subject) && /@mdconcierge\.net\s*$/i.test(fromAddr) && SVC) {
          try {
            const res = await scrapeSignature(fromAddr, subject, body);
            console.log(res.created ? `Scraped contact: ${res.name || ''}${res.company ? (' — ' + res.company) : ''}` : `Contact email had no extractable signature — "${subject}"`);
          } catch (e) { console.error('  contact scrape failed: ' + e.message); }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          continue;
        }
        // Phase F: a reported case event ("Report UR/IME/IRE — <ref>") -> log an event, don't create a lead
        const repM = subject.match(/\breport\s+(UR|IME|IRE)\b/i);
        if (repM) {
          const type = repM[1].toUpperCase();
          const refM = (subject + ' ' + body).match(/\b([A-Z]{2,4}-[A-Z]-\d{4}-\d+)\b/i);
          if (refM && SVC) {
            try {
              const cs = (await sbGet(`cases?select=id&case_id=eq.${refM[1].toUpperCase()}`))[0];
              if (cs) {
                const dlM = body.match(/deadline[^:]*:\s*([^\n|]+)/i);
                await sbPost('events', { case_id: cs.id, event_type: type, actor: 'attorney', note: 'Reported via email by ' + fromAddr, deadline: dlM ? dlM[1].trim() : null, status: 'open', notified: false });
                console.log(`Logged ${type} event for ${refM[1]} (reported by ${fromAddr})`);
              } else { console.log(`Report email for unknown ref ${refM[1]} — left for manual review.`); }
            } catch (e) { console.error('  report-event log failed: ' + e.message); }
          } else { console.log(`Report email with no case ref — "${subject}"`); }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          continue;
        }
        const docRefM = (subject + ' ' + body).match(/\b([A-Z]{2,4}-[A-Z]-\d{4}-\d+)\b/i);
        // Phase E(b): inbound document(s) for a known case -> forward to the counterparty (conduit; never stored)
        const docs = (parsed.attachments || []).filter(a => a && a.content && (a.filename || (a.size || 0) > 2048));
        if (docs.length && docRefM && SVC) {
          let fcs = null;
          try { fcs = (await sbGet(`cases?select=*&case_id=eq.${docRefM[1].toUpperCase()}`))[0]; } catch (e) {}
          if (fcs) {
            try {
              const res = await forwardDocuments(fcs, fromAddr, subject, body, docs);
              if (res.forwarded) console.log(`Forwarded ${docs.length} document(s) for ${fcs.case_id} -> ${res.role} (not retained).`);
              else console.log(`Document for ${fcs.case_id} not auto-forwarded (${res.reason}) — flagged for manual handling.`);
            } catch (e) { console.error(`  doc forward failed for ${fcs.case_id}: ${e.message} — left unread for retry.`); continue; }
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            continue;
          }
        }
        // Phase E: a "SENT:" confirmation (no attachment) -> mark the requested artifact transmitted
        const sentM = subject.match(/^\s*SENT:\s*(.+?)\s*[—-]+\s*([A-Z]{2,4}-[A-Z]-\d{4}-\d+)/i);
        if (sentM && SVC) {
          try {
            const scs = (await sbGet(`cases?select=id&case_id=eq.${sentM[2].toUpperCase()}`))[0];
            if (scs) { await markArtifactTransmitted(scs.id, sentM[1].trim()); console.log(`Marked artifact transmitted (sent direct) for ${sentM[2]}.`); }
          } catch (e) { console.error('  sent-confirm failed: ' + e.message); }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          continue;
        }
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
            const ackBtns = [mailtoBtn('Reply to coordinate', `Re: referral — ${pName} (${payload.case_id})`, `Hello,\n\nRegarding ${pName} (${payload.case_id}):\n\n`)];
            if (payload.status_token) ackBtns.unshift(statusBtn(payload.status_token));
            const ackHtml = emailHtml(replyText, ackBtns, caseFooter(payload.case_id));
            await sendReply(fromAddr, subject, replyText, ackHtml, msg.envelope?.messageId);
            console.log(`  ↳ acknowledged ${fromAddr}`);
            await sendPortalInvite('attorney', payload.attorney_id || null, fromAddr, extracted && extracted.referring_contact); // first-time only; free domains held
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
  await announceInNetworkReferrals();
  await notifyRoutedProviders();
  await followUpRouted();
  await relayAppointments();
  await escalateUnreachable();
  await emailArtifactRequests();
  await handleEvents();
  await sendSignupInvites();
  await sendProfileChangeNotices();
  await sendPortalLinks();
  await processImportJobs();
  await ensureGaps();
  await forwardCompletedInfo();
  await chaseGaps();
  console.log(`Done. Created ${created} lead(s), skipped ${skipped} non-referral(s).`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
