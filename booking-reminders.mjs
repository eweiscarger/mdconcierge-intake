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

const mailer = () => nodemailer.createTransport({
  host: 'smtp.zoho.com', port: 465, secure: true,
  auth: { user: ERIC, pass: process.env.ZOHO_ERIC_APP_PASSWORD },
});

async function notify(subject, html) {
  await mailer().sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC}>`, to: ERIC, subject, html, headers: { 'X-MDC-Auto': 'reminder' } });
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

    // Day before: anything landing 18-30 hours out. A booking made inside that window still gets
    // one on the next hourly pass rather than silently skipping straight to the hour notice.
    if (!b.reminded_day_at && mins > 90 && mins <= 30 * 60) {
      await notify(`Tomorrow: ${b.name}`, `<p style="font-size:15px;">You have this tomorrow.</p>${await brief(b)}`);
      await sPatch(`bookings?id=eq.${b.id}`, { reminded_day_at: new Date().toISOString() });
      console.log(`day-before sent: ${b.name} @ ${fmt(new Date(start))}`);
      sent++;
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
