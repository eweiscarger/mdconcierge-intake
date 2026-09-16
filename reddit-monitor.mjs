// reddit-monitor.mjs — finds Pennsylvania and Delaware people on Reddit asking for help after a
// work injury or an accident, and drafts a genuinely helpful answer for Eric to post himself.
// Eric, 15 Sep 2026: traffic for InjuredGuide has to come from being useful where people already
// ask. Reddit bans promotion, so an answer helps first and mentions injuredguide.com only when it
// truly fits, with a disclosure. NOTHING IS EVER POSTED AUTOMATICALLY. New Jersey is out of scope
// until after launch.
//
// MODE=scan   reads subreddit RSS feeds (the .json API refuses these requests; RSS does not),
//             keeps fresh posts that look like a PA/DE injury question, asks Claude to judge and
//             draft, and stores everything in reddit_leads.
// MODE=digest emails Eric every drafted answer not yet sent, once a day, and marks them emailed.
import Anthropic from '@anthropic-ai/sdk';
// Outbound goes through the shared capped transport - see mailer.mjs for why.
import { transporter } from './mailer.mjs';

const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const MODE = (process.env.MODE || 'scan').toLowerCase();
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error('Missing env var: ' + k); process.exit(1); }
}

const H = { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' };
const sGet = async (p) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`GET ${p} ${r.status}: ${await r.text()}`); return r.json(); };
const sPost = async (t, row) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}`, { method: 'POST', headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) }); if (!r.ok) console.error(`insert ${t} ${r.status}: ${await r.text()}`); };
const sPatch = async (p, patch) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch) }); if (!r.ok) throw new Error(`PATCH ${p} ${r.status}: ${await r.text()}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where PA and DE people ask. A local subreddit implies the state; a national one has to say it.
const LOCAL = {
  Pennsylvania: 'PA', philadelphia: 'PA', pittsburgh: 'PA', lehighvalley: 'PA', Harrisburg: 'PA',
  Scranton: 'PA', Lancaster: 'PA', erie: 'PA', Reading: 'PA', StateCollege: 'PA',
  Delaware: 'DE', wilmingtonde: 'DE', Newark_DE: 'DE',
};
const NATIONAL = ['WorkersComp', 'personalinjury', 'legaladvice', 'Insurance'];
const STATE_RE = {
  PA: /\b(PA|Penn(sylvania)?|Philly|Philadelphia|Pittsburgh|Allentown|Bethlehem|Scranton|Wilkes[- ]Barre|Harrisburg|Lancaster|Reading|Erie|York|Altoona|State College|Bucks County|Montgomery County|Delco|Delaware County|Chester County|Lehigh)\b/,
  DE: /\b(DE|Delaware|Wilmington|Dover|Newark,? DE|Rehoboth|Middletown,? DE|Sussex County|Kent County)\b/,
};
// Cheap first pass so Claude only sees posts that are plausibly about an injury.
const INJURY_RE = /\b(work(ers)?'? ?comp|workman'?s comp|injur(y|ed|ies)|hurt (at|on) (work|the job)|accident|crash|rear[- ]ended|slip(ped)? and f[ae]ll|whiplash|herniat|torn|fractur|concussion|IME\b|panel (doctor|physician)|light duty|disability|claim (was )?denied|adjuster|settlement|lawyer|attorney|PIP\b)/i;
const MAX_AGE_H = 72;

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const stripHtml = (s) => decode(decode(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function fetchFeed(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; injuredguide-research/1.0)' } });
    if (r.status === 429 && attempt === 1) { await sleep(75000); continue; }
    if (!r.ok) throw new Error(`${r.status}`);
    const xml = await r.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const e = m[1];
      const pick = (re) => { const x = e.match(re); return x ? x[1] : ''; };
      return {
        id: decode(pick(/<id>([^<]+)<\/id>/)).replace(/^t3_/, ''),
        title: stripHtml(pick(/<title>([\s\S]*?)<\/title>/)),
        url: decode(pick(/<link href="([^"]+)"/)),
        author: stripHtml(pick(/<name>([\s\S]*?)<\/name>/)).replace(/^\/u\//, ''),
        posted: pick(/<published>([^<]+)<\/published>/) || pick(/<updated>([^<]+)<\/updated>/),
        body: stripHtml(pick(/<content[^>]*>([\s\S]*?)<\/content>/)).replace(/submitted by .*$/i, '').slice(0, 3000),
        subreddit: decode(pick(/<category term="([^"]+)"/)),
      };
    }).filter((p) => p.id && p.url);
  }
  return [];
}

