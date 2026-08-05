# Data Flow (ETL)

How tutor data gets from the Wise API into the in-memory index that `/search` and `/compare` query. This is the most load-bearing pipeline in the application: every availability answer the product gives is derived from the artifacts this pipeline writes, and the fail-closed guarantees are enforced *here*, at write time — not at read time.

The whole thing is one function — `runFullSync()` at [`src/lib/sync/orchestrator.ts:50`](../../src/lib/sync/orchestrator.ts) — wrapped by a single-flight guard in [`src/lib/sync/run-wise-sync.ts:142`](../../src/lib/sync/run-wise-sync.ts). It has exactly one production caller (`run-wise-sync.ts:152`); there is no CLI script, no partial-sync mode, and no incremental path. Every run is a full rebuild.

> **Scope.** This is the *tutor-availability snapshot* sync. `vercel.json` registers many other crons (sales dashboard, credit control, Wise activity audit, progress tests, post-class feedback, leave requests, class-assignment automation, watchdog, and more); those are separate pipelines with their own `*_sync_runs` tables. They share the `WiseClient` but not the snapshot/promotion machinery described here. See [cron reference](../reference/crons.md).

## Design shape

Wise is slow and rate-limited, so it is never on the request path. Instead:

1. A background job pulls **everything** from Wise.
2. Normalization turns Wise's loosely-typed payloads into a fail-closed domain model.
3. The result is written to Postgres tables all keyed by an immutable `snapshot_id`, with `active = false`.
4. A validation gate decides whether the candidate snapshot is fit to serve.
5. One `UPDATE` statement flips `active` — readers see the old snapshot or the new one, never neither.
6. Web instances lazily notice the snapshot id changed and rebuild their in-process index.

The consequence worth internalizing: **a failed sync is a no-op for readers.** Nothing is deleted, nothing is mutated in place, and the previously-active snapshot keeps serving traffic until a *successful* run replaces it.

## The stage map

| # | Stage | Code | Writes |
|---|---|---|---|
| — | Auth + single-flight guard | `run-wise-sync.ts:88-118`, `142-154` | `sync_runs` (`running`), `cron_invocations` |
| 1 | Create/adopt sync run | `orchestrator.ts:62-68` | `sync_runs` |
| 2 | Create candidate snapshot | `orchestrator.ts:71-81` | `snapshots` (`active=false`), `sync_runs.snapshot_id` |
| 3 | Fetch all teachers | `orchestrator.ts:84` | — |
| 4 | Load alias overrides | `orchestrator.ts:87-91` | — |
| 5 | Resolve identities | `orchestrator.ts:94` | — (issues buffered) |
| 6 | Persist groups + members | `orchestrator.ts:111-139` | `tutor_identity_groups`, `tutor_identity_group_members` |
| 7 | Per-teacher availability, leaves, tags | `orchestrator.ts:156-260` | (buffered) |
| 8 | Fetch + normalize future sessions | `orchestrator.ts:263-305` | (buffered) |
| 9 | Derive modality + contradiction pass | `orchestrator.ts:315-398` | `tutor_identity_groups.supported_modality` |
| 9.5 | PAST-01 diff-hook | `orchestrator.ts:407` → `past-sessions-diff-hook.ts:66` | `past_session_blocks` |
| 10 | Bulk-insert buffered rows + issues | `orchestrator.ts:420-450` | 6 snapshot tables + `data_issues` |
| 11 | Compute snapshot stats | `orchestrator.ts:458-470` | `snapshot_stats` |
| 12 | Validate + atomic promote | `orchestrator.ts:473-501` | `snapshots.active` |
| 13 | Finalize run, prune old snapshots | `orchestrator.ts:509-548` | `sync_runs`, cascade deletes |
| 14 | Invalidate cache tag | `run-wise-sync.ts:161` | Next.js `"use cache"` entries |
| 15 | Lazy index rebuild (read path) | `search/index.ts:354` | `globalThis.__bgscheduler_searchIndex` |

Stages 7–11 buffer rows in memory and flush them in chunks of 250 (`INSERT_CHUNK_SIZE`, `orchestrator.ts:38`) rather than inserting per entity — with one exception noted in stage 6.

Column-level detail for every table named here lives in the [database reference](../reference/database/index.md) and the [core ERD](../reference/database/erd-core.md).

## Sequence diagram

