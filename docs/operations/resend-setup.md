# Resend setup: owner steps

Owner: Kevin. Pairs with the engineering plan [`docs/superpowers/plans/2026-10-07-resend-email-transport.md`](../superpowers/plans/2026-10-07-resend-email-transport.md).

Code ships **dark**. Nothing changes for anyone until you flip the env values in Phase 4. Every step below can be undone by changing an env value and redeploying.

**Time needed:** about 30 minutes of hands-on work, plus up to a few hours waiting for DNS.

---

## Phase 1: Account and plan (5 min)

1. Sign in at https://resend.com.
2. **Billing → upgrade to Pro** (about $20/mo, 50k emails/month, no daily cap). Decision taken 2026-10-07 for scale and reliability.
3. **Settings → Team:** add a second owner email (for example admin@begiftededucation.com) so the account isn't tied to one person.

## Phase 2: Verify the sending domain (10 min + DNS wait)

Use a **subdomain**, never the root domain. Google Workspace owns the root's mail records, and keeping them separate protects admin@'s sending reputation.

1. Resend → **Domains → Add domain**
   - Domain: `notify.begiftededucation.com`
   - Region: **Tokyo (ap-northeast-1)** if offered. It's closest to the app's Singapore servers. Otherwise use the default.
2. Resend shows 3–4 DNS records. Add them **exactly as shown** wherever DNS for `begiftededucation.com` is managed (registrar, Cloudflare, or Google Domains/Squarespace):

   | Type | Name (host) | Purpose |
   |---|---|---|
   | MX | `send.notify` | Bounce handling |
   | TXT | `send.notify` | SPF (`v=spf1 include:amazonses.com ~all`) |
   | TXT | `resend._domainkey.notify` | DKIM signature |

   Most DNS panels append the root domain automatically. Enter the host as shown in Resend, without `.begiftededucation.com`, unless the panel asks for the full name.

3. **Recommended:** add a DMARC record for the subdomain:
   - Type `TXT`, Name `_dmarc.notify`, Value `v=DMARC1; p=none; rua=mailto:kevhsh7@gmail.com`

4. ⚠️ **Do NOT edit or delete** any existing record on the root domain (`@` MX, `@` TXT SPF, `google._domainkey`). Those carry Workspace mail. Breaking them stops admin@ from sending and receiving.

5. Back in Resend, click **Verify**. Wait until all records show **Verified**. That usually takes minutes, sometimes a few hours. Don't go past this phase until it's green.

**Check:** Resend → Domains shows `notify.begiftededucation.com` with status **Verified**.

## Phase 3: API key and Vercel env (10 min)

1. Resend → **API Keys → Create**
   - Name: `bgscheduler-production`
   - Permission: **Sending access**
   - Domain: `notify.begiftededucation.com` only
2. Copy the key **once**. Resend never shows it again. Don't paste it into chat, Slack or a doc.
3. Add it to Vercel, **Production only**. Run this from the linked `Scheduling` checkout; it prompts for the value, so the key never sits in your shell history:

```bash
vercel env add RESEND_API_KEY production --sensitive
```

4. Add the addresses (not secret, but keep them Production-only):

```bash
vercel env add RESEND_FROM production
```
   Value: `BeGifted <no-reply@notify.begiftededucation.com>`

```bash
vercel env add ADMISSIONS_EMAIL_FROM production
```
   Value: `BeGifted Admissions <admissions@notify.begiftededucation.com>`

```bash
vercel env add RESEND_REPLY_TO production
```
   Value: where replies should land. Suggested: `admin@begiftededucation.com`. If you skip this one, replies go to the existing `SCHEDULE_EMAIL_REPLY_TO`.

5. **Don't** add these to Preview. Preview deploys should never send real mail.

**Check:** `vercel env ls production` lists `RESEND_API_KEY`, `RESEND_FROM`, `ADMISSIONS_EMAIL_FROM` and `RESEND_REPLY_TO`. Never use `vercel env pull` to check a value: it shows sensitive values as empty even when they're set.

## Phase 4: Turn it on in waves (after PR A merges)

Each flip is an env change followed by a redeploy (push to `main`, or **Redeploy** on the latest production deployment in the Vercel dashboard).

