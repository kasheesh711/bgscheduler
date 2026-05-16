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
import {
  ProposalHoldModal,
  type ProposalDraft,
} from "@/components/search/proposal-hold-modal";
import { ActiveHoldsDrawer } from "@/components/search/active-holds-drawer";
import type { RecommendedSlot } from "@/lib/search/recommend";
import { ComparePanel } from "@/components/compare/compare-panel";
import { useCompare, shiftWeek } from "@/hooks/use-compare";
import type { BlockingSessionInfo, RangeSearchResponse } from "@/lib/search/types";
import type { ProposalHoldSummary, ProposalPatchAction } from "@/lib/proposals/types";
import { proposalHoldBlocksSearchSlot } from "@/lib/proposals/overlap";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchWorkspaceProps {
  filterOptions: FilterOptions;
  tutorList: TutorListItem[];
  naturalLanguageEnabled: boolean;
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

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function proposalHoldToBlockingInfo(hold: ProposalHoldSummary): BlockingSessionInfo {
  return {
    kind: "proposal_hold",
    title: `Held for ${hold.studentLabel}`,
    studentName: hold.studentLabel,
    subject: [hold.subject, hold.curriculum, hold.level].filter(Boolean).join(" ") || undefined,
    startTime: hold.startTime,
    endTime: hold.endTime,
    proposalHold: hold,
  };
}

// ---------------------------------------------------------------------------
// SearchWorkspace component
// ---------------------------------------------------------------------------

export function SearchWorkspace({
  filterOptions,
  tutorList,
  naturalLanguageEnabled,
}: SearchWorkspaceProps) {
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
  const [proposalDraft, setProposalDraft] = useState<ProposalDraft | null>(null);
  const [activeHolds, setActiveHolds] = useState<ProposalHoldSummary[]>([]);
  const [holdsDrawerOpen, setHoldsDrawerOpen] = useState(false);
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [proposalActionLoadingId, setProposalActionLoadingId] = useState<string | null>(null);

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

  const applyProposalHoldsToResponse = useCallback((
    current: RangeSearchResponse | null,
    holds: ProposalHoldSummary[],
  ): RangeSearchResponse | null => {
    if (!current || !searchContext) return current;

    const nextGrid = current.grid.map((row) => {
      const availability = row.availability.map((cell, index) => {
        const hasWiseDetails = Array.isArray(cell) && cell.some((entry) => entry.kind !== "proposal_hold");
        if (hasWiseDetails) return cell;
        const hadProposalHold = Array.isArray(cell) && cell.some((entry) => entry.kind === "proposal_hold");
        if (cell !== true && !hadProposalHold) return cell;

        const slot = current.subSlots[index];
        const weekday = searchContext.searchMode === "recurring"
          ? searchContext.dayOfWeek
          : searchContext.date
            ? new Date(`${searchContext.date}T00:00:00+07:00`).getDay()
            : undefined;
        if (weekday === undefined) return cell;

        const startMinute = parseTimeToMinutes(slot.start);
        const endMinute = parseTimeToMinutes(slot.end);
        const hold = holds.find((candidate) => (
          candidate.tutorCanonicalKey === row.tutorCanonicalKey &&
          proposalHoldBlocksSearchSlot(candidate, {
            searchMode: searchContext.searchMode,
            weekday,
            date: searchContext.date,
            startMinute,
            endMinute,
          })
        ));

        return hold ? [proposalHoldToBlockingInfo(hold)] : true;
      });

      return { ...row, availability };
    });

    return { ...current, grid: nextGrid };
  }, [searchContext]);

  const refreshProposalHolds = useCallback(async () => {
    setHoldsLoading(true);
    try {
      const res = await fetch("/api/proposals/active");
      if (!res.ok) return;
      const data = await res.json();
      const holds = (data.holds ?? []) as ProposalHoldSummary[];
      setActiveHolds(holds);
      setResponse((current) => applyProposalHoldsToResponse(current, holds));
    } finally {
      setHoldsLoading(false);
    }
  }, [applyProposalHoldsToResponse]);

  useEffect(() => {
    void refreshProposalHolds();
  }, [refreshProposalHolds]);

  const handleProposalCreated = useCallback((items: ProposalHoldSummary[]) => {
    setActiveHolds((prev) => {
      const byId = new Map(prev.map((hold) => [hold.itemId, hold]));
      for (const item of items) byId.set(item.itemId, item);
      const merged = [...byId.values()];
      setResponse((current) => applyProposalHoldsToResponse(current, merged));
      return merged;
    });
    void refreshProposalHolds();
  }, [applyProposalHoldsToResponse, refreshProposalHolds]);

  const handleProposalAction = useCallback(async (itemId: string, action: ProposalPatchAction) => {
    setProposalActionLoadingId(itemId);
    try {
      const res = await fetch(`/api/proposals/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const holds = (data.holds ?? []) as ProposalHoldSummary[];
      setActiveHolds(holds);
      setResponse((current) => applyProposalHoldsToResponse(current, holds));
    } finally {
      setProposalActionLoadingId(null);
    }
  }, [applyProposalHoldsToResponse]);

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
          naturalLanguageEnabled={naturalLanguageEnabled}
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
              onMarkProposed={setProposalDraft}
              disableAdd={disableAdd}
            />
          </div>
        )}
        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {activeHolds.length > 0
              ? `${activeHolds.length} active proposal hold${activeHolds.length !== 1 ? "s" : ""}`
              : "No active proposal holds"}
          </span>
          <button
            type="button"
            onClick={() => setHoldsDrawerOpen(true)}
            className="rounded-md border border-border px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted"
          >
            Active holds
          </button>
        </div>
        <SearchResults
          response={response}
          loading={false}
          searchContext={searchContext}
          onCompareSelected={handleCompareSelected}
          onAddSingle={compare.addTutor}
          onMarkProposed={setProposalDraft}
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
          proposalHolds={activeHolds}
        />
      </div>
      <CopyForParentDrawer
        open={drawerSlots !== null}
        onClose={handleCloseDrawer}
        slots={drawerSlots ?? []}
        searchContext={searchContext}
      />
      <ProposalHoldModal
        draft={proposalDraft}
        onClose={() => setProposalDraft(null)}
        onCreated={handleProposalCreated}
      />
      <ActiveHoldsDrawer
        open={holdsDrawerOpen}
        holds={activeHolds}
        loading={holdsLoading}
        actionLoadingId={proposalActionLoadingId}
        onClose={() => setHoldsDrawerOpen(false)}
        onRefresh={refreshProposalHolds}
        onAction={handleProposalAction}
      />
    </div>
  );
}
