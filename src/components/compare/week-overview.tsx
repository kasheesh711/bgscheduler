"use client";

import { useMemo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import type { CompareTutor, Conflict, SharedFreeSlot } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";
import {
  sessionBgColor,
  sessionBorderStyle,
  sessionFrameColor,
  sessionTextColor,
  rgba,
} from "./session-colors";

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

// ---------------------------------------------------------------------------
// Overlap detection — GCal-style sub-column layout for overlapping sessions
// ---------------------------------------------------------------------------

interface LayoutInfo {
  column: number;
  totalColumns: number;
}

function computeOverlapColumns(
  sessions: { startMinute: number; endMinute: number }[],
): LayoutInfo[] {
  if (sessions.length === 0) return [];

  // Sort indices by start time, then by duration descending (longer sessions first)
  const indices = sessions.map((_, i) => i);
  indices.sort((a, b) => {
    const diff = sessions[a].startMinute - sessions[b].startMinute;
    if (diff !== 0) return diff;
    return (sessions[b].endMinute - sessions[b].startMinute) -
           (sessions[a].endMinute - sessions[a].startMinute);
  });

  // Greedy column assignment
  const columns = new Array<number>(sessions.length).fill(0);
  const columnEnds: number[] = [];

  for (const idx of indices) {
    const s = sessions[idx];
    let placed = false;
    for (let c = 0; c < columnEnds.length; c++) {
      if (columnEnds[c] <= s.startMinute) {
        columns[idx] = c;
        columnEnds[c] = s.endMinute;
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns[idx] = columnEnds.length;
      columnEnds.push(s.endMinute);
    }
  }

  // Build connected overlap groups via union-find
  const parent = sessions.map((_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      const si = sessions[indices[i]];
      const sj = sessions[indices[j]];
      // Sorted by start, so sj.startMinute >= si.startMinute
      if (sj.startMinute >= si.endMinute) break; // no more overlaps possible
      union(indices[i], indices[j]);
    }
  }

  // Count max column per group
  const groupMaxCol = new Map<number, number>();
  for (let i = 0; i < sessions.length; i++) {
    const root = find(i);
    groupMaxCol.set(root, Math.max(groupMaxCol.get(root) ?? 0, columns[i] + 1));
  }

  return sessions.map((_, i) => ({
    column: columns[i],
    totalColumns: groupMaxCol.get(find(i)) ?? 1,
  }));
}

interface CappedLayoutInfo extends LayoutInfo {
  hidden: boolean;
  overflowCount: number;
}

function applyColumnCap(
  sessions: { startMinute: number; endMinute: number }[],
  layout: LayoutInfo[],
  maxCols: number,
): CappedLayoutInfo[] {
  if (sessions.length === 0) return [];

  const result: CappedLayoutInfo[] = layout.map((l) => ({
    ...l,
    hidden: false,
    overflowCount: 0,
  }));

  // Find overlap groups (sessions sharing the same totalColumns value from union-find)
  // Group by the original totalColumns — sessions in the same overlap cluster share this
  const groups = new Map<number, number[]>(); // totalColumns -> indices
  for (let i = 0; i < layout.length; i++) {
    // Use a composite key: sessions in the same overlap group have identical totalColumns
    // AND they actually overlap temporally. We can use the column assignment to identify groups.
    const key = layout[i].totalColumns;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }

  for (const [totalCols, indices] of groups) {
    if (totalCols <= maxCols) continue;

    // Hide sessions in columns >= maxCols
    const hiddenIndices: number[] = [];
    for (const idx of indices) {
      if (result[idx].column >= maxCols) {
        result[idx].hidden = true;
        hiddenIndices.push(idx);
      }
      // Cap totalColumns for visible sessions
      result[idx].totalColumns = maxCols;
    }

    // Count overflow for visible sessions in the last visible column
    for (const idx of indices) {
      if (result[idx].column === maxCols - 1 && !result[idx].hidden) {
        // Count hidden sessions that overlap with this one
        let count = 0;
        for (const hIdx of hiddenIndices) {
          if (
            sessions[hIdx].startMinute < sessions[idx].endMinute &&
            sessions[hIdx].endMinute > sessions[idx].startMinute
          ) {
            count++;
          }
        }
        result[idx].overflowCount = count;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------

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

  const multiTutorLayout = tutors.length > 1;
  const laneCount = multiTutorLayout ? tutors.length : 1;
  const laneWidth = 100 / laneCount;
  const maxCols = multiTutorLayout ? 2 : 3;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Sticky header row ── */}
      <div className="flex flex-shrink-0 border-b border-border/30">
        {/* Spacer above time axis */}
        <div className="flex-shrink-0 w-10 h-8" />
        {/* Day name buttons */}
        <div className="flex-1 flex">
          {DISPLAY_DAYS.map((day) => {
            const dayConflicts = conflictsByDay.get(day) ?? [];
            return (
              <button
                key={day}
                className="flex-1 min-w-0 h-8 flex items-center justify-center text-xs font-medium hover:bg-muted/50 transition-colors"
                onClick={() => onDayClick(day)}
              >
                {DAY_NAMES[day]}
                {dayConflicts.length > 0 && <span className="ml-1 text-conflict">!</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="flex" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
          {/* Time axis */}
          <div className="flex-shrink-0 w-10 relative">
            {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
              const hour = START_HOUR + i;
              return (
                <div
                  key={hour}
                  className="absolute text-[10px] text-muted-foreground text-right pr-1 w-10"
                  style={{ top: i * HOUR_HEIGHT - 6 }}
                >
                  {hour === 0 ? "12a" : hour < 12 ? `${hour}a` : hour === 12 ? "12p" : `${hour - 12}p`}
                </div>
              );
            })}
          </div>

          {/* Day columns */}
          <div className="flex-1 flex">
            {DISPLAY_DAYS.map((day) => {
              const dayConflicts = conflictsByDay.get(day) ?? [];
              return (
                <div
                  key={day}
                  className="flex-1 min-w-0 border-r border-border/30 last:border-r-0 relative"
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

                  {/* Lane dividers for multi-tutor */}
                  {multiTutorLayout &&
                    tutors.slice(0, -1).map((_, tutorIdx) => (
                      <div
                        key={`lane-${tutorIdx}`}
                        className="absolute top-0 bottom-0 border-r border-border/20"
                        style={{ left: `${(tutorIdx + 1) * laneWidth}%` }}
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

                  {/* Availability windows (behind sessions) */}
                  {tutors.map((t, tutorIdx) => {
                    const chip = tutorChips[tutorIdx];
                    const windows = t.availabilityWindows.filter((w) => w.weekday === day);
                    const laneLeftPct = multiTutorLayout ? tutorIdx * laneWidth : 0;
                    const laneWidthPct = multiTutorLayout ? laneWidth : 100;
                    return windows.map((w, wIdx) => {
                      const wTop = minuteToY(w.startMinute);
                      const wHeight = ((w.endMinute - w.startMinute) / 60) * HOUR_HEIGHT;
                      return (
                        <div
                          key={`avail-${tutorIdx}-${day}-${wIdx}`}
                          className="absolute z-0 pointer-events-none"
                          style={{
                            top: wTop,
                            height: Math.max(wHeight, 2),
                            left: `${laneLeftPct}%`,
                            width: `${laneWidthPct}%`,
                            backgroundColor: rgba(chip?.color ?? "#888", 0.06),
                            borderLeft: `2px solid ${rgba(chip?.color ?? "#888", 0.15)}`,
                          }}
                        />
                      );
                    });
                  })}

                  {/* Session blocks */}
                  {tutors.map((t, tutorIdx) => {
                    const chip = tutorChips[tutorIdx];
                    const sessions = t.sessions.filter((s) => s.weekday === day);
                    const layout = computeOverlapColumns(sessions);
                    const cappedLayout = applyColumnCap(sessions, layout, maxCols);

                    // Base lane geometry
                    const laneLeftPct = multiTutorLayout ? tutorIdx * laneWidth : 0;
                    const laneWidthPct = multiTutorLayout ? laneWidth : 100;

                    return sessions.map((s, sIdx) => {
                      const cl = cappedLayout[sIdx];
                      if (cl.hidden) return null;

                      const { column, totalColumns, overflowCount } = cl;
                      const subWidth = laneWidthPct / totalColumns;
                      const leftPct = laneLeftPct + column * subWidth;

                      const top = minuteToY(s.startMinute);
                      const height = ((s.endMinute - s.startMinute) / 60) * HOUR_HEIGHT;
                      const isConflict = dayConflicts.some(
                        (c) =>
                          s.studentName &&
                          c.studentName.toLowerCase() === s.studentName?.toLowerCase() &&
                          s.startMinute < c.endMinute &&
                          s.endMinute > c.startMinute,
                      );
                      const bgColor = sessionBgColor(chip?.color, isConflict);
                      const textColor = sessionTextColor(chip?.color, isConflict);
                      const frameColor = sessionFrameColor(chip?.color, isConflict);
                      const border = sessionBorderStyle(chip?.color, isConflict);
                      const isTooNarrow = totalColumns >= 3 && multiTutorLayout;
                      const isCompact = totalColumns >= 2;
                      const showSecondaryLine = !isCompact && height >= (multiTutorLayout ? 40 : 30);

                      return (
                        <Popover key={`${t.tutorGroupId}-${day}-${sIdx}`}>
                          <PopoverTrigger
                            render={(props) => (
                              <button
                                type="button"
                                {...props}
                                className="absolute cursor-pointer overflow-hidden rounded-sm border-0 bg-transparent p-0 text-left shadow-none outline-none appearance-none"
                                style={{
                                  top: top + 1,
                                  left: `calc(${leftPct}% + 1px)`,
                                  width: `calc(${subWidth}% - 2px)`,
                                  height: Math.max(height - 2, 18),
                                  backgroundColor: bgColor,
                                  borderLeft: border,
                                  boxShadow: `inset 0 0 0 1px ${frameColor}`,
                                  zIndex: multiTutorLayout ? 1 : tutorIdx + 1,
                                }}
                              >
                                {!isTooNarrow && (
                                  <div className="px-1 py-0.5 overflow-hidden">
                                    <div
                                      className={`leading-tight font-semibold truncate ${
                                        isCompact ? "text-[9px]" : multiTutorLayout ? "text-[10px]" : "text-[11px]"
                                      }`}
                                      style={{ color: textColor }}
                                    >
                                      {minuteToLabel(s.startMinute)}{!isCompact ? ` ${s.subject ?? ""}` : ""}
                                    </div>
                                    {showSecondaryLine && s.studentName && (
                                      <div className="text-[10px] leading-tight text-foreground/60 truncate">
                                        {s.studentName}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {overflowCount > 0 && (
                                  <div
                                    className="absolute bottom-0.5 right-0.5 text-[8px] font-semibold rounded px-1 cursor-pointer"
                                    style={{
                                      backgroundColor: rgba(chip?.color ?? "#888", 0.18),
                                      color: textColor,
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onDayClick(day);
                                    }}
                                  >
                                    +{overflowCount}
                                  </div>
                                )}
                              </button>
                            )}
                          />
                          <PopoverContent side="top" className="w-56 p-3 text-xs space-y-1 z-50">
                            <p className="font-semibold text-sm" style={{ color: chip?.color }}>
                              {t.displayName}
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
                    });
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
