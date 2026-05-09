"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Badge } from "@/components/ui/badge";
import type { TutorListItem } from "@/lib/data/tutors";
import { TutorCombobox } from "@/components/compare/tutor-combobox";
import { DensityOverview } from "@/components/compare/density-overview";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WeekCalendar } from "@/components/compare/week-calendar";
import dynamic from "next/dynamic";
import { CalendarSkeleton } from "@/components/skeletons/calendar-skeleton";
import { X, Maximize2, Minimize2 } from "lucide-react";
import { DAY_NAMES } from "@/components/search/search-form";
import {
  shiftWeek,
  formatWeekLabel,
  getWeekDate,
  formatMinute,
} from "@/hooks/use-compare";
import type { UseCompareReturn } from "@/hooks/use-compare";
import {
  getWeekTransitionKind,
  isRapidWeekNavigation,
  runCalendarViewTransition,
} from "@/lib/ui/view-transitions";

const WeekOverview = dynamic(
  () => import("@/components/compare/week-overview").then((mod) => mod.WeekOverview),
  { loading: () => <CalendarSkeleton /> }
);

const CalendarGrid = dynamic(
  () => import("@/components/compare/calendar-grid").then((mod) => mod.CalendarGrid),
  { loading: () => <CalendarSkeleton /> }
);

const DiscoveryPanel = dynamic(
  () => import("@/components/compare/discovery-panel").then((mod) => mod.DiscoveryPanel),
  { loading: () => null }
);

const CALENDAR_START_HOUR = 7;
const WEEK_PIXELS_PER_HOUR = 48;
const DAY_PIXELS_PER_HOUR = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComparePanelProps {
  compare: UseCompareReturn;
  tutorList: TutorListItem[];
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}

// ---------------------------------------------------------------------------
// ComparePanel component
// ---------------------------------------------------------------------------

