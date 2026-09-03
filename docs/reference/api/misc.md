# Search, Compare & Platform Core API

Mechanical HTTP reference for the **11 endpoints across 10 route files** that have no group page of their own: the tutor search and range-search workspace, the AI-scheduler assistant turn, compare and discover, the tutor/filter dropdown reads, the home summary that feeds the nav badges, the session-authenticated Wise-sync trigger, and the Auth.js catch-all.

> **Canonical-home rule.** This page owns request/response signatures, side effects and status codes. *Why* these endpoints exist — the fail-closed availability doctrine, the compare workflow, what the AI scheduler is allowed to decide — lives in [docs/features/tutor-search.md](../../features/tutor-search.md), [docs/features/tutor-compare.md](../../features/tutor-compare.md) and [docs/features/ai-scheduler.md](../../features/ai-scheduler.md). The master method+path inventory across every group is [index.md](./index.md).

**Authoritative source:** the ten handlers listed below, plus the libs they delegate to — [`src/lib/search/engine.ts`](../../../src/lib/search/engine.ts), [`range-search.ts`](../../../src/lib/search/range-search.ts), [`compare.ts`](../../../src/lib/search/compare.ts), [`index.ts`](../../../src/lib/search/index.ts), [`src/lib/data/tutors.ts`](../../../src/lib/data/tutors.ts), [`src/lib/data/filters.ts`](../../../src/lib/data/filters.ts), [`src/lib/home/summary.ts`](../../../src/lib/home/summary.ts), [`src/lib/sync/run-wise-sync.ts`](../../../src/lib/sync/run-wise-sync.ts) and [`src/lib/auth.ts`](../../../src/lib/auth.ts).

## Where the other families moved

This page used to carry ten more route families — eleven `/api` prefixes. Each now has its own reference page:

| Family | Paths | Now documented in |
|---|---|---|
| University Admissions | `/api/admissions/**` | [university-admissions.md](./university-admissions.md) · notification cron in [internal-crons.md](./internal-crons.md) |
| Post-Class Feedback | `/api/post-class-feedback/**` | [post-class-feedback.md](./post-class-feedback.md) · its six `/api/internal/**` cron routes in [internal-crons.md](./internal-crons.md) |
| Competitor Intelligence | `/api/competitor-intelligence/**` | [competitor-intelligence.md](./competitor-intelligence.md) |
| Progress Tests | `/api/progress-tests/**` | [progress-tests.md](./progress-tests.md) |
| US Universities (IPEDS) | `/api/us-universities/**` | [us-universities.md](./us-universities.md) |
| Leave Requests | `/api/leave-requests/**` | [leave-requests.md](./leave-requests.md) |
| Student Schedule & Parent Report | `/api/student-schedule/**`, `/api/student-report` | [student-schedule-and-report.md](./student-schedule-and-report.md) |
| Tutor Profiles | `/api/tutor-profiles/**` | [tutor-profiles.md](./tutor-profiles.md) |
| Data Health | `/api/data-health/**`, `/api/internal/cron-watchdog` | [data-health.md](./data-health.md) |
| Student Promotions | `/api/student-promotions/**` | [student-promotions.md](./student-promotions.md) |

Everything else — AI Scheduler, class assignments, classrooms, credit control, LINE, payroll, proposals, room capacity, sales dashboard, Wise activity, and the internal cron surface — has had its own page all along; [index.md](./index.md) is the routing table.

## Endpoint index (11)

| Method | Path | Auth | Writes | Handler |
|--------|------|------|--------|---------|
| POST | `/api/search` | session | none (may rebuild the in-memory index) | [`search/route.ts:30-60`](../../../src/app/api/search/route.ts) |
| POST | `/api/search/range` | session | none (may rebuild the in-memory index) | [`search/range/route.ts:6-56`](../../../src/app/api/search/range/route.ts) |
| POST | `/api/search/assistant` | middleware-public, **session in-handler** | one `ai_scheduler_runs` row per turn | [`search/assistant/route.ts:135-211`](../../../src/app/api/search/assistant/route.ts) |
| POST | `/api/compare` | session | none | [`compare/route.ts:112-254`](../../../src/app/api/compare/route.ts) |
| POST | `/api/compare/discover` | session | none | [`compare/discover/route.ts:29-170`](../../../src/app/api/compare/discover/route.ts) |
| GET | `/api/tutors` | session | none | [`tutors/route.ts:5-18`](../../../src/app/api/tutors/route.ts) |
| GET | `/api/filters` | session | none | [`filters/route.ts:5-17`](../../../src/app/api/filters/route.ts) |
| GET | `/api/home/summary` | session **with `user.email`** | none | [`home/summary/route.ts:6-21`](../../../src/app/api/home/summary/route.ts) |
| POST | `/api/admin/sync-wise` | session | full Wise snapshot write + promotion, `cron_invocations` row | [`admin/sync-wise/route.ts:8-24`](../../../src/app/api/admin/sync-wise/route.ts) |
| GET | `/api/auth/[...nextauth]` | public | Auth.js session cookies; Google OAuth token row at sign-in | [`auth/[...nextauth]/route.ts:3`](../../../src/app/api/auth/[...nextauth]/route.ts) |
| POST | `/api/auth/[...nextauth]` | public | same | [`auth/[...nextauth]/route.ts:3`](../../../src/app/api/auth/[...nextauth]/route.ts) |

