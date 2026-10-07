# Resend setup: owner steps

Owner: Kevin. Pairs with the engineering plan [`docs/superpowers/plans/2026-10-07-resend-email-transport.md`](../superpowers/plans/2026-10-07-resend-email-transport.md).

The code ships in two PRs. **PR1** is the transport, staff routing, sign-in codes, Admissions and the digest switches (no migration). **PR2** is the delivery webhook plus migration 0111.

Staff and teacher mail routing stays **dark** until you flip `OUTBOUND_EMAIL_TRANSPORT` in Phase 4. **Admissions is the exception:** once PR1 is merged and the Phase 3 values (`RESEND_API_KEY` plus `ADMISSIONS_EMAIL_FROM` or `RESEND_FROM`) are deployed, deadline reminders and weekly digests to students and parents start on the next admissions cron (01:12 UTC daily), with no wave and no transport flag. Every step below can be undone by changing an env value and redeploying, except mail already sent.

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
2. Resend shows three DNS records: one TXT for DKIM and two CNAMEs for sending and bounces (Tokyo region). Add them at **Squarespace Domains**, where DNS for `begiftededucation.com` lives:
   1. Go to https://account.squarespace.com/domains, select `begiftededucation.com`, then **DNS** → **DNS Settings**.
   2. Scroll to **Custom records** and click **Add record** once per row below. Squarespace adds `.begiftededucation.com` to the host itself, so type only the short host.

   | Type | Host (type exactly) | Data / value | TTL |
   |---|---|---|---|
   | TXT | `resend._domainkey.notify` | the long `p=MIGfMA0…IDAQAB` string from Resend, pasted whole with no quotes or spaces | default |
   | CNAME | `rsend.notify` | `rsend-apne1.forge.rmta.net` | default |
   | CNAME | `send.notify` | `send.forge.rmta.net` | default |

   3. Save each record. Leave the **Google Workspace** preset (MX, SPF, DKIM on the root `@`) alone.
   4. Check from a terminal after 5–30 minutes (all three should print a value):
      ```bash
      dig +short TXT resend._domainkey.notify.begiftededucation.com
      ```
      ```bash
      dig +short CNAME send.notify.begiftededucation.com
      ```
      ```bash
      dig +short CNAME rsend.notify.begiftededucation.com
      ```

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

> **Heads-up: this phase turns Admissions email on.** After PR1 is merged and these values are deployed, the next admissions cron (01:12 UTC daily) sends deadline reminders and weekly digests to students and parents through Resend. `OUTBOUND_EMAIL_TRANSPORT` does not control it. If you want Admissions off, hold back `RESEND_API_KEY` (and the `ADMISSIONS_EMAIL_FROM` / `RESEND_FROM` values) until you are ready.

**Check:** `vercel env ls production` lists `RESEND_API_KEY`, `RESEND_FROM`, `ADMISSIONS_EMAIL_FROM` and `RESEND_REPLY_TO`. Never use `vercel env pull` to check a value: it shows sensitive values as empty even when they're set.

## Phase 4: Turn it on in waves (after PR1 merges)

Each flip is an env change followed by a redeploy (push to `main`, or **Redeploy** on the latest production deployment in the Vercel dashboard).

**Wave 1: staff mail, sign-in codes and Admissions**

```bash
vercel env add OUTBOUND_EMAIL_TRANSPORT production
```
Value: `resend`. If the variable already exists, edit it in the Vercel dashboard instead. Then redeploy.

What changes:
- Cron alerts, autowriter alerts, weekend check, leave-request notices, admin digests and sign-in codes now go through **Resend**.
- Teacher mail (classroom schedules, feedback reminders, progress-test heads-ups) now goes through **Workspace Gmail as admin@**. That also moves it off the 100-a-day Apps Script relay.
- Admissions is not part of this flip. It already sends through Resend from Phase 3 onward (once PR1 is merged), independent of `OUTBOUND_EMAIL_TRANSPORT`.

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

