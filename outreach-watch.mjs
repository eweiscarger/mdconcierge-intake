// outreach-watch.mjs — dead-man alarm for the outreach sender.
//
// Why this exists: from 17 to 23 Sep 2026 the send path returned HTTP 500 on every attempt for SIX
// DAYS and nobody found out. Nothing in the engine was watching. watchdog.mjs is a dead-man switch
// for REFERRAL INTAKE only - it reads system_health.last_run_at, which is written by intake.mjs and
// by nothing else, so outreach could be dead for a week and the watchdog would report a healthy
// engine the whole time. morning-report.mjs runs every morning but cannot tell the difference
// either: it says "Nothing went out this morning" for a crashed sender AND for a genuinely quiet
// day, in the same words, so six broken mornings read exactly like six quiet ones.
//
// The whole point of this file is that a FAILED run must not look like a QUIET one. It reads the
// outbox, works out which of four states the morning is actually in, and only shouts when the
// evidence says mail should have left and did not:
//
//   HEALTHY: NOTHING DUE          nothing was eligible and nothing went - a real quiet day
//   HEALTHY: SENT N               mail left the building - the sender works
//   FAILURE: N ELIGIBLE, 0 SENT   rows were due, the window opened and closed, nothing sent
//   WARNING: N STRANDED IN HELD   approved rows (proofed=true) stuck in held, which nothing
//                                 returns to pending, so they can never send at all
//
// Runs as its own workflow, after the send window has closed, so a sender crash cannot silence it.
// Outbound goes through the shared capped transport - see mailer.mjs for why.
import { transporter } from './mailer.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
// DRY_RUN prints the alarm it WOULD raise and sends nothing. This is how the alarm gets tested
// without a single email reaching a physician or Eric.
const DRY_RUN = !!process.env.DRY_RUN || process.argv.includes('--dry-run');
const THROTTLE_HOURS = Number(process.env.OUTREACH_WATCH_THROTTLE_HOURS || 6);

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env: ' + k); process.exit(1); }
}
if (!ERIC_PASS && !DRY_RUN) console.error('WARNING: no mailbox password in env - an alarm would have nothing to send through.');

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };

// This THROWS. It does not return [].
//
// Every other script in this repo reads Supabase with `const get = async (p) => { const r = await
// fetch(...); return r.ok ? r.json() : []; }`. That one line is the root cause being fixed here: a
// dead database, an expired key or a 500 comes back as an empty array, an empty array means "no
// rows were due", and "no rows were due" is indistinguishable from a quiet morning. An alarm built
// on that pattern would have reported six healthy days through the outage it exists to catch. A
// monitor that cannot read its own evidence must fail loudly, never reassuringly.
const get = async (p) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

// ---- Eastern time helpers ----------------------------------------------------------------------
// Everything the engine schedules is computed in the physician's timezone, and Eric's morning is
// the morning that matters, so "today" and "has the window closed" are both asked in Eastern and
// never in the runner's UTC. Same approach as morning-report.mjs.
const etParts = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
}).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});

