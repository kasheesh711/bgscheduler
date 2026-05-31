# Payroll API

**Status: stable.** **Authoritative source:** the five route handlers under [`src/app/api/payroll/`](../../../src/app/api/payroll/).

This page is the mechanical reference for the Payroll HTTP endpoints: method, path, auth, request shape, response shape, side effects, and status codes. Feature meaning, the reconciliation flow, and the issue taxonomy live in [docs/features/payroll.md](../../features/payroll.md). Table columns are defined in [`schema.ts`](../../../src/lib/db/schema.ts) — the eight `payroll_*` tables start at [`schema.ts:855`](../../../src/lib/db/schema.ts).

A **payroll month** is addressed in every request as `YYYY-MM` (Asia/Bangkok). Each handler that takes a month resolves it through `assertPayrollMonth`, which throws `Invalid month. Expected YYYY-MM.` on a malformed value ([`domain.ts:79-89`](../../../src/lib/payroll/domain.ts)); every handler maps that specific message to **400** and any other thrown error to **500**.

## Conventions shared across the endpoints

- **No Zod.** Unlike most BGScheduler routes, none of the payroll handlers use a Zod schema. Bodies are parsed with `request.json()` inside a `.catch()` that falls back to `{}`, then read through inline TypeScript casts. Field validation is hand-written `if` checks. There is no rejection of unknown fields and no type coercion guard beyond what each handler does explicitly.
- **Authentication.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and returns `401 {"error":"Unauthorized"}` when the session check fails. Two of the five (`PATCH /api/payroll/review`, `POST /api/payroll/adjustments`) require not just a session but `session.user.email`, because they stamp the actor's email/name onto the row. The middleware also gates the whole `/api/payroll/**` subtree: it is **not** in the public-route allowlist ([`middleware.ts:4-15`](../../../src/middleware.ts)), so an unauthenticated browser request is redirected to `/login` before the handler runs. The in-handler `auth()` check is the API-level backstop.
- **Payload echo.** `POST /api/payroll/sync`, `PATCH /api/payroll/review`, and `POST /api/payroll/adjustments` all re-read and return the full month payload (`getPayrollPayload`) in their success response, so the client never needs a follow-up `GET`. The shape of that payload object is documented once under [`GET /api/payroll`](#get-apipayroll) and referenced elsewhere as the **payroll payload**.

---

## Sync

### `POST /api/payroll/sync`

Runs a manual Wise payroll sync for a month, then returns the sync result and the freshly-rebuilt payload. Handler: [`sync/route.ts:18-53`](../../../src/app/api/payroll/sync/route.ts). `maxDuration = 800` ([`sync/route.ts:9`](../../../src/app/api/payroll/sync/route.ts)).

**Auth:** session required (`if (!session)`, [`sync/route.ts:19-22`](../../../src/app/api/payroll/sync/route.ts)).

**Request body** (JSON; all fields optional, no schema):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `month` | string | current Bangkok month (`todayBangkok().slice(0,7)`) | Read only if a string; any other type silently falls back to the default ([`sync/route.ts:31`](../../../src/app/api/payroll/sync/route.ts)). |
| `maxEventPages` | number | `1000` | Clamped to the integer range `[1, 2000]` by `numberOption`; non-integers fall back to `1000` ([`sync/route.ts:13-16,39`](../../../src/app/api/payroll/sync/route.ts)). Caps how many pages of Wise payout events are pulled. |

A missing or non-JSON body is treated as `{}` ([`sync/route.ts:24-30`](../../../src/app/api/payroll/sync/route.ts)), so both `month` and `maxEventPages` fall to their defaults.

The Wise institute is taken from `process.env.WISE_INSTITUTE_ID`, falling back to the hard-coded `696e1f4d90102225641cc413` ([`sync/route.ts:11,37`](../../../src/app/api/payroll/sync/route.ts)).

**Side effects** (in `runPayrollSync`, [`sync.ts:243-448`](../../../src/lib/payroll/sync.ts)):

- Marks any `payroll_sync_runs` row still `running` after 20 minutes as `failed` ([`sync.ts:125-137,255`](../../../src/lib/payroll/sync.ts)).
- Inserts a new `payroll_sync_runs` row with `status: "running"`, `triggerType: "manual"`. A partial unique index allowing only one `running` row at a time means a concurrent sync raises a `23505` violation, surfaced as `PayrollSyncAlreadyRunningError` ([`sync.ts:258-273`](../../../src/lib/payroll/sync.ts)).
- Fetches teachers, the active tutor-identity snapshot, past sessions, and payout events from Wise in parallel ([`sync.ts:276-281`](../../../src/lib/payroll/sync.ts)).
- In a single write transaction: **deletes and replaces** all `payroll_teacher_tiers`, `payroll_payout_invoices`, and `payroll_session_observations` rows for the month; upserts the month's `payroll_reviews` row back to `status: "draft"` (clearing any prior approval); and marks the run `status: "success"` with teacher/session/invoice counts ([`sync.ts:385-425`](../../../src/lib/payroll/sync.ts)). The transaction runs over a dedicated `pg` Pool when the Neon HTTP driver rejects transactions ([`sync.ts:100-123`](../../../src/lib/payroll/sync.ts)).
- On any failure inside the run, the sync row is set to `status: "failed"` with a truncated `errorSummary` and the error is re-thrown ([`sync.ts:437-447`](../../../src/lib/payroll/sync.ts)).

**Response 200** — `{ ok: true, result, payload }`:

- `result` is a `PayrollSyncResult` ([`sync.ts:29-38`](../../../src/lib/payroll/sync.ts)): `{ syncRunId, status: "success", payrollMonth, teacherCount, sessionCount, invoiceCount, eventPagesFetched, sessionPagesFetched }`.
- `payload` is the full payroll payload re-read after the sync ([`sync/route.ts:41-42`](../../../src/app/api/payroll/sync/route.ts)). See [`GET /api/payroll`](#get-apipayroll).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Sync completed; `result` + `payload` returned. |
| 401 | No session. |
| 409 | A sync is already running (`PayrollSyncAlreadyRunningError`); body `{"error":"Payroll sync is already running"}` ([`sync/route.ts:44-46`](../../../src/app/api/payroll/sync/route.ts)). |
| 400 | Error message starts with `Invalid month` ([`sync/route.ts:50`](../../../src/app/api/payroll/sync/route.ts)). |
| 500 | Any other thrown error; body carries the error message ([`sync/route.ts:47-51`](../../../src/app/api/payroll/sync/route.ts)). |

---

## Reading the month

### `GET /api/payroll`

Returns the full reconciled payroll payload for a month. Read-only — no writes. Handler: [`route.ts:7-23`](../../../src/app/api/payroll/route.ts).

**Auth:** session required (`if (!session)`, [`route.ts:8-11`](../../../src/app/api/payroll/route.ts)).

**Query parameters:**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `month` | string (`YYYY-MM`) | current Bangkok month | From `searchParams.get("month")`, falling back to `todayBangkok().slice(0,7)` ([`route.ts:13`](../../../src/app/api/payroll/route.ts)). |

**Response 200** — the **payroll payload** object, the return value of `getPayrollPayload` / `buildPayrollPayload` ([`data.ts:258-575`](../../../src/lib/payroll/data.ts)), typed as `PayrollPayload` ([`types.ts:77-127`](../../../src/lib/payroll/types.ts)). The handler returns it directly (no `ok`/`result` envelope). Top-level keys:

| Key | Type | Meaning |
|-----|------|---------|
| `month` | string | The requested month, `YYYY-MM`. |
| `payrollMonth` | string | First-of-month date, e.g. `2026-05-01`. |
| `rateCard` | object \| null | Active rate-card version `{ id, versionName, effectiveMonth, sourceLabel, active }`, or null if none active ([`data.ts:102-111`](../../../src/lib/payroll/data.ts)). |
| `review` | object | `{ status: "draft" \| "approved", notes, approvedByEmail, approvedByName, approvedAt, updatedAt }` ([`data.ts:76-86`](../../../src/lib/payroll/data.ts)). |
| `lastSync` | object \| null | Most recent sync run `{ id, status, startedAt, finishedAt, teacherCount, sessionCount, invoiceCount, errorSummary }`, or null ([`data.ts:88-100`](../../../src/lib/payroll/data.ts)). |
| `summary` | object | Month-level aggregates (totals, paid vs utilization hours, variance, free-pay hours, Kevin-specific totals, manual-adjustment totals, and issue/expected-rate counts). See `PayrollPayload["summary"]` ([`types.ts:105-123`](../../../src/lib/payroll/types.ts)) and the assembly at [`data.ts:504-522`](../../../src/lib/payroll/data.ts). |
| `tutors` | `PayrollTutorRow[]` | Per-tutor aggregate rows, sorted by tier then name ([`types.ts:39-60`](../../../src/lib/payroll/types.ts), [`data.ts:224-256`](../../../src/lib/payroll/data.ts)). |
| `issues` | `PayrollIssue[]` | Data-integrity issues; nine `type` values incl. `missing_payout_invoice`, `orphan_payout_invoice`, `unresolved_tutor_identity`, `missing_tier`, `duration_mismatch`, `expected_rate_mismatch`, `missing_expected_rate_rule`, `unmapped_rate_course`, `zero_credit_or_zero_amount` ([`types.ts:3-30`](../../../src/lib/payroll/types.ts)). |
| `adjustments` | `PayrollAdjustmentDto[]` | Manual adjustment rows for the month, newest first ([`types.ts:62-75`](../../../src/lib/payroll/types.ts), [`data.ts:113-128`](../../../src/lib/payroll/data.ts)). |

(The issue taxonomy and what each field means are documented in [docs/features/payroll.md](../../features/payroll.md); this page does not restate them.)

**Status codes:**

| Status | When |
|--------|------|
| 200 | Payload returned. |
| 401 | No session. |
| 400 | Error message starts with `Invalid month` ([`route.ts:20`](../../../src/app/api/payroll/route.ts)). |
| 500 | Any other thrown error ([`route.ts:16-21`](../../../src/app/api/payroll/route.ts)). |

---

## Review (approval workflow)

### `PATCH /api/payroll/review`

Sets a month's review `status` and/or `notes`, stamping the actor on approval. Handler: [`review/route.ts:6-57`](../../../src/app/api/payroll/review/route.ts).

**Auth:** session **with email** required (`if (!session?.user?.email)`, [`review/route.ts:7-10`](../../../src/app/api/payroll/review/route.ts)). The email/name become `actorEmail`/`actorName` on the review row.

**Request body** (JSON; no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `month` | string (`YYYY-MM`) | yes | Missing → 400 `{"error":"month is required"}` ([`review/route.ts:18-20`](../../../src/app/api/payroll/review/route.ts)). |
| `status` | `"draft"` \| `"approved"` | no | If present and not one of those two literals → 400 `{"error":"Invalid review status"}` ([`review/route.ts:21-23`](../../../src/app/api/payroll/review/route.ts)). When omitted, `updatePayrollReview` defaults the row to `"draft"` ([`data.ts:589-593`](../../../src/lib/payroll/data.ts)). |
| `notes` | string | no | Persisted only when a string; otherwise left unchanged ([`review/route.ts:45`](../../../src/app/api/payroll/review/route.ts), [`data.ts:615`](../../../src/lib/payroll/data.ts)). |

**Approval gate (fail-closed):** when `status === "approved"`, the handler first loads the payload and counts blocking expected-rate issues — `expected_rate_mismatch`, `missing_expected_rate_rule`, `unmapped_rate_course`. If any exist it returns **409** without writing ([`review/route.ts:27-40`](../../../src/app/api/payroll/review/route.ts)).

**Side effects:** `updatePayrollReview` upserts the month's `payroll_reviews` row ([`data.ts:577-619`](../../../src/lib/payroll/data.ts)). On `approved` it sets `approvedByEmail`/`approvedByName`/`approvedAt`; otherwise those columns are cleared.

**Response 200** — `{ ok: true, payload }`, where `payload` is the payload re-read after the update ([`review/route.ts:49`](../../../src/app/api/payroll/review/route.ts)). See [`GET /api/payroll`](#get-apipayroll).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Review updated. |
| 400 | Missing `month`; invalid `status`; or error message starts with `Invalid month` ([`review/route.ts:18-23,54`](../../../src/app/api/payroll/review/route.ts)). |
| 401 | No session, or session without email. |
| 409 | Approval attempted while unresolved expected-rate issues remain ([`review/route.ts:34-39`](../../../src/app/api/payroll/review/route.ts)). |
| 500 | Any other thrown error ([`review/route.ts:50-55`](../../../src/app/api/payroll/review/route.ts)). |

---

## Manual adjustments

### `POST /api/payroll/adjustments`

Adds one manual adjustment row (extra hours/amount) to a month. Handler: [`adjustments/route.ts:6-45`](../../../src/app/api/payroll/adjustments/route.ts).

**Auth:** session **with email** required (`if (!session?.user?.email)`, [`adjustments/route.ts:7-10`](../../../src/app/api/payroll/adjustments/route.ts)). The email/name become the row's `createdByEmail`/`createdByName`.

**Request body** (JSON; no schema):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `month` | string (`YYYY-MM`) | yes | Missing → 400 `{"error":"month is required"}` ([`adjustments/route.ts:22`](../../../src/app/api/payroll/adjustments/route.ts)). |
| `description` | string | yes | Empty/whitespace → 400 `{"error":"description is required"}` (checked via `.trim()`) ([`adjustments/route.ts:23`](../../../src/app/api/payroll/adjustments/route.ts)). Trimmed before insert. |
| `adjustmentType` | string | no | Defaults to `"manual"` at the route ([`adjustments/route.ts:29`](../../../src/app/api/payroll/adjustments/route.ts)); `addPayrollAdjustment` re-trims and re-defaults to `"manual"` if blank ([`data.ts:640`](../../../src/lib/payroll/data.ts)). |
| `tutorCanonicalKey` | string \| null | no | Trimmed; blank → null ([`data.ts:641`](../../../src/lib/payroll/data.ts)). |
| `tutorDisplayName` | string \| null | no | Trimmed; blank → null ([`data.ts:641`](../../../src/lib/payroll/data.ts)). |
| `hours` | number | no | Coerced with `Number(body.hours ?? 0)`; non-finite stored as `0` ([`adjustments/route.ts:31`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:643`](../../../src/lib/payroll/data.ts)). |
| `amount` | number | no | Coerced with `Number(body.amount ?? 0)`; non-finite stored as `0` ([`adjustments/route.ts:32`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:644`](../../../src/lib/payroll/data.ts)). |

**Side effects:** inserts one row into `payroll_adjustments` with `source: "manual"` and returns it ([`data.ts:621-652`](../../../src/lib/payroll/data.ts)). The month's `summary.manualAdjustmentHours` / `manualAdjustmentAmount` reflect the new row on the next payload build ([`data.ts:483-484`](../../../src/lib/payroll/data.ts)).

**Response 200** — `{ ok: true, adjustment, payload }`:

- `adjustment` is the inserted row as a `PayrollAdjustmentDto`: `{ id, payrollMonth, adjustmentType, tutorCanonicalKey, tutorDisplayName, hours, amount, description, source, createdByEmail, createdByName, createdAt }` ([`types.ts:62-75`](../../../src/lib/payroll/types.ts), [`data.ts:113-128`](../../../src/lib/payroll/data.ts)).
- `payload` is the payload re-read after the insert ([`adjustments/route.ts:37`](../../../src/app/api/payroll/adjustments/route.ts)). See [`GET /api/payroll`](#get-apipayroll).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Adjustment added. |
| 400 | Missing `month`; missing/blank `description`; or error message starts with `Invalid month` ([`adjustments/route.ts:22-23,42`](../../../src/app/api/payroll/adjustments/route.ts)). |
| 401 | No session, or session without email. |
| 500 | Any other thrown error ([`adjustments/route.ts:38-43`](../../../src/app/api/payroll/adjustments/route.ts)). |

---

### `DELETE /api/payroll/adjustments/[adjustmentId]`

Deletes a single manual adjustment by id. Handler: [`adjustments/[adjustmentId]/route.ts:6-21`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts).

**Auth:** session required (`if (!session)`, [`adjustments/[adjustmentId]/route.ts:11-13`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)).

**Path parameter:**

| Param | Type | Notes |
|-------|------|-------|
| `adjustmentId` | string | The `payroll_adjustments.id` (UUID). Awaited from `context.params` ([`adjustments/[adjustmentId]/route.ts:15`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)). |

No request body is read. There is no `month`-based validation, so this endpoint never returns the `Invalid month` 400.

**Side effects:** `deletePayrollAdjustment` issues a `DELETE ... RETURNING id` against `payroll_adjustments` and reports whether a row matched ([`data.ts:654-660`](../../../src/lib/payroll/data.ts)).

**Response:**

- **200** — `{ ok: true }` when a row was deleted ([`adjustments/[adjustmentId]/route.ts:20`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)). Unlike the other write endpoints, this one does **not** echo the payload.
- **404** — `{"error":"Adjustment not found"}` when no row matched the id ([`adjustments/[adjustmentId]/route.ts:17-19`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)).

**Status codes:**

| Status | When |
|--------|------|
| 200 | Row deleted. |
| 401 | No session. |
| 404 | No adjustment with that id. |

(No `try/catch` wraps the delete, so an unexpected DB error surfaces as a framework-level 500 rather than a handler-shaped `{ error }` body.)

---

_Verified against HEAD + uncommitted WIP on 2026-05-31._
