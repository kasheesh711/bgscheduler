"use client";

// ----------------------------------------------------------------------------
// Admissions deadline calendar (design §5.1, PRD CM-100..102) — month-grid
// view of a case's dated items, following the WeekCalendar interaction
// patterns (src/components/compare/week-calendar.tsx): Monday-start 6×7 grid,
// prev/next month arrows, Today button, dimmed out-of-month cells, today ring.
//
// Design §5.1 lists no Calendar tab — the shell renders this component inside
// the Overview tab behind a "Show calendar" toggle (a sub-view, not a tab).
// The initially shown month arrives server-fetched as props (buildCaseCalendar
// on the page); navigating to another month fetches that month's window from
// GET /api/admissions/cases/[caseId]/calendar and caches it per month key.
// Chips render only on in-month cells so the grid always matches the fetched
// "YYYY-MM-01".."YYYY-MM-<last>" window exactly (never a guessed margin).
//
// Mobile rule (design §5.2): the month grid is desktop-only (≥1024px); below
// lg a deadline list grouped by week renders instead. Overdue items use the
// --conflict token; `overdue` is stamped server-side and never recomputed here
// (fail-closed: the lib owns the Bangkok-date comparison).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  CALENDAR_DAY_HEADERS,
  addMonths,
  buildMonthGrid,
  formatMonthLabel,
  getMondayKey,
  getMonthKey,
  getMonthWindow,
  isMonthKey,
  type CalendarGridCell,
} from "@/lib/calendar/month-grid";
import type { CalendarItem } from "@/lib/admissions/calendar";

// ── Pure helpers (exported for tests) ───────────────────────────────────

// Grid math lives in @/lib/calendar/month-grid so Server Components and the
// print/public schedule routes can share it without importing this "use client"
// module. Re-exported below so existing importers and tests are unaffected.
export {
  CALENDAR_DAY_HEADERS,
  addMonths,
  buildMonthGrid,
  formatMonthLabel,
  getMondayKey,
  getMonthKey,
  getMonthWindow,
  type CalendarGridCell,
};

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Max deadline chips shown per day cell before the "+N more" overflow. */
export const MAX_VISIBLE_DAY_CHIPS = 2;

/** One week bucket of the mobile list fallback. */
export interface CalendarWeekGroup {
  /** Monday of the week, "YYYY-MM-DD". */
  weekStart: string;
  items: CalendarItem[];
}

/** Groups items by their "YYYY-MM-DD" date, preserving input order per day. */
export function groupItemsByDate(
  items: readonly CalendarItem[],
): Map<string, CalendarItem[]> {
  const byDate = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const bucket = byDate.get(item.date);
    if (bucket) bucket.push(item);
    else byDate.set(item.date, [item]);
  }
  return byDate;
}

/**
 * Groups items into Monday-keyed week buckets for the mobile list fallback
 * (design §5.2: deadline list grouped by week instead of a month grid).
 * Weeks sort ascending; input order is preserved within each week (the API
 * already sorts date-ascending).
 */
export function groupItemsByWeek(items: readonly CalendarItem[]): CalendarWeekGroup[] {
  const byWeek = new Map<string, CalendarItem[]>();
  for (const item of items) {
    if (!DATE_KEY_PATTERN.test(item.date)) continue;
    const weekStart = getMondayKey(item.date);
    const bucket = byWeek.get(weekStart);
    if (bucket) bucket.push(item);
    else byWeek.set(weekStart, [item]);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, weekItems]) => ({ weekStart, items: weekItems }));
}

/** "YYYY-MM-DD" → "D/M/YYYY" (repo-wide D/M convention); non-dates pass through. */
function formatDateOnly(value: string): string {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return fallback;
}

/**
 * Defensively reads the calendar items array off an API payload. Malformed
 * entries are skipped, never guessed (fail-closed against a bad wire shape).
 */
function readCalendarItems(payload: unknown): CalendarItem[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("items" in payload) ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    return [];
  }
  const items: CalendarItem[] = [];
  for (const entry of (payload as { items: unknown[] }).items) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.caseId !== "string" ||
      typeof record.title !== "string" ||
      typeof record.date !== "string" ||
      typeof record.overdue !== "boolean"
    ) {
      continue;
    }
    items.push(record as unknown as CalendarItem);
  }
  return items;
}

// ── Presentational atoms ────────────────────────────────────────────────

function DeadlineChip({ item }: { item: CalendarItem }) {
  return (
    <span
      data-testid="calendar-chip"
      title={item.title}
      className={cn(
        "block truncate rounded px-1 py-px text-[11px] leading-4",
        item.overdue
          ? "bg-conflict/15 font-medium text-conflict"
          : "bg-primary/10 text-primary",
      )}
    >
      {item.title}
    </span>
  );
}

// ── Calendar ────────────────────────────────────────────────────────────

/** Props for CalendarTab — the initial month's items are server-fetched. */
export interface CalendarTabProps {
  caseId: string;
  /** Month first shown, "YYYY-MM" (the page's current Bangkok month). */
  initialMonth: string;
  /** buildCaseCalendar output for initialMonth's full window. */
  initialItems: CalendarItem[];
}

/**
 * Per-case deadline calendar (CM-100/CM-102): desktop month grid with
 * deadline chips per day (overdue in --conflict red), prev/next/Today
 * navigation, and a week-grouped list fallback below lg. Months are cached
 * per "YYYY-MM" key; only uncached months hit the API.
 */
