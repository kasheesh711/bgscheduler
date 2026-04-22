---
phase: 07-past-01-past-day-session-visibility
plan: 04
type: execute
wave: 2
depends_on:
  - 01
files_modified:
  - src/lib/search/index.ts
  - src/lib/search/compare.ts
  - src/lib/search/__tests__/compare.test.ts
autonomous: true
requirements:
  - PAST-01
  - PAST-04

must_haves:
  truths:
    - "`IndexedTutorGroup` exposes `canonicalKey: string` populated from `tutor_identity_groups.canonical_key` at index-build time — one-field additive change (D-18 permits)"
    - "`buildCompareTutor` accepts an optional `pastBlocks?: IndexedSessionBlock[]` parameter; past blocks merged with `group.sessionBlocks` BEFORE the filter/fallback pipeline (D-06)"
    - "Per-weekday `isHistoricalRange` check (D-05): weekdays whose calendar date is before startOfToday(Asia/Bangkok) DO NOT get the nearest-future-occurrence fallback (PAST-04 / Pitfall 6)"
    - "Today + future days retain the existing weekday-fallback behavior (backward-compatible for current-week view on not-yet-elapsed days)"
    - "`detectConflicts` sees past+future sessions in the returned `CompareTutor.sessions` transparently (name-based keying unchanged per Pitfall 13)"
    - "No change to `buildIndex` / `ensureIndex` — past data stays OUT of SearchIndex singleton (D-18)"
  artifacts:
    - path: "src/lib/search/index.ts"
      provides: "IndexedTutorGroup.canonicalKey exposure (additive single-field change)"
      contains: "canonicalKey: string"
    - path: "src/lib/search/compare.ts"
      provides: "buildCompareTutor with optional pastBlocks parameter + per-weekday historical flag + helper functions"
      contains: "pastBlocks?: IndexedSessionBlock[]"
    - path: "src/lib/search/__tests__/compare.test.ts"
      provides: "Extended test matrix for merge + per-weekday flag + past-in-detectConflicts"
      contains: "pastBlocks"
  key_links:
    - from: "src/lib/search/index.ts (buildIndex mapping, ~line 192)"
      to: "IndexedTutorGroup.canonicalKey"
      via: "group.canonicalKey from the already-SELECTed tutor_identity_groups row"
      pattern: "canonicalKey: group\\.canonicalKey"
    - from: "src/lib/search/compare.ts buildCompareTutor"
      to: "fallback loop per-weekday historical check"
      via: "getStartOfTodayBkk() + computeDateForWeekdayInRange(weekday, dateRange)"
      pattern: "dateForWeekday < startOfTodayBkk"
---

<objective>
Teach `buildCompareTutor` to merge past session blocks with live future blocks (D-06) and to disable the nearest-future-occurrence fallback for historical weekdays (D-05, PAST-04). Also expose `canonicalKey` on `IndexedTutorGroup` (research Pitfall 17) so Plan 05's `/api/compare` route can pass canonical keys to `fetchPastSessionBlocks` without an extra DB query.

Purpose: PAST-01 (prior-week compare shows real captured data) + PAST-04 (weekday-fallback disabled for past days). Transparent extension — downstream functions (`detectConflicts`, `findSharedFreeSlots`, `weeklyHoursBooked`, `studentCount`) consume the unified session list with zero signature changes.

