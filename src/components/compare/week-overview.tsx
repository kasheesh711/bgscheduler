"use client";

import { useMemo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import type { CompareTutor, Conflict, SharedFreeSlot, CompareSessionBlock } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";

const HOUR_HEIGHT = 48;
const START_HOUR = 7;
const END_HOUR = 21;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function minuteToY(minute: number): number {
  return ((minute / 60) - START_HOUR) * HOUR_HEIGHT;
}

function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function formatClassType(ct?: string): string {
  if (ct === "ONE_TO_ONE") return "1:1";
  if (ct === "GROUP") return "Group";
  return ct ?? "";
}

// ── Overlap layout algorithm (Google Calendar style) ──────────────

interface LayoutBlock {
  session: CompareSessionBlock;
  tutorIdx: number;
  tutorGroupId: string;
  displayName: string;
  col: number;     // column index within overlap group
  totalCols: number; // total columns in overlap group
}

/**
 * Lay out sessions within a day column like Google Calendar:
 * - Non-overlapping sessions get full width
 * - Overlapping sessions split the width equally
 */
function layoutSessions(
  tutors: CompareTutor[],
  day: number,
): LayoutBlock[] {
  // Collect all sessions for this day with tutor metadata
  const items: { session: CompareSessionBlock; tutorIdx: number; tutorGroupId: string; displayName: string }[] = [];
  for (let i = 0; i < tutors.length; i++) {
    for (const s of tutors[i].sessions) {
      if (s.weekday === day) {
        items.push({ session: s, tutorIdx: i, tutorGroupId: tutors[i].tutorGroupId, displayName: tutors[i].displayName });
      }
    }
  }

  // Sort by start time, then by tutor index for stability
  items.sort((a, b) => a.session.startMinute - b.session.startMinute || a.tutorIdx - b.tutorIdx);

  if (items.length === 0) return [];

  // Group overlapping sessions using a sweep-line approach
  const results: LayoutBlock[] = [];
  let groupStart = 0;

  while (groupStart < items.length) {
    // Find all items that form a connected overlap group
    let groupEnd = groupStart;
    let maxEnd = items[groupStart].session.endMinute;

    while (groupEnd + 1 < items.length && items[groupEnd + 1].session.startMinute < maxEnd) {
      groupEnd++;
      maxEnd = Math.max(maxEnd, items[groupEnd].session.endMinute);
    }

    // Assign columns within this group using greedy column assignment
    const group = items.slice(groupStart, groupEnd + 1);
    const colEnds: number[] = []; // tracks the end minute of each column

    for (const item of group) {
      // Find the first column where this session fits (doesn't overlap)
      let col = -1;
      for (let c = 0; c < colEnds.length; c++) {
        if (item.session.startMinute >= colEnds[c]) {
          col = c;
          break;
        }
      }
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(0);
      }
      colEnds[col] = item.session.endMinute;

      results.push({
        ...item,
        col,
        totalCols: 0, // will fill in below
      });
    }

    // Set totalCols for all items in this group
    const totalCols = colEnds.length;
    for (let i = results.length - group.length; i < results.length; i++) {
      results[i].totalCols = totalCols;
    }

    groupStart = groupEnd + 1;
  }

  return results;
}

// ── Component ─────────────────────────────────────────────────────

interface WeekOverviewProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  conflicts: Conflict[];
  sharedFreeSlots?: SharedFreeSlot[];
  onDayClick: (day: number) => void;
}

