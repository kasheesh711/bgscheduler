// ----------------------------------------------------------------------------
// Student monthly schedule — the calendar itself.
//
// Presentational only: it takes a fully-formed StudentSchedulePayload and
// renders it. No fetching, no clock, no "use client" — this is a plain
// component so the admin workspace, the print report and the PUBLIC parent
// page can all render exactly the same thing (what the admin previews is
// byte-for-byte what the parent receives).
//
// Layout follows the admissions calendar (Monday-start 6×7 grid, dimmed
// out-of-month cells, week-grouped list below lg). Two deliberate departures:
//   • No "+N more" truncation. A parent-facing document must never silently
//     hide a class, so day cells grow instead.
//   • Colour is keyed by SUBJECT rather than tutor, since a single student's
//     month is read subject-first.
// ----------------------------------------------------------------------------

import { cn } from "@/lib/utils";
import {
  CALENDAR_DAY_HEADERS,
  buildMonthGrid,
  dayOfMonth,
  formatDateOnly,
  getMondayKey,
} from "@/lib/calendar/month-grid";
import { rgba } from "@/components/compare/session-colors";
import { modalityDisplay } from "./modality-display";
import type {
  StudentSchedulePayload,
  StudentScheduleSession,
} from "@/lib/student-schedule/types";

/**
 * Subject palette. Extends the 3-colour tutor palette because a student's month
 * routinely spans more subjects than a compare view spans tutors.
 */
const SUBJECT_COLORS = [
  "#3b82f6", // sky
  "#e67e22", // amber
  "#7c3aed", // violet
  "#0d9488", // teal
  "#db2777", // pink
  "#65a30d", // lime
];

/**
 * Assigns a colour per subject by order of first appearance, so no two subjects
 * in one document can collide until there are more subjects than colours. A
 * content hash was tried first and produced two indistinguishable blues in a
 * real month (Mathematics and English) — unacceptable on a page a parent reads.
 *
 * Determinism holds where it matters: the admin preview, the printed PDF and
 * the parent's page all render the same payload, so all three agree.
 */
export function buildSubjectColorMap(
  sessions: readonly StudentScheduleSession[],
): Map<string, string> {
  const colors = new Map<string, string>();
  for (const session of sessions) {
    if (colors.has(session.subject)) continue;
    colors.set(session.subject, SUBJECT_COLORS[colors.size % SUBJECT_COLORS.length]);
  }
  return colors;
}

function timeRange(session: StudentScheduleSession): string {
  return session.endLabel
    ? `${session.startLabel}–${session.endLabel}`
    : session.startLabel;
}

function groupByDate(
  sessions: readonly StudentScheduleSession[],
): Map<string, StudentScheduleSession[]> {
  const byDate = new Map<string, StudentScheduleSession[]>();
  for (const session of sessions) {
    const bucket = byDate.get(session.dateKey);
    if (bucket) bucket.push(session);
    else byDate.set(session.dateKey, [session]);
  }
  return byDate;
}

function SessionBlock({
  session,
  color,
  compact,
}: {
  session: StudentScheduleSession;
  color: string;
  compact?: boolean;
}) {
  const modality = modalityDisplay(session.modality);
  return (
    <div
      data-testid="schedule-session"
      className={cn(
        "schedule-session rounded-sm px-1.5 py-1 text-left",
        compact ? "text-[10px] leading-tight" : "text-xs leading-snug",
      )}
      style={{
        backgroundColor: rgba(color, 0.18),
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div className="flex items-center gap-1 font-semibold tabular-nums" style={{ color }}>
        {modality && (
          // Icon only — a cell this narrow has no room for the word, and the
          // glyph prints as inline SVG on the A4 report.
          <modality.Icon aria-label={modality.label} className="size-2.5 shrink-0" />
        )}
        {timeRange(session)}
      </div>
      <div className="truncate font-medium text-foreground">{session.subject}</div>
      <div className="truncate text-muted-foreground">{session.teacherName}</div>
    </div>
  );
}

export function ScheduleMonthCalendar({
  payload,
  todayKey,
  className,
}: {
  payload: StudentSchedulePayload;
  /** Bangkok "YYYY-MM-DD" used only for the today ring; omit to draw none. */
  todayKey?: string;
  className?: string;
}) {
  const cells = buildMonthGrid(payload.monthKey);
  const byDate = groupByDate(payload.sessions);
  const subjectColors = buildSubjectColorMap(payload.sessions);
  const colorFor = (subject: string) => subjectColors.get(subject) ?? SUBJECT_COLORS[0];

  if (payload.sessions.length === 0) {
    return (
      <div
        data-testid="schedule-empty"
        className={cn(
          "rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        No classes scheduled in {payload.monthLabel}.
      </div>
    );
  }

  // Week buckets for the mobile list fallback.
  const weeks = new Map<string, StudentScheduleSession[]>();
  for (const session of payload.sessions) {
    const weekStart = getMondayKey(session.dateKey);
    const bucket = weeks.get(weekStart);
    if (bucket) bucket.push(session);
    else weeks.set(weekStart, [session]);
  }

  return (
    <div className={className}>
      {/* ── Month grid (desktop + all print) ───────────────────────── */}
      <div className="schedule-month-grid hidden lg:block">
        <div className="grid grid-cols-7 gap-px text-center text-xs font-semibold text-muted-foreground">
          {CALENDAR_DAY_HEADERS.map((header) => (
            <div key={header} className="py-2">{header}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px rounded-md bg-border/60 ring-1 ring-border">
          {cells.map((cell) => {
            const sessions = cell.inMonth ? byDate.get(cell.dateKey) ?? [] : [];
            return (
              <div
                key={cell.dateKey}
                data-testid="schedule-day-cell"
                className={cn(
                  "schedule-day-cell min-h-24 space-y-1 bg-background p-1.5 align-top",
                  !cell.inMonth && "bg-muted/40",
                )}
              >
                {/* Wrapper owns the alignment: an inline-flex today badge and a
                    plain number cannot both be positioned by `text-right`. */}
                <div className="flex justify-end">
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      cell.inMonth ? "text-foreground" : "text-muted-foreground/50",
                      todayKey === cell.dateKey &&
                        "inline-flex size-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground",
                    )}
                  >
                    {dayOfMonth(cell.dateKey)}
                  </span>
                </div>
                {sessions.map((session) => (
                  <SessionBlock
                    key={session.wiseSessionId}
                    session={session}
                    color={colorFor(session.subject)}
                    compact
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Week-grouped list (mobile; hidden in print) ─────────────── */}
      <div className="schedule-mobile-list space-y-5 lg:hidden">
        {[...weeks.entries()].map(([weekStart, weekSessions]) => (
          <section key={weekStart} className="schedule-week-row space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Week of {formatDateOnly(weekStart)}
            </h3>
            {[...groupByDate(weekSessions).entries()].map(([dateKey, daySessions]) => (
              <div key={dateKey} className="space-y-1">
                <div className="text-sm font-semibold tabular-nums">
                  {formatDateOnly(dateKey)}
                </div>
                <div className="space-y-1">
                  {daySessions.map((session) => (
                    <SessionBlock
                      key={session.wiseSessionId}
                      session={session}
                      color={colorFor(session.subject)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
