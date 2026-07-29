// inbox-tidy.mjs — keeps eric@ free of machine mail. Runs on a schedule so it stays clean.
// DRY=1 lists what it would do and touches nothing. Without DRY it moves mail.
// Real human mail is never moved: anything not matching a rule stays put.
import { ImapFlow } from 'imapflow';

const USER = 'eric@mdconcierge.net';
const PASS = process.env.ERIC_PASS;
const DRY = process.env.DRY === '1';
if (!PASS) { console.error('set ERIC_PASS'); process.exit(1); }

const ENGINE = /MDconcierge engine|engine RECOVERED|engine may be DOWN|issue\(s\) this run|daily health check|FATAL error/i;
const TESTJUNK = /^(h|d|vv|test)$|Signature preview|CRM . send test|LIVETEST/i;
const BOUNCE_FROM = /mailer-daemon|mailerdaemon|postmaster|mail delivery/i;
const BOUNCE_SUBJ = /undeliverable|delivery status notification|failure notice|returned mail|delivery has failed|address not found|could ?n.?t be delivered|message not delivered/i;
const DMARC = /dmarc/i;
const CAL = /zohocalendar/i;

function route(from, subject) {
  if (ENGINE.test(subject)) return { folder: 'Trash', why: 'engine notification' };
  if (TESTJUNK.test(subject.trim())) return { folder: 'Trash', why: 'test email' };
  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subject)) return { folder: 'Trash', why: 'bounce notice' };
  if (DMARC.test(from) || DMARC.test(subject)) return { folder: 'Archive', why: 'DMARC report' };
  if (CAL.test(from)) return { folder: 'Notification', why: 'calendar notice' };
  return null;                                    // real mail: leave it alone
}

const client = new ImapFlow({ host: 'imap.zoho.com', port: 993, secure: true, auth: { user: USER, pass: PASS }, logger: false });
await client.connect();
const lock = await client.getMailboxLock('INBOX');
const plan = { Trash: [], Archive: [], Notification: [] };
const why = {};
let scanned = 0, kept = 0;
try {
  for await (const m of client.fetch('1:*', { envelope: true })) {
    scanned++;
    const env = m.envelope || {};
    const from = (env.from?.[0]?.address || '').toLowerCase();
    const subject = env.subject || '';
    const r = route(from, subject);
    if (!r) { kept++; continue; }
    plan[r.folder].push(m.uid);
    why[r.why] = (why[r.why] || 0) + 1;
  }
  console.log(`scanned ${scanned}, leaving ${kept} real message(s) in the inbox`);
  for (const [w, n] of Object.entries(why)) console.log(`  ${String(n).padStart(3)}  ${w}`);
  console.log('destinations:', Object.entries(plan).map(([f, u]) => `${f}=${u.length}`).join(', '));
  if (DRY) { console.log('\nDRY RUN, nothing moved.'); }
  else {
    for (const [folder, uids] of Object.entries(plan)) {
      if (!uids.length) continue;
      await client.messageMove(uids.join(','), folder, { uid: true });
      console.log(`moved ${uids.length} -> ${folder}`);
    }
  }
} finally { lock.release(); await client.logout(); }