export function CalendarTab({ caseId, initialMonth, initialItems }: CalendarTabProps) {
  const todayKey = useMemo(() => todayBangkok(), []);
  const [viewMonth, setViewMonth] = useState(
    isMonthKey(initialMonth) ? initialMonth : getMonthKey(todayBangkok()),
  );
  const [itemsByMonth, setItemsByMonth] = useState<Record<string, CalendarItem[]>>(
    () => ({ [initialMonth]: initialItems }),
  );
  const [errorsByMonth, setErrorsByMonth] = useState<Record<string, string>>({});

  // Fetch the viewed month once per month key; the initial month is seeded
  // from props so first paint never waits on the network. Loading/error are
  // derived from the caches so the effect never sets state synchronously.
  useEffect(() => {
    if (itemsByMonth[viewMonth] !== undefined) return;
    const controller = new AbortController();
    let cancelled = false;
    const { from, to } = getMonthWindow(viewMonth);
    fetch(`/api/admissions/cases/${caseId}/calendar?from=${from}&to=${to}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(readErrorMessage(payload, "Failed to load the calendar."));
        }
        const items = readCalendarItems(payload);
        if (!cancelled) {
          setItemsByMonth((previous) => ({ ...previous, [viewMonth]: items }));
        }
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load the calendar.";
        setErrorsByMonth((previous) => ({ ...previous, [viewMonth]: message }));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [caseId, viewMonth, itemsByMonth]);

  const error = errorsByMonth[viewMonth] ?? null;
  const loading = itemsByMonth[viewMonth] === undefined && error === null;
  const monthItems = useMemo(() => itemsByMonth[viewMonth] ?? [], [itemsByMonth, viewMonth]);
  const itemsByDate = useMemo(() => groupItemsByDate(monthItems), [monthItems]);
  const weekGroups = useMemo(() => groupItemsByWeek(monthItems), [monthItems]);
  const cells = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);

  return (
    <Card data-testid="calendar-tab">
      <CardHeader>
        <CardTitle>Deadline calendar</CardTitle>
        <CardDescription>
          Dated checklist items for {formatMonthLabel(viewMonth)}
          {loading ? " · Loading…" : ""}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous month"
              onClick={() => setViewMonth((current) => addMonths(current, -1))}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span className="min-w-28 text-center text-sm font-medium text-foreground">
              {formatMonthLabel(viewMonth)}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next month"
              onClick={() => setViewMonth((current) => addMonths(current, 1))}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setViewMonth(getMonthKey(todayKey))}
            >
              Today
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {/* ── Month grid (desktop, ≥1024px — design §5.2 mobile rule) ── */}
        <div data-testid="calendar-grid" className="hidden select-none lg:block">
          <div className="grid grid-cols-7">
            {CALENDAR_DAY_HEADERS.map((day) => (
              <div
                key={day}
                className="py-1 text-center text-[11px] font-medium text-muted-foreground"
              >
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-border/60 ring-1 ring-border/60">
            {cells.map((cell) => {
              const dayItems = cell.inMonth ? itemsByDate.get(cell.dateKey) ?? [] : [];
              const visible = dayItems.slice(0, MAX_VISIBLE_DAY_CHIPS);
              const hiddenCount = dayItems.length - visible.length;
              const isToday = cell.dateKey === todayKey;
              return (
                <div
                  key={cell.dateKey}
                  data-testid={`calendar-cell-${cell.dateKey}`}
                  className={cn(
                    "min-h-16 space-y-0.5 p-1",
                    cell.inMonth ? "bg-card" : "bg-muted/40",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums",
                      cell.inMonth ? "text-foreground" : "text-muted-foreground/50",
                      isToday && "bg-primary font-semibold text-primary-foreground",
                    )}
                  >
                    {Number(cell.dateKey.slice(8))}
                  </span>
                  {visible.map((item) => (
                    <DeadlineChip key={item.id} item={item} />
                  ))}
                  {hiddenCount > 0 ? (
                    <span className="block px-1 text-[10px] text-muted-foreground">
                      +{hiddenCount} more
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Week-grouped list fallback (below lg — design §5.2) ── */}
        <div data-testid="calendar-list" className="lg:hidden">
          {weekGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deadlines in {formatMonthLabel(viewMonth)}.
            </p>
          ) : (
            <div className="space-y-3">
              {weekGroups.map((group) => (
                <section key={group.weekStart} aria-label={`Week of ${formatDateOnly(group.weekStart)}`}>
                  <h3 className="text-xs font-semibold text-muted-foreground">
                    Week of {formatDateOnly(group.weekStart)}
                  </h3>
                  <ul className="mt-1 space-y-1.5">
                    {group.items.map((item) => (
                      <li
                        key={item.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-sm"
                      >
                        <span className="min-w-0 truncate">{item.title}</span>
                        <span
                          className={cn(
                            "shrink-0 text-xs tabular-nums",
                            item.overdue
                              ? "font-medium text-conflict"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatDateOnly(item.date)}
                          {item.overdue ? " · Overdue" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        {monthItems.length === 0 && !loading ? (
          <p className="hidden text-sm text-muted-foreground lg:block">
            No deadlines in {formatMonthLabel(viewMonth)}.
          </p>
        ) : null}

        <p className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="bg-conflict/15 text-conflict">
            Overdue
          </Badge>
          Overdue items stay flagged until they are done.
        </p>
      </CardContent>
    </Card>
  );
}