Output: One-line `canonicalKey` addition to `IndexedTutorGroup` + interface; `buildCompareTutor` signature extension + per-weekday flag + two new helpers (`getStartOfTodayBkk`, `computeDateForWeekdayInRange`); extended compare.test.ts.
</objective>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| pastBlocks parameter → merge input | Already-validated via Plan 03 fetcher (DB-typed) |
| dateRange → per-weekday date computation | Parsed by /api/compare route via parseMondayDate (existing validation) |
| canonicalKey field → IndexedTutorGroup | Read-only copy from DB row (existing Drizzle typing) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-04-01 | Tampering | Caller passes hostile pastBlocks | accept | Callers are server-side only (/api/compare in Plan 05); pastBlocks originate from Drizzle-typed DB reads via Plan 03 fetcher. No client input path. |
| T-07-04-02 | Information Disclosure | Exposing canonicalKey in a client-facing response | mitigate | `canonicalKey` is added to the internal `IndexedTutorGroup` type only; `CompareTutor` (the API response shape at `src/lib/search/types.ts`) remains unchanged — canonical keys are NOT serialized to the client. |
| T-07-04-03 | Denial of Service | Large pastBlocks array makes filter pipeline O(N²) | mitigate | Plan 03 fetcher queries a bounded 7-day range; expected per-tutor past block count per query ≤100. Filter pipeline is O(N); no quadratic operation introduced. |
| T-07-04-04 | Elevation of Privilege | Historical boundary computed server-side with Asia/Bangkok zone drift | mitigate | `toZonedTime(..., "Asia/Bangkok")` from `date-fns-tz` already in repo; BKK has no DST (PITFALLS.md A7). |
| T-07-04-05 | Tampering | Developer "simplifies" per-weekday flag to binary range-level flag | mitigate | Test case 6 below explicitly asserts mixed-week behavior (Mon past, Fri future, per-day enforcement). Removing per-day logic breaks the test. |

All LOW. No HIGH severity threats.
</threat_model>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md
@.planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md
@src/lib/search/index.ts
@src/lib/search/compare.ts
@src/lib/search/__tests__/compare.test.ts

<interfaces>
<!-- Current signatures that need to be extended -->

From src/lib/search/index.ts (lines 55-65) — current IndexedTutorGroup:
```typescript
export interface IndexedTutorGroup {
  id: string;
  displayName: string;
  supportedModes: string[];
  qualifications: IndexedQualification[];
  wiseRecords: IndexedWiseRecord[];
  availabilityWindows: IndexedAvailabilityWindow[];
  leaves: IndexedLeave[];
  sessionBlocks: IndexedSessionBlock[];
  dataIssues: IndexedDataIssue[];
  // NEW: canonicalKey: string;   ← Task 1 adds this
}
```

From src/lib/search/index.ts (lines 192-244) — buildIndex mapping block; line 192-193 is where to add the `canonicalKey` field from the already-SELECTed `group.canonicalKey` (read at line 125-128 of the prior SELECT).

From src/lib/search/compare.ts (lines 188-233) — current buildCompareTutor (refactor target):
```typescript
export function buildCompareTutor(
  group: IndexedTutorGroup,
  weekdays?: number[],
  dateRange?: DateRange,
): CompareTutor {
  const weekdaySet = weekdays ? new Set(weekdays) : null;
  const filtered = group.sessionBlocks.filter((s) => { ... });
  if (dateRange) {
    // ... weekday-fallback loop with no historical check
  }
  // ... mapping to CompareSessionBlock ...
}
```

`date-fns-tz` is already a dep (package.json) and already used in `src/lib/normalization/timezone.ts`.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Expose canonicalKey on IndexedTutorGroup (index.ts one-field addition)</name>
  <files>src/lib/search/index.ts</files>
  <read_first>
    - src/lib/search/index.ts (full file — especially lines 55-65 interface, 110-267 buildIndex, 184-244 tutorGroup mapping)
  </read_first>
  <action>
Make two minimal changes to `src/lib/search/index.ts`:

**Change 1 — Extend the `IndexedTutorGroup` interface at lines 55-65:**

Add `canonicalKey: string;` as a new field. After the change, the interface reads:

```typescript
export interface IndexedTutorGroup {
  id: string;
  canonicalKey: string;  // NEW — D-04 cross-snapshot anchor, denormalized from tutor_identity_groups.canonical_key
  displayName: string;
  supportedModes: string[];
  qualifications: IndexedQualification[];
  wiseRecords: IndexedWiseRecord[];
  availabilityWindows: IndexedAvailabilityWindow[];
  leaves: IndexedLeave[];
  sessionBlocks: IndexedSessionBlock[];
  dataIssues: IndexedDataIssue[];
}
```

