# Student Schedule & Parent Report API

The **3 endpoints** under `/api/student-schedule` and `/api/student-report` — two features that share one page because they share one data source (the **active credit-control snapshot**) and a set of helpers: `deriveDisplaySubject`, `deriveSessionModality` and the `TEACHER_TBC` placeholder live in `src/lib/student-schedule/` and are imported by the report builder ([`build.ts:1-7`](../../../src/lib/student-report/build.ts)), as is `parseStudentDisplay` by the report loader ([`db.ts:26`](../../../src/lib/student-report/db.ts)).

Feature meaning — why the parent page is public, what the token threat model is, which rules the calendar and the statement enforce — lives in [docs/features/student-schedule.md](../../features/student-schedule.md) and [docs/features/student-report.md](../../features/student-report.md). Column-level detail for `student_schedule_links` is in [erd-student-schedule.md](../database/erd-student-schedule.md); the `credit_control_*` tables both features read are in [erd-credit-control.md](../database/erd-credit-control.md). The full inventory is [the master index](./index.md). **This page owns the mechanics**: method, path, auth, request shape, response shape, side effects, and status codes.

**Authoritative source:** the three handlers — [`src/app/api/student-schedule/route.ts`](../../../src/app/api/student-schedule/route.ts), [`src/app/api/student-schedule/link/route.ts`](../../../src/app/api/student-schedule/link/route.ts), [`src/app/api/student-report/route.ts`](../../../src/app/api/student-report/route.ts) — plus the libs they delegate to: [`src/lib/student-schedule/data.ts`](../../../src/lib/student-schedule/data.ts), [`links.ts`](../../../src/lib/student-schedule/links.ts), [`live.ts`](../../../src/lib/student-schedule/live.ts), [`src/lib/student-report/db.ts`](../../../src/lib/student-report/db.ts), [`params.ts`](../../../src/lib/student-report/params.ts), [`window.ts`](../../../src/lib/student-report/window.ts), [`build.ts`](../../../src/lib/student-report/build.ts).

## Endpoint index (3)

| Method | Path | Auth | DB writes | Wise calls | Handler |
|--------|------|------|-----------|------------|---------|
| GET | `/api/student-schedule` | admin session **with `user.email`** | none | yes — live month sweep, fail-soft | [`route.ts:13-43`](../../../src/app/api/student-schedule/route.ts) |
| POST | `/api/student-schedule/link` | admin session **with `user.email`** | one `student_schedule_links` insert | yes — same sweep, via the pre-mint resolve | [`link/route.ts:22-74`](../../../src/app/api/student-schedule/link/route.ts) |
| GET | `/api/student-report` | admin session **with `user.email`** | none | none | [`route.ts:13-66`](../../../src/app/api/student-report/route.ts) |

Three surfaces that look like they belong to this group but are **not** endpoints:

- **`/schedule/{token}`** — the public parent page. A Server Component that resolves the capability token and reads the schedule in process ([`schedule/[token]/page.tsx:104`](../../../src/app/schedule/%5Btoken%5D/page.tsx)); it is the only path of these features in the middleware public allowlist ([`middleware.ts:21`](../../../src/middleware.ts)).
- **`/student-schedule/report` and `/student-report/report`** — the A4 print/PDF surfaces, also Server Components calling the same loaders directly; the report one calls `getParentClassReport(getDb(), …)` in process, which is what makes the LINE-delivered link render under the recipient's own session.
- **`GET /api/line/students`** — the student typeahead both workspaces search ([`student-schedule-workspace.tsx:73`](../../../src/components/student-schedule/student-schedule-workspace.tsx), [`student-report-workspace.tsx:200-203`](../../../src/components/student-report/student-report-workspace.tsx)). It is owned by LINE Integration — see [line.md](./line.md).

---

## Conventions shared by all three