Ten route files, eleven endpoints: the Auth.js catch-all exports **two** methods from a single three-line file by destructuring (`export const { GET, POST } = handlers`), so it matches no `export async function` grep — this is the pair that makes the repo-wide count 243 rather than 241.

**In-repo callers.** Only six of these are reached from application code:

| Endpoint | Caller |
|---|---|
| `POST /api/search/range` | the search form ([`search-form.tsx:138`](../../../src/components/search/search-form.tsx)) |
| `POST /api/search/assistant` | the AI-scheduler panel ([`ai-scheduler-panel.tsx:87`](../../../src/components/search/ai-scheduler-panel.tsx)) |
| `POST /api/compare` | the compare hook ([`use-compare.ts:135`](../../../src/hooks/use-compare.ts)) |
| `POST /api/compare/discover` + `GET /api/filters` | the discovery panel ([`discovery-panel.tsx:91,55`](../../../src/components/compare/discovery-panel.tsx)) |
| `GET /api/home/summary` | the nav bar, once per mount and only when the rendered sections carry badges ([`app-nav.tsx:141-151`](../../../src/components/layout/app-nav.tsx)) |
| `POST /api/admin/sync-wise` | the class-assignment pre-sync flow ([`sync-flow.ts:110`](../../../src/components/class-assignments/sync-flow.ts)) |

`POST /api/search` and `GET /api/tutors` have **no in-repo caller**. `/search` and `/scheduler` await `getTutorList()` and `getFilterOptions()` server-side and pass the results down as props ([`(app)/search/page.tsx:11-12`](../../../src/app/%28app%29/search/page.tsx), [`(app)/scheduler/page.tsx:14`](../../../src/app/%28app%29/scheduler/page.tsx)), and the client searches through `/api/search/range`. Both remain live, tested endpoints; treat them as the external contract, not dead code — all nine non-auth paths are pinned in the release guard's route inventory ([`production-route-surface.json`](../production-route-surface.json)).

---

## Conventions shared by these endpoints

### Middleware tier

`isPublicRoute` ([`middleware.ts:10-26`](../../../src/middleware.ts)) allowlists `/api/auth*` and the exact path `/api/search/assistant`. Every other path on this page is behind the session gate: an unauthenticated request is redirected to `/login?callbackUrl=…` before the handler runs ([`middleware.ts:89-93`](../../../src/middleware.ts)).

A restricted user (non-null `allowedPages`) is additionally matched by `isPathAllowed`, which tests each allowed page both as a page prefix and as its `/api` namespace ([`middleware.ts:59-66`](../../../src/middleware.ts)); a miss on an `/api/*` path returns `403 {"error":"Forbidden"}` from the edge ([`middleware.ts:97-100`](../../../src/middleware.ts)). Two carve-outs touch this page: `/api/home/summary` **always** passes so every signed-in user can load the landing hub ([`middleware.ts:38`](../../../src/middleware.ts)), and `/` passes when the user has more than one allowed page ([`middleware.ts:58`](../../../src/middleware.ts)).

A maintenance gate sits **above** the public allowlist ([`middleware.ts:76-82`](../../../src/middleware.ts)), so `MAINTENANCE_MODE=true` closes even `/api/auth*` for non-bypass emails.

`POST /api/search/assistant` is public at the middleware but still calls `auth()` and returns `401` without a session ([`assistant/route.ts:136-139`](../../../src/app/api/search/assistant/route.ts)) — effectively admin-only. The allowlist entry only spares it the login redirect.

### Auth and the four-step handler shape

Every non-auth handler here calls `auth()` from [`@/lib/auth`](../../../src/lib/auth.ts) directly; there is no guard module and no role check on this surface. Eight test `!session`; `GET /api/home/summary` alone tests `!session?.user?.email`, because it stamps the caller's identity into the payload ([`home/summary/route.ts:8`](../../../src/app/api/home/summary/route.ts)).

