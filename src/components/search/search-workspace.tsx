"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { SearchForm } from "@/components/search/search-form";
import type { SearchContext } from "@/components/search/search-form";
import type { FilterOptions } from "@/lib/data/filters";
import type { TutorListItem } from "@/lib/data/tutors";
import { SearchResults } from "@/components/search/search-results";
import { RecommendedSlots } from "@/components/search/recommended-slots";
import { CopyForParentDrawer } from "@/components/search/copy-for-parent-drawer";
import type { RecommendedSlot } from "@/lib/search/recommend";
import { ComparePanel } from "@/components/compare/compare-panel";
import { useCompare, shiftWeek } from "@/hooks/use-compare";
import type { RangeSearchResponse } from "@/lib/search/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchWorkspaceProps {
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strict YYYY-MM-DD validator. Rejects calendar-impossible dates like 2026-02-31
// by round-tripping through Date.UTC and comparing back to the input. Shape-only
// regex was M3 finding in v1.0-MILESTONE-AUDIT.md:135 (POLISH-08).
function isValidWeekParam(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  // Reject obviously out-of-range components before building a Date (Date.UTC
  // silently normalizes negatives and overflow).
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const ts = Date.UTC(y, m - 1, d);
  const back = new Date(ts);
  return (
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === m - 1 &&
    back.getUTCDate() === d
  );
}

// ---------------------------------------------------------------------------
// SearchWorkspace component
// ---------------------------------------------------------------------------

export function SearchWorkspace({ filterOptions, tutorList }: SearchWorkspaceProps) {
  const searchParams = useSearchParams();
  const compare = useCompare();

  // Stable ref to latest compare hook. Prevents stale-closure fragility if
  // compare state mutates between render and mount-effect execution
  // (POLISH-12 / L4 from v1.0-MILESTONE-AUDIT.md:139).
  const compareRef = useRef(compare);
  compareRef.current = compare;

  const [response, setResponse] = useState<RangeSearchResponse | null>(null);
  const [searchContext, setSearchContext] = useState<SearchContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [drawerSlots, setDrawerSlots] = useState<RecommendedSlot[] | null>(null);

  // Handle ?tutors= and ?week= deep links on mount. Reads via compareRef so
  // the effect always sees the current hook, not the stale render-0 closure.
  useEffect(() => {
    const current = compareRef.current;
    const weekParam = searchParams.get("week");
    const tutorIds = searchParams.get("tutors")?.split(",").filter(Boolean) ?? [];
    if (weekParam && isValidWeekParam(weekParam)) {
      current.changeWeek(weekParam);
    }
    if (tutorIds.length > 0) {
      current.fetchCompare(tutorIds, weekParam ?? current.weekStart);
    }
    // Mount-only effect (by design). compareRef is stable (ref identity never
    // changes across renders). searchParams is from Next useSearchParams and is
    // snapshot at mount; re-running on param change would nuke user state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive the primitive the effect actually depends on (joined IDs string) so
  // the effect re-runs only when the set of selected tutor IDs changes, not when
  // the `compare` object identity changes every render. POLISH-06 / M1 fix from
  // v1.0-MILESTONE-AUDIT.md:133.
  const tutorIdsKey = compare.compareTutors.map((t) => t.tutorGroupId).join(",");

  // Sync weekStart and selected tutors to URL (non-navigating)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (tutorIdsKey) url.searchParams.set("tutors", tutorIdsKey);
    else url.searchParams.delete("tutors");
    if (compare.weekStart !== compare.getCurrentMonday()) {
      url.searchParams.set("week", compare.weekStart);
    } else {
      url.searchParams.delete("week");
    }
    window.history.replaceState({}, "", url.toString());
    // `compare.weekStart` and `tutorIdsKey` are primitives; `compare.getCurrentMonday`
    // is a stable module-level function — safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorIdsKey, compare.weekStart]);

  // ArrowLeft/ArrowRight navigate weeks (guard against text input focus)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target.isContentEditable) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        compare.changeWeek(shiftWeek(compare.weekStart, -1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        compare.changeWeek(shiftWeek(compare.weekStart, 1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [compare]);

  // Esc exits fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFullscreen]);

  // --- Communication wiring ---
  const handleSearchResponse = useCallback((data: RangeSearchResponse, context: SearchContext) => {
    setResponse(data);
    setSearchContext(context);
    setError(null);
  }, []);

  const handleCompareSelected = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    compare.tutorCache.current.clear();
    compare.fetchCompare(ids.slice(0, 3), compare.weekStart);
  }, [compare]);

  const disableAdd = compare.compareTutors.length >= 3;

  const handleOpenDrawer = useCallback((slots: RecommendedSlot[]) => {
    setDrawerSlots(slots);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawerSlots(null);
  }, []);

  return (
    <div className="flex-1 flex gap-3 overflow-hidden min-h-0">
      <div
        className={cn(
          "flex flex-col overflow-hidden min-w-0 transition-all duration-300 ease-in-out",
          isFullscreen
            ? "w-0 opacity-0 pr-0 border-r-0"
            : "w-1/2 border-r border-border/50 pr-3",
        )}
      >
        <SearchForm
          filterOptions={filterOptions}
          tutorList={tutorList}
          onSearchResponse={handleSearchResponse}
          onError={setError}
        />
        {error && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive mt-2 flex-shrink-0">
            {error}
          </div>
        )}
        {response && (
          <div className="mt-2">
            <RecommendedSlots
              response={response}
              searchContext={searchContext}
              onOpenDrawer={handleOpenDrawer}
              onAddToCompare={handleCompareSelected}
              disableAdd={disableAdd}
            />
          </div>
        )}
        <SearchResults
          response={response}
          loading={false}
          searchContext={searchContext}
          onCompareSelected={handleCompareSelected}
          onAddSingle={compare.addTutor}
          disableAdd={disableAdd}
        />
      </div>
      <div
        className={cn(
          "flex flex-col overflow-hidden min-w-0 transition-all duration-300 ease-in-out",
          isFullscreen ? "w-full pl-0" : "w-1/2 pl-1",
        )}
      >
        <ComparePanel
          compare={compare}
          tutorList={tutorList}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() => setIsFullscreen((v) => !v)}
        />
      </div>
      <CopyForParentDrawer
        open={drawerSlots !== null}
        onClose={handleCloseDrawer}
        slots={drawerSlots ?? []}
        searchContext={searchContext}
      />
    </div>
  );
}