**Auth — session *plus* email.** Each handler calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) and rejects on `!session?.user?.email`, not merely on a missing session ([`student-schedule/route.ts:14-17`](../../../src/app/api/student-schedule/route.ts), [`link/route.ts:23-26`](../../../src/app/api/student-schedule/link/route.ts), [`student-report/route.ts:14-17`](../../../src/app/api/student-report/route.ts)). The mint route needs the email because it stamps `createdByEmail` onto the row ([`link/route.ts:61`](../../../src/app/api/student-schedule/link/route.ts)); the two reads demand it anyway. Failure body is `401 {"error":"Unauthorized"}`. There is no role model and no per-student capability check: any signed-in user who reaches these paths can read any student's month, any family's statement, and mint a parent link.

**Middleware.** Neither `/api/student-schedule/**` nor `/api/student-report` is in the public allowlist ([`middleware.ts:10-26`](../../../src/middleware.ts)) — note the trailing slash in `pathname.startsWith("/schedule/")`, which deliberately keeps the authenticated `/student-schedule` admin page out of it ([`middleware.ts:17-21`](../../../src/middleware.ts)). An unauthenticated request is redirected to `/login` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)). For a restricted user (non-null `allowedPages`), `isPathAllowed` matches each granted page both as `/x` and as `/api/x` ([`middleware.ts:59-66`](../../../src/middleware.ts)), so the nav grants `/student-schedule` and `/student-report` ([`tools.ts:171-183`](../../../src/lib/navigation/tools.ts)) carry their own API namespaces — and *only* their own: a user granted `/student-schedule` gets `403 {"error":"Forbidden"}` from the middleware on `/api/student-report` ([`middleware.ts:97-100`](../../../src/middleware.ts)).

**Zod on every input.** Unlike the payroll group, all three handlers validate with a module-scope schema and `safeParse`, returning `400` with `parsed.error.flatten()` under a `details` key. The error labels differ per route — `"Invalid query"`, `"Invalid body"`, `"Invalid request"` — so a client cannot key on one string.

**No route segment config.** `grep -n "^export"` across the three files returns only the handlers: no `maxDuration`, no `"use cache"`, no `revalidate`, no `dynamic`. Every request reads Postgres (and, for the two schedule routes, Wise) directly on the default function duration.

**Error tail.** Business logic sits in `try/catch`; a throw becomes `500 {"error": <message>}` with a per-route fallback string for a non-`Error` throw (`"Failed to load schedule"`, `"Failed to create link"`, `"Failed to build report"`). Only the report route logs from its own catch, via `console.error("student-report GET failed", err)` ([`student-report/route.ts:60`](../../../src/app/api/student-report/route.ts)); the two schedule handlers discard the error object and return the message alone (their libs still log their own failures — e.g. a failed live sweep, [`live.ts:154-158`](../../../src/lib/student-schedule/live.ts)).

**Shared read scope.** All three resolve the single `credit_control_snapshots` row with `active = true`, newest first — inline in the schedule loader ([`data.ts:322-328`](../../../src/lib/student-schedule/data.ts)), via `getActiveCreditSnapshot` in the report loader ([`credit-control/db.ts:74-86`](../../../src/lib/credit-control/db.ts)). Every subsequent query filters on `snapshotId` first, because `credit_control_sessions` retains rotated snapshots and an unscoped predicate would scan history ([`student-report/db.ts:1-20`](../../../src/lib/student-report/db.ts)). The two features differ in what they do when no snapshot exists: the schedule loader returns `null` (rendered as **404**), the report loader returns a typed `no-snapshot` outcome (rendered as **503**).

**Tests.** [`src/app/api/student-schedule/__tests__/route.test.ts`](../../../src/app/api/student-schedule/__tests__/route.test.ts) covers both schedule endpoints in one file — 5 cases for the GET (401, three 400 query shapes, 404, 200, 500) and 5 for the mint (401, unparseable JSON, malformed month, 404 with `mintStudentScheduleLink` asserted *not* called, and a 200 that asserts the mint used the **resolved** student key rather than the raw input). [`src/app/api/student-report/__tests__/route.test.ts`](../../../src/app/api/student-report/__tests__/route.test.ts) has 11 cases, including the 503, the 404-with-`missing`, the nine-student 400, and both `feedback` branches.

