import nodemailer from "npm:nodemailer@6.9.13";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = Deno.env.get("ZOHO_ERIC_USER");
    const pass = Deno.env.get("ZOHO_ERIC_APP_PASSWORD");
    if (!user || !pass) return J({ ok: false, error: "mail not configured" }, 500);
    const { to, cc, subject, html, text, attachments } = await req.json();
    if (!to || !subject) return J({ ok: false, error: "missing to or subject" }, 400);
    const atts = (attachments || []).map((a) => a.url
      ? { filename: a.filename || "attachment", path: a.url }
      : { filename: a.filename || "attachment", content: a.contentBase64, encoding: "base64", contentType: a.contentType });
    const transporter = nodemailer.createTransport({ host: "smtp.zoho.com", port: 465, secure: true, auth: { user, pass } });
    await transporter.sendMail({ from: `Eric Weiscarger <${user}>`, to, cc: cc || undefined, replyTo: user, subject, text: text || undefined, html: html || undefined, attachments: atts.length ? atts : undefined });
    return J({ ok: true });
  } catch (e) {
    return J({ ok: false, error: String((e && e.message) || e) }, 500);
  }
});
