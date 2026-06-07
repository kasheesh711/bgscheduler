---
phase: "12"
plan: "01"
subsystem: "line-identity"
tags: ["backlog-recovery", "pure-function", "identity-matching", "ident-07"]
dependency_graph:
  requires: []
  provides:
    - "src/lib/line/backlog-matcher.ts — distinctiveTokens, buildTargetTokenIndex, matchFollowersToTargets, VerifiedResolverTarget, BacklogMatchResult"
  affects:
    - "src/lib/line/__tests__/backlog-matcher.test.ts — 28 unit tests"
tech_stack:
  added: []
  patterns:
    - "em-dash section separators (mirrors name-matcher.ts)"
    - "pure-function module with zero DB imports (IDENT-07 fail-closed pattern)"
    - "nicknameCodes inlined as extractNicknameCodes (Wave-1 constraint; exported in Plan 03)"
key_files:
  created:
    - "src/lib/line/backlog-matcher.ts"
    - "src/lib/line/__tests__/backlog-matcher.test.ts"
  modified: []
decisions:
  - "Inlined extractNicknameCodes instead of importing from student-links.ts — nicknameCodes is unexported in Wave-1; the export is added in Plan 03 (student-links.ts modifications)"
  - "VerifiedResolverTarget defined in backlog-matcher.ts as the canonical input type — mirrors name-matcher.ts pattern of defining its own input interface"
  - "Deduplication in distinctiveTokens uses an ordered Set — space tokens first, then nickname-code tokens, preserving insertion order"
metrics:
  duration: "4m (17:35-17:39 UTC)"
  completed_date: "2026-06-07"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
  tests_added: 28
  test_baseline: 1119
  test_final: 1147
---

# Phase 12 Plan 01: Backlog Matcher — Pure Distinctive-Token Matching Summary

Pure distinctive-token matcher (`backlog-matcher.ts`) for LINE backlog identity recovery — zero DB imports, three exported functions, 28 passing unit tests.

## What Was Built

**`src/lib/line/backlog-matcher.ts`** — Pure TypeScript module with three exported functions:

1. `distinctiveTokens(name)` — Extracts ≥4-char tokens from a display name string using `normalizeForNameMatch` (space-preserving) + `normalizeLineStudentCode` per token, plus nickname-codes from `(…)` regex. Returns deduplicated array.

2. `buildTargetTokenIndex(targets)` — Builds `Map<normalizedToken, Set<studentKey>>` from `VerifiedResolverTarget[]` rows. Indexes studentName tokens, parentName tokens, and searchCode nickname-codes.

3. `matchFollowersToTargets(followers, index, targetsByStudentKey)` — For each follower with a non-empty displayName: extract distinctive tokens, union index hits, emit `confidence: "high"` for exactly one matched studentKey or `confidence: "ambiguous"` (one result per key, never collapsed) for 2+ matches.

**`src/lib/line/__tests__/backlog-matcher.test.ts`** — 28 unit tests covering:
- `distinctiveTokens`: 9 cases (≥4-char filter, (…) extraction, Thai/English, empty, dedup)
- `buildTargetTokenIndex`: 7 cases (studentName, parentName, searchCode, short-token exclusion, shared tokens)
- `matchFollowersToTargets`: 12 cases (unambiguous → "high", ambiguous → "ambiguous" per key, no match, empty displayName, undefined displayName, null lineChatUrl, fail-closed invariant, empty followers, empty index)

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create backlog-matcher.ts | 65787d6 | src/lib/line/backlog-matcher.ts |
| 2 | Create backlog-matcher.test.ts | 89ad5d3 | src/lib/line/__tests__/backlog-matcher.test.ts |

## Key Decisions

- **Wave-1 nicknameCodes inlining:** `extractNicknameCodes` is inlined in `backlog-matcher.ts` rather than imported from `student-links.ts` because `nicknameCodes` is unexported in Wave-1. Plan 03 (student-links.ts modifications) exports it; Plan 04 (Wave-2) can switch the import. This avoids breaking Wave-1.
- **VerifiedResolverTarget ownership:** Defined canonically in `backlog-matcher.ts` (the matcher's input type), not in `student-links.ts`. `listVerifiedResolverTargets` (Plan 03) returns rows that conform to this interface.
- **Ambiguous handling:** Two separate `BacklogMatchResult` items are produced (one per matched studentKey) — never a single collapsed result. This is enforced at the type level and verified by test.

## Deviations from Plan

None — plan executed exactly as written. The key constraint (INLINE nicknameCodes instead of importing) was pre-resolved in the plan's `<key_constraints>` section and implemented accordingly.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. This plan is a pure-function module with zero side effects and zero DB access — no new threat surface.

## Self-Check: PASSED

- [x] `src/lib/line/backlog-matcher.ts` — FOUND
- [x] `src/lib/line/__tests__/backlog-matcher.test.ts` — FOUND
- [x] commit 65787d6 — FOUND in git log
- [x] commit 89ad5d3 — FOUND in git log
- [x] `grep -c "import.*from.*@/lib/db" backlog-matcher.ts` → 0 (no DB imports)
- [x] `grep -c "^export function" backlog-matcher.ts` → 3 (three exported functions)
- [x] 28 tests pass; 1147 total tests (1119 baseline + 28 new)
- [x] `npx tsc --noEmit` → exit 0
- [x] `npx eslint` on both files → exit 0
