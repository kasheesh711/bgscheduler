"use client";

import { useState, useEffect, useCallback } from "react";
import { getMondayForDate } from "@/hooks/use-compare";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

interface WeekCalendarProps {
  weekStart: string;
  onWeekSelect: (monday: string) => void;
}

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function WeekCalendar({ weekStart, onWeekSelect }: WeekCalendarProps) {
  const selectedMonday = parseDate(weekStart);
  const selectedSunday = new Date(selectedMonday.getFullYear(), selectedMonday.getMonth(), selectedMonday.getDate() + 6);

  const [viewMonth, setViewMonth] = useState(() => new Date(selectedMonday.getFullYear(), selectedMonday.getMonth(), 1));
  const [hoverWeek, setHoverWeek] = useState<string | null>(null);

  // Sync viewMonth when weekStart changes externally (arrows)
  useEffect(() => {
    setViewMonth(new Date(selectedMonday.getFullYear(), selectedMonday.getMonth(), 1));
  }, [weekStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevMonth = useCallback(() => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1)), []);
  const nextMonth = useCallback(() => setViewMonth((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1)), []);

  // Build 6x7 grid starting from Monday
  const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const startDay = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), firstOfMonth.getDate() - (startDay === 0 ? 6 : startDay - 1));

  const today = new Date();
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  }

  return (
    <div className="w-60 select-none">
      {/* Month header */}
      <div className="flex items-center justify-between mb-1.5">
        <button
          onClick={prevMonth}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Previous month"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 9L4.5 6L7.5 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <span className="text-xs font-medium">
          {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
        </span>
        <button
          onClick={nextMonth}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Next month"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-0.5">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="text-[10px] text-muted-foreground text-center py-0.5">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {cells.map((cell, i) => {
          const isCurrentMonth = cell.getMonth() === viewMonth.getMonth();
          const isToday = sameDay(cell, today);
          const isInSelectedWeek = cell >= selectedMonday && cell <= selectedSunday;
          const cellMonday = getMondayForDate(cell);
          const isInHoverWeek = hoverWeek !== null && !isInSelectedWeek && cellMonday === hoverWeek;
          const dayOfWeek = cell.getDay();
          const isMonday = dayOfWeek === 1;
          const isSunday = dayOfWeek === 0;

          return (
            <button
              key={i}
              onClick={() => onWeekSelect(cellMonday)}
              onMouseEnter={() => setHoverWeek(cellMonday)}
              onMouseLeave={() => setHoverWeek(null)}
              className={[
                "text-[11px] py-1 text-center transition-colors relative",
                isCurrentMonth ? "text-foreground" : "text-muted-foreground/40",
                isInSelectedWeek ? "bg-primary/10 font-medium" : "",
                isInSelectedWeek && isMonday ? "rounded-l-md" : "",
                isInSelectedWeek && isSunday ? "rounded-r-md" : "",
                isInHoverWeek ? "bg-muted/60" : "",
                isInHoverWeek && isMonday ? "rounded-l-md" : "",
                isInHoverWeek && isSunday ? "rounded-r-md" : "",
                isToday ? "ring-1 ring-primary/40 rounded-sm" : "",
                !isInSelectedWeek && !isInHoverWeek ? "hover:bg-muted/40" : "",
              ].filter(Boolean).join(" ")}
              aria-label={cell.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              aria-selected={isInSelectedWeek}
            >
              {cell.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
