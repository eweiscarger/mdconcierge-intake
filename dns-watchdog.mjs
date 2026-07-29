// dns-watchdog.mjs — weekly check that mdconcierge.net's email authentication
// (SPF, DKIM, DMARC) is still published and valid. Emails Eric the moment any of
// them break or drift, so deliverability never silently degrades again.
import { resolveTxt } from 'node:dns/promises';
import nodemailer from 'nodemailer';

const DOMAIN = 'mdconcierge.net';
const ERIC_USER = process.env.ERIC_USER || 'eric@mdconcierge.net';
const ERIC_PASS = process.env.MDRX_ERIC_PASS || process.env.ERIC_APP_PASSWORD;
const DKIM_FINGERPRINT = 'LOfZG2Epue9oQ'; // current DKIM key marker; a change here is worth flagging

async function txt(name) { try { return (await resolveTxt(name)).map((a) => a.join('')); } catch { return []; } }

async function main() {
  const spf = await txt(DOMAIN);
  const dmarc = await txt('_dmarc.' + DOMAIN);
  const dkim = await txt('zmail._domainkey.' + DOMAIN);
  const spfV = spf.find((v) => /v=spf1/i.test(v)) || '';
  const dmarcV = dmarc.find((v) => /v=DMARC1/i.test(v)) || '';
  const dkimV = dkim.find((v) => /v=DKIM1/i.test(v)) || '';

  const checks = [
    { name: 'SPF',   ok: !!spfV, detail: spfV || '(MISSING)' },
    { name: 'DMARC', ok: !!dmarcV, detail: dmarcV || '(MISSING)' },
    { name: 'DKIM',  ok: /v=DKIM1/i.test(dkimV) && /p=[A-Za-z0-9]/.test(dkimV), detail: dkimV ? ('present' + (dkimV.includes(DKIM_FINGERPRINT) ? '' : ' — KEY CHANGED from expected')) : '(MISSING)' },
  ];
  const dkimDrift = !!dkimV && !dkimV.includes(DKIM_FINGERPRINT);
  const broken = checks.filter((c) => !c.ok);
  console.log('DNS auth:', checks.map((c) => c.name + '=' + (c.ok ? 'OK' : 'BROKEN')).join(' ') + (dkimDrift ? ' (DKIM key changed)' : ''));

  if (!broken.length && !dkimDrift) return; // all good, stay silent
  if (!ERIC_PASS) { console.error('cannot alert: no mail password'); return; }
  const t = nodemailer.createTransport({ host: 'smtp.zoho.com', port: 465, secure: true, auth: { user: ERIC_USER, pass: ERIC_PASS } });
  const body = `Heads up: mdconcierge.net's email authentication needs attention.\n\n` +
    checks.map((c) => `${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n') +
    (dkimDrift ? `\n\nNote: the DKIM key changed from what we set. If you did not rotate it on purpose, verify it in Zoho.` : '') +
    `\n\nBroken or drifted records can push your mail to spam. Fix the failing record in Namecheap DNS (Advanced DNS > Host Records).`;
  await t.sendMail({ from: `"MDconcierge" <${ERIC_USER}>`, to: ERIC_USER, subject: `[MDconcierge] email auth check: ${(broken.map((b) => b.name).concat(dkimDrift ? ['DKIM key changed'] : [])).join(', ')}`, text: body });
  console.log('alerted Eric');
}

main().catch((e) => { console.error('dns-watchdog error: ' + (e?.message || e)); process.exit(0); });
