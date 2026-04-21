---
phase: 06-mod-01-reliable-modality-detection
reviewed: 2026-04-21T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - src/app/(app)/data-health/page.tsx
  - src/app/api/data-health/__tests__/modality-counter.test.ts
  - src/app/api/data-health/modality-counter.ts
  - src/app/api/data-health/route.ts
  - src/components/compare/calendar-grid.tsx
  - src/components/compare/modality-display.ts
  - src/components/compare/week-overview.tsx
  - src/hooks/use-compare.ts
  - src/lib/search/__tests__/compare.test.ts
  - src/lib/search/cache-version.ts
  - src/lib/search/compare.ts
  - src/lib/search/types.ts
  - src/lib/sync/orchestrator.ts
findings:
  critical: 0
  warning: 3
  info: 6
  total: 9
status: issues_found
---

# Phase 06 (MOD-01): Code Review Report

**Reviewed:** 2026-04-21
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Reviewed the MOD-01 "reliable modality detection" phase implementation: a new confidence-graded `resolveSessionModality` (with high/low tiers), a sync-time `detectSessionModalityConflict` that writes `conflict_model` data_issues, the /data-health counter extension that folds group-level + session-level modality issues together, and the UI mapping in `modality-display.ts`. Supporting pieces include the client cache-version constant, an updated `CompareSessionBlock` shape, and a 17-case merge-gate matrix in the compare test.

**Overall assessment:** the core resolver logic is well-designed and the test matrix is thorough. Contradictions are wired correctly from `resolveSessionModality` through `detectSessionModalityConflict` to the /data-health UI. Fail-closed rules hold (every `unknown` branch has test coverage). No security issues.

The findings below are correctness gaps and maintainability concerns — none block ship, but WR-01 and WR-02 are worth addressing before the next phase compounds them.

## Warnings

### WR-01: `applyColumnCap` over-groups non-overlapping sessions that happen to share a `totalColumns` value

**File:** `src/components/compare/week-overview.tsx:176-183`
**Issue:** `applyColumnCap` groups sessions by `layout[i].totalColumns` under the comment "sessions in the same overlap cluster share this [value]." The converse is not true — two temporally disjoint overlap clusters can both produce `totalColumns = 3` (e.g., three overlapping 9-10 AM sessions and three unrelated overlapping 4-5 PM sessions on the same day). The current code merges those into a single `indices[]` list and then, under the `maxCols` hide path, counts overflow across clusters via a post-hoc temporal overlap check. The overflow count works out right because of the `sessions[hIdx].startMinute < sessions[idx].endMinute && sessions[hIdx].endMinute > sessions[idx].startMinute` guard at lines 205-208, but the design is fragile: if a future change (e.g., "hide sessions in the last visible column if their duration is too short") iterates over `indices` without the explicit overlap guard, it will silently treat separate clusters as one.

This is not a live user-visible bug in the current lane layout (2/3-column caps). It is latent.

**Fix:** Either compute group keys from the union-find roots already built in `computeOverlapColumns` and pass them through on `LayoutInfo`, or document the invariant inline and keep the overlap guard in any future iteration inside this function.

```ts
// In computeOverlapColumns, expose the root as part of LayoutInfo:
interface LayoutInfo {
  column: number;
  totalColumns: number;
  groupRoot: number; // index of the union-find root — unique per overlap cluster
}

// Then in applyColumnCap:
const groups = new Map<number, number[]>(); // groupRoot -> indices
for (let i = 0; i < layout.length; i++) {
  const key = layout[i].groupRoot;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(i);
}
```

### WR-02: `resolveSessionModality` silently drops contradictions when `teacherRecord` is missing

**File:** `src/lib/search/compare.ts:78, 102-130`
**Issue:** The paired-group branch is guarded by `if (isPaired && teacherRecord)` — if a session references a `wiseTeacherId` that is not in the group's `wiseRecords` list (orphan session), the branch is skipped and execution falls through to the single-record checks. For a paired group (where both `isSingleOnline` and `isSingleOnsite` are false), execution then falls into step 3 and returns `{ modality: "unknown", confidence: "low" }` with **no contradiction payload** — so no `conflict_model` issue is ever emitted for that session, even if there is real data disagreement.

This is a fail-closed outcome on the UI (correct), but it silently hides what is actually a data-integrity problem (orphan session). Worse, the sync-time counterpart `detectSessionModalityConflict` in `orchestrator.ts:361` explicitly skips these sessions via `if (!member) continue;` — so they never appear in the admin-facing "Modality issues" counter either. A tutor with corrupt session-to-record linkage will be invisible.

