# Phase 1: Component Architecture - Research

**Researched:** 2026-04-10
**Domain:** React component extraction, custom hooks, Next.js singleton patterns
**Confidence:** HIGH

## Summary

This phase is a mechanical refactoring of an 878-line monolithic client component (`src/app/(app)/search/page.tsx`) into four focused components (SearchForm, SearchResults, ComparePanel, SearchWorkspace) and one custom hook (useCompare). Additionally, two server-side module singletons (`_db` in `src/lib/db/index.ts` and `currentIndex` in `src/lib/search/index.ts`) need to be anchored on `globalThis` to survive Next.js dev-mode HMR module reloads.

The codebase already follows the patterns needed: `"use client"` directives, props-based communication, named exports, and colocated helper functions. Seven compare sub-components and seven search sub-components are already extracted into their own files. The page component is the last monolith -- it contains all the wiring state, fetch handlers, and layout JSX in a single `SearchPageInner` function.

**Primary recommendation:** Extract components bottom-up (SearchForm first, then SearchResults, then useCompare hook, then ComparePanel, then SearchWorkspace as the composition root), testing visual parity at each step by running the dev server.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Extract `SearchForm` -- owns search form state (mode, day, time, duration, filters), filter option fetching, and form submission. Receives `onSearch` callback and `filterOptions` as props.
- **D-02:** Extract `SearchResults` -- owns search results display, row selection state, copy-for-parents, and "Compare (N)" button. Receives search response data and emits selected tutor IDs.
- **D-03:** Extract `ComparePanel` -- owns the entire right panel: tutor selector chips, combobox, week picker, week/day tabs, calendar grid, conflict summary, free slot indicators, and discovery modal trigger.
- **D-04:** Extract `SearchWorkspace` -- the top-level layout component that wires SearchForm, SearchResults, and ComparePanel together in the side-by-side split. Minimal state -- delegates to children and useCompare hook.
- **D-05:** Extract `useCompare` custom hook owning all compare state: `compareTutors`, `tutorCache` (Map ref), `abortRef`, `lastSnapshotId`, `weekStart`, `fetchCompare`, `addTutor`, `removeTutor`, `changeWeek`. Returns state + actions. No context provider needed -- hook is called once in SearchWorkspace and passed down as props.
- **D-06:** Communication between search and compare: SearchResults emits selected tutor IDs via callback prop. SearchWorkspace passes this to ComparePanel's `addTutor` action.
- **D-07:** Anchor `_db` (in `src/lib/db/index.ts`) and `currentIndex` (in `src/lib/search/index.ts`) on `globalThis` to survive across server-side module reloads in development. Use a namespaced key like `__bgscheduler_db` and `__bgscheduler_searchIndex`.

### Claude's Discretion
- File naming and internal organization of extracted components
- Whether helper functions (getCurrentMonday, shiftWeek, formatWeekLabel, etc.) move into a shared utils file or stay colocated
- Exact prop interfaces for each component -- derive from current inline state usage
- TypeScript type declarations for globalThis extensions

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PERF-01 | Break 878-line search page into focused client components (SearchForm, SearchResults, ComparePanel, SearchWorkspace) | Decisions D-01 through D-04 define exact component boundaries. Existing sub-components in `src/components/compare/` and `src/components/search/` are already extracted -- this phase extracts the remaining top-level orchestration. |
| PERF-02 | Extract `useCompare` custom hook owning all compare state | Decision D-05 defines the hook interface. All compare state (lines 156-169 of current page) and handlers (lines 273-386) move into the hook. |
| PERF-03 | Anchor SearchIndex and DB singletons on `globalThis` instead of module-level variables | Decision D-07. Two files need modification: `src/lib/db/index.ts` (24 lines) and `src/lib/search/index.ts` (289 lines, singleton at line 76-77). |
</phase_requirements>

## Standard Stack

No new dependencies needed. This phase uses only existing project libraries.

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | 19.2.4 | Component model, hooks | Already in use |
| Next.js | 16.2.2 | App Router, `"use client"` directive | Already in use |
| TypeScript | ^5.9.3 | Type safety for prop interfaces, globalThis typing | Already in use |

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| shadcn/ui components | ^4.1.2 | Button, Card, Badge, Dialog, Popover, Command | Already used in existing search page |
| date-fns | ^4.1.0 | Date manipulation helpers | If helper functions are refactored |