The five POST handlers follow the repo's standard four steps in order — `auth()` → 401, `request.json()` in try/catch → `400 {"error":"Invalid JSON"}`, `schema.safeParse()` → `400 {"error":"Invalid request","details":<flatten()>}`, business logic in try/catch → `500 {"error":<message>}`. Each 500 fallback string differs by route: `"Search failed"` (search and range), `"Compare failed"`, `"Discover failed"`, `"AI scheduling failed"`, `"Failed to load tutors"`, `"Failed to load filters"`, `"Home summary failed"`.

### Snapshot metadata and staleness

Search, range search, compare and discover each return a `SnapshotMeta` ([`types.ts:30-34`](../../../src/lib/search/types.ts)):

```jsonc
{ "snapshotId": "uuid", "syncedAt": "2026-09-02T…Z", "stale": false }
```

`stale` is `Date.now() - syncedAt > API_STALE_THRESHOLD_MS`, and that threshold is **90 minutes** — 30-minute cron cadence plus recovery headroom ([`ops/stale.ts:1-2`](../../../src/lib/ops/stale.ts)). Search and compare additionally push `STALE_SEARCH_WARNING` (`"Search data may be stale — last sync was more than 90 minutes ago"`) into `warnings` ([`engine.ts:36-38`](../../../src/lib/search/engine.ts), [`compare/route.ts:147-149`](../../../src/app/api/compare/route.ts)); `POST /api/compare/discover` computes `stale` but emits no warning — it has no `warnings` field at all. Staleness is always a warning, never withheld data.

### The in-memory index

`ensureIndex(db)` backs search, range and both compare endpoints. It returns any in-flight build promise first, then re-reads the active snapshot id and the tutor-profile version and reuses the cached index only when **both** still match; otherwise it rebuilds ([`index.ts:354-399`](../../../src/lib/search/index.ts)). The build promise is assigned to the `globalThis` singleton in the same synchronous tick that starts the work, so concurrent requests coalesce onto one rebuild instead of stampeding. A request that triggers a rebuild pays for it inline — that is the only "side effect" these read endpoints have.

---

## Search

`src/app/api/search/` · tutor-search **stable**; `/api/search/assistant` is ai-scheduler **experimental**.

### `POST /api/search`

Multi-slot availability search against the warm in-memory index. Tutors available in **every** requested slot are returned as the `intersection`.

**Auth:** `!session` → `401 {"error":"Unauthorized"}` ([`route.ts:31-34`](../../../src/app/api/search/route.ts)).

**Body** — `searchRequestSchema` ([`route.ts:8-28`](../../../src/app/api/search/route.ts)):

```jsonc
{
  "searchMode": "recurring" | "one_time",
  "slots": [{                       // min 1, no maximum
    "id": "string",
    "dayOfWeek": 0-6,               // optional (recurring)
    "date": "string",               // optional (one_time)
    "start": "HH:mm",               // /^\d{2}:\d{2}$/
    "end": "HH:mm",
    "mode": "online" | "onsite" | "either"
  }],
  "filters": { "subject": "…", "curriculum": "…", "level": "…" },  // optional, all optional
  "rawInput": "string"              // optional, accepted and ignored by the engine
}
```

The schema is not `.strict()`, so unknown top-level keys are dropped rather than rejected.

**Response `200`** — `SearchResponse` ([`types.ts:56-63`](../../../src/lib/search/types.ts)): `{ snapshotMeta, normalizedSlots, perSlotResults, intersection, latencyMs, warnings }`. `normalizedSlots` echoes the request slots verbatim ([`engine.ts:52`](../../../src/lib/search/engine.ts)). Each `perSlotResults` entry is `{ slotId, available, needsReview }` ([`types.ts:50-54`](../../../src/lib/search/types.ts)); a tutor row is a `TutorResult` ([`types.ts:36-44`](../../../src/lib/search/types.ts)) carrying `tutorGroupId`, `tutorCanonicalKey`, `displayName`, `supportedModes`, `qualifications`, `underlyingWiseRecords` and an optional `businessProfile`, and a review row adds `reasons: string[]` ([`types.ts:46-48`](../../../src/lib/search/types.ts)).

**Fail-closed routing** ([`engine.ts:83-97`](../../../src/lib/search/engine.ts), [`:142-146`](../../../src/lib/search/engine.ts)):

- any `dataIssues` on the group → a reason string `"{type}: {message}"`, and the tutor lands in `needsReview`, never `available`;
- `supportedModes.length === 0` (unresolved modality) → reason `"Unresolved modality"`, likewise `needsReview`;
- a *resolved* modality that simply does not match a non-`either` slot mode → the tutor is skipped entirely, not surfaced as review.

A slot whose weekday resolves outside 0-6 returns empty `available`/`needsReview` rather than throwing ([`engine.ts:70-72`](../../../src/lib/search/engine.ts)). Blocking sessions and leaves remove a tutor from the slot outright.