**Change 2 — Populate `canonicalKey` in the `buildIndex` mapping at lines 192-244:**

Inside the `.map((group) => { ... return { ... } })` block, add `canonicalKey: group.canonicalKey,` as a field in the returned object. The `group` variable already holds the Drizzle row from the SELECT at line 125-128, which includes `canonicalKey` per `tutor_identity_groups.canonicalKey`. After the change, the returned object at line 192 reads (abbreviated):

```typescript
    return {
      id: group.id,
      canonicalKey: group.canonicalKey,  // NEW
      displayName: group.displayName,
      supportedModes: /* ... existing ... */,
      // ... rest unchanged ...
    };
```

Do NOT add any new DB query. Do NOT alter `buildIndex`'s parallel-load block (lines 131-156). Do NOT change `ensureIndex`. Do NOT reference `past_session_blocks` or `pastSessionBlocks` anywhere in this file (regression guard — Pitfall 5 + D-18).
  </action>
  <verify>
    <automated>grep -c "canonicalKey: string" src/lib/search/index.ts && grep -c "canonicalKey: group.canonicalKey" src/lib/search/index.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "canonicalKey: string" src/lib/search/index.ts` returns `1` (interface declaration)
    - `grep -c "canonicalKey: group.canonicalKey" src/lib/search/index.ts` returns `1` (mapping population)
    - `grep -c "past_session_blocks\|pastSessionBlocks" src/lib/search/index.ts` returns `0` (REGRESSION GUARD for D-18)
    - `grep -c "export interface IndexedTutorGroup" src/lib/search/index.ts` returns `1` (no accidental duplication)
    - `npx tsc --noEmit 2>&1 | grep -c "error TS" | head -1` returns `0`
    - `npm test --run 2>&1 | grep -E "Tests.*passed" | head -1` shows no decrease vs baseline
  </acceptance_criteria>
  <done>IndexedTutorGroup has canonicalKey field; buildIndex populates it from the existing SELECT; no SearchIndex bloat.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Refactor buildCompareTutor with pastBlocks + per-weekday historical flag</name>
  <files>src/lib/search/compare.ts, src/lib/search/__tests__/compare.test.ts</files>
  <read_first>
    - src/lib/search/compare.ts (full file — refactor target lines 188-261)
    - src/lib/search/__tests__/compare.test.ts (existing test file — for extension pattern, fixture helpers)
    - .planning/phases/07-past-01-past-day-session-visibility/07-RESEARCH.md §"Pattern 4: `buildCompareTutor` extension" (code blueprint)
    - .planning/phases/07-past-01-past-day-session-visibility/07-CONTEXT.md §D-05 (per-weekday flag), §D-06 (merge before fallback)
  </read_first>
  <behavior>
    - Test 1: Historical week, tutor has past_session_blocks on Monday but not Tuesday → returned `sessions` includes Monday past data AND Tuesday is EMPTY (no fallback). Explicitly asserts the absence of future-week Tuesday data in the Tuesday slot.
    - Test 2: Historical week, no past data at all → returned `sessions` is empty (honest empty per D-09). No fallback appears.
    - Test 3: Future week (dateRange entirely in the future), no past data → existing weekday-fallback behavior preserved (current behavior: Monday with no sessions pulls nearest-future Monday). Validates backward compatibility.
    - Test 4: Current week where Monday is past + Tuesday is today + Wednesday is future, tutor has past data only on Monday → Monday shows captured data, Tuesday shows fallback (if empty), Wednesday shows fallback. Asserts PER-WEEKDAY enforcement (D-05 — the rule that distinguishes Phase 7 from "fully historical binary flag").
    - Test 5: `buildCompareTutor` called WITHOUT pastBlocks → behaves exactly like pre-Phase-7 buildCompareTutor (regression guard; all existing tests must pass unchanged).
    - Test 6 (detectConflicts interaction): Tutor A with past session 10-11am Monday for student "Alex"; Tutor B with future session 10-11am Monday for student "Alex"; same historical week. Conflict detected because past and future merged pre-conflict-detection (PITFALLS.md Pitfall 13).
  </behavior>
  <action>
Make three modifications to `src/lib/search/compare.ts`:

**Modification A — Add two helper functions near the top (after `formatDate` at line 24, before `resolveSessionModality` at line 60):**

```typescript
import { toZonedTime } from "date-fns-tz";

