// Packet access requests: nag Eric until he decides, and let him decide from the email.
//
// When someone Jackie (or any recipient) forwards a packet to asks for access, doc-access writes a
// quote_links row with note 'ACCESS REQUEST' and revoked = true, and emails Eric once. That single
// email is easy to lose, and nothing else ever mentions it again.
//
// This runs on a schedule and does two things:
//   1. While anything is pending, it emails and pushes every run. It does not stop until decided.
//   2. It reads Eric's inbox for a reply of "APPROVE <token>" or "DENY <token>" and acts on it,
//      so the nag email's two links are the whole interface: tap, send, done.
//
// Approving sets revoked = false, which is exactly what the gate checks. Denying deletes the row.
// Nothing here can touch a live recipient link: every write is filtered to note = 'ACCESS REQUEST'.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import webpush from 'web-push';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY: SVC, ZOHO_USER, ZOHO_APP_PASSWORD,
        ERIC_APP_PASSWORD, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT } = process.env;
const ERIC = ZOHO_USER || 'eric@mdconcierge.net';
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
const PENDING = "quote_links?note=eq.ACCESS%20REQUEST&revoked=is.true&select=*&order=created_at.asc";

const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com', port: 465, secure: true,
  auth: { user: ZOHO_USER, pass: ZOHO_APP_PASSWORD },
});

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ago = ts => {
  const h = Math.floor((Date.now() - new Date(ts).getTime()) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  const d = Math.floor(h / 24);
  return d + ' day' + (d === 1 ? '' : 's') + ' ago';
};

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

// Both writes are pinned to note = 'ACCESS REQUEST' so a stray token can never alter a real link.
async function approve(token, name) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/quote_links?token=eq.${token}&note=eq.ACCESS%20REQUEST`,
    { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ revoked: false, note: `APPROVED ${new Date().toISOString().slice(0, 10)} by reply` }) });
  const rows = r.ok ? await r.json() : [];
  if (rows.length) console.log(`  approved ${name || token}`);
  return rows.length > 0;
}

async function deny(token, name) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/quote_links?token=eq.${token}&note=eq.ACCESS%20REQUEST`,
    { method: 'DELETE', headers: { ...H, Prefer: 'return=representation' } });
  const rows = r.ok ? await r.json() : [];
  if (rows.length) console.log(`  denied ${name || token}`);
  return rows.length > 0;
}

async function pushNotify(title, body) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:eric@mdconcierge.net', VAPID_PUBLIC, VAPID_PRIVATE);
    let subs = [];
    try { subs = await sbGet('push_subscriptions?select=endpoint,subscription'); } catch (e) { return; }
    const payload = JSON.stringify({ title, body, url: '/admin-v2.html', tag: 'mdc-access' });
    for (const s of subs || []) {
      try { await webpush.sendNotification(s.subscription, payload); } catch (e) {}
    }
  } catch (e) { console.error('  push failed: ' + e.message); }
}

// ---- 1. read replies first, so anything he has already decided drops out of this run's nag ----
async function readDecisions() {
  if (!ERIC_APP_PASSWORD) { console.log('no inbox password, skipping reply scan'); return; }
  const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true,
    auth: { user: ERIC, pass: ERIC_APP_PASSWORD }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });   // never modify the mailbox
  let acted = 0;
  try {
    const total = client.mailbox?.exists || 0;
    for await (const msg of client.fetch(`${Math.max(1, total - 40)}:*`, { source: true, envelope: true })) {
      const from = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
      if (from !== ERIC.toLowerCase()) continue;                            // only Eric decides
      const parsed = await simpleParser(msg.source);
      const text = `${parsed.subject || ''} ${parsed.text || ''}`;
      for (const m of text.matchAll(/\b(APPROVE|DENY)\s+([0-9a-f]{32})\b/gi)) {
        const ok = m[1].toUpperCase() === 'APPROVE'
          ? await approve(m[2].toLowerCase()) : await deny(m[2].toLowerCase());
        if (ok) acted++;
      }
    }
  } finally { lock.release(); await client.logout(); }
  if (acted) console.log(`acted on ${acted} decision${acted === 1 ? '' : 's'} from the inbox`);
}