**Side effects:** none beyond a possible index rebuild ([`route.ts:54`](../../../src/app/api/search/route.ts)).

**Status codes:** 200 · 400 invalid JSON · 400 Zod failure with `details` · 401 · 500 `{"error": …}`.

### `POST /api/search/range`

Time-window search: the window is sliced into fixed-duration sub-slots and each is evaluated per tutor into a grid. This is the endpoint the search UI actually calls.

**Auth:** `!session` → 401 ([`range/route.ts:7-10`](../../../src/app/api/search/range/route.ts)).

**Body** — `rangeRequestSchema`, declared in the lib rather than the route ([`range-search.ts:16-37`](../../../src/lib/search/range-search.ts)): `searchMode`, optional `dayOfWeek` (0-6) and `date`, `startTime` and `endTime` (`HH:mm`), `durationMinutes`, `mode`, optional `filters`, optional `tutorGroupIds: string[]`. `durationMinutes` accepts the strings `"60" | "90" | "120"` (coerced to numbers via `.transform(Number)`) **or** the numeric literals `60 | 90 | 120` — nothing else.

**Response `200`** — `RangeSearchResponse` ([`types.ts:102-109`](../../../src/lib/search/types.ts)): `{ snapshotMeta, subSlots, grid, needsReview, latencyMs, warnings }`. A `grid` row ([`types.ts:93-100`](../../../src/lib/search/types.ts)) carries the tutor identity plus `availability`, one entry per sub-slot: `true` for free, or a `BlockingSessionInfo[]` describing what blocks it ([`types.ts:67-78`](../../../src/lib/search/types.ts)).

**Proposal holds are merged into blocking.** `executeRangeSearch` loads active local holds and, for a sub-slot the engine called available, replaces `true` with a single `BlockingSessionInfo` of `kind: "proposal_hold"` ([`range-search.ts:117,144-168`](../../../src/lib/search/range-search.ts)). A local admin hold therefore suppresses a slot without anything ever being written to Wise. This is the only search path that consults proposals.

**Status codes:** 200 · 400 invalid JSON · 400 Zod failure · **400 `{"error":"Time range is too short for the selected class duration"}`** when `generateSubSlots` yields nothing, checked in the route before any DB work ([`range/route.ts:30-36`](../../../src/app/api/search/range/route.ts)) · 401 · 500.

### `POST /api/search/assistant`

One AI-scheduler turn: an LLM parses pasted parent chat, the app proves availability deterministically through the same search engine, and a parent reply is drafted. The model never decides availability.

**Auth:** middleware-public, `!session` → 401 in-handler ([`assistant/route.ts:136-139`](../../../src/app/api/search/assistant/route.ts)).

**Body** — `aiSchedulerRequestSchema` ([`scheduler.ts:141-143`](../../../src/lib/ai/scheduler.ts)), the strictest schema on this page:

```jsonc
{ "input": "pasted chat text" }   // trimmed, 1-6000 chars, .strict() — any extra key is a 400
```

**Response `200`** — one of three discriminated shapes from `responseFromSchedulerResult` ([`assistant/route.ts:101-133`](../../../src/app/api/search/assistant/route.ts)), each with a `logId` appended at return ([`:188`](../../../src/app/api/search/assistant/route.ts)):

| `status` | Fields |
|---|---|
| `availability_summary` | `state`, `availabilitySummary`, `assistantMessage`, `parentMessageDraft`, `snapshotMeta`, `warnings`, `logId` — chosen only when the turn is parent-ready, an availability summary exists, and a subject intent or subject filter is resolved ([`:91-99`](../../../src/app/api/search/assistant/route.ts)) |
| `needs_clarification` | `partial`, `clarifyingQuestions` (never empty — a generic fallback question is substituted), `warnings`, `logId` |
| `solved` | `parsedRequest`, `options` (max 3 tutors per option), `parentMessageDraft`, `snapshotMeta`, `warnings`, `logId` |

**Side effects:** every turn writes one `ai_scheduler_runs` row via `logSchedulerRun` — on the success path *and* on the failure path ([`:176-186`](../../../src/app/api/search/assistant/route.ts), [`:191-205`](../../../src/app/api/search/assistant/route.ts)). The pasted text is never stored raw: `redactAiSchedulerInput` masks emails, phone numbers and long digit runs, then truncates to 600 characters ([`scheduler.ts:439-450`](../../../src/lib/ai/scheduler.ts)).

