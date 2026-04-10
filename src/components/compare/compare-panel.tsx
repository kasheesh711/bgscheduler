"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { TutorListItem } from "@/lib/data/tutors";
import { TutorCombobox } from "@/components/compare/tutor-combobox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WeekCalendar } from "@/components/compare/week-calendar";
import dynamic from "next/dynamic";
import { CalendarSkeleton } from "@/components/skeletons/calendar-skeleton";
import { DAY_NAMES } from "@/components/search/search-form";

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
import {
  shiftWeek,
  formatWeekLabel,
  getWeekDate,
  formatMinute,
} from "@/hooks/use-compare";
import type { UseCompareReturn } from "@/hooks/use-compare";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComparePanelProps {
  compare: UseCompareReturn;
  tutorList: TutorListItem[];
}

// ---------------------------------------------------------------------------
// ComparePanel component
// ---------------------------------------------------------------------------

export function ComparePanel({ compare, tutorList }: ComparePanelProps) {
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
              className="text-muted-foreground hover:text-foreground text-[10px] ml-0.5"
            >
              x
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
                onClick={() => changeWeek(shiftWeek(weekStart, -1))}
                className="px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
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
                      changeWeek(monday);
                      setCalendarOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <button
                onClick={() => changeWeek(shiftWeek(weekStart, 1))}
                className="px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              >
                &gt;
              </button>
              {weekStart !== getCurrentMonday() && (
                <button
                  onClick={() => changeWeek(getCurrentMonday())}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground ml-1"
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
              onClick={() => setActiveDay(null)}
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
                onClick={() => setActiveDay(day)}
              >
                {DAY_NAMES[day]} {getWeekDate(weekStart, day)}
                {activeDay === day && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Calendar view */}
          <div className={`flex-1 min-h-0 mt-1 ${activeDay !== null ? "overflow-y-auto" : ""}`}>
            {activeDay !== null ? (
              <CalendarGrid
                tutors={compareResponse.tutors}
                tutorChips={compareTutors}
                conflicts={compareResponse.conflicts}
                sharedFreeSlots={compareResponse.sharedFreeSlots}
                dayOfWeek={activeDay}
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
                onDayClick={(day) => setActiveDay(day)}
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
