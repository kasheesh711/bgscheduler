# Data Flow (ETL)

**Status: stable**

## Purpose

This document traces the **Wise snapshot sync** — the single ETL pipeline that turns the live Wise scheduling platform into the normalized, versioned, in-memory data that every tutor search and compare query reads. It is the spine of the application's source-of-truth rule: production truth comes from the Wise API only, is fetched on a schedule, normalized through seven domain modules, written into a fresh immutable snapshot, validated, and atomically promoted. Search and compare never call Wise on the request path — they read a process-global index built from whichever snapshot is currently `active`.

The pipeline has one entry point, `runFullSync()` in `src/lib/sync/orchestrator.ts:50`. It is triggered by a Vercel cron every 30 minutes (`vercel.json:4-5`: path `/api/internal/sync-wise`, schedule `*/30 * * * *`) and can also be triggered manually (admin session or `curl` with the cron secret). A single-flight guard ensures only one sync runs at a time.

> **Scope note.** This is the *tutor-availability* snapshot sync only. The other staggered crons in `vercel.json` (Wise Activity audit, Sales Dashboard, Credit Control, Leave Requests, class-assignment automation, student promotions) are separate pipelines with their own sync lineages and tables — see [`docs/reference/crons.md`](../reference/crons.md). They share the `WiseClient` transport but not the snapshot / promotion / in-memory-index machinery described here.

For the meaning of individual snapshot tables (purpose, business rules), see the feature docs ([tutor-search](../features/tutor-search.md), [tutor-compare](../features/tutor-compare.md), [data-health](../features/data-health.md)). For column-level detail (types, defaults, indexes, FK targets) see the [database reference](../reference/database/index.md) and its [core ERD](../reference/database/erd-core.md). For the Wise endpoints and transport contract see the [Wise API reference](../reference/wise-api.md). This document owns the *flow* — the ordered choreography across those layers and the invariants that hold each stage together.

## The layered model

The architecture rule is that lower layers know nothing of upper layers. The sync is the one place that touches every layer top to bottom in a single function:

```
Wise client        src/lib/wise/        retry/backoff + concurrency limiter; no internal imports
  ↓
Normalization      src/lib/normalization/   identity, availability, leaves, sessions,
                                            qualifications, modality, timezone — depend only on Wise types
  ↓
Orchestrator       src/lib/sync/        runFullSync() + diff-hook + pruning
  ↓
Database           src/lib/db/          Neon-http singleton, snapshot-scoped writes, atomic promote
  ↓
In-memory index    src/lib/search/index.ts   SearchIndex singleton, lazily (re)built from the active snapshot
```

The orchestrator never imports a route, auth, or React. The route handler (`src/app/api/internal/sync-wise/route.ts`) is a thin auth gate; the runnable logic lives in `src/lib/sync/run-wise-sync.ts` and `orchestrator.ts` so it is unit-testable without the Next/auth graph.

## The stage map

End to end, with the orchestrator's own source-comment numbering (`// 1.` … `// 12.`) preserved so the prose lines up with the code:

```
Trigger (cron GET / manual POST) → /api/internal/sync-wise
  └─ run-wise-sync.ts: failStaleRunningSyncs → single-flight guard → acquire syncRunId
       └─ orchestrator.ts: runFullSync()
            1.  Create sync_run row (status=running) — unless caller supplied syncRunId
            2.  Create candidate snapshot (active=false), link it onto the sync_run
            3.  Fetch all teachers ........................... Wise GET /teachers
            4.  Load tutor_aliases (DB read)
            5.  Resolve identities .......................... normalization/identity
            6.  Persist identity groups + members (DB write)
            7.  Per teacher: fetch availability + leaves .... Wise GET /availability ×26 windows
                  → normalize workingHours, leaves, raw tags, qualifications
            8.  Fetch all FUTURE sessions ................... Wise GET /sessions (paged)
                  → normalize into session blocks
            9.  Derive modality per group ................... normalization/modality
                  → build tutor rows; MOD-01 per-session contradiction pass
            9.5 PAST-01 diff-hook: capture dropped past sessions (DB write) — BEFORE promote
            10. Stamp window modality, then batch-insert
                  windows / leaves / tags / quals / sessions / tutors (DB write, parallel)
                  → insert data_issues
            11. Compute + insert snapshot_stats (DB write)
            12. Validate (unresolved ratio < 0.5) → atomic promote (single UPDATE)
                  → mark sync_run success; prune old snapshots
       └─ run-wise-sync.ts: revalidateTag("snapshot") on success
  ... later, on the first read after promotion ...
  └─ ensureIndex(): staleness check (snapshotId / profileVersion) → buildIndex() rebuilds SearchIndex
```

