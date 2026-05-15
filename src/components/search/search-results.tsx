"use client";

import { useState, useEffect } from "react";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AvailabilityGrid } from "@/components/search/availability-grid";
import { CopyButton } from "@/components/search/copy-button";
import type { SearchContext } from "@/components/search/search-form";
import type { RangeSearchResponse } from "@/lib/search/types";
import type { ProposalDraft, ProposalDraftItem } from "@/components/search/proposal-hold-modal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResultsProps {
  response: RangeSearchResponse | null;
  loading: boolean;
  searchContext: SearchContext | null;
  onCompareSelected: (ids: string[]) => void;
  onAddSingle: (id: string, name: string) => void;
  onMarkProposed: (draft: ProposalDraft) => void;
  disableAdd: boolean;
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

// ---------------------------------------------------------------------------
// SearchResults component
// ---------------------------------------------------------------------------

export function SearchResults({
  response,
  loading,
  searchContext,
  onCompareSelected,
  onAddSingle,
  onMarkProposed,
  disableAdd,
}: SearchResultsProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Reset selection when response changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIds(new Set());
  }, [response]);

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCompareSelected = () => {
    onCompareSelected([...selectedIds]);
  };

  const buildSelectedProposalDraft = (): ProposalDraft | null => {
    if (!response || !searchContext) return null;

    const items: ProposalDraftItem[] = [];
    for (const row of response.grid) {
      if (!selectedIds.has(row.tutorGroupId)) continue;
      row.availability.forEach((cell, index) => {
        if (cell !== true) return;
        const slot = response.subSlots[index];
        items.push({
          tutorGroupId: row.tutorGroupId,
          tutorDisplayName: row.displayName,
          scope: searchContext.searchMode,
          weekday: searchContext.dayOfWeek,
          date: searchContext.date,
          startMinute: parseTimeToMinutes(slot.start),
          endMinute: parseTimeToMinutes(slot.end),
          subject: searchContext.filters.subject,
          curriculum: searchContext.filters.curriculum,
          level: searchContext.filters.level,
        });
      });
    }

    if (items.length === 0) return null;
    return {
      sourceLabel: `Selected search results (${selectedIds.size} tutor${selectedIds.size !== 1 ? "s" : ""})`,
      items,
    };
  };

  const selectedProposalDraft = buildSelectedProposalDraft();

  if (response) {
    return (
      <div className="flex-1 overflow-y-auto mt-2 min-h-0">
        <div className="flex items-center justify-between mb-1 sticky top-0 bg-background z-10 pb-1">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>
              {response.snapshotMeta.snapshotId.slice(0, 8)}
            </span>
            <span>·</span>
            <span>{response.latencyMs}ms</span>
            {response.snapshotMeta.stale && (
              <Badge variant="destructive" className="text-[10px]">
                Stale
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <CopyButton
              grid={response.grid}
              subSlots={response.subSlots}
              selectedIds={selectedIds}
              dayOfWeek={searchContext?.dayOfWeek}
              date={searchContext?.date}
              filters={searchContext?.filters ?? {}}
            />
            {selectedIds.size >= 2 && selectedIds.size <= 3 && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={handleCompareSelected}
              >
                Compare ({selectedIds.size})
              </Button>
            )}
            {selectedIds.size > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7 gap-1"
                disabled={!selectedProposalDraft}
                onClick={() => {
                  if (selectedProposalDraft) onMarkProposed(selectedProposalDraft);
                }}
              >
                <LockKeyhole className="h-3 w-3" aria-hidden />
                Mark proposed
              </Button>
            )}
          </div>
        </div>
        {response.warnings.length > 0 && (
          <div className="space-y-1 mb-2">
            {response.warnings.map((w, i) => (
              <div
                key={i}
                className="rounded-md bg-accent/60 p-1.5 text-[10px] text-accent-foreground"
              >
                {w}
              </div>
            ))}
          </div>
        )}
        <AvailabilityGrid
          subSlots={response.subSlots}
          grid={response.grid}
          needsReview={response.needsReview}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
          onAddSingle={onAddSingle}
          disableAdd={disableAdd}
        />
      </div>
    );
  }

  if (!loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Search for available tutors
      </div>
    );
  }

  return null;
}