```mermaid
sequenceDiagram
    autonumber
    participant Cron as Vercel Cron every 30 min
    participant Route as sync-wise route
    participant Guard as run-wise-sync.ts
    participant Orch as runFullSync
    participant Wise as Wise API
    participant Norm as normalization modules
    participant PG as Postgres
    participant Idx as SearchIndex per instance

    Cron->>Route: GET with Bearer CRON_SECRET
    Route->>Route: constant-time secret compare (REL-07)
    Route->>Guard: runWiseSyncRequest via withCronInvocationAudit
    Guard->>PG: fail sync_runs running longer than 20 min
    Guard->>PG: INSERT sync_runs status=running
    Note over Guard,PG: partial UNIQUE index permits exactly one running row
    alt another run in flight
        Guard-->>Route: 202 skipped
    end
    Guard->>Orch: runFullSync db, client, instituteId, syncRunId

    Orch->>PG: INSERT snapshots active=false
    Orch->>Wise: GET /institutes/{id}/teachers
    Wise-->>Orch: WiseTeacher[]
    Orch->>PG: SELECT tutor_aliases
    Orch->>Norm: resolveIdentities teachers, aliases
    Norm-->>Orch: IdentityGroup[] plus alias issues
    Orch->>PG: INSERT tutor_identity_groups one row at a time
    Orch->>PG: INSERT tutor_identity_group_members chunked

    loop per teacher, sequential
        Orch->>Wise: 26x GET .../availability seven-day windows
        Wise-->>Orch: workingHours plus leaves
        Orch->>Norm: normalizeWorkingHours / normalizeLeaves / normalizeTeacherTags
        Norm-->>Orch: windows, leaves, quals, tag issues
    end

    Orch->>Wise: GET /institutes/{id}/sessions status=FUTURE, paged
    Wise-->>Orch: WiseSession[]
    Orch->>Norm: normalizeSessions
    Norm-->>Orch: NormalizedSessionBlock[] with fail-closed isBlocking

    loop per identity group
        Orch->>Norm: deriveModality group, groupSessions
        Norm-->>Orch: modality or unresolved plus issue
        Orch->>PG: UPDATE tutor_identity_groups.supported_modality
    end
    Orch->>Orch: MOD-01 per-session contradiction pass

    Orch->>PG: PAST-01 diff-hook into past_session_blocks, ON CONFLICT DO NOTHING
    Note over Orch,PG: must run BEFORE promotion; prior snapshot still active

    par chunked bulk inserts
        Orch->>PG: recurring_availability_windows
    and
        Orch->>PG: dated_leaves, raw_teacher_tags, subject_level_qualifications
    and
        Orch->>PG: future_session_blocks, tutors
    end
    Orch->>PG: INSERT data_issues chunked
    Orch->>PG: INSERT snapshot_stats

    alt unresolvedRatio below 0.5
        Orch->>PG: single UPDATE snapshots SET active = id equals candidate
        Orch->>PG: pruneOldSnapshots retain 30
    else gate fails
        Note over Orch,PG: candidate stays active=false; prior snapshot keeps serving
    end
    Orch->>PG: UPDATE sync_runs status=success
    Orch-->>Guard: SyncResult
    Guard->>Guard: revalidateTag snapshot, expire 0

    Note over Idx: next reader calls ensureIndex
    Idx->>PG: SELECT active snapshot id
    Idx->>PG: load all snapshot tables in parallel
    Idx->>Idx: rebuild singleton plus byWeekday map
```

## Trigger and entry

**Cron.** `vercel.json` registers `/api/internal/sync-wise` on `*/30 * * * *`. Vercel invokes it with `GET`; the route also accepts `POST` for manual triggers ([`route.ts:69`, `route.ts:74`](../../src/app/api/internal/sync-wise/route.ts)). `maxDuration = 800` is declared per route (`route.ts:7`), not in `vercel.json`. The same schedule and an 800-second budget are mirrored in the cron registry entry `wise_snapshot` ([`src/lib/data-health/cron-registry.ts:48-56`](../../src/lib/data-health/cron-registry.ts)), which also sets `lateAfterMinutes: 45` for watchdog purposes.

**Auth.** The cron secret is compared in constant time with a length pre-check before `timingSafeEqual` (REL-07, `route.ts:11-29`) — a length mismatch would otherwise make `timingSafeEqual` throw `RangeError`. `GET` accepts only the cron secret; `POST` additionally accepts an Auth.js session (`route.ts:32-66`). A second admin-only entry point exists at `POST /api/admin/sync-wise`, which requires a session and no secret ([`src/app/api/admin/sync-wise/route.ts:9`](../../src/app/api/admin/sync-wise/route.ts)). All paths wrap the call in `withCronInvocationAudit({ jobKey: "wise_snapshot", ... })` ([`src/lib/data-health/cron-audit.ts:144`](../../src/lib/data-health/cron-audit.ts)), which writes a `cron_invocations` row carrying trigger source, actor email, duration, response status, an outcome derived from the response body (`skipped` on HTTP 202 or a "already running" message, `cron-audit.ts:63-70`), and the `syncRunId` extracted from the JSON body into `linked_run_ids` (`cron-audit.ts:38-60`).

**Single-flight.** Before doing anything, `acquireSyncRun()` ([`run-wise-sync.ts:88`](../../src/lib/sync/run-wise-sync.ts)) does three things in order:

