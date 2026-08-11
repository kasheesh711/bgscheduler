"use client";

// ----------------------------------------------------------------------------
// Parent mini calendar — the phone-sized "calendar view" of the public page.
//
// A full month grid with session text does not fit a 375px screen, so below
// lg the calendar view is a compressed month of micro chips: each session is
// a truncated subject label on that subject's colour tint (the same
// rgba-tint-plus-colour-edge formula as the agenda cards and the desktop
// grid's SessionBlock, via the shared buildSubjectColorMap, so every surface
// agrees). Tapping a day hands the dateKey back to the shell, which returns
// to the agenda scrolled to that day. Navigation only — chips carry no
// time/teacher detail and taps never write the stored view preference.
// ----------------------------------------------------------------------------

import { cn } from "@/lib/utils";
import { buildMonthGrid, dayOfMonth } from "@/lib/calendar/month-grid";
import { rgba } from "@/components/compare/session-colors";
import { buildSubjectColorMap } from "./schedule-month-calendar";
import {
  PUBLIC_PAGE_COPY,
  THAI_WEEKDAY_INITIALS,
  formatThaiDayHeading,
} from "@/lib/line/schedule-bot-copy";
import type {
  StudentSchedulePayload,
  StudentScheduleSession,
} from "@/lib/student-schedule/types";

/** Chips drawn per day before collapsing the rest into a "+N". */
export const CHIP_CAP = 3;

/** First palette entry, for the impossible miss on an empty-subject session. */
const FALLBACK_COLOR = "#3b82f6";

export interface MiniCalendarChip {
  subject: string;
  color: string;
}

export interface MiniCalendarDay {
  dateKey: string;
  inMonth: boolean;
  day: number;
  isToday: boolean;
  /** 0 for out-of-month and empty days. */
  sessionCount: number;
  /** One chip per session, capped at CHIP_CAP. */
  chips: MiniCalendarChip[];
  /** Sessions beyond CHIP_CAP. */
  overflow: number;
}

export interface MiniCalendarModel {
  /** Exactly 42 cells, Monday-start — same grid maths as the month calendar. */
  days: MiniCalendarDay[];
}

/**
 * Pure model behind the component, exported so behaviour is testable without
 * DOM events: chip subjects/colours, the CHIP_CAP overflow, today detection,
 * and the out-of-month blanks.
 */
export function buildParentMiniCalendarModel(
  payload: StudentSchedulePayload,
  todayKey?: string,
): MiniCalendarModel {
  const subjectColors = buildSubjectColorMap(payload.sessions);
  const chipFor = (session: StudentScheduleSession): MiniCalendarChip => ({
    subject: session.subject,
    color: subjectColors.get(session.subject) ?? FALLBACK_COLOR,
  });

  const byDate = new Map<string, StudentScheduleSession[]>();
  for (const session of payload.sessions) {
    const bucket = byDate.get(session.dateKey);
    if (bucket) bucket.push(session);
    else byDate.set(session.dateKey, [session]);
  }

  const days = buildMonthGrid(payload.monthKey).map((cell) => {
    const sessions = cell.inMonth ? byDate.get(cell.dateKey) ?? [] : [];
    return {
      dateKey: cell.dateKey,
      inMonth: cell.inMonth,
      day: dayOfMonth(cell.dateKey),
      isToday: todayKey !== undefined && cell.dateKey === todayKey,
      sessionCount: sessions.length,
      chips: sessions.slice(0, CHIP_CAP).map(chipFor),
      overflow: Math.max(0, sessions.length - CHIP_CAP),
    };
  });

  return { days };
}

export function ParentScheduleMiniCalendar({
  payload,
  todayKey,
  onSelectDay,
}: {
  payload: StudentSchedulePayload;
  todayKey?: string;
  /** Called with the tapped day's dateKey; only session days are tappable. */
  onSelectDay: (dateKey: string) => void;
}) {
  const model = buildParentMiniCalendarModel(payload, todayKey);

  return (
    <div data-testid="parent-mini-calendar">
      <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
        {THAI_WEEKDAY_INITIALS.map((header) => (
          <div key={header} className="py-1.5">
            {header}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-x-1 gap-y-1.5">
        {model.days.map((cell) => {
          const dayNumber = (
            <span
              className={cn(
                "text-sm tabular-nums",
                cell.inMonth ? "text-foreground" : "text-muted-foreground/40",
                cell.isToday &&
                  "inline-flex size-6 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground",
              )}
            >
              {cell.day}
            </span>
          );

          if (cell.sessionCount === 0) {
            return (
              <div
                key={cell.dateKey}
                data-testid="mini-day"
                className="flex min-h-11 flex-col items-center rounded-md pt-0.5"
              >
                {dayNumber}
              </div>
            );
          }
          return (
            <button
              key={cell.dateKey}
              type="button"
              data-testid="mini-day"
              aria-label={`${formatThaiDayHeading(cell.dateKey)} · ${cell.sessionCount} ${PUBLIC_PAGE_COPY.classUnit}`}
              onClick={() => onSelectDay(cell.dateKey)}
              className="flex min-h-11 flex-col items-stretch gap-0.5 rounded-md pt-0.5 pb-1 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="self-center">{dayNumber}</span>
              {cell.chips.map((chip, index) => (
                <span
                  key={index}
                  className="w-full truncate rounded-[3px] px-1 py-px text-left text-[9px] leading-tight font-medium text-foreground"
                  style={{
                    backgroundColor: rgba(chip.color, 0.18),
                    borderLeft: `2px solid ${chip.color}`,
                  }}
                >
                  {chip.subject}
                </span>
              ))}
              {cell.overflow > 0 && (
                <span className="text-[9px] leading-none text-muted-foreground">
                  +{cell.overflow}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
