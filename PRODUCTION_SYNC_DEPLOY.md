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

## 5. Verify search behavior

From an authenticated session:

- open `https://bgscheduler.vercel.app/search`
- run at least one recurring search
- run at least one one-time search
- confirm results render instead of `No active snapshot found`

## 6. Check cron continuity

Current production cron runs these data refreshes every 30 minutes on Vercel Pro:

- `/api/internal/sync-wise` at `*/30 * * * *`
- `/api/internal/sync-sales-dashboard` at `10,40 * * * *`
- `/api/internal/sync-credit-control` at `20,50 * * * *`

Confirm recent `sync_runs`, `sales_dashboard_import_runs`, and `credit_control_sync_runs` rows complete successfully and that no fresh overlapping `running` rows remain. Old abandoned `running` rows should be marked failed by the single-flight guards after 20 minutes.
