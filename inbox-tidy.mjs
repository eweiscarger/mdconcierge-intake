// inbox-tidy.mjs — keeps eric@ tidy. Runs on a schedule so it stays that way.
//   INBOX : machine mail out (engine notices, test mail, bounces, DMARC, calendar).
//   Sent  : automated cadence sends out, so Sent holds only mail Eric actually wrote.
// Anything that does not match a rule is left exactly where it is. DRY=1 previews.
import { ImapFlow } from 'imapflow';

const USER = 'eric@mdconcierge.net';
const PASS = process.env.ERIC_PASS;
const DRY = process.env.DRY === '1';
if (!PASS) { console.error('set ERIC_PASS'); process.exit(1); }

const AUTOMATION_FOLDER = 'Automation';   // where cadence sends go to live
const ENGINE_FOLDER = 'Engine';           // where the machine's own notices go, out of the inbox

// ---- INBOX rules ----
// Written against what was actually sitting in the inbox on 2026-08-10 rather than guesses.
// Everything here is the machine talking to itself.
const ENGINE = /MDconcierge engine|engine RECOVERED|engine may be DOWN|issue\(s\) this run|daily health check|FATAL error|^\[MDconcierge\]|^Outreach sent:|fresh content ideas to review|DRY PREVIEW|^\[PREVIEW\]|^\[TEST\]/i;
// GitHub telling him a cron ran is the same category of noise.
const CI = /notifications@github\.com|noreply@github\.com/i;
// Deliberately NOT filed, because these are the reasons the inbox exists: "Hot lead: X just
// engaged", booking confirmations, hand-raises, dispensing analyses, referral chases, and
// anything a human sent.
const TESTJUNK = /^(h|d|vv|test)$|Signature preview|CRM . send test|LIVETEST/i;
// NOTE: bounce notices are deliberately NOT handled here. bounce-scan reads them, classifies
// the failure, suppresses or queues a retry, and trashes them itself once logged. This job used
// to trash them too and ran 5 minutes before it, deleting roughly half of each day's DSNs
// before they were ever classified.
const DMARC = /dmarc/i;
const CAL = /zohocalendar/i;

function routeInbox(from, subject, headerBlob) {
  // Authoritative: every operational agent stamps X-MDC-Bot. Sales notices are NOT stamped and
  // stay in the inbox, because a booking or a hand-raise is exactly what Eric wants to see.
  if (/x-mdc-bot/i.test(headerBlob || '')) return { folder: ENGINE_FOLDER, why: 'engine notice' };
  if (ENGINE.test(subject)) return { folder: ENGINE_FOLDER, why: 'engine notice, by subject' };
  if (CI.test(from)) return { folder: ENGINE_FOLDER, why: 'GitHub Actions notice' };
  if (TESTJUNK.test(subject.trim())) return { folder: 'Trash', why: 'test email' };
  if (DMARC.test(from) || DMARC.test(subject)) return { folder: 'Archive', why: 'DMARC report' };
  if (CAL.test(from)) return { folder: 'Notification', why: 'calendar notice' };
  return null;
}

// ---- Sent rules ----
// The X-MDC-Auto header is authoritative going forward. The subject list catches sends that
// went out before the header existed, plus the brief the request-info function mails itself.
const CADENCE_SUBJECTS = [
  /PA Court Opens Up Significant Revenue Opportunity for Physicians/i,
  /How physicians participate without running a pharmacy/i,
  /Where the PA ruling stops/i,
  /Closing the loop on the PA pharmacy ruling/i,
  /Pharmacy overview you asked for/i,
  /Pennsylvania Supreme Court Confirms Physicians May Have a Financial Interest/i,
];
function isAutomated(subject, headerBlob) {
  if (/x-mdc-auto/i.test(headerBlob || '')) return true;
  return CADENCE_SUBJECTS.some((re) => re.test(subject));
}

async function ensureFolder(client, name) {
  try { const list = await client.list(); if (list.some((b) => b.path === name || b.name === name)) return true; } catch (e) {}
  try { await client.mailboxCreate(name); console.log(`created folder ${name}`); return true; }
  catch (e) { console.error(`could not create ${name}: ${e.message}`); return false; }
}

// Several jobs share this mailbox, so Zoho sometimes refuses a new IMAP connection.
// Back off and retry; if it still will not connect, exit quietly and try again next run.
// This is housekeeping, so a missed cycle is not worth an alert.
const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
let connected = false;
for (let attempt = 1; attempt <= 4 && !connected; attempt++) {
  try { await client.connect(); connected = true; }
  catch (e) {
    console.log(`connect attempt ${attempt} failed: ${e.message}`);
    if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 20000));
  }
}
if (!connected) { console.log('mailbox busy, skipping this run.'); process.exit(0); }

// ---------- INBOX ----------
{
  await ensureFolder(client, ENGINE_FOLDER);
  const lock = await client.getMailboxLock('INBOX');
  const plan = { Trash: [], Archive: [], Notification: [], [ENGINE_FOLDER]: [] };
  const why = {}; let scanned = 0, kept = 0;
  try {
    for await (const m of client.fetch('1:*', { envelope: true, headers: ['x-mdc-bot'] })) {
      scanned++;
      const env = m.envelope || {};
      const hdr = m.headers ? m.headers.toString() : '';
      const r = routeInbox((env.from?.[0]?.address || '').toLowerCase(), env.subject || '', hdr);
      if (!r) { kept++; continue; }
      plan[r.folder].push(m.uid); why[r.why] = (why[r.why] || 0) + 1;
    }
    console.log(`INBOX: scanned ${scanned}, leaving ${kept} real message(s)`);
    for (const [w, n] of Object.entries(why)) console.log(`  ${String(n).padStart(3)}  ${w}`);
    if (!DRY) for (const [folder, uids] of Object.entries(plan)) {
      if (uids.length) { await client.messageMove(uids.join(','), folder, { uid: true }); console.log(`  moved ${uids.length} -> ${folder}`); }
    }
  } finally { lock.release(); }
}

// ---------- Sent ----------
{
  const ok = await ensureFolder(client, AUTOMATION_FOLDER);
  const lock = await client.getMailboxLock('Sent');
  const move = []; let scanned = 0, kept = 0;
  try {
    for await (const m of client.fetch('1:*', { envelope: true, headers: ['x-mdc-auto'] })) {
      scanned++;
      const subject = m.envelope?.subject || '';
      const hdr = m.headers ? m.headers.toString() : '';
      if (isAutomated(subject, hdr)) move.push(m.uid); else kept++;
    }
    console.log(`Sent: scanned ${scanned}, ${move.length} automated, leaving ${kept} that Eric wrote`);
    if (!DRY && ok && move.length) {
      await client.messageMove(move.join(','), AUTOMATION_FOLDER, { uid: true });
      console.log(`  moved ${move.length} -> ${AUTOMATION_FOLDER}`);
    }
  } finally { lock.release(); }
}

if (DRY) console.log('\nDRY RUN, nothing moved.');
await client.logout();
