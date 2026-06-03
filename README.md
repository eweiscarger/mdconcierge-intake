# MDconcierge — Referral Intake

Automation that turns attorney referral emails into leads in the MDconcierge portal.

Every run it: logs into the `referrals@mdconcierge.net` Zoho inbox (IMAP), reads new
messages, uses Claude to extract the client + referring firm, and inserts a lead into
the Supabase `cases` table (`lead_source = attorney_referral_email`, marked represented).
Unclear emails are created with `status = review` so nothing is ever dropped or mis-routed.

**No credentials or client data are stored in this repository.** All configuration is
provided at runtime via GitHub Actions encrypted secrets:

- `ZOHO_USER`, `ZOHO_APP_PASSWORD` — read-only mailbox access (revocable in Zoho)
- `ANTHROPIC_API_KEY` — the AI parser
- `SUPABASE_URL`, `SUPABASE_KEY` — the portal database (publishable key; insert-only via RLS)

Runs on a schedule via `.github/workflows/intake.yml` and can be triggered manually.