**Wave 1: staff mail, sign-in codes and Admissions**

```bash
vercel env add OUTBOUND_EMAIL_TRANSPORT production
```
Value: `resend`. Then redeploy.

What changes:
- Cron alerts, autowriter alerts, weekend check, leave-request notices, admin digests and sign-in codes now go through **Resend**.
- Teacher mail (classroom schedules, feedback reminders, progress-test heads-ups) now goes through **Workspace Gmail as admin@**. That also moves it off the 100-a-day Apps Script relay.
- Admissions starts sending once PR B is merged.

**Check, same day:**
- Request a sign-in code from `/login` and confirm it arrives within about 10 seconds and not in spam.
- Resend → **Emails** shows sends with status `delivered`.
- Look in Gmail at the original of one email (⋮ → *Show original*). SPF, DKIM and DMARC should all show **PASS**.

**Wave 2: teacher mail (1–2 weeks later)**

Move on only if Resend → **Metrics** shows bounces under 2% and complaints near 0.

```bash
vercel env add RESEND_AUDIENCE production
```
Value: `all`. Then redeploy.

Afterwards, spot-check with two or three teachers that the next morning's classroom email didn't land in spam.

## Phase 5: Bounce tracking (after PR D is ready)

1. **Apply the migration before merging PR D.** From the linked checkout, on the PR branch:

```bash
set -a && source .env.local && set +a && npm run db:migrate
```

   `.env.local` in the linked checkout holds the production Neon `DATABASE_URL`. Confirm that before running.

   Confirm the only new migration it applies is `0111_email_delivery_events`.
2. Merge PR D and wait for the production deploy.
3. Resend → **Webhooks → Add endpoint**
   - URL: `https://bgscheduler.vercel.app/api/email/resend-webhook`
   - Events: `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`
4. Copy the **Signing secret** (starts with `whsec_`) and add it to Vercel:

```bash
vercel env add RESEND_WEBHOOK_SECRET production --sensitive
```
Then redeploy.

5. Resend → Webhooks → your endpoint → **Send test event**. It should show `200`. A `503` means the secret isn't deployed yet; a `401` means the secret is wrong.

## Phase 6: Optional: drop the two admin digests (after PR C merges)

Only if staff don't act on them. The same information is on `/class-assignments` and `/progress-tests`.

```bash
vercel env add CLASSROOM_ADMIN_EMAIL_ENABLED production
```
Value: `false`

```bash
vercel env add PROGRESS_TEST_ADMIN_DIGEST_ENABLED production
```
Value: `false`

Redeploy. To bring either digest back, set its value to `true` (or remove the variable) and redeploy.

---

## Emergency rollback

If Resend mail is missing or landing in spam:

1. Vercel → Settings → Environment Variables → `OUTBOUND_EMAIL_TRANSPORT` → change it to `gmail`.
2. Redeploy.

All app mail then goes back through Workspace Gmail, with the Apps Script relay as backup. Nothing else needs to change. If teacher mail alone is the problem, remove `RESEND_AUDIENCE` instead: staff mail stays on Resend and teacher mail goes back to Gmail.

## Rules that always apply

- Rotate the API key (Resend → API Keys → create new, update Vercel, redeploy, revoke the old one) if it's ever pasted anywhere outside Vercel.
- Only one Resend API key is used by production. Don't create per-feature keys.
- Never put `RESEND_*` values on a laptop, in `.env.local` on Aoeng's machine, or in Preview environments.

## Checklist

- [ ] Pro plan active, second owner added
- [ ] `notify.begiftededucation.com` verified (SPF, DKIM, DMARC)
- [ ] `RESEND_API_KEY`, `RESEND_FROM`, `ADMISSIONS_EMAIL_FROM`, `RESEND_REPLY_TO` in Vercel Production
- [ ] Wave 1: `OUTBOUND_EMAIL_TRANSPORT=resend`, sign-in code test passed, headers show PASS
- [ ] Migration 0111 applied, webhook added, `RESEND_WEBHOOK_SECRET` set, test event returned 200
- [ ] (optional) digests disabled
- [ ] Wave 2 after 1–2 weeks: `RESEND_AUDIENCE=all`, teacher spot-check done
