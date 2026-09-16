# Tutor Sit-ins API

All workspace routes require Google sign-in, the feature flag, an enabled account and fresh feature authorization. Responses are `private, no-store`. Mutations require an `Origin` matching the request origin. Inputs are strict Zod objects; unknown properties are rejected. IDs are UUIDs except Wise IDs. `expectedRevision` is the last revision read; conflicting edits return 409.

| Method | Path | Contract |
|---|---|---|
| GET | `/api/tutor-sit-ins?quarter=2026-Q4` | Scoped assignments, current observations, deadlines, communication tasks and delivery status. Defaults to the current Bangkok quarter, floored at Q4 2026. |
| POST | `/api/tutor-sit-ins/refresh` | `{quarter}`. Refreshes source evidence, generates unique obligations, reconciles current bookings, recalculates suggestions and returns the dashboard. Up to 300 seconds. |
| GET | `/api/tutor-sit-ins/settings?quarter=2026-Q4` | Manager-only grants, tutor contacts, class mappings, unresolved classes and source errors. |
| POST | `/api/tutor-sit-ins/settings` | Manager commands below; all require a reason. |
| GET | `/api/tutor-sit-ins/{assignmentId}` | Scoped detail, attempts, communication and delivery jobs. Coordinators receive no reports or audit entries. |
| PATCH | `/api/tutor-sit-ins/{assignmentId}` | `{action,expectedRevision,reason}`; action is `cancel`, `exempt`, `reopen`, or `reassign` (also `email`). Assigned head may cancel; other commands require manager access. |
| POST | `/api/tutor-sit-ins/{assignmentId}/book` | `{sessionId,expectedRevision}`. Assigned head or manager confirms after live checks; exact repeat returns the existing booking. Up to 300 seconds. |
| PUT | `/api/tutor-sit-ins/reports/{reportId}` | `{expectedRevision,submit,data}`. Only the actual observer may write. `data`: `scores` and optional criterion `notes`, `strengths`, `priorities`, `nextSteps`, `occurred`. Returns the saved report with server score, revision and late/submission state. |
| PATCH | `/api/tutor-sit-ins/communications/{communicationId}` | Staff `{expectedRevision,audience:"parent"\|"student"}` acknowledgement. Manager resolution: `{action:"resolve",expectedRevision,familyKey,parentName,reason}`. |
| GET | `/api/tutor-sit-ins/calendar` | Current account's connection status, safe calendar list, selection, revision and errors; no tokens. |
| PATCH | `/api/tutor-sit-ins/calendar` | `{calendarId,busyCalendarIds,expectedRevision}`; owned destination required. |
| DELETE | `/api/tutor-sit-ins/calendar` | Disconnect current account after outstanding event withdrawals finish. |
| POST | `/api/tutor-sit-ins/calendar/connect` | Sets encrypted HttpOnly OAuth state cookie; returns `{url}` for separate Google consent. |
| GET | `/api/tutor-sit-ins/calendar/callback` | Verifies session/state, exchanges code, stores encrypted credentials; redirects to dashboard with `calendar=connected` or `calendar=error`. Codes/provider bodies are not logged. |
| GET | `/api/internal/tutor-sit-ins` | Cron-secret only, monitored worker; every ten minutes; 300-second maximum. |
| GET | `/api/internal/tutor-sit-ins/digest` | Cron-secret only, queues daily digest and drains outbox at 08:00 Bangkok; 300-second maximum. |

## Settings commands

```ts
{ action: "grant", email, role: "observer" | "coordinator" | "manager",
  departments: Department[], scopes: CoverageScope[], canonicalKey: string | null, active: boolean,
  expectedRevision: number, reason: string }
{ action: "mapping", classId: string, departments: Department[], scopes: CoverageScope[],
  expectedRevision: number, reason: string }
{ action: "assignment", quarter: string, canonicalKey: string,
  department: Department, coverageScope: CoverageScope, reason: string }
```

Departments: `physics`, `maths`, `english`, `chemistry`, `iseb`, `science`. Coverage scopes: the five ordinary subject names plus `iseb_english_vr`, `iseb_maths_vr`, `iseb_other`. Scope and department must agree. Legacy omitted scope fields map `iseb` only to `iseb_other`, never to all strands. A mapping can contain multiple departments or an explicit empty list. New mapping/grant creation starts at expected revision zero. Reasons are trimmed, 3–1000 characters.

## Readiness payloads

Assignments include `coverageScope`, `allocationMode` (`automatic` / `manual`) and `readinessIssues`. Each issue has `code`, `category`, `message`, `action`, and `retryable`. Suggestions include `verification: "wise_only" | "verified"` and their own `issues`. `wise_only` is provisional and cannot be confirmed without live Calendar and Wise checks. Detail includes `deliveryEnabled` for the confirmation control. Superseded obligations are omitted from active lists but their authorized detail and audit history remain available.

Settings class summaries aggregate `students`, `scopes`, `sessionCount`, `rosterPending`, `familyPending`, and `identityPending`; `unresolved` refers only to missing subject mapping. Summary students are display evidence, never a replacement lesson roster.

## Failure behavior

401 means no valid session; 403 means insufficient/revoked access or cross-origin mutation; 400 means invalid input; 404 means absent assignment/report; 409 means stale version, insufficient notice, incomplete availability, self-observation or another scheduling conflict. Disabled setup/delivery returns 503. Provider failures are visible and queued deliveries retry with persistent identifiers. Generic 500 responses disclose neither SQL nor credentials.

The cron routes use the existing constant-time secret check and `withCronInvocationAudit` monitoring. Worker leases, per-observer operation leases and outbox leases are persisted separately.

_Verified against `codex/sit-in-allocations` on 2026-09-16._