const SYSTEM = `You help Eric, who runs InjuredGuide.com, answer Reddit posts from people in Pennsylvania or Delaware who were hurt at work or in an accident. InjuredGuide is a free site where a real person reviews a request and calls back within 2 business days. It is NOT a law firm or a healthcare provider.

First judge the post. It is RELEVANT only if the poster (or their family member) was injured and is asking what to do, about a claim, a doctor, a denial, a lawyer, or money after the injury, AND the injury or claim is in Pennsylvania or Delaware. New Jersey and every other state are NOT relevant. Venting with no question, news, and memes are not relevant.

If relevant, draft a reply Eric could post from his own account:
- Genuinely helpful first. Answer their actual question in plain words, 60 to 160 words, like a knowledgeable neighbor. No headings, no bullet walls.
- General information only, never legal advice, never "you have a case" or "you deserve", no guarantees, never claim to be a lawyer.
- State-specific facts only when you are confident they are correct for PA or DE workers' comp or auto injury. Do NOT state deadlines, day counts or dollar amounts unless certain; say "there are deadlines, so don't wait" instead. Point to the official agency (Pennsylvania Bureau of Workers' Compensation, or the Delaware Office of Workers' Compensation) when useful.
- Suggest talking to a licensed attorney in their state when their situation calls for it, without pushing.
- Never ask them to DM, call, or contact Eric personally.
- Never tell them to avoid, screen out, or question a doctor or provider because of network, certification, or panel list status. Eric works with providers who may not be on those lists.
- Mention injuredguide.com only if it truly fits (they ask where to get help, or how to find a lawyer or doctor). Then set include_link true and end with one sentence of disclosure: "Full disclosure, I run injuredguide.com, a free site where someone reviews your situation and calls you back." Otherwise include_link false and no mention of the site.
- No em dashes or en dashes.

Return ONLY JSON: {"relevant": true|false, "state": "PA"|"DE"|null, "topic": "work_injury"|"car_accident"|"other_injury"|null, "reason": "one short sentence", "draft": "reply text or empty", "include_link": true|false}`;