/**
 * Start of today (00:00) in Asia/Bangkok, returned as a Date representing
 * that BKK instant. Used by buildCompareTutor (D-05) to decide whether a
 * calendar date in the requested dateRange is "historical" (→ disable
 * weekday-fallback) or "today-or-future" (→ keep existing fallback).
 *
 * Extracted as a helper so tests can mock `Date.now()` deterministically.
 * Thailand has no DST (stable UTC+7 since 1941) per PITFALLS.md §Assumptions A7.
 */
export function getStartOfTodayBkk(now: Date = new Date()): Date {
  const nowInBkk = toZonedTime(now, "Asia/Bangkok");
  return new Date(nowInBkk.getFullYear(), nowInBkk.getMonth(), nowInBkk.getDate());
}

/**
 * Given a weekday (0=Sunday..6=Saturday) and a dateRange whose `start` is the
 * Monday of the requested week, return the calendar date within the range
 * that corresponds to that weekday, or null if the weekday falls outside the
 * range. Mirrors the client-side `getWeekDate` helper in use-compare.ts:53-59
 * to avoid off-by-one divergence.
 *
 * Weekday→offset mapping (Monday as first day of week in dateRange):
 *   Mon(1) → offset 0, Tue(2) → 1, Wed(3) → 2, Thu(4) → 3, Fri(5) → 4,
 *   Sat(6) → 5, Sun(0) → 6.
 */
