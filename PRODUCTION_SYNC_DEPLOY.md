# Production Sync Deploy Flow

Use this flow after merging or committing Wise integration fixes to `main`.

## 1. Verify required production environment variables

Production must have these values configured in Vercel:

- `DATABASE_URL`
- `AUTH_GOOGLE_ID`
- `AUTH_GOOGLE_SECRET`
- `AUTH_SECRET`
- `WISE_USER_ID`
- `WISE_API_KEY`
- `WISE_NAMESPACE=begifted-education`
- `WISE_INSTITUTE_ID=696e1f4d90102225641cc413`
- `CRON_SECRET`
- `WISE_CLASSROOM_WRITEBACK_ALLOWED_EMAILS=kevinhsieh711@gmail.com,kevhsh7@gmail.com` if `ENABLE_WISE_CLASSROOM_WRITEBACK=true`

Check them with:

```bash
npx vercel env ls production
```

## 2. Deploy production

If Git integration is healthy, pushing `main` is enough:

```bash
git push origin main
```

If a manual production deploy is needed:

```bash
npx vercel --prod
```

## 3. Trigger a production Wise sync

Run the protected sync endpoint after the new deployment is live:

```bash
curl -X POST https://bgscheduler.vercel.app/api/internal/sync-wise \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected success response fields:

- `success: true`
- `snapshotId`
- `promotedSnapshotId`

If `promotedSnapshotId` is `null`, the sync wrote a candidate snapshot but did not activate it.

## 4. Verify snapshot promotion

Open the data-health endpoint from an authenticated session or use the UI:

- `https://bgscheduler.vercel.app/data-health`

Confirm:

- `activeSnapshotId` is non-null
- the latest sync run status is `success`
- `lastFailureError` is null or older than the successful sync
- no recent cron sync is shown as `timed out`; Wise sync routes use `maxDuration = 800` and should not hit the old 300s ceiling on Pro

## 5. Verify search behavior

From an authenticated session:

- open `https://bgscheduler.vercel.app/search`
- run at least one recurring search
- run at least one one-time search
- confirm results render instead of `No active snapshot found`

## 6. Check cron continuity

Current production cron cadence requires Vercel Pro or Enterprise. Hobby only supports daily cron and will reject this schedule at deploy time.

- `/api/internal/sync-wise/daytime` — `0,30 0-11 * * *` (07:00-18:30 Bangkok, every 30 minutes)
- `/api/internal/sync-wise/overnight` — `0 12-23 * * *` (19:00-06:00 Bangkok, hourly)

After deployment, verify with:

```bash
npx vercel crons ls
```
