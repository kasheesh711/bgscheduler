# Credit Control retirement

`CREDIT_CONTROL_MODE` accepts `retired` (the default) or `active`. Retirement preserves the code, data, permissions, follow-up history, ownership and LINE digest preferences. It pauses the workspace, feature APIs, automatic credit alerts, and follow-up/churn maintenance.

The shared student/session/credit snapshot remains available to Parent Reports, LINE and Progress Tests. In retired mode its scheduled refresh runs at 06:20 Bangkok with recovery opportunities at 06:50 and 07:20; ordinary half-hourly cron ticks do no Wise work. Progress Tests refresh at 07:25 with recovery opportunities at 07:55 and 08:25, using that morning's successfully promoted shared snapshot. Its 07:35 digest requires a completed daily refresh. Authenticated Data Health manual recovery remains available.

Student schedules use a shared institute/month live cache for at most 60 seconds. Explicit refresh bypasses the completed cache while joining an existing refresh. Failed refreshes retain complete cached data or the shared snapshot, visibly marked stale with its actual source timestamp. Public links still grant exactly one student/month.

## Restore

1. Set `CREDIT_CONTROL_MODE=active` in the production environment and redeploy.
2. Run the shared snapshot job from Data Health and verify successful promotion.
3. Confirm Credit Control's navigation, workspace, half-hourly refresh and saved LINE digest preferences are restored. Progress Tests remain daily.

Apply the additive schedule-cache migration before deploying this change. No Credit Control table is removed or renamed. Skipped cron invocations are not proof of fresh data. A live Wise outage can exceed the schedule freshness target; the page must show this rather than claiming a fresh or empty schedule.

## Failure handling

Retired-mode shared refreshes require complete credit fetches and check their abort signal before creating or promoting a snapshot. A deadline or failed credit fetch records a failed run and preserves the prior active snapshot for readers and the next scheduled recovery attempt. The existing attendance and credit-history calculations remain unchanged.
