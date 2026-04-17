"use client";

import { useState } from "react";
import { Plus, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RangeGridRow, TutorReviewResult, BlockingSessionInfo } from "@/lib/search/types";

function formatSlotLabel(start: string, end: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const suffix = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

function formatClassType(classType: string): string {
  if (classType === "ONE_TO_ONE") return "1:1";
  if (classType === "GROUP") return "Group";
  return classType;
}

function BlockingSessionPopover({ sessions }: { sessions: BlockingSessionInfo[] }) {
  if (sessions.length === 0) return null;

  return (
    <div className="space-y-2 text-xs">
      {sessions.map((s, i) => (
        <div key={i}>
          {i > 0 && <div className="border-t border-border my-2" />}
          {s.studentName && (
            <p className="font-semibold text-foreground">{s.studentName}</p>
          )}
          {s.subject && (
            <p className="text-muted-foreground">{s.subject}</p>
          )}
          <p className="text-muted-foreground">
            {formatSlotLabel(s.startTime, s.endTime)}
          </p>
          <div className="flex gap-1 flex-wrap mt-1">
            {s.classType && (
              <Badge variant="outline" className="text-[10px] px-1 py-0">
                {formatClassType(s.classType)}
              </Badge>
            )}
            {s.location && (
              <Badge variant="outline" className="text-[10px] px-1 py-0">
                {s.location}
              </Badge>
            )}
            {s.recurrenceId && (
              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                recurring
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface AvailabilityGridProps {
  subSlots: { start: string; end: string }[];
  grid: RangeGridRow[];
  needsReview: TutorReviewResult[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onAddSingle: (id: string, name: string) => void;
  disableAdd: boolean;
}

export function AvailabilityGrid({
  subSlots,
  grid,
  needsReview,
  selectedIds,
  onToggleSelect,
  onAddSingle,
  disableAdd,
}: AvailabilityGridProps) {
  const [flashedId, setFlashedId] = useState<string | null>(null);

  const handleQuickAdd = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (disableAdd) return;
    onAddSingle(id, name);
    setFlashedId(id);
    window.setTimeout(() => {
      setFlashedId((current) => (current === id ? null : current));
    }, 800);
  };

  if (grid.length === 0 && needsReview.length === 0) {
    return (
      <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
        No tutors found matching your criteria.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {grid.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm table-fixed">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-8 px-2 py-2 text-left" />
                <th className="w-28 px-2 py-2 text-left font-medium">Tutor</th>
                {subSlots.map((ss, i) => (
                  <th key={i} className="px-1 py-2 text-center font-medium text-xs truncate">
                    {formatSlotLabel(ss.start, ss.end)}
                  </th>
                ))}
                <th className="w-20 px-2 py-2 text-left font-medium">Mode</th>
                <th className="w-8 px-1 py-2 text-center" aria-label="Add to compare" />
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => {
                const isSelected = selectedIds.has(row.tutorGroupId);
                return (
                  <tr
                    key={row.tutorGroupId}
                    className={`border-b cursor-pointer transition-colors ${
                      isSelected ? "bg-primary/10" : "hover:bg-muted/30"
                    }`}
                    onClick={() => onToggleSelect(row.tutorGroupId)}
                  >
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect(row.tutorGroupId)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{row.displayName}</td>
                    {row.availability.map((cell, i) => {
                      const isAvailable = cell === true;
                      const blockingSessions = isAvailable ? [] : (cell as BlockingSessionInfo[]);
                      const hasDetails = blockingSessions.length > 0;

                      if (isAvailable) {
                        return (
                          <td
                            key={i}
                            className="px-2 py-2 text-center bg-available/15 text-available"
                          >
                            {"\u2713"}
                          </td>
                        );
                      }

                      if (hasDetails) {
                        return (
                          <td key={i} className="px-2 py-2 text-center">
                            <Popover>
                              <PopoverTrigger
                                onClick={(e) => e.stopPropagation()}
                                className="cursor-help text-blocked/60 hover:text-blocked transition-colors"
                              >
                                {"\u2022"}
                              </PopoverTrigger>
                              <PopoverContent
                                side="top"
                                className="w-56 p-3"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <BlockingSessionPopover sessions={blockingSessions} />
                              </PopoverContent>
                            </Popover>
                          </td>
                        );
                      }

                      return (
                        <td
                          key={i}
                          className="px-2 py-2 text-center text-muted-foreground/30"
                        >
                          {"\u2014"}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {row.supportedModes.map((m) => (
                          <Badge key={m} variant="secondary" className="text-xs">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="w-8 px-1 py-2 text-center">
                      <button
                        type="button"
                        onClick={(e) => handleQuickAdd(e, row.tutorGroupId, row.displayName)}
                        disabled={disableAdd}
                        title={disableAdd ? "Remove a tutor first (max 3)" : "Add to compare"}
                        aria-label={disableAdd ? "Maximum 3 tutors — remove one first" : `Add ${row.displayName} to compare`}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                          disableAdd
                            ? "opacity-40 cursor-not-allowed"
                            : "text-muted-foreground hover:bg-muted hover:text-primary cursor-pointer"
                        }`}
                      >
                        {flashedId === row.tutorGroupId ? (
                          <Check className="h-3.5 w-3.5 text-available" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {needsReview.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Needs Review ({needsReview.length})
          </h3>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="w-28 px-2 py-2 text-left font-medium">Tutor</th>
                  <th className="px-2 py-2 text-left font-medium">Reasons</th>
                  <th className="w-8 px-1 py-2 text-center" aria-label="Add to compare" />
                </tr>
              </thead>
              <tbody>
                {needsReview.map((t) => (
                  <tr key={t.tutorGroupId} className="border-b">
                    <td className="px-3 py-2 font-medium">{t.displayName}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {t.reasons.map((r, i) => (
                          <Badge key={i} variant="destructive" className="text-xs">
                            {r.split(":")[0]}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="w-8 px-1 py-2 text-center">
                      <button
                        type="button"
                        onClick={(e) => handleQuickAdd(e, t.tutorGroupId, t.displayName)}
                        disabled={disableAdd}
                        title={disableAdd ? "Remove a tutor first (max 3)" : "Add to compare"}
                        aria-label={disableAdd ? "Maximum 3 tutors — remove one first" : `Add ${t.displayName} to compare`}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${
                          disableAdd
                            ? "opacity-40 cursor-not-allowed"
                            : "text-muted-foreground hover:bg-muted hover:text-primary cursor-pointer"
                        }`}
                      >
                        {flashedId === t.tutorGroupId ? (
                          <Check className="h-3.5 w-3.5 text-available" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
