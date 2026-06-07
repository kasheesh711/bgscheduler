---
phase: "12"
plan: "03"
subsystem: line-identity
tags: [line, backlog-recovery, identity-resolution, ident-07, student-links]
dependency_graph:
  requires: ["12-01", "12-02"]
  provides: ["runLineBacklogRecovery", "listVerifiedResolverTargets", "nicknameCodes (exported)", "C1 route dryRun"]
  affects: ["src/lib/line/backlog-recovery.ts", "src/lib/line/student-links.ts", "src/app/api/line/contacts/followers-reanchor/route.ts"]
tech_stack:
  added: []
  patterns: ["onConflictDoNothing duplicate-safe insert", "dryRun gate pattern", "inline import() type-only to avoid circular import"]
key_files:
  created: ["src/lib/line/backlog-recovery.ts"]
  modified:
    - "src/lib/line/student-links.ts"
    - "src/app/api/line/contacts/followers-reanchor/route.ts"
    - "src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts"
decisions:
  - "backlog-recovery.ts owns runLineBacklogRecovery — not student-links.ts — preserving acyclic module DAG"
  - "studentLinkEvidence made optional on student field + exported so backlog-recovery.ts can call it without passing a student row"
  - "listVerifiedResolverTargets return type uses inline import() type annotation to avoid a value import from backlog-matcher.ts"
  - "Route test updated to pass NextRequest, mock backlog-recovery module, assert combined {reanchor, backlog} shape"
metrics:
  duration: "6m"
  completed_date: "2026-06-07"
  tasks: 3
  files: 4
requirements: [IDENT-07]
---

# Phase 12 Plan 03: Wire Backlog Recovery — Data-Access and Route Layer Summary

Distinctive-token backlog recovery orchestrator wired into the data-access and route layers: `runLineBacklogRecovery` inserts suggested links (IDENT-07) with `status:"suggested"` fail-closed and `evidence.originalUrl = target.lineChatUrl` powering the LINE worklist button, via the acyclic DAG `student-links → backlog-matcher → backlog-recovery → C1 route`.

## What Was Built

**Task 1 — student-links.ts (3 targeted edits):**
- `function nicknameCodes` → `export function nicknameCodes` (one keyword — now importable by backlog-matcher)
- `function studentLinkEvidence` → `export function studentLinkEvidence`, `student` field made optional; source union extended with `| "follower_profile"`; input type extended with optional `originalUrl`, `ambiguous`, `tokens`, `displayName` fields that pass through to JSONB evidence
- `export async function listVerifiedResolverTargets(db)` added — queries `lineOaResolverRows WHERE committedLinkId IS NOT NULL`, returns ~662 human-verified targets shaped as `VerifiedResolverTarget[]`; return type uses inline `import("@/lib/line/backlog-matcher").VerifiedResolverTarget[]` (type-only, zero circular value dep)
- `isNotNull` added to drizzle-orm import

**Task 2 — backlog-recovery.ts (NEW FILE):**
- `export interface LineBacklogRecoveryResult` — counts + optional `dryRunMatches`
- `export async function runLineBacklogRecovery({ db, dryRun? })` — 5-step orchestrator:
  1. Load `lineContacts` with non-null `displayName` (stored from Phase 11 re-anchor — no fresh API calls)
  2. Load verified targets via `listVerifiedResolverTargets`
  3. Build token index + `targetsByStudentKey` map
  4. Match contacts via `matchFollowersToTargets` (backlog-matcher)
  5. If `dryRun`: return matches; else: insert `status:"suggested"` rows with `onConflictDoNothing`
- Fail-closed: `status: "suggested"` hardcoded with `// ALWAYS suggested — NEVER verified from content (IDENT-02)` comment
- `evidence.originalUrl = target.lineChatUrl` wires the LINE worklist button
- Ambiguous matches: `confidence: 0.60` + `evidence.ambiguous: true`; one row per matched studentKey, never collapsed
- No DB imports in `backlog-matcher.ts` (pure module unchanged)

**Task 3 — followers-reanchor/route.ts (rewrite):**
- `maxDuration`: 60 → 300
- Signature: `POST()` → `POST(request: NextRequest)`
- `?dryRun=true` read from URL, passed to `runLineBacklogRecovery`
- Sequential: `runLineFollowersReanchor` (populates displayNames) then `runLineBacklogRecovery` (reads them)
- Combined response: `{ reanchor, backlog }` instead of `{ result }`
- Import from `@/lib/line/backlog-recovery` (not student-links)

## Module DAG (Acyclic)

```
student-links.ts (base layer — exports nicknameCodes, studentLinkEvidence, listVerifiedResolverTargets)
  ↑ imported by
backlog-matcher.ts (Wave 1 — pure functions; imports normalizeLineStudentCode from student-links)
  ↑ imported by
backlog-recovery.ts (Wave 2 orchestrator; imports matcher VALUES + data-access from student-links)
  ↑ imported by
followers-reanchor/route.ts (C1 route)
```