1. Fails any `sync_runs` row still `running` after `STALE_RUNNING_SYNC_MS` = 20 minutes (`run-wise-sync.ts:10`, `51-72`) — this is how a timed-out invocation gets unwedged without operator action.
2. Looks for a live `running` row; if one exists, returns a `202` "skipped" payload (`run-wise-sync.ts:95-97`, `148-150`).
3. Otherwise inserts a `running` row. The database is the real lock: `sync_runs` carries a *partial* unique index `sync_runs_single_running_idx` on `status WHERE status = 'running'` ([`src/lib/db/schema.ts:473-475`](../../src/lib/db/schema.ts)), so two racing inserts cannot both win. The loser catches SQLSTATE `23505` and degrades to the same "skipped" result (`run-wise-sync.ts:106-117`).

The guard hands its `syncRunId` to `runFullSync` via options, which is why the orchestrator only creates its own run row when called without one (`orchestrator.ts:62`).

## Transport: the Wise client

[`src/lib/wise/client.ts`](../../src/lib/wise/client.ts) is the only thing in the repo that talks HTTP to Wise. It imports nothing from the rest of the app.

- **Headers** (`client.ts:52-61`): Basic auth from base64 `userId:apiKey`, plus `x-api-key`, `x-wise-namespace`, and `user-agent: VendorIntegrations/{namespace}`. Base URL defaults to `https://api.wiseapp.live` (`client.ts:47`).
- **Retry policy (REL-05)**: only `408, 429, 500, 502, 503, 504` are retried (`client.ts:23-30`). Every other non-OK status — notably `401`, `403`, `404`, `422` — throws immediately (`client.ts:123-125`). Network-level throws (DNS, `ECONNRESET`, fetch `TypeError`) are also retried (`client.ts:105-113`). Backoff is `2^attempt * 1000` ms → 1s, 2s, 4s, with `maxRetries` defaulting to 3.
- **Concurrency limiter** (`client.ts:136-156`): a hand-rolled promise queue, default `maxConcurrency = 5`. The production factory `createWiseClient()` raises it to **15** (`client.ts:159-166`) and reads `WISE_USER_ID` / `WISE_API_KEY` / `WISE_NAMESPACE` straight from `process.env`.