No `npm install` needed for this phase. [VERIFIED: examined package.json and existing imports]

## Architecture Patterns

### Recommended Project Structure After Extraction
```
src/
├── app/(app)/search/
│   └── page.tsx                    # Default export only: Suspense wrapper + SearchWorkspace
├── components/search/
│   ├── search-workspace.tsx        # NEW: Composition root (side-by-side layout)
│   ├── search-form.tsx             # NEW: Left panel search form
│   ├── search-results.tsx          # NEW: Left panel results + selection
│   ├── availability-grid.tsx       # EXISTING
│   ├── copy-button.tsx             # EXISTING
│   ├── recent-searches.tsx         # EXISTING
│   ├── results-view.tsx            # EXISTING
│   └── ...
├── components/compare/
│   ├── compare-panel.tsx           # NEW: Right panel orchestrator
│   ├── calendar-grid.tsx           # EXISTING
│   ├── week-overview.tsx           # EXISTING
│   ├── discovery-panel.tsx         # EXISTING
│   ├── tutor-combobox.tsx          # EXISTING
│   ├── tutor-selector.tsx          # EXISTING
│   └── ...
├── hooks/
│   └── use-compare.ts              # NEW: Compare state hook
├── lib/db/
│   └── index.ts                    # MODIFIED: globalThis anchoring
└── lib/search/
    └── index.ts                    # MODIFIED: globalThis anchoring
```
[ASSUMED] File locations follow existing project conventions (kebab-case in feature directories). The `src/hooks/` directory does not currently exist but follows standard Next.js project organization.

### Pattern 1: Component Extraction with Props-Down, Callbacks-Up
**What:** Each extracted component owns its own local state and receives data/callbacks via props. No context providers.
**When to use:** When a single parent (SearchWorkspace) orchestrates 2-3 children that don't need cross-component communication beyond what the parent can wire.
**Example:**
```typescript
// src/components/search/search-workspace.tsx
"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { SearchForm } from "@/components/search/search-form";
import { SearchResults } from "@/components/search/search-results";
import { ComparePanel } from "@/components/compare/compare-panel";
import { useCompare } from "@/hooks/use-compare";
import type { FilterOptions } from "@/components/search/search-form";
import type { RangeSearchResponse } from "@/lib/search/types";

export function SearchWorkspace() {
  const searchParams = useSearchParams();
  const compare = useCompare();

  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [response, setResponse] = useState<RangeSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Init: fetch filters, handle ?tutors= deep link
  useEffect(() => {
    fetch("/api/filters")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setFilterOptions(data); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const tutorIds = searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
    if (tutorIds.length > 0) {
      compare.fetchCompare(tutorIds, compare.weekStart);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 border-r border-border/50 pr-3">
        <SearchForm
          filterOptions={filterOptions}
          onSearchComplete={setResponse}
          loading={loading}
          onLoadingChange={setLoading}
          onError={setError}
        />
        {error && <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive mt-2">{error}</div>}
        <SearchResults
          response={response}
          loading={loading}
          onCompareSelected={(ids) => {
            compare.tutorCache.current.clear();
            compare.fetchCompare(ids, compare.weekStart);
          }}
        />
      </div>
      <div className="w-1/2 flex flex-col overflow-hidden min-w-0 pl-1">
        <ComparePanel compare={compare} />
      </div>
    </div>
  );
}
```
[ASSUMED] Exact prop shapes will be derived from current inline state during implementation.