The same fall-through applies to single-record groups when `teacherRecord` is absent: the `isSingleOnline`/`isSingleOnsite` branches still fire on `modes.length` alone, so if the session's `sessionType` contradicts the single mode, the contradiction IS emitted — but the `recordIsOnline` field in the payload will be `null`. This is inconsistent with the orchestrator side (which uses `member.isOnlineVariant` directly and skips orphans entirely) and inconsistent with the test matrix (every test fixture has the teacherId pointing at a valid record).

**Fix:** Decide policy and make both resolver paths agree.

Option A (recommended — surface the orphan as its own issue class):
```ts
// src/lib/search/compare.ts — add orphan detection at top of resolveSessionModality
if (!teacherRecord) {
  return {
    modality: "unknown",
    confidence: "low",
    contradiction: {
      message: `Session ${session.wiseTeacherId ?? "<missing>"} references a teacher not in group "${group.displayName}"`,
      isOnlineVariant: null,
      sessionType: normalizedType ?? "",
    },
  };
}
```
And emit this as a new `data_issue` type (e.g., `orphan_session`) from the orchestrator.

Option B (minimum — at least log as completeness issue at sync time):
```ts
// orchestrator.ts — replace the silent `if (!member) continue;` at line 362
if (!member) {
  allIssues.push({
    snapshotId,
    type: "completeness",
    severity: "high",
    entityType: "future_session_block",
    entityId: session.wiseSessionId,
    entityName: group.displayName,
    message: `Session ${session.wiseSessionId} references teacher ${session.wiseTeacherId} not in group`,
  });
  continue;
}
```

### WR-03: /data-health /api route lacks HTTP cache headers despite being a dashboard poll

**File:** `src/app/api/data-health/route.ts:115-143`
**Issue:** The route performs 5 sequential DB queries (`lastSuccess`, `lastFailure`, `activeSnapshot`, `snapshotStat`, `issues`, `recentSyncs`) on every GET. There is no `Cache-Control` response header set. If an admin leaves `/data-health` open in a tab, Next.js's default behavior in production for a route that takes no request parameters and does DB reads may or may not memoize (depends on Next 16 defaults for dynamic routes with `auth()`) — in practice `await auth()` forces dynamic rendering, so every hit runs all 6 queries.

This is not a bug — the page loads, the data is correct. But the full-issue `SELECT` at line 81 (`issues = db.select().from(dataIssues).where(snapshotId = X)`) returns every row in the table for the active snapshot (`>251` rows on the live tenant per AGENTS.md). The endpoint does not page or cap. With the MOD-01 session-level contradictions adding rows, the issue count can grow large enough that round-trip time on every `/data-health` visit is noticeable.

**Fix:** Return a short `Cache-Control: private, max-age=30` header for authenticated admin users so a single tab refresh doesn't re-run 6 queries. If real-time accuracy is required, skip this. Alternatively, cap the issues SELECT at a sane top-N (500) with an ORDER BY severity + createdAt.

```ts
return NextResponse.json({...}, {
  headers: {
    "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
  },
});
```

Note: keep the 401 path without the caching header (it already short-circuits before the DB calls).

## Info

### IN-01: Comment in `modality-counter.ts:14-16` duplicates info already in `route.ts:22-24`

**File:** `src/app/api/data-health/modality-counter.ts:14-16`, `src/app/api/data-health/route.ts:22-24`
**Issue:** The rationale block ("Lives in a dedicated module… Vitest's bare Node resolver") appears verbatim in both files. Good intent (future-reader discoverability), but if one is edited and the other isn't, they drift.

**Fix:** Keep it once, in `modality-counter.ts` (the canonical location); `route.ts` can reference with a one-liner: `See modality-counter.ts for rationale.`

### IN-02: `selectModalityIssues` return type differs slightly from the `unresolvedModality` type declared in `DataHealthPage`

**File:** `src/app/api/data-health/modality-counter.ts:22-23`, `src/app/(app)/data-health/page.tsx:33-37`
**Issue:** Helper returns `{ entityName: string; message: string; issueType: string }[]`. Page interface declares `issueType: string; // "modality" | "conflict_model"`. These are compatible at the TS level, but the page narrows with `m.issueType === "conflict_model"` (ternary on line 264-267 and 269); if any new `data_issue_type` is added and `selectModalityIssues`'s filter is widened to include it, the UI will render the wrong "group"/"session" label for it. No test catches this because the filter is narrow.

**Fix:** Promote the union to a named type and share it.

```ts
// shared somewhere (e.g., modality-counter.ts):
export type ModalityIssueType = "modality" | "conflict_model";
export function selectModalityIssues<...>(issues: T[]): { ...; issueType: ModalityIssueType }[]
```

