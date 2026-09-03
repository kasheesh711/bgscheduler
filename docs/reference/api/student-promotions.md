# Student Promotions API

**Status: stable** (handbook maturity map; no `@deprecated` or status marker exists in code). Feature meaning — why the July 1 rollover exists, how grades and course bands are derived, why Year 13 is a human decision — lives in [docs/features/student-promotions.md](../../features/student-promotions.md). Column-level detail for the six `student_promotion_*` tables lives in [docs/reference/database/erd-student-promotions.md](../database/erd-student-promotions.md). Cron scheduling, health derivation, and manual invocation live in [docs/reference/crons.md](../crons.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

**Authoritative source:** the eight route files under [`src/app/api/student-promotions/`](../../../src/app/api/student-promotions/) and [`src/app/api/internal/student-promotions/july-1/route.ts`](../../../src/app/api/internal/student-promotions/july-1/route.ts), plus the two libs every one of them delegates to — [`src/lib/student-promotions/api.ts`](../../../src/lib/student-promotions/api.ts) (56 lines: auth guard, path-param guard, error mapper) and [`src/lib/student-promotions/data.ts`](../../../src/lib/student-promotions/data.ts) (2 508 lines: the entire audit/verify/apply/readback engine).

## Endpoint index (11)

Nine admin endpoints across eight route files, plus the two-method internal cron. `maxDuration = 800` reaches six of the nine admin endpoints. Three route files omit it — `runs/[runId]`, `verify`, and `pay-rate-impacts/[impactId]/review` — and those are exactly the handlers that make no Wise call. The correspondence is not perfect in the other direction: `GET /api/student-promotions/runs` makes no Wise call either, but inherits the file-level `export const maxDuration` it shares with the `POST` in the same file ([`runs/route.ts:5`](../../../src/app/api/student-promotions/runs/route.ts)).

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/student-promotions/runs` | session **with email** | none | [`runs/route.ts:7-14`](../../../src/app/api/student-promotions/runs/route.ts) |
| POST | `/api/student-promotions/runs` | session **with email** | inserts 1 run + 5 action collections | [`runs/route.ts:16-23`](../../../src/app/api/student-promotions/runs/route.ts) |
| GET | `/api/student-promotions/runs/[runId]` | session **with email** | none | [`runs/[runId]/route.ts:10-21`](../../../src/app/api/student-promotions/runs/[runId]/route.ts) |
| PATCH | `/api/student-promotions/runs/[runId]/graduation-actions/[actionId]` | session **with email** | 1 graduation row + full re-derivation of course/future-session/pay-rate rows | [`graduation-actions/[actionId]/route.ts:36-62`](../../../src/app/api/student-promotions/runs/[runId]/graduation-actions/[actionId]/route.ts) |
| PATCH | `/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review` | session **with email** | 1 pay-rate impact row | [`pay-rate-impacts/[impactId]/review/route.ts:34-62`](../../../src/app/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review/route.ts) |
| POST | `/api/student-promotions/runs/[runId]/verify` | session **with email** | run row → `verified` | [`verify/route.ts:10-37`](../../../src/app/api/student-promotions/runs/[runId]/verify/route.ts) |
| POST | `/api/student-promotions/runs/[runId]/apply` | session **with email** | **Wise writes** + run/action rows | [`apply/route.ts:12-33`](../../../src/app/api/student-promotions/runs/[runId]/apply/route.ts) |
| POST | `/api/student-promotions/runs/[runId]/future-sessions/apply` | session **with email** | **Wise writes** (env-gated) + future-session rows | [`future-sessions/apply/route.ts:15-36`](../../../src/app/api/student-promotions/runs/[runId]/future-sessions/apply/route.ts) |
| POST | `/api/student-promotions/runs/[runId]/readback` | session **with email** | re-derives future-session rows only | [`readback/route.ts:12-29`](../../../src/app/api/student-promotions/runs/[runId]/readback/route.ts) |
| GET | `/api/internal/student-promotions/july-1` | cron secret | **Wise writes** + run/action rows | [`july-1/route.ts:19-44`](../../../src/app/api/internal/student-promotions/july-1/route.ts) |
| POST | `/api/internal/student-promotions/july-1` | cron secret | identical — delegates to `GET` | [`july-1/route.ts:46-48`](../../../src/app/api/internal/student-promotions/july-1/route.ts) |

The only in-repo caller of the admin nine is the workspace client component, which calls seven of them ([`student-promotions-workspace.tsx:606,621,634,703,886,916,929`](../../../src/components/student-promotions/student-promotions-workspace.tsx)). `GET /api/student-promotions/runs` and `GET /api/student-promotions/runs/[runId]` have **no in-repo fetch caller**: the page server-renders the latest detail through `getLatestStudentPromotionRunDetail()` directly ([`(app)/student-promotions/page.tsx:11`](../../../src/app/%28app%29/student-promotions/page.tsx)) and hands it to the client as `initialDetail`.

---

## Conventions shared by all eleven endpoints

**No Zod, anywhere.** `grep -rn zod src/app/api/student-promotions src/app/api/internal/student-promotions src/lib/student-promotions` returns **zero** hits — there is no schema to cite for any request on this page. Bodies are read with `await request.json().catch(() => ({}))` and then narrowed by hand-written literal comparisons ([`verify/route.ts:17-21`](../../../src/app/api/student-promotions/runs/[runId]/verify/route.ts), [`apply/route.ts:19-22`](../../../src/app/api/student-promotions/runs/[runId]/apply/route.ts), [`graduation-actions/[actionId]/route.ts:44-45`](../../../src/app/api/student-promotions/runs/[runId]/graduation-actions/[actionId]/route.ts)). A malformed or absent body therefore never fails on parsing — it degrades to `{}` and then fails the field check. Unknown fields are ignored.

**Auth.** Every admin handler calls `requireStudentPromotionSession()`, which requires **both** `session.user.email` and a name, lowercases and trims the email, and falls the name back to the email; a session missing either throws the literal `"Unauthorized"` ([`api.ts:9-15`](../../../src/lib/student-promotions/api.ts)). That string is caught by the shared mapper and returned as `401 {"error":"Unauthorized"}` ([`api.ts:39-41`](../../../src/lib/student-promotions/api.ts)). There is no role model and no promotions-specific capability grant — any signed-in admin who reaches these paths can audit, review, verify, and apply. The resulting `{ email, name }` is the actor stamped onto every row the request writes.

**Middleware.** `/api/student-promotions/**` is not in the public allowlist ([`middleware.ts:10-25`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs. A restricted user whose `allowedPages` does not prefix-match `/student-promotions` gets a middleware-level `403`, because `isPathAllowed` matches each allowed page both as `/x` and as `/api/x` ([`middleware.ts:36-66`](../../../src/middleware.ts)). The cron route is the inverse: `pathname.startsWith("/api/internal/")` exempts it from the session gate entirely ([`middleware.ts:24`](../../../src/middleware.ts)), and it authenticates on the bearer secret alone.

**Path parameters.** `runId` is pulled from the Next 16 async `params` promise by `requireStudentPromotionRunId`, which throws `"Student promotion run id is required"` for a missing, non-string, or whitespace-only value ([`api.ts:17-27`](../../../src/lib/student-promotions/api.ts)). The two doubly-parameterised routes carry their own near-identical local copies for the second segment — `requireGraduationActionId` ([`graduation-actions/[actionId]/route.ts:17-27`](../../../src/app/api/student-promotions/runs/[runId]/graduation-actions/[actionId]/route.ts)) and `requirePayRateImpactId` ([`pay-rate-impacts/[impactId]/review/route.ts:17-27`](../../../src/app/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review/route.ts)). Neither id is checked for UUID shape at the boundary; a non-existent id becomes a 404 from the lib, and a syntactically invalid one reaches the `uuid` primary key.

### The error mapper is a message-regex, not a typed error set

Every admin handler's `catch` funnels into `studentPromotionErrorResponse(route, error, fallback)` ([`api.ts:29-56`](../../../src/lib/student-promotions/api.ts)), which classifies by **matching the thrown message text**, in this order:

| Order | Test | Result |
|------:|------|--------|
| 1 | `error.digest === "HANGING_PROMISE_REJECTION"` | **rethrown** to the framework, not converted ([`api.ts:30-37`](../../../src/lib/student-promotions/api.ts)) |
| 2 | message is exactly `Unauthorized` | `401 {"error":"Unauthorized"}` ([`:39-41`](../../../src/lib/student-promotions/api.ts)) |
| 3 | message matches `/not found/i` | `404 {"error": <message>}` ([`:43-45`](../../../src/lib/student-promotions/api.ts)) |
| 4 | message matches `/(required\|cannot\|only\|must be\|blocked\|no verified\|no pending\|before July 1)/i` | `400 {"error": <message>}` ([`:47-49`](../../../src/lib/student-promotions/api.ts)) |
| 5 | anything else | `console.error(route, error)` then `500 {"error": <message or fallback>}` ([`:51-55`](../../../src/lib/student-promotions/api.ts)) |

Because rule 5 still echoes `error.message` when the throw is an `Error`, the per-endpoint `fallbackMessage` argument only ever surfaces for a non-`Error` throw.

Two consequences of classifying on prose are worth knowing before you trust a status code here:

- **A config failure returns 400.** `createPromotionWiseClient` throws `"WISE_USER_ID and WISE_API_KEY are required for student promotions"` when the Wise credentials are absent ([`data.ts:298-306`](../../../src/lib/student-promotions/data.ts)). The word `required` matches rule 4, so a missing server credential is reported to the client as a **400 bad request**, not a 500.
- **A business-rule failure returns 500.** `applyStudentPromotionFutureSessionActions` refuses a run that has not been applied with `"Future session subject updates require the verified student promotion run to be applied first"` ([`data.ts:2418`](../../../src/lib/student-promotions/data.ts)). The message says `require`, not `required`, and matches no other alternative — so it falls through to rule 5 and is returned as **500**, unlike every sibling guard in the same feature. The 400-shaped guard immediately above it in the same function *does* match, because it contains `required` ([`data.ts:2412`](../../../src/lib/student-promotions/data.ts)).

The reverse case is handled deliberately: `latestVerifiedRunId` throws `"No verified student promotion run found"` ([`data.ts:2506`](../../../src/lib/student-promotions/data.ts)), which contains `found` but not `not found`, so rule 3 misses it — the literal `no verified` alternative in rule 4 exists to catch it as a 400.

### No caching, no cron audit

No handler on this page declares `"use cache"`, `revalidate`, or `dynamic`; every request reads Postgres live. The cron route is additionally **not** wrapped in `withCronInvocationAudit` — `grep -rn recordCronInvocation src/app/api/internal` matches nothing, and this route is one of six internal handlers that does not import the shared [`src/lib/internal/cron-auth.ts`](../../../src/lib/internal/cron-auth.ts) helper either, carrying an inline copy of the same constant-time comparison instead ([`july-1/route.ts:10-17`](../../../src/app/api/internal/student-promotions/july-1/route.ts)).

### Tests

[`src/app/api/student-promotions/__tests__/route.test.ts`](../../../src/app/api/student-promotions/__tests__/route.test.ts) is a single 272-line file with **15 cases** covering all eleven endpoints: auth rejection, dry-run creation, single-run load, the verify confirmation gate and its success path, the apply confirmation gate and its success path, readback, the future-session confirmation gate and its success path, graduation disposition, pay-rate review, cron secret rejection, cron success, and the cron date guard. Library behaviour is covered separately by [`src/lib/student-promotions/__tests__/data.test.ts`](../../../src/lib/student-promotions/__tests__/data.test.ts) and [`rules.test.ts`](../../../src/lib/student-promotions/__tests__/rules.test.ts).

### The run-detail payload

Eight of the nine admin endpoints return the same object under a `detail` key: `StudentPromotionRunDetail`, declared at [`data.ts:66-97`](../../../src/lib/student-promotions/data.ts) and assembled by `getStudentPromotionRunDetail` ([`data.ts:1844-1926`](../../../src/lib/student-promotions/data.ts)) from seven parallel reads — five action collections plus the run's source Credit Control snapshot and the currently active one.

| Key | Type | Notes |
|-----|------|-------|
| `run` | `student_promotion_runs` row | Status is the `student_promotion_run_status` enum: `draft` \| `verified` \| `applying` \| `applied` \| `applied_with_errors` \| `failed` ([`schema.ts:136-143`](../../../src/lib/db/schema.ts)). Table at [`schema.ts:1346-1377`](../../../src/lib/db/schema.ts). |
| `gradeActions` | row[] | One per accepted Wise student ([`schema.ts:1379`](../../../src/lib/db/schema.ts)). |
| `courseActions` | row[] | Class-level subject moves ([`schema.ts:1403`](../../../src/lib/db/schema.ts)). |
| `futureSessionActions` | row[] | Per-session subject rewrites ([`schema.ts:1426`](../../../src/lib/db/schema.ts)). |
| `graduationActions` | row[] | Year 13 students awaiting a human disposition ([`schema.ts:1453`](../../../src/lib/db/schema.ts)). |
| `payRateImpacts` | row[] | Pay-band consequences of the course moves ([`schema.ts:1476`](../../../src/lib/db/schema.ts)). |
| `freshness` | object | Eight fields — the run's source snapshot id/timestamp/count, the active snapshot's id/timestamp/count, plus the two derived booleans `activeSnapshotIsNewer` and `runIsOlderThan24Hours` ([`data.ts:99-108`](../../../src/lib/student-promotions/data.ts), computed at [`:774-802`](../../../src/lib/student-promotions/data.ts)). |
| `summary` | object | 22 counters derived in-process by filtering the five collections — four each for grade, course, and future-session actions (`pending`/`skipped`/`applied`/`failed`), five for graduation, four for pay-rate impacts ([`data.ts:75-95`](../../../src/lib/student-promotions/data.ts), computed at [`:1903-1923`](../../../src/lib/student-promotions/data.ts)). |

The four action-status counters read the `student_promotion_action_status` enum — `pending` \| `skipped` \| `applied` \| `failed` ([`schema.ts:145-150`](../../../src/lib/db/schema.ts)).

### Two guards every state transition shares

Both live in `data.ts` and both throw messages that map to **400**:

- **Freshness** — `assertStudentPromotionRunFresh(detail, "verify" | "apply")` refuses when either the active Credit Control snapshot is newer than the run's source snapshot, or the run is more than 24 hours old ([`data.ts:808-816`](../../../src/lib/student-promotions/data.ts), predicate at [`:804-806`](../../../src/lib/student-promotions/data.ts)). Message: `Cannot {verify|apply} this promotion run because …; run a fresh audit first`.
- **Coverage** — `assertRunCoversLiveAcceptedStudents` (apply only) refuses when any live accepted Wise student has no grade-action row in the run ([`data.ts:826-835`](../../../src/lib/student-promotions/data.ts)).

---

## Reading runs

### `GET /api/student-promotions/runs`

Returns the most recent run for the hard-coded target date `2026-07-01`, or `null` when none exists. Read-only: no writes, no Wise calls. Handler [`runs/route.ts:7-14`](../../../src/app/api/student-promotions/runs/route.ts).

Despite the plural path this is **not** a list endpoint. `getLatestStudentPromotionRunDetail` selects a single id, filtered on `targetDate = STUDENT_PROMOTION_TARGET_DATE` and ordered by `createdAt DESC LIMIT 1`, then expands it ([`data.ts:1928-1936`](../../../src/lib/student-promotions/data.ts)). The target date is the literal `"2026-07-01"` ([`rules.ts:1`](../../../src/lib/student-promotions/rules.ts)), so runs created for any other target date are unreachable through this endpoint.

**Auth:** session with email ([`runs/route.ts:9`](../../../src/app/api/student-promotions/runs/route.ts)).

**Request:** no body, no query parameters, no path parameters.

**Response `200`:** `{ "detail": StudentPromotionRunDetail | null }`.

| Code | Condition |
|------|-----------|
| 200 | Latest run returned, or `{"detail": null}` when no `2026-07-01` run exists. |
| 401 | No session, or a session without email/name. |
| 500 | Any DB failure; fallback message `"Failed to load student promotion run"` ([`runs/route.ts:12`](../../../src/app/api/student-promotions/runs/route.ts)). |

### `GET /api/student-promotions/runs/[runId]`

Returns one run by id, regardless of target date. Handler [`runs/[runId]/route.ts:10-21`](../../../src/app/api/student-promotions/runs/[runId]/route.ts). This is the only handler in the group with **no** `maxDuration` override and no Wise dependency.

**Auth:** session with email ([`runs/[runId]/route.ts:15`](../../../src/app/api/student-promotions/runs/[runId]/route.ts)).

**Path parameter:** `runId` — awaited and validated by `requireStudentPromotionRunId` ([`runs/[runId]/route.ts:16`](../../../src/app/api/student-promotions/runs/[runId]/route.ts)).

**Response `200`:** `{ "detail": StudentPromotionRunDetail }`.

| Code | Condition |
|------|-----------|
| 200 | Run found. |
| 400 | Blank or non-string `runId` — `{"error":"Student promotion run id is required"}`. |
| 401 | No session. |
| 404 | `{"error":"Student promotion run not found"}` ([`data.ts:1850`](../../../src/lib/student-promotions/data.ts)). |
| 500 | Any other failure. |

---

## Creating a dry run

### `POST /api/student-promotions/runs`

Builds a complete audit against live Wise plus the active Credit Control snapshot, persists it as a `draft` run, and returns it. This is the only endpoint that creates a run. Handler [`runs/route.ts:16-23`](../../../src/app/api/student-promotions/runs/route.ts); `export const maxDuration = 800` ([`runs/route.ts:5`](../../../src/app/api/student-promotions/runs/route.ts)).

**Auth:** session with email; the actor is stamped as `createdByEmail` / `createdByName` ([`runs/route.ts:18`](../../../src/app/api/student-promotions/runs/route.ts), [`data.ts:1739-1740`](../../../src/lib/student-promotions/data.ts)).

**Request:** **no body is read at all** — the handler takes no `request` argument. Target date, Wise client, and DB handle are all defaulted inside `createStudentPromotionDryRun` ([`data.ts:1714-1718`](../../../src/lib/student-promotions/data.ts)); the `targetDate` override in `DryRunInput` exists for tests only and is unreachable over HTTP.

**Response `201`:** `{ "detail": StudentPromotionRunDetail }` — note the non-default status, the only `201` in the group ([`runs/route.ts:19`](../../../src/app/api/student-promotions/runs/route.ts)).

**Side effects,** in the order `createStudentPromotionDryRun` performs them ([`data.ts:1714-1841`](../../../src/lib/student-promotions/data.ts)):

1. **Read in parallel** — the active Credit Control snapshot (students + packages) from Postgres, and all accepted students from Wise ([`:1720-1723`](../../../src/lib/student-promotions/data.ts)). Then fetch each student's Wise registration state at concurrency 4 (`REGISTRATION_FETCH_CONCURRENCY` at [`:195`](../../../src/lib/student-promotions/data.ts)).
2. **Insert the run row** as `draft`, recording `sourceSnapshotId`, the two student counts, and a metadata blob naming the Wise grade field (`if89sblj` / `Current Year/Grade level`, [`rules.ts:3-4`](../../../src/lib/student-promotions/rules.ts)) plus the source snapshot timestamp ([`:1731-1747`](../../../src/lib/student-promotions/data.ts)).
3. **Derive one grade action per accepted student.** Unparseable or blank grades become `missing_grade_review` / `unparsed_grade_review` with status `skipped`; Year 13 students are also `skipped` and additionally emit a graduation row with status `pending_review` ([`:1756-1803,1792-1802`](../../../src/lib/student-promotions/data.ts)). Everyone else is `pending` with a computed `targetGrade`.
4. **Derive course actions** from the snapshot packages, then chunk-insert grade, course, and graduation rows and write the five roll-up counters back onto the run row ([`:1805-1823`](../../../src/lib/student-promotions/data.ts)).
5. **Fetch all live FUTURE sessions once** and re-derive future-session actions and pay-rate impacts from them ([`:1825-1840`](../../../src/lib/student-promotions/data.ts)).

Nothing is written to Wise; every Wise call in this path is a read. Runs are append-only — a second `POST` creates a second `draft` run rather than replacing the first, and `GET /api/student-promotions/runs` then returns the newer one.

| Code | Condition |
|------|-----------|
| 201 | Run created. |
| 400 | Missing `WISE_USER_ID` / `WISE_API_KEY` (see the message-regex caveat above), or any lib error whose message matches rule 4. |
| 401 | No session. |
| 500 | Wise or DB failure; fallback `"Student promotion audit failed"` ([`runs/route.ts:21`](../../../src/app/api/student-promotions/runs/route.ts)). |

---

## Review gates (draft only)

Both review endpoints refuse any run whose status is not `draft`, so review is impossible once a run is verified or applied.

### `PATCH /api/student-promotions/runs/[runId]/graduation-actions/[actionId]`

Records a Year 13 graduate's disposition and re-derives everything downstream of it. Handler [`graduation-actions/[actionId]/route.ts:36-62`](../../../src/app/api/student-promotions/runs/[runId]/graduation-actions/[actionId]/route.ts); `maxDuration = 800` ([`:34`](../../../src/app/api/student-promotions/runs/[runId]/graduation-actions/[actionId]/route.ts)) — this is a **PATCH that calls Wise**, which is why.

**Auth:** session with email; stamped as `reviewedByEmail` / `reviewedByName` ([`data.ts:1993-1994`](../../../src/lib/student-promotions/data.ts)).

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `disposition` | `"inactive"` \| `"university"` | **yes** | `parseDisposition` throws `Graduation disposition must be inactive or university` for anything else, including `undefined` ([`route.ts:29-32,45`](../../../src/app/api/student-promotions/runs/[runId]/graduation-actions/[actionId]/route.ts)); the lib re-checks the same pair ([`data.ts:1976-1978`](../../../src/lib/student-promotions/data.ts)). |

**Side effects** ([`data.ts:1972-2025`](../../../src/lib/student-promotions/data.ts)): the graduation row is updated to `status: "selected"` with the disposition, reviewer, and timestamp, and its `errorMessage` cleared ([`:1988-2002`](../../../src/lib/student-promotions/data.ts)). Then, in sequence, `refreshGraduationCourseActions` runs, all live FUTURE sessions are fetched once, and the future-session actions and pay-rate impacts are both re-derived ([`:2004-2023`](../../../src/lib/student-promotions/data.ts)) — each step re-reading the full run detail first, so this single PATCH performs five `getStudentPromotionRunDetail` round-trips plus a full Wise session fetch. No Wise writes.

**Response `200`:** `{ "detail": StudentPromotionRunDetail }`.

| Code | Condition |
|------|-----------|
| 200 | Disposition recorded and downstream rows re-derived. |
| 400 | Invalid/missing `disposition`; blank `runId` or `actionId`; run not in `draft` — `{"error":"Graduation dispositions can only be changed on draft promotion runs"}` ([`data.ts:1982`](../../../src/lib/student-promotions/data.ts)). |
| 401 | No session. |
| 404 | Run not found, or `{"error":"Graduation action not found"}` ([`data.ts:1985`](../../../src/lib/student-promotions/data.ts)). |
| 500 | Wise or DB failure; fallback `"Student promotion graduation update failed"`. |

### `PATCH /api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review`

Marks one pay-rate impact group reviewed. Handler [`pay-rate-impacts/[impactId]/review/route.ts:34-62`](../../../src/app/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review/route.ts). No `maxDuration` override and no Wise call — a pure Postgres update.

**Auth:** session with email; stamped as `reviewedByEmail` / `reviewedByName`.

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | `"verified_correct"` \| `"incorrect"` | **yes** | `parseReviewStatus` throws `Pay-rate review status must be verified_correct or incorrect` otherwise ([`route.ts:29-32,43`](../../../src/app/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review/route.ts)). |
| `note` | `string` | no | Kept only when it is a string; any other type becomes `null` ([`route.ts:44`](../../../src/app/api/student-promotions/runs/[runId]/pay-rate-impacts/[impactId]/review/route.ts)), then trimmed and emptied to `null` in the lib ([`data.ts:2052`](../../../src/lib/student-promotions/data.ts)). |

**The blocked-row rule.** A row whose `reviewStatus` is `blocked` — or which carries any `blockerReason` — cannot be moved to `verified_correct`; the lib throws `Blocked pay-rate impacts cannot be verified correct until tier/rate-card data is fixed and the audit is rerun` ([`data.ts:2040-2042`](../../../src/lib/student-promotions/data.ts)). Marking such a row `incorrect` is allowed, but does not clear the verify gate either (see below).

**Side effects:** one `UPDATE` on `student_promotion_pay_rate_impacts` scoped by both `id` **and** `runId` ([`data.ts:2045-2058`](../../../src/lib/student-promotions/data.ts)) — an impact id from a different run silently matches nothing rather than erroring, because the not-found check ran against the in-memory detail first.

**Response `200`:** `{ "detail": StudentPromotionRunDetail }`.

| Code | Condition |
|------|-----------|
| 200 | Review recorded. |
| 400 | Invalid/missing `status`; blank ids; run not in `draft` ([`data.ts:2036`](../../../src/lib/student-promotions/data.ts)); attempt to verify a blocked row ([`:2041`](../../../src/lib/student-promotions/data.ts)). |
| 401 | No session. |
| 404 | Run not found, or `{"error":"Pay-rate impact row not found"}` ([`data.ts:2039`](../../../src/lib/student-promotions/data.ts)). |
| 500 | DB failure; fallback `"Student promotion pay-rate review failed"`. |

---

## Verify

### `POST /api/student-promotions/runs/[runId]/verify`

Locks a reviewed `draft` run into `verified`, which is the state the apply paths require. Handler [`verify/route.ts:10-37`](../../../src/app/api/student-promotions/runs/[runId]/verify/route.ts). No `maxDuration` override, no Wise call.

**Auth:** session with email; stamped as `verifiedByEmail` / `verifiedByName`.

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `endpointVerificationConfirmed` | `true` | **yes** | Compared with `=== true`, so `"true"` or `1` fail. A false or missing value short-circuits **in the handler** with `400 {"error":"Endpoint verification confirmation is required"}` before any lib call ([`verify/route.ts:18,23-25`](../../../src/app/api/student-promotions/runs/[runId]/verify/route.ts)). |
| `endpointVerificationNote` | `string` | **yes in effect** | Defaults to `""` when absent or non-string ([`verify/route.ts:19-21`](../../../src/app/api/student-promotions/runs/[runId]/verify/route.ts)); the lib then trims it and throws `Endpoint verification note is required` on empty ([`data.ts:1955`](../../../src/lib/student-promotions/data.ts)). Stored verbatim (trimmed) on the run row. |

**Verification gates,** checked in this order ([`data.ts:1938-1971`](../../../src/lib/student-promotions/data.ts)):

1. Run status must be `draft` — otherwise `Only draft promotion runs can be verified` ([`:1942`](../../../src/lib/student-promotions/data.ts)).
2. Freshness (`assertStudentPromotionRunFresh(detail, "verify")`, [`:1944`](../../../src/lib/student-promotions/data.ts)).
3. `assertGraduationAndPayRateReviewComplete` ([`:1945`](../../../src/lib/student-promotions/data.ts), body at [`:837-860`](../../../src/lib/student-promotions/data.ts)) — it accumulates up to four independent complaints into one message prefixed `Cannot verify this promotion run:` — any graduation row without a disposition, any pay-rate row that is `blocked` or carries a `blockerReason`, any still `pending_review`, and any marked `incorrect`. So marking a row `incorrect` does not unblock verification; it records a finding that must be fixed by a fresh audit.
4. The run must have something to do: zero pending grade actions **and** zero pending course actions **and** zero dispositioned graduation actions → `Promotion run has no pending actions to verify` ([`:1947-1952`](../../../src/lib/student-promotions/data.ts)).
5. The note must be non-empty after trimming ([`:1954-1955`](../../../src/lib/student-promotions/data.ts)).

**Side effects:** one `UPDATE` on the run row setting `status: "verified"`, `verifiedAt`, the two verifier fields, and `endpointVerificationNote` ([`data.ts:1957-1969`](../../../src/lib/student-promotions/data.ts)). Nothing else is touched; the action rows stay `pending`.

**Response `200`:** `{ "detail": StudentPromotionRunDetail }`.

| Code | Condition |
|------|-----------|
| 200 | Run verified. |
| 400 | Missing confirmation (handler-level); blank `runId`; any of the five gates above. |
| 401 | No session. |
| 404 | Run not found. |
| 500 | DB failure; fallback `"Student promotion verification failed"`. |

---

## Apply

### `POST /api/student-promotions/runs/[runId]/apply`

The admin apply path — the same library call the cron makes, reached with a session instead of a secret. Handler [`apply/route.ts:12-33`](../../../src/app/api/student-promotions/runs/[runId]/apply/route.ts); `maxDuration = 800` ([`:10`](../../../src/app/api/student-promotions/runs/[runId]/apply/route.ts)). **This endpoint writes to Wise.**

**Auth:** session with email; stamped as `appliedByEmail` / `appliedByName` ([`data.ts:2315-2316`](../../../src/lib/student-promotions/data.ts)).

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `confirm` | the literal string `"apply-student-promotions"` | **yes** | Any other value returns `400 {"error":"Apply confirmation is required"}` in the handler, before the lib is called ([`apply/route.ts:20-22`](../../../src/app/api/student-promotions/runs/[runId]/apply/route.ts)). |

The handler passes `trigger: "admin"` ([`apply/route.ts:24`](../../../src/app/api/student-promotions/runs/[runId]/apply/route.ts)); `allowBeforeTarget` is **not** exposed over HTTP, so the calendar window guard below always applies.

**Preconditions,** in the order `applyVerifiedStudentPromotionRun` checks them ([`data.ts:2286-2365`](../../../src/lib/student-promotions/data.ts)):

1. **Apply window.** `now` must be at or after `STUDENT_PROMOTION_CRON_READY_AT_UTC` = `2026-06-30T17:05:00.000Z` ([`rules.ts:2`](../../../src/lib/student-promotions/rules.ts), predicate at [`data.ts:2063-2065`](../../../src/lib/student-promotions/data.ts)); otherwise `Student promotions cannot be applied before July 1, 2026 Bangkok time` ([`:2290`](../../../src/lib/student-promotions/data.ts)). Note this is a **lower bound only** — unlike the cron's equality guard, the admin path stays open indefinitely after that instant.
2. **Idempotence.** A run already `applied` or `applied_with_errors` is returned unchanged, with no Wise traffic and no error ([`:2296-2298`](../../../src/lib/student-promotions/data.ts)).
3. **Status.** Anything other than `verified` → `Only verified student promotion runs can be applied` ([`:2300`](../../../src/lib/student-promotions/data.ts)).
4. **Freshness** ([`:2303`](../../../src/lib/student-promotions/data.ts)) and **coverage** against live accepted Wise students ([`:2307-2308`](../../../src/lib/student-promotions/data.ts)).

**Side effects.** The run flips to `applying` with `applyStartedAt` ([`:2310-2319`](../../../src/lib/student-promotions/data.ts)), then three action classes run through `mapLimit` at concurrency 3 (`WISE_WRITE_CONCURRENCY`, [`:196`](../../../src/lib/student-promotions/data.ts)) behind a shared 130 ms rate gate (`WISE_REQUEST_MIN_INTERVAL_MS`, [`:197`](../../../src/lib/student-promotions/data.ts), gate at [`:314`](../../../src/lib/student-promotions/data.ts)):

| Class | Wise write | Re-check before writing | Row outcome |
|-------|-----------|-------------------------|-------------|
| Pending grade actions | `updateWiseStudentRegistrationAnswers` — one answer on field `if89sblj` | Re-reads the student's live registration and classifies: already-target → `applied` with `responsePayload: {idempotent:true}`; year drift → `skipped` with `skipReason: "grade_drift"` ([`data.ts:2088-2156`](../../../src/lib/student-promotions/data.ts)) | `applied` / `skipped` / `failed` |
| Pending course actions | `updateWiseCourseSubject` | Re-reads the live course subject **and** the live participant roster; subject drift → `skipped` (`course_subject_drift`), roster mismatch or empty roster → `skipped` (`course_roster_drift`) ([`data.ts:2160-2237`](../../../src/lib/student-promotions/data.ts)) | `applied` / `skipped` / `failed` |
| `selected` graduation actions with a disposition | **none** — Wise is not written | `inactive` additionally calls `markCreditInactive` in Credit Control, keyed by `studentKey`; a missing key fails the row ([`data.ts:2239-2284`](../../../src/lib/student-promotions/data.ts)) | `applied` / `skipped` / `failed` |

Each action is fail-isolated: its own `try/catch` writes `status: "failed"` with the error message and returns, so one bad row never aborts the run. The terminal run status is `applied` only when there were **zero** failures and **zero** drift skips; otherwise `applied_with_errors` with `errorSummary` = `"N failed actions; M skipped actions during apply"` ([`:2342-2356`](../../../src/lib/student-promotions/data.ts)). Finally the future-session actions are re-derived against fresh Wise state ([`:2358-2363`](../../../src/lib/student-promotions/data.ts)) — they are **not** applied here.

**Response `200`:** `{ "detail": StudentPromotionRunDetail }` — read back after the writes, so `summary` reflects the outcome.

| Code | Condition |
|------|-----------|
| 200 | Apply finished — including the partial-failure case, which surfaces as `run.status === "applied_with_errors"` in the body, **not** as an error status. |
| 400 | Wrong/missing `confirm`; blank `runId`; before the apply window; run not `verified`; stale run; live students missing from the run. |
| 401 | No session. |
| 404 | Run not found. |
| 500 | Wise client construction aside (see the 400 caveat), any unmatched failure; fallback `"Student promotion apply failed"`. |

### `POST /api/student-promotions/runs/[runId]/future-sessions/apply`

Rewrites the `subject` on individual future Wise sessions so the pay band on already-scheduled classes follows the course move. Separate endpoint, separate confirmation, separate env gate. Handler [`future-sessions/apply/route.ts:15-36`](../../../src/app/api/student-promotions/runs/[runId]/future-sessions/apply/route.ts); `maxDuration = 800` ([`:13`](../../../src/app/api/student-promotions/runs/[runId]/future-sessions/apply/route.ts)). **This endpoint writes to Wise.**

**Auth:** session with email; recorded in the run's `metadata.lastFutureSessionSubjectApply`, not on the run's own actor columns ([`data.ts:2439-2452`](../../../src/lib/student-promotions/data.ts)).

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `confirm` | the literal string `"apply-future-session-subjects"` | **yes** | Compared against the exported constant `WISE_SESSION_SUBJECT_UPDATE_CONFIRMATION` ([`data.ts:199`](../../../src/lib/student-promotions/data.ts)); mismatch → `400 {"error":"Future session subject apply confirmation is required"}` ([`route.ts:23-25`](../../../src/app/api/student-promotions/runs/[runId]/future-sessions/apply/route.ts)). |

**Double gate.** Before anything else the lib requires `process.env.WISE_SESSION_SUBJECT_UPDATE_VERIFIED === "true"` ([`data.ts:449-451`](../../../src/lib/student-promotions/data.ts), env name held as a `const` at [`:201`](../../../src/lib/student-promotions/data.ts)); unset means off, so the write path is fail-closed. The throw at [`:2412`](../../../src/lib/student-promotions/data.ts) contains `required` and therefore maps to **400**. Then the run must already be `applied` or `applied_with_errors` — and that second guard's message is the one that escapes the 400 regex and returns **500** (see [the error mapper](#the-error-mapper-is-a-message-regex-not-a-typed-error-set) above). Full env inventory: [docs/reference/env.md](../env.md).

**Side effects** ([`data.ts:2408-2456`](../../../src/lib/student-promotions/data.ts)): all live FUTURE sessions are fetched once, the future-session action rows are re-derived from them, and every row still `pending` is written through `updateSessionSubject` — `PUT /teacher/classes/{classId}/sessions/{sessionId}?updateType=SINGLE` with `{ subject }` ([`wise/fetchers.ts:426-436`](../../../src/lib/wise/fetchers.ts)) — at concurrency 3 behind the same 130 ms gate. Each row records its request and response payloads on success or an `errorMessage` on failure, fail-isolated per session ([`data.ts:2367-2406`](../../../src/lib/student-promotions/data.ts)). The run row itself does **not** change status; only its `metadata` gains an apply receipt with the actor, timestamp, and attempted count.

**Response `200`:** `{ "detail": StudentPromotionRunDetail }`.

| Code | Condition |
|------|-----------|
| 200 | Attempt finished; per-session outcomes are in `futureSessionActions` / `summary`. |
| 400 | Wrong/missing `confirm`; blank `runId`; `WISE_SESSION_SUBJECT_UPDATE_VERIFIED` not `"true"`. |
| 401 | No session. |
| 404 | Run not found. |
| 500 | Run not yet applied (the regex-miss noted above); plus any genuine Wise/DB failure. Fallback `"Student promotion future session apply failed"`. |

---

## Readback

### `POST /api/student-promotions/runs/[runId]/readback`

Re-reads live Wise after an apply and reports, row by row, whether the intended state actually landed. Handler [`readback/route.ts:12-29`](../../../src/app/api/student-promotions/runs/[runId]/readback/route.ts); `maxDuration = 800` ([`:10`](../../../src/app/api/student-promotions/runs/[runId]/readback/route.ts)).

`POST` because it is expensive, not because it mutates domain state: it performs **no Wise writes** and changes no run, grade, course, graduation, or pay-rate row. Its one persistent side effect is that `refreshStudentPromotionFutureSessionActions` re-derives the future-session action rows from the sessions it just fetched ([`data.ts:2469-2476`](../../../src/lib/student-promotions/data.ts)).

**Auth:** session with email — but the actor is discarded ([`readback/route.ts:17`](../../../src/app/api/student-promotions/runs/[runId]/readback/route.ts) awaits the guard without binding it), and nothing records who ran the check.

**Request:** the body is never read; `_request` is unused ([`readback/route.ts:13`](../../../src/app/api/student-promotions/runs/[runId]/readback/route.ts)).

**Response `200`:** `{ "readback": StudentPromotionReadbackResult }` — the one endpoint on this page that does **not** return `detail` ([`readback/route.ts:19-21`](../../../src/app/api/student-promotions/runs/[runId]/readback/route.ts)). Shape at [`data.ts:279-290`](../../../src/lib/student-promotions/data.ts):

| Key | Type | Notes |
|-----|------|-------|
| `runId`, `checkedAt` | `string`, `Date` | Echo + timestamp of this sweep. |
| `liveAcceptedStudentCount`, `runGradeActionCount` | number | The coverage comparison, unasserted here — reported, not enforced. |
| `gradeSummary` | `Record<GradeReadbackStatus, number>` | Seven buckets: `promoted_exact`, `promoted_equivalent`, `missing_from_run`, `skipped_needs_review`, `wrong_grade`, `unparseable_grade`, `fetch_failed` ([`data.ts:219-226`](../../../src/lib/student-promotions/data.ts)). |
| `courseSummary` | `Record<CourseReadbackStatus, number>` | Five buckets: `target_matched`, `skipped_needs_review`, `subject_drift`, `roster_drift`, `fetch_failed` ([`data.ts:228-233`](../../../src/lib/student-promotions/data.ts)). |
| `futureSessionSummary` | `Record<FutureSessionReadbackStatus, number>` | Seven buckets: `target_matched`, `pending_update`, `manual_required`, `subject_drift`, `missing_class_id`, `missing_session_id`, `failed` ([`data.ts:235-242`](../../../src/lib/student-promotions/data.ts)). |
| `gradeRows`, `courseRows`, `futureSessionRows` | row[] | The per-entity detail behind each summary ([`data.ts:244-278`](../../../src/lib/student-promotions/data.ts)). |

| Code | Condition |
|------|-----------|
| 200 | Sweep completed. A fully failed sweep is still 200 — failures are counted in the `*_summary` buckets, not raised. |
| 400 | Blank `runId`; missing Wise credentials. |
| 401 | No session. |
| 404 | Run not found. |
| 500 | Wise or DB failure; fallback `"Student promotion readback failed"`. |

---

## The internal cron

### `GET /api/internal/student-promotions/july-1` · `POST /api/internal/student-promotions/july-1`

The scheduled apply. `POST` is a one-line alias — `return GET(request)` ([`july-1/route.ts:46-48`](../../../src/app/api/internal/student-promotions/july-1/route.ts)) — so the two methods are behaviourally identical and are counted as two endpoints only because both are exported. `maxDuration = 800` ([`:8`](../../../src/app/api/internal/student-promotions/july-1/route.ts)). Registered in [`vercel.json:56-59`](../../../vercel.json) as `5 17 30 6 *` — 30 June 17:05 UTC = 1 July 00:05 Bangkok — and in the Data Health registry as `dangerous: true` ([`cron-registry.ts:306-321`](../../../src/lib/data-health/cron-registry.ts)).

**Auth:** `CRON_SECRET` only, via an inline length-prechecked `timingSafeEqual` against `Bearer ${CRON_SECRET}` rather than the shared helper ([`july-1/route.ts:10-17`](../../../src/app/api/internal/student-promotions/july-1/route.ts)). A **missing** `CRON_SECRET` on the server returns `500 {"error":"Server misconfigured"}` ([`:21-23`](../../../src/app/api/internal/student-promotions/july-1/route.ts)); a wrong or absent header returns `401 {"error":"Unauthorized"}` ([`:24-26`](../../../src/app/api/internal/student-promotions/july-1/route.ts)).

**Request:** no body, no query parameters. The handler passes only `{ trigger: "cron" }` ([`:35`](../../../src/app/api/internal/student-promotions/july-1/route.ts)) — no `runId`, so the lib resolves the target itself: the most recent run with `targetDate = "2026-07-01"` **and** `status = "verified"`, ordered by `verifiedAt DESC, createdAt DESC` ([`data.ts:2496-2507`](../../../src/lib/student-promotions/data.ts)). With no such run it throws `No verified student promotion run found`, which the mapper's `no verified` alternative turns into a **400**.

**Response `200`:** `{ "detail": StudentPromotionRunDetail }`. Side effects are exactly those of `POST …/apply` above, minus the `confirm` check, and with the actor columns set to the literal string `"cron"` instead of an email, because `input.actor` is undefined ([`data.ts:2315-2316`](../../../src/lib/student-promotions/data.ts)).

#### The date guard: this cron returns 409 on every date except one

After the secret check and **before** any work, the handler compares today's Bangkok date against a hard-coded constant:

```ts
if (todayBangkok() !== STUDENT_PROMOTION_TARGET_DATE) {
  return NextResponse.json({
    error: "Student promotion cron is only allowed on July 1, 2026 Bangkok time",
  }, { status: 409 });
}
```

— [`july-1/route.ts:27-31`](../../../src/app/api/internal/student-promotions/july-1/route.ts). `STUDENT_PROMOTION_TARGET_DATE` is the literal `"2026-07-01"` ([`rules.ts:1`](../../../src/lib/student-promotions/rules.ts)), and `todayBangkok()` formats the current instant in `Asia/Bangkok` as `YYYY-MM-DD` ([`room-capacity/dates.ts:22-29`](../../../src/lib/room-capacity/dates.ts)).

State this plainly, because the schedule and the guard disagree about how often this route is meant to succeed. The cron expression `5 17 30 6 *` has no year field, so Vercel fires it **every 30 June at 17:05 UTC, indefinitely**. The guard is an equality test against a single fixed calendar date. The two lined up exactly once — 30 June 2026 17:05 UTC, which is 1 July 2026 00:05 in Bangkok. **Every firing after that one — 30 June 2027, 2028, and onward — fails with `409` and does nothing.** As of this page's verification date (2026-09-02) the guard is already unsatisfiable: no future date can equal `2026-07-01`, so the route is permanently dead until the constant is changed, while remaining scheduled. Nothing in the repo removes the entry or advances the constant, and the cron regression test pins the schedule as-is ([`vercel-crons.test.ts:31`](../../../src/__tests__/vercel-crons.test.ts)).

Two follow-on facts:

- The guard is in the handler, not the library, so it applies to **any** caller — a manual `curl` with the cron secret gets the same 409 on the wrong day. The library's own window check is a *lower* bound (`now >= 2026-06-30T17:05Z`, [`data.ts:2063-2065,2289-2291`](../../../src/lib/student-promotions/data.ts)), which is why the admin `…/apply` endpoint still works after July 1 while this one does not.
- There is **no in-app manual trigger** for it either. The Data Health "run now" path resolves the registry entry and enforces its `dangerous` confirmation, then falls through `runDataHealthJob`'s branch chain — which has no `student_promotions_july_1` case — to `404 {"error":"Unknown job"}` ([`run-job.ts:207`](../../../src/lib/data-health/run-job.ts), route at [`jobs/[jobKey]/run/route.ts:33-43`](../../../src/app/api/data-health/jobs/[jobKey]/run/route.ts)). The button is rendered; the job is unreachable through it.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Apply ran (or returned an already-applied run unchanged). |
| 400 | No verified run for `2026-07-01`; stale run; live students missing; run not `verified`; missing Wise credentials. |
| 401 | Wrong or missing `Authorization: Bearer $CRON_SECRET` ([`july-1/route.ts:24-26`](../../../src/app/api/internal/student-promotions/july-1/route.ts)). |
| 409 | **Any Bangkok date other than 2026-07-01** ([`july-1/route.ts:27-31`](../../../src/app/api/internal/student-promotions/july-1/route.ts)). Checked after auth, so an unauthenticated call on the wrong day still gets 401, not 409. |
| 500 | `CRON_SECRET` unset on the server ([`:21-23`](../../../src/app/api/internal/student-promotions/july-1/route.ts)); or a Wise/DB failure whose message matches no rule. Fallback `"Student promotion cron failed"`. |

Cron health treatment — why the dashboard reports this job `unknown` rather than borrowing inferred evidence — is in [docs/reference/crons.md](../crons.md#per-cron-detail) (cron 14).

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
