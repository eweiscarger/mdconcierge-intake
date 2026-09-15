// news-monitor.mjs — the content mind-hive scout.
// Weekly, it uses Claude's web search to find fresh, REAL, cited developments. Eric, 15 Sep
// 2026: most of what it used to bring (FTC and commercial PBM news, other states' fee
// schedules) meant nothing to a Pennsylvania physician, so openers are now held to a narrow
// test: Pennsylvania workers' comp, or injured workers getting their medication. Fewer items,
// each one worth an email. It also watches for ancillary REVENUE OPPORTUNITIES as intel for
// Eric. Everything lands in mdrx_content_queue as 'pending'. A story only reaches a physician
// after Eric approves it AND approves the email written for it (email_status = 'approved').
// It SENDS NOTHING to prospects.
// Governed by MESSAGING_AND_CONTENT.md.
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}
const MAX_ITEMS = Number(process.env.NEWS_MAX_ITEMS || 6);
const today = new Date().toISOString().slice(0, 10);

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; };
const sPost = async (t, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };

const SYSTEM = `You are the content and business-intelligence scout for Eric Weiscarger's MDRx Workers' Compensation Pharmacy Program. Eric recruits physicians (orthopedics, interventional pain, PM&R, neurology, podiatry) into a compliant work-comp pharmacy program with the MDRx360 team.

THE CONTENT RULE (hero / villain) governs everything you write:
- HERO: the physician and the injured worker. Our program is the tool that helps them.
- VILLAINS: the middlemen and the friction. PBMs, TPAs (claims administrators), and the denial / delay / utilization-review machinery that keeps injured workers from their medication and buries practices in admin work.
- NEVER speak negatively about physician dispensing, mail-order pharmacy, or workers'-comp pharmacy. Two of those are our own model and some prospects dispense today. Never disparage them, even implicitly.
- The problem we point at is the access gap and billing friction in the WC system, framed as a patient problem we solve, not any pharmacy model being bad.

ACCURACY GUARDRAIL: Our model still bills the payer through MDRx. Do NOT frame it as cutting the payer out of paying. Aim the fire at the middlemen and denial games (PBMs, TPAs, UR friction). Keep every claim true: independent pharmacy, claims-purchasing / factoring (NOT ownership, NOT dispensing), WC only, legal opinions per state, cite the PA Supreme Court's 700 Pharmacy decision and Alice Gosfield where natural. Never fabricate. Every source_url must be a REAL url you actually found via web search. No em dashes or en dashes anywhere. Never use the phrase "gray area".

THE RELEVANCE TEST FOR OPENERS (Eric, 15 Sep 2026). An opener must pass BOTH:
1. It is about Pennsylvania workers' compensation, OR about injured workers getting (or failing to get) their medication: fills, denials, delays, access, delivery.
2. A Pennsylvania orthopedic, pain or PM&R physician who treats work comp patients would read it and think "that affects my patients or my practice."
Reject for openers: FTC or commercial PBM news that is not about work comp; any other state's rules, fee schedules or audits; general practice economics; private equity; webinars and events; anything older than the window; anything that repeats a story already covered. When in doubt, leave it out. Returning zero openers is a good result when nothing passes.

STANDING THEMES (only as they pass the test above): (1) Pennsylvania work comp medication access, denials and delays for injured workers; (2) Pennsylvania Bureau of Workers' Compensation and PA court developments affecting WC pharmacy; (3) medication-access data for injured workers (WCRI, drug trends) with a clear patient consequence.

STANDING SOURCES to draw from: WorkersCompensation.com, WCRI, Risk & Insurance, MyMatrixx, Enlyte drug trends, daisyBill, FTC newsroom, health-law firm alerts, Medical Economics, MGMA, Becker's Orthopedic/Spine, Physicians Practice, Gosfield's newsletter, Dan Siegel's firm, AHLA, PA Bureau of Workers' Comp, DOL OWCP.

ANCILLARY OPPORTUNITY RADAR: also watch for ancillary revenue opportunities or advancements our target practices (and we) should know about and could get involved in, e.g. peptides for MSK/orthopedic/pain practices, regenerative and other compliant cash-pay ancillary lines, new revenue models adjacent to WC pharmacy. These are intel for Eric (kind="opportunity"), not customer-facing copy.`;

