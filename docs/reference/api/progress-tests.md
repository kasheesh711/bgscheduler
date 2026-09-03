# Progress Tests API

Feature meaning — what the every-8-classes cadence is, how a cycle rolls, the fail-closed rules — lives in [docs/features/progress-tests.md](../../features/progress-tests.md). Column-level detail for the eight `progress_test_*` tables lives in [docs/reference/database/erd-progress-tests.md](../database/erd-progress-tests.md), and the two enums in [enums.md](../database/enums.md#progress_test_status). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes. It is the canonical home for all nine endpoints below; the group row in [docs/reference/api/index.md](./index.md) points here.

## Endpoint index (9)

Six session-authenticated handlers under `/api/progress-tests`, plus three internal handlers across two cron routes.

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| GET | `/api/progress-tests` | admin **or** `teacher` (read-only) | none | [`route.ts:6-18`](../../../src/app/api/progress-tests/route.ts) |
| POST | `/api/progress-tests/book` | admin | booking audit row + cycle state + ledger flag; optional Wise session create | [`book/route.ts:15-46`](../../../src/app/api/progress-tests/book/route.ts) |
| POST | `/api/progress-tests/select-at-home` | admin | booking audit row + cycle state | [`select-at-home/route.ts:10-34`](../../../src/app/api/progress-tests/select-at-home/route.ts) |
| POST | `/api/progress-tests/mark-at-home-submitted` | admin | booking audit row + cycle roll | [`mark-at-home-submitted/route.ts:10-34`](../../../src/app/api/progress-tests/mark-at-home-submitted/route.ts) |
| POST | `/api/progress-tests/mark-complete` | admin | cycle roll | [`mark-complete/route.ts:10-34`](../../../src/app/api/progress-tests/mark-complete/route.ts) |
| POST | `/api/progress-tests/resend-email` | admin | email-run + notification upsert; sends one email | [`resend-email/route.ts:10-34`](../../../src/app/api/progress-tests/resend-email/route.ts) |
| GET | `/api/internal/sync-progress-tests` | cron | full sync lineage (ledger, cycle state, heads-up emails) | [`sync-progress-tests/route.ts:41-43`](../../../src/app/api/internal/sync-progress-tests/route.ts) |
| POST | `/api/internal/sync-progress-tests` | cron **or** any signed-in session | same as GET, recorded as `triggerType: "admin"` | [`sync-progress-tests/route.ts:45-47`](../../../src/app/api/internal/sync-progress-tests/route.ts) |
| GET | `/api/internal/progress-tests/admin-digest` | cron | digest run + per-recipient rows; sends admin emails | [`admin-digest/route.ts:8-24`](../../../src/app/api/internal/progress-tests/admin-digest/route.ts) |

**Authoritative source:** the six handlers under [`src/app/api/progress-tests/`](../../../src/app/api/progress-tests/) and the two under [`src/app/api/internal/`](../../../src/app/api/internal/), plus the libs they delegate to — [`api.ts`](../../../src/lib/progress-tests/api.ts) (guards), [`service.ts`](../../../src/lib/progress-tests/service.ts) (payload + action adapters), [`booking.ts`](../../../src/lib/progress-tests/booking.ts) (writes), [`teacher-heads-up.ts`](../../../src/lib/progress-tests/teacher-heads-up.ts) (emails), [`run-sync-request.ts`](../../../src/lib/progress-tests/run-sync-request.ts) (single-flight), and [`admin-digest.ts`](../../../src/lib/progress-tests/admin-digest.ts).

The only in-repo caller of the six app routes is the dashboard client component, which calls all six ([`progress-tests-dashboard.tsx:414,538,557,570,603,616`](../../../src/components/progress-tests/progress-tests-dashboard.tsx)). The page itself renders no payload server-side — it runs the session guard and hands the user object to the client shell ([`(app)/progress-tests/page.tsx:6-18`](../../../src/app/%28app%29/progress-tests/page.tsx)).

---

## Conventions shared by the six app endpoints

**Two guards, one error mapper.** Every handler resolves the session through [`src/lib/progress-tests/api.ts`](../../../src/lib/progress-tests/api.ts): the read uses `requireProgressTestsSession()` ([`api.ts:35-56`](../../../src/lib/progress-tests/api.ts)); all five mutations use `requireProgressTestsAdminSession()`, which re-runs the same check and then throws `Forbidden` for a `teacher` ([`api.ts:66-72`](../../../src/lib/progress-tests/api.ts)). Both throw plain `Error("Unauthorized")` / `Error("Forbidden")`; `progressTestsErrorResponse()` maps those to **401** / **403** and anything else to **500** with the error's own message, after a single `console.error(route, error)` ([`api.ts:74-97`](../../../src/lib/progress-tests/api.ts)). A Next.js `HANGING_PROMISE_REJECTION` digest is re-thrown rather than swallowed ([`api.ts:75-82`](../../../src/lib/progress-tests/api.ts)).

**Role resolution is fail-closed.** The guard requires both an email and a name on the session, then applies page scoping via `hasPageAccess(allowedPages, "/progress-tests")` — a null `allowedPages` means full access ([`api.ts:15-21`](../../../src/lib/progress-tests/api.ts)). The JWT `role` claim is then mapped: `teacher` passes through; `admin` **or an absent/null role** (legacy full-access admins) becomes `admin`; every other role — an admissions counselor, student, or parent — throws `Forbidden`, never guessed upward ([`api.ts:48-55`](../../../src/lib/progress-tests/api.ts)).

**Middleware.** `/api/progress-tests/**` is not in the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)), so an unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:92`](../../../src/middleware.ts)). A restricted user whose `allowedPages` does not prefix-match `/progress-tests` gets a middleware-level `403 {"error":"Forbidden"}` ([`middleware.ts:36`](../../../src/middleware.ts), [`:99`](../../../src/middleware.ts)) — the in-handler `hasPageAccess` check is defence in depth behind it.

**Zod on every mutation, none on the read.** Each of the five POSTs declares a module-scope schema, reads `request.json()` inside a `try/catch` that returns `400 {"error":"Invalid JSON body"}`, then `safeParse`s and returns `400 {"error": <flattened>}` on failure. Four of the five share one shape — `{ enrollmentKey: string (min 1) }` ([`select-at-home/route.ts:6-8`](../../../src/app/api/progress-tests/select-at-home/route.ts), [`mark-at-home-submitted/route.ts:6-8`](../../../src/app/api/progress-tests/mark-at-home-submitted/route.ts), [`mark-complete/route.ts:6-8`](../../../src/app/api/progress-tests/mark-complete/route.ts), [`resend-email/route.ts:6-8`](../../../src/app/api/progress-tests/resend-email/route.ts)); only `/book` takes more.

**The enrollment key.** Every mutation addresses one enrollment by `enrollmentKey`, built as `` `${wiseClassId}|${wiseStudentId}` `` ([`config.ts:35-37`](../../../src/lib/progress-tests/config.ts)). It is the `progress_test_cycle_state` primary key and the ledger grouping key.

**Actor stamping.** All five mutations pass the resolved session user through as `actor`, which `normalizeActor` lower-cases and trims into `createdByEmail` / `createdByName` on the booking audit row and `updatedByEmail` on cycle state ([`booking.ts:94-99`](../../../src/lib/progress-tests/booking.ts)).

**Every write sweeps the cache tag.** `revalidateTag("progress-tests", { expire: 0 })` fires at the end of each write path ([`config.ts:24`](../../../src/lib/progress-tests/config.ts)) — belt-and-braces only, since the read itself is uncached (below).

**No caching, no `maxDuration`.** None of the six declares `"use cache"`, `revalidate`, `dynamic`, or `maxDuration`; each request reads Postgres directly on the platform default timeout. `getProgressTestsPayload` deliberately avoids `"use cache"` so a mutation's effect is visible on the next read ([`service.ts:1-14`](../../../src/lib/progress-tests/service.ts)).

**Mutations echo the refreshed row.** Every mutation reloads the single affected dashboard row through `reloadRow()` after the write and returns it, so the client patches its table without a refetch ([`service.ts:307-310`](../../../src/lib/progress-tests/service.ts)). A `null` row is what produces the `404 {"error":"Enrollment not found"}` in four of the five (see the `/book` caveat below).

**Tests.** [`src/app/api/progress-tests/__tests__/route.test.ts`](../../../src/app/api/progress-tests/__tests__/route.test.ts) is the only route-level suite — 17 `it` cases across GET (payload, teacher scoping, admin no-filter, 401, 403, 500), `/book` (teacher 403, success, 401, 400, 404), `/mark-complete` (success, 404, 400) and `/resend-email` (success, 404, 401), plus a two-row `it.each` asserting that a Learning Plans teacher grant does not widen Progress Tests access ([`route.test.ts:295-299`](../../../src/app/api/progress-tests/__tests__/route.test.ts)). `/select-at-home` and `/mark-at-home-submitted` have no route test; their service and booking layers are covered by [`src/lib/progress-tests/__tests__/booking.test.ts`](../../../src/lib/progress-tests/__tests__/booking.test.ts).

### The dashboard payload

Four of the six app endpoints return a `ProgressTestRow`; the read returns the whole `ProgressTestsPayload` ([`types.ts:90-96`](../../../src/lib/progress-tests/types.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `rows` | `ProgressTestRow[]` | Sorted by `currentCount` descending, then `studentName` ([`service.ts:272-277`](../../../src/lib/progress-tests/service.ts)). |
| `summary` | object | Counts by status — `accumulating`, `approaching`, `due`, `scheduled`, `completed`, plus `total` ([`types.ts:80-87`](../../../src/lib/progress-tests/types.ts)). |
| `subjects` | `string[]` | Distinct non-empty subjects across the returned rows, sorted — the facet for the UI filter ([`service.ts:289-291`](../../../src/lib/progress-tests/service.ts)). |
| `lastSyncedAt` | `string \| null` | `finishedAt ?? startedAt` of the newest `progress_test_sync_runs` row, ISO; `null` before the first run ([`service.ts:183-195`](../../../src/lib/progress-tests/service.ts)). |
| `generatedAt` | `string` | ISO timestamp of this response. |

`ProgressTestRow` carries 28 fields ([`types.ts:43-77`](../../../src/lib/progress-tests/types.ts)). The load-bearing ones:

| Field | Type | Notes |
|-------|------|-------|
| `enrollmentKey` | `string` | `wiseClassId\|wiseStudentId` — the handle every mutation takes. |
| `studentKey` / `studentName` / `parentName` | `string` | `parentName` is recovered by splitting the credit-control `student::parent` key ([`service.ts:89-92`](../../../src/lib/progress-tests/service.ts)). |
| `currentCount` / `threshold` / `cycleIndex` | `number` | `threshold` is the constant **8** ([`config.ts:11`](../../../src/lib/progress-tests/config.ts)), not a stored column. |
| `status` | `accumulating` \| `approaching` \| `due` \| `scheduled` \| `completed` | Mirrors the `progress_test_status` enum ([`schema.ts:181-187`](../../../src/lib/db/schema.ts)). |
| `mostFrequentTutorCanonicalKey` / `…DisplayName` | `string \| null` | The teacher-scoping key; `null` when unresolved. |
| `teacherNotifiedAt` / `teacherNotifiedForCycle` | `string \| null` / `number \| null` | Stamped only by a successful heads-up send. |
| `bookedTestWiseSessionId` / `bookedTestDate` / `bookedTestBookingMode` / `bookedTestLocation` | nullable | `bookingMode` is `wise` \| `manual`. |
| `scheduleMethod` | `after_class` \| `parent_pick` \| `at_home` \| `null` | |
| `atHomeSelectedAt` / `atHomeSubmittedAt` | `string \| null` | The at-home lifecycle stamps. |
| `lastAiSummary` / `lastAiSummaryAt` | object \| `null` | Coerced defensively from untyped `jsonb`: a blob missing any of `headline`, `strengths[]`, `focusAreas[]`, `recommendation` yields `null` rather than a broken card ([`service.ts:103-123`](../../../src/lib/progress-tests/service.ts)). |
| `parentLineContact` | object \| `null` | Admin reads only — see below. |
| `recommendedSlots` | `RecommendedTestSlot[]` | Admin reads only; `start`/`end` are **UTC ISO** strings from `Date.toISOString()` ([`recommend.ts:172-173`](../../../src/lib/progress-tests/recommend.ts)), despite the `+07:00` wording in the type comment ([`types.ts:31-33`](../../../src/lib/progress-tests/types.ts)). |
| `parentMessage` | `string \| null` | Admin reads only; the prebuilt bilingual outreach text. |

---

## Reading the dashboard

### `GET /api/progress-tests`

**Auth:** admin **or** `teacher`. The only endpoint a teacher may call.

**Request:** no query parameters, no body. The handler takes no `NextRequest` argument at all ([`route.ts:6`](../../../src/app/api/progress-tests/route.ts)), so anything appended to the query string is ignored.

**Response:** `200` with the full `ProgressTestsPayload` above.

**Scoping.** For a `teacher` session the handler resolves the caller's canonical-key set **fresh on every request** with `resolveTeacherCanonicalKeys(user.email)` and passes it into the service; an admin passes `null` ([`route.ts:11-13`](../../../src/app/api/progress-tests/route.ts)). Resolution matches active `tutor_contacts` rows on either the onsite or the online email, then bridges split online/onsite Wise identities by name-matching the active snapshot's identity groups, so one login covers both accounts ([`teacher-access.ts:41-114`](../../../src/lib/progress-tests/teacher-access.ts)). An unknown email resolves to `[]`, which yields **zero rows** — fail-closed, not "all rows" ([`teacher-access.ts:46`](../../../src/lib/progress-tests/teacher-access.ts), [`service.ts:279-284`](../../../src/lib/progress-tests/service.ts)). Rows with a `null` `mostFrequentTutorCanonicalKey` are never visible to a teacher.

**Admin-only enrichment.** Only the unscoped (admin) read runs `enrichRowsWithParentOutreach`, which batch-resolves the verified parent LINE contact for every row's `studentKey` in one query, then — for `approaching`/`due` rows that have a verified link — builds room-verified recommended slots and a prebuilt parent message from one shared recommendation load ([`service.ts:209-242`](../../../src/lib/progress-tests/service.ts)). Cost is bounded: one LINE query plus a handful of batched queries shared across all eligible students, not per row. A teacher-scoped read skips this entirely, so `parentLineContact` is `null`, `recommendedSlots` is `[]`, and `parentMessage` is `null`.

**Side effects:** none — two parallel reads (`loadCycleStates`, `loadLastSyncedAt`) plus the enrichment reads ([`service.ts:267-270`](../../../src/lib/progress-tests/service.ts)).

**Status codes:** `200` · `401` no session, or a session missing email/name · `403` page scope or a non-admin/non-teacher role · `500` on any service throw.

---

## Booking a test

### `POST /api/progress-tests/book`

**Auth:** admin (a `teacher` session gets `403` before any write).

**Body** — `BookProgressTestSchema` ([`book/route.ts:6-13`](../../../src/app/api/progress-tests/book/route.ts)):

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `enrollmentKey` | `string` (min 1) | yes | |
| `testDate` | `z.string().datetime()` | yes | The **start** instant. Zod's `.datetime()` accepts only the UTC `Z` form — a `+07:00` offset string is a `400`. Both UI paths comply: the custom-time dialog converts the Bangkok wall-clock through `new Date("…+07:00").toISOString()` ([`progress-tests-dashboard.tsx:237`](../../../src/components/progress-tests/progress-tests-dashboard.tsx)) and a recommended slot's `start` is already `toISOString()` output. |
| `location` | `string` | no | Free text (a room name from a recommended slot); trimmed, empty becomes `null`. |
| `modality` | `"online" \| "offline"` | no | **Accepted and validated, then discarded** — the handler never forwards it to `bookTest` ([`book/route.ts:31-37`](../../../src/app/api/progress-tests/book/route.ts)), even though the dashboard always sends it ([`progress-tests-dashboard.tsx:544`](../../../src/components/progress-tests/progress-tests-dashboard.tsx)). It reaches neither the booking row nor Wise. |
| `scheduleMethod` | `"after_class" \| "parent_pick"` | no, defaults `"parent_pick"` | `after_class` means the admin clicked a recommended slot. The third `ProgressTestScheduleMethod` value, `at_home`, is not reachable here — it is set by `/select-at-home`. |

**End time is derived, not supplied:** `bookTest` adds `PROGRESS_TEST_DEFAULT_DURATION_MINUTES` (60) to the start ([`service.ts:334`](../../../src/lib/progress-tests/service.ts), [`config.ts:21`](../../../src/lib/progress-tests/config.ts)).

**Response** (`200`) — `BookProgressTestServiceResult` ([`service.ts:313-319`](../../../src/lib/progress-tests/service.ts)):

```jsonc
{
  "status": "wise_created",      // progress_test_booking_status enum value
  "wiseSessionId": "…" ,         // null unless the Wise create actually ran
  "bookingMode": "wise",         // "wise" | "manual" | null
  "message": "Progress test booked into Wise.",
  "row": { /* refreshed ProgressTestRow */ }
}
```

`status` is one of the six `progress_test_booking_status` values ([`schema.ts:189-196`](../../../src/lib/db/schema.ts)); `/book` can return `manual_required`, `wise_created`, or `failed`.

**Side effects,** in the order `confirmProgressTestBooking` performs them ([`booking.ts:180-350`](../../../src/lib/progress-tests/booking.ts)):

1. **Always** insert a `progress_test_bookings` audit row (`status: "recorded"`, `dryRun: true`) carrying the intended Wise endpoint and body — written **before** any network call, so every attempt is auditable even when it later aborts.
2. Resolve the Wise class id from cycle state and the teacher's Wise user id from the most-frequent tutor's canonical key. If either is missing → finalize `manual_required`, set cycle state to `scheduled` with `bookingMode: "manual"`, and stop with **no Wise call**.
3. Availability pre-check against Wise (`checkTeacherAvailabilityForSessions`). Any reported conflict → finalize `failed`, leave cycle state **unchanged**, and return `200` with `status: "failed"` and `bookingMode: null` ([`booking.ts:277-286`](../../../src/lib/progress-tests/booking.ts)). A conflict is not an HTTP error.
4. Gate on `WISE_SESSION_CREATE_VERIFIED`. Off (the default) → finalize `manual_required` with **no Wise write**, record the booking locally, and tell the admin to book manually ([`config.ts:49-51`](../../../src/lib/progress-tests/config.ts), [`booking.ts:288-307`](../../../src/lib/progress-tests/booking.ts)). On → `scheduleWiseSession` creates a `Progress Test` session and the booking row is finalized `wise_created` with `dryRun: false`.
5. Upsert `progress_test_cycle_state` to `scheduled` (booked date, session id, mode, schedule method, location) and mark the matching ledger row `isProgressTest` so it never counts toward the cycle; then sweep the cache tag.

**The `404` branch is effectively unreachable here.** The route returns `404 {"error":"Enrollment not found"}` when `result.row` is null ([`book/route.ts:39-41`](../../../src/app/api/progress-tests/book/route.ts)), but for an unknown `enrollmentKey` step 2's `applyScheduledCycleState` **inserts a placeholder cycle-state row** (empty `studentKey`/`studentName`/`subject`, `cycleIndex: 0`) from the key's own `classId|studentId` split ([`booking.ts:589-634`](../../../src/lib/progress-tests/booking.ts)), so the subsequent reload finds a row and the request answers `200` with `status: "manual_required"`. The 404 path is exercised only in tests that stub the service ([`route.test.ts:209`](../../../src/app/api/progress-tests/__tests__/route.test.ts)).

**Status codes:** `200` (including a `failed` or `manual_required` booking) · `400` invalid JSON or schema · `401` · `403` teacher or page scope · `404` (see above) · `500` on a Wise/DB throw.

---

## The at-home path

### `POST /api/progress-tests/select-at-home`

**Auth:** admin. **Body:** `{ "enrollmentKey": "<string, min 1>" }` ([`select-at-home/route.ts:6-8`](../../../src/app/api/progress-tests/select-at-home/route.ts)).

**Response:** `200 { "row": ProgressTestRow }`.

**Side effects** ([`booking.ts:466-501`](../../../src/lib/progress-tests/booking.ts)): loads cycle state (absent → `false` → **404**, no writes); inserts an audit `progress_test_bookings` row with `status: "recorded"`, `dryRun: true`, `requestPayload: { mode: "at_home_selected" }`; upserts cycle state to `scheduled` with `scheduleMethod: "at_home"` and `atHomeSelectedAt = now`, clearing every booked-test field; sweeps the cache tag. **No Wise call is made on this path at all.** The student stops counting as `due` while the at-home test is outstanding.

**Status codes:** `200` · `400` · `401` · `403` · `404 {"error":"Enrollment not found"}` · `500`.

### `POST /api/progress-tests/mark-at-home-submitted`

**Auth:** admin. **Body:** `{ "enrollmentKey": "<string, min 1>" }` ([`mark-at-home-submitted/route.ts:6-8`](../../../src/app/api/progress-tests/mark-at-home-submitted/route.ts)).

**Response:** `200 { "row": ProgressTestRow }`.

**Side effects** ([`booking.ts:513-553`](../../../src/lib/progress-tests/booking.ts)): inserts an audit row with `status: "manual_confirmed"` and `requestPayload: { mode: "at_home_submitted" }`, carrying the earlier `atHomeSelectedAt` as its `scheduledTestDate`; then **rolls the cycle** — `cycleIndex + 1`, `currentCount = 0`, `currentCycleStart = now`, `status: "accumulating"`, clearing the booked, at-home, and notify fields; sweeps the cache tag. An unknown enrollment no-ops to `404`.

**Status codes:** `200` · `400` · `401` · `403` · `404` · `500`.

---

## Closing a cycle by hand

### `POST /api/progress-tests/mark-complete`

**Auth:** admin. **Body:** `{ "enrollmentKey": "<string, min 1>" }` ([`mark-complete/route.ts:6-8`](../../../src/app/api/progress-tests/mark-complete/route.ts)).

**Response:** `200 { "row": ProgressTestRow }`.

**Side effects** ([`booking.ts:418-446`](../../../src/lib/progress-tests/booking.ts)): the admin override of the automatic reset the sync engine performs once a booked test date passes. It rolls the cycle exactly as the at-home submission does — `cycleIndex + 1`, `currentCount = 0`, `currentCycleStart = now`, `status: "accumulating"`, all booked/at-home/notify fields cleared, `updatedByEmail` stamped — and sweeps the cache tag. It writes **no** booking audit row and makes no Wise call. A missing cycle state no-ops to `404`.

**Status codes:** `200` · `400` · `401` · `403` · `404` · `500`.

---

## Re-sending the teacher heads-up

### `POST /api/progress-tests/resend-email`

**Auth:** admin. **Body:** `{ "enrollmentKey": "<string, min 1>" }` ([`resend-email/route.ts:6-8`](../../../src/app/api/progress-tests/resend-email/route.ts)).

**Response** (`200`) — `ResendTeacherEmailServiceResult` ([`service.ts:405-408`](../../../src/lib/progress-tests/service.ts)):

```jsonc
{
  "outcome": {
    "enrollmentKey": "…",
    "cycleIndex": 3,
    "status": "sent",            // "sent" | "failed" | "unresolved"
    "recipientEmail": "…",       // null when unresolved
    "error": null
  },
  "row": { /* refreshed ProgressTestRow */ }
}
```

**Side effects.** The service reloads cycle state (absent → `{ outcome: null, row: null }` → **404**), rebuilds a single heads-up enrollment from the stored fields — **reusing the persisted AI summary rather than regenerating it**, so no model call is made — and hands it to `runTeacherHeadsUpNotifications` with a synthetic `syncRunId` of `manual-resend:<enrollmentKey>` ([`service.ts:422-449`](../../../src/lib/progress-tests/service.ts), [`teacher-heads-up.ts:407`](../../../src/lib/progress-tests/teacher-heads-up.ts)). That function resolves the recipient from the active `tutor_contacts` row for the tutor's canonical key, preferring the onsite email and falling back to the online one ([`teacher-heads-up.ts:101-117`](../../../src/lib/progress-tests/teacher-heads-up.ts)):

- **Unresolved** (no canonical key, or no active contact email) — writes a `progress_test_notifications` row with `status: "unresolved"` and a `recipientEmail` of `unresolved:<canonicalKey>`; no email, no email-run row, `teacherNotifiedAt` untouched.
- **Sent / failed** — upserts `progress_test_email_runs` (incrementing `attemptedCount` and the matching success/failure counter) and `progress_test_notifications`, both keyed on the idempotency key `progress-test:teacher:<enrollmentKey>:<cycleIndex>` ([`teacher-heads-up.ts:82-84`](../../../src/lib/progress-tests/teacher-heads-up.ts)). A repeat resend within the same cycle therefore **updates** the existing rows instead of adding new ones, and the same key is passed to the Apps Script sender.
- **On success only**, `teacherNotifiedAt = now` and `teacherNotifiedForCycle = cycleIndex` are stamped on cycle state, which is what stops the sync engine re-notifying this cycle.

A send failure is captured into the outcome, not thrown: the route still answers `200`, with `outcome.status: "failed"` and the provider message in `outcome.error`.

**Status codes:** `200` (including a failed or unresolved send) · `400` · `401` · `403` · `404` · `500`.

---

## Internal cron routes

Both live under `/api/internal/`, which the middleware treats as public ([`middleware.ts:24`](../../../src/middleware.ts)) — each enforces its own bearer check instead. Both declare `maxDuration = 300` and both wrap their work in `withCronInvocationAudit`, which opens a `cron_invocations` row, closes it with the response status, and converts an uncaught throw into `500 {"error": <message>}` ([`cron-audit.ts:191-206`](../../../src/lib/data-health/cron-audit.ts)). Schedules and health thresholds live in [crons.md](../crons.md); the wider cron family is documented in [internal-crons.md](./internal-crons.md).

### `GET /api/internal/sync-progress-tests` · `POST /api/internal/sync-progress-tests`

**Auth.** The `Authorization` header is compared to `Bearer ${CRON_SECRET}` with a length pre-check plus `timingSafeEqual` ([`cron-auth.ts:6-17`](../../../src/lib/internal/cron-auth.ts)). `GET` accepts nothing else. `POST` additionally falls back to **any** signed-in Auth.js session — no role or page check — recorded as `triggerSource: "admin"` with the actor's email ([`sync-progress-tests/route.ts:19-32`](../../../src/app/api/internal/sync-progress-tests/route.ts)). Because the session branch is evaluated **before** the missing-secret branch, a signed-in `POST` still succeeds in an environment where `CRON_SECRET` is unset.

**Cron registration.** `vercel.json` schedules the `GET` at `25,55 * * * *` ([`vercel.json:20-23`](../../../vercel.json)); the Data Health registry declares the same schedule with `lateAfterMinutes: 45` and `maxDurationSeconds: 300` under job key `progress_tests` ([`cron-registry.ts:128-142`](../../../src/lib/data-health/cron-registry.ts)).

**Request:** no query parameters, no body — both methods route into the same `handleSync` ([`sync-progress-tests/route.ts:9-39`](../../../src/app/api/internal/sync-progress-tests/route.ts)).

**Single-flight.** `runProgressTestSyncRequest` first fails any run still marked `running` past 20 minutes (`STALE_RUNNING_PROGRESS_TEST_SYNC_MS`), stamping a fixed error summary on it, then refuses to start a second concurrent run; a unique-violation on insert is also treated as "already running" ([`run-sync-request.ts:48-135`](../../../src/lib/progress-tests/run-sync-request.ts), [`config.ts:27`](../../../src/lib/progress-tests/config.ts)).

**Responses:**

| Status | Body |
|--------|------|
| `200` | `ProgressTestSyncResult` + `syncRunId` + `staleRunningSyncsFailed` — `success: true`, `ledgerRowCount`, `enrollmentCount`, `approachingCount`, `dueCount`, `unresolvedTeacherCount`, `notificationCount` ([`sync.ts:75-84`](../../../src/lib/progress-tests/sync.ts), [`run-sync-request.ts:158-164`](../../../src/lib/progress-tests/run-sync-request.ts)). |
| `202` | Skipped — `{ success: true, skipped: true, alreadyRunning: true, syncRunId, runningStartedAt, staleRunningSyncsFailed, … }` with all counts zeroed ([`run-sync-request.ts:82-101`](../../../src/lib/progress-tests/run-sync-request.ts)). |
| `401` | `{"error":"Unauthorized"}` — bad or absent secret (and, for `POST`, no session). |
| `500` | `{"error":"Server misconfigured"}` when `CRON_SECRET` is unset; or the same result envelope with `success: false` and an `errorSummary` when the sync itself failed. |

**Side effects** ([`sync.ts:494-633`](../../../src/lib/progress-tests/sync.ts)): reads attended-with-credit sessions from the active credit-control snapshot; fetches Wise teachers and PAST sessions since `PROGRESS_TEST_COUNTING_START` (2026-03-01 Bangkok) to resolve each session's teacher via the active snapshot's identity groups; upserts `progress_test_attendance_ledger` idempotently on `wiseSessionId + wiseStudentId`; recomputes every enrollment's cycle state through the pure engine and upserts `progress_test_cycle_state`; then, for enrollments newly transitioning to `approaching`, generates an AI summary from recent feedback, stores it on cycle state, and **sends the teacher heads-up email**. Step 5 is fail-isolated — an AI or email error is logged and never fails the run. Finally the run row is finalized with counts and metadata and the cache tag is swept.

### `GET /api/internal/progress-tests/admin-digest`

**Auth:** `CRON_SECRET` only — `rejectInvalidCronSecret` returns `401` for a bad secret and `500 {"error":"Server misconfigured"}` when the env var is unset ([`cron-auth.ts:19-26`](../../../src/lib/internal/cron-auth.ts)). There is no session fallback and no `POST` handler.

**Cron registration:** `35 0 * * *` UTC = **07:35 Bangkok**, daily ([`vercel.json:24-27`](../../../vercel.json)), registered as `progress_tests_digest` with `expectedBangkokMinute` 455 and `lateAfterMinutes: 60` ([`cron-registry.ts:143-158`](../../../src/lib/data-health/cron-registry.ts)).

**Request:** no query parameters, no body.

**Response** — `ProgressTestAdminDigestResult` ([`admin-digest.ts:32-43`](../../../src/lib/progress-tests/admin-digest.ts)): `status` (`sent` \| `partial` \| `failed` \| `skipped`), `digestDate` (Bangkok `YYYY-MM-DD`), `digestRunId`, `approachingCount`, `dueCount`, `unresolvedCount`, `attempted`, `success`, `failed`, `message`.

**Status codes:** `200` for `sent`, `partial`, and `skipped`; **`500` for `failed`** — the route maps the result status to HTTP directly ([`admin-digest/route.ts:17`](../../../src/app/api/internal/progress-tests/admin-digest/route.ts)) — and `500 {"error": message}` on an uncaught throw.

**Side effects** ([`admin-digest.ts:309-451`](../../../src/lib/progress-tests/admin-digest.ts)): returns `skipped` without writing when a terminal digest already exists for today (the per-day idempotency guard); otherwise builds content from `approaching` plus **un-booked** `due` cycle-state rows and the distinct recipients of `unresolved` teacher notifications. With nothing to report it creates the run row and immediately marks it `skipped`. With content, it creates a `progress_test_admin_digest_runs` row, loads every `admin_users` email as the recipient list, and sends one email per recipient through the Apps Script sender under the idempotency key `progress-test-digest:<digestDate>:<email>`, writing a `progress_test_admin_digest_recipients` row per attempt. An empty recipient list is a **`failed`** digest (`500`), not a skip. The final status is `sent` (no failures), `partial` (some sent), or `failed` (none sent).

---

## Status-code summary

| Code | When |
|------|------|
| `200` | Success on all nine handlers. On `/book` and `/resend-email` this includes business-level non-success — an availability conflict, an unverified Wise gate, or a failed email — which are reported in the body, never as an HTTP error. |
| `202` | `/api/internal/sync-progress-tests` only: a run is already in flight. |
| `400` | The five mutations: unparseable JSON (`{"error":"Invalid JSON body"}`) or a Zod failure (`{"error": <flattened>}`). |
| `401` | App routes: no session, or a session without an email/name. Internal routes: bad/absent cron secret (and, for `POST` sync, no session). |
| `403` | App routes only: a `teacher` calling a mutation, a page-scope miss, or any other role. Also emitted by the middleware before the handler for a restricted user. |
| `404` | The four single-enrollment mutations when no cycle state exists (`{"error":"Enrollment not found"}`). Effectively unreachable on `/book`. |
| `500` | Any other throw (mapped by `progressTestsErrorResponse` on app routes); `Server misconfigured` when `CRON_SECRET` is unset; a failed sync run; a failed admin digest. |

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
