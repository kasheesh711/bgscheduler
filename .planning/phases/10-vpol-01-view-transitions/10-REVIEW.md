---
phase: 10-vpol-01-view-transitions
reviewed: 2026-05-09T09:55:41Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/app/globals.css
  - src/components/compare/__tests__/view-transitions-source.test.ts
  - src/components/compare/compare-panel.tsx
  - src/components/compare/week-overview.tsx
  - src/hooks/use-compare.ts
  - src/lib/ui/__tests__/view-transitions.test.ts
  - src/lib/ui/view-transitions.ts
findings:
  critical: 0
  warning: 3
  info: 0
  total: 3
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-05-09T09:55:41Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Reviewed the Phase 10 native view-transition helper, compare-panel wiring, scroll ref plumbing, global CSS, and guardrail tests. No security issues or strict-fidelity data regressions were found. The actionable risks are warning-level client-state regressions around the new fetch-first week navigation path: current calendar content remains interactive while shared cache/request state is mutated for the target week.

## Warnings

### WR-01: Week navigation clears the current compare cache before target data commits

**File:** `src/hooks/use-compare.ts:253`
**Issue:** `changeWeek` clears `tutorCache` before fetching the target week, while the current week UI remains visible and interactive because the request uses `keepCurrentVisible: true`. If that request fails, is aborted, or the user adds/removes a tutor before the target week commits, the current week still renders but incremental `fetchOnly` merges depend on cache entries that were just deleted. That can drop existing tutor schedules from compare results.
**Fix:**
```ts
// Keep the current week's cache until target data is ready. Cache keys already
// include weekStart, so old-week entries cannot satisfy a new-week lookup.
const prepared = await fetchCompareData(
  compareTutors.map((t) => t.tutorGroupId),
  newWeek,
  { keepCurrentVisible: true },
);

if (prepared === null) {
  return;
}

const pruneCacheToCommittedWeek = () => {
  const targetSuffix = `:${newWeek}:${CACHE_VERSION}`;
  for (const key of Array.from(tutorCache.current.keys())) {
    if (!key.endsWith(targetSuffix)) {
      tutorCache.current.delete(key);
    }
  }
};

const commitLoadedWeek = () => {
  flushSync(() => {
    setWeekStart(newWeek);
    commitPreparedCompare(prepared);
  });
  pruneCacheToCommittedWeek();
  options.restoreScrollTop?.(options.capturedScrollTop ?? 0);
};
```

### WR-02: Rapid next/previous clicks collapse onto the stale committed week

**File:** `src/components/compare/compare-panel.tsx:299`
**Issue:** The next/previous buttons derive targets from `weekStart`, but `weekStart` is intentionally not updated until the fetch-first request returns and the transition commits. During that pending window, repeated "next" clicks keep targeting `shiftWeek(weekStart, 1)` from the old visible week, aborting/restarting the same request instead of advancing multiple weeks. This undercuts the rapid-navigation requirement because users cannot move ahead quickly until each fetch completes.
**Fix:**
```tsx
const pendingWeekRef = useRef<string | null>(null);

const beginWeekChange = useCallback((targetWeek: string) => {
  pendingWeekRef.current = targetWeek;
  void changeWeek(targetWeek, transitionOptions).finally(() => {
    if (pendingWeekRef.current === targetWeek) {
      pendingWeekRef.current = null;
    }
  });
}, [changeWeek, transitionOptions]);

const handleWeekDelta = useCallback((delta: number) => {
  const baseWeek = pendingWeekRef.current ?? weekStart;
  beginWeekChange(shiftWeek(baseWeek, delta));
}, [beginWeekChange, weekStart]);

// Buttons:
onClick={() => handleWeekDelta(-1)}
onClick={() => handleWeekDelta(1)}
```

### WR-03: Removing the final tutor does not cancel an in-flight compare request

**File:** `src/hooks/use-compare.ts:216`
**Issue:** When the last tutor is removed, `removeTutor` clears `compareResponse` and returns without aborting any in-flight fetch. A pending week-change or incremental compare request can still resolve afterward and commit stale tutor data back into the now-empty compare panel.
**Fix:**
```ts
if (remaining.length === 0) {
  abortRef.current?.abort();
  abortRef.current = null;
  tutorCache.current.clear();
  setCompareResponse(null);
  return;
}
```

---

_Reviewed: 2026-05-09T09:55:41Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