export function computeDateForWeekdayInRange(weekday: number, dateRange: DateRange): Date | null {
  const offset = weekday === 0 ? 6 : weekday - 1;
  const date = new Date(
    dateRange.start.getFullYear(),
    dateRange.start.getMonth(),
    dateRange.start.getDate() + offset,
  );
  if (date < dateRange.start || date >= dateRange.end) return null;
  return date;
}
```

**Modification B — Change the `buildCompareTutor` function signature and body (current lines 188-261):**

Replace the current function with this version. The changes are:
1. Add `pastBlocks?: IndexedSessionBlock[]` parameter (fourth param).
2. Concatenate `pastBlocks ?? []` with `group.sessionBlocks` BEFORE the filter step (D-06).
3. Per-weekday `isHistoricalRange` check inside the fallback loop — skip fallback when the weekday's calendar date is before `startOfTodayBkk` (D-05 / PAST-04).

```typescript
export function buildCompareTutor(
  group: IndexedTutorGroup,
  weekdays?: number[],
  dateRange?: DateRange,
  pastBlocks?: IndexedSessionBlock[],
): CompareTutor {
  const weekdaySet = weekdays ? new Set(weekdays) : null;

  // D-06: Merge past blocks into the filter input BEFORE filtering. Past
  // blocks have already been date-range-filtered by the Plan 03 fetcher; the
  // concat is safe and does not duplicate sessions (past and future are
  // disjoint by definition — future_session_blocks have startTime >= now,
  // past_session_blocks have startTime < now at capture time).
  const allBlocks = pastBlocks && pastBlocks.length > 0
    ? [...group.sessionBlocks, ...pastBlocks]
    : group.sessionBlocks;

  const filtered = allBlocks.filter((s) => {
    if (!s.isBlocking) return false;
    if (dateRange) {
      if (s.startTime < dateRange.start || s.startTime >= dateRange.end) return false;
    }
    if (weekdaySet && !weekdaySet.has(s.weekday)) return false;
    return true;
  });

  // D-05 / PAST-04: per-weekday `isHistoricalRange` evaluation. The
  // nearest-future-occurrence fallback runs only for weekdays whose calendar
  // date is today or in the future. Past weekdays render honest empty (D-09)
  // unless we captured real past data in past_session_blocks.
  if (dateRange) {
    const startOfTodayBkk = getStartOfTodayBkk();
    const coveredWeekdays = new Set(filtered.map((s) => s.weekday));
    const targetWeekdays = weekdaySet ? new Set(weekdaySet) : new Set([0, 1, 2, 3, 4, 5, 6]);

    for (const wd of targetWeekdays) {
      if (coveredWeekdays.has(wd)) continue;

      // D-05: calendar date for this weekday within dateRange. If it's before
      // today (BKK), disable the fallback for this weekday only — honest empty.
      const dateForWeekday = computeDateForWeekdayInRange(wd, dateRange);
      if (dateForWeekday && dateForWeekday < startOfTodayBkk) continue;

      // Existing nearest-future-occurrence fallback (unchanged semantics for
      // today + future days — uses `allBlocks` so future blocks are also
      // candidates, but past blocks cannot be future-candidates since they
      // have startTime < now).
      const seenRecurrence = new Set<string>();
      const fallback = allBlocks
        .filter((s) => s.isBlocking && s.weekday === wd && s.startTime >= dateRange.end)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        .filter((s) => {
          if (s.recurrenceId) {
            if (seenRecurrence.has(s.recurrenceId)) return false;
            seenRecurrence.add(s.recurrenceId);
          }
          return true;
        });

      if (fallback.length > 0) {
        const firstDate = fallback[0].startTime.toDateString();
        filtered.push(...fallback.filter((s) => s.startTime.toDateString() === firstDate));
      }
    }
  }

  const sessions: CompareSessionBlock[] = filtered.map((s) => {
    const { modality, confidence } = resolveSessionModality(group, s);
    return {
      title: s.title, studentName: s.studentName, subject: s.subject,
      classType: s.classType, sessionType: s.sessionType, recurrenceId: s.recurrenceId, location: s.location,
      modality,
      modalityConfidence: confidence,
      startTime: formatMinute(s.startMinute), endTime: formatMinute(s.endMinute),
      date: dateRange ? formatDate(s.startTime) : undefined,
      weekday: s.weekday, startMinute: s.startMinute, endMinute: s.endMinute,
    };
  });

  const totalMinutes = filtered.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
  const studentNames = new Set(filtered.map((s) => s.studentName).filter(Boolean));

  return {
    tutorGroupId: group.id, displayName: group.displayName,
    supportedModes: group.supportedModes, qualifications: group.qualifications,
    sessions,
    availabilityWindows: group.availabilityWindows.map((w) => ({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute, modality: w.modality })),
    leaves: group.leaves.map((l) => ({ startTime: l.startTime.toISOString(), endTime: l.endTime.toISOString() })),
    dataIssues: group.dataIssues,
    weeklyHoursBooked: Math.round((totalMinutes / 60) * 100) / 100,
    studentCount: studentNames.size,
  };
}
```

Do NOT change `detectConflicts` or `findSharedFreeSlots` signatures — they receive past+future transparently via `CompareTutor.sessions` (Pitfall 13: conflicts remain name-based; Pitfall 16 is handled by Plan 05 which pre-merges into `group.sessionBlocks` at the route boundary for findSharedFreeSlots).

**Modification C — Extend `src/lib/search/__tests__/compare.test.ts` with 6 new test cases:**

Append a new `describe` block at the end of the existing compare.test.ts, using the already-present fixture helpers. The 6 cases match the behavior list above. Each test constructs an `IndexedTutorGroup` with `canonicalKey` (new required field) + a fixture set of `sessionBlocks` (future) + a separate `pastBlocks: IndexedSessionBlock[]` passed as the fourth arg to `buildCompareTutor`.

Scaffold:
```typescript
describe("buildCompareTutor past+future merge + per-weekday historical flag (Phase 7)", () => {
  // Helper: freeze system time for deterministic "today" comparisons.
  beforeEach(() => {
    // Simulate today = 2026-04-15 (Wednesday) in BKK, so past weekdays are
    // Mon 04-13 and Tue 04-14; future weekdays are Thu..Sun of the same week.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00+07:00"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("historical week: returns captured past data, no weekday-fallback for empty past days", () => { /* Test 1 */ });
  it("historical week + no past data: returns empty sessions (honest empty per D-09)", () => { /* Test 2 */ });
  it("future week + no past data: preserves existing weekday-fallback behavior", () => { /* Test 3 */ });
  it("current week: past weekdays respect captured-or-empty, future weekdays keep fallback", () => { /* Test 4 */ });
  it("backward-compat: calling without pastBlocks behaves identically to pre-Phase-7", () => { /* Test 5 */ });
  it("detectConflicts sees merged past+future sessions for same student", () => { /* Test 6 */ });
});
```

Populate the bodies with concrete assertions (session counts, weekday coverage, studentName matches). Use small fixed dates within a single known week.

Every existing test in `compare.test.ts` must continue to pass — the new parameter is optional, so tests that omit it have unchanged behavior.
  </action>
  <verify>
    <automated>npm test -- src/lib/search/__tests__/compare.test.ts --run</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "pastBlocks?: IndexedSessionBlock\\[\\]" src/lib/search/compare.ts` returns `1`
    - `grep -c "export function getStartOfTodayBkk" src/lib/search/compare.ts` returns `1`
    - `grep -c "export function computeDateForWeekdayInRange" src/lib/search/compare.ts` returns `1`
    - `grep -c "if (dateForWeekday && dateForWeekday < startOfTodayBkk) continue" src/lib/search/compare.ts` returns `1`
    - `grep -c "const allBlocks = pastBlocks && pastBlocks.length > 0" src/lib/search/compare.ts` returns `1`
    - `grep -c "toZonedTime" src/lib/search/compare.ts` returns `1`
    - `grep -c "describe(\"buildCompareTutor past\\+future merge" src/lib/search/__tests__/compare.test.ts` returns `1`
    - `grep -c "it(\"" src/lib/search/__tests__/compare.test.ts` returns baseline+6 or more
    - `npm test -- src/lib/search/__tests__/compare.test.ts --run` exits `0` with all tests passing
    - `npm test --run 2>&1 | tail -5 | grep -E "Tests.*passed" ` shows total ≥ baseline+6
    - `grep -c "past_session_blocks\\|pastSessionBlocks" src/lib/search/index.ts` returns `0` (regression guard D-18)
  </acceptance_criteria>
  <done>buildCompareTutor merges past+future, honors per-weekday historical flag, passes 6 new tests + all existing tests.</done>
</task>

</tasks>

<verification>
- `npm test --run` passes with baseline+6 tests
- `grep -c "canonicalKey" src/lib/search/index.ts` returns `2` (interface + mapping)
- `grep -c "past_session_blocks\\|pastSessionBlocks" src/lib/search/index.ts` returns `0`
- `grep -c "dateForWeekday < startOfTodayBkk" src/lib/search/compare.ts` returns `1`
</verification>

<success_criteria>
- IndexedTutorGroup exposes canonicalKey; buildIndex populates it from existing SELECT
- buildCompareTutor accepts optional pastBlocks; merges BEFORE fallback
- Per-weekday historical check disables fallback only for past weekdays
- New helpers getStartOfTodayBkk + computeDateForWeekdayInRange exported for reuse
- 6 new test cases pass; all existing tests pass
- No reference to past_session_blocks in index.ts (D-18 regression guard)
</success_criteria>

<output>
After completion, create `.planning/phases/07-past-01-past-day-session-visibility/07-04-SUMMARY.md` documenting:
- compare.ts LOC delta (before → after)
- Test count delta (baseline → baseline+6)
- Any divergence from research §Pattern 4 blueprint
- Note on backward compatibility: pastBlocks param is optional (Plan 05 is the first caller)
</output>
