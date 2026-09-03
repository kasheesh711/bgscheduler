# Payroll API

**Status: stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Feature meaning — why payroll reconciles, the issue taxonomy, the review flow — lives in [docs/features/payroll.md](../../features/payroll.md). Column-level detail for the `payroll_*` tables lives in [docs/reference/database/erd-payroll.md](../database/erd-payroll.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

**Authoritative source:** the five handlers under [`src/app/api/payroll/`](../../../src/app/api/payroll/), plus the two libs they delegate to, [`src/lib/payroll/data.ts`](../../../src/lib/payroll/data.ts) and [`src/lib/payroll/sync.ts`](../../../src/lib/payroll/sync.ts).

## Endpoint index (5)

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/payroll` | session | none | [`route.ts:7-23`](../../../src/app/api/payroll/route.ts) |
| POST | `/api/payroll/sync` | session | rewrites 3 month-scoped tables + sync-run + review reset | [`sync/route.ts:18-52`](../../../src/app/api/payroll/sync/route.ts) |
| PATCH | `/api/payroll/review` | session **with `user.email`** | `payroll_reviews` upsert | [`review/route.ts:6-56`](../../../src/app/api/payroll/review/route.ts) |
| POST | `/api/payroll/adjustments` | session **with `user.email`** | `payroll_adjustments` insert | [`adjustments/route.ts:6-45`](../../../src/app/api/payroll/adjustments/route.ts) |
| DELETE | `/api/payroll/adjustments/[adjustmentId]` | session | `payroll_adjustments` delete | [`adjustments/[adjustmentId]/route.ts:6-21`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts) |

There is **no payroll cron**: `grep -n payroll vercel.json src/lib/data-health/cron-registry.ts` returns nothing, so `POST /api/payroll/sync` is the only way a payroll sync run starts. The only in-repo caller of any of these five is the dashboard client component, which calls all five ([`payroll-dashboard.tsx:143,172,192,212,240`](../../../src/components/payroll/payroll-dashboard.tsx)); the page itself renders no payload server-side ([`(app)/payroll/page.tsx:6-12`](../../../src/app/%28app%29/payroll/page.tsx)).

---

## Conventions shared by all five endpoints

**No Zod.** None of the payroll handlers use a schema — unusual for this codebase. Bodies are read with `request.json()` wrapped in a `.catch(() => ({}))` or `try/catch` that falls back to `{}` ([`adjustments/route.ts:12`](../../../src/app/api/payroll/adjustments/route.ts), [`review/route.ts:12`](../../../src/app/api/payroll/review/route.ts), [`sync/route.ts:24-30`](../../../src/app/api/payroll/sync/route.ts)), then narrowed by an inline TypeScript cast — a compile-time assertion only. Validation is hand-written `if` checks; unknown fields are ignored. A malformed JSON body therefore never returns 400 for parse reasons; it degrades to an empty object and fails (or not) on the field checks.

**Auth.** Every handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and returns `401 {"error":"Unauthorized"}` on failure. There is no role model and no payroll-specific capability check — any signed-in user who reaches these paths can sync, adjust, approve, or un-approve. Two handlers require more than a session: `PATCH /api/payroll/review` and `POST /api/payroll/adjustments` demand `session.user.email` because they stamp the actor onto the row ([`review/route.ts:8`](../../../src/app/api/payroll/review/route.ts), [`adjustments/route.ts:8`](../../../src/app/api/payroll/adjustments/route.ts)); a session without an email gets 401 from those two and passes the other three.

**Middleware.** `/api/payroll/**` is not in the public allowlist ([`middleware.ts:10-25`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:88-92`](../../../src/middleware.ts)). A restricted user (non-null `allowedPages` that does not prefix-match `/payroll`) gets a middleware-level `403 {"error":"Forbidden"}`, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-66`](../../../src/middleware.ts), [`:96-99`](../../../src/middleware.ts)).

**The month parameter.** Every endpoint is addressed by a **payroll month** written `YYYY-MM` in Asia/Bangkok. `assertPayrollMonth` validates the shape and round-trips it through a Bangkok-anchored `Date`, throwing the literal message `Invalid month. Expected YYYY-MM.` on failure ([`domain.ts:79-89`](../../../src/lib/payroll/domain.ts)); `payrollMonthRange` then derives the stored first-of-month `date` key (`${month}-01`) plus the padded query window used against Wise ([`domain.ts:91-107`](../../../src/lib/payroll/domain.ts)). Four of the five handlers share the same error mapping: a thrown message that **starts with** `Invalid month` becomes **400**, anything else **500**.

**Payload echo.** `GET /api/payroll`, `POST /api/payroll/sync`, `PATCH /api/payroll/review`, and `POST /api/payroll/adjustments` all return the full month payload, so a mutating client never needs a follow-up read. `DELETE /api/payroll/adjustments/[adjustmentId]` is the one write that does not echo it — the dashboard re-`GET`s after a delete ([`payroll-dashboard.tsx:240-243`](../../../src/components/payroll/payroll-dashboard.tsx)).

**No caching.** No handler declares `"use cache"`, `revalidate`, or `dynamic`; every request reads Postgres directly.

**Tests.** [`src/app/api/payroll/__tests__/route.test.ts`](../../../src/app/api/payroll/__tests__/route.test.ts) covers GET (auth, month passthrough, 400), sync (success, 409), review (update, approval block), and adjustment creation — 8 cases. The `DELETE` handler has no route test.

### The payroll payload

The shared response object is `PayrollPayload`, declared at [`types.ts:77-127`](../../../src/lib/payroll/types.ts) and assembled by `buildPayrollPayload` ([`data.ts:258-527`](../../../src/lib/payroll/data.ts)) from rows fetched by `getPayrollPayload` ([`data.ts:529-575`](../../../src/lib/payroll/data.ts)). Top-level keys:

| Key | Type | Notes |
|-----|------|-------|
| `month` | `string` | The validated `YYYY-MM`. |
| `payrollMonth` | `string` | Stored first-of-month key, `YYYY-MM-01`. |
| `rateCard` | object \| `null` | The single `active` rate-card version (`id`, `versionName`, `effectiveMonth`, `sourceLabel`, `active`); `null` when none is active. |
| `review` | object | `status` (`draft` \| `approved`), `notes`, `approvedByEmail`, `approvedByName`, `approvedAt`, `updatedAt`. |
| `lastSync` | object \| `null` | Most recent run for the month: `id`, `status` (`running` \| `success` \| `failed`), `startedAt`, `finishedAt`, `teacherCount`, `sessionCount`, `invoiceCount`, `errorSummary`. |
| `summary` | object | 17 numeric roll-ups (`totalPayoutAmount`, `paidHours`, `utilizationHours`, `varianceHours`, `detectedFreePayHours`, the three `kevin*` fields, `manualAdjustmentHours`/`Amount`, `unresolvedTutorCount`, `issueCount`, the four expected-rate counters, `tutorCount`). |
| `tutors` | `PayrollTutorRow[]` | Per-tutor aggregate — [`types.ts:39-60`](../../../src/lib/payroll/types.ts). |
| `issues` | `PayrollIssue[]` | Typed integrity findings — [`types.ts:14-30`](../../../src/lib/payroll/types.ts); the nine `PayrollIssueType` values are at [`types.ts:3-12`](../../../src/lib/payroll/types.ts). |
| `adjustments` | `PayrollAdjustmentDto[]` | Manual rows, newest first — [`types.ts:62-75`](../../../src/lib/payroll/types.ts). |

`getPayrollPayload` issues seven parallel reads (review, latest sync run, teacher tiers, payout invoices, session observations, adjustments, active rate-card version) and then one conditional read of that version's rate rules ([`data.ts:532-558`](../../../src/lib/payroll/data.ts), [`:559-562`](../../../src/lib/payroll/data.ts)). All month-scoped reads key on `payrollMonth`.

---

## Reading a month

### `GET /api/payroll`

Returns the reconciled payload for one month. Read-only: no writes, no Wise calls. Handler [`route.ts:7-23`](../../../src/app/api/payroll/route.ts).

**Auth:** session required — `if (!session)` → `401 {"error":"Unauthorized"}` ([`route.ts:8-11`](../../../src/app/api/payroll/route.ts)).

**Query:**

| Param | Type | Required | Default |
|-------|------|----------|---------|
| `month` | `YYYY-MM` | no | current Bangkok month — `todayBangkok().slice(0, 7)` ([`route.ts:13`](../../../src/app/api/payroll/route.ts), [`room-capacity/dates.ts:27-29`](../../../src/lib/room-capacity/dates.ts)) |

**Response `200`:** the payroll payload verbatim ([`route.ts:15`](../../../src/app/api/payroll/route.ts)) — no wrapper key.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Payload returned. A month with no synced rows is still 200, with empty `tutors`/`issues` and `lastSync: null`. |
| 400 | Thrown message starts with `Invalid month` — i.e. `month` is not a valid `YYYY-MM` ([`route.ts:20`](../../../src/app/api/payroll/route.ts)). |
| 401 | No session. |
| 500 | Any other thrown error; body is `{"error": <message>}` or `"Failed to load payroll"` for a non-`Error` throw ([`route.ts:17`](../../../src/app/api/payroll/route.ts)). |

---

## Syncing from Wise

### `POST /api/payroll/sync`

Runs the full month sync — the only trigger in the repo. Handler [`sync/route.ts:18-52`](../../../src/app/api/payroll/sync/route.ts); `export const maxDuration = 800` ([`sync/route.ts:9`](../../../src/app/api/payroll/sync/route.ts)).

**Auth:** session required ([`sync/route.ts:19-22`](../../../src/app/api/payroll/sync/route.ts)).

**Body** (JSON; a missing or unparseable body degrades to `{}`):

| Field | Type | Required | Default / clamp |
|-------|------|----------|-----------------|
| `month` | `string` (`YYYY-MM`) | no | current Bangkok month when the value is not a string ([`sync/route.ts:31`](../../../src/app/api/payroll/sync/route.ts)) |
| `maxEventPages` | integer | no | `1000`, clamped to `[1, 2000]`; a non-integer or non-number falls back to `1000` ([`sync/route.ts:13-16,39`](../../../src/app/api/payroll/sync/route.ts)) |

The Wise institute id comes from `process.env.WISE_INSTITUTE_ID`, falling back to the hard-coded `696e1f4d90102225641cc413` ([`sync/route.ts:11,37`](../../../src/app/api/payroll/sync/route.ts)) — it is not client-settable.

**Response `200`:** `{ ok: true, result, payload }`, where `payload` is the payroll payload re-read after the write ([`sync/route.ts:41-42`](../../../src/app/api/payroll/sync/route.ts)) and `result` is `PayrollSyncResult` ([`sync.ts:29-38`](../../../src/lib/payroll/sync.ts)):

```
{ syncRunId, status: "success", payrollMonth,
  teacherCount, sessionCount, invoiceCount,
  eventPagesFetched, sessionPagesFetched }
```

**Side effects,** in the order `runPayrollSync` performs them ([`sync.ts:243-448`](../../../src/lib/payroll/sync.ts)):

1. **Validate first.** `assertPayrollMonth` runs before any write ([`sync.ts:250`](../../../src/lib/payroll/sync.ts)), so an invalid month produces no run row at all.
2. **Reap abandoned runs.** Any `payroll_sync_runs` row still `running` after 20 minutes is flipped to `failed` with a fixed `errorSummary` ([`sync.ts:125-137`](../../../src/lib/payroll/sync.ts), `STALE_RUNNING_MS` at [`:24`](../../../src/lib/payroll/sync.ts)).
3. **Claim single-flight.** Inserts a `running` row with `triggerType: "manual"` ([`sync.ts:258-269`](../../../src/lib/payroll/sync.ts)). The guard lives in Postgres — a partial unique index on `status` where `status = 'running'` ([`schema.ts:1776-1778`](../../../src/lib/db/schema.ts)) — and it is **global, not per-month**: a run in flight for any month blocks a run for every other month. A `23505` violation (or a message naming `payroll_sync_runs_single_running_idx`) is converted to `PayrollSyncAlreadyRunningError` ([`sync.ts:40-45,53-58,271`](../../../src/lib/payroll/sync.ts)).
4. **Fetch from Wise, read-only.** In parallel: all teachers, the active-snapshot identity entries from Postgres, past sessions over the padded date window, and `TutorPayoutInvoiceCreatedEvent` activity events ([`sync.ts:275-280`](../../../src/lib/payroll/sync.ts); helpers at [`:139`](../../../src/lib/payroll/sync.ts), [`:161`](../../../src/lib/payroll/sync.ts), [`:193`](../../../src/lib/payroll/sync.ts); page sizes `SESSION_PAGE_SIZE = 1000`, `EVENT_PAGE_SIZE = 50` at [`:21-22`](../../../src/lib/payroll/sync.ts)). Nothing is written to Wise.
5. **Persist run metadata**, then run one write transaction that deletes and re-inserts the month's rows in `payroll_teacher_tiers`, `payroll_payout_invoices`, and `payroll_session_observations` in 500-row chunks ([`sync.ts:380-393`](../../../src/lib/payroll/sync.ts)).
6. **Reset the review.** The same transaction upserts `payroll_reviews` back to `status: "draft"` and **nulls `approvedByEmail` / `approvedByName` / `approvedAt`** ([`sync.ts:394-412`](../../../src/lib/payroll/sync.ts)). A sync therefore un-approves an approved month. Manual adjustments are untouched.
7. **Finalize** the run row to `success` with the three counts, inside the same transaction ([`sync.ts:414-424`](../../../src/lib/payroll/sync.ts)).

Because the Neon HTTP driver has no transaction support, `runPayrollWriteTransaction` first attempts `db.transaction(...)` and, on the specific "No transactions support in neon-http driver" error, falls back to a dedicated `pg` `Pool` (`max: 1`) doing an explicit `BEGIN`/`COMMIT`/`ROLLBACK` ([`sync.ts:89-123`](../../../src/lib/payroll/sync.ts)). Any other error is rethrown, not silently retried.

On failure the run row is set to `failed` with `errorSummary` truncated at 2 000 characters, and the error is rethrown to the handler ([`sync.ts:437-447`](../../../src/lib/payroll/sync.ts), [`:83-87`](../../../src/lib/payroll/sync.ts)) — so a partial Wise fetch leaves the previous month rows in place (deletes and inserts share one transaction).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Sync completed; `{ ok, result, payload }`. |
| 400 | Message starts with `Invalid month` ([`sync/route.ts:50`](../../../src/app/api/payroll/sync/route.ts)). |
| 401 | No session. |
| 409 | `PayrollSyncAlreadyRunningError` — body `{"error":"Payroll sync is already running"}` ([`sync/route.ts:44-46`](../../../src/app/api/payroll/sync/route.ts), message at [`sync.ts:42`](../../../src/lib/payroll/sync.ts)). |
| 500 | Any other error — Wise failure, DB failure, missing `DATABASE_URL` for the fallback pool ([`sync.ts:93-95`](../../../src/lib/payroll/sync.ts)). Body `{"error": <message>}`, defaulting to `"Payroll sync failed"`. |

---

## Review (approval workflow)

### `PATCH /api/payroll/review`

Sets the month's review status and/or notes. Handler [`review/route.ts:6-56`](../../../src/app/api/payroll/review/route.ts).

**Auth:** session **with `session.user.email`** — the email is written as the approver ([`review/route.ts:7-10`](../../../src/app/api/payroll/review/route.ts)).

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `month` | `string` (`YYYY-MM`) | **yes** | Falsy (missing or empty) → `400 {"error":"month is required"}` ([`review/route.ts:18-20`](../../../src/app/api/payroll/review/route.ts)). |
| `status` | `"draft"` \| `"approved"` | no | Any other defined value → `400 {"error":"Invalid review status"}` ([`review/route.ts:21-23`](../../../src/app/api/payroll/review/route.ts)). Omitted means "notes-only update" — the stored status is left alone by the upsert, whose `status` branch is spread in only when `input.status` is truthy ([`data.ts:607-614`](../../../src/lib/payroll/data.ts)). |
| `notes` | `string` | no | Written only when it is a string; any other type is dropped ([`review/route.ts:45`](../../../src/app/api/payroll/review/route.ts)). |

**Approval gate.** When `status === "approved"`, the handler first loads the payload and counts issues of type `expected_rate_mismatch`, `missing_expected_rate_rule`, or `unmapped_rate_course`. If any exist it refuses with **409** and the message `Cannot approve payroll with N unresolved expected-rate issue(s).` ([`review/route.ts:27-39`](../../../src/app/api/payroll/review/route.ts)). The other six issue types do not block approval. Setting `status: "draft"` bypasses the gate entirely.

**Side effects.** `updatePayrollReview` upserts one `payroll_reviews` row keyed by `payrollMonth` ([`data.ts:577-619`](../../../src/lib/payroll/data.ts), unique index at [`schema.ts:1796`](../../../src/lib/db/schema.ts)). On `approved` it stamps `approvedByEmail` / `approvedByName` (falling back to the email when the session has no name) and `approvedAt: now`; on `draft` it **clears all three** ([`data.ts:595-599,609-612`](../../../src/lib/payroll/data.ts)) — so this endpoint is also the un-approve path. `updatedAt` is always bumped.

**Response `200`:** `{ ok: true, payload }` — the payload re-read after the write ([`review/route.ts:49`](../../../src/app/api/payroll/review/route.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Review updated. |
| 400 | Missing `month`; invalid `status`; or a thrown `Invalid month …` from `payrollMonthRange` ([`review/route.ts:54`](../../../src/app/api/payroll/review/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 409 | Approval blocked by unresolved expected-rate issues. |
| 500 | Any other error; default message `"Payroll review update failed"`. |

---

## Manual adjustments

### `POST /api/payroll/adjustments`

Appends one manual adjustment row to a month. Handler [`adjustments/route.ts:6-45`](../../../src/app/api/payroll/adjustments/route.ts).

**Auth:** session **with `session.user.email`** ([`adjustments/route.ts:7-10`](../../../src/app/api/payroll/adjustments/route.ts)).

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `month` | `string` (`YYYY-MM`) | **yes** | Falsy → `400 {"error":"month is required"}` ([`adjustments/route.ts:22`](../../../src/app/api/payroll/adjustments/route.ts)). |
| `description` | `string` | **yes** | Empty after `.trim()` → `400 {"error":"description is required"}` ([`adjustments/route.ts:23`](../../../src/app/api/payroll/adjustments/route.ts)); stored trimmed ([`data.ts:645`](../../../src/lib/payroll/data.ts)). |
| `adjustmentType` | `string` | no | Defaults to `"manual"` at the handler ([`:28`](../../../src/app/api/payroll/adjustments/route.ts)) and again after trimming in the lib ([`data.ts:640`](../../../src/lib/payroll/data.ts)). Free text — not an enum. |
| `tutorCanonicalKey` | `string` \| `null` | no | Trimmed; empty → `null` ([`data.ts:641`](../../../src/lib/payroll/data.ts)). Not validated against the identity tables, so an adjustment can name a tutor that does not exist. |
| `tutorDisplayName` | `string` \| `null` | no | Same trim-or-null treatment ([`data.ts:642`](../../../src/lib/payroll/data.ts)). |
| `hours` | number | no | `Number(body.hours ?? 0)`, then coerced to `0` unless `Number.isFinite` ([`adjustments/route.ts:31`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:643`](../../../src/lib/payroll/data.ts)) — a non-numeric value silently becomes `0` rather than 400. |
| `amount` | number | no | Same treatment ([`adjustments/route.ts:32`](../../../src/app/api/payroll/adjustments/route.ts), [`data.ts:644`](../../../src/lib/payroll/data.ts)). |

`source` is always written as `"manual"` and `createdByEmail` / `createdByName` come from the session — none of the three is client-settable ([`data.ts:646-648`](../../../src/lib/payroll/data.ts)).

**Side effects.** One insert into `payroll_adjustments` ([`data.ts:621-652`](../../../src/lib/payroll/data.ts), table at [`schema.ts:1870-1887`](../../../src/lib/db/schema.ts)). Rows are append-only and additive: nothing dedupes or replaces, so posting twice creates two rows. Adjustments feed the payload's `manualAdjustmentHours` / `manualAdjustmentAmount` roll-ups and survive a re-sync.

**Response `200`:** `{ ok: true, adjustment, payload }`, where `adjustment` is the inserted `PayrollAdjustmentDto` ([`types.ts:62-75`](../../../src/lib/payroll/types.ts)) and `payload` is the re-read month ([`adjustments/route.ts:37`](../../../src/app/api/payroll/adjustments/route.ts)).

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Adjustment created. |
| 400 | Missing `month`; blank `description`; or a thrown `Invalid month …` ([`adjustments/route.ts:42`](../../../src/app/api/payroll/adjustments/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 500 | Any other error; default message `"Payroll adjustment failed"`. |

### `DELETE /api/payroll/adjustments/[adjustmentId]`

Hard-deletes one adjustment row. Handler [`adjustments/[adjustmentId]/route.ts:6-21`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts).

**Auth:** session required — note this one does **not** require `user.email`, and no actor is recorded for the deletion ([`route.ts:10-13`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)).

**Path parameter:** `adjustmentId`, awaited from the Next 16 async `params` promise ([`route.ts:8,15`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)). There is no request body and no query parameter; the month is not supplied and not needed.

**Side effects.** `deletePayrollAdjustment` issues a `DELETE … RETURNING id` on `payroll_adjustments.id` and reports whether a row was removed ([`data.ts:654-660`](../../../src/lib/payroll/data.ts)). The delete is permanent — there is no soft-delete column and no audit row.

**Response `200`:** `{ ok: true }` only — this is the one write that does **not** echo the payload, so a client holding month state must re-`GET`.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Row deleted. |
| 401 | No session. |
| 404 | No row matched the id — `{"error":"Adjustment not found"}` ([`route.ts:17-19`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)). |
| 500 | Not produced by the handler: it has **no `try/catch`** ([`route.ts:6-21`](../../../src/app/api/payroll/adjustments/[adjustmentId]/route.ts)), so any driver error escapes to the framework and the response body is not the usual `{"error": …}` JSON. The likely trigger is a non-UUID `adjustmentId` reaching the `uuid` primary key ([`schema.ts:1871`](../../../src/lib/db/schema.ts)); the exact runtime response is untested — this handler has no route test. |

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