**Status codes:** 200 · 400 invalid JSON · 400 Zod failure · **503 `{"error":"AI scheduler is not configured"}`** when `ENABLE_AI_SCHEDULER === "false"` or `OPENAI_API_KEY` is empty ([`scheduler.ts:477-480`](../../../src/lib/ai/scheduler.ts), checked at [`assistant/route.ts:156-161`](../../../src/app/api/search/assistant/route.ts)) · 401 · **502 `{ error, detail, logId }`** on an execution failure. Note the ordering: the config check runs **after** body validation, so a malformed body on an unconfigured deployment still returns 400.

The eight `/api/ai-scheduler/*` endpoints — conversations, messages, feedback, metrics — are a separate surface documented in [ai-scheduler.md](./ai-scheduler.md).

---

## Compare

`src/app/api/compare/` · tutor-compare — both endpoints are fully live; only the `/compare` *page* is a client-side redirect to `/search`.

### `POST /api/compare`

Week-scoped side-by-side comparison of up to three tutors: schedules, same-student conflicts, shared free slots.

**Auth:** `!session` → 401 ([`route.ts:113-116`](../../../src/app/api/compare/route.ts)).

**Body** — `compareRequestSchema` ([`route.ts:24-31`](../../../src/app/api/compare/route.ts)):

```jsonc
{
  "tutorGroupIds": ["…"],           // min 1, max 3
  "mode": "recurring" | "one_time", // parsed, then unused by the handler
  "dayOfWeek": 0-6,                 // optional — narrows to one weekday
  "date": "…",                      // optional — narrows to that date's weekday
  "weekStart": "YYYY-MM-DD",        // optional; defaults to the current Bangkok Monday
  "fetchOnly": ["…"]                // optional: serialize only this subset
}
```

**Response `200`** — `CompareResponse` ([`types.ts:169-178`](../../../src/lib/search/types.ts)): `{ snapshotMeta, tutors, conflicts, sharedFreeSlots, weekStart, weekEnd, latencyMs, warnings }`. Each `CompareTutor` ([`types.ts:139-152`](../../../src/lib/search/types.ts)) carries the tutor identity, filtered `sessions`, `availabilityWindows`, `leaves`, `dataIssues`, an optional `businessProfile`, plus the derived `weeklyHoursBooked` and `studentCount`. `weekEnd` is the **Sunday** of the displayed week — `mondayDate + 6` ([`route.ts:244`](../../../src/app/api/compare/route.ts)) — while the internal `dateRange` end is the exclusive `+7` boundary ([`:170-171`](../../../src/app/api/compare/route.ts)).

**Mechanics worth knowing:**

- **Stale-id rescue.** Ids absent from the active index are looked up in `tutor_identity_groups` by UUID (only values matching the UUID regex are queried) and re-resolved through `canonicalKey`; when any id needed that path the response gains the warning `"Tutor selection was refreshed after the latest Wise sync"` ([`route.ts:61-110`](../../../src/app/api/compare/route.ts), [`:157-159`](../../../src/app/api/compare/route.ts)). Duplicates that collapse onto the same active group are de-duplicated.
- **Historical range (D-07 / PAST-01).** If the requested week starts before the Bangkok start of today, `past_session_blocks` are fetched by canonical key — keys sorted first for a deterministic cache key — and merged into `buildCompareTutor` *and*, via cloned groups whose `sessionBlocks` are extended, into `findSharedFreeSlots` ([`route.ts:185-227`](../../../src/app/api/compare/route.ts)). Without the second merge a past captured session would read as free. The fetch is cached under its own `cacheTag("past-sessions")` with `cacheLife("days")`, deliberately separate from the `"snapshot"` tag a sync sweeps ([`data/past-sessions.ts:82-89`](../../../src/lib/data/past-sessions.ts)).
- **Weekday fallback (D-05).** For a target weekday with no session in range, `buildCompareTutor` substitutes the nearest *future* occurrence, deduplicated by `recurrenceId` and limited to one calendar day's worth — but only when that weekday's date is today or later; a past weekday stays honestly empty ([`compare.ts:255-291`](../../../src/lib/search/compare.ts)).
- **`fetchOnly`.** Conflicts and shared free slots are always computed over the *full* selection; only the serialized `tutors` array is filtered, after mapping requested ids through the stale-id resolution map ([`route.ts:229-236`](../../../src/app/api/compare/route.ts)). That is what makes the client's incremental cache correct — `use-compare.ts` keys cached tutors as `` `${tutorGroupId}:${week}:${CACHE_VERSION}` `` with `CACHE_VERSION = "v3"` ([`cache-version.ts:24`](../../../src/lib/search/cache-version.ts)) and clears the whole map when `snapshotMeta.snapshotId` moves mid-session ([`use-compare.ts:152-165`](../../../src/hooks/use-compare.ts)).

