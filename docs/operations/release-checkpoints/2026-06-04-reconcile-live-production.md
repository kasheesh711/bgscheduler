# 2026-06-04 Live Production Reconciliation Checkpoint

This checkpoint records the known-good production state before merging the
`codex/reconcile-live-production-2026-06-04` branch back to `main`.

## Known-Good Production

| Field | Value |
| --- | --- |
| Production alias | `https://bgscheduler.vercel.app` |
| Deployment ID | `dpl_5S1abfEyBEPRDdd2LZyRb2DNWRWK` |
| Deployment URL | `https://bgscheduler-bl5sz78th-kevins-projects-6ebb4efc.vercel.app` |
| Vercel output items | `362` |
| Recorded source branch | `codex/reconcile-live-production-2026-06-04` |
| Live-source snapshot commit | `8cc2717eae9f1cabd9cecf8ae5df3919bc59e3e1` |
| `origin/main` at checkpoint | `e1c794c9ef386c4c02472790cf54d31343ee0c92` |

The source route surface is recorded in
[`docs/reference/production-route-surface.json`](../../reference/production-route-surface.json).

## Migration State

Production Drizzle table: `drizzle.__drizzle_migrations`.

Latest production rows recorded before merge:

| id | hash | created_at | Local journal tag |
| --- | --- | --- | --- |
| 40 | `8cd8c6aa14c92b4fd8349968e4a98f898ee3285d4909aa815824aa596f88c7ab` | `1780362000000` | `0040_student_promotions` |
| 39 | `eb91917a8cc358bb0072b21189ff1b79ffaf3710875431b4a1d8c072f5f6e77d` | `1780358400000` | `0039_line_link_validation_source_indexes` |
| 38 | `952aede110334b23f62a2359f31c0f57cc561fb2bdb68bef4616dade5aa62c55` | `1780315200000` | `0038_data_health_cron_invocations` |
| 37 | `8e04601b2f5b9faab847e9ac3aaa81a5aa848867df40cf7f0141a22c339b2f7b` | `1780311600000` | `0037_payroll_rate_cards` |
| 36 | `197551e970303869f9ab8044326ef18aa57ef8fc1d51fd5109c166e001ebc16b` | `1780304400000` | `0036_tutor_leave_requests` |

## Rollback Gate

After the post-merge production deployment from `main`, smoke-check:

```bash
curl -I https://bgscheduler.vercel.app/leave-requests
curl -I https://bgscheduler.vercel.app/line-review
curl -I https://bgscheduler.vercel.app/payroll
curl -I https://bgscheduler.vercel.app/student-promotions
curl -I https://bgscheduler.vercel.app/api/data-health/jobs/sync-wise/run
curl -I https://bgscheduler.vercel.app/api/internal/sync-leave-requests
curl -I https://bgscheduler.vercel.app/api/internal/student-promotions/july-1
```

Expected unauthenticated responses are redirects for admin pages and `401` for
cron-only internal routes. Any `404`, `500`, or unexpected missing route is a
release blocker.

If any critical route fails or the route surface regresses, immediately run:

```bash
vercel rollback dpl_5S1abfEyBEPRDdd2LZyRb2DNWRWK --yes --timeout 5m
```

Do not drop or roll back database objects as part of app rollback. The recorded
migrations are additive and can remain inert if the app code is rolled back.