export function ComparePanel({
  compare,
  tutorList,
  isFullscreen,
  onToggleFullscreen,
}: ComparePanelProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const {
    compareTutors,
    compareResponse,
    compareLoading,
    compareError,
    activeDay,
    discoveryOpen,
    prefillConflict,
    weekStart,
    addTutor,
    removeTutor,
    changeWeek,
    setActiveDay,
    setDiscoveryOpen,
    setPrefillConflict,
    getCurrentMonday,
  } = compare;

  const weekScrollRef = useRef<HTMLDivElement | null>(null);
  const dayScrollRef = useRef<HTMLDivElement | null>(null);
  const calendarChunksReady = useRef(false);
  const lastWeekNavigationStartedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!compareResponse) {
      calendarChunksReady.current = false;
      return;
    }

    let cancelled = false;
    calendarChunksReady.current = false;
    void Promise.all([
      import("@/components/compare/week-overview"),
      import("@/components/compare/calendar-grid"),
    ]).then(() => {
      if (!cancelled) {
        calendarChunksReady.current = true;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [compareResponse]);

  const getScrollElementForDay = useCallback((day: number | null) => {
    return day === null ? weekScrollRef.current : dayScrollRef.current;
  }, []);

  const getPixelsPerHourForDay = useCallback((day: number | null) => {
    return day === null ? WEEK_PIXELS_PER_HOUR : DAY_PIXELS_PER_HOUR;
  }, []);

  const captureCalendarMinuteOfDay = useCallback(
    (day: number | null = activeDay) => {
      const el = getScrollElementForDay(day);
      const sourcePixelsPerHour = getPixelsPerHourForDay(day);
      const minuteOfDay = CALENDAR_START_HOUR * 60 + ((el?.scrollTop ?? 0) / sourcePixelsPerHour) * 60;

      return minuteOfDay;
    },
    [activeDay, getPixelsPerHourForDay, getScrollElementForDay],
  );

  const restoreCalendarMinuteOfDay = useCallback(
    (day: number | null, minuteOfDay: number) => {
      const restore = () => {
        const el = getScrollElementForDay(day);
        if (!el) return;

        const targetPixelsPerHour = getPixelsPerHourForDay(day);
        const scrollTop = ((minuteOfDay - CALENDAR_START_HOUR * 60) / 60) * targetPixelsPerHour;
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
      };

      restore();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(restore);
      }
    },
    [getPixelsPerHourForDay, getScrollElementForDay],
  );

  const restoreSameViewScrollTop = useCallback(
    (day: number | null, scrollTop: number) => {
      const restore = () => {
        const el = getScrollElementForDay(day);
        if (!el) return;

        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
      };

      restore();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(restore);
      }
    },
    [getScrollElementForDay],
  );

  const handleWeekChange = useCallback(
    (targetWeek: string) => {
      const kind = getWeekTransitionKind(weekStart, targetWeek);
      if (kind === null) {
        return;
      }

      const now = performance.now();
      const rapid = isRapidWeekNavigation(lastWeekNavigationStartedAt.current, now);
      lastWeekNavigationStartedAt.current = now;
      const sameViewScrollTop = getScrollElementForDay(activeDay)?.scrollTop ?? 0;

      void changeWeek(targetWeek, {
        kind,
        skipTransition: rapid,
        capturedScrollTop: sameViewScrollTop,
        restoreScrollTop: (top) => restoreSameViewScrollTop(activeDay, top),
      });
    },
    [
      activeDay,
      changeWeek,
      getScrollElementForDay,
      restoreSameViewScrollTop,
      weekStart,
    ],
  );

  const handleDayChange = useCallback(
    (targetDay: number | null) => {
      const minuteOfDay = captureCalendarMinuteOfDay(activeDay);

      // 5pm conversion guardrail: WeekOverview raw 480px -> 1020 minutes ->
      // CalendarGrid raw 600px; inverse Day-to-Week maps 600px back to 480px.
      void runCalendarViewTransition(() => {
        flushSync(() => setActiveDay(targetDay));
        restoreCalendarMinuteOfDay(targetDay, minuteOfDay);
      }, { kind: "day", skip: !calendarChunksReady.current });
    },
    [activeDay, captureCalendarMinuteOfDay, restoreCalendarMinuteOfDay, setActiveDay],
  );

  const conflictCountByDay = useMemo(() => {
    const map = new Map<number, number>();
    if (!compareResponse) return map;
    for (const c of compareResponse.conflicts) {
      map.set(c.dayOfWeek, (map.get(c.dayOfWeek) ?? 0) + 1);
    }
    return map;
  }, [compareResponse]);

  const handleDensityDayClick = useCallback(
    (day: number) => {
      handleDayChange(day);
    },
    [handleDayChange],
  );

  return (
    <>
      {/* Tutor selector */}
      <div className="flex items-center gap-2 flex-wrap mb-2 flex-shrink-0">
        {compareTutors.map((t) => (
          <div
            key={t.tutorGroupId}
            className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
            style={{ borderColor: t.color }}
          >
            <div className="h-2 w-2 rounded-full" style={{ background: t.color }} />
            <span className="font-medium">{t.displayName}</span>
            <button
              onClick={() => removeTutor(t.tutorGroupId)}
              className="text-muted-foreground hover:text-foreground ml-0.5"
              aria-label={`Remove ${t.displayName}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {compareTutors.length < 3 && (
          <TutorCombobox
            existingTutorGroupIds={compareTutors.map((t) => t.tutorGroupId)}
            onAdd={addTutor}
            tutors={tutorList}
          />
        )}
        <button
          onClick={() => setDiscoveryOpen(true)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          Advanced search
        </button>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {compareTutors.length}/3
        </span>
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? (
            <Minimize2 className="h-3.5 w-3.5" />
          ) : (
            <Maximize2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {compareError && (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive mb-2 flex-shrink-0">
          {compareError}
        </div>
      )}

      {compareLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Loading schedules...
        </div>
      )}

      {compareResponse && !compareLoading && (
        <>
          {/* Week picker + snapshot meta */}
          <div className="flex items-center gap-2 mb-1 flex-shrink-0">
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleWeekChange(shiftWeek(weekStart, -1))}
                className="px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Previous week"
              >
                &lt;
              </button>
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger
                  render={(props) => (
                    <button
                      {...props}
                      className="text-xs font-medium min-w-[140px] text-center hover:bg-muted rounded px-1.5 py-0.5 transition-colors cursor-pointer"
                    >
                      {formatWeekLabel(weekStart)}
                    </button>
                  )}
                />
                <PopoverContent align="start" className="w-auto p-2">
                  <WeekCalendar
                    weekStart={weekStart}
                    onWeekSelect={(monday) => {
                      handleWeekChange(monday);
                      setCalendarOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <button
                onClick={() => handleWeekChange(shiftWeek(weekStart, 1))}
                className="px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Next week"
              >
                &gt;
              </button>
              {weekStart !== getCurrentMonday() && (
                <button
                  onClick={() => handleWeekChange(getCurrentMonday())}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground ml-1"
                  aria-label="Go to current week"
                >
                  Today
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground ml-auto">
              <span>{compareResponse.snapshotMeta.snapshotId.slice(0, 8)}</span>
              <span>·</span>
              <span>{compareResponse.latencyMs}ms</span>
              {compareResponse.snapshotMeta.stale && (
                <Badge variant="destructive" className="text-[10px]">Stale</Badge>
              )}
            </div>
          </div>

          {/* Day tabs */}
          <div className="flex border-b border-border flex-shrink-0">
            <button
              className={`px-3 py-1.5 text-xs font-medium transition-colors relative ${
                activeDay === null
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => handleDayChange(null)}
            >
              Week
              {activeDay === null && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
            {[1, 2, 3, 4, 5, 6, 0].map((day) => (
              <button
                key={day}
                className={`px-3 py-1.5 text-xs font-medium transition-colors relative ${
                  activeDay === day
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => handleDayChange(day)}
              >
                {DAY_NAMES[day]} {getWeekDate(weekStart, day)}
                {(conflictCountByDay.get(day) ?? 0) > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center h-4 min-w-[16px] rounded-full bg-conflict text-white text-[10px] font-semibold px-1">
                    {conflictCountByDay.get(day)}
                  </span>
                )}
                {activeDay === day && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>

          <DensityOverview
            tutors={compareResponse.tutors}
            tutorChips={compareTutors}
            activeDay={activeDay}
            onDayClick={handleDensityDayClick}
          />

          {/* Calendar view */}
          <div
            ref={activeDay !== null ? dayScrollRef : undefined}
            className={`compare-calendar-transition-surface flex-1 min-h-0 mt-1 ${activeDay !== null ? "overflow-y-auto" : ""}`}
          >
            {activeDay !== null ? (
              <CalendarGrid
                tutors={compareResponse.tutors}
                tutorChips={compareTutors}
                conflicts={compareResponse.conflicts}
                sharedFreeSlots={compareResponse.sharedFreeSlots}
                dayOfWeek={activeDay}
                weekStart={weekStart}
                onFindAlternatives={(conflict) => {
                  setPrefillConflict(conflict);
                  setDiscoveryOpen(true);
                }}
              />
            ) : (
              <WeekOverview
                tutors={compareResponse.tutors}
                tutorChips={compareTutors}
                conflicts={compareResponse.conflicts}
                sharedFreeSlots={compareResponse.sharedFreeSlots}
                weekStart={weekStart}
                onDayClick={handleDayChange}
                scrollContainerRef={weekScrollRef}
              />
            )}
          </div>

          {/* Conflicts summary */}
          {compareResponse.conflicts.length > 0 && (
            <div className="rounded-md border border-conflict/30 bg-conflict/10 p-2 text-xs mt-2 flex-shrink-0">
              <span className="font-semibold text-conflict">
                {compareResponse.conflicts.length} conflict{compareResponse.conflicts.length > 1 ? "s" : ""}
              </span>
              <ul className="mt-0.5 space-y-0.5 text-conflict/80 text-[10px]">
                {compareResponse.conflicts.slice(0, 5).map((c, i) => (
                  <li key={i}>
                    {c.studentName} — {DAY_NAMES[c.dayOfWeek]}{" "}
                    {formatMinute(c.startMinute)}–{formatMinute(c.endMinute)} —{" "}
                    {c.tutorA.displayName} vs {c.tutorB.displayName}
                  </li>
                ))}
                {compareResponse.conflicts.length > 5 && (
                  <li>+{compareResponse.conflicts.length - 5} more</li>
                )}
              </ul>
            </div>
          )}
        </>
      )}

      {compareTutors.length === 0 && !compareLoading && (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <p className="text-sm font-medium">Compare tutors</p>
          <p className="text-xs mt-1">
            Use the dropdown above or select 2-3 tutors from search results.
          </p>
        </div>
      )}

      <DiscoveryPanel
        open={discoveryOpen}
        onClose={() => {
          setDiscoveryOpen(false);
          setPrefillConflict(null);
        }}
        existingTutorGroupIds={compareTutors.map((t) => t.tutorGroupId)}
        onAdd={addTutor}
        prefillConflict={prefillConflict}
      />
    </>
  );
}