### Pattern 2: Custom Hook for Complex State
**What:** `useCompare` encapsulates all compare state (compareTutors, cache, abort, snapshot, week) and exposes state + action functions.
**When to use:** When multiple pieces of state are tightly coupled and share handlers.
**Example:**
```typescript
// src/hooks/use-compare.ts
"use client";

import { useState, useCallback, useRef } from "react";
import { TUTOR_COLORS } from "@/components/compare/tutor-selector";
import type { TutorChip } from "@/components/compare/tutor-selector";
import type { CompareResponse, CompareTutor } from "@/lib/search/types";

// Helper functions colocated in this file
function getCurrentMonday(): string { /* ... */ }
function shiftWeek(current: string, delta: number): string { /* ... */ }

export function useCompare() {
  const [compareTutors, setCompareTutors] = useState<TutorChip[]>([]);
  const [compareResponse, setCompareResponse] = useState<CompareResponse | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [weekStart, setWeekStart] = useState<string>(getCurrentMonday);

  const tutorCache = useRef(new Map<string, CompareTutor>());
  const lastSnapshotId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchCompare = useCallback(async (
    ids: string[],
    week: string,
    opts?: { fetchOnly?: string[] },
  ) => {
    // ... (move existing fetchCompare logic here verbatim)
  }, []);

  const addTutor = useCallback((id: string, name: string) => {
    // ... (move handleAddTutor logic)
  }, [compareTutors, weekStart, fetchCompare]);

  const removeTutor = useCallback((id: string) => {
    // ... (move handleRemoveTutor logic)
  }, [compareTutors, weekStart, fetchCompare]);

  const changeWeek = useCallback((newWeek: string) => {
    // ... (move handleWeekChange logic)
  }, [compareTutors, fetchCompare]);

  return {
    // State
    compareTutors,
    compareResponse,
    compareLoading,
    compareError,
    activeDay,
    discoveryOpen,
    weekStart,
    tutorCache,
    // Actions
    fetchCompare,
    addTutor,
    removeTutor,
    changeWeek,
    setActiveDay,
    setDiscoveryOpen,
    getCurrentMonday,
  };
}
```
[VERIFIED: state variables and handlers mapped from lines 156-386 of current page.tsx]

### Pattern 3: globalThis Singleton Anchoring
**What:** Use `globalThis` with namespaced keys to persist singletons across HMR module reloads in Next.js development.
**When to use:** Server-side singletons that are expensive to recreate (DB connections, in-memory indexes).
**Example:**
```typescript
// src/lib/db/index.ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type DbInstance = ReturnType<typeof drizzle>;

const GLOBAL_KEY = "__bgscheduler_db" as const;

declare global {
  // eslint-disable-next-line no-var
  var [typeof GLOBAL_KEY]: DbInstance | undefined;
}

function createDb(): DbInstance {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const sql = neon(databaseUrl);
  return drizzle({ client: sql, schema });
}

export function getDb(): DbInstance {
  if (!globalThis.__bgscheduler_db) {
    globalThis.__bgscheduler_db = createDb();
  }
  return globalThis.__bgscheduler_db;
}

export type Database = ReturnType<typeof getDb>;
```
[VERIFIED: This is the standard Next.js pattern for dev-mode singleton persistence. The existing `_db` variable at line 14 of `src/lib/db/index.ts` uses module-level `let` which resets on HMR.]

**Note on TypeScript `declare global`:** The `var` declaration (not `let` or `const`) is required inside `declare global` blocks because `var` declarations become properties of `globalThis`. This is a TypeScript requirement, not a style choice. [ASSUMED]

### Anti-Patterns to Avoid
- **Lifting too much state into SearchWorkspace:** The workspace should be thin. Search-specific state (mode, day, time, filters) stays in SearchForm. Selection state stays in SearchResults. Compare state stays in useCompare.
- **Using React Context for compare state:** D-05 explicitly says no context provider. The hook is called once in SearchWorkspace and passed down as props. Context is unnecessary for a single-level prop pass.
- **Moving helpers to a shared utils file prematurely:** Functions like `getCurrentMonday`, `shiftWeek`, `formatWeekLabel`, `getWeekDate` are only used by the compare panel. Colocate them in `use-compare.ts` or `compare-panel.tsx` until a second consumer appears.
- **Breaking the Suspense boundary:** The current `SearchPage` wraps `SearchPageInner` in `<Suspense>` because `useSearchParams()` requires it. After extraction, `SearchWorkspace` (which calls `useSearchParams`) must remain inside a Suspense boundary in `page.tsx`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Class merging | Custom classname concatenation | `cn()` from `src/lib/utils.ts` | Already established pattern, handles Tailwind deduplication |
| Tutor color assignment | New color mapping logic | `TUTOR_COLORS` from `tutor-selector.tsx` | Already exported, used by index-based assignment |
| Abort controller management | Custom cancellation system | Native `AbortController` + `useRef` | Already in use (line 169), well-tested pattern |

## Common Pitfalls

