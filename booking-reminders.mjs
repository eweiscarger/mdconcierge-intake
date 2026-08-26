// Meeting reminders for Eric. Two per booking: one the day before, one an hour before.
//
// Runs hourly. The day-before notice fires inside a window rather than at a fixed clock time, so a
// meeting booked late still gets one; the hour-before fires in the 45-90 minute band. Each is
// stamped on the booking row, so a re-run or an overlapping schedule cannot send it twice.
//
// It deliberately does NOT email the physician. Eric asked to be alerted; a surprise reminder to a
// doctor who booked fifteen minutes reads as pestering, and Zoho already sends the calendar invite.
import nodemailer from 'nodemailer';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ERIC = process.env.ZOHO_ERIC_USER || 'eric@mdconcierge.net';
const TZ = 'America/New_York';
const H = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' };

const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPatch = async (p, row) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) console.error(`patch ${p} ${r.status}: ${await r.text()}`);
};
const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(d);
// The calendar day in Eric's timezone, so "today" and "tomorrow" mean what he sees on his calendar
// rather than what UTC happens to say at the moment the cron runs.
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

const mailer = () => nodemailer.createTransport({
  host: 'smtp.zoho.com', port: 465, secure: true,
  auth: { user: ERIC, pass: process.env.ZOHO_ERIC_APP_PASSWORD },
});

