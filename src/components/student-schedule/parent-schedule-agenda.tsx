// ----------------------------------------------------------------------------
// Student monthly schedule — the PARENT-facing agenda.
//
// Presentational only, same contract as ScheduleMonthCalendar: a fully-formed
// StudentSchedulePayload in, markup out. No fetching, no clock, no "use client".
//
// This is deliberately a separate component from ScheduleMonthCalendar rather
// than a third branch inside it:
//   • ScheduleMonthCalendar's .schedule-month-grid / .schedule-mobile-list
//     class names are force-toggled by the print CSS (student-schedule.css),
//     so its markup is load-bearing for the A4 report and must stay put.
//   • The agenda is phone-first for parents (Thai headings, 16px type,
//     scroll-to-today anchor); the grid is admin/print-first. Merging the two
//     audiences into one component would mean audience conditionals everywhere.
// All surfaces still agree on content: same payload, and the same subject
// colours via buildSubjectColorMap.
// ----------------------------------------------------------------------------

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { buildSubjectColorMap } from "./schedule-month-calendar";
import {
  PUBLIC_PAGE_COPY,
  formatThaiDayHeading,
} from "@/lib/line/schedule-bot-copy";
import type {
  StudentSchedulePayload,
  StudentScheduleSession,
} from "@/lib/student-schedule/types";

/** First palette entry, for the impossible miss on an empty-subject session. */
const FALLBACK_COLOR = "#3b82f6";

function timeRange(session: StudentScheduleSession): string {
  return session.endLabel
    ? `${session.startLabel}–${session.endLabel}`
    : session.startLabel;
}

/** Insertion order preserves the payload's chronological sort. */
function groupSessionsByDay(
  sessions: readonly StudentScheduleSession[],
): Map<string, StudentScheduleSession[]> {
  const byDay = new Map<string, StudentScheduleSession[]>();
  for (const session of sessions) {
    const bucket = byDay.get(session.dateKey);
    if (bucket) bucket.push(session);
    else byDay.set(session.dateKey, [session]);
  }
  return byDay;
}

function AgendaSessionCard({
  session,
  color,
}: {
  session: StudentScheduleSession;
  color: string;
}) {
  return (
    <Card
      size="sm"
      data-testid="agenda-session"
      className="flex-row items-stretch gap-0 py-0"
    >
      <span
        aria-hidden
        className="w-1.5 shrink-0 rounded-l-xl"
        style={{ backgroundColor: color }}
      />
      <div className="flex min-w-0 flex-1 items-start justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <div className="text-base font-semibold tabular-nums" style={{ color }}>
            {timeRange(session)}
          </div>
          <div className="mt-0.5 truncate text-base font-medium text-foreground">
            {session.subject}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {session.teacherName}
          </div>
        </div>
        {session.durationMinutes > 0 && (
          <span className="shrink-0 pt-0.5 text-xs whitespace-nowrap tabular-nums text-muted-foreground">
            {session.durationMinutes} {PUBLIC_PAGE_COPY.minutesUnit}
          </span>
        )}
      </div>
    </Card>
  );
}

/**
 * Day-by-day agenda of one month's sessions. Renders a section per day that
 * HAS sessions (dates imply the gaps; a row per empty day would triple the
 * scroll length for no signal), each headed by the Thai weekday + day number.
 *
 * With `todayKey` (Bangkok "YYYY-MM-DD"):
 *   • today's section is highlighted and badged "วันนี้",
 *   • past days are dimmed (visual only — never dropped),
 *   • the first section at or after today carries id="agenda-scroll-target"
 *     for the shell's scroll-to-today. A month entirely in the past gets no
 *     anchor.
 * Without it, none of those states render (the print-safe default).
 */
export function ParentScheduleAgenda({
  payload,
  todayKey,
}: {
  payload: StudentSchedulePayload;
  todayKey?: string;
}) {
  const days = groupSessionsByDay(payload.sessions);
  const subjectColors = buildSubjectColorMap(payload.sessions);
  const dayKeys = [...days.keys()];
  const scrollTargetKey = todayKey
    ? dayKeys.find((key) => key >= todayKey)
    : undefined;

  return (
    <div data-testid="parent-schedule-agenda" className="space-y-4">
      {dayKeys.map((dateKey) => {
        const isToday = dateKey === todayKey;
        const isPast = todayKey !== undefined && dateKey < todayKey;
        return (
          <section
            key={dateKey}
            data-testid="agenda-day"
            data-date={dateKey}
            data-today={isToday || undefined}
            data-past={isPast || undefined}
            id={dateKey === scrollTargetKey ? "agenda-scroll-target" : undefined}
            className={cn(
              "scroll-mt-[calc(8.5rem+env(safe-area-inset-top))]",
              isPast && "opacity-60",
            )}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <h2
                className={cn(
                  "text-sm font-semibold",
                  isToday ? "text-primary" : "text-foreground",
                )}
              >
                {formatThaiDayHeading(dateKey)}
              </h2>
              {isToday && <Badge>{PUBLIC_PAGE_COPY.today}</Badge>}
            </div>
            <div className="space-y-2">
              {days.get(dateKey)!.map((session) => (
                <AgendaSessionCard
                  key={session.wiseSessionId}
                  session={session}
                  color={subjectColors.get(session.subject) ?? FALLBACK_COLOR}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