**Status codes:** 200 · 400 invalid JSON · 400 Zod failure · 401 · **404 `{"error":"No matching tutor groups found in active snapshot"}`** when nothing resolves ([`route.ts:161-166`](../../../src/app/api/compare/route.ts)) · 500.

### `POST /api/compare/discover`

Ranks every other tutor in the active snapshot as a candidate to add to the current comparison.

**Auth:** `!session` → 401 ([`discover/route.ts:30-33`](../../../src/app/api/compare/discover/route.ts)).

**Body** — `discoverRequestSchema` ([`discover/route.ts:12-27`](../../../src/app/api/compare/discover/route.ts)): `existingTutorGroupIds` (array, **max 2**, may be empty), `mode`, and optional `dayOfWeek` / `date` / `startTime` / `endTime` (`HH:mm`) / `modeFilter` / `filters`.

**Response `200`** — `DiscoverResponse` ([`types.ts:203-207`](../../../src/lib/search/types.ts)): `{ snapshotMeta, candidates, latencyMs }` — no `warnings` field. Each candidate ([`types.ts:191-201`](../../../src/lib/search/types.ts)) carries `tutorGroupId`, `displayName`, `supportedModes`, `qualifications`, `conflictCount`, `conflicts`, `freeSlots`, `hasDataIssues`, `dataIssueReasons`.

**Scoring.** A candidate is marked free for the requested window only when all three of `hasAvailabilityWindow`, `!hasBlockingSession` and `!hasLeaveConflict` hold, and only when weekday, start and end were all supplied ([`discover/route.ts:97-125`](../../../src/app/api/compare/discover/route.ts)) — fail-closed by omission. `hasDataIssues` is true when the group has any data issue **or** an unresolved modality (`supportedModes.length === 0`), and that second case appends the reason `"Unresolved modality"` ([`:134-138`](../../../src/app/api/compare/discover/route.ts)).

**Ordering** ([`:153-157`](../../../src/app/api/compare/discover/route.ts)): candidates with data issues sort last; then ascending `conflictCount`; then descending free-slot count.

**Status codes:** 200 · 400 invalid JSON · 400 Zod failure · 401 · 500.

---

## Tutors and filters

Two cached read endpoints over the active snapshot. Both are thin wrappers: `auth()`, then one call into the `src/lib/data/*` layer, then the payload.

| Method | Path | Response | Handler |
|---|---|---|---|
| GET | `/api/tutors` | `{ "tutors": TutorListItem[] }` | [`tutors/route.ts:5-18`](../../../src/app/api/tutors/route.ts) |
| GET | `/api/filters` | `FilterOptions` (unwrapped) | [`filters/route.ts:5-17`](../../../src/app/api/filters/route.ts) |

### `GET /api/tutors`

`getTutorList()` returns `{ tutorGroupId, displayName, supportedModes, subjects }` per tutor ([`data/tutors.ts:7-12`](../../../src/lib/data/tutors.ts)), sorted by `displayName` with each tutor's subjects sorted and de-duplicated ([`:44-52`](../../../src/lib/data/tutors.ts)). `supportedModesFromModality` maps `both → ["online","onsite"]` and `unresolved → []` ([`:25-29`](../../../src/lib/data/tutors.ts)) — an unresolved tutor advertises **no** mode rather than a guessed one.

### `GET /api/filters`

`getFilterOptions()` returns `{ subjects, curriculums, levels }`, each a sorted de-duplicated list built from the snapshot's qualification rows ([`data/filters.ts:19-35`](../../../src/lib/data/filters.ts)). The body is the object itself, with no wrapper key.

**Caching, shared by both.** Each helper is a `"use cache"` server function tagged `cacheTag("snapshot")` with `cacheLife("hours")` ([`tutors.ts:80-86`](../../../src/lib/data/tutors.ts), [`filters.ts:52-58`](../../../src/lib/data/filters.ts)), so a successful sync's `revalidateTag("snapshot")` is what invalidates them. Both resolve the active snapshot through `getActiveSnapshotIdOrThrow`, so a database with no active snapshot surfaces as a **500**, not an empty list.

**Status codes (both):** 200 · 401 · 500 `{"error": …}`.

---

## Home summary

| Method | Path | Auth |
|---|---|---|
| GET | `/api/home/summary` | session **with `user.email`** |

Feeds the landing hub and the seven nav count badges. The handler passes the caller's `allowedPages` and `email` into `getHomeSummaryPayload` ([`route.ts:13-16`](../../../src/app/api/home/summary/route.ts)), so a restricted user's summary contains only their own tools.

**Response `200`** — `HomeSummaryPayload` ([`summary.ts:53-57`](../../../src/lib/home/summary.ts)): `{ generatedAt, actions, freshness }`.

