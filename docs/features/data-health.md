# Data Health

**Status: stable**

## Purpose

Data Health is now the admin-facing operations command center for the site. It answers two questions:

- Are the scheduled production jobs actually firing?
- Is the data used by search, scheduling, sales, credit control, leave requests, classrooms, and room capacity fresh enough to trust?

The page still owns the Wise snapshot health view used by the stale-data banner, but it no longer stops there. It now combines cron invocation audit rows, existing feature run ledgers, active snapshot stats, normalization issue drill-downs, and manual run controls.

## Data Model

Data Health reads the existing feature run ledgers and adds one generic audit table:

| Table | Role |
|---|---|
| `cron_invocations` | One valid cron/admin invocation of a registered operational job. Written by the route wrapper after auth succeeds; stores job key, path, schedule, trigger source, actor, response status, outcome, duration, error summary, and linked run metadata. |
| `sync_runs` | Wise snapshot sync ledger and stale-snapshot source of truth. |
| `wise_activity_sync_runs` | Wise Activity cron/manual sync evidence. |
| `sales_dashboard_import_runs`, `sales_dashboard_projection_import_runs` | Sales source and projection refresh evidence. |
| `credit_control_sync_runs` | Credit-control snapshot evidence. |
| `leave_request_sync_runs` | Leave-request sheet sync evidence. |
| `classroom_assignment_runs`, `classroom_admin_email_runs` | Morning automation and admin email evidence. |
| `room_utilization_sessions` | Manual-only room-utilization sync evidence. |
| `snapshots`, `snapshot_stats`, `data_issues` | Active Wise snapshot, roll-up stats, and unresolved normalization issues. |

`cron_invocations` is best-effort: audit write failures are logged but do not block production cron execution.

## API Surface

| Endpoint | Purpose |
|---|---|
| `GET /api/data-health` | Returns the v2 dashboard payload: `overall`, `cronJobs`, `dataDomains`, `wiseSnapshot`, `issueSummary`, `issueDetails`, `recentRuns`, and compatibility fields (`staleAgeMs`, `lastSuccessfulSync`, etc.) consumed by the stale banner. |
| `POST /api/data-health/jobs/[jobKey]/run` | Session-gated manual trigger for registered jobs. Dangerous jobs require `{ "confirmed": true }`. |
| `POST /api/admin/sync-wise` | Legacy/admin Wise sync trigger; now also records a `cron_invocations` audit row. |

## UI

- **Page:** `src/app/(app)/data-health/page.tsx` is a Server Component that auth-checks and loads the initial dashboard payload.
- **Interactive dashboard:** `src/components/data-health/data-health-dashboard.tsx` handles refresh, manual run buttons, confirmations, and UI state.
- **Primary sections:** overall health strip, next expected cron timeline, manual controls, cron control plane, data freshness, Wise snapshot fidelity, normalization issue tables, and unified run history.
- **Status values:** `healthy`, `late`, `failing`, `running`, `manual-only`, `unknown`.

## Cron Health Rules

- 30-minute sync jobs are late when the latest observed evidence is older than cadence + 15 minutes.
- Daily classroom jobs are evaluated against Bangkok business windows:
  - morning automation: 06:45 Bangkok
  - admin email retry ladder: 07:00-07:30 Bangkok
- Running jobs are marked failing after configured `maxDuration` plus a one-minute buffer.
- Until new `cron_invocations` rows exist for a job, health can be inferred from durable run tables; the UI labels this as inferred proof.
- Room utilization remains `manual-only` because it is not listed in `vercel.json`.

## Tests

- `src/lib/data-health/__tests__/cron-registry.test.ts` checks registry parity with `vercel.json`.
- `src/lib/data-health/__tests__/status.test.ts` covers interval lateness, Bangkok daily windows, stuck runs, and recovery after later success.
- `src/lib/data-health/__tests__/migration.test.ts` checks the cron audit migration shape.
- `src/app/api/data-health/__tests__/route.test.ts` covers the v2 payload route and legacy stale-banner fields.
- `src/app/api/data-health/jobs/[jobKey]/run/__tests__/route.test.ts` covers auth, unknown jobs, and dangerous-job confirmation.
- `src/components/data-health/__tests__/data-health-dashboard.test.tsx` smoke-tests the rendered command-center sections.

_Updated for the Ops Command dashboard refactor on 2026-06-01._
