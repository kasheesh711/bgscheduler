"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CompareTutor, Conflict, SharedFreeSlot } from "@/lib/search/types";
import type { TutorChip } from "./tutor-selector";

const HOUR_HEIGHT = 60;
const START_HOUR = 7;
const END_HOUR = 21;
const TOTAL_HOURS = END_HOUR - START_HOUR;

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

interface CalendarGridProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  conflicts: Conflict[];
  sharedFreeSlots: SharedFreeSlot[];
  dayOfWeek: number;
  onFindAlternatives?: (conflict: Conflict) => void;
  onTutorNameClick?: (tutorGroupId: string) => void;
}

export function CalendarGrid({
  tutors,
  tutorChips,
  conflicts,
  sharedFreeSlots,
  dayOfWeek,
  onFindAlternatives,
  onTutorNameClick,
}: CalendarGridProps) {
  const dayConflicts = useMemo(
    () => conflicts.filter((c) => c.dayOfWeek === dayOfWeek),
    [conflicts, dayOfWeek],
  );

  const dayFreeSlots = useMemo(
    () => sharedFreeSlots.filter((s) => s.dayOfWeek === dayOfWeek),
    [sharedFreeSlots, dayOfWeek],
  );

  const conflictRanges = useMemo(() => {
    return dayConflicts.map((c) => ({
      top: minuteToY(c.startMinute),
      height: ((c.endMinute - c.startMinute) / 60) * HOUR_HEIGHT,
      conflict: c,
    }));
  }, [dayConflicts]);

  return (
    <div className="relative" style={{ marginLeft: 50 }}>
      {/* Column headers */}
      <div className="flex border-b sticky top-0 bg-background z-10">
        {tutors.map((t, i) => {
          const chip = tutorChips[i];
          return (
            <div key={t.tutorGroupId} className="flex-1 px-3 py-2 text-center border-r last:border-r-0">
              <button
                className="font-semibold text-sm hover:underline"
                style={{ color: chip?.color }}
                onClick={() => onTutorNameClick?.(t.tutorGroupId)}
              >
                {t.displayName}
              </button>
              <div className="text-[10px] text-muted-foreground">
                {t.supportedModes.join(" · ")} · {t.qualifications.map((q) => q.subject).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
              </div>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
        {/* Time labels */}
        <div className="absolute top-0 h-full" style={{ left: -50, width: 45 }}>
          {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => {
            const hour = START_HOUR + i;
            return (
              <div
                key={hour}
                className="absolute text-[10px] text-muted-foreground text-right pr-2"
                style={{ top: i * HOUR_HEIGHT - 6, width: 45 }}
              >
                {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
              </div>
            );
          })}
        </div>

        {/* Grid lines */}
        {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
          <div
            key={i}
            className="absolute left-0 right-0 border-t border-border/30"
            style={{ top: i * HOUR_HEIGHT }}
          />
        ))}

        {/* Column dividers */}
        {tutors.slice(0, -1).map((_, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 border-l border-border/30"
            style={{ left: `${((i + 1) / tutors.length) * 100}%` }}
          />
        ))}

        {/* Conflict highlight bands */}
        {conflictRanges.map((cr, i) => (
          <div
            key={`conflict-${i}`}
            className="absolute left-0 right-0 bg-red-500/5 border-y border-red-500/20 z-0"
            style={{ top: cr.top, height: cr.height }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 bg-red-500 text-white text-[9px] px-2 py-0.5 rounded-l font-semibold whitespace-nowrap flex items-center gap-1">
              <span>⚠ {cr.conflict.studentName}</span>
              {onFindAlternatives && (
                <button
                  className="underline ml-1"
                  onClick={() => onFindAlternatives(cr.conflict)}
                >
                  Find alt
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Session blocks per tutor */}
        {tutors.map((t, tutorIdx) => {
          const chip = tutorChips[tutorIdx];
          const colWidth = 100 / tutors.length;
          const colLeft = tutorIdx * colWidth;

          return t.sessions
            .filter((s) => s.weekday === dayOfWeek)
            .map((s, sIdx) => {
              const top = minuteToY(s.startMinute);
              const height = ((s.endMinute - s.startMinute) / 60) * HOUR_HEIGHT;
              const isConflict = dayConflicts.some(
                (c) =>
                  s.studentName &&
                  c.studentName.toLowerCase() === s.studentName.toLowerCase() &&
                  s.startMinute < c.endMinute &&
                  s.endMinute > c.startMinute,
              );
              const bgColor = isConflict
                ? "rgba(239, 68, 68, 0.25)"
                : `${chip?.color}33`;
              const borderColor = isConflict ? "#ef4444" : chip?.color;

              return (
                <Popover key={`${t.tutorGroupId}-${sIdx}`}>
                  <PopoverTrigger
                    className="absolute rounded cursor-pointer overflow-hidden z-[1] text-left"
                    style={{
                      top: top + 2,
                      left: `calc(${colLeft}% + 4px)`,
                      width: `calc(${colWidth}% - 8px)`,
                      height: height - 4,
                      background: bgColor,
                      borderLeft: `3px solid ${borderColor}`,
                    }}
                  >
                    <div className="p-1.5 text-[11px] leading-tight">
                      <div className="font-semibold" style={{ color: isConflict ? "#fca5a5" : `${chip?.color}dd` }}>
                        {s.subject ?? "Session"} — {s.studentName ?? "Unknown"}
                        {isConflict && " ⚠️"}
                      </div>
                      <div className="text-muted-foreground text-[10px]">
                        {minuteToLabel(s.startMinute)}–{minuteToLabel(s.endMinute)}
                        {s.classType && ` · ${formatClassType(s.classType)}`}
                        {s.location && ` · ${s.location}`}
                      </div>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent side="top" className="w-56 p-3 text-xs space-y-1">
                    {s.studentName && <p className="font-semibold">{s.studentName}</p>}
                    {s.subject && <p className="text-muted-foreground">{s.subject}</p>}
                    <p>{minuteToLabel(s.startMinute)}–{minuteToLabel(s.endMinute)}</p>
                    <div className="flex gap-1 flex-wrap">
                      {s.classType && <Badge variant="outline" className="text-[10px] px-1 py-0">{formatClassType(s.classType)}</Badge>}
                      {s.location && <Badge variant="outline" className="text-[10px] px-1 py-0">{s.location}</Badge>}
                      {s.recurrenceId && <Badge variant="secondary" className="text-[10px] px-1 py-0">recurring</Badge>}
                    </div>
                  </PopoverContent>
                </Popover>
              );
            });
        })}

        {/* Shared free slot indicators */}
        {dayFreeSlots.map((slot, i) => {
          const top = minuteToY(slot.startMinute);
          const height = ((slot.endMinute - slot.startMinute) / 60) * HOUR_HEIGHT;
          return (
            <div
              key={`free-${i}`}
              className="absolute left-0 right-0 flex items-center justify-center z-[1] pointer-events-none"
              style={{ top, height }}
            >
              <div className="bg-green-500/5 border border-dashed border-green-500/20 rounded px-3 py-0.5 text-green-400 text-[10px]">
                {minuteToLabel(slot.startMinute)}–{minuteToLabel(slot.endMinute)} · All free
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