`student-links.ts` does NOT import any VALUE from `backlog-matcher.ts` — only uses an inline `import()` type annotation (erased at runtime).

## Deviations from Plan

### Post-plan Corrective Fix (2026-06-08 — commit f4d2c77)

**[Corrective — Phase 12 deviation] Rewired runLineBacklogRecovery to fetch the full LINE roster**

- **Found during:** Phase 12 Plan 04 production dry-run gate — the stored-lineContacts path yielded only 41 high-confidence matches; UAT-validated expectation was 229.
- **Root cause:** `lineContacts` table has 788 rows with displayNames, but only those already upserted by the re-anchor. The full OA follower roster has 1,962 followers; 788 stored records is a subset.
- **Fix:** Replaced the `db.select().from(schema.lineContacts)` scan with `fetchLineFollowerIds` (paginated) + `fetchLineProfilesBatched(allUserIds, 10)` to cover all 1,962 followers fresh from the LINE API. `upsertLineContactFromFollower` exported from `student-links.ts` so the live path can also write the contact row before inserting the suggestion link.
- **Route change:** `dryRun ? null` gates `runLineFollowersReanchor` — a `?dryRun=true` call is now fully read-only (`reanchor: null` in the response). Previously, reanchor always ran regardless of `dryRun`.
- **Known follow-up (do NOT fix in this plan):** On the LIVE combined C1 route (`!dryRun`), the follower roster is double-fetched: `runLineFollowersReanchor` does ~1,962 sequential `getProfile` calls then `runLineBacklogRecovery` batches another ~1,962 fetches. This risks the 300s `maxDuration`. The dedicated C2 cron (Plan 05) calls `runLineBacklogRecovery` directly (single fetch) and is the clean production vehicle. The double-fetch is intentionally deferred.
- **Files modified:** `src/lib/line/backlog-recovery.ts`, `src/lib/line/student-links.ts`, `src/app/api/line/contacts/followers-reanchor/route.ts`, `src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts`
- **New file:** `src/lib/line/__tests__/backlog-recovery.test.ts` (15 unit tests — mocked client + DB)
- **Commit:** f4d2c77

### Auto-fixed Issues (original plan execution)

**1. [Rule 1 - Bug] Route test broke when POST signature changed to require NextRequest**
- **Found during:** Task 3 TypeScript check (`npx tsc --noEmit` returned exit 2)
- **Issue:** Existing `route.test.ts` called `POST()` with no arguments; 3 call sites failed with TS2554 (Expected 1 argument)
- **Fix:** Rewrote test to: add `runLineBacklogRecovery` mock, add `makeRequest()` helper that constructs a `Request` castable to `NextRequest`, update all `POST()` calls to `POST(makeRequest(...))`, update assertions for new combined `{ reanchor, backlog }` response shape, add `?dryRun=true` path test
- **Files modified:** `src/app/api/line/contacts/followers-reanchor/__tests__/route.test.ts`
- **Result:** Test count: 1147 → 1148 (1 new test for dryRun path)

**2. [Rule 2 - Missing functionality] studentLinkEvidence not exported**
- **Found during:** Task 2 implementation — backlog-recovery.ts needs to import `studentLinkEvidence` as a value
- **Issue:** `studentLinkEvidence` was a private function in student-links.ts; the plan noted "if not exported, export it there"
- **Fix:** Added `export` keyword to `studentLinkEvidence` in Task 1; also made `student` field optional in the input type (backlog-recovery path doesn't have a `LineStudentDirectoryRow`, only resolver target data)
- **Files modified:** `src/lib/line/student-links.ts`

## Known Stubs

None — all data paths are wired to real DB queries. The `dryRun=true` mode returns actual computed matches (not mocked), just without DB writes.

## Threat Flags

No new threat surface beyond what was in the plan's threat model. The `evidence.originalUrl` field (containing `chat.line.biz` URLs) is stored in JSONB and gated behind admin-session auth on all read paths — same accepted risk as T-12-12.

## Test Results

- Unit tests: 1148 passing / 0 failing (163 test files)
- TypeScript: clean (`tsc --noEmit` exit 0)
- Integration tests: skipped (Docker not available in this environment; DB-backed orchestration validated via TypeScript clean + unit mocks)
- The end-to-end recovery path (actual DB inserts + ~229 expected suggestions) is gated behind the Phase 12 Plan 04 production dry-run checkpoint

## Self-Check: PASSED

Files exist:
- `src/lib/line/backlog-recovery.ts` — FOUND
- `src/lib/line/student-links.ts` — FOUND (modified)
- `src/app/api/line/contacts/followers-reanchor/route.ts` — FOUND (modified)

Commits exist:
- `56337fc` — Task 1 (student-links.ts)
- `10511dc` — Task 2 (backlog-recovery.ts)
- `b64698a` — Task 3 (C1 route + test)
