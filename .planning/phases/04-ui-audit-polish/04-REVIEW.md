---
phase: 04-ui-audit-polish
reviewed: 2026-04-16T09:35:03Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - src/components/compare/session-colors.ts
  - src/components/compare/tutor-selector.tsx
  - src/components/compare/compare-panel.tsx
  - src/components/compare/discovery-panel.tsx
  - src/components/search/slot-chips.tsx
  - src/components/search/slot-builder.tsx
  - src/components/search/results-view.tsx
  - src/hooks/use-compare.ts
  - src/components/compare/week-overview.tsx
  - src/components/compare/calendar-grid.tsx
  - src/components/search/search-form.tsx
  - src/app/(app)/data-health/page.tsx
findings:
  critical: 0
  warning: 6
  info: 5
  total: 11
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-04-16T09:35:03Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Reviewed 12 source files across the compare, search, and data-health UI components plus the `useCompare` hook. No critical security vulnerabilities or data-loss risks were found. The codebase follows project conventions well -- named exports, kebab-case files, `"use client"` directives, proper error handling patterns.

Six warnings were identified, primarily around missing error handling for non-OK HTTP responses, a potential infinite recursion in the compare hook, an out-of-bounds array access, and silently swallowed errors in data fetching. Five informational items note duplicated utility functions, dead code, and an unused import.

## Warnings

### WR-01: Potential infinite recursion in fetchCompare on snapshot change

**File:** `src/hooks/use-compare.ts:126-129`
**Issue:** When the server snapshot changes, the code clears the cache and recursively calls `fetchCompare` without any guard. If the server snapshot changes again between the recursive call's fetch and response processing (unlikely but possible during rapid re-syncs), this creates an unbounded recursion. Additionally, `setCompareLoading(false)` is called on line 128 before the recursive call, which means the loading state flickers to false then back to true.
**Fix:** Add a recursion guard (e.g., a parameter or ref counter) and remove the premature `setCompareLoading(false)`:
```typescript
const fetchCompare = useCallback(async (
  ids: string[],
  week: string,
  opts?: { fetchOnly?: string[]; _retried?: boolean },
) => {
  // ...existing code...
  if (lastSnapshotId.current && lastSnapshotId.current !== data.snapshotMeta.snapshotId) {
    tutorCache.current.clear();
    if (opts?._retried) {
      setCompareError("Snapshot changed during fetch. Please retry.");
      return;
    }
    // Do NOT set loading false here -- let the recursive call handle finally{}
    return fetchCompare(ids, week, { _retried: true });
  }
  // ...rest...
}, []);
```

### WR-02: Non-OK response silently ignored in discovery panel search

**File:** `src/components/compare/discovery-panel.tsx:95-98`
**Issue:** When `res.ok` is false, the response error is silently discarded. The `loading` state is set to false but `error` remains null, leaving the user with no feedback that the search failed.
**Fix:** Add an else branch to surface the error:
```typescript
if (res.ok) {
  const data: DiscoverResponse = await res.json();
  setResponse(data);
} else {
  const errData = await res.json().catch(() => ({}));
  setError(errData.error ?? `Search failed (${res.status})`);
}
```

### WR-03: Non-OK response silently ignored in data-health page fetch

**File:** `src/app/(app)/data-health/page.tsx:82-84`
**Issue:** The `fetch("/api/data-health")` call chains `.then((r) => r.json())` without checking `r.ok`. If the server returns a 500 or 401, `r.json()` may succeed but return an error object that is then set as `data`, or it may throw a parse error that gets caught and logged to console. Either way, the user sees "Failed to load health data" but gets no detail about why.
**Fix:** Check the response status before parsing:
```typescript
fetch("/api/data-health")
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(setData)
  .catch(console.error)
  .finally(() => setLoading(false));
```

### WR-04: Array index access without bounds check in results-view

**File:** `src/components/search/results-view.tsx:47`
**Issue:** `response.normalizedSlots[i]` uses the loop index `i` from `perSlotResults.map` to index into `normalizedSlots`. If these two arrays are ever out of sync (e.g., a backend bug returns mismatched lengths), `slot` will be `undefined` and the template literal on line 49 will render `"undefined undefined-undefined"`. The `?.` on lines 49-50 partially guards this but the first access `slot?.dayOfWeek` still produces a confusing label.
**Fix:** Add an early return for the missing slot case:
```typescript
{perSlotResults.map((sr, i) => {
  const slot = response.normalizedSlots[i];
  if (!slot) return null;
  const label = slot.dayOfWeek !== undefined
    ? `${WEEKDAY_NAMES[slot.dayOfWeek]} ${slot.start}-${slot.end}`
    : `${slot.date} ${slot.start}-${slot.end}`;
  return (
    <TabsTrigger key={sr.slotId} value={sr.slotId}>
      {label} ({sr.available.length})
    </TabsTrigger>
  );
})}
```

