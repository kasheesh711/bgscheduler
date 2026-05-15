# Apps Script Schedule Email Relay

Classroom schedule emails are sent by a Google Apps Script Web App authorized as
`kevhsh7@gmail.com`. The Next.js app calls the Web App with a shared secret, and
Apps Script sends via `MailApp`.

## 1. Create Script

Open `https://script.google.com` while signed in as `kevhsh7@gmail.com`, create a
new project, and paste this code:

```javascript
const SECRET_PROPERTY = "SCHEDULE_EMAIL_APPS_SCRIPT_SECRET";

function doPost(e) {
  try {
    const payload = JSON.parse((e.postData && e.postData.contents) || "{}");
    const expectedSecret = PropertiesService
      .getScriptProperties()
      .getProperty(SECRET_PROPERTY);

    if (!expectedSecret || payload.secret !== expectedSecret) {
      return json({ ok: false, error: "Unauthorized" });
    }

    for (const field of ["to", "subject", "text", "html", "idempotencyKey"]) {
      if (!payload[field]) {
        return json({ ok: false, error: "Missing field: " + field });
      }
    }

    const sentId = "apps-script:" + payload.idempotencyKey;
    const cacheKey = "sent:" + payload.idempotencyKey;
    const cache = CacheService.getScriptCache();
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      if (cache.get(cacheKey)) {
        return json({
          ok: true,
          id: sentId,
          duplicate: true,
          remainingQuota: MailApp.getRemainingDailyQuota(),
        });
      }

      const remainingQuota = MailApp.getRemainingDailyQuota();
      if (remainingQuota < 1) {
        return json({
          ok: false,
          error: "MailApp daily recipient quota is exhausted",
          remainingQuota,
        });
      }

      MailApp.sendEmail({
        to: payload.to,
        subject: payload.subject,
        body: payload.text,
        htmlBody: payload.html,
        name: payload.senderName || "BeGifted",
        replyTo: payload.replyTo || "kevhsh7@gmail.com",
      });
      cache.put(cacheKey, sentId, 21600);

      return json({
        ok: true,
        id: sentId,
        remainingQuota: MailApp.getRemainingDailyQuota(),
      });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json({
      ok: false,
      error: error && error.message ? error.message : "Apps Script email send failed",
    });
  }
}

function json(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## 2. Add Script Secret

In Apps Script, open `Project Settings` and add a script property:

```text
SCHEDULE_EMAIL_APPS_SCRIPT_SECRET=<same value as Vercel>
```

Use a long random string. The value must match `SCHEDULE_EMAIL_APPS_SCRIPT_SECRET`
in `.env.local` and Vercel.

## 3. Deploy Web App

1. Click `Deploy` -> `New deployment`.
2. Select type `Web app`.
3. Set `Execute as` to `Me`.
4. Set access to `Anyone` or `Anyone with the link`.
5. Authorize the script when prompted.
6. Copy the `/exec` Web App URL into `SCHEDULE_EMAIL_APPS_SCRIPT_URL`.

## 4. Configure Vercel

```bash
npx vercel env add SCHEDULE_EMAIL_APPS_SCRIPT_URL production
npx vercel env add SCHEDULE_EMAIL_APPS_SCRIPT_SECRET production --sensitive
npx vercel env add SCHEDULE_EMAIL_SENDER_NAME production
npx vercel env add SCHEDULE_EMAIL_REPLY_TO production
npx vercel --prod
```

After the Apps Script relay is deployed and tested, remove the obsolete Resend
production variable:

```bash
npx vercel env rm RESEND_API_KEY production
```

## Quota Notes

Personal Gmail Apps Script sending is limited by Google quotas. This app assumes
schedule emails stay under 100 recipients per day.

The script caches each `idempotencyKey` for 6 hours to reduce accidental duplicate
sends if the same schedule email request is retried. The app includes the email
run audit id in that key, so a new manual send attempt can still send the same
tutor again.
