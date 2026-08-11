"use client";

// ----------------------------------------------------------------------------
// Parent dot grid — the phone-sized "calendar view" of the public page.
//
// A month grid with readable session text does not fit a 375px screen, so
// below lg the calendar view is a jump map instead: one dot per session in
// the subject's colour (same buildSubjectColorMap as the agenda and the
// admin grid, so all surfaces agree), and tapping a day hands the dateKey
// back to the shell, which returns to the agenda scrolled to that day.
// Navigation only — it never renders session text and never writes the
// stored view preference.
// ----------------------------------------------------------------------------

import { cn } from "@/lib/utils";
import { buildMonthGrid, dayOfMonth } from "@/lib/calendar/month-grid";
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

/** Dots drawn per day before collapsing the rest into a "+N". */
export const DOT_CAP = 4;

/** First palette entry, for the impossible miss on an empty-subject session. */
const FALLBACK_COLOR = "#3b82f6";

export interface DotGridDay {
  dateKey: string;
  inMonth: boolean;
  day: number;
  isToday: boolean;
  /** 0 for out-of-month and empty days. */
  sessionCount: number;
  /** One colour per session, capped at DOT_CAP. */
  dots: string[];
  /** Sessions beyond DOT_CAP. */
  overflow: number;
}

export interface DotGridModel {
  /** Exactly 42 cells, Monday-start — same grid maths as the month calendar. */
  days: DotGridDay[];
  /** Subject → colour in order of first appearance. */
  legend: Array<{ subject: string; color: string }>;
}

/**
 * Pure model behind the component, exported so behaviour is testable without
 * DOM events: dot colours, the DOT_CAP overflow, today detection, and the
 * out-of-month blanks.
 */
export function buildParentDotGridModel(
  payload: StudentSchedulePayload,
  todayKey?: string,
): DotGridModel {
  const subjectColors = buildSubjectColorMap(payload.sessions);
  const colorFor = (session: StudentScheduleSession) =>
    subjectColors.get(session.subject) ?? FALLBACK_COLOR;

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
      dots: sessions.slice(0, DOT_CAP).map(colorFor),
      overflow: Math.max(0, sessions.length - DOT_CAP),
    };
  });

  return {
    days,
    legend: [...subjectColors].map(([subject, color]) => ({ subject, color })),
  };
}

export function ParentScheduleDotGrid({
  payload,
  todayKey,
  onSelectDay,
}: {
  payload: StudentSchedulePayload;
  todayKey?: string;
  /** Called with the tapped day's dateKey; only session days are tappable. */
  onSelectDay: (dateKey: string) => void;
}) {
  const model = buildParentDotGridModel(payload, todayKey);

  return (
    <div data-testid="parent-dot-grid">
      <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
        {THAI_WEEKDAY_INITIALS.map((header) => (
          <div key={header} className="py-1.5">
            {header}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {model.days.map((cell) => {
          const dayNumber = (
            <span
              className={cn(
                "text-sm tabular-nums",
                cell.inMonth
                  ? "text-foreground"
                  : "text-muted-foreground/40",
                cell.isToday &&
                  "inline-flex size-6 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground",
              )}
            >
              {cell.day}
            </span>
          );
          const dotRow = (
            <span className="flex min-h-1.5 items-center gap-0.5">
              {cell.dots.map((color, index) => (
                <span
                  key={index}
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
              ))}
              {cell.overflow > 0 && (
                <span className="text-[10px] leading-none text-muted-foreground">
                  +{cell.overflow}
                </span>
              )}
            </span>
          );

          if (cell.sessionCount === 0) {
            return (
              <div
                key={cell.dateKey}
                data-testid="dot-day"
                className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-md"
              >
                {dayNumber}
                {dotRow}
              </div>
            );
          }
          return (
            <button
              key={cell.dateKey}
              type="button"
              data-testid="dot-day"
              aria-label={`${formatThaiDayHeading(cell.dateKey)} · ${cell.sessionCount} ${PUBLIC_PAGE_COPY.classUnit}`}
              onClick={() => onSelectDay(cell.dateKey)}
              className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-md outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {dayNumber}
              {dotRow}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
        {model.legend.map(({ subject, color }) => (
          <span
            key={subject}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            {subject}
          </span>
        ))}
      </div>
    </div>
  );
}