async function judge(post, stateHint) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const m = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Subreddit: r/${post.subreddit}\n${stateHint ? `This is a ${stateHint} local subreddit.\n` : ''}Title: ${post.title}\n\n${post.body || '(no body)'}` }],
  });
  const raw = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no JSON in model output');
  return JSON.parse(raw.slice(s, e + 1));
}

async function scan() {
  if (!ANTHROPIC_API_KEY) { console.error('Missing env var: ANTHROPIC_API_KEY'); process.exit(1); }
  const feeds = [
    ...Object.keys(LOCAL).map((sub) => ({ url: `https://www.reddit.com/r/${sub}/new/.rss?limit=50`, hint: LOCAL[sub] })),
    ...NATIONAL.map((sub) => ({ url: `https://www.reddit.com/r/${sub}/new/.rss?limit=100`, hint: null })),
  ];
  const seen = new Set((await sGet('reddit_leads?select=post_id&found_at=gte.' + new Date(Date.now() - 14 * 864e5).toISOString())).map((r) => r.post_id));
  let read = 0, candidates = 0, drafted = 0, failedFeeds = 0;
  for (const f of feeds) {
    let posts = [];
    try { posts = await fetchFeed(f.url); read += posts.length; }
    catch (e) { failedFeeds++; console.error(`feed ${f.url.split('/r/')[1].split('/')[0]} failed: ${e.message}`); }
    for (const p of posts) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (p.posted && Date.now() - new Date(p.posted).getTime() > MAX_AGE_H * 3600e3) continue;
      const text = `${p.title} ${p.body}`;
      if (!INJURY_RE.test(text)) continue;
      const stateHit = f.hint || (STATE_RE.PA.test(text) ? 'PA' : STATE_RE.DE.test(text) ? 'DE' : null);
      if (!stateHit) continue;
      candidates++;
      let v;
      try { v = await judge(p, f.hint); }
      catch (e) {
        // An empty credit balance fails every post the same way. Stop and alert rather than log it
        // quietly on each one and finish green, which is how the other AI jobs went dark for days.
        if (/credit balance/i.test(e.message)) throw new Error('Anthropic credit balance is too low: ' + e.message.slice(0, 200));
        console.error(`judge failed for ${p.id}: ${e.message}`); seen.delete(p.id); continue;
      }
      const relevant = !!v.relevant && ['PA', 'DE'].includes(v.state) && String(v.draft || '').trim().length > 0;
      await sPost('reddit_leads', {
        post_id: p.id, subreddit: p.subreddit || (f.url.split('/r/')[1] || '').split('/')[0], title: p.title.slice(0, 500), url: p.url,
        author: p.author || null, body_snippet: p.body.slice(0, 1200), posted_at: p.posted || null,
        state: v.state || null, topic: v.topic || null, draft: relevant ? String(v.draft).trim() : null,
        include_link: relevant && !!v.include_link, status: relevant ? 'drafted' : 'not_relevant', notes: String(v.reason || '').slice(0, 300),
      });
      if (relevant) drafted++;
    }
    await sleep(15000); // Reddit rate-limits bursts: at 6 seconds apart 8 of 17 feeds were refused
  }
  console.log(`reddit-monitor scan: ${read} posts read from ${feeds.length - failedFeeds}/${feeds.length} feeds, ${candidates} candidates judged, ${drafted} answers drafted.`);
  if (failedFeeds === feeds.length) throw new Error('every Reddit feed failed');
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function digest() {
  const rows = await sGet('reddit_leads?select=*&status=eq.drafted&emailed_at=is.null&order=posted_at.desc&limit=25');
  if (!rows.length) { console.log('reddit-monitor digest: nothing new to send.'); return; }
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:680px;">
<p>${rows.length} Reddit post${rows.length === 1 ? '' : 's'} from Pennsylvania or Delaware where a helpful answer could fit. Each has a suggested reply. Nothing was posted. Open the post, edit the reply however you like, and post it from your account, or skip it.</p>
${rows.map((r, i) => `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:12px 0;">
<div style="font-size:12px;color:#6b7280;">${i + 1}. r/${esc(r.subreddit)} · ${esc(r.state || '')} · ${esc((r.topic || '').replace('_', ' '))}${r.include_link ? ' · mentions injuredguide.com' : ''}</div>
<div style="font-weight:bold;margin:4px 0;"><a href="${esc(r.url)}">${esc(r.title)}</a></div>
<div style="font-size:13px;color:#4b5563;margin-bottom:8px;">${esc((r.body_snippet || '').slice(0, 400))}${(r.body_snippet || '').length > 400 ? '...' : ''}</div>
<div style="background:#f9fafb;border-left:3px solid #c0392b;padding:8px 10px;white-space:pre-wrap;">${esc(r.draft)}</div>
</div>`).join('')}
<p style="font-size:12px;color:#6b7280;">Reddit removes accounts that promote. Keep most answers link-free and only mention the site where it genuinely helps.</p></div>`;
  const text = rows.map((r, i) => `${i + 1}. r/${r.subreddit} (${r.state}) ${r.title}\n${r.url}\n\nSuggested reply:\n${r.draft}\n`).join('\n----------\n\n');
  const t = transporter;   // shared capped transport
  await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"InjuredGuide monitor" <${ERIC_USER}>`, to: ERIC_USER, subject: `${rows.length} Reddit post${rows.length === 1 ? '' : 's'} worth answering`, text, html });
  const ids = rows.map((r) => `"${r.post_id}"`).join(',');
  await sPatch(`reddit_leads?post_id=in.(${ids})`, { status: 'emailed', emailed_at: new Date().toISOString() });
  console.log(`reddit-monitor digest: emailed ${rows.length} drafted answer(s).`);
}

(MODE === 'digest' ? digest() : scan()).catch(async (e) => {
  const msg = String(e?.message || e);
  console.error('reddit-monitor failed: ' + msg);
  if (/credit balance|every Reddit feed failed/i.test(msg)) {
    try {
      const t = transporter;   // shared capped transport
      await t.sendMail({ headers: { 'X-MDC-Bot': 'engine' }, from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: '[MDconcierge] the Reddit monitor hit a problem', text: msg });
    } catch (_) {}
  }
  process.exit(1);
});