const USER = `Today is ${today}. Use web search to find REAL, cited developments from roughly the LAST 21 DAYS. Openers must pass THE RELEVANCE TEST above; also report any notable ancillary revenue opportunities for MSK / orthopedic / pain / PM&R practices.

Search the standing sources and the open web. Keep only items that are (a) real and sourceable to a working URL, (b) usable WITHOUT saying anything negative about dispensing, mail-order, or WC pharmacy, and (c) for openers, pass the relevance test. Discard everything else, and prefer returning nothing over returning filler.

After searching, output ONLY a JSON array (no prose before or after, no markdown fences). Return ${MAX_ITEMS} items or fewer, favoring the freshest, most concrete, best-sourced. Each element:
{
  "kind": "opener" | "opportunity",
  "theme": "pbm-ftc" | "tpa-denial" | "practice-economics" | "access-data" | "legal" | "ancillary",
  "source_title": "the article/source title",
  "source_url": "https://... (a real url you found)",
  "headline": "<= 90 char label of the development",
  "angle": "one sentence: why it matters to a physician or to us",
  "draft_hook": "for kind=opener: a 2 to 4 sentence ready email OPENER in the locked voice (hero = doctor + patient, villain = the middleman, our program = the counter; cite 700 Pharmacy / Gosfield where it fits naturally). for kind=opportunity: what it is, why it matters to our target practices, and how MDRx / MDconcierge might participate."
}

Keep each draft_hook under 80 words. Do your searches first, then write the array. Output ONLY the JSON array: no citations, no explanation, no markdown code fences.`;

async function scout() {
  const m = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 12000,
    system: SYSTEM,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{ role: 'user', content: USER }],
  });
  const raw = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s < 0 || e < 0) { console.error('no json array in scout output: ' + raw.slice(0, 200)); return []; }
  let arr;
  try { arr = JSON.parse(raw.slice(s, e + 1)); } catch (err) { console.error('json parse failed: ' + err.message); return []; }
  return Array.isArray(arr) ? arr : [];
}

const norm = (u) => String(u || '').trim().replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();

async function main() {
  const items = await scout();
  if (!items.length) { console.log('news-monitor: nothing usable this run.'); return; }

  // Dedupe against everything already queued (any status), by normalized URL.
  const existing = await sGet('mdrx_content_queue?select=source_url');
  const seen = new Set((existing || []).map((r) => norm(r.source_url)));

  let added = 0, openers = 0, opps = 0;
  for (const it of items) {
    if (added >= MAX_ITEMS) break;
    const url = String(it.source_url || '').trim();
    if (!it.draft_hook || !url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(norm(url))) continue;
    seen.add(norm(url));
    const kind = it.kind === 'opportunity' ? 'opportunity' : 'opener';
    await sPost('mdrx_content_queue', {
      kind,
      theme: (it.theme || '').slice(0, 40) || null,
      source_title: (it.source_title || '').slice(0, 300) || null,
      source_url: url.slice(0, 600),
      headline: (it.headline || '').slice(0, 200) || null,
      draft_hook: String(it.draft_hook).slice(0, 4000),
      angle: (it.angle || '').slice(0, 400) || null,
      status: 'pending',
      run_tag: today,
    });
    added++; if (kind === 'opportunity') opps++; else openers++;
  }
  console.log(`news-monitor: added ${added} pending (${openers} openers, ${opps} opportunities).`);

  // Nudge Eric to review, only when there is something new.
  if (added > 0) {
    try {
      const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
      await t.sendMail({
        from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER,
        subject: `${added} fresh content idea${added === 1 ? '' : 's'} to review`,
        html: `<p>The news scout found <b>${openers}</b> Pennsylvania work comp stor${openers === 1 ? 'y' : 'ies'} and <b>${opps}</b> ancillary opportunit${opps === 1 ? 'y' : 'ies'}.</p><p>Review them in the Cockpit &rarr; <b>Content</b> tab. For a story worth emailing, ask Claude to write its email. Nothing reaches a physician until you approve that email.</p>`,
      });
    } catch (e) { console.error('digest email failed: ' + e.message); }
  }
}

async function alertFailure(job, msg) {
  try {
    const rows = await sGet(`job_alerts?select=last_alert_at&job=eq.${job}`);
    const last = rows[0]?.last_alert_at ? new Date(rows[0].last_alert_at).getTime() : 0;
    if (Date.now() - last < 6 * 3600 * 1000) return;
    const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
    await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: `[MDconcierge] the ${job} job hit a problem`, text: msg });
    await fetch(`${SUPABASE_URL}/rest/v1/job_alerts`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ job, last_alert_at: new Date().toISOString(), last_msg: msg.slice(0, 300) }) });
  } catch (e) { console.error('alertFailure error: ' + e.message); }
}

main().catch(async (e) => {
  const msg = String(e?.message || e);
  if (/timeout|econnreset|econnrefused|enotfound|socket|network|fetch failed|overloaded|529|503/i.test(msg)) { console.warn('transient, skipping run: ' + msg); process.exit(0); }
  console.error('news-monitor fatal: ' + (e?.stack || e));
  await alertFailure('news-monitor', msg);
  process.exit(0);
});
