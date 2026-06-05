# Payroll API — `/api/payroll`

Monthly tutor-pay reconciliation endpoints. The payroll feature pulls a Bangkok calendar month of Wise past sessions + tutor-payout invoice events, normalizes them against a rate card, and serves a single read payload plus review/adjustment mutations. For purpose, business rules, tier/rate-card semantics, and the reconciliation flow, see [docs/features/payroll.md](../../features/payroll.md). This page owns only the mechanical endpoint inventory (method + path + auth + request/response shapes + side effects + status codes).

All five route handlers live under `src/app/api/payroll/**/route.ts`.

## Conventions for this group

- **Auth — all `admin`.** None of these paths are in the `src/middleware.ts` public allowlist, so the middleware redirects unauthenticated browser requests to `/login` and every handler additionally calls `auth()` (`src/lib/auth.ts`). A missing session returns `401 {"error":"Unauthorized"}`. Two handlers (`PATCH /api/payroll/review`, `POST /api/payroll/adjustments`) require not just a session but `session.user.email` (used as the audit actor), still returning the same `401` when it is absent (`review/route.ts:8`, `adjustments/route.ts:8`).
- **No Zod.** Unlike most mutating routes in the codebase, the payroll handlers do **not** use a Zod schema. Request bodies are read with `request.json().catch(() => ({}))` and treated as inline-cast TypeScript shapes with hand-rolled field checks. There is no `safeParse`; malformed JSON degrades to an empty object rather than `400`.
- **`month` parameter.** Format is `YYYY-MM` (Bangkok calendar month). It is validated lazily inside the data/sync layer by `assertPayrollMonth`, which throws `"Invalid month. Expected YYYY-MM."` for anything not matching `/^\d{4}-\d{2}$/` or that fails a Bangkok round-trip check (`src/lib/payroll/domain.ts:79-89`). Every handler maps a thrown message that `startsWith("Invalid month")` to HTTP `400`, and any other thrown error to `500`. On `POST /api/payroll/sync` and `GET /api/payroll`, `month` defaults to the current Bangkok month (`todayBangkok().slice(0, 7)`); on `review` and `adjustments` it is required (`400` if missing).
- **Payload echo.** Four of the five handlers return the full `PayrollPayload` (see [Shared response: `PayrollPayload`](#shared-response-payrollpayload)) so the client can refresh its view from a single round-trip. `DELETE` is the exception — it returns only `{ ok: true }`.

---

## Sync — `POST /api/payroll/sync`

File: `src/app/api/payroll/sync/route.ts`. Carries `export const maxDuration = 800` (`sync/route.ts:9`) for the long Wise pull.

Triggers a full payroll resync for a month: fetches Wise teachers, past sessions, and `TutorPayoutInvoiceCreatedEvent` activity events, normalizes them, and rewrites the month's snapshot tables transactionally.

- **Auth**: `admin` — `auth()`; `401` if no session (`sync/route.ts:19-22`).
- **Request body** (JSON, all optional; malformed JSON → `{}`):

  | Field | Type | Default | Notes |
  |---|---|---|---|
  | `month` | string `YYYY-MM` | current Bangkok month | `sync/route.ts:31` |
  | `maxEventPages` | integer | `1000` | Clamped to `[1, 2000]` via `numberOption`; non-integer/non-number falls back to `1000` (`sync/route.ts:13-16,39`). Caps how many 50-event activity pages are walked. |

- **Side effects** (in `runPayrollSync`, `src/lib/payroll/sync.ts:243-448`):
  1. Marks any `running` `payroll_sync_runs` row older than 20 minutes as `failed` (`sync.ts:125-137`).
  2. Inserts a new `payroll_sync_runs` row with `status: "running"`, `triggerType: "manual"`. **Single-flight guard**: a unique partial index `payroll_sync_runs_single_running_idx` makes a concurrent second `running` insert raise Postgres `23505`, which is caught and rethrown as `PayrollSyncAlreadyRunningError` (`sync.ts:54-59,259-273`).
  3. Fetches Wise teachers, active identity groups (from the active snapshot), past sessions (`status=PAST`, paginated by date over a ±1-day padded window), and payout events — concurrently.
  4. In a transaction, **deletes and replaces** `payroll_teacher_tiers`, `payroll_payout_invoices`, and `payroll_session_observations` for the month, then upserts `payroll_reviews` back to `status: "draft"` (clearing any prior approval) and marks the sync run `success` with counts (`sync.ts:385-425`). The transaction runs via `node-postgres` `Pool` when the Neon-HTTP driver rejects transactions (`sync.ts:100-123`).
  5. On any error after the run row exists, the run is set to `status: "failed"` with a truncated `errorSummary` and the error is rethrown (`sync.ts:437-447`).
- **Response** `200`:
  ```jsonc
  {
    "ok": true,
    "result": {            // PayrollSyncResult (sync.ts:29-38)
      "syncRunId": "…",
      "status": "success",
      "payrollMonth": "2026-05-01",   // first-of-month form
      "teacherCount": 0,
      "sessionCount": 0,
      "invoiceCount": 0,
      "eventPagesFetched": 0,
      "sessionPagesFetched": 0
    },
    "payload": { /* PayrollPayload, freshly re-read */ }
  }
  ```
  The payload is re-fetched after the sync via `getPayrollPayload` (`sync/route.ts:41`).
- **Status codes**:

  | Code | When |
  |---|---|
  | `200` | Sync completed; `result` + `payload` returned. |
  | `401` | No session. |
  | `409` | `PayrollSyncAlreadyRunningError` — another sync holds the single-flight slot (`sync/route.ts:44-46`). |
  | `400` | Thrown message starts with `"Invalid month"` (`sync/route.ts:50`). |
  | `500` | Any other failure; body `{"error": <message>}`. |

---

## Read payload — `GET /api/payroll`

File: `src/app/api/payroll/route.ts`. Read-only; computes the reconciliation payload from the month's persisted snapshot tables (no Wise call).

- **Auth**: `admin` — `auth()`; `401` if no session (`route.ts:9-11`).
- **Query parameters**:

  | Param | Type | Default | Notes |
  |---|---|---|---|
  | `month` | string `YYYY-MM` | current Bangkok month | `request.nextUrl.searchParams.get("month")` (`route.ts:13`) |

- **Side effects**: none (pure read; `getPayrollPayload` issues parallel `SELECT`s, `src/lib/payroll/data.ts:529-575`).
- **Response** `200`: the bare [`PayrollPayload`](#shared-response-payrollpayload) object (not wrapped in `{ ok, payload }`).
- **Status codes**: `200` success · `401` no session · `400` `"Invalid month…"` · `500` other (`route.ts:16-22`).

---

## Review status — `PATCH /api/payroll/review`

File: `src/app/api/payroll/review/route.ts`. Sets a month's review state to `draft` or `approved` and/or updates its notes.

- **Auth**: `admin` — requires `session.user.email`; `401` otherwise (`review/route.ts:8`). The signed-in email/name is recorded as the approver when approving.
- **Request body** (JSON):

  | Field | Type | Required | Notes |
  |---|---|---|---|
  | `month` | string `YYYY-MM` | yes | `400 {"error":"month is required"}` if missing (`review/route.ts:18`). |
  | `status` | `"draft"` \| `"approved"` | no | If present and not one of those two values → `400 {"error":"Invalid review status"}` (`review/route.ts:21-23`). If omitted, `updatePayrollReview` defaults the inserted row to `"draft"` but only changes status fields when `status` is provided (`data.ts:589,606-614`). |
  | `notes` | string | no | Persisted only when a string is supplied; non-strings are ignored (`review/route.ts:45`). |

- **Approval gate**: when `status === "approved"`, the handler first loads the payload and counts blocking expected-rate issues (types `expected_rate_mismatch`, `missing_expected_rate_rule`, `unmapped_rate_course`). If any exist, it refuses with `409` and does **not** write (`review/route.ts:27-39`).
- **Side effects**: upserts the `payroll_reviews` row for the month (`updatePayrollReview`, `data.ts:577-619`). On approval, sets `approvedByEmail`/`approvedByName` (name falls back to email) and `approvedAt = now`; reverting to `draft` clears those approval columns. `updatedAt` is always bumped.
- **Response** `200`: `{ "ok": true, "payload": { /* PayrollPayload, re-read */ } }` (`review/route.ts:49`).
- **Status codes**:

  | Code | When |
  |---|---|
  | `200` | Review updated. |
  | `400` | Missing `month`, invalid `status`, or thrown `"Invalid month…"`. |
  | `401` | No session / no `session.user.email`. |
  | `409` | Approval blocked by unresolved expected-rate issues (`review/route.ts:34-39`). |
  | `500` | Other failure. |

---

## Manual adjustments

Two routes manage manual line-item adjustments (e.g. one-off bonuses/deductions) stored in `payroll_adjustments`. Adjustment hours/amounts roll into `summary.manualAdjustmentHours` / `manualAdjustmentAmount` in the payload (`data.ts:483-484,513-514`).

### Create — `POST /api/payroll/adjustments`

File: `src/app/api/payroll/adjustments/route.ts`.

- **Auth**: `admin` — requires `session.user.email`; `401` otherwise (`adjustments/route.ts:8`). Email/name recorded as `createdByEmail`/`createdByName`.
- **Request body** (JSON):

  | Field | Type | Required | Notes |
  |---|---|---|---|
  | `month` | string `YYYY-MM` | yes | `400 {"error":"month is required"}` if missing (`adjustments/route.ts:22`). |
  | `description` | string | yes | Must be non-empty after `.trim()`; else `400 {"error":"description is required"}` (`adjustments/route.ts:23`). Stored trimmed. |
  | `adjustmentType` | string | no | Defaults to `"manual"` in the handler; `addPayrollAdjustment` also falls back to `"manual"` if the trimmed value is empty (`adjustments/route.ts:29`, `data.ts:640`). |
  | `tutorCanonicalKey` | string \| null | no | Trimmed; empty → `null` (`data.ts:641`). |
  | `tutorDisplayName` | string \| null | no | Trimmed; empty → `null` (`data.ts:642`). |
  | `hours` | number | no | Coerced via `Number(body.hours ?? 0)`; non-finite stored as `0` (`adjustments/route.ts:31`, `data.ts:643`). |
  | `amount` | number | no | Coerced via `Number(body.amount ?? 0)`; non-finite stored as `0` (`adjustments/route.ts:32`, `data.ts:644`). |

- **Side effects**: inserts one `payroll_adjustments` row with `source: "manual"` and returns it (`addPayrollAdjustment`, `data.ts:621-652`).
- **Response** `200`:
  ```jsonc
  {
    "ok": true,
    "adjustment": {        // PayrollAdjustmentDto (types.ts:62-75)
      "id": "…",
      "payrollMonth": "2026-05-01",
      "adjustmentType": "manual",
      "tutorCanonicalKey": null,
      "tutorDisplayName": null,
      "hours": 0,
      "amount": 0,
      "description": "…",
      "source": "manual",
      "createdByEmail": "…",
      "createdByName": "…",
      "createdAt": "2026-05-31T…Z"
    },
    "payload": { /* PayrollPayload, re-read */ }
  }
  ```
- **Status codes**: `200` created · `400` missing `month`/`description` or `"Invalid month…"` · `401` no session/email · `500` other (`adjustments/route.ts:38-43`).

### Delete — `DELETE /api/payroll/adjustments/[adjustmentId]`

File: `src/app/api/payroll/adjustments/[adjustmentId]/route.ts`.

- **Auth**: `admin` — `auth()`; `401` if no session (`[adjustmentId]/route.ts:11-13`). (Does **not** require `session.user.email`.)
- **Path parameter**: `adjustmentId` — the `payroll_adjustments.id` to delete (awaited from `context.params`, `[adjustmentId]/route.ts:15`).
- **Request body**: none.
- **Side effects**: deletes the matching `payroll_adjustments` row (`deletePayrollAdjustment`, `data.ts:654-660`). Returns whether a row was deleted.
- **Response** `200`: `{ "ok": true }`. Unlike the other mutations, this route does **not** echo a refreshed payload.
- **Status codes**:

  | Code | When |
  |---|---|
  | `200` | Row deleted. |
  | `401` | No session. |
  | `404` | No adjustment matched `adjustmentId` (`[adjustmentId]/route.ts:17-19`). |

  > This handler has no surrounding try/catch, so an unexpected DB error surfaces as Next's default `500` rather than the uniform `{"error": …}` envelope used by the other four routes.

---

## Shared response: `PayrollPayload`

Returned (bare, or under `payload`) by `GET /api/payroll`, `POST /api/payroll/sync`, `PATCH /api/payroll/review`, and `POST /api/payroll/adjustments`. Defined in `src/lib/payroll/types.ts:77-127`; assembled by `buildPayrollPayload` (`src/lib/payroll/data.ts:258-527`). Top-level shape:

| Key | Type | Meaning |
|---|---|---|
| `month` | string `YYYY-MM` | Requested month. |
| `payrollMonth` | string `YYYY-MM-01` | First-of-month key used in storage. |
| `rateCard` | object \| null | Active rate-card version (`id`, `versionName`, `effectiveMonth`, `sourceLabel`, `active`), or `null` if none active. |
| `review` | object | `{ status: "draft"\|"approved", notes, approvedByEmail, approvedByName, approvedAt, updatedAt }`; defaults to an empty draft when no row exists (`data.ts:65-86`). |
| `lastSync` | object \| null | Most recent `payroll_sync_runs` row: `{ id, status: "running"\|"success"\|"failed", startedAt, finishedAt, teacherCount, sessionCount, invoiceCount, errorSummary }`. |
| `summary` | object | Aggregates: `totalPayoutAmount`, `paidHours`, `utilizationHours`, `varianceHours`, `detectedFreePayHours`, `kevinHours`, `kevinPaidHours`, `kevinPayoutAmount`, `manualAdjustmentHours`, `manualAdjustmentAmount`, `unresolvedTutorCount`, `issueCount`, `expectedRateCheckedCount`, `expectedRateMismatchCount`, `missingRateRuleCount`, `unmappedRateCourseCount`, `tutorCount` (`types.ts:105-123`). |
| `tutors` | `PayrollTutorRow[]` | Per-tutor reconciliation rows (tier, paid vs utilization hours, payout, rate buckets, variance, per-row `flags`, expected-rate counters); sorted by tier then name (`types.ts:39-60`, `data.ts:475-481`). |
| `issues` | `PayrollIssue[]` | Flat list of detected problems; `type` is one of `missing_payout_invoice`, `orphan_payout_invoice`, `zero_credit_or_zero_amount`, `missing_tier`, `unresolved_tutor_identity`, `duration_mismatch`, `expected_rate_mismatch`, `missing_expected_rate_rule`, `unmapped_rate_course` (`types.ts:3-30`). The last three are the **blocking** set for approval. |
| `adjustments` | `PayrollAdjustmentDto[]` | Manual adjustments for the month, newest first (`data.ts:550-551`). |

> See [docs/reference/database/index.md](../database/index.md) for the underlying `payroll_*` table columns and [docs/features/payroll.md](../../features/payroll.md) for what each issue type / summary metric means.

---

_Verified against HEAD `d4fe6d3` on 2026-06-05._