### IN-03: Orchestrator's second pass rebuilds `groupSessions` using a new `memberByTeacherId` Map when a `Set<string>` would do

**File:** `src/lib/sync/orchestrator.ts:355-361`
**Issue:** Line 356 builds `memberByTeacherId` as a `Map<string, Member>`, only to use it as a membership test at line 357 (`memberByTeacherId.has(s.wiseTeacherId)`) and then a lookup at line 361. The lookup is the only real use. The filter at line 357 could just `.some(m => m.wiseTeacherId === s.wiseTeacherId)` or use a precomputed `Set`. Not a bug — minor allocation and style.

**Fix:** If the current shape is clearer for future readers, leave it. Otherwise:
```ts
const memberById = new Map(group.members.map((m) => [m.wiseTeacherId, m]));
const groupSessions = sessionBlocks.filter((s) => memberById.has(s.wiseTeacherId));
// ...later:
const member = memberById.get(session.wiseTeacherId);
```
The current code is functionally identical — this is purely a readability nit.

### IN-04: `CompareSessionBlock.modalityConfidence` type includes `"medium"` but emitter never uses it

**File:** `src/lib/search/types.ts:122`, `src/lib/search/compare.ts:27-44`
**Issue:** Type declares `modalityConfidence: "high" | "medium" | "low"`. MOD-01 never emits `"medium"` (D-03, covered by test `never emits \`medium\` confidence tier in MOD-01`). The `modalityDisplay` helper in `modality-display.ts:14` accepts all three but only branches on `low` vs not-low. A future phase (per the `TODO(future phase)` comment at `modality-display.ts:9-10`) will add `"medium"` semantics, but today the type is wider than any value that can exist.

This is intentional forward-compatibility and explicitly documented — flagging as Info only.

**Fix (optional, reinforces fail-closed):** Narrow the type today and widen it when MOD-02 ships:
```ts
modalityConfidence: "high" | "low";
```
Keeps the type honest and forces the next phase to consciously re-widen. Against this: the current type prevents a type-break when MOD-02 lands. Either choice is defensible — leaving as-is is fine.

### IN-05: `CACHE_VERSION = "v1"` with no prior value — bump policy is documented but the current constant is the first

**File:** `src/lib/search/cache-version.ts:13`
**Issue:** The doc comment says "Bump this string whenever the shape of `CompareTutor` / `CompareSessionBlock` / any client-cached server shape changes." MOD-01 changes `CompareSessionBlock` (adds `modality`, `modalityConfidence` as required fields — see `types.ts:121-122`). But `CACHE_VERSION` was introduced simultaneously (commit 17daef1) as part of this phase, and the type changes (commit e99e3db) also landed in this phase. There is no "v0" to invalidate. So "v1" is correct for the first release.

Flagging only so the next phase reviewer (PAST-01 / VPOL-03) remembers to bump to "v2" per the documented rule.

**Fix:** None. The comment at line 8-10 already names the next phase owners.

### IN-06: `detectSessionModalityConflict` duplicates the contradiction-message formatting in `resolveSessionModality`

**File:** `src/lib/search/compare.ts:87-95` and `src/lib/search/compare.ts:159-183`
**Issue:** The three contradiction message templates
(`Paired group "..." has contradicting modality signals: teacher record isOnlineVariant=... but session sessionType="..."`,
`Single-record online group "..." has contradicting sessionType="..."`,
`Single-record onsite group "..." has contradicting sessionType="..."`)
appear once in `resolveSessionModality` (runtime UI path) and once in `detectSessionModalityConflict` (sync-time data-issues path). The test matrix asserts the message format on both sides. If the wording ever changes in one place and not the other, the resolver's `contradiction.message` and the `data_issues.message` drift apart, making debugging harder for admins.

**Fix:** Extract the three templates to a shared helper, e.g.:
```ts
const CONTRADICTION_MESSAGES = {
  pairedGroup: (name: string, iov: boolean, type: string) =>
    `Paired group "${name}" has contradicting modality signals: teacher record isOnlineVariant=${iov} but session sessionType="${type}"`,
  singleOnline: (name: string, type: string) =>
    `Single-record online group "${name}" has contradicting sessionType="${type}"`,
  singleOnsite: (name: string, type: string) =>
    `Single-record onsite group "${name}" has contradicting sessionType="${type}"`,
};
```
Then both sites call the same helper. Test matrix still passes unchanged. Low priority; only matters if the message strings get edited.

---

_Reviewed: 2026-04-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