### WR-05: Implicit programmatic click via getElementById is fragile

**File:** `src/components/search/search-form.tsx:183-185`
**Issue:** `handleSelectRecent` uses `setTimeout(() => document.getElementById("search-btn")?.click(), 0)` to trigger a search after restoring form state from a recent search. This couples the "recent search" logic to a specific DOM element ID and relies on React having flushed all state updates within a single microtask -- which is not guaranteed by React's batching semantics. If React batches the state updates into a later render, the click fires before the form state is updated.
**Fix:** Call `handleSearch` directly after setting state, wrapped in a `useEffect` or via a ref-based trigger:
```typescript
const [pendingSearch, setPendingSearch] = useState(false);

useEffect(() => {
  if (pendingSearch) {
    setPendingSearch(false);
    handleSearch();
  }
}, [pendingSearch, handleSearch]);

const handleSelectRecent = (search: RecentSearch) => {
  // ...set all state...
  setPendingSearch(true);
};
```

### WR-06: Filter options fetch error silently swallowed in discovery panel

**File:** `src/components/compare/discovery-panel.tsx:57-58`
**Issue:** The `.catch(() => {})` on the `/api/filters` fetch completely swallows any error. If filters fail to load, the subject dropdown will remain empty with no indication to the user. While this is a non-critical auxiliary fetch, the empty catch masks network issues that could confuse admin staff.
**Fix:** At minimum log the error; optionally show a subtle inline warning:
```typescript
.catch((err) => {
  console.error("Failed to load filter options:", err);
});
```

## Info

### IN-01: Duplicated utility functions across week-overview and calendar-grid

**File:** `src/components/compare/week-overview.tsx:27-43` and `src/components/compare/calendar-grid.tsx:26-42`
**Issue:** `minuteToY`, `minuteToLabel`, and `formatClassType` are identically defined in both files. This violates DRY and creates a maintenance risk if one copy is updated without the other.
**Fix:** Extract these into a shared utility file, e.g., `src/components/compare/calendar-utils.ts`, and import from both components.

### IN-02: Duplicated DAY_NAMES constant

**File:** `src/components/compare/discovery-panel.tsx:17`, `src/components/compare/week-overview.tsx:25`, `src/components/search/slot-chips.tsx:8`, `src/components/search/results-view.tsx:16`
**Issue:** `DAY_NAMES` (or `WEEKDAY_NAMES`) is defined independently in at least 4 files. The canonical export is in `search-form.tsx` (line 52), which `compare-panel.tsx` imports, but other files define their own local copies.
**Fix:** Consolidate into a single shared constant file and import everywhere.

### IN-03: Unused TUTOR_COLORS re-export in tutor-selector

**File:** `src/components/compare/tutor-selector.tsx:51`
**Issue:** `TUTOR_COLORS` is re-exported from `tutor-selector.tsx` but is imported from `session-colors.ts` directly wherever it is needed (e.g., `use-compare.ts:4`). The re-export appears to be dead code that was left behind after a refactor.
**Fix:** Remove the re-export `export { TUTOR_COLORS };` from `tutor-selector.tsx` unless there are consumers that depend on this re-export path. Check with `grep -r "from.*tutor-selector" src/` to verify.

### IN-04: Magic numbers for calendar grid dimensions

**File:** `src/components/compare/week-overview.tsx:21-24`, `src/components/compare/calendar-grid.tsx:21-24`
**Issue:** `HOUR_HEIGHT`, `START_HOUR`, `END_HOUR` are defined as magic-number constants in both files but with different values (`HOUR_HEIGHT` is 48 in week-overview vs 60 in calendar-grid). While the different values are intentional (week overview is more compact), the naming is identical, which could confuse future maintainers into thinking they should be the same.
**Fix:** Consider renaming to `WEEK_HOUR_HEIGHT` / `DAY_HOUR_HEIGHT` or adding a comment clarifying the intentional difference.

### IN-05: Slot mode is hardcoded to "either" in slot-builder

**File:** `src/components/search/slot-builder.tsx:64`
**Issue:** The slot `mode` is hardcoded to `"either"` with a comment saying "overridden by page-level mode filter." While functionally correct, this is a confusing pattern -- the `SearchSlot` type includes `mode` as a required field, but the value set here is never used. This could mislead a future developer into thinking the slot-level mode matters.
**Fix:** Add a more prominent comment or consider omitting the field and letting the consumer set it, if the type allows.

---

_Reviewed: 2026-04-16T09:35:03Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