const easternMidnight = () => {
  const now = new Date();
  const p = etParts(now);
  const offsetMs = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - now.getTime();
  return new Date(Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`) - offsetMs);
};

const P = etParts();
const todayET = `${P.year}-${P.month}-${P.day}`;
const nowMinutesET = Number(P.hour) * 60 + Number(P.minute);
// send_windows.days uses ISO weekday numbers: Monday 1 ... Sunday 7 (the live config carries
// [1,2,3,4,5] for the before-clinic window and [4] for the Thursday evening test).
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const dowET = DOW[P.weekday] || 0;
const hhmm = (s) => {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

async function main() {
  // Weekends never alarm. The cadence does not send on Saturday or Sunday, so an empty Saturday is
  // the system working, and an alarm every weekend is an alarm nobody reads by the third week.
  if (dowET >= 6) { console.log(`outreach-watch: ${todayET} is a weekend in Eastern. Nothing to check.`); return; }

  // The windows are configuration, not a constant. Reading them means the day Eric moves the send
  // time, the alarm moves with it instead of shouting at 09:00 about a window that now closes at 11.
  const cfg = (await get('outreach_config?select=send_windows,sending_paused,pause_reason,sending_enabled&id=eq.1'))[0] || {};
  const windows = Array.isArray(cfg.send_windows) && cfg.send_windows.length
    ? cfg.send_windows
    // Only if the config row has lost its windows entirely. The live value is 06:30-07:30 ET Mon-Fri.
    : [{ start: '06:30', end: '07:30', days: [1, 2, 3, 4, 5], label: 'Before clinic (fallback)' }];

  // A window that has OPENED AND CLOSED today is the evidence that mail had its chance. Only the
  // closed ones count: the config also carries a Thursday 20:00-20:45 evening window, and requiring
  // every window to be shut would mean no Thursday could ever raise an alarm at 09:00.
  const todays = windows.filter((w) => !Array.isArray(w.days) || w.days.includes(dowET));
  const closed = todays.filter((w) => { const e = hhmm(w.end); return e !== null && nowMinutesET >= e; });
  const windowClosed = closed.length > 0;

  // Sending deliberately switched off is not a failure, and Eric already knows he did it.
  const paused = cfg.sending_paused === true;

  const [eligible, sentToday, stranded, lastSentRows] = await Promise.all([
    // Due and still waiting: these are the rows that prove mail SHOULD have gone.
    get(`mdrx_outbox?select=id,provider_id,touch_no,to_email,subject,scheduled_date,proofed&status=eq.pending&scheduled_date=lte.${todayET}&order=scheduled_date.asc&limit=500`),
    // What actually left today, read from the outbox rather than from any job's own claim of success.
    get(`mdrx_outbox?select=id,to_email,sent_at&status=eq.sent&sent_at=gte.${easternMidnight().toISOString()}&limit=500`),
    // Approved emails in held. Nothing in this repo moves a held row back to pending, so a proofed
    // row sitting in held is not waiting for anything - it is dead, and it will stay dead silently.
    get('mdrx_outbox?select=id,provider_id,touch_no,to_email,scheduled_date&status=eq.held&proofed=is.true&order=scheduled_date.asc&limit=500'),
    get('mdrx_outbox?select=id,to_email,sent_at&status=eq.sent&sent_at=not.is.null&order=sent_at.desc&limit=1'),
  ]);

  const lastSent = lastSentRows[0];
  const lastSentTxt = lastSent
    ? `${String(lastSent.sent_at).slice(0, 10)} (row #${lastSent.id} to ${lastSent.to_email})`
    : 'never - there is no sent row on record at all';

  // ---- EXACTLY one state -----------------------------------------------------------------------
  // Ordered by how much it costs to miss. A sender that is down outranks a queue that is stuck,
  // which outranks a morning that went fine. The counts for the other three are printed on the
  // status line regardless, so choosing one state never hides the rest.
  let state, subject, body;

  if (eligible.length > 0 && sentToday.length === 0 && windowClosed && !paused) {
    state = 'FAILURE';
    subject = `OUTREACH FAILURE: ${eligible.length} eligible, 0 sent`;
    body = [
      `${eligible.length} emails were due to go out today and NOT ONE of them sent.`,
      '',
      `The send window (${closed.map((w) => `${w.start}-${w.end} ET`).join(', ')}) opened and closed. The outbox says nothing left.`,
      `Last successful send: ${lastSentTxt}`,
      '',
      'The rows that should have gone:',
      '',
      ...eligible.slice(0, 40).map((r) => `  #${r.id}  touch ${r.touch_no}  ${r.to_email}  due ${r.scheduled_date}${r.proofed ? '' : '  (NOT proofed)'}`),
      ...(eligible.length > 40 ? ['', `  ...and ${eligible.length - 40} more.`] : []),
      '',
      // Spread rather than a '' placeholder plus a filter: filtering empty strings to drop this one
      // optional line also stripped every deliberate blank line and sent the whole alarm as a wall.
      ...(stranded.length ? [`Separately, ${stranded.length} approved emails are stranded in held and can never send.`, ''] : []),
      'Check the sender first:',
      'https://github.com/eweiscarger/mdconcierge-intake/actions/workflows/auto-send.yml',
      'The send-outreach function returning anything but 200 is the thing to look at.',
      '',
      'This alarm exists because on 17-23 Sep 2026 the sender returned HTTP 500 on every attempt',
      'for six days and nothing told anybody. A failed morning used to read exactly like a quiet one.',
    ].join('\n');
  } else if (stranded.length > 0) {
    state = 'WARNING';
    subject = `OUTREACH WARNING: ${stranded.length} stranded in held`;
    body = [
      `${stranded.length} emails are sitting in held with proofed=true.`,
      '',
      'These were approved. Nothing in the engine ever moves a held row back to pending, so they',
      'are not queued for later - they will never send, and no report mentions them again.',
      '',
      `Last successful send: ${lastSentTxt}`,
      '',
      ...stranded.slice(0, 40).map((r) => `  #${r.id}  touch ${r.touch_no}  ${r.to_email}  was due ${r.scheduled_date}`),
      ...(stranded.length > 40 ? ['', `  ...and ${stranded.length - 40} more.`] : []),
      '',
      'Either release them or clear them, but they should not sit there looking like a queue.',
    ].join('\n');
  } else if (sentToday.length > 0) {
    state = 'HEALTHY_SENT';
  } else {
    state = 'HEALTHY_NOTHING_DUE';
  }

  // One line that says which of the four it is, with the evidence behind it, so a run read in the
  // Actions log is never ambiguous about what it found.
  const detail = `eligible=${eligible.length} sent_today=${sentToday.length} stranded=${stranded.length}`
    + ` window_closed=${windowClosed}${paused ? ' sending_paused=TRUE' : ''} last_send=${lastSentTxt}`;

  if (state === 'HEALTHY_SENT') {
    console.log(`HEALTHY: SENT ${sentToday.length} | ${detail}`);
    return;
  }
  if (state === 'HEALTHY_NOTHING_DUE') {
    // Said in full rather than as "nothing sent", which is the exact phrase that hid the outage.
    const why = paused ? 'sending is PAUSED in outreach_config'
      : !windowClosed ? 'the send window has not closed yet'
        : 'no rows were eligible';
    console.log(`HEALTHY: NOTHING DUE (${why}) | ${detail}`);
    return;
  }

  const line = state === 'FAILURE'
    ? `FAILURE: ${eligible.length} ELIGIBLE, 0 SENT`
    : `WARNING: ${stranded.length} STRANDED IN HELD`;
  console.error(`${line} | ${detail}`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN, nothing sent and nothing recorded ---');
    console.log('To: ' + ERIC_USER);
    console.log('Subject: ' + subject);
    console.log('');
    console.log(body);
    return;
  }

  await raise(state, subject, body, detail);
}

// Throttle, following the job_alerts pattern used by next-move.mjs and news-monitor.mjs: one row
// per job, last_alert_at stamped on each alert, upserted with merge-duplicates.
//
// The state is stored on the front of last_msg and compared, so the throttle silences a REPEAT of
// the same bad morning but never silences a CHANGE. A queue that has been stuck for a week going
// down hard is exactly the transition this alarm was built to report, and a plain six-hour timer
// would have swallowed it.
async function raise(state, subject, body, detail) {
  const rows = await get('job_alerts?select=last_alert_at,last_msg&job=eq.outreach-watch');
  const prev = rows[0] || {};
  const last = prev.last_alert_at ? new Date(prev.last_alert_at).getTime() : 0;
  const sameState = String(prev.last_msg || '').startsWith(state + ':');
  const ageH = last ? (Date.now() - last) / 3600000 : Infinity;
  if (sameState && ageH < THROTTLE_HOURS) {
    console.log(`Already alerted ${state} ${ageH.toFixed(1)}h ago (throttle ${THROTTLE_HOURS}h). Staying quiet.`);
    return;
  }

  const res = await transporter.sendMail({
    headers: { 'X-MDC-Bot': 'engine' },
    from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER,
    subject, text: body,
  });
  // The capped transport can refuse a send, and an alarm that was quietly capped is silence, which
  // is the failure mode this whole file exists to end. Say so loudly and fail the run.
  if (res && res.blocked) throw new Error('the mail cap BLOCKED the outreach alarm: ' + res.reason);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/job_alerts`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ job: 'outreach-watch', last_alert_at: new Date().toISOString(), last_msg: `${state}: ${detail}`.slice(0, 300) }),
  });
  if (!r.ok) throw new Error(`job_alerts upsert -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  console.log(`ALERT SENT: ${subject}`);
}

// Deliberately NOT the `catch -> console.warn -> process.exit(0)` pattern the other jobs use for
// transient errors. Those jobs can afford to skip a run; this one is the thing that notices when a
// run was skipped. If it cannot reach Supabase, cannot read the config or cannot send the alarm,
// the run must go RED in Actions rather than pass quietly and leave Eric believing he is covered.
// exitCode rather than process.exit(1): killing the process while a fetch or the SMTP socket is
// still unwinding makes Node abort with a libuv assertion and exit 127, which buries the actual
// reason under a crash dump. This still exits non-zero and still goes red in Actions.
main().catch((e) => {
  console.error('outreach-watch FAILED to check outreach: ' + (e?.stack || e?.message || e));
  process.exitCode = 1;
});