// ---- 2. nag on whatever is still undecided ----
async function nag() {
  const pending = await sbGet(PENDING);
  if (!pending.length) { console.log('nothing pending'); return; }

  const one = pending.length === 1;
  const subject = one
    ? `Waiting on you: ${pending[0].recipient_name} wants the ${String(pending[0].program || '').toUpperCase()} packet`
    : `Waiting on you: ${pending.length} people want packet access`;

  const line = r => `${r.recipient_name} · ${r.practice || 'no company given'}\n` +
    `${r.recipient_email}\n` +
    `asked ${ago(r.created_at)} for the ${String(r.program || '').toUpperCase()} packet\n\n` +
    `  Approve:  reply with   APPROVE ${r.token}\n` +
    `  Turn down: reply with  DENY ${r.token}\n`;

  const text = (one ? 'Someone has asked for access to a packet and is waiting on you.\n\n'
                    : `${pending.length} people have asked for access and are waiting on you.\n\n`)
    + pending.map(line).join('\n----------------------------------------\n\n')
    + `\nThey were told you have to approve it. Until you do, they see nothing.\n`
    + `This will keep reminding you until each one is decided.`;

  const card = r => `<tr><td style="padding:14px 16px;border:1px solid #DFE4EC;border-radius:10px;">
      <div style="font:600 15px/1.4 system-ui,sans-serif;color:#12203A;">${esc(r.recipient_name)}</div>
      <div style="font:400 13px/1.5 system-ui,sans-serif;color:#5C6A82;">${esc(r.practice || 'no company given')}<br>
        ${esc(r.recipient_email)}<br>
        asked ${esc(ago(r.created_at))} &middot; ${esc(String(r.program || '').toUpperCase())} packet</div>
      <div style="margin-top:11px;">
        <a href="mailto:${ERIC}?subject=${encodeURIComponent('APPROVE ' + r.token)}&body=${encodeURIComponent('APPROVE ' + r.token)}"
           style="display:inline-block;padding:9px 18px;background:#08214C;color:#fff;text-decoration:none;
                  border-radius:8px;font:700 13px system-ui,sans-serif;">Approve</a>
        <a href="mailto:${ERIC}?subject=${encodeURIComponent('DENY ' + r.token)}&body=${encodeURIComponent('DENY ' + r.token)}"
           style="display:inline-block;padding:9px 16px;margin-left:8px;color:#9B3B2E;text-decoration:none;
                  border:1px solid #DFE4EC;border-radius:8px;font:600 13px system-ui,sans-serif;">Turn down</a>
      </div></td></tr>`;

  const html = `<div style="max-width:560px;font:400 14px/1.6 system-ui,sans-serif;color:#12203A;">
    <p style="margin:0 0 14px;">${one ? 'Someone has asked for access to a packet and is waiting on you.'
                                      : pending.length + ' people have asked for access and are waiting on you.'}</p>
    <table style="border-collapse:separate;border-spacing:0 10px;width:100%;">${pending.map(card).join('')}</table>
    <p style="margin:14px 0 0;color:#5C6A82;font-size:13px;">
      Tap a button and send the email that opens; nothing else is needed. They were told you have to
      approve it, and until you do they see nothing. This will keep reminding you until each one is decided.</p>
  </div>`;

  await transporter.sendMail({
    from: `MDconcierge <${ZOHO_USER}>`, to: ERIC, subject, text, html,
    headers: { 'X-MDC-Auto': 'access-nag' },
  });
  await pushNotify(one ? 'Packet access request' : `${pending.length} packet access requests`,
    one ? `${pending[0].recipient_name} is waiting on you` : 'People are waiting on you to approve');
  console.log(`nagged on ${pending.length} pending request${pending.length === 1 ? '' : 's'}`);
}

if (!SUPABASE_URL || !SVC) { console.error('missing Supabase env'); process.exit(1); }
try { await readDecisions(); } catch (e) { console.error('reply scan failed: ' + e.message); }
await nag();
