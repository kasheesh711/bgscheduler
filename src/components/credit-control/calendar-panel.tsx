import React, { useState } from "react";

import type { CalendarDay } from "@/types/credit-control";
import type { CalendarView } from "@/lib/credit-control/ui-helpers";
import { HighlightText } from "./queue-panel";
import {
  buildCalendarCells,
  capitalize,
  formatCurrentCalendarHeading,
  formatDateKey,
  formatLongDate,
  formatNumber,
  formatShortDate,
  formatShortWeekday,
  getActionableStripDays,
  getCalendarDayTone,
  getCalendarSeverityLabel,
  statusLabel,
  WEEKDAY_NAMES,
} from "@/lib/credit-control/ui-helpers";

export const CalendarPanel = React.memo(function CalendarPanel({
  calendarView,
  calendarCursor,
  selectedDay,
  filteredCalendarDayMap,
  adminScopedCalendarDays,
  selectedCalendarDate,
  onSetCalendarView,
  onShiftCalendar,
  onSelectCalendarDate,
  onJumpToToday,
  onJumpToNextUrgent,
  onJumpToNextScheduled,
  onJumpToAdjacentActionableDay,
  onOpenStudentByIndex,
  searchTerm,
}: {
  calendarView: CalendarView;
  calendarCursor: Date;
  selectedDay: CalendarDay | null;
  filteredCalendarDayMap: Record<string, CalendarDay>;
  adminScopedCalendarDays: CalendarDay[];
  selectedCalendarDate: string;
  onSetCalendarView: (view: CalendarView) => void;
  onShiftCalendar: (direction: number) => void;
  onSelectCalendarDate: (dateKey: string) => void;
  onJumpToToday: () => void;
  onJumpToNextUrgent: () => void;
  onJumpToNextScheduled: () => void;
  onJumpToAdjacentActionableDay: (direction: number) => void;
  onOpenStudentByIndex: (studentIndex: number) => void;
  searchTerm?: string;
}) {
  const [showGrid, setShowGrid] = useState(false);
  const actionableDays = getActionableStripDays(filteredCalendarDayMap, selectedCalendarDate);
  const urgentDays = actionableDays.filter((d) => d.urgentStudents > 0);
  const scheduledDays = actionableDays.filter((d) => d.urgentStudents === 0);

  return (
    <section className="panel calendar-panel">
      {/* Compact planner header */}
      <div className="panel-header" style={{ padding: "4px 0", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: "0.95rem" }}>Triage Planner</h2>
          <span className="mini-pill" style={{ padding: "2px 8px", fontSize: "0.72rem" }}>
            {adminScopedCalendarDays.filter((day) => day.students.length > 0).length} days
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button className="ghost-button" onClick={onJumpToToday} type="button" style={{ padding: "3px 8px", fontSize: "0.72rem" }}>
            Today
          </button>
          <button className="ghost-button" onClick={onJumpToNextUrgent} type="button" style={{ padding: "3px 8px", fontSize: "0.72rem" }}>
            Next urgent
          </button>
          <button className="ghost-button" onClick={onJumpToNextScheduled} type="button" style={{ padding: "3px 8px", fontSize: "0.72rem" }}>
            Next scheduled
          </button>
          <button
            className="ghost-button"
            onClick={() => setShowGrid((prev) => !prev)}
            type="button"
            style={{ padding: "3px 8px", fontSize: "0.72rem" }}
          >
            {showGrid ? "Hide grid" : "Show grid"}
          </button>
        </div>
      </div>

      {/* Actionable days strip: urgent + scheduled */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
        {urgentDays.length > 0 && (
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--notify)", marginBottom: 3 }}>
              Next urgent days
            </div>
            <div className="calendar-action-list" style={{ gap: 4 }}>
              {urgentDays.map((day) => (
                <button
                  className={
                    day.date === selectedDay?.date
                      ? `calendar-action-pill ${getCalendarDayTone(day)} is-selected`
                      : `calendar-action-pill ${getCalendarDayTone(day)}`
                  }
                  key={day.date}
                  onClick={() => onSelectCalendarDate(day.date)}
                  type="button"
                  style={{ minWidth: 110, padding: "8px 10px" }}
                >
                  <div className="calendar-action-pill-label">{formatShortWeekday(day.date)}</div>
                  <div className="calendar-action-pill-date">{formatShortDate(day.date)}</div>
                  <div className="calendar-action-pill-meta" style={{ fontSize: "0.72rem" }}>
                    {day.totalStudents} · {day.urgentStudents} urgent
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {scheduledDays.length > 0 && (
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--ok)", marginBottom: 3 }}>
              Next scheduled days
            </div>
            <div className="calendar-action-list" style={{ gap: 4 }}>
              {scheduledDays.map((day) => (
                <button
                  className={
                    day.date === selectedDay?.date
                      ? `calendar-action-pill ${getCalendarDayTone(day)} is-selected`
                      : `calendar-action-pill ${getCalendarDayTone(day)}`
                  }
                  key={day.date}
                  onClick={() => onSelectCalendarDate(day.date)}
                  type="button"
                  style={{ minWidth: 110, padding: "8px 10px" }}
                >
                  <div className="calendar-action-pill-label">{formatShortWeekday(day.date)}</div>
                  <div className="calendar-action-pill-date">{formatShortDate(day.date)}</div>
                  <div className="calendar-action-pill-meta" style={{ fontSize: "0.72rem" }}>
                    {day.totalStudents} students
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {!urgentDays.length && !scheduledDays.length && (
          <div className="empty-inline" style={{ fontSize: "0.82rem" }}>No scheduled days visible.</div>
        )}
      </div>

      {/* Collapsible month/week grid */}
      {showGrid && calendarView !== "day" && (
        <div style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <div className="segmented-control" style={{ transform: "scale(0.85)", transformOrigin: "left" }}>
              {(["month", "week", "day"] as CalendarView[]).map((view) => (
                <button
                  className={calendarView === view ? "is-active" : ""}
                  key={view}
                  onClick={() => onSetCalendarView(view)}
                  type="button"
                  style={{ padding: "4px 8px", fontSize: "0.72rem" }}
                >
                  {capitalize(view)}
                </button>
              ))}
            </div>
            <div className="calendar-period-nav" style={{ gap: 4 }}>
              <button className="icon-button" onClick={() => onShiftCalendar(-1)} type="button" style={{ padding: "2px 6px" }}>
                ‹
              </button>
              <div style={{ fontSize: "0.82rem", fontWeight: 700 }}>
                {formatCurrentCalendarHeading(calendarView, calendarCursor, selectedCalendarDate)}
              </div>
              <button className="icon-button" onClick={() => onShiftCalendar(1)} type="button" style={{ padding: "2px 6px" }}>
                ›
              </button>
            </div>
          </div>
          <div className="calendar-weekdays" style={{ fontSize: "0.7rem", gap: 4 }}>
            {WEEKDAY_NAMES.map((name) => (
              <div className="calendar-weekday" key={name}>{name}</div>
            ))}
          </div>
          <div className={`calendar-grid ${calendarView}`} style={{ gap: 4 }}>
            {buildCalendarCells(calendarView, calendarCursor).map((cellDate) =>
              renderCalendarCell(
                cellDate,
                calendarView === "month" && cellDate.getMonth() !== calendarCursor.getMonth(),
                filteredCalendarDayMap,
                selectedDay?.date ?? "",
                onSelectCalendarDate,
              ),
            )}
          </div>
        </div>
      )}

      {/* Selected day detail — scrollable */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {selectedDay && (
          <div style={{ flexShrink: 0, padding: "4px 0", borderBottom: "1px solid var(--panel-border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>{formatLongDate(selectedDay.date)}</span>
              <span className="mini-pill" style={{ padding: "2px 6px", fontSize: "0.7rem" }}>{selectedDay.totalStudents} total</span>
              {selectedDay.urgentStudents > 0 && (
                <span className="mini-pill" style={{ padding: "2px 6px", fontSize: "0.7rem", background: "rgba(196,73,45,0.12)", color: "var(--notify)" }}>{selectedDay.urgentStudents} urgent</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button className="ghost-button" onClick={() => onJumpToAdjacentActionableDay(-1)} type="button" style={{ padding: "2px 6px", fontSize: "0.72rem" }}>‹ Prev</button>
              <button className="ghost-button" onClick={() => onJumpToAdjacentActionableDay(1)} type="button" style={{ padding: "2px 6px", fontSize: "0.72rem" }}>Next ›</button>
            </div>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {selectedDay ? (
            selectedDay.students.length ? (
              <div className="day-student-list" style={{ gap: 6, padding: "4px 0" }}>
                {selectedDay.students.map((student) => (
                  <article className="day-student-card" key={student.key} style={{ padding: 10, gap: 6 }}>
                    <div className="day-student-top">
                      <div>
                        <div className="table-primary" style={{ fontSize: "0.88rem" }}>
                          <HighlightText text={student.student} term={searchTerm} />
                        </div>
                        <div className="table-subtle" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                          <HighlightText text={student.parent} term={searchTerm} />
                        </div>
                      </div>
                      <div className="mini-pills" style={{ gap: 4 }}>
                        <span className={`status-pill tone-${student.worstStatus}`} style={{ padding: "2px 8px", fontSize: "0.72rem" }}>{statusLabel(student.worstStatus)}</span>
                      </div>
                    </div>
                    <div className="table-subtle" style={{ fontSize: "0.78rem" }}>{student.whyNow}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <div className="mini-pills" style={{ gap: 4 }}>
                        <span className="mini-pill" style={{ padding: "2px 6px", fontSize: "0.7rem" }}>{formatNumber(student.totalAdjustedRemaining)} cr</span>
                      </div>
                      <button className="ghost-button" onClick={() => onOpenStudentByIndex(student.studentIndex)} type="button" style={{ padding: "2px 8px", fontSize: "0.72rem" }}>
                        Open
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-inline" style={{ fontSize: "0.82rem" }}>No students match filters for this day.</div>
            )
          ) : (
            <div className="empty-inline" style={{ fontSize: "0.82rem", paddingTop: 20 }}>Select a day to see scheduled students.</div>
          )}
        </div>
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Internal render helpers
// ---------------------------------------------------------------------------

function renderCalendarCell(
  dateObj: Date,
  muted: boolean,
  filteredCalendarDayMap: Record<string, CalendarDay>,
  selectedDate: string,
  selectCalendarDate: (dateKey: string) => void,
) {
  const dateKey = formatDateKey(dateObj);
  const day = filteredCalendarDayMap[dateKey] || null;
  const tone = getCalendarDayTone(day);

  return (
    <button
      className={[
        "calendar-cell",
        muted ? "muted" : "",
        selectedDate === dateKey ? "selected" : "",
        tone === "urgent" ? "has-urgent" : "",
        tone === "watch" ? "has-watch" : "",
        tone === "scheduled" ? "has-scheduled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      key={dateKey}
      onClick={() => selectCalendarDate(dateKey)}
      type="button"
    >
      <div className="calendar-day-top">
        <div className="calendar-day-number">{dateObj.getDate()}</div>
        <span className="calendar-count-badge">
          {day ? day.totalStudents : 0} student{day && day.totalStudents === 1 ? "" : "s"}
        </span>
      </div>
      <div className="calendar-summary">
        <span className={`calendar-severity-pill ${tone}`}>{getCalendarSeverityLabel(day)}</span>
      </div>
    </button>
  );
}