## Phase 5: Bounce tracking (PR2)

1. **Apply the migration before merging PR2.** From the linked checkout, on the PR branch:

```bash
set -a && source .env.local && set +a && npm run db:migrate
```

   `.env.local` in the linked checkout holds the production Neon `DATABASE_URL`. Confirm that before running.

   Pre-check, before running it: confirm 0111 is the only pending migration. Against the production database run:

```sql
select max(created_at) from drizzle.__drizzle_migrations;
```

   It must return **1790870000000**, which is 0110's timestamp. Drizzle applies every migration with a newer timestamp, so 0111 (`1790880000000`) is the only one that will run. If it returns `1790880000000` or higher, stop: another branch already applied something newer and 0111 would be skipped. After the migration it should return **1790880000000**. Ignore the row count: prod carries a couple of historical extra rows, which is expected.
2. Merge PR2 and wait for the production deploy.
3. Resend → **Webhooks → Add endpoint**
   - URL: `https://bgscheduler.vercel.app/api/email/resend-webhook`
   - Events: `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`
4. Copy the **Signing secret** (starts with `whsec_`) and add it to Vercel:

```bash
vercel env add RESEND_WEBHOOK_SECRET production --sensitive
```
Then redeploy.

5. Resend → Webhooks → your endpoint → **Send test event**. It should show `200`. A `503` means the secret isn't deployed yet; a `401` means the secret is wrong.

## Phase 6: Optional: drop the two admin digests (after PR1 merges)

Only if staff don't act on them. The same information is on `/class-assignments` and `/progress-tests`.

```bash
vercel env add CLASSROOM_ADMIN_EMAIL_ENABLED production
```
Value: `false`

```bash
vercel env add PROGRESS_TEST_ADMIN_DIGEST_ENABLED production
```
Value: `false`

`CLASSROOM_ADMIN_EMAIL_ENABLED=false` stops only the admin summary; teachers still get their schedules.

Redeploy. To bring either digest back, set its value to `true` (or remove the variable) and redeploy.

---

## Emergency rollback

If Resend mail is missing or landing in spam:

1. Vercel → Settings → Environment Variables → `OUTBOUND_EMAIL_TRANSPORT` → change it to `gmail`.
2. Redeploy.

All app mail **except Admissions** then goes back through Workspace Gmail, with the Apps Script relay as backup. Admissions has no fallback: to stop Admissions mail, remove `RESEND_API_KEY` from Vercel and redeploy. That also moves staff mail back to Gmail, because Resend is skipped when it is unconfigured. If teacher mail alone is the problem, remove `RESEND_AUDIENCE` instead: staff mail stays on Resend and teacher mail goes back to Gmail.

## Rules that always apply

- Rotate the API key (Resend → API Keys → create new, update Vercel, redeploy, revoke the old one) if it's ever pasted anywhere outside Vercel.
- Only one Resend API key is used by production. Don't create per-feature keys.
- Never put `RESEND_*` values on a laptop, in `.env.local` on Aoeng's machine, or in Preview environments.

## Checklist

- [ ] Pro plan active, second owner added
- [ ] `notify.begiftededucation.com` verified (SPF, DKIM, DMARC)
- [ ] `RESEND_API_KEY`, `RESEND_FROM`, `ADMISSIONS_EMAIL_FROM`, `RESEND_REPLY_TO` in Vercel Production
- [ ] Wave 1: `OUTBOUND_EMAIL_TRANSPORT=resend`, sign-in code test passed, headers show PASS
- [ ] PR2: migration 0111 applied (max created_at was 1790870000000, now 1790880000000), webhook added, `RESEND_WEBHOOK_SECRET` set, test event returned 200
- [ ] (optional) digests disabled
- [ ] Wave 2 after 1–2 weeks: `RESEND_AUDIENCE=all`, teacher spot-check done
