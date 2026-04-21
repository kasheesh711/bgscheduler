---
phase: 05-polish-drain
reviewed: 2026-04-21T11:10:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/app/globals.css
  - src/components/compare/calendar-grid.tsx
  - src/components/compare/tutor-selector.tsx
  - src/components/compare/week-overview.tsx
  - src/components/search/search-workspace.tsx
  - src/hooks/use-compare.ts
  - src/lib/search/__tests__/recommend.test.ts
findings:
  critical: 0
  warning: 1
  info: 3
  total: 4
status: issues_found
---

# Phase 5: Code Review Report — POLISH Drain

## Summary

Phase 5 is a surgical polish pass — the diff is small, targeted, and every intentional choice (mount-only effects, ref-based stale-closure escape, strict regex with calendar round-trip) is documented inline with audit references. All checked files compile and the test fixture correctly mirrors the `RangeGridRow.availability` contract (`=== true` gates unavailable arrays out).

One warning surfaced: a stale-closure/churn hazard in `search-workspace.tsx`'s keyboard effect that is the same *class* of bug POLISH-06/11/12 were fixing elsewhere, but was not memoized here. The dead-code removal in `tutor-selector.tsx` is clean — all three downstream consumers only import the preserved `TutorChip` type and re-exported `TUTOR_COLORS` constant.

---

## Warnings

### WR-01: Keyboard effect re-attaches listener every render (churn + latent stale-closure)

**File:** `src/components/search/search-workspace.tsx:111-127`

**Issue:** The ArrowLeft/ArrowRight keyboard-navigation effect lists `[compare]` as its dependency. But `useCompare()` returns a fresh object every render (`removeTutor` and `changeWeek` at `src/hooks/use-compare.ts:166,197` are *not* wrapped in `useCallback`), so the `compare` reference is new on every parent render. That means:

1. The effect tears down the previous `keydown` listener and re-attaches a new one on every render of `SearchWorkspace` — pure churn.
2. If we ever switch any of the captured values (`compare.changeWeek`, `compare.weekStart`) to be read via a different code path, the current listener already holds a handler that captures the specific `compare` snapshot from its mount render — the `[compare]` dep happens to mask this by re-registering, but it's the wrong solution.

This is the same *class* of hazard that POLISH-06 (tutorIdsKey primitive) and POLISH-11 (`addTutor` useCallback) already fixed elsewhere. The mount-effect (lines 71–85) and URL-sync effect (94–108) were audited/fixed; this keydown effect was apparently missed.

**Fix:** Depend on the primitive that actually matters (`compare.weekStart`) and read `changeWeek` via a ref, the same pattern POLISH-12 applied:

```ts
const compareRef = useRef(compare);
compareRef.current = compare; // already present

useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (target.isContentEditable) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      compareRef.current.changeWeek(shiftWeek(compareRef.current.weekStart, -1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      compareRef.current.changeWeek(shiftWeek(compareRef.current.weekStart, 1));
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Alternatively, memoize `removeTutor` and `changeWeek` in `useCompare` (see IN-01) so `compare` itself becomes stable — then `[compare]` is legitimate everywhere.

---

## Info

### IN-01: `removeTutor` and `changeWeek` still not memoized in useCompare

**File:** `src/hooks/use-compare.ts:166, 197`

**Issue:** POLISH-11 memoized `addTutor` via `useCallback`, which is correct. But the sibling helpers `removeTutor` and `changeWeek` are plain function expressions — every render of `useCompare()` produces a new identity for each. This makes the `compare` object returned from the hook unstable by construction, which is exactly what leaks into WR-01. If the goal of POLISH-11 was to make the hook output stable for downstream effect deps, finishing the job (both callbacks) would complete it.

**Fix:**

```ts
const removeTutor = useCallback((id: string) => {
  // ...existing body
}, [compareTutors, weekStart, fetchCompare]);