- `actions` is one `HomeActionSummary` ([`summary.ts:17-26`](../../../src/lib/home/summary.ts)) per accessible badge — `{ id, toolId, label, href, value, detail, status, error }`. The seven `NavBadgeKey` values are `leaveRequests`, `lineReviews`, `progressTests`, `creditControl`, `payroll`, `wiseReconciliation`, `dataHealth` ([`navigation/tools.ts:33-40`](../../../src/lib/navigation/tools.ts)); a badge the caller cannot reach is skipped entirely rather than returned with a null value ([`summary.ts:193-252`](../../../src/lib/home/summary.ts)).
- `freshness` ([`summary.ts:28-51`](../../../src/lib/home/summary.ts)) mirrors the Data Health roll-up — `overallStatus`, `overallHeadline`, `staleAgeMs`/`staleMinutes`, `wiseSnapshotLastSuccess`, the six `cronCounts`, and a `googleSheets` connection block. When Data Health itself is unreachable the whole object degrades to `freshnessError(...)` rather than failing the request ([`summary.ts:279`](../../../src/lib/home/summary.ts)).

**Degradation is the point.** All eight sources load in parallel through `loadSource`, which converts a thrown error into `{ data: null, error }` ([`summary.ts:64-73`](../../../src/lib/home/summary.ts)); `actionItem` then blanks that card's `value`, sets `detail` to `"Summary unavailable"` and `status` to `"error"` ([`summary.ts:82-99`](../../../src/lib/home/summary.ts)). One broken subsystem degrades its own card, never the page. A 500 from this route therefore means the payload assembly itself failed, not that a feature is down.

**Status codes:** 200 · 401 (no `session.user.email`) · 500 `{"error": …}`.

This path is the one blanket exemption from `allowedPages` filtering in middleware ([`middleware.ts:38`](../../../src/middleware.ts)).

---

## Admin

| Method | Path | Auth |
|---|---|---|
| POST | `/api/admin/sync-wise` | session |

The session-authenticated twin of the `CRON_SECRET`-guarded `GET/POST /api/internal/sync-wise` ([internal-crons.md](./internal-crons.md)). Both call the same `runWiseSyncRequest()`. `export const maxDuration = 800` gives it Pro-plan headroom ([`route.ts:6`](../../../src/app/api/admin/sync-wise/route.ts)).

**Body:** none — the handler takes no arguments and reads nothing from the request.

**Execution:** wrapped in `withCronInvocationAudit({ jobKey: "wise_snapshot", triggerSource: "admin", actorEmail, requestMethod: "POST" }, () => runWiseSyncRequest())` ([`route.ts:15-23`](../../../src/app/api/admin/sync-wise/route.ts)). The wrapper inserts a `running` `cron_invocations` row before the handler and updates it afterwards with duration, response status, a size-capped response digest and a derived `outcome` ([`cron-audit.ts:131-206`](../../../src/lib/data-health/cron-audit.ts)); a `202`, a `skipped: true` body, or a message containing "already running" is recorded as `skipped` rather than `success` ([`cron-audit.ts:108-117`](../../../src/lib/data-health/cron-audit.ts)). Audit-write failures are logged and swallowed — they never fail the sync. The `wise_snapshot` registry entry supplies the recorded path and schedule (`/api/internal/sync-wise`, `*/30 * * * *`), so a manual admin run is attributed to the same job as the cron ([`cron-registry.ts:49-62`](../../../src/lib/data-health/cron-registry.ts)).

**Response and status codes** — produced by `runWiseSyncRequest` ([`run-wise-sync.ts:142-167`](../../../src/lib/sync/run-wise-sync.ts)):

| Code | Body |
|---|---|
| 200 | The full `runFullSync` result plus `staleRunningSyncsFailed`, after `revalidateTag("snapshot", { expire: 0 })`. |
| 202 | The single-flight skip payload — `{ success: true, skipped: true, alreadyRunning: true, syncRunId, runningStartedAt, message: "Wise sync is already running. Data will refresh when that run finishes.", … }` ([`run-wise-sync.ts:120-140`](../../../src/lib/sync/run-wise-sync.ts)). The caller in `sync-flow.ts` depends on this exact shape: it reads `runningStartedAt` and polls for a fresh snapshot instead of erroring. |
| 401 | No session ([`route.ts:11-13`](../../../src/app/api/admin/sync-wise/route.ts)). |
| 500 | The same result body when `result.success` is false — the previously active snapshot is preserved, and the cache tag is **not** swept. |
| 500 | `{"error": <message>}` if the handler throws outright; the audit wrapper converts the throw into a response rather than letting it escape ([`cron-audit.ts:200-205`](../../../src/lib/data-health/cron-audit.ts)). |