---

## Student monthly schedule

### `GET /api/student-schedule`

One student's Bangkok-calendar-month payload. The admin workspace's only data call ([`student-schedule-workspace.tsx:98-101`](../../../src/components/student-schedule/student-schedule-workspace.tsx)). Handler [`route.ts:13-43`](../../../src/app/api/student-schedule/route.ts).

**Auth:** session with `user.email` → else `401`.

**Query** — `querySchema` at [`route.ts:8-11`](../../../src/app/api/student-schedule/route.ts):

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | `string`, `min(1)` | yes | The credit-control `student_key` (`"student name::parent name"`), not a Wise id. A missing param becomes `undefined` and fails the schema. |
| `month` | `string` matching `/^\d{4}-\d{2}$/` | yes | Bangkok calendar month. `2026-8` is rejected; the test pins that ([`route.test.ts:61-67`](../../../src/app/api/student-schedule/__tests__/route.test.ts)). |

There is no default month and no `liveSweep` override on the wire — the handler passes only `studentKey` and `monthKey`, so the loader's `liveSweep` default of `"always"` applies ([`route.ts:31-34`](../../../src/app/api/student-schedule/route.ts), [`data.ts:311`](../../../src/lib/student-schedule/data.ts)).

**Response `200`:** the `StudentSchedulePayload` verbatim, no wrapper key ([`types.ts:51-60`](../../../src/lib/student-schedule/types.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `student` | object | `studentKey`, `wiseStudentId`, `studentName`, `parentName`, plus the parsed `code` (`"Aadhu.Sr"`, or `null`) and `shortName` ([`types.ts:40-49`](../../../src/lib/student-schedule/types.ts); `parseStudentDisplay` at [`data.ts:136-148`](../../../src/lib/student-schedule/data.ts)). |
| `monthKey` | `string` | Echo of the request month, `YYYY-MM`. |
| `monthLabel` | `string` | `"August 2026"` — precomputed server-side. |
| `sessions` | `StudentScheduleSession[]` | Ascending by `startTime` ([`data.ts:204-206`](../../../src/lib/student-schedule/data.ts)). |
| `generatedAt` | ISO instant | `new Date()` when the live sweep succeeded, otherwise the **snapshot's** `generatedAt` ([`data.ts:406`](../../../src/lib/student-schedule/data.ts)) — so a client can tell a live read from a snapshot-only one. |

Each session ([`types.ts:19-38`](../../../src/lib/student-schedule/types.ts)) carries `wiseSessionId`, `dateKey` (Bangkok `YYYY-MM-DD`), `startTime`/`endTime` (ISO, `endTime` nullable), `startLabel`/`endLabel` (Bangkok `HH:mm`, `endLabel` empty when Wise gave no end), `subject`, `packageName`, `modality`, `teacherName`, `durationMinutes`, and an upper-cased `meetingStatus`. Three derivations are worth naming because clients must not redo them:

- **`subject`** is the Wise `title` with the modality prefix stripped (`"In-Person Session-Biology HL"` → `"Biology HL"`), falling back to `subject` → `packageName` → `"Class"` for rows predating the title column ([`deriveDisplaySubject`, `data.ts:86-96`](../../../src/lib/student-schedule/data.ts)).
- **`modality`** is `"online" | "onsite" | "unknown"`, read off that same prefix; anything unmatched stays `"unknown"` and is never guessed ([`deriveSessionModality`, `data.ts:116-121`](../../../src/lib/student-schedule/data.ts)).
- **`teacherName`** is never blank — an unresolved teacher renders the `TEACHER_TBC` constant, `"Teacher TBC"` ([`types.ts:10`](../../../src/lib/student-schedule/types.ts), applied at [`data.ts:198`](../../../src/lib/student-schedule/data.ts)).

Two rows never reach the array: a session whose `meetingStatus` matches `/^CANCELL?ED$/i`, and a duplicate `wiseSessionId` a student holds across two packages ([`data.ts:182-186`](../../../src/lib/student-schedule/data.ts)).

**Side effects.** No database writes. The read does reach Wise: `getStudentMonthlySchedule` runs a **live month sweep** for the resolved `wiseStudentId` on every call ([`data.ts:379-387`](../../../src/lib/student-schedule/data.ts)). The sweep is read-only and fail-soft — `fetchLiveMonthSessions` returns `{ ok: false }` rather than throwing when the kill switch is off, the sweep errors, or it exceeds the 8-second deadline ([`live.ts:129-160`](../../../src/lib/student-schedule/live.ts), `DEFAULT_DEADLINE_MS` at [`:27`](../../../src/lib/student-schedule/live.ts)), and the handler then serves the snapshot unchanged. A successful sweep is memoized 60 s on a `globalThis`-anchored map keyed `wiseStudentId:monthKey`, storing only the already student-filtered result ([`live.ts:28-30,140-151`](../../../src/lib/student-schedule/live.ts)). When the sweep succeeds, its result is authoritative: a snapshot row Wise no longer returns is **dropped**, and a live-only class is synthesized into the payload ([`mergeLiveSessionsIntoRows`, `data.ts:235-285`](../../../src/lib/student-schedule/data.ts)). The one runtime switch is an opt-out — `ENABLE_STUDENT_SCHEDULE_LIVE="false"` disables the overlay ([`live.ts:66-68`](../../../src/lib/student-schedule/live.ts)); it is declared optional in [`env.ts:23`](../../../src/lib/env.ts) but read straight from `process.env`.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Payload returned. A month with no classes is still 200 with `sessions: []`. |
| 400 | `studentKey` or `month` missing or malformed; body `{"error":"Invalid query","details":<flattened>}` ([`route.ts:23-28`](../../../src/app/api/student-schedule/route.ts)). |
| 401 | No session, or a session without `user.email`. |
| 403 | From middleware, for a restricted user without a `/student-schedule` grant. |
| 404 | Loader returned `null` — the key is not on the active snapshot, **or no snapshot is active at all** ([`data.ts:328,343`](../../../src/lib/student-schedule/data.ts) → [`route.ts:35-37`](../../../src/app/api/student-schedule/route.ts)). The two causes are indistinguishable to the caller. |
| 500 | Any throw, including the loader's own `Invalid month key` guard ([`data.ts:318-320`](../../../src/lib/student-schedule/data.ts)) — unreachable in practice because the Zod regex is stricter. |

---

### `POST /api/student-schedule/link`

Mints the capability token behind the public `/schedule/{token}` parent page, for exactly one (student, month). Handler [`link/route.ts:22-74`](../../../src/app/api/student-schedule/link/route.ts); the workspace calls it from its "copy parent link" control and writes the returned URL to the clipboard ([`student-schedule-workspace.tsx:135-146`](../../../src/components/student-schedule/student-schedule-workspace.tsx)).

**Auth:** session with `user.email` → else `401`, and nothing is minted ([`route.test.ts:91-96`](../../../src/app/api/student-schedule/__tests__/route.test.ts)).

**Body** (JSON) — `bodySchema` at [`link/route.ts:13-16`](../../../src/app/api/student-schedule/link/route.ts):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `studentKey` | `string`, `min(1)` | yes | Same credit-control key as the GET. |
| `month` | `string` matching `/^\d{4}-\d{2}$/` | yes | Schema message on failure: `month must be YYYY-MM`. |

Unparseable JSON is caught separately and returns `400 {"error":"Invalid JSON body"}` before Zod runs ([`link/route.ts:28-33`](../../../src/app/api/student-schedule/link/route.ts)).

**Response `200`:**

| Key | Type | Notes |
|-----|------|-------|
| `url` | `string` | `${base}/schedule/${token}` ([`studentScheduleLinkUrl`, `links.ts:187-189`](../../../src/lib/student-schedule/links.ts)). `base` is `process.env.APP_BASE_URL` trimmed, falling back to `request.nextUrl.origin` so a preview deployment links to itself ([`link/route.ts:18-20`](../../../src/app/api/student-schedule/link/route.ts)). **This is the only time the raw token exists outside the client's hands** — only its SHA-256 is stored. |
| `expiresAt` | ISO instant | `now + ttlDays`. |
| `sessionCount` | `number` | `schedule.sessions.length` — the *post-filter* count, so cancelled and duplicate rows are already excluded. |

**Side effects,** in handler order:

1. **Resolve before minting.** The route calls `getStudentMonthlySchedule` first and 404s when it returns `null`, so "a token can never grant access to an arbitrary key" ([`link/route.ts:45-53`](../../../src/app/api/student-schedule/link/route.ts)). This resolve carries the same live Wise sweep as the GET above.
2. **Mint from the resolved record, not the request.** `studentKey`, `wiseStudentId`, `studentName` and `monthKey` are taken off the loaded payload ([`link/route.ts:56-63`](../../../src/app/api/student-schedule/link/route.ts)); a test asserts exactly that ([`route.test.ts:117-137`](../../../src/app/api/student-schedule/__tests__/route.test.ts)).
3. **TTL.** `Number(process.env.STUDENT_SCHEDULE_LINK_TTL_DAYS) || DEFAULT_LINK_TTL_DAYS` ([`link/route.ts:55`](../../../src/app/api/student-schedule/link/route.ts)), i.e. **30 days** ([`links.ts:27`](../../../src/lib/student-schedule/links.ts)) whenever the env var is unset, non-numeric, or `0`. The var is declared optional in [`env.ts:25`](../../../src/lib/env.ts) but read from `process.env` here.
4. **One insert into `student_schedule_links`** ([`links.ts:95-111`](../../../src/lib/student-schedule/links.ts)): 32 `crypto.randomBytes` base64url-encoded as the token, `tokenHash` = SHA-256 hex, plus `studentKey`, `wiseStudentId`, `studentName`, `monthKey`, `createdByEmail` = the session email, and `expiresAt`. The LINE-delivery columns — `createdByLineUserId`, `sentToLineUserId`, `sentToGroupId` — stay `null` on this path; they are set only by the schedule bot, which mints in process rather than through this endpoint ([`schedule-bot.ts:386`](../../../src/lib/line/schedule-bot.ts), [`:535`](../../../src/lib/line/schedule-bot.ts), [`schedule-bot-group.ts:713`](../../../src/lib/line/schedule-bot-group.ts)). `viewCount` starts at 0 and is incremented later by the public page's `resolveStudentScheduleLink` ([`links.ts:150-159`](../../../src/lib/student-schedule/links.ts)), never by an API call.
5. **No revoke, list, or read endpoint exists.** `revokeStudentScheduleLink` ([`links.ts:172-184`](../../../src/lib/student-schedule/links.ts)) has no HTTP caller at this revision, so a minted link can only be retired by expiry or a direct database write.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Link minted; body as above. |
| 400 | Unparseable JSON (`"Invalid JSON body"`), or a schema failure (`"Invalid body"` + `details`) ([`link/route.ts:31,37-40`](../../../src/app/api/student-schedule/link/route.ts)). |
| 401 | No session, or no `user.email`. |
| 403 | From middleware, restricted user without the `/student-schedule` grant. |
| 404 | `{"error":"Student not found"}` — the key does not resolve on the active snapshot, or no snapshot is active. No row is written. |
| 500 | Any throw; `{"error": <message>}`, falling back to `"Failed to create link"`. |

---

## Parent class report

### `GET /api/student-report`

Builds the whole class-and-credit statement for 1–8 students over an inclusive Bangkok date range. The workspace's only report call ([`student-report-workspace.tsx:301-304`](../../../src/components/student-report/student-report-workspace.tsx)). Handler [`route.ts:13-66`](../../../src/app/api/student-report/route.ts).

**Auth:** session with `user.email` → else `401 {"error":"Unauthorized"}`.

**Query.** The handler folds raw search params into the schema's input shape with `normalizeReportParams` ([`params.ts:23-33`](../../../src/lib/student-report/params.ts)) before `reportParamsSchema.safeParse` ([`params.ts:5-14`](../../../src/lib/student-report/params.ts)):

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `student` | repeatable `string`, `min(1)` each | yes | Read with `searchParams.getAll("student")` ([`route.ts:21`](../../../src/app/api/student-report/route.ts)) and folded to `students`. **1 to 8** entries — `REPORT_MAX_STUDENTS = 8` ([`params.ts:3,6`](../../../src/lib/student-report/params.ts)); a ninth is a 400. Order is preserved into the response. |
| `from` | `YYYY-MM-DD` | yes | Regex-checked, not date-checked — `2026-5-01` is a 400, `2026-02-31` is not. |
| `to` | `YYYY-MM-DD` | yes | Same. A cross-field `.refine` rejects `from > to` with `from must be on or before to` ([`params.ts:12-14`](../../../src/lib/student-report/params.ts)). |
| `feedback` | `"0"` \| `"1"` | no | **Opt-out.** Absent → `includeFeedback: true`; `feedback=0` → false; any other value (e.g. `feedback=2`) is a 400, because the enum runs before the transform ([`params.ts:11`](../../../src/lib/student-report/params.ts)). |

Repeated single-value keys collapse to their first value ([`params.ts:29-31`](../../../src/lib/student-report/params.ts)). `buildReportSearch` ([`params.ts:40-52`](../../../src/lib/student-report/params.ts)) is the canonical encoder — it emits `feedback=0` **only** when feedback is excluded, keeping default-on URLs byte-identical to pre-feedback ones, which matters because report URLs are pasted into LINE messages.

**Response `200`:** the `ParentReportPayload` verbatim, no wrapper key ([`types.ts:99-112`](../../../src/lib/student-report/types.ts)):

| Key | Type | Notes |
|-----|------|-------|
| `meta.snapshotId` / `meta.snapshotGeneratedAt` | `string` / ISO | The active credit-control snapshot the whole payload was read from. |
| `meta.generatedAt` | ISO | Assembly time (`input.now ?? new Date()`, [`db.ts:262`](../../../src/lib/student-report/db.ts)). |
| `meta.window` | object | `fromDateKey`, `toDateKey`, the half-open `startUtc`/`endUtc` instants, and a display `label` such as `"1 May – 1 June 2026"` ([`resolveReportWindow`, `window.ts:50-61`](../../../src/lib/student-report/window.ts)). |
| `meta.snapshotFloorDateKey` / `snapshotCeilingDateKey` | `YYYY-MM-DD` | The snapshot's retained bounds — generation day minus `PAST_WINDOW_DAYS` (120) and plus `FUTURE_WINDOW_DAYS` (180), borrowed from Credit Control ([`window.ts:64-73`](../../../src/lib/student-report/window.ts), [`credit-control/sync.ts:61,63`](../../../src/lib/credit-control/sync.ts)). |
| `meta.floorWarning` / `ceilingWarning` | `boolean` | True when the requested window runs past those bounds ([`window.ts:76-84`](../../../src/lib/student-report/window.ts)). The request still succeeds — the payload warns rather than truncating silently. |
| `combined.bucketTotals` | `BucketTotal[]` | All students' rows rolled up: `{ bucket, sessions, hours, credits }` ([`types.ts:43-48`](../../../src/lib/student-report/types.ts)). |
| `students` | `StudentReportSection[]` | One section per requested key, in request order ([`types.ts:82-89`](../../../src/lib/student-report/types.ts)). |

Each section holds `student` ([`types.ts:72-80`](../../../src/lib/student-report/types.ts)), `rows`, `bucketTotals`, `summaries` (`SummaryLine[]` over the `class` / `teacher` / `month` / `modality` dimensions, [`types.ts:50-58`](../../../src/lib/student-report/types.ts)), `packages` (point-in-time balances, [`types.ts:60-70`](../../../src/lib/student-report/types.ts)), and `ledger: { entries, netCredit }` counting every credit movement in the window, not just classes.

A `ReportClassRow` ([`types.ts:20-41`](../../../src/lib/student-report/types.ts)) is one class line. Three fields carry rules a client must not re-derive:

- **`bucket`** is `"attended" | "ended-no-credit" | "cancelled" | "upcoming"`, or a fail-closed `other:<verbatim status>` string — a blank unknown status surfaces as `other:(blank)` and is never folded into a known bucket ([`classifySession`, `build.ts:91-103`](../../../src/lib/student-report/build.ts), [`types.ts:3-6`](../../../src/lib/student-report/types.ts)).
- **`source`** is `"snapshot"` or `"ledger"`. Ledger rows are classes the snapshot no longer holds — pre-floor or deleted in Wise — reconstructed from a `SESSION`-type billing charge whose Wise id *is* the session id, kept only when no snapshot session already covers it ([`isLedgerClassCandidate`, `build.ts:176`](../../../src/lib/student-report/build.ts); [`buildLedgerClassRow`, `build.ts:192`](../../../src/lib/student-report/build.ts)). Those rows set `timeApproximate: true`, because they are stamped by the charge, not the scheduled start.
- **`feedback`** is `null` unless the tutor's latest stored post-class version has at least one non-blank field ([`normalizeReportFeedback`, `build.ts:111-133`](../../../src/lib/student-report/build.ts)), and always `null` when `feedback=0` was sent.

**Side effects.** None — no writes, no Wise calls, no cache tags. The loader ([`getParentClassReport`, `db.ts:93-265`](../../../src/lib/student-report/db.ts)) resolves the active snapshot, resolves every requested key against `credit_control_students` on it, then issues three snapshot-scoped reads in parallel — window-scoped `credit_control_sessions`, point-in-time `credit_control_packages`, window-scoped `credit_control_credit_history` ([`db.ts:144-216`](../../../src/lib/student-report/db.ts)) — and, only when feedback is included, one further lookup joining `post_class_sessions` to its latest `post_class_feedback_versions` row ([`db.ts:52-77,244-249`](../../../src/lib/student-report/db.ts)). That last query is the deliberate exception to snapshot scoping: the post-class tables are keyed by a unique `wise_session_id` and never rotated, which is why a ledger-reconstructed pre-floor class can still carry feedback. Duplicate `student` params are de-duplicated before the lookup (`new Set`, [`db.ts:106`](../../../src/lib/student-report/db.ts)), so a repeated key yields one section, not two.

**Status codes:**

| Code | Condition |
|------|-----------|
| 200 | Payload returned. A student with no classes in the window still gets a section, with empty `rows`. |
| 400 | Any schema failure — no `student`, more than 8, malformed `from`/`to`, `from > to`, or an unrecognized `feedback`. Body `{"error":"Invalid request","details":<flattened>}` ([`route.ts:27-32`](../../../src/app/api/student-report/route.ts)). |
| 401 | No session, or no `user.email`. |
| 403 | From middleware, restricted user without the `/student-report` grant. |
| 404 | `{"error":"Some students were not found on the active snapshot","missing":[…]}` — fails closed on the **complete** missing list rather than reporting the students it did find ([`db.ts:124-125`](../../../src/lib/student-report/db.ts) → [`route.ts:48-56`](../../../src/app/api/student-report/route.ts)). The workspace renders exactly this list ([`student-report-workspace.tsx:311-321`](../../../src/components/student-report/student-report-workspace.tsx)). |
| 503 | `{"error":"No active credit-control snapshot"}` — the loader's `no-snapshot` outcome ([`route.ts:42-47`](../../../src/app/api/student-report/route.ts)). Distinct from 404 on purpose: nothing is wrong with the request, the data is simply not there yet. This is the only 503 in the group. |
| 500 | Any throw; logged, then `{"error": <message>}` or `"Failed to build report"`. |

---

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
