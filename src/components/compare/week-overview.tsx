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

                {/* Session blocks — full width, stacked by tutor */}
                {tutors.map((t, tutorIdx) => {
                  const chip = tutorChips[tutorIdx];
                  const sessions = t.sessions.filter((s) => s.weekday === day);
                  const left = multiTutorLayout
                    ? `calc(${tutorIdx * laneWidth}% + 2px)`
                    : "1px";
                  const width = multiTutorLayout
                    ? `calc(${laneWidth}% - 4px)`
                    : "calc(100% - 2px)";

                  return sessions.map((s, sIdx) => {
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
                    const border = sessionBorderStyle(
                      chip?.color,
                      isConflict,
                      s.modality,
                      s.sessionType,
                      s.location,
                    );
                    const showSecondaryLine = height >= (multiTutorLayout ? 40 : 30);

                    return (
                      <Popover key={`${t.tutorGroupId}-${day}-${sIdx}`}>
                        <PopoverTrigger
                          render={(props) => (
                            <button
                              type="button"
                              {...props}
                              className="absolute cursor-pointer overflow-hidden rounded-sm border-0 bg-transparent p-0 text-left shadow-none outline-none appearance-none"
                              style={{
                                top: top + 2,
                                left,
                                width,
                                height: Math.max(height - 4, 14),
                                backgroundColor: bgColor,
                                borderLeft: border,
                                boxShadow: `inset 0 0 0 1px ${frameColor}`,
                                zIndex: multiTutorLayout ? 1 : tutorIdx + 1,
                              }}
                            >
                              <div className="px-1 py-0.5 overflow-hidden">
                                <div
                                  className={`leading-tight font-semibold truncate ${
                                    multiTutorLayout ? "text-[10px]" : "text-[11px]"
                                  }`}
                                  style={{ color: textColor }}
                                >
                                  {minuteToLabel(s.startMinute)} {s.subject ?? ""}
                                </div>
                                {showSecondaryLine && s.studentName && (
                                  <div className="text-[10px] leading-tight text-foreground/60 truncate">
                                    {s.studentName}
                                  </div>
                                )}
                              </div>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