const changeWeek = useCallback((newWeek: string) => {
  // ...existing body
}, [compareTutors, fetchCompare]);
```

Risk: tiny — these are called from event handlers, not in effect deps.

### IN-02: Browser-local Date parsing for Bangkok wall-clock is fragile (pre-existing)

**File:** `src/components/compare/calendar-grid.tsx:66, 82`; `src/components/compare/week-overview.tsx:233, 249`; `src/hooks/use-compare.ts:22`

**Issue:** The pattern `new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }))` formats the current instant as a BKK wall-clock string, then re-parses that string into a `Date` in the *browser's* local TZ. Reading `.getHours()/.getDay()/.getDate()` off that reconstructed Date happens to return the "BKK wall-clock" numbers because of how the constructor consumes the string — but this is implementation-dependent on the locale string format. Not introduced in this phase; flagging only because the midnight-tick fix (POLISH-07) now relies on `dateKey` which is derived this way.

**Fix:** Use `date-fns-tz` (already a dependency per AGENTS.md):

```ts
import { toZonedTime } from "date-fns-tz";
const bkk = toZonedTime(new Date(), "Asia/Bangkok");
// bkk.getHours() / getDay() / toDateString() now correctly reflect Asia/Bangkok
```

Safer and more explicit. Not urgent — no behavior regression. Out-of-scope for the polish drain unless the user wants to bundle it.

### IN-03: `typeof window === "undefined"` guard inside useEffect is dead

**File:** `src/components/search/search-workspace.tsx:96`

**Issue:** `useEffect` callbacks only run on the client in React 19; `window` is always defined. The guard is harmless but misleading (suggests the code might run server-side).

**Fix:** Delete the `if (typeof window === "undefined") return;` line. Optional cleanup.

---

## Items explicitly verified and found correct

- **POLISH-08 (`isValidWeekParam`)** — regex gates shape, explicit range check on `m`/`d`, round-trip via `getUTC*` confirms validity. Correctly rejects `2026-02-31`, `0000-01-01`, `2026-13-01`, non-leap-year `2025-02-29` while accepting `2024-02-29`.
- **POLISH-12 mount-effect** — `compareRef.current = compare` set unconditionally above the effect, effect reads `compareRef.current` rather than `compare` directly, justified `eslint-disable`. Correct.
- **POLISH-06 `tutorIdsKey`** — primitive string dep prevents effect re-run when `compare` object identity churns.
- **POLISH-07 midnight tick** — always-running interval with `dateKey` comparison correctly forces re-render across midnight so `getCurrentMonday()` is re-evaluated and `isCurrentWeek` flips. State-update guard prevents render storm.
- **POLISH-09 (`bg-today-indicator`)** — token fully wired: `--today-indicator` in `:root` + `.dark`, surfaced via `--color-today-indicator` under `@theme inline`. No stray `bg-red-500` remaining in `src/`.
- **POLISH-10 duplicate guard removal** — both files read clean.
- **POLISH-11 `addTutor` useCallback** — deps `[compareTutors, weekStart, fetchCompare]` are exhaustive.
- **POLISH-14 dead-code removal** — `tutor-selector.tsx` reduces to `TutorChip` interface + `TUTOR_COLORS` re-export. All three downstream consumers use `import type { TutorChip }` — type-only, no ripple.
- **POLISH-16 `recommend.test.ts`** — fixtures match `RangeGridRow.availability` contract; `BLOCKED = []` correctly fails `=== true` gate. 11 test cases cover ranking behavior (count DESC, start ASC, modality union, variety threshold, limit cap).

## Not a bug

- **`TUTOR_COLORS` re-export in `tutor-selector.tsx` is technically unused** — no call site imports it from `./tutor-selector`; all consumers go direct to `./session-colors`. Out of scope for POLISH-14 as written. Could collapse the file to just `export type TutorChip` in a follow-up if desired.
- **`handleCompareSelected` deps `[compare]`** — same churn concern as WR-01, but this callback is only passed to event handlers (not to effect dep arrays), so churn has no observable effect.

---

_Reviewed: 2026-04-21T11:10:00Z_
_Reviewer: gsd-code-reviewer_
_Depth: standard_