Two ordering subtleties worth flagging up front, both explained in their sections below:

- **Step 9.5 runs before step 12.** The past-session diff-hook reads the *prior* active snapshot, so it must run while that snapshot is still `active=true` — i.e. before the promote in step 12 flips the flag (`past-sessions-diff-hook.ts:11-13`, `orchestrator.ts:400-407`).
- **The index rebuild is not part of the sync.** `runFullSync()` writes the snapshot and returns; it never builds the index. The successful HTTP wrapper only calls `revalidateTag("snapshot")` (`run-wise-sync.ts:160-162`). The in-memory `SearchIndex` is rebuilt lazily by the *next read-path caller* via `ensureIndex()`, which detects the snapshot change and rebuilds (`src/lib/search/index.ts:354-401`).

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    participant Cron as Vercel Cron / curl
    participant Route as /api/internal/sync-wise
    participant Runner as run-wise-sync.ts
    participant Orch as orchestrator.runFullSync
    participant Wise as Wise API (WiseClient)
    participant DB as Neon Postgres
    participant Idx as SearchIndex (globalThis)

    Cron->>Route: GET (cron) / POST (manual)
    Route->>Route: hasValidCronSecret() — constant-time, REL-07
    alt secret valid OR (POST and Auth.js session)
        Route->>Runner: runWiseSyncRequest()
    else neither
        Route-->>Cron: 401 Unauthorized
    end

    Runner->>DB: failStaleRunningSyncs() (>20min running → failed)
    Runner->>DB: findRunningSyncRun()
    alt a sync is already running
        Runner-->>Cron: 202 { skipped, alreadyRunning }
    else acquire guard
        Runner->>DB: INSERT sync_runs(status=running) → syncRunId
        Runner->>Orch: runFullSync(db, client, instituteId, { syncRunId })

        Orch->>DB: INSERT snapshots(active=false) → snapshotId
        Orch->>DB: UPDATE sync_runs SET snapshotId
        Orch->>Wise: GET /institutes/{id}/teachers
        Wise-->>Orch: WiseTeacher[]
        Orch->>DB: SELECT tutor_aliases
        Orch->>Orch: resolveIdentities(teachers, aliases) → groups + identityIssues
        Orch->>DB: INSERT tutor_identity_groups (per group) + members (chunked)

        loop per teacher
            Orch->>Wise: GET /availability ×26 windows (workingHours + 180d leaves)
            Wise-->>Orch: { workingHours, leaves }
            Orch->>Orch: normalizeWorkingHours / normalizeLeaves / normalizeTeacherTags
        end

        Orch->>Wise: GET /sessions?status=FUTURE (paged, page_size 1000)
        Wise-->>Orch: WiseSession[]
        Orch->>Orch: normalizeSessions(...) → session blocks
        Orch->>DB: UPDATE tutor_identity_groups SET supportedModality (per group)
        Orch->>Orch: deriveModality + MOD-01 contradiction pass → data_issues

        Orch->>DB: PAST-01 diff-hook: read prior active snapshot,<br/>INSERT past_session_blocks ON CONFLICT DO NOTHING
        Orch->>DB: batch INSERT windows/leaves/tags/quals/sessions/tutors (parallel)
        Orch->>DB: INSERT data_issues + snapshot_stats

        alt unresolvedRatio < 0.5
            Orch->>DB: UPDATE snapshots SET active = (id = snapshotId) — single atomic UPDATE
            Orch->>DB: UPDATE sync_runs SET status=success, promotedSnapshotId
            Orch->>DB: pruneOldSnapshots() — keep newest 30 + active
        else ≥50% unresolved
            Note over Orch,DB: no promote; prior snapshot stays active
            Orch->>DB: UPDATE sync_runs SET status=success (promotedSnapshotId=null)
        end

        Orch-->>Runner: SyncResult
        alt result.success
            Runner->>Idx: revalidateTag("snapshot")
        end
        Runner-->>Cron: 200 (success) / 500 (failed)
    end

    Note over Idx: index NOT rebuilt here
    rect rgb(245,245,245)
        participant Reader as next read (search/compare/…)
        Reader->>Idx: ensureIndex(db)
        Idx->>DB: SELECT active snapshot id + profile version
        alt snapshotId or profileVersion changed
            Idx->>DB: buildIndex() — load all snapshot tables
            Idx->>Idx: rebuild SearchIndex singleton
        else unchanged
            Idx-->>Reader: cached index
        end
    end