**There is no Zod validation of Wise responses anywhere in the ETL path** — `grep -r zod src/lib/{sync,normalization,wise}` returns nothing outside tests. Wise payloads are typed as permissive interfaces with `[key: string]: unknown` index signatures and read through defensive accessor helpers — `getWiseTeacherUserId`, `getWiseTeacherDisplayName`, `getWiseSessionTeacherUserId`, `getWiseSessionClassName`, `getWiseTagName` ([`src/lib/wise/types.ts:300-350`](../../src/lib/wise/types.ts)) — each of which tolerates a field being either a bare string id or a populated object. Validation at this boundary is structural-by-accessor, not schema-based. (Zod *is* used at the app's own HTTP boundary, e.g. `src/app/api/search/route.ts:2,8`, just not against Wise.)

## Stage 3–6: teachers → identity groups

`fetchAllTeachers` ([`fetchers.ts:31`](../../src/lib/wise/fetchers.ts)) is a single unpaginated `GET /institutes/{id}/teachers` returning `res.data.teachers ?? []`.

Aliases come from `tutor_aliases` — one of the few snapshot-independent tables — and are lower-cased into a `Map` for lookup (`identity.ts:76-79`).

`resolveIdentities()` ([`src/lib/normalization/identity.ts:72`](../../src/lib/normalization/identity.ts)) runs the cascade:

1. **Nickname extraction** — first parenthetical in the display name, via `/\(([^)]+)\)/` (`identity.ts:43-46`). `"Chinnakrit (Celeste) Channiti"` → `"Celeste"`.
2. **Alias override** — `aliasMap.get(nickname.toLowerCase())` wins over the raw nickname (`identity.ts:98-99`).
3. **Online/offline pair merge** — teachers are bucketed by lower-cased canonical key (`identity.ts:113-121`); `isOnlineVariant()` tests `/\bOnline\s*$/i` against the trimmed display name (`identity.ts:52-54`). The group's display name is taken from the non-online member when one exists (`identity.ts:129`).
4. **Collision detection (REL-03)** — a bucket that is neither a solo entry nor a clean 1-online + 1-offline pair emits a high-severity `alias` issue naming every member, but **the group is still created** so the members stay visible in Needs Review (`identity.ts:153-170`).
5. **Unresolved fallback** — a teacher with no nickname and no alias match gets an `alias` issue *and* a solo group keyed by its raw display name (`identity.ts:178-204`).

Note the deliberate consequence of steps 4 and 5: `resolveIdentities` never drops a teacher. Every Wise teacher lands in exactly one group; ambiguity is expressed as a `data_issue`, never as silent data loss.

Persistence (`orchestrator.ts:111-139`) inserts groups **one row at a time** in a loop, because it needs each generated `id` back to build `groupIdMap`; members are batched afterwards. `supported_modality` is written as `"unresolved"` here and corrected in stage 9.

Identity issues are typed `alias` with severity `critical` (`orchestrator.ts:97-105`) — the only `critical` severity this pipeline emits. (The `data_issue_type` and `data_issue_severity` enums are declared at `schema.ts:27-41`.)

## Stage 7: availability, leaves, tags (per teacher)

A sequential `for` loop over every Wise teacher (`orchestrator.ts:156-260`). Two guards bracket it:

- **Missing Wise user id** → a `completeness` / `high` issue and `continue` (`orchestrator.ts:162-173`). Availability is addressed by *user* id, not teacher id, so such a teacher contributes no windows.
- **Any thrown error** → a `completeness` / `high` issue naming the teacher and the error message, then the loop continues (`orchestrator.ts:249-259`). One teacher's Wise failure never aborts the sync.

**Fetch shape.** `fetchTeacherFullAvailability` ([`fetchers.ts:63`](../../src/lib/wise/fetchers.ts)) covers a 180-day horizon as `Math.ceil(180 / 7) = 26` seven-day windows. The first window is awaited alone because it is the only one whose `workingHours` are kept (`fetchers.ts:76-84`); the remaining 25 are issued via `Promise.all` for leaves only (`fetchers.ts:88-97`). Cost per teacher is therefore 26 requests, and total availability traffic is roughly `26 × teacherCount`, throttled to 15 in flight by the client limiter. Because the outer loop is sequential per teacher, wall-clock time scales linearly with teacher count — this is the dominant term in sync duration and the reason `maxDuration = 800` exists.

**Normalization.**

- `normalizeWorkingHours` ([`availability.ts:33`](../../src/lib/normalization/availability.ts)) accepts either a numeric weekday or a weekday *name* (`WEEKDAY_MAP`, `availability.ts:10-18`), parses `"HH:mm"` into minutes-since-midnight, **drops** slots where `startMinute >= endMinute` (`availability.ts:47`), then merges overlaps per weekday (`deduplicateWindows`, `availability.ts:62`). Wise `workingHours` are already Bangkok-local, so no timezone conversion happens here — only sessions and leaves are converted.
- `normalizeLeaves` ([`leaves.ts:14`](../../src/lib/normalization/leaves.ts)) converts each leave through `toLocalTime` and merges overlapping *or adjacent* windows (`<=` comparison, `leaves.ts:43`).
- `normalizeTeacherTags` ([`qualifications.ts:71`](../../src/lib/normalization/qualifications.ts)) matches `^(.+?)\s*\(([^)]+)\)\s*(.+)$` (`qualifications.ts:31`) to split `Subject (Curriculum) Level`. `CURRICULUM_MAP` canonicalizes `int.`/`int`/`international` → `International`, `th`/`thai` → `Thai`, `examprep`/`exam prep` → `ExamPrep` (`qualifications.ts:33-41`); an unrecognized curriculum passes through verbatim rather than failing. When curriculum resolves to `ExamPrep`, the level is copied into `examPrep` (`qualifications.ts:61-63`). Anything that does not match the pattern produces a `tag` / `high` issue and no qualification row (`qualifications.ts:87-94`).

Raw tags are also stored verbatim in `raw_teacher_tags` alongside the parsed qualifications (`orchestrator.ts:210-218`), so a change to the parsing rules can be re-evaluated against what Wise actually sent.

## Stage 8: future sessions

`fetchAllFutureSessions` ([`fetchers.ts:110`](../../src/lib/wise/fetchers.ts)) delegates to `fetchAllInstituteSessions` with `status: "FUTURE"`, paging `COUNT`-style at `page_size = 1000` (`PAGE_LIMIT`, `fetchers.ts:24`) until `page > page_count` or an empty page arrives (`fetchers.ts:126-144`).

Sessions arrive institute-wide and carry a *user* id, not a teacher id, so the orchestrator builds a `wiseUserId → wiseTeacherId` map from the already-fetched teachers and passes a resolver closure into normalization (`orchestrator.ts:264-275`). A session whose teacher cannot be resolved is dropped inside `normalizeSessions` (`sessions.ts:64-65`); a session whose teacher has no identity group is dropped again at the row-building step (`orchestrator.ts:279-280`). Neither drop emits a `data_issue`.

`normalizeSessions` ([`sessions.ts:57`](../../src/lib/normalization/sessions.ts)) converts start/end to Bangkok, derives `weekday` / `startMinute` / `endMinute`, and classifies blocking status.

**The fail-closed rule lives in `isBlockingStatus` (`sessions.ts:46-51`):** a missing status returns `true`, and any status not in `NON_BLOCKING_STATUSES` returns `true`. That set is `CANCELLED`, `CANCELED` (both spellings), `COMPLETED`, `MISSED`, `NO_SHOW` (`sessions.ts:34-40`). A missing status is persisted as the literal string `"UNKNOWN"` (`sessions.ts:80`). An unrecognized future Wise status therefore makes a tutor *look busy*, never falsely free.

## Stage 9: modality

Two passes, both over the identity groups.

**Pass A — group modality** (`orchestrator.ts:315-362`) calls `deriveModality` ([`modality.ts:23`](../../src/lib/normalization/modality.ts)) with the group's own sessions. Precedence:

1. Structural: online member **and** offline member → `both`; online only → `online` (`modality.ts:28-36`).
2. Session evidence: `sessionType` `online` or `location` in `{online, virtual}` → online evidence; `sessionType` in `{onsite, in-person, offline}` or `location` `onsite` → onsite evidence. Both → `both` (`modality.ts:42-62`).
3. Otherwise `unresolved` **with a `modality` issue** — including the single-offline-record case, which the comment at `modality.ts:65-66` explicitly declines to default to `onsite` (`modality.ts:67-79`). This is the fail-closed rule for modality: no guessing.

The result updates `tutor_identity_groups.supported_modality` per group. The per-teacher modality stamped onto availability windows is derived from it: an online-variant member is always `online`, and non-online members of a `both` group are stored as `onsite` (`orchestrator.ts:332-337`). `tutors.supportedModes` expands `both` into `["online","onsite"]` and `unresolved` into `[]` (`orchestrator.ts:352-361`).

**Pass B — MOD-01 per-session contradictions** (`orchestrator.ts:367-398`) re-walks each group's sessions and calls `detectSessionModalityConflict` ([`src/lib/search/compare.ts:185`](../../src/lib/search/compare.ts)). It compares the teacher record's `isOnlineVariant` against the session's `sessionType`, using the sets `ONLINE_SESSION_TYPES = {online, virtual, scheduled}` and `ONSITE_SESSION_TYPES = {onsite, in-person, offline}` (`compare.ts:6-7`). A session type outside both sets contradicts nothing and returns `null` (`compare.ts:194`). Matches emit a `conflict_model` / `high` issue carrying `{isOnlineVariant, sessionType, groupCanonicalKey}` in `metadata`. The group's `supportedModality` is read from an in-memory `Map` hoisted during pass A specifically to avoid a per-session `SELECT` (`orchestrator.ts:308-324`).

## Stage 9.5: the PAST-01 diff-hook

Wise's `status=FUTURE` endpoint stops returning a session once it is in the past, so sessions would simply vanish between snapshots. `runPastSessionsDiffHook` ([`src/lib/sync/past-sessions-diff-hook.ts:66`](../../src/lib/sync/past-sessions-diff-hook.ts)) catches them on the way out.

Ordering is load-bearing: it runs at `orchestrator.ts:407`, **before** promotion at `orchestrator.ts:488`, because it reads the still-`active` prior snapshot (`past-sessions-diff-hook.ts:75-84`). If no prior active snapshot exists (first-ever sync), it returns immediately.

The comparison (`past-sessions-diff-hook.ts:117-153`): for each prior-snapshot `future_session_blocks` row, skip it if its `wiseSessionId` is still present in the new Wise response, skip it if `startTime >= now`, otherwise copy it into `past_session_blocks` keyed by the prior group's `canonicalKey`. A prior `groupId` that cannot be resolved to a canonical key emits a `completeness` / `medium` issue and is skipped — never thrown.

Idempotency is purely database-side: `past_session_blocks` has `uniqueIndex("psb_wise_session_id_idx")` on `wise_session_id` ([`src/lib/db/schema.ts:2289`](../../src/lib/db/schema.ts)) and the insert uses `onConflictDoNothing` (`past-sessions-diff-hook.ts:159-163`). That matters because the Neon HTTP driver has no transaction support ([`src/lib/db/index.ts:5-12`](../../src/lib/db/index.ts)) — a crashed sync that half-inserted rows re-runs safely on the next tick. `capturedCount` counts only rows that actually landed (`RETURNING` length) and is reported into `sync_runs.metadata` alongside the hook duration (`orchestrator.ts:503-506`).

`past_session_blocks` is the pipeline's only cross-snapshot data table: no `snapshot_id` foreign key, only a nullable provenance column `captured_in_snapshot_id`, precisely so snapshot pruning cannot orphan it (`schema.ts:2262-2264`). Capture is first-observation-wins: a session later observed as retroactively cancelled keeps the row as originally captured (`schema.ts:2252-2254`).

## Stage 10–11: bulk write and stats

Availability rows are created in stage 7 with `modality: "unresolved"` and backfilled from the stage-9 map immediately before insert (`orchestrator.ts:420-422`) — a deliberate ordering so each window is written exactly once with its final value.

Six tables are then filled in parallel, each chunked at 250 (`orchestrator.ts:424-443`): `recurring_availability_windows`, `dated_leaves`, `raw_teacher_tags`, `subject_level_qualifications`, `future_session_blocks`, `tutors`. All accumulated issues follow into `data_issues` (`orchestrator.ts:446-450`).

`snapshot_stats` (`orchestrator.ts:458-470`) records teacher/group/qualification/window/leave/session/issue totals plus an `issuesByType` histogram, under a unique index on `snapshot_id` (`schema.ts:2718`). This row is what the Data Health dashboard reads.

Two counting quirks to know before trusting those numbers:

- `unresolvedGroups` is `identityIssues.length` — an **issue** count, which includes REL-03 collision issues, not a count of unresolved groups.
- `resolvedGroups` counts groups whose `canonicalKey` does not appear as an issue `entityId` (`orchestrator.ts:462`). Unresolved-teacher issues use `entityId = teacher._id`, not the canonical key (`identity.ts:186`), so the solo groups those issues created are still counted as resolved.

## Stage 12: validate and promote

The gate is deliberately blunt (`orchestrator.ts:473-476`):

```
unresolvedRatio = identityIssues.length / max(groups.length, 1)
shouldPromote   = unresolvedRatio < 0.5
```

Only identity health gates promotion. Modality issues, unmapped tags, and per-teacher availability failures do not block — by design, since they degrade individual tutors to Needs Review rather than corrupting the whole snapshot.

Promotion is **one** statement (`orchestrator.ts:488-498`):

```sql
UPDATE snapshots
   SET active = (id = $candidate)
 WHERE active = true OR id = $candidate
```

The comment at `orchestrator.ts:481-487` records why (REL-01): a single statement under PostgreSQL MVCC means concurrent readers see either the old active row or the new one, never a window with zero `active = true` rows. The bounded `WHERE` also avoids rewriting the whole table on every promote. This replaced an earlier two-`UPDATE` sequence — and it matters precisely because the Neon HTTP driver cannot wrap two statements in a transaction.

If the gate fails, `promotedSnapshotId` stays `null`, the candidate keeps `active = false`, and the sync still reports `success: true` (`orchestrator.ts:550-560`). The candidate's rows stay in Postgres as forensic evidence, invisible to readers.

**Pruning** runs only after a real promotion (`orchestrator.ts:520-548`). `pruneOldSnapshots` ([`src/lib/sync/snapshot-pruning.ts:49`](../../src/lib/sync/snapshot-pruning.ts)) keeps the newest `SNAPSHOT_RETENTION_COUNT = 30` snapshots plus any snapshot marked active (`snapshot-pruning.ts:5`, `64-70`), nullifies `sync_runs.snapshot_id` / `promoted_snapshot_id` references, then deletes child rows in FK-safe order before deleting the snapshots themselves (`snapshot-pruning.ts:88-179`). A pruning failure is caught, logged, and recorded in `sync_runs.metadata` as `{attempted, failed, error}` — it never turns a successful sync into a failed one (`orchestrator.ts:525-534`).

## Failure model

Three distinct behaviors, chosen per stage:

| Failure | Behavior | Code |
|---|---|---|
| One teacher's availability fetch | `completeness` issue, loop continues | `orchestrator.ts:249-259` |
| One unparseable tag | `tag` issue, no qualification row | `qualifications.ts:87-94` |
| One unresolvable identity | `alias` issue + solo group kept | `identity.ts:178-204` |
| One diff-hook group anomaly | `completeness` issue, hook continues | `past-sessions-diff-hook.ts:121-131` |
| Snapshot pruning | logged, recorded in metadata, sync still succeeds | `orchestrator.ts:525-534` |
| Anything else (teachers fetch, sessions fetch, bulk insert) | thrown → outer catch → `sync_runs.status='failed'`, no promotion | `orchestrator.ts:561-599` |

The outer catch's own cleanup `UPDATE` is `.catch()`-guarded (REL-06, `orchestrator.ts:573-585`): a cleanup failure is logged to `console.error` with the primary error message attached, but swallowed so the real error survives into the `SyncResult`. The cost of that choice — a `sync_runs` row stuck in `running` — is exactly what the 20-minute stale-run sweep exists to clean up.

A failed run returns HTTP 500 from `runWiseSyncRequest` (`run-wise-sync.ts:164-166`), which `withCronInvocationAudit` records as a `failed` cron invocation.

## Timezone convention

All conversion goes through [`src/lib/normalization/timezone.ts`](../../src/lib/normalization/timezone.ts), which is 34 lines and hard-codes `TIMEZONE = "Asia/Bangkok"`.

`toLocalTime()` wraps `date-fns-tz`'s `toZonedTime` (`timezone.ts:8-11`), which returns a `Date` **shifted so that local getters read Bangkok wall-clock**. `getLocalWeekday` and `getLocalMinuteOfDay` read `.getDay()` / `.getHours()` off that shifted value (`timezone.ts:16-26`), which is why weekday and minute-of-day are correct regardless of the host's own timezone.

The consequence to keep in mind: the shifted `Date` is what gets **stored** into the `timestamptz` columns of `dated_leaves` and `future_session_blocks` (`orchestrator.ts:203-204`, `289-290`). On a UTC host — which is what Vercel serverless runs, and no `TZ` is pinned anywhere in the repo — the stored instant is Bangkok wall-clock stamped as UTC, i.e. 7 hours ahead of the true instant. The read path uses the same convention: `getStartOfTodayBkk()` and `getCurrentMonday()` build their boundaries from `toZonedTime` components through local `Date` constructors ([`src/lib/search/compare.ts:36-39`](../../src/lib/search/compare.ts), [`src/app/api/compare/route.ts:34-41`](../../src/app/api/compare/route.ts)), so comparisons against stored `startTime` are apples-to-apples. The one place the convention is mixed is the diff-hook's `prior.startTime >= now` test against a raw `new Date()` (`past-sessions-diff-hook.ts:114`, `119`) — see open questions.

`parseTimeToMinutes()` is a plain `"HH:mm"` split with no validation (`timezone.ts:31-34`); a malformed string yields `NaN`, which then fails the `startMinute >= endMinute` guard in `normalizeWorkingHours` and drops the slot.

## After the sync: cache and index

**Next.js cache.** On success only, `revalidateTag("snapshot", { expire: 0 })` fires (`run-wise-sync.ts:160-162`). That sweeps the `"use cache"` server functions tagged `snapshot` — currently `getTutorList()` ([`src/lib/data/tutors.ts:80-86`](../../src/lib/data/tutors.ts)) and `getFilterOptions()` ([`src/lib/data/filters.ts:52-58`](../../src/lib/data/filters.ts)), both `cacheLife("hours")`. Past-session reads are deliberately **not** tagged `snapshot` — there is an explicit regression test asserting the absence (`src/lib/data/__tests__/past-sessions.test.ts:143`) — because that data is cross-snapshot and must survive a snapshot rotation.

**In-memory index.** The sync never touches the index directly. Every read path calls `ensureIndex(db)` ([`src/lib/search/index.ts:354`](../../src/lib/search/index.ts)) — from `/api/search`, `/api/compare`, `/api/compare/discover`, `/api/proposals`, `src/lib/search/range-search.ts`, `src/lib/room-capacity/data.ts`, `src/lib/ai/scheduler-service.ts`, and `src/lib/line/operational.ts`. `ensureIndex` compares the cached index's `snapshotId` **and** its `profileVersion` (a `count:max(updatedAt)` digest over `tutor_business_profiles`, `search/index.ts:128-137`) against the database, rebuilding only on a mismatch (`search/index.ts:366-388`). If the active-snapshot lookup returns nothing, it keeps serving the cached index rather than failing (`search/index.ts:384-386`).

There is also an eager invalidation path that has nothing to do with the ETL: editing tutor business profiles calls `clearSearchIndex()` directly, in `PATCH /api/tutor-profiles/[canonicalKey]` ([`route.ts:51`](../../src/app/api/tutor-profiles/[canonicalKey]/route.ts)) and after a non-empty bulk import commit ([`import-commit/route.ts:61`](../../src/app/api/tutor-profiles/import-commit/route.ts)). That clears the singleton on *one* instance; the `profileVersion` digest is what makes every other instance notice.

Two properties follow from lazy rebuild. First, **rebuild is per-instance**: each warm serverless instance rebuilds on its own first post-sync request, so a promotion propagates over the following minutes rather than instantly. Second, **concurrent rebuilds coalesce**: the in-flight build promise is assigned to `globalThis.__bgscheduler_searchIndexBuildPromise` synchronously, before any `await` yields to the microtask queue (REL-02, `search/index.ts:391-400`), so a thundering herd of first requests shares one build.

`buildIndex` (`search/index.ts:142`) issues one query for groups, then eight parallel queries for members, qualifications, windows, leaves, sessions, issues, business profiles, and the profile version (`search/index.ts:175-222`). It denormalizes `canonicalKey` onto each `IndexedTutorGroup` (D-04, `search/index.ts:263`) so the compare route can reach cross-snapshot `past_session_blocks` without an extra round trip, joins editorial `tutor_business_profiles` by canonical key, and builds a `byWeekday` map for O(1) weekday lookup (`search/index.ts:322-331`). `syncedAt` comes from the `sync_runs` row that promoted this snapshot, falling back to the snapshot's `createdAt` (`search/index.ts:155-166`) — that value drives the staleness warnings.

Note that `buildIndex` re-derives `supportedModes` from `tutor_identity_groups.supported_modality` (`search/index.ts:265-270`) rather than reading the `tutors` table the sync wrote, so `tutors.supported_modes` is written by the ETL but not consumed by the index.

**Staleness is a warning, never withheld data.** `API_STALE_THRESHOLD_MS` is 90 minutes and `APP_STALE_BANNER_THRESHOLD_MS` is 2 hours ([`src/lib/ops/stale.ts:2-3`](../../src/lib/ops/stale.ts)); `executeSearch` attaches `STALE_SEARCH_WARNING` to its response when the index's `syncedAt` is older than the threshold ([`src/lib/search/engine.ts:30-37`](../../src/lib/search/engine.ts)), the compare API does the same ([`src/app/api/compare/route.ts:144-149`](../../src/app/api/compare/route.ts)), and Data Health reports `staleAgeMs` / `staleMinutes` computed from the last successful sync ([`src/lib/data-health/dashboard.ts:952-962`](../../src/lib/data-health/dashboard.ts)).

## What this pipeline does not do

- **No writes to Wise.** The snapshot ETL is strictly read-only. The write-capable fetchers living in the same file — `updateSessionLocation`, `updateSessionSubject`, `scheduleWiseSession`, `updateWiseCourseSubject`, `updateWiseStudentRegistrationAnswers` (`fetchers.ts:410`, `426`, `460`, `331`, `308`) — belong to other features and are never called from `runFullSync`.
- **No incremental sync.** Every run refetches everything and writes a whole new snapshot.
- **No Google Sheets fallback.** Tutor availability comes from Wise or not at all.
- **No cross-pipeline lineage.** Other subsystems replicate the single-flight discipline but not the snapshot/promotion machinery.

## Tests that pin this behavior

`src/lib/sync/__tests__/orchestrator.integration.test.ts` runs the pipeline against a real Postgres via testcontainers and asserts: happy-path promotion of exactly one active snapshot, pruning of older inactive snapshots, success preserved when the pruning-metadata update fails, and **no promotion at a ≥50% unresolved-identity ratio**. `orchestrator-modality-conflict.test.ts` covers MOD-01 in both directions (contradiction persisted; agreement emits nothing). `src/lib/wise/__tests__/client.test.ts` pins the REL-05 policy explicitly: 401 and 404 do not retry, 500 exhausts the budget, 429 recovers on the second try, a fetch `TypeError` recovers, and concurrency is capped. `past-sessions-diff-hook.integration.test.ts` covers capture, idempotency under the UNIQUE constraint, future/near-future exclusion, orphan-group isolation, and "still present in the new response" exclusion; `snapshot-pruning.integration.test.ts` covers retention and the within-window no-op. Per-module normalization tests live under `src/lib/normalization/__tests__/` — one per domain module (availability, identity, leaves, modality, qualifications, sessions, timezone).

## Related references

- [Architecture](architecture.md) — how this pipeline sits inside the wider system
- [Tutor Search](../features/tutor-search.md) and [Tutor Compare](../features/tutor-compare.md) — what the read path does with the index
- [Data Health](../features/data-health.md) — the operator view of `sync_runs`, `snapshot_stats`, and `data_issues`
- [Database reference](../reference/database/index.md), [core ERD](../reference/database/erd-core.md), [enums](../reference/database/enums.md) — column-level detail for every table named here
- [API reference](../reference/api/index.md) — endpoint signatures for `/api/internal/sync-wise` and `/api/admin/sync-wise`
- [Cron reference](../reference/crons.md) — schedules and stagger
- [Wise API reference](../reference/wise-api.md) — endpoint contracts
- [Runbook](../operations/runbook.md) and [observability](../operations/observability.md) — what to do when a sync fails

## Open questions

- **Diff-hook clock mixing.** `past-sessions-diff-hook.ts:114,119` compares `prior.startTime` (stored under the Bangkok-wall-clock-as-local-epoch convention) against a raw `new Date()`. On a UTC host that makes a session eligible for capture roughly 7 hours after it actually started. Capture still happens on a later cron tick, so nothing is lost — but is the deferral intended, or should the comparison use `toLocalTime(new Date())`?
- **`snapshot_stats` counting.** `unresolvedGroups` stores an issue count, and `resolvedGroups` does not exclude groups created by the unresolved-teacher fallback (issue `entityId` is a teacher id, not a canonical key). Should these be corrected, or does the Data Health UI already interpret them as issue counts?
- **Promotion-gate denominator.** `unresolvedRatio` divides *all* identity issues (including REL-03 collisions) by group count, so a snapshot with many collisions but zero truly unresolved teachers could be blocked. Is that the intended conservatism?
- **Silent session drops.** Sessions whose teacher cannot be resolved (`sessions.ts:64`) or whose teacher has no identity group (`orchestrator.ts:280`) are discarded without a `data_issue`. Should they be counted, given the fail-closed posture everywhere else?
- **Wise payload validation.** AGENTS.md states that Zod validates external Wise payloads; the ETL path contains no Zod. Is schema validation at the Wise boundary a desired addition, or is accessor-based tolerance the deliberate policy?
- **Sequential per-teacher loop.** Stage 7 awaits each teacher in turn while the client limiter allows 15 concurrent requests, so the limiter is rarely saturated. Is the sequencing intentional (Wise-side rate-limit caution) or an optimization opportunity against the 800 s ceiling?
- **Modality location evidence.** `deriveModality` matches `location` against the exact strings `online` / `virtual` / `onsite` (`modality.ts:44-52`), while real Wise locations are venue names. Is the location branch effectively dead in production, and should it be removed or replaced by a reliable signal?
- **Write-only `tutors` table.** The only non-test references to `schema.tutors` are the ETL insert (`orchestrator.ts:313`, `441`) and the pruning delete (`snapshot-pruning.ts:155-157`); `buildIndex` derives `supportedModes` from `tutor_identity_groups.supported_modality` instead (`search/index.ts:265-270`). Is `tutors` still needed, or can it be dropped?

_Verified against HEAD + uncommitted WIP on 2026-05-31._