async function notify(subject, html) {
  await mailer().sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC}>`, to: ERIC, subject, html, headers: { 'X-MDC-Auto': 'reminder' } });
}
async function mailPhysician(to, subject, html) {
  await mailer().sendMail({ from: `"Eric, MDconcierge" <${ERIC}>`, to, subject, html });
}

// ---------------------------------------------------------------------------
// The booking confirmation.
//
// booking-create sends this itself and stamps confirmed_at in the same insert. This pass exists
// for every OTHER way a booking can appear: put in by hand, moved, created from the Cockpit. Those
// used to reach the physician as a bare Zoho invite with no link, no context and no way to give a
// phone number, which is exactly what happened to the Bechtold call on 25 Aug 2026.
// ---------------------------------------------------------------------------
const SITE = 'https://mdconcierge.net';
// How to address them. "Lauren Bechtold, MD" and "Rishin Patel MD" both need to come out as
// "Dr. Bechtold", so strip the credentials before taking the surname rather than after, or the
// greeting reads "Dr. MD". Anyone without credentials keeps their first name.
function confirmName(b) {
  const CRED = '[,\\s]+(m\\.?d\\.?|d\\.?o\\.?|p\\.?a\\.?-?c?|c?rnp|n\\.?p\\.?|dpm|dds|phd|mba|facs)\\b';
  const raw = String(b.name || '');
  const bare = raw.replace(new RegExp(CRED, 'gi'), '').replace(/[,\s]+$/, '').trim();
  const hasCred = new RegExp(CRED, 'i').test(raw);   // fresh, non-global: .test() on a /g regex is stateful
  return /^(dr|mr|ms|mrs)\b/i.test(bare) ? bare
       : (hasCred && bare.includes(' ') ? `Dr. ${bare.split(/\s+/).pop()}`
       : (bare.split(' ')[0] || bare));
}
function confirmHtml(b) {
  const who = confirmName(b);
  const resched = `${SITE}/book.html${b.token ? '?p=' + encodeURIComponent(b.token) : ''}`;
  const go = (to) => b.token ? `${SITE}/go.html?p=${encodeURIComponent(b.token)}&amp;to=${to}` : `${SITE}/brief.html`;
  // What happens at the appointed time, so neither of them sits waiting for the other to move.
  const how = b.meeting_mode === 'phone'
    ? (b.phone
       ? `<p style="font-size:15px;"><b>I will call you at ${esc(b.phone)}.</b> Nothing for you to join or install.</p>`
       : `<p style="font-size:15px;"><b>This one is a phone call, so I will be the one calling.</b> I do not have a number for you yet. Feel free to reply with it, or <a href="${resched}">add it here</a>. That page also lets you switch to video if that is easier.</p>`)
    : (b.join_url
       ? `<p style="font-size:15px;"><b>We will meet by video.</b> <a href="${esc(b.join_url)}">Join from this link</a>, straight in your browser, nothing to download.</p>`
       : `<p style="font-size:15px;"><b>We will meet by video.</b> I will send the link before we speak. If you would rather I just call you, <a href="${resched}">add your number here</a>.</p>`);
  return `
  <div style="font-family:Inter,Arial,sans-serif;color:#14213D;max-width:560px;">
    <p>You're on my calendar, ${esc(who)}. Let's make our 15 minutes count.</p>
    <p><b>${esc(fmt(new Date(b.slot_start)))} Eastern</b></p>
    ${how}
    <p>Nothing to prepare. If you want a refresher beforehand, these take a minute each:</p>
    <ul style="line-height:1.7;">
      <li><a href="${go('program')}">How the program works</a>, one page</li>
      <li><a href="${go('siegel')}">Daniel Siegel's summary</a>, he argued the case before the Court</li>
      <li><a href="${go('gosfield')}">Alice Gosfield's opinion</a> on the structure</li>
    </ul>
    <p>Otherwise I'll cover it on the call and we can spend the time on your own numbers.</p>
    <p>See you soon. If something comes up, use this link to pick a new time, no problem at all: <a href="${resched}">reschedule</a>.</p>
    <p>Best,<br>Eric<br>MDconcierge</p>
  </div>`;
}

// What Eric actually needs in front of him before he dials: who, where they work, and what they
// have already read, so he is not opening the CRM one minute before the call.
async function brief(b) {
  // The single most important line: is Eric dialling, or clicking. Put it first and make it loud,
  // because a phone booking is a promise that only he can keep.
  const action = b.meeting_mode === 'phone'
    ? `<p style="font-size:17px;color:#b34700;margin:0 0 10px;"><b>YOU CALL THEM: ${esc(b.phone || 'no number on file')}</b></p>`
    : `<p style="font-size:15px;margin:0 0 10px;">Video call${b.join_url ? ` &middot; <a href="${esc(b.join_url)}">join link</a>` : ' &middot; no room link configured'}</p>`;
  const bits = [action,
    `<p style="font-size:15px;"><b>${esc(b.name)}</b> &lt;${esc(b.email)}&gt;${b.phone ? ' &middot; ' + esc(b.phone) : ''}</p>`,
    `<p style="font-size:15px;">${esc(fmt(new Date(b.slot_start)))} &middot; ${b.meeting_type === 'demo' ? '60 minute demonstration' : '15 minutes'}</p>`];
  if (b.note) bits.push(`<p style="font-size:14px;">Their note: ${esc(b.note)}</p>`);
  if (b.provider_id) {
    const [p] = await sGet(`mdrx_providers?select=practice_name,specialty,city,state,funnel_stage,funnel_last_cta,brief_sent_at,office_phone,relationship&id=eq.${b.provider_id}`);
    if (p) {
      const where = [p.practice_name, [p.city, p.state].filter(Boolean).join(', ')].filter(Boolean).join(' &middot; ');
      if (where) bits.push(`<p style="font-size:14px;color:#4a5568;">${esc(where)}${p.specialty ? ' &middot; ' + esc(p.specialty) : ''}${p.office_phone ? ' &middot; ' + esc(p.office_phone) : ''}</p>`);
      const read = [];
      if (p.brief_sent_at) read.push('has the Executive Brief');
      if (p.funnel_last_cta) read.push(`last clicked ${String(p.funnel_last_cta).replace('-', ' ')}`);
      if (read.length) bits.push(`<p style="font-size:14px;color:#4a5568;">${esc(read.join(' &middot; '))}</p>`);
      if (p.relationship) bits.push(`<p style="font-size:14px;color:#8a5a00;">${esc(p.relationship)}</p>`);
    }
  }
  return bits.join('\n');
}

const run = async () => {
  const now = Date.now();
  // Only look at what is actually happening: confirmed bookings still in the future.
  // Reach back far enough to catch meetings that have just finished, for the accountability pass.
  const rows = await sGet(`bookings?select=*&status=in.(booked,confirmed)&slot_start=gte.${new Date(now - 26 * 3600000).toISOString()}&order=slot_start`);
  let sent = 0;

  for (const b of rows) {
    const start = Date.parse(b.slot_start);
    if (!start) continue;
    const mins = (start - now) / 60000;

    // Confirmation for anything booked outside the booking page. Future meetings only: a booking
    // added after the fact for the record should not tell a physician to show up to something that
    // has already happened.
    if (!b.confirmed_at && mins > 0 && b.email) {
      try {
        await mailPhysician(b.email, "You're on my calendar, one quick step before our call", confirmHtml(b));
        await sPatch(`bookings?id=eq.${b.id}`, { confirmed_at: new Date().toISOString() });
        await notify(`Confirmation sent: ${b.name}`, `<p style="font-size:15px;">This one was booked outside the page, so the engine sent ${esc(b.name)} the confirmation.</p>${await brief(b)}`);
        console.log(`confirmation sent: ${b.name} @ ${fmt(new Date(start))}`);
        sent++;
      } catch (e) {
        console.error(`confirmation failed for ${b.name}: ${String(e)}`);
      }
    }

    // The heads-up notice: anything from 90 minutes to 30 hours out. The window is deliberately
    // wide so a meeting booked at short notice still gets one on the next hourly pass instead of
    // skipping straight to the hour notice. Because of that width the meeting may be today or
    // tomorrow, so say which: a 3pm booking for 5:45pm the same day was going out as "Tomorrow".
    if (!b.reminded_day_at && mins > 90 && mins <= 30 * 60) {
      const when = dayKey(new Date(start)) === dayKey(new Date(now)) ? 'Today' : 'Tomorrow';
      await notify(`${when}: ${b.name}`, `<p style="font-size:15px;">You have this ${when.toLowerCase()}.</p>${await brief(b)}`);
      await sPatch(`bookings?id=eq.${b.id}`, { reminded_day_at: new Date().toISOString() });
      console.log(`day-before sent: ${b.name} @ ${fmt(new Date(start))}`);
      sent++;
    }

    // A phone booking with no number is a call that cannot happen. Ask once, roughly two hours
    // out, while there is still time for them to answer. Nothing about the program in here: it is
    // a logistics note, and it goes to physicians in any state, so it carries no PA material.
    if (b.meeting_mode === 'phone' && !b.phone && !b.number_asked_at && mins > 90 && mins <= 180 && b.email) {
      const link = `${SITE}/book.html${b.token ? '?p=' + encodeURIComponent(b.token) : ''}`;
      try {
        await mailPhysician(b.email, 'Before our call', `
          <div style="font-family:Inter,Arial,sans-serif;color:#14213D;max-width:560px;">
            <p>Hi ${esc(confirmName(b))},</p>
            <p>I look forward to speaking with you later today. I realized I do not have a number to reach you on.</p>
            <p>Feel free to send it over, or you can <a href="${link}">add it here</a> if that is easier. I am also happy to do video instead.</p>
            <p>Best,<br>Eric</p>
          </div>`);
        await sPatch(`bookings?id=eq.${b.id}`, { number_asked_at: new Date().toISOString() });
        await notify(`No number yet: ${b.name}`, `<p style="font-size:16px;color:#b34700;"><b>This is a phone call and there is no number on file.</b> Asked them for it just now.</p>${await brief(b)}`);
        console.log(`number asked: ${b.name}`);
        sent++;
      } catch (e) { console.error(`number ask failed for ${b.name}: ${String(e)}`); }
    }

    // One hour out, with a wide enough band that an hourly cron cannot miss it.
    if (!b.reminded_hour_at && mins > 20 && mins <= 90) {
      await notify(`In about an hour: ${b.name}`, `<p style="font-size:15px;">Starting soon.</p>${await brief(b)}`);
      await sPatch(`bookings?id=eq.${b.id}`, { reminded_hour_at: new Date().toISOString() });
      console.log(`hour-before sent: ${b.name} @ ${fmt(new Date(start))}`);
      sent++;
    }

    // Accountability. A physician who chose "phone" is sitting waiting for Eric to ring - if the
    // slot has passed and the call was never marked made, say so plainly rather than let it slide.
    if (b.meeting_mode === 'phone' && !b.call_made_at && !b.nagged_at && mins < -20 && mins > -24 * 60) {
      await notify(`Did you call ${b.name}?`, `<p style="font-size:16px;">This was your call to make and it is not marked done.</p>${await brief(b)}
        <p style="font-size:14px;color:#4a5568;">If you spoke to them, mark it in the Cockpit. If you missed it, ring them now or send a line — they were expecting you.</p>`);
      await sPatch(`bookings?id=eq.${b.id}`, { nagged_at: new Date().toISOString() });
      console.log(`accountability nag sent: ${b.name}`);
      sent++;
    }
  }
  console.log(`booking-reminders: ${rows.length} upcoming, ${sent} reminder(s) sent`);
};

run().catch((e) => { console.error(e); process.exit(1); });