```

## Stage-by-stage

### Trigger and authentication

`/api/internal/sync-wise/route.ts` exposes both `GET` (Vercel cron) and `POST` (manual admin or `curl`). The handler:

1. Checks `CRON_SECRET` with `hasValidCronSecret()` — a **constant-time** comparison using `timingSafeEqual` after a length pre-check (`route.ts:11-29`, design ID REL-07). The length pre-check both avoids the `RangeError` that `timingSafeEqual` throws on length-mismatched buffers and is itself O(1), so the secret length does not leak through timing.
2. If the secret is valid → run, tagged `triggerSource: "cron"`.
3. Else, for `POST` only (`allowSessionAuth: true`), it falls back to an Auth.js session (`route.ts:45-59`); a valid session runs tagged `triggerSource: "admin"`. `GET` does not allow session auth (`route.ts:69-71`).
4. A missing `CRON_SECRET` env returns `500 Server misconfigured`; otherwise `401 Unauthorized` (`route.ts:61-65`).

Either authenticated path wraps the run in `withCronInvocationAudit(...)` (recording the invocation) and delegates to `runWiseSyncRequest()`. The route carries `export const maxDuration = 800` (`route.ts:7`) — Vercel Pro headroom for a full sync.

### Single-flight guard

`runWiseSyncRequest()` (`run-wise-sync.ts:142-167`) is the concurrency gate. Before doing any work it:

1. **Fails stale `running` rows.** `failStaleRunningSyncs()` flips any `sync_runs` row that has been `running` longer than `STALE_RUNNING_SYNC_MS` (20 minutes, `run-wise-sync.ts:10`) to `failed` with an explanatory `errorSummary` (`run-wise-sync.ts:51-72`). This self-heals after a crashed or aborted sync left a guard row behind.
2. **Checks for a live run.** `findRunningSyncRun()` returns the newest `running` row, if any (`run-wise-sync.ts:74-86`). If one exists, the request short-circuits and returns **HTTP 202** with `{ skipped: true, alreadyRunning: true }` (`run-wise-sync.ts:120-140`, `148-150`) — "data will refresh when that run finishes."
3. **Acquires the guard.** Otherwise it inserts a fresh `sync_runs` row with `status: "running"` and passes its id into `runFullSync({ syncRunId })` (`run-wise-sync.ts:99-105`, `152-154`). A concurrent insert that loses the race (unique-violation, Postgres `23505`) is caught and downgraded to the same skipped result (`run-wise-sync.ts:42-49`, `106-117`) — the partial-unique index on `sync_runs` permits at most one `running` row.

Because the guard row is created here, `runFullSync()` is told to *adopt* it rather than create its own (step 1 below).

The instituteId comes from `process.env.WISE_INSTITUTE_ID` and defaults to `696e1f4d90102225641cc413` (`run-wise-sync.ts:145`). The client is built by `createWiseClient()`.

### The Wise client (transport)

`createWiseClient()` (`client.ts:159-166`) constructs a `WiseClient` with `maxConcurrency: 15` — deliberately higher than the constructor default of `5` (`client.ts:48`) because a full sync issues hundreds of availability requests and benefits from more in-flight parallelism. Auth headers are Basic Auth (base64 `userId:apiKey`) plus `x-api-key`, `x-wise-namespace`, and a `user-agent` of `VendorIntegrations/{namespace}` (`client.ts:52-61`).

Two transport invariants matter to the sync:

- **Concurrency limiter.** A simple in-process queue caps concurrent fetches at `maxConcurrency`; each completion drains the next queued request (`client.ts:136-156`). This is what keeps the sync from stampeding the Wise API even when `fetchTeacherFullAvailability` fans out 26 requests per teacher.
- **Retry / backoff with fail-fast on permanent errors.** `fetchWithRetry` retries network-level failures and only the status codes in `RETRYABLE_STATUS_CODES` — `408, 429, 500, 502, 503, 504` (`client.ts:23-30`, REL-05). Backoff is `2^attempt × 1000ms` (1s / 2s / 4s) up to `maxRetries` (default 3) (`client.ts:107-111`, `128-133`). Permanent 4xx (401/403/404/422 and any other non-retryable status) throw immediately with the body and URL (`client.ts:121-124`) so no retry budget is wasted on errors that will not fix themselves.

A thrown Wise error propagates up to `runFullSync`'s top-level try/catch and fails the whole sync (see [Error handling](#error-handling-three-layers)). Per-teacher availability errors are the exception — they are isolated (step 7).

### 1–2. Create / adopt the sync run, create the candidate snapshot

`runFullSync` (`orchestrator.ts:50-60`) records `startTime` and:

1. If no `syncRunId` was supplied, it inserts one with `status: "running"` (`orchestrator.ts:61-68`). In production the runner already supplied one, so this branch is the manual/test path.
2. Inserts a new `snapshots` row with `active: false` — the **candidate** (`orchestrator.ts:70-75`) — and back-links it onto the sync run via `UPDATE sync_runs SET snapshotId` (`orchestrator.ts:77-81`).

Every subsequent write is scoped to this `snapshotId`. The candidate stays invisible to readers (which only read `active = true`) until the atomic promote in step 12. A sync that fails anywhere before promotion simply leaves an orphan inactive snapshot; the previously-active one is untouched.

### 3–4. Fetch teachers, load aliases

`fetchAllTeachers(client, instituteId)` issues a single `GET /institutes/{id}/teachers` and returns `data.teachers ?? []` (`fetchers.ts:29-35`). Then `tutor_aliases` is read in full and mapped to `{ fromKey, toKey }` pairs (`orchestrator.ts:86-91`). `tutor_aliases` is one of the snapshot-independent tables — it survives snapshot rotation and feeds identity resolution.

### 5–6. Identity resolution

`resolveIdentities(wiseTeachers, aliases)` (`identity.ts:72-207`) merges Wise's per-teacher records into logical tutors. The cascade:

1. **Nickname extraction.** The parenthetical in a display name is the nickname — `"Chinnakrit (Celeste) Channiti"` → `"Celeste"` (`extractNickname`, `identity.ts:43-46`).
2. **Alias override.** If the nickname matches an entry in `tutor_aliases` (case-insensitive), the canonical key becomes the alias target; otherwise it is the nickname itself (`identity.ts:96-100`).
3. **Online/offline pairing.** Records are grouped by lower-cased canonical key (`identity.ts:110-121`). `isOnlineVariant()` flags names ending in "Online" (`identity.ts:52-54`); the non-online entry supplies the group display name (`identity.ts:127-133`).
4. **Collision detection (REL-03).** A key that matches more than two records, or two that are not a clean 1-online + 1-offline pair, emits a high-severity `alias`-type issue but is **still kept** so admins can disambiguate it in Needs Review (`identity.ts:148-170`).
5. **Unresolved fallback.** A teacher with no nickname and no alias match gets its own `alias` issue *and* a solo group, again so it surfaces in Needs Review rather than vanishing (`identity.ts:177-204`).

The result is `{ groups, issues }`. Identity issues are mapped into the running `allIssues` array as `type: "alias", severity: "critical"` (`orchestrator.ts:97-105`). Critically, the **unresolved ratio computed from these issues is the promotion gate** (step 12) — identity is the one failure that can block a snapshot from going live.

Persistence (step 6): each group is inserted into `tutor_identity_groups` with `supportedModality: "unresolved"` (set properly later in step 9), and its db id is recorded in `groupIdMap` keyed by canonical key (`orchestrator.ts:108-122`). Members are queued and inserted into `tutor_identity_group_members` in chunks of 250 via `insertInChunks` (`orchestrator.ts:38-48`, `124-139`). A `teacherToGroupId` map is then built so per-teacher rows in later stages can resolve their group id from memory without a SELECT (`orchestrator.ts:141-148`).

### 7. Per-teacher availability, leaves, tags, qualifications

For each teacher with a resolvable group and a Wise user id, the orchestrator fetches and normalizes that teacher's schedule data (`orchestrator.ts:156-260`). A teacher missing a Wise user id is skipped with a `completeness` / `high` issue (`orchestrator.ts:162-173`).

**Fetch.** `fetchTeacherFullAvailability(client, instituteId, teacherUserId)` (`fetchers.ts:61-103`) stitches a 180-day horizon:

- The **first** 7-day window (now → now+7) returns both `workingHours` (the recurring pattern) and the first batch of leaves (`fetchers.ts:74-83`).
- The remaining 25 windows (`ceil(180/7) = 26` total) are fetched **in parallel** for leaves only and concatenated (`fetchers.ts:85-100`). The concurrency limiter throttles the actual network parallelism.

Each window is a `GET /institutes/{id}/teachers/{userId}/availability?startTime=…&endTime=…` (`fetchers.ts:40-55`).

**Normalize.**

- `normalizeWorkingHours(workingHours?.slots)` (`availability.ts:33-57`): maps each slot's day (name or `0–6`) to a weekday and parses `HH:mm` start/end to minutes-since-midnight. Working hours are already Asia/Bangkok local time, so **no UTC conversion is applied** (`availability.ts:28-32`). Zero-length or inverted windows are dropped (`availability.ts:47`), and windows are then de-duplicated and overlap-merged per weekday (`deduplicateWindows`, `availability.ts:62-92`). Rows are queued with `modality: "unresolved"` — a placeholder stamped with the real value just before insert (`orchestrator.ts:182-194`, `420-422`).
- `normalizeLeaves(leaves)` (`leaves.ts:14-24`): converts each leave's UTC start/end to Asia/Bangkok via `toLocalTime` and overlap-merges adjacent intervals (`deduplicateLeaves`, `leaves.ts:29-54`). Queued into `dated_leaves` (`orchestrator.ts:197-206`).
- Raw tags are recorded verbatim into `raw_teacher_tags` (`orchestrator.ts:209-218`), and `normalizeTeacherTags(tags, …)` (`qualifications.ts:71-98`) parses each tag of the form `Subject (Curriculum) Level` via a single regex (`qualifications.ts:31`), mapping curriculum aliases (`int.`→International, `th`→Thai, `examprep`→ExamPrep, etc., `qualifications.ts:33-41`). Parsed rows queue into `subject_level_qualifications`; unmapped tags emit `tag` / `high` issues (`qualifications.ts:86-94`, `orchestrator.ts:226-248`).

**Error isolation.** The entire per-teacher body is wrapped in try/catch; any failure (a Wise error on that teacher's availability, a parse error) records a `completeness` / `high` issue and **continues to the next teacher** (`orchestrator.ts:249-259`). One teacher's bad data never aborts the sync. This is the "fail-isolated inside sync" rule.

Timezone note: every Wise→local conversion in the pipeline goes through `src/lib/normalization/timezone.ts`, which is hard-wired to `Asia/Bangkok` (`timezone.ts:3`) using `date-fns-tz`'s `toZonedTime` (`timezone.ts:8-11`). `getLocalWeekday` and `getLocalMinuteOfDay` derive the indexed weekday and minute-of-day used by the search grid (`timezone.ts:16-26`).

### 8. Future sessions

`fetchAllFutureSessions(client, instituteId)` delegates to `fetchAllInstituteSessions` with `status: "FUTURE"` (`fetchers.ts:108-113`), paging `GET /institutes/{id}/sessions` at `page_size = 1000` until `page_count` is reached or an empty page is returned (`fetchers.ts:115-145`). Because Wise's FUTURE API does not return past sessions, this fetch is also the input to the PAST-01 diff-hook (step 9.5).

`normalizeSessions(wiseSessions, resolver)` (`sessions.ts:57-94`) converts each session to a block. The `resolver` callback maps a session's Wise user id back to a teacher id via the `wiseUserIdToTeacherId` map built in the orchestrator from `getWiseSessionTeacherUserId` ↔ `getWiseTeacherUserId` (`orchestrator.ts:263-275`; accessors at `wise/types.ts:264-276`); sessions whose teacher cannot be resolved are dropped (`sessions.ts:64-65`). Each block carries Asia/Bangkok start/end plus the derived `weekday` / `startMinute` / `endMinute` (`sessions.ts:67-79`), denormalized class metadata (title, type, location, student name/count, subject, classType, `recurrenceId`), and a **blocking** flag.

**Blocking classification is fail-closed.** `isBlockingStatus(status)` (`sessions.ts:46-51`) returns `false` only for the explicit non-blocking set `CANCELLED, CANCELED, COMPLETED, MISSED, NO_SHOW` (`sessions.ts:33-40`). A missing status, or any status not in that set, is treated as **blocking** (`sessions.ts:47`, `50`). This realizes the non-negotiable rule "unknown session status → blocking; cancelled sessions must not block."

Resolved blocks queue into `future_session_blocks`, again resolving the group id from `teacherToGroupId` in memory (`orchestrator.ts:277-305`).

### 9. Modality derivation, tutor rows, and the MOD-01 contradiction pass

For each group, `deriveModality(group, groupSessions)` (`modality.ts:23-92`) decides the supported modality with strict precedence, **never guessing**:

1. **Structural.** Online + offline members → `both`; online-only → `online` (`modality.ts:27-36`).
2. **Session-type / location evidence.** Online vs onsite signals from session `type`/`location`; both present → `both`, otherwise the single signal (`modality.ts:38-63`).
3. **Single offline record, no evidence → `unresolved`** with a modality issue — explicitly fail-closed rather than assuming onsite (`modality.ts:65-79`).
4. **Otherwise `unresolved`** with an issue (`modality.ts:81-91`).

The result drives three writes per group (`orchestrator.ts:315-362`):

- `UPDATE tutor_identity_groups SET supportedModality` (`orchestrator.ts:326-329`).
- A per-teacher entry in `teacherModalities` so each availability window is stamped with the correct value before insert — online-variant members get `online`; for a `both` group the offline member is stamped `onsite` (`orchestrator.ts:331-337`, applied at `420-422`).
- A `tutors` display row whose `supportedModes` is `["online","onsite"]` for `both`, the single mode otherwise, and `[]` for `unresolved` (`orchestrator.ts:351-361`).

Any modality issue is appended to `allIssues` as `modality` / `high` (`orchestrator.ts:339-349`).

The derived modality per group is also cached in `groupSupportedModality` (`orchestrator.ts:308-324`) so the **MOD-01 contradiction pass** that follows (`orchestrator.ts:364-398`, design IDs D-07/D-08) needs no per-session SELECT. For every session in a group it calls `detectSessionModalityConflict(...)` (`compare.ts:185-223`), which flags cases where the teacher record's `isOnlineVariant` disagrees with the session's `sessionType` (e.g. a `both` group's online record carrying an onsite session). Each contradiction emits a `conflict_model` / `high` issue with `metadata` (`orchestrator.ts:381-397`). Like the availability loop, this pass is read-only over in-memory data and emits issues without aborting.

> **Known limitation (carried, not solved here).** Online/onsite detection from `location` strings is unreliable — most venues are named (`"Tesla"`, `"Nerd"`) and match no online pattern, so many sessions read as onsite. The visual modality distinction on compare cards was removed pending a more reliable signal. The fail-closed `unresolved` routing above is what keeps this from ever producing a false "Available."

### 9.5. PAST-01 diff-hook (runs before promotion)

`runPastSessionsDiffHook(db, sessionBlocks, snapshotId)` (`past-sessions-diff-hook.ts:66-172`) captures sessions that have **dropped out of Wise's FUTURE response and already started**, persisting them to the cross-snapshot `past_session_blocks` table so the compare view can still show recent history Wise no longer returns.

It must run **before** the step-12 promote, because it reads the *prior* active snapshot — which is only still `active=true` until the promote flips it (`past-sessions-diff-hook.ts:11-13`, `orchestrator.ts:400-407`). Mechanics:

1. Find the prior active snapshot (active and `id != newSnapshotId`); if none (first-ever sync), return empty (`past-sessions-diff-hook.ts:74-89`).
2. Read the prior snapshot's `future_session_blocks` and its group→canonicalKey map in batch queries (`past-sessions-diff-hook.ts:91-107`).
3. A prior block is "dropped" iff its `wiseSessionId` is absent from the newly-fetched set **and** its `startTime < now` (`past-sessions-diff-hook.ts:109-132`). A block whose group canonical key can't be resolved is skipped with a `completeness` / `medium` issue (`past-sessions-diff-hook.ts:121-132`).
4. Insert in chunks of 250 with `onConflictDoNothing({ target: wiseSessionId })` (`past-sessions-diff-hook.ts:155-165`, design IDs D-03 / PAST-05).

Idempotency is structural: the Neon HTTP driver has **no transaction support**, so a crashed sync that partially inserted these rows can safely re-run on the next cron tick — the `UNIQUE(wise_session_id)` + `ON CONFLICT DO NOTHING` guarantees exactly one row per session (`past-sessions-diff-hook.ts:55-61`). Per-group errors emit issues; the hook never throws (`orchestrator.ts:400-418`). Its `{ capturedCount, durationMs }` is later stamped into the sync run's `metadata` (`orchestrator.ts:503-506`).

### 10–11. Bulk insert and stats

With window modality now finalized (`orchestrator.ts:420-422`), the six bulk tables are inserted **in parallel** via `Promise.all`, each chunked at 250 rows: `recurring_availability_windows`, `dated_leaves`, `raw_teacher_tags`, `subject_level_qualifications`, `future_session_blocks`, `tutors` (`orchestrator.ts:424-443`). Then all accumulated `data_issues` are inserted (chunked) if any exist (`orchestrator.ts:445-450`).

Chunking at 250 is deliberate. The Neon-http driver has no transaction support and Postgres caps bound parameters per statement; 250-row chunks keep each insert under that limit (`orchestrator.ts:38`). These writes are not transactional — but they all target the **inactive candidate** snapshot, so a partial write is never visible to readers and is cleaned up by pruning on a later successful run.

`snapshot_stats` is then computed and written once (`orchestrator.ts:452-470`): totals for Wise teachers, identity groups, resolved vs unresolved groups, qualifications, availability windows, leaves, future sessions, and total data issues, plus an `issuesByType` histogram. This single roll-up row is what the Data Health page reads to summarize a snapshot.

### 12. Validate and atomic promote

The promotion gate is a single ratio (`orchestrator.ts:472-476`):

```
unresolvedRatio = identityIssues.length / max(groups.length, 1)
shouldPromote   = unresolvedRatio < 0.5
```

If **≥50% of identity groups are unresolved**, the candidate is **not** promoted and the prior active snapshot keeps serving traffic. Note the gate keys on *identity* issues specifically — modality/qualification/completeness issues do not block a promote (they surface as Needs Review instead).

When `shouldPromote`, promotion is a **single atomic `UPDATE`** (`orchestrator.ts:480-501`, design ID REL-01):

```sql
UPDATE snapshots
SET active = (snapshots.id = :snapshotId)
WHERE active = true OR snapshots.id = :snapshotId;
```

One statement sets the candidate's `active` to `true` and every previously-active row's `active` to `false`. Postgres MVCC plus the row-level lock held for the statement's duration guarantee that a concurrent reader sees either the old active row or the new one — **never a window with zero active snapshots**. The bounded `WHERE` touches only the prior-active row(s) and the candidate, avoiding a full-table rewrite. This replaced an earlier two-UPDATE sequence that briefly had no active snapshot.

The sync run is then marked `status: "success"` with `finishedAt`, `promotedSnapshotId` (null if not promoted), `teacherCount`, and the diff-hook metadata (`orchestrator.ts:508-518`).

Finally, **only if a snapshot was promoted**, `pruneOldSnapshots(db)` runs (`orchestrator.ts:520-548`). It keeps the newest `SNAPSHOT_RETENTION_COUNT = 30` snapshots plus whatever is currently active, and deletes everything older — fanning out cascading `DELETE`/`UPDATE` across every snapshot-scoped table and nullifying `sync_runs` references (`snapshot-pruning.ts:49-190`). Pruning is best-effort: a failure is caught, logged, and recorded in the sync run's `metadata.pruning` rather than failing the (already successful) sync (`orchestrator.ts:525-547`). `past_session_blocks` is deliberately **not** pruned here — it is cross-snapshot by design.

`runFullSync` returns a `SyncResult` (`orchestrator.ts:22-32`, `550-560`): `success`, `syncRunId`, `snapshotId`, `promotedSnapshotId`, counts, `errorSummary`, `durationMs`.

### Back in the runner: cache invalidation

If `result.success`, `runWiseSyncRequest()` calls `revalidateTag("snapshot", { expire: 0 })` (`run-wise-sync.ts:160-162`) and returns the `SyncResult` as JSON with status **200** (success) or **500** (failed) (`run-wise-sync.ts:164-166`). The `"snapshot"` cache tag is what the Server Components' cached `src/lib/data/*` helpers register under (`"use cache"` + `cacheTag`), so revalidation sweeps stale cached reads. Note this revalidates the *Next data cache*; it does **not** rebuild the in-memory `SearchIndex`.

## Index rebuild — lazy, on the read path

The in-memory `SearchIndex` is a `globalThis`-anchored singleton (`__bgscheduler_searchIndex`) that survives HMR (`src/lib/search/index.ts:92-126`). It is **never** built by the sync. Instead, the next read-path caller triggers it:

- `ensureIndex(db)` (`index.ts:354-401`) is called by every read that needs tutor data — search (`api/search/route.ts:54`, `range-search.ts:115`), compare (`api/compare/route.ts:138`, `api/compare/discover/route.ts:57`), proposals (`api/proposals/route.ts:64`), room capacity (`room-capacity/data.ts:409`), the AI scheduler (`ai/scheduler-service.ts:60`), and LINE operational planning (`line/operational.ts:527`).
- It **stale-detects** by comparing the cached index's `snapshotId` and `profileVersion` against the current active snapshot and the tutor-profile version string (`index.ts:365-387`). If either changed — which is exactly what a promote does to `snapshotId` — it calls `buildIndex(db)` (`index.ts:142-344`) to reload every snapshot table for the active snapshot into a fresh `IndexedTutorGroup[]` plus an O(1) `byWeekday` map.
- **Build-promise coalescing (REL-02).** The in-flight build promise is assigned to the singleton **synchronously**, before any `await`, so concurrent first-time callers reuse the same promise instead of each kicking off a duplicate rebuild — guarding against a thundering herd right after promotion (`index.ts:346-401`).

A second, independent invalidation path exists: editing tutor business profiles calls `clearSearchIndex()` directly (`api/tutor-profiles/import-commit/route.ts:61`, `api/tutor-profiles/[canonicalKey]/route.ts:51`), which nulls the singleton so the next `ensureIndex` rebuilds. This is why the index keys on *both* `snapshotId` and `profileVersion`.

`buildIndex` also stamps `syncedAt` from the last successful promoted sync's `finishedAt` (`index.ts:155-166`) — this is the value the staleness banner uses (sync data older than ~90 minutes is shown as a warning, never withheld).

## Error handling (three layers)

The pipeline applies a different failure posture at each layer — the architecture's "fail-closed at the data boundary, fail-loud at the API boundary, fail-isolated inside sync":

| Layer | Posture | Mechanism |
|---|---|---|
| Normalization / data boundary | **Fail-closed** | Unknown session status → blocking (`sessions.ts:46-51`); unresolved identity/modality → issue + Needs Review, never "Available" (`identity.ts`, `modality.ts`); modality contradictions → `conflict_model` issue, never a guess (`compare.ts:185-223`). |
| Inside the sync | **Fail-isolated** | Per-teacher availability errors → `completeness` issue, continue (`orchestrator.ts:249-259`); diff-hook per-group errors → `completeness` issue, never throw (`past-sessions-diff-hook.ts:121-132`); pruning failure → logged into metadata, sync still succeeds (`orchestrator.ts:525-547`). |
| Top of `runFullSync` | **Fail-loud, preserve prior** | Any uncaught throw is caught at `orchestrator.ts:561`; the sync run is marked `failed` with the error message, **no promotion happens**, and the prior active snapshot is untouched. The cleanup `UPDATE` failure is itself logged (REL-06) but swallowed so the primary error surfaces (`orchestrator.ts:564-586`). Returns `success: false`. |
| API boundary | **Fail-loud** | The runner returns HTTP 500 on `result.success === false` (`run-wise-sync.ts:164-166`); the route returns 401/500 on auth failures. |

The net guarantee: a failed sync is a **no-op on served data**. Readers keep seeing the last good snapshot, and the next cron tick (or manual trigger) retries from scratch with a brand-new candidate.

## Tables written, at a glance

All writes are scoped to the candidate `snapshotId` except `past_session_blocks` (cross-snapshot). Grain and columns live in the [database reference](../reference/database/index.md) / [core ERD](../reference/database/erd-core.md); the table below maps each to its producing stage.

| Table (`const`) | Written in | Notes |
|---|---|---|
| `snapshots` (`snapshots`) | 2, 12 | Candidate created inactive; promoted by the single atomic `UPDATE`. |
| `sync_runs` (`syncRuns`) | 1, 2, 12 | Lifecycle: running → success/failed; carries diff-hook + pruning metadata. |
| `tutor_identity_groups` (`tutorIdentityGroups`) | 6, 9 | Inserted unresolved; `supportedModality` updated in step 9. |
| `tutor_identity_group_members` (`tutorIdentityGroupMembers`) | 6 | Chunked. |
| `recurring_availability_windows` (`recurringAvailabilityWindows`) | 10 | Modality stamped just before insert. |
| `dated_leaves` (`datedLeaves`) | 10 | UTC→Bangkok, overlap-merged. |
| `raw_teacher_tags` (`rawTeacherTags`) | 10 | Verbatim Wise tag values. |
| `subject_level_qualifications` (`subjectLevelQualifications`) | 10 | Parsed from tags. |
| `future_session_blocks` (`futureSessionBlocks`) | 10 | Blocking flag fail-closed. |
| `tutors` (`tutors`) | 10 | Display record + `supportedModes`. |
| `past_session_blocks` (`pastSessionBlocks`) | 9.5 | **Cross-snapshot**, `ON CONFLICT DO NOTHING`. |
| `data_issues` (`dataIssues`) | 10 | All accumulated issues (alias/tag/modality/conflict_model/completeness). |
| `snapshot_stats` (`snapshotStats`) | 11 | One roll-up row per snapshot. |

Reads during the sync: `tutor_aliases` (step 4), and inside the diff-hook the prior snapshot's `snapshots` / `tutor_identity_groups` / `future_session_blocks` (step 9.5).

## Cross-references

- **Architecture** — the snapshot/index spine in context: [architecture.md](architecture.md).
- **Tutor search / compare** — how the promoted snapshot is *queried* (range search, conflict detection, free-slot intersection): [tutor-search](../features/tutor-search.md), [tutor-compare](../features/tutor-compare.md).
- **Data health** — how `sync_runs`, `snapshot_stats`, and `data_issues` surface to admins: [data-health](../features/data-health.md).
- **Crons** — the full cron roster and how this sync is staggered against the others: [crons.md](../reference/crons.md).
- **Wise API** — endpoint contracts, pagination, and the client's auth/retry behavior: [wise-api.md](../reference/wise-api.md).
- **Database** — table grains, columns, indexes: [database/index.md](../reference/database/index.md), [erd-core.md](../reference/database/erd-core.md).

_Verified against HEAD `d4fe6d3` on 2026-06-05._
