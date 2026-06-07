---
phase: 11-ident-01-webhook-side-line-identity-resolution
plan: "03"
subsystem: line
tags: [name-matching, identity-resolution, fail-closed, phantom-filter, student-links, review-service]

# Dependency graph
requires:
  - "11-01 isPhantom column in schema"
  - "11-02 matchNamesToDirectory from name-matcher.ts"
provides:
  - "ensureLineContactStudentLinkSuggestions extended with optional names param calling matchNamesToDirectory"
  - "studentLinkEvidence source union includes message_content and line_followers"
  - "listVerifiedLineStudentKeys filters isPhantom=false (phantom rows excluded from verified count)"
  - "processLineMessageForScheduler reads extractedState and passes names to ensureLineContactStudentLinkSuggestions"
affects: [11-04 followers-reanchor, 11-05 link-validation phantom scope, 11-06 recompute]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive parameter extension: optional 4th param preserves existing signature callers"
    - "Fail-closed: name-matched inserts always status='suggested', sourceKind='message_content' — no path to 'verified'"
    - "DB-param discipline: extractedState read using the db param already in scope (never getDb())"
    - "isPhantom filter at DB layer (WHERE clause) not at application layer — correct for SQL-level exclusion"

key-files:
  created: []
  modified:
    - src/lib/line/student-links.ts
    - src/lib/line/review-service.ts
    - src/lib/line/__tests__/student-links.test.ts

key-decisions:
  - "Removed the early-return short-circuit (if matches.length === 0 return) from ensureLineContactStudentLinkSuggestions so the name-matching block always runs when names param is provided"
  - "Type-guard extractedState fields with typeof === 'string' before use (T-11-09 mitigation)"
  - "isPhantom filter placed in WHERE clause alongside status='verified' — DB excludes phantoms, not application layer"

requirements-completed: [IDENT-01, IDENT-02]

# Metrics
duration: ~25min
completed: 2026-06-07
---

# Phase 11 / Plan 03: Name Matcher Wiring Summary

**Wired the deterministic name matcher into the student-link suggestion pipeline: ensureLineContactStudentLinkSuggestions now accepts AI-extracted names and inserts scored candidates as status='suggested' with sourceKind='message_content'; listVerifiedLineStudentKeys excludes phantom rows via isPhantom=false filter.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-06-07
- **Tasks:** 2 (TDD: RED tests + GREEN implementation for Task 1; Task 2 additive wire)
- **Files modified:** 3

## Accomplishments

- `studentLinkEvidence` source union extended with `"message_content"` and `"line_followers"`
- `ensureLineContactStudentLinkSuggestions` adds optional 4th param `names`; when provided, calls `matchNamesToDirectory` and inserts all candidates with score >= `SUGGEST_SHORTLIST_MIN_SCORE` as `status='suggested'`, `sourceKind='message_content'` — fail-closed, never `'verified'`
- `listVerifiedLineStudentKeys` now filters `isPhantom = false` in the WHERE clause; `hasVerifiedLineStudentLink` inherits the fix by delegating to `listVerifiedLineStudentKeys`
- `processLineMessageForScheduler` reads `extractedState` from `aiSchedulerConversations` using the `db` parameter already in scope (never a second `getDb()` call), extracts `studentName`/`parentName` with `typeof === 'string'` guards, passes as `extractedNames` to `ensureLineContactStudentLinkSuggestions`
- 4 new test cases in `student-links.test.ts` + `makeSelectDb` DB mock helper

## Task Commits

1. **RED — failing tests for isPhantom filter and source kinds** - `cf4ad48` (test)
2. **GREEN — student-links.ts implementation** - `bde4d43` (feat)
3. **GREEN — review-service.ts wiring** - `0e384bc` (feat)

## Files Created/Modified

- `src/lib/line/student-links.ts` — ~39 lines added: import, source union extension, names param, name-matcher block (IDENT-01/IDENT-02), isPhantom filter (IDENT-05)
- `src/lib/line/review-service.ts` — ~24 lines added: eq/schema imports, extractedState read block, extractedNames 4th arg
- `src/lib/line/__tests__/student-links.test.ts` — ~71 lines added: Database import, makeSelectDb helper, 4 new test cases

## Test Results

- **161 test files, 1099 tests — all pass** (npm test green)
- New cases: 4 listVerifiedLineStudentKeys cases + 1 studentLinkEvidence compile-time guard

## Deviations from Plan

### Design refinement (within plan latitude)

**1. [Rule 1 - Bug] Removed early-return short-circuit from ensureLineContactStudentLinkSuggestions**

- **Found during:** Task 2 implementation review
- **Issue:** Original function had `if (matches.length === 0) return listLineContactStudentLinks(db, contactId)` before the name-based block; this would skip name matching entirely when no code-based matches were found (the common case for message_content)
- **Fix:** Removed the early return so code-based inserts always run (iterating over an empty array is a no-op), then name-based matching block always executes when `names` is provided
- **Files modified:** `src/lib/line/student-links.ts`
- **Commit:** `bde4d43`

## Known Stubs

None — all paths are wired to real implementation.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| T-11-08 mitigated | `src/lib/line/student-links.ts` | status='suggested' hard-coded in name-match insert; comment "NEVER verified from content (IDENT-02)" |
| T-11-09 mitigated | `src/lib/line/review-service.ts` | typeof === 'string' guards on extractedState.studentName/.parentName before use |
| T-11-10 mitigated | `src/lib/line/student-links.ts` | listVerifiedLineStudentKeys now has isPhantom=false filter; hasVerifiedLineStudentLink inherits fix |

---

## Self-Check: PASSED

- `src/lib/line/student-links.ts` — FOUND
- `src/lib/line/review-service.ts` — FOUND
- `src/lib/line/__tests__/student-links.test.ts` — FOUND
- Commits cf4ad48, bde4d43, 0e384bc — all present in git log
- `npm test` — 161 files, 1099 tests, all green

*Phase: 11-ident-01-webhook-side-line-identity-resolution*
*Completed: 2026-06-07*