Before claiming the guard, `acquireSyncRun` reaps any `running` sync run older than `STALE_RUNNING_SYNC_MS` (20 minutes) and reports how many it failed as `staleRunningSyncsFailed` ([`run-wise-sync.ts:10,55-61`](../../../src/lib/sync/run-wise-sync.ts)).

---

## Auth

| Method | Path | Auth |
|---|---|---|
| GET | `/api/auth/[...nextauth]` | public |
| POST | `/api/auth/[...nextauth]` | public |

[`src/app/api/auth/[...nextauth]/route.ts`](../../../src/app/api/auth/[...nextauth]/route.ts) is three lines: `export const { GET, POST } = handlers`, re-exported from [`@/lib/auth`](../../../src/lib/auth.ts). Auth.js v5 owns every sub-path under the catch-all — sign-in, OAuth callback, session, CSRF, sign-out — so there is no per-path request schema to document here. The prefix is allowlisted in middleware ([`middleware.ts:13`](../../../src/middleware.ts)).

What the repo *does* own is the configuration ([`auth.ts:32-73`](../../../src/lib/auth.ts)):

- **One provider — Google**, requesting `openid email profile` plus `spreadsheets` and `drive.file`, with `access_type: "offline"` so a refresh token is issued ([`auth.ts:34-43`](../../../src/lib/auth.ts)). The Sheets/Drive scopes are what let sales-dashboard and leave-request features act as the signed-in user.
- **Sign-in is fail-closed.** `signInCallback` first activates any invited/bounced admissions memberships for that exact email — failures are logged and never block an existing user — then calls `resolveUserAccess`, and returns `false` (denying sign-in) when it resolves to `null` ([`auth.ts:5-30`](../../../src/lib/auth.ts)). `resolveUserAccess` grants `admin` from `admin_users` (`allowedPages` carried through), else `counselor`, `teacher`, or `student`/`parent` with a single-page `allowedPages`, else `null` ([`auth-access.ts:56-85`](../../../src/lib/auth-access.ts)).
- **On a successful sign-in** the Google OAuth token is persisted for that email ([`auth.ts:52-55`](../../../src/lib/auth.ts)) — the one write this surface performs.
- **`role` and `allowedPages` are resolved once**, at sign-in, and persisted on the JWT so later requests need no database round-trip ([`auth.ts:58-67`](../../../src/lib/auth.ts)); the session callback copies both onto `session.user` ([`auth.ts:68-72`](../../../src/lib/auth.ts)). A consequence worth knowing: revoking a user's access does not take effect until their token is reissued — which is exactly why Post-Class Feedback and Learning Plans re-resolve capabilities from Postgres per request instead of trusting `allowedPages`.
- Both `signIn` and `error` pages point at `/login` ([`auth.ts:45-48`](../../../src/lib/auth.ts)).

The edge-side variant used by middleware is [`src/lib/auth-edge.ts`](../../../src/lib/auth-edge.ts); it shares the JWT but not the database callbacks.

---

## Tests

Nine of the ten route files have a route test under a sibling `__tests__/` directory; the Auth.js catch-all has none (it declares no logic of its own — the sign-in callback is covered separately).

| Route test | Cases |
|---|---:|
| [`search/__tests__/route.test.ts`](../../../src/app/api/search/__tests__/route.test.ts) | 4 |
| [`search/range/__tests__/route.test.ts`](../../../src/app/api/search/range/__tests__/route.test.ts) | 6 |
| [`search/assistant/__tests__/route.test.ts`](../../../src/app/api/search/assistant/__tests__/route.test.ts) | 4 |
| [`compare/__tests__/route.test.ts`](../../../src/app/api/compare/__tests__/route.test.ts) | 6 |
| [`compare/discover/__tests__/route.test.ts`](../../../src/app/api/compare/discover/__tests__/route.test.ts) | 9 |
| [`tutors/__tests__/route.test.ts`](../../../src/app/api/tutors/__tests__/route.test.ts) | 3 |
| [`filters/__tests__/route.test.ts`](../../../src/app/api/filters/__tests__/route.test.ts) | 3 |
| [`home/summary/__tests__/route.test.ts`](../../../src/app/api/home/summary/__tests__/route.test.ts) | 3 |
| [`admin/sync-wise/__tests__/route.test.ts`](../../../src/app/api/admin/sync-wise/__tests__/route.test.ts) | 4 |

The engines behind them carry their own unit suites under `src/lib/search/__tests__/` (engine, compare, parser, recommend), and `src/__tests__/middleware.test.ts` covers the allowlist and `allowedPages` matching described above.

_Verified against main@0cd1e81 (clean tree) on 2026-09-02._
