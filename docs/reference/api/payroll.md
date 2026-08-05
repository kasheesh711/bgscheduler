# Payroll API

**Authoritative source:** the five route handlers under [`src/app/api/payroll/`](../../../src/app/api/payroll/). Status is declared by the feature doc ([docs/features/payroll.md](../../features/payroll.md) — "Status: stable"); this page does not restate it.

This page is the mechanical reference for the Payroll HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning, the reconciliation flow, and the issue taxonomy live in [docs/features/payroll.md](../../features/payroll.md). Table columns live in [docs/reference/database/erd-payroll.md](../database/erd-payroll.md), generated from the `payroll_*` tables in [`schema.ts`](../../../src/lib/db/schema.ts) (the payroll section starts at [`schema.ts:1758`](../../../src/lib/db/schema.ts)).

**Endpoints on this page (5):**

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/payroll` | session |
| POST | `/api/payroll/sync` | session |
| PATCH | `/api/payroll/review` | session **with email** |
| POST | `/api/payroll/adjustments` | session **with email** |
| DELETE | `/api/payroll/adjustments/[adjustmentId]` | session |

**There is no cron for payroll.** `POST /api/payroll/sync` is the only way a sync run starts — no payroll path appears in `vercel.json`, and no `/api/internal/*` route calls `runPayrollSync`. The dashboard at [`payroll-dashboard.tsx:143,172,192,212,240`](../../../src/components/payroll/payroll-dashboard.tsx) is the only in-repo caller, and it calls all five.

A **payroll month** is addressed in every request as `YYYY-MM` (Asia/Bangkok) and stored as the first-of-month `date` (e.g. `2026-05-01`). Handlers that take a month resolve it through `assertPayrollMonth`, which throws the literal message `Invalid month. Expected YYYY-MM.` on a malformed value ([`domain.ts:79-89`](../../../src/lib/payroll/domain.ts)); each handler maps a message *starting with* `Invalid month` to **400** and any other thrown error to **500**.

## Conventions shared across the endpoints

- **No Zod.** Unlike most BGScheduler routes, none of the payroll handlers use a Zod schema. Bodies are parsed with `request.json()` inside a `.catch()`/`try` that falls back to `{}`, then read through inline TypeScript casts. Field validation is hand-written `if` checks. Unknown fields are ignored; there is no coercion guard beyond what each handler does explicitly.
- **Authentication.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and returns `401 {"error":"Unauthorized"}` when the check fails. Two of the five (`PATCH /api/payroll/review`, `POST /api/payroll/adjustments`) require not just a session but `session.user.email`, because they stamp the actor onto the row.
- **Middleware gating.** `/api/payroll/**` is **not** in the public-route allowlist ([`middleware.ts:4-20`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:71-75`](../../../src/middleware.ts)). Additionally, a restricted user (non-null `allowedPages` that does not include `/payroll`) gets a middleware-level **403** `{"error":"Forbidden"}` for these paths, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:30-61,79-82`](../../../src/middleware.ts)). The in-handler `auth()` check is the API-level backstop; there is no payroll-specific role check.
- **No caching.** None of the five handlers, and none of `src/lib/payroll/*`, declare `"use cache"`, `revalidate`, or `dynamic`. Every request reads Postgres directly.
- **Payload echo.** `POST /api/payroll/sync`, `PATCH /api/payroll/review`, and `POST /api/payroll/adjustments` all re-read and return the full month payload (`getPayrollPayload`) in their success response, so the client never needs a follow-up `GET`. That object is documented once under [`GET /api/payroll`](#get-apipayroll) and referenced elsewhere as the **payroll payload**. `DELETE /api/payroll/adjustments/[adjustmentId]` is the one write that does **not** echo it.
- **Route tests.** [`src/app/api/payroll/__tests__/route.test.ts`](../../../src/app/api/payroll/__tests__/route.test.ts) covers GET, sync (including the 409), review (including the approval gate), and adjustment creation. The `DELETE` handler has no route test.

---

## Reading the month

### `GET /api/payroll`

Returns the full reconciled payroll payload for a month. Read-only — no writes. Handler: [`route.ts:7-23`](../../../src/app/api/payroll/route.ts).

**Auth:** session required (`if (!session)`, [`route.ts:8-11`](../../../src/app/api/payroll/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `month` | string (`YYYY-MM`) | current Bangkok month | `searchParams.get("month")` falling back to `todayBangkok().slice(0, 7)` ([`route.ts:13`](../../../src/app/api/payroll/route.ts)); `todayBangkok` is the Asia/Bangkok date key ([`room-capacity/dates.ts:27-29`](../../../src/lib/room-capacity/dates.ts)). The fallback is `??`, so a present-but-empty `?month=` is **not** replaced by the default — it reaches `assertPayrollMonth` and yields 400. |

**Response 200** — the **payroll payload** object, returned bare (no `ok`/`result` envelope). It is the value of `getPayrollPayload` → `buildPayrollPayload` ([`data.ts:258-575`](../../../src/lib/payroll/data.ts)), typed `PayrollPayload` ([`types.ts:77-127`](../../../src/lib/payroll/types.ts)). Top-level keys:

| Key | Type | Meaning |
|-----|------|---------|
| `month` | string | The requested month, `YYYY-MM`. |
| `payrollMonth` | string | First-of-month date, e.g. `2026-05-01` ([`domain.ts:91-107`](../../../src/lib/payroll/domain.ts)). |
| `rateCard` | object \| null | The single `active` rate-card version `{ id, versionName, effectiveMonth, sourceLabel, active }`, or null when none is active ([`data.ts:102-111,552-559`](../../../src/lib/payroll/data.ts)). |
| `review` | object | `{ status: "draft" \| "approved", notes, approvedByEmail, approvedByName, approvedAt, updatedAt }`; defaults to an empty draft when no row exists ([`data.ts:65-86`](../../../src/lib/payroll/data.ts)). |
| `lastSync` | object \| null | Most recent run for the month: `{ id, status, startedAt, finishedAt, teacherCount, sessionCount, invoiceCount, errorSummary }` ([`data.ts:88-100,538-543`](../../../src/lib/payroll/data.ts)). |
| `summary` | object | Month-level aggregates — totals, paid vs utilization hours, variance, detected free-pay hours, Kevin-specific totals, manual-adjustment totals, and issue / expected-rate counts. Field list at [`types.ts:105-123`](../../../src/lib/payroll/types.ts); assembly at [`data.ts:483-522`](../../../src/lib/payroll/data.ts). |
| `tutors` | `PayrollTutorRow[]` | Per-tutor aggregates, sorted by tier then tutor name ([`types.ts:39-60`](../../../src/lib/payroll/types.ts), [`data.ts:224-256,475-481`](../../../src/lib/payroll/data.ts)). |
| `issues` | `PayrollIssue[]` | Data-integrity findings. Nine `type` values: `missing_payout_invoice`, `orphan_payout_invoice`, `zero_credit_or_zero_amount`, `missing_tier`, `unresolved_tutor_identity`, `duration_mismatch`, `expected_rate_mismatch`, `missing_expected_rate_rule`, `unmapped_rate_course` ([`types.ts:3-30`](../../../src/lib/payroll/types.ts)). |
| `adjustments` | `PayrollAdjustmentDto[]` | Manual adjustment rows for the month, newest first ([`types.ts:62-75`](../../../src/lib/payroll/types.ts), [`data.ts:113-128,547-551`](../../../src/lib/payroll/data.ts)). |

The payload is assembled from seven month-scoped queries issued in parallel — review, latest sync run, teacher tiers, payout invoices, session observations, adjustments, active rate card — plus a follow-up query for that card's rate rules ([`data.ts:532-562`](../../../src/lib/payroll/data.ts)). What each issue type means and how the aggregates are derived is documented in [docs/features/payroll.md](../../features/payroll.md); this page does not restate it.

**Status codes:**

| Status | When |
|--------|------|
| 200 | Payload returned. |
| 401 | No session. |
| 400 | Thrown message starts with `Invalid month` ([`route.ts:20`](../../../src/app/api/payroll/route.ts)). |
| 500 | Any other thrown error; body is `{ error: <message> }` ([`route.ts:16-22`](../../../src/app/api/payroll/route.ts)). |

---

## Sync

### `POST /api/payroll/sync`

Runs a manual Wise payroll sync for a month, then returns the sync result and the freshly rebuilt payload. Handler: [`sync/route.ts:18-53`](../../../src/app/api/payroll/sync/route.ts). `export const maxDuration = 800` ([`sync/route.ts:9`](../../../src/app/api/payroll/sync/route.ts)).

**Auth:** session required (`if (!session)`, [`sync/route.ts:19-22`](../../../src/app/api/payroll/sync/route.ts)).

**Request body** (JSON; all fields optional, no schema):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `month` | string | current Bangkok month | Used only when `typeof input.month === "string"`; any other type silently falls back to `todayBangkok().slice(0, 7)` ([`sync/route.ts:31`](../../../src/app/api/payroll/sync/route.ts)). |
| `maxEventPages` | number | `1000` | Clamped to the integer range `[1, 2000]` by `numberOption`; a non-integer or non-number falls back to `1000` ([`sync/route.ts:13-16,39`](../../../src/app/api/payroll/sync/route.ts)). Caps how many 50-event pages of Wise `TutorPayoutInvoiceCreatedEvent` records are pulled ([`sync.ts:20-23,203-229`](../../../src/lib/payroll/sync.ts)). |

A missing or non-JSON body is treated as `{}` ([`sync/route.ts:24-30`](../../../src/app/api/payroll/sync/route.ts)), so both fields take their defaults. The Wise institute is `process.env.WISE_INSTITUTE_ID`, falling back to the hard-coded `696e1f4d90102225641cc413` ([`sync/route.ts:11,37`](../../../src/app/api/payroll/sync/route.ts)).

**Side effects** — all inside `runPayrollSync` ([`sync.ts:243-448`](../../../src/lib/payroll/sync.ts)):

- Marks any `payroll_sync_runs` row still `running` after 20 minutes as `failed` before starting ([`sync.ts:24,125-137,255`](../../../src/lib/payroll/sync.ts)).
- Inserts a new `payroll_sync_runs` row with `status: "running"`, `triggerType: "manual"`. The partial unique index `payroll_sync_runs_single_running_idx` is on `status` alone (`WHERE status = 'running'`, [`schema.ts:1773-1775`](../../../src/lib/db/schema.ts)), so it permits exactly one running row **across all months** — a second sync, even for a different month, hits a `23505` violation that is translated to `PayrollSyncAlreadyRunningError` ([`sync.ts:40-45,54-59,258-273`](../../../src/lib/payroll/sync.ts)).
- Fetches Wise teachers, the active tutor-identity snapshot, past sessions for the month window, and payout-event pages — in parallel ([`sync.ts:276-281`](../../../src/lib/payroll/sync.ts)).
- In one write transaction: **deletes and replaces** every `payroll_teacher_tiers`, `payroll_payout_invoices`, and `payroll_session_observations` row for the month; upserts the month's `payroll_reviews` row back to `status: "draft"` with `approvedByEmail`/`approvedByName`/`approvedAt` cleared — **a sync revokes an existing approval**; and marks the run `success` with the three counts ([`sync.ts:385-425`](../../../src/lib/payroll/sync.ts)). Rows are inserted in chunks of 500 ([`sync.ts:25,71-81`](../../../src/lib/payroll/sync.ts)). The transaction falls back to a dedicated `pg` `Pool` when the Neon HTTP driver rejects transactions ([`sync.ts:89-123`](../../../src/lib/payroll/sync.ts)).
- On any failure after the run row exists, the row is set to `status: "failed"` with an `errorSummary` truncated at 2,000 chars, and the error is re-thrown ([`sync.ts:26,83-87,437-447`](../../../src/lib/payroll/sync.ts)).

**Response 200** — `{ ok: true, result, payload }` ([`sync/route.ts:42`](../../../src/app/api/payroll/sync/route.ts)):

- `result` is a `PayrollSyncResult` ([`sync.ts:29-38`](../../../src/lib/payroll/sync.ts)): `{ syncRunId, status: "success", payrollMonth, teacherCount, sessionCount, invoiceCount, eventPagesFetched, sessionPagesFetched }`.
- `payload` is the payroll payload re-read after the sync ([`sync/route.ts:41`](../../../src/app/api/payroll/sync/route.ts)). See [`GET /api/payroll`](#get-apipayroll).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Sync completed; `result` + `payload` returned. |
| 401 | No session. |
| 409 | `PayrollSyncAlreadyRunningError`; body `{"error":"Payroll sync is already running"}` ([`sync/route.ts:44-46`](../../../src/app/api/payroll/sync/route.ts), [`sync.ts:40-45`](../../../src/lib/payroll/sync.ts)). |
| 400 | Thrown message starts with `Invalid month` ([`sync/route.ts:50`](../../../src/app/api/payroll/sync/route.ts)). |
| 500 | Any other thrown error, including Wise fetch failures ([`sync/route.ts:47-51`](../../../src/app/api/payroll/sync/route.ts)). |

---

## Review (approval workflow)

### `PATCH /api/payroll/review`

Sets a month's review `status` and/or `notes`, stamping the actor on approval. Handler: [`review/route.ts:6-57`](../../../src/app/api/payroll/review/route.ts).

**Auth:** session **with email** required (`if (!session?.user?.email)`, [`review/route.ts:7-10`](../../../src/app/api/payroll/review/route.ts)). `session.user.email` / `session.user.name` become `actorEmail` / `actorName` on the row ([`review/route.ts:46-47`](../../../src/app/api/payroll/review/route.ts)).

**Request body** (JSON; no schema; unparseable body → `{}` at [`review/route.ts:12`](../../../src/app/api/payroll/review/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `month` | string (`YYYY-MM`) | yes | Falsy/missing → 400 `{"error":"month is required"}` ([`review/route.ts:18-20`](../../../src/app/api/payroll/review/route.ts)). |
| `status` | `"draft"` \| `"approved"` | no | Present but not one of the two literals → 400 `{"error":"Invalid review status"}` ([`review/route.ts:21-23`](../../../src/app/api/payroll/review/route.ts)). When omitted, the insert path defaults a new row to `"draft"` while the conflict path leaves an existing `status` untouched ([`data.ts:589-614`](../../../src/lib/payroll/data.ts)). |
| `notes` | string | no | Forwarded only when `typeof notes === "string"`; otherwise `undefined`, which leaves the stored notes unchanged on conflict ([`review/route.ts:45`](../../../src/app/api/payroll/review/route.ts), [`data.ts:615`](../../../src/lib/payroll/data.ts)). |

**Approval gate (fail-closed).** When `status === "approved"`, the handler first loads the payload and counts blocking expected-rate issues — `expected_rate_mismatch`, `missing_expected_rate_rule`, `unmapped_rate_course`. If any exist it returns **409** with `Cannot approve payroll with N unresolved expected-rate issue(s).` and performs **no write** ([`review/route.ts:27-40`](../../../src/app/api/payroll/review/route.ts)). Note that a successful approval therefore builds the payload twice — once for the gate, once for the echo. The other six issue types do not block approval.

**Side effects:** `updatePayrollReview` upserts the month's `payroll_reviews` row on the `payroll_month` unique index ([`data.ts:577-619`](../../../src/lib/payroll/data.ts), [`schema.ts:1793`](../../../src/lib/db/schema.ts)). On `approved` it sets `approvedByEmail` / `approvedByName` (falling back to the email when no name) / `approvedAt = now`; on `draft` those three columns are explicitly cleared to `null` ([`data.ts:595-614`](../../../src/lib/payroll/data.ts)). `updatedAt` is always refreshed.

**Response 200** — `{ ok: true, payload }`, the payload re-read after the update ([`review/route.ts:49`](../../../src/app/api/payroll/review/route.ts)). See [`GET /api/payroll`](#get-apipayroll).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Review updated. |
| 400 | Missing `month`; invalid `status`; or thrown message starts with `Invalid month` ([`review/route.ts:18-23,54`](../../../src/app/api/payroll/review/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 409 | Approval attempted while unresolved expected-rate issues remain ([`review/route.ts:34-39`](../../../src/app/api/payroll/review/route.ts)). |
| 500 | Any other thrown error ([`review/route.ts:50-56`](../../../src/app/api/payroll/review/route.ts)). |

---

## Manual adjustments

### `POST /api/payroll/adjustments`

Adds one manual adjustment row (extra hours and/or amount) to a month. Handler: [`adjustments/route.ts:6-45`](../../../src/app/api/payroll/adjustments/route.ts).

**Auth:** session **with email** required (`if (!session?.user?.email)`, [`adjustments/route.ts:7-10`](../../../src/app/api/payroll/adjustments/route.ts)). The email/name become the row's `createdByEmail` / `createdByName` ([`adjustments/route.ts:34-35`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:647-648`](../../../src/lib/payroll/data.ts)).

**Request body** (JSON; no schema; unparseable body → `{}` at [`adjustments/route.ts:12`](../../../src/app/api/payroll/adjustments/route.ts)):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `month` | string (`YYYY-MM`) | yes | Falsy/missing → 400 `{"error":"month is required"}` ([`adjustments/route.ts:22`](../../../src/app/api/payroll/adjustments/route.ts)). |
| `description` | string | yes | Missing or whitespace-only (`!body.description?.trim()`) → 400 `{"error":"description is required"}` ([`adjustments/route.ts:23`](../../../src/app/api/payroll/adjustments/route.ts)). Trimmed before insert ([`data.ts:645`](../../../src/lib/payroll/data.ts)). |
| `adjustmentType` | string | no | Defaults to `"manual"` at the route ([`adjustments/route.ts:28`](../../../src/app/api/payroll/adjustments/route.ts)); `addPayrollAdjustment` re-trims and re-defaults to `"manual"` when blank ([`data.ts:640`](../../../src/lib/payroll/data.ts)). Free text — not an enum. |
| `tutorCanonicalKey` | string \| null | no | Trimmed; blank → `null` ([`data.ts:641`](../../../src/lib/payroll/data.ts)). Not validated against any tutor identity. |
| `tutorDisplayName` | string \| null | no | Trimmed; blank → `null` ([`data.ts:642`](../../../src/lib/payroll/data.ts)). |
| `hours` | number | no | Coerced with `Number(body.hours ?? 0)`; a non-finite result is stored as `0` ([`adjustments/route.ts:31`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:643`](../../../src/lib/payroll/data.ts)). |
| `amount` | number | no | Coerced with `Number(body.amount ?? 0)`; a non-finite result is stored as `0` ([`adjustments/route.ts:32`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:644`](../../../src/lib/payroll/data.ts)). |

**Side effects:** inserts one `payroll_adjustments` row with `source: "manual"` and returns it ([`data.ts:621-652`](../../../src/lib/payroll/data.ts)). Adjustments are additive-only — they feed `summary.manualAdjustmentHours` / `manualAdjustmentAmount` on the next payload build ([`data.ts:483-484,513-514`](../../../src/lib/payroll/data.ts)) and do **not** alter `tutors[]` rows or `summary.totalPayoutAmount`, which are derived solely from synced invoices and sessions ([`data.ts:485-492`](../../../src/lib/payroll/data.ts)). The month's review row is not touched, so an approved month can still receive adjustments without losing its approval.

**Response 200** — `{ ok: true, adjustment, payload }` ([`adjustments/route.ts:37`](../../../src/app/api/payroll/adjustments/route.ts)):

- `adjustment` — the inserted row as a `PayrollAdjustmentDto`: `{ id, payrollMonth, adjustmentType, tutorCanonicalKey, tutorDisplayName, hours, amount, description, source, createdByEmail, createdByName, createdAt }` ([`types.ts:62-75`](../../../src/lib/payroll/types.ts), [`data.ts:113-128`](../../../src/lib/payroll/data.ts)).
- `payload` — the payroll payload re-read after the insert. See [`GET /api/payroll`](#get-apipayroll).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Adjustment added. |
| 400 | Missing `month`; missing/blank `description`; or thrown message starts with `Invalid month` ([`adjustments/route.ts:22-23,42`](../../../src/app/api/payroll/adjustments/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 500 | Any other thrown error ([`adjustments/route.ts:38-44`](../../../src/app/api/payroll/adjustments/route.ts)). |

---

### `DELETE /api/payroll/adjustments/[adjustmentId]`

Deletes a single manual adjustment by id. Handler: [`adjustments/[adjustmentId]/route.ts:6-21`](../../../src/app/api/payroll/adjustments/%5BadjustmentId%5D/route.ts).

**Auth:** session required (`if (!session)`, [`adjustments/[adjustmentId]/route.ts:10-13`](../../../src/app/api/payroll/adjustments/%5BadjustmentId%5D/route.ts)) — note this endpoint does **not** require `user.email`, and it records no actor for the deletion.

**Path parameter:**

| Param | Type | Notes |
|-------|------|-------|
| `adjustmentId` | string | The `payroll_adjustments.id` UUID ([`schema.ts:1868`](../../../src/lib/db/schema.ts)). Awaited from `context.params` (Next.js 16 async params, [`adjustments/[adjustmentId]/route.ts:8,15`](../../../src/app/api/payroll/adjustments/%5BadjustmentId%5D/route.ts)). |

No request body is read and no month is resolved, so this endpoint never returns the `Invalid month` 400.

**Side effects:** `deletePayrollAdjustment` issues `DELETE ... RETURNING id` against `payroll_adjustments` and reports whether a row matched ([`data.ts:654-660`](../../../src/lib/payroll/data.ts)). The delete is unscoped by month and hard (no soft-delete column) — any adjustment id is deletable by any signed-in user who can reach `/payroll`.

**Response:**

- **200** — `{ ok: true }` when a row was deleted ([`adjustments/[adjustmentId]/route.ts:20`](../../../src/app/api/payroll/adjustments/%5BadjustmentId%5D/route.ts)). Unlike the other writes, this one does **not** echo the payload; the dashboard refetches with `GET /api/payroll` ([`payroll-dashboard.tsx:240-243`](../../../src/components/payroll/payroll-dashboard.tsx)).
- **404** — `{"error":"Adjustment not found"}` when no row matched ([`adjustments/[adjustmentId]/route.ts:17-19`](../../../src/app/api/payroll/adjustments/%5BadjustmentId%5D/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Row deleted. |
| 401 | No session. |
| 404 | No adjustment with that id. |

No `try`/`catch` wraps the delete, so a database error — for example a malformed non-UUID `adjustmentId` cast against the `uuid` primary key — surfaces as a framework-level 500 rather than a handler-shaped `{ error }` body.

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
