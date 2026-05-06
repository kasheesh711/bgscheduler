"use client";

import { memo, useMemo } from "react";
import type { CompareTutor } from "@/lib/search/types";
import { rgba, TUTOR_COLORS } from "./session-colors";
import type { TutorChip } from "./tutor-selector";

const DISPLAY_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_LABELS: Record<number, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

export interface DensityDayCell {
  weekday: number;
  label: string;
  bookedMinutes: number;
  sessionCount: number;
  availableMinutes: number;
  fillRatio: number;
}

export interface DensityRow {
  tutorGroupId: string;
  displayName: string;
  color: string;
  weeklyHoursBooked: number;
  days: DensityDayCell[];
}

export interface DensityOverviewProps {
  tutors: CompareTutor[];
  tutorChips: TutorChip[];
  activeDay: number | null;
  onDayClick: (weekday: number) => void;
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0h";

  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${Number(hours.toFixed(1))}h`;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${Number(hours.toFixed(1))}h`;
}

function resolveTutorColor(tutor: CompareTutor, tutorChips: TutorChip[], index: number): string {
  return (
    tutorChips.find((chip) => chip.tutorGroupId === tutor.tutorGroupId)?.color ??
    TUTOR_COLORS[index] ??
    "#888888"
  );
}

export function buildDensityRows(tutors: CompareTutor[], tutorChips: TutorChip[]): DensityRow[] {
  const rowsWithoutFill = tutors.map((tutor, tutorIndex) => {
    const days = DISPLAY_DAYS.map((weekday) => {
      const daySessions = tutor.sessions.filter((session) => session.weekday === weekday);
      const bookedMinutes = daySessions.reduce(
        (total, session) => total + Math.max(0, session.endMinute - session.startMinute),
        0,
      );
      const availableMinutes = tutor.availabilityWindows
        .filter((window) => window.weekday === weekday)
        .reduce((total, window) => total + Math.max(0, window.endMinute - window.startMinute), 0);

      return {
        weekday,
        label: DAY_LABELS[weekday],
        bookedMinutes,
        sessionCount: daySessions.length,
        availableMinutes,
        fillRatio: 0,
      };
    });

    return {
      tutorGroupId: tutor.tutorGroupId,
      displayName: tutor.displayName,
      color: resolveTutorColor(tutor, tutorChips, tutorIndex),
      weeklyHoursBooked: tutor.weeklyHoursBooked,
      days,
    };
  });

  const allCells = rowsWithoutFill.flatMap((row) => row.days);
  const maxBookedMinutes = Math.max(60, ...allCells.map((cell) => cell.bookedMinutes));

  return rowsWithoutFill.map((row) => ({
    ...row,
    days: row.days.map((cell) => ({
      ...cell,
      fillRatio: cell.bookedMinutes === 0 ? 0 : cell.bookedMinutes / maxBookedMinutes,
    })),
  }));
}

export const DensityOverview = memo(function DensityOverview({
  tutors,
  tutorChips,
  activeDay,
  onDayClick,
}: DensityOverviewProps) {
  const rows = useMemo(() => buildDensityRows(tutors, tutorChips), [tutors, tutorChips]);

  if (tutors.length === 0) return null;

  return (
    <section aria-label="Visible week booking density" className="flex-shrink-0 border-b border-border/60 py-1">
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.tutorGroupId} className="grid grid-cols-[96px_1fr] items-center gap-2">
            <div className="min-w-0 pl-2" style={{ borderLeft: `3px solid ${row.color}` }}>
              <div className="truncate text-[11px] font-semibold leading-tight" style={{ color: row.color }}>
                {row.displayName}
              </div>
              <div className="truncate text-[10px] leading-tight text-muted-foreground">
                {formatHours(row.weeklyHoursBooked)} booked
              </div>
            </div>

            <div className="grid grid-cols-7 gap-1">
              {row.days.map((day) => {
                const fillRatio = day.fillRatio;
                const fillWidth = fillRatio === 0 ? 0 : Math.max(fillRatio * 100, 12);
                const segmentLabel = `${day.label}: ${row.displayName}, ${formatMinutes(day.bookedMinutes)} booked, ${day.sessionCount} session(s). Open day view.`;
                const isActive = activeDay === day.weekday;

                return (
                  <button
                    key={day.weekday}
                    type="button"
                    aria-current={activeDay === day.weekday ? "date" : undefined}
                    aria-label={segmentLabel}
                    title={segmentLabel}
                    onClick={() => onDayClick(day.weekday)}
                    className={[
                      "relative h-8 overflow-hidden rounded border border-border/60 bg-muted/30 px-1 text-[10px] font-semibold leading-none text-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                      isActive ? "border-primary/70 ring-1 ring-primary/40" : "",
                    ].join(" ")}
                  >
                    {day.bookedMinutes > 0 ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-1 left-0 rounded-r"
                        style={{
                          width: `${fillWidth}%`,
                          backgroundColor: rgba(row.color, 0.24),
                          borderLeft: `3px solid ${row.color}`,
                        }}
                      />
                    ) : null}
                    <span className="relative z-10 block truncate">
                      {day.bookedMinutes > 0 ? formatMinutes(day.bookedMinutes) : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
});
