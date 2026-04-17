---
phase: 04-ui-audit-polish
fixed_at: 2026-04-17T00:00:00Z
review_path: .planning/phases/04-ui-audit-polish/04-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-04-17
**Source review:** `.planning/phases/04-ui-audit-polish/04-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (Critical: 0, Warning: 6; Info findings out of scope)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### WR-01: Potential infinite recursion in fetchCompare on snapshot change

**Files modified:** `src/hooks/use-compare.ts`
**Commit:** `4a5e8c4`
**Applied fix:** Added `_retried?: boolean` opt to `fetchCompare`. When the server snapshot changes, the cache is cleared and a single recursive retry is attempted. If the retried call also detects a snapshot mismatch, an error message ("Snapshot changed during fetch. Please retry.") is surfaced via `setCompareError` instead of recursing again. Removed the premature `setCompareLoading(false)` so the recursive call's `finally{}` block clears loading once.

### WR-02: Non-OK response silently ignored in discovery panel search

**Files modified:** `src/components/compare/discovery-panel.tsx`
**Commit:** `60a6d09`
**Applied fix:** Added an `else` branch to `handleSearch` that parses the error body (with `.catch(() => ({}))` fallback) and calls `setError(errData.error ?? \`Search failed (${res.status})\`)` so the user sees an explanation when discovery search fails.

### WR-03: Non-OK response silently ignored in data-health page fetch

**Files modified:** `src/app/(app)/data-health/page.tsx`
**Commit:** `bba4242`
**Applied fix:** Updated the data-health fetch chain to throw `Error(\`HTTP ${r.status}\`)` when the response is not OK, ensuring the existing `.catch(console.error)` logs the actual HTTP status instead of attempting to JSON-parse an error envelope and silently setting it as `data`.

### WR-04: Array index access without bounds check in results-view

**Files modified:** `src/components/search/results-view.tsx`
**Commit:** `c70ff9f`
**Applied fix:** Added an early `if (!slot) return null;` guard before computing the tab label, removing the now-unnecessary `?.` chains and preventing the "undefined undefined-undefined" rendering case if `perSlotResults` and `normalizedSlots` are ever out of sync.

### WR-05: Implicit programmatic click via getElementById is fragile

**Files modified:** `src/components/search/search-form.tsx`
**Commit:** `9614f1d`
**Applied fix:** Added a `pendingSearch` state flag. `handleSelectRecent` now sets `pendingSearch = true` after restoring all form state. A new `useEffect([pendingSearch])` invokes `handleSearch()` once React has committed the state updates, eliminating the `setTimeout(() => document.getElementById("search-btn").click(), 0)` hack. Imported `useEffect` from `react`. The `id="search-btn"` on the button was left in place as it is harmless and may be used elsewhere.

### WR-06: Filter options fetch error silently swallowed in discovery panel

**Files modified:** `src/components/compare/discovery-panel.tsx`
**Commit:** `60a6d09`
**Applied fix:** Replaced the empty `.catch(() => {})` on the `/api/filters` fetch with `.catch((err) => { console.error("Failed to load filter options:", err); })`. Folded into the same atomic commit as WR-02 because both fixes touch only `discovery-panel.tsx`.

## Skipped Issues

None.

---

_Fixed: 2026-04-17_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