### Pitfall 1: Breaking the useSearchParams Suspense Requirement
**What goes wrong:** `useSearchParams()` in Next.js App Router requires a Suspense boundary above the component that calls it. If the boundary is removed during refactoring, the page crashes.
**Why it happens:** The current code has `SearchPage` > `Suspense` > `SearchPageInner`. When renaming to `SearchWorkspace`, the Suspense wrapper in `page.tsx` must be preserved.
**How to avoid:** Keep the default export in `page.tsx` as a thin wrapper: `<Suspense fallback={...}><SearchWorkspace /></Suspense>`.
**Warning signs:** Runtime error "useSearchParams() should be wrapped in a suspense boundary".

### Pitfall 2: Stale Closure in useCompare fetchCompare
**What goes wrong:** `fetchCompare` uses `useCallback` with an empty dependency array (line 273-344). It references `setCompareTutors` and `setCompareResponse` which are stable, but also calls itself recursively for snapshot invalidation (line 313). Moving this into a custom hook requires careful handling of the recursive call.
**Why it happens:** The recursive `fetchCompare` call on line 313 must reference the latest version of itself. In the current monolith this works because `fetchCompare` is defined with `useCallback(async (...) => { ... return fetchCompare(...) }, [])` -- the closure captures the ref-stable callback.
**How to avoid:** Keep the same `useCallback([], ...)` pattern. The recursive call works because React guarantees `useCallback` with `[]` returns a stable reference.
**Warning signs:** Infinite re-renders or stale data after snapshot changes.

### Pitfall 3: Losing the Tutor Cache Ref on Re-renders
**What goes wrong:** `tutorCache` is a `useRef(new Map<string, CompareTutor>())`. If this ref is accidentally recreated (e.g., by calling `useRef` conditionally or in the wrong scope), the cache is lost.
**Why it happens:** Moving the ref into `useCompare` hook is safe as long as the hook is called exactly once per SearchWorkspace instance.
**How to avoid:** Call `useCompare()` once at the top of SearchWorkspace. Never conditionally call hooks.
**Warning signs:** Every tutor addition triggers a full refetch instead of incremental.

### Pitfall 4: globalThis Type Declaration Conflicts
**What goes wrong:** TypeScript's `declare global { var ... }` can conflict if multiple files declare the same global key, or if the declaration file isn't included in tsconfig.
**Why it happens:** The global augmentation must use `var` (not `let`/`const`) and must be in a file that TypeScript treats as a module (has at least one import/export).
**How to avoid:** Put the `declare global` block in the same file as the singleton (`src/lib/db/index.ts` and `src/lib/search/index.ts`). Both files already have exports, so they're treated as modules.
**Warning signs:** TypeScript error "Property '__bgscheduler_db' does not exist on type 'typeof globalThis'".

### Pitfall 5: Visual Regression from CSS Class Changes
**What goes wrong:** When extracting JSX into separate components, class strings or conditional styles are accidentally modified, changing the visual appearance.
**Why it happens:** Copy-paste errors, especially with Tailwind classes in template literals and conditional expressions.
**How to avoid:** Copy JSX verbatim from the monolith, then adjust only the data plumbing (state -> props). Do not refactor styles in this phase. Verify each component visually after extraction.
**Warning signs:** Layout shifts, missing borders, wrong spacing between panels.

## Code Examples

### globalThis for SearchIndex singleton
```typescript
// src/lib/search/index.ts — modification
const DB_GLOBAL_KEY = "__bgscheduler_searchIndex" as const;
const BUILD_PROMISE_KEY = "__bgscheduler_searchIndexBuildPromise" as const;

declare global {
  // eslint-disable-next-line no-var
  var __bgscheduler_searchIndex: SearchIndex | null;
  // eslint-disable-next-line no-var
  var __bgscheduler_searchIndexBuildPromise: Promise<SearchIndex> | null;
}

// Replace module-level:
//   let currentIndex: SearchIndex | null = null;
//   let buildingPromise: Promise<SearchIndex> | null = null;
// With:
function getCurrentIndex(): SearchIndex | null {
  return globalThis.__bgscheduler_searchIndex ?? null;
}

function setCurrentIndex(index: SearchIndex | null): void {
  globalThis.__bgscheduler_searchIndex = index;
}

function getBuildingPromise(): Promise<SearchIndex> | null {
  return globalThis.__bgscheduler_searchIndexBuildPromise ?? null;
}

function setBuildingPromise(promise: Promise<SearchIndex> | null): void {
  globalThis.__bgscheduler_searchIndexBuildPromise = promise;
}
```
[ASSUMED] Exact accessor pattern is a recommendation. The key requirement is that `globalThis.__bgscheduler_searchIndex` replaces the module-level `currentIndex`.