export function WeekOverview({ tutors, tutorChips, conflicts, sharedFreeSlots, onDayClick }: WeekOverviewProps) {
  const conflictsByDay = useMemo(() => {
    const map = new Map<number, Conflict[]>();
    for (const c of conflicts) {
      const list = map.get(c.dayOfWeek) ?? [];
      list.push(c);
      map.set(c.dayOfWeek, list);
    }
    return map;
  }, [conflicts]);

  const layoutsByDay = useMemo(() => {
    const map = new Map<number, LayoutBlock[]>();
    for (const day of DISPLAY_DAYS) {
      map.set(day, layoutSessions(tutors, day));
    }
    return map;
  }, [tutors]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Time axis */}
      <div className="flex-shrink-0 w-10 pt-8 relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT + 32 }}>
        {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
          const hour = START_HOUR + i;
          return (
            <div
              key={hour}
              className="absolute text-[10px] text-muted-foreground text-right pr-1 w-10"
              style={{ top: i * HOUR_HEIGHT + 32 - 6 }}
            >
              {hour === 0 ? "12a" : hour < 12 ? `${hour}a` : hour === 12 ? "12p" : `${hour - 12}p`}
            </div>
          );
        })}
      </div>

      {/* Day columns */}
      <div className="flex-1 flex overflow-hidden">
        {DISPLAY_DAYS.map((day) => {
          const dayConflicts = conflictsByDay.get(day) ?? [];
          const blocks = layoutsByDay.get(day) ?? [];
          return (
            <div key={day} className="flex-1 min-w-0 border-r border-border/30 last:border-r-0 flex flex-col">
              {/* Day header */}
              <button
                className="h-8 flex items-center justify-center text-xs font-medium hover:bg-muted/50 transition-colors border-b border-border/30 flex-shrink-0"
                onClick={() => onDayClick(day)}
              >
                {DAY_NAMES[day]}
                {dayConflicts.length > 0 && <span className="ml-1 text-conflict">!</span>}
              </button>

              {/* Time grid with sessions */}
              <div
                className="relative flex-1"
                style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
              >
                {/* Grid lines */}
                {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
                  <div
                    key={i}
                    className="absolute left-0 right-0 border-t border-border/20"
                    style={{ top: i * HOUR_HEIGHT }}
                  />
                ))}

                {/* Conflict bands */}
                {dayConflicts.map((c, ci) => {
                  const top = minuteToY(c.startMinute);
                  const height = ((c.endMinute - c.startMinute) / 60) * HOUR_HEIGHT;
                  return (
                    <div
                      key={`conflict-${ci}`}
                      className="absolute left-0 right-0 bg-conflict/8 border-y border-conflict/20 z-0"
                      style={{ top, height: Math.max(height, 2) }}
                    />
                  );
                })}

                {/* Session blocks — full-width with overlap splitting */}
                {blocks.map((block, bIdx) => {
                  const { session: s, tutorIdx, col, totalCols } = block;
                  const chip = tutorChips[tutorIdx];
                  const top = minuteToY(s.startMinute);
                  const height = ((s.endMinute - s.startMinute) / 60) * HOUR_HEIGHT;
                  const isConflict = dayConflicts.some(
                    (c) =>
                      s.studentName &&
                      c.studentName.toLowerCase() === s.studentName?.toLowerCase() &&
                      s.startMinute < c.endMinute &&
                      s.endMinute > c.startMinute,
                  );
                  const bgColor = isConflict
                    ? "rgba(239, 68, 68, 0.2)"
                    : `${chip?.color}30`;
                  const borderColor = isConflict ? "#ef4444" : chip?.color;

                  // Position: col/totalCols within the day column width
                  const colWidthPct = 100 / totalCols;
                  const leftPct = col * colWidthPct;

                  return (
                    <Popover key={`block-${day}-${bIdx}`}>
                      <PopoverTrigger
                        className="absolute rounded-sm cursor-pointer overflow-hidden z-[1] text-left"
                        style={{
                          top: top + 1,
                          left: `calc(${leftPct}% + 1px)`,
                          width: `calc(${colWidthPct}% - 2px)`,
                          height: Math.max(height - 2, 14),
                          background: bgColor,
                          borderLeft: `3px solid ${borderColor}`,
                        }}
                      >
                        <div className="px-1 py-0.5 overflow-hidden">
                          <div
                            className="text-[11px] leading-tight font-semibold truncate"
                            style={{ color: isConflict ? "#fca5a5" : `${chip?.color}` }}
                          >
                            {minuteToLabel(s.startMinute)}
                          </div>
                          {height > 24 && (
                            <div className="text-[10px] leading-tight text-foreground/70 truncate">
                              {s.subject ?? ""}
                            </div>
                          )}
                          {height > 38 && s.studentName && (
                            <div className="text-[9px] leading-tight text-muted-foreground truncate">
                              {s.studentName}
                            </div>
                          )}
                        </div>
                      </PopoverTrigger>
                      <PopoverContent side="top" className="w-56 p-3 text-xs space-y-1 z-50">
                        <p className="font-semibold text-sm" style={{ color: chip?.color }}>
                          {block.displayName}
                        </p>
                        {s.studentName && <p className="font-medium">{s.studentName}</p>}
                        {s.subject && <p className="text-muted-foreground">{s.subject}</p>}
                        <p>{minuteToLabel(s.startMinute)}–{minuteToLabel(s.endMinute)}</p>
                        <div className="flex gap-1 flex-wrap">
                          {s.classType && <Badge variant="outline" className="text-[10px] px-1 py-0">{formatClassType(s.classType)}</Badge>}
                          {s.location && <Badge variant="outline" className="text-[10px] px-1 py-0">{s.location}</Badge>}
                        </div>
                        {isConflict && (
                          <p className="text-conflict text-[10px] font-medium">Conflict detected</p>
                        )}
                      </PopoverContent>
                    </Popover>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
