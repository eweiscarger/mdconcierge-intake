// MDRx inbox assistant (SEPARATE from the referrals@ engine).
// Reads eric@mdconcierge.net INBOX read-only, finds MDRx-related replies, drafts a reply
// in Eric's voice, and queues it in the mdrx_inbox_drafts table for Eric to approve/send.
// It SENDS NOTHING and never modifies the mailbox. Runs on a schedule via GitHub Actions.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
for (const [k, v] of Object.entries({ ERIC_PASS, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
async function sGet(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function sPost(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) console.error(`insert ${table} ${r.status}: ${await r.text()}`);
}

const NOISE = /dmarc|no-?reply|noreply|postmaster|mailer-daemon|notification/i;

async function draftReply(who, fromAddr, subject, body) {
  try {
    const prompt = `You are drafting a reply email for Eric Weiscarger, founder of MDconcierge, about the MDRx Workers' Compensation Pharmacy Program. Write ONLY the reply body, in Eric's voice.
RULES: brief and warm, peer to peer, sounds like a real person not a pitch. NO em dashes or en dashes ever, use periods or commas. Ranges in words like "20 to 30 minutes". Never mention commission. If naming the program use the full name "MDRx Workers' Compensation Pharmacy Program". Sign off with "Best," then a new line then "Eric". Natural, never templated. Never invent facts, numbers, names, or legal conclusions.
Replying to ${who} (${fromAddr}), subject "${subject}":
"""
${String(body || '').slice(0, 2500)}
"""
Write a concise, warm reply that moves things forward (answer their question and/or propose a simple next step such as a brief call). Return only the email body.`;
    const m = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 450, messages: [{ role: 'user', content: prompt }] });
    return (m.content?.[0]?.text || '').trim();
  } catch (e) { console.error('draft failed: ' + e.message); return ''; }
}

async function main() {
  const provs = await sGet('mdrx_providers?select=id,first_name,last_name,email&lead_type=eq.mdrx');
  const funnelP = await sGet('mdrx_providers?select=email&lead_type=eq.funnel');
  const funnelEmails = new Set((funnelP || []).map(p => (p.email || '').toLowerCase()).filter(Boolean));
  const existing = await sGet('mdrx_inbox_drafts?select=message_uid');
  const seen = new Set((existing || []).map(d => d.message_uid));
  const byEmail = {}; (provs || []).forEach(p => { if (p.email) byEmail[p.email.toLowerCase()] = p; });

  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true }); // read-only: never touch the mailbox
  let created = 0, scanned = 0;
  try {
    const total = client.mailbox?.exists || 0;
    const start = Math.max(1, total - 24);
    for await (const m of client.fetch(`${start}:*`, { envelope: true, source: true })) { // source uses BODY.PEEK, no \Seen
      scanned++;
      const env = m.envelope || {};
      const from = env.from?.[0] || {};
      const fromAddr = (from.address || '').toLowerCase();
      const subject = env.subject || '';
      const mid = env.messageId || ('uid:' + m.uid);
      if (seen.has(mid)) continue;
      if (NOISE.test(fromAddr) || fromAddr === 'referrals@mdconcierge.net' || fromAddr === 'eric@mdconcierge.net') continue;
      if (funnelEmails.has(fromAddr)) continue; // funnel leads are handled by funnel-reply.mjs
      const prov = byEmail[fromAddr];
      const isMdrx = /@mdrx360\.com$/i.test(fromAddr) || prov || /mdrx|workers.?comp|workers compensation|pharmacy program/i.test(subject);
      if (!isMdrx) continue;
      let bodyText = '';
      try { const parsed = await simpleParser(m.source); bodyText = (parsed.text || '').trim(); } catch (e) {}
      const who = prov ? ('Dr. ' + (prov.last_name || '')) : (from.name || fromAddr);
      const draft = created < 8 ? await draftReply(who, fromAddr, subject, bodyText) : '';
      await sPost('mdrx_inbox_drafts', {
        message_uid: mid, from_addr: fromAddr, from_name: from.name || '', subject,
        received_at: env.date || null, snippet: bodyText.replace(/\s+/g, ' ').slice(0, 400),
        draft_reply: draft, in_reply_to: mid, provider_id: prov ? prov.id : null, status: 'pending',
      });
      seen.add(mid); created++;
    }
  } finally { lock.release(); }
  await client.logout();
  console.log(`MDRx inbox scan: ${scanned} scanned, ${created} new draft(s) queued.`);
}

// Notify Eric ONLY on a genuine (non-transient) failure, at most once per 3 hours.
async function alertFailure(job, msg) {
  try {
    const rows = await sGet(`job_alerts?select=last_alert_at&job=eq.${job}`);
    const last = rows[0]?.last_alert_at ? new Date(rows[0].last_alert_at).getTime() : 0;
    if (Date.now() - last < 3 * 3600 * 1000) return; // throttle
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: `[MDconcierge] the ${job} job hit a problem`, text: `The ${job} job failed with a non-transient error:\n\n${msg}\n\nIt retries on its schedule. Check the GitHub Actions logs if it persists.` });
    await fetch(`${SUPABASE_URL}/rest/v1/job_alerts`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ job, last_alert_at: new Date().toISOString(), last_msg: msg.slice(0, 300) }) });
    console.log(`alerted Eric about ${job} failure`);
  } catch (e) { console.error('alertFailure error: ' + e.message); }
}

main().catch(async e => {
  const msg = String(e?.message || e);
  if (/greeting|connection|timeout|econnreset|econnrefused|enotfound|socket|network/i.test(msg)) {
    console.warn('Transient mail connection issue, skipping this run: ' + msg);
    process.exit(0); // transient blip, no alert
  }
  console.error('Fatal: ' + (e?.stack || e));
  await alertFailure('mdrx-inbox', msg);
  process.exit(0); // we alert Eric ourselves; do not also trigger a GitHub failure email
});