### Prop Interface for SearchForm
```typescript
// Derived from lines 135-153 and 191-261 of current page.tsx
export interface FilterOptions {
  subjects: string[];
  curriculums: string[];
  levels: string[];
}

export interface SearchFormProps {
  filterOptions: FilterOptions | null;
  onSearch: (response: RangeSearchResponse) => void;
  loading: boolean;
  onLoadingChange: (loading: boolean) => void;
  onError: (error: string | null) => void;
  onSelectRecent: (search: RecentSearch) => void;
}
```
[VERIFIED: Derived from actual state variables and handlers in the current monolith]

### Prop Interface for SearchResults
```typescript
// Derived from lines 604-672 of current page.tsx
export interface SearchResultsProps {
  response: RangeSearchResponse | null;
  loading: boolean;
  searchMode: SearchMode;
  dayOfWeek?: number;
  date?: string;
  filters: { subject?: string; curriculum?: string; level?: string };
  onCompareSelected: (ids: string[]) => void;
}
```
[VERIFIED: Derived from actual JSX consumption in the current monolith]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Module-level `let` for singletons | `globalThis` anchoring | Standard since Next.js 13+ dev mode | Prevents singleton loss on HMR |
| Monolithic page components | Extracted components + custom hooks | React best practice | Enables RSC conversion in Phase 2 |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `src/hooks/` directory is the right location for `use-compare.ts` | Architecture Patterns | LOW -- just a file location, easily moved |
| A2 | TypeScript `declare global { var ... }` requires `var` keyword (not `let`/`const`) | Code Examples | LOW -- well-documented TypeScript behavior |
| A3 | Helper functions (getCurrentMonday, shiftWeek, etc.) should be colocated in use-compare.ts | Architecture Patterns | LOW -- can be moved later if needed |
| A4 | The globalThis accessor wrapper pattern (getCurrentIndex/setCurrentIndex) is cleaner than direct globalThis access | Code Examples | LOW -- implementation detail, both approaches work |

## Open Questions

1. **Where should `formatMinute` helper go?**
   - What we know: Used in both SearchResults (not yet, but conflict summary in ComparePanel uses it at line 833) and ComparePanel
   - What's unclear: Whether to colocate in compare-panel.tsx or put in a shared utility
   - Recommendation: Keep in compare-panel.tsx since it's only used in the compare context. If SearchResults needs it later, move to a shared file.

2. **Should SearchForm own its own search state, or should SearchWorkspace own it?**
   - What we know: D-01 says SearchForm "owns search form state". But SearchResults needs `searchMode`, `dayOfWeek`, `date`, and `filters` for the CopyButton.
   - What's unclear: Whether SearchForm should lift these values up via callbacks, or SearchWorkspace should own them and pass down.
   - Recommendation: SearchForm owns the state internally and passes the needed values back via the onSearch callback (which already carries the response). For CopyButton context, include the search params in the response or pass them as a separate callback.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all verified as existing
- Architecture: HIGH -- decisions are locked, component boundaries are clearly defined, patterns are standard React
- Pitfalls: HIGH -- derived from reading the actual 878-line source code

**Research date:** 2026-04-10
**Valid until:** 2026-05-10 (stable -- no external dependency changes expected)

## Sources

### Primary (HIGH confidence)
- `src/app/(app)/search/page.tsx` -- 878-line monolith, full state and handler inventory
- `src/lib/db/index.ts` -- 24-line DB singleton, current module-level pattern
- `src/lib/search/index.ts` -- 289-line SearchIndex singleton, current module-level pattern
- `src/lib/search/types.ts` -- All shared type definitions (197 lines)
- `src/components/compare/tutor-selector.tsx` -- TutorChip type and TUTOR_COLORS export
- `tsconfig.json` -- Confirms strict mode and module settings for global type declarations
- `.planning/phases/01-component-architecture/01-CONTEXT.md` -- Locked decisions D-01 through D-07
