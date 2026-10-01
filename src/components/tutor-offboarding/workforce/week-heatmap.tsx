"use client";
import { useState } from "react";
import type { WorkforceWeekCell } from "@/lib/tutor-offboarding/workforce/types";
import { Panel } from "../atoms";
import {
  formatMetric,
  metricReason,
  heatDomain,
  heatTone,
  HEAT_CLASSES,
  METRIC_LABELS,
  monthLabel,
  type DisplayMetric,
} from "./presentation";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function minuteLabel(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function weekCellLabel(cell: WorkforceWeekCell, metric: DisplayMetric) {
  return `${DAYS[cell.weekday]} ${minuteLabel(cell.startMinute)}–${minuteLabel(cell.endMinute)}: ${formatMetric(cell[metric], "h")} average week; ${formatMetric(cell.monthlyTotals[metric], "h")} monthly total; ${cell.coveredDates} supported dates of ${cell.calendarOccurrences} calendar occurrences. ${metricReason(cell[metric])}`;
}
export function WeekHeatmap({
  cells,
  month,
  onSelect,
}: {
  cells: WorkforceWeekCell[];
  month: string;
  onSelect: (cell: WorkforceWeekCell) => void;
}) {
  const [metric, setMetric] = useState<DisplayMetric>("freeHours");
  const selected = cells.filter((cell) => cell.month === month);
  const domain = heatDomain(cells, metric);
  const times = [...new Set(selected.map((cell) => cell.startMinute))].sort(
    (a, b) => a - b,
  );
  return (
    <Panel aria-label="Average week heat map">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="font-semibold">Average week · {monthLabel(month)}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            30-minute buckets · hours per supported weekday occurrence · Bangkok
            time. Each cell includes its monthly total and supported dates.
          </p>
        </div>
        <label className="text-xs">
          Week measure
          <select
            className="mt-1 block max-w-full rounded-md border bg-background p-2"
            value={metric}
            onChange={(e) => setMetric(e.target.value as DisplayMetric)}
          >
            {(
              [
                "freeHours",
                "usableHours",
                "bookedHours",
                "creditConsumedHours",
                "recordedTeachingHours",
              ] as DisplayMetric[]
            ).map((key) => (
              <option key={key} value={key}>
                {METRIC_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="px-5 py-3 text-xs text-muted-foreground">
        Comparable scale across report months: 0–{domain.toFixed(2)} h · Missing
        support stays unavailable.
      </p>
      <div className="max-h-[480px] overflow-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">
            Average week hours by weekday and half-hour interval
          </caption>
          <thead className="sticky top-0 bg-card">
            <tr>
              <th scope="col" className="px-3 py-2 text-left">
                Bangkok
              </th>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <th scope="col" key={day} className="min-w-20 p-2">
                  {DAYS[day]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((time) => (
              <tr key={time}>
                <th
                  scope="row"
                  className="whitespace-nowrap px-3 py-2 text-left font-normal"
                >
                  {minuteLabel(time)}–{minuteLabel(time + 30)}
                </th>
                {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                  const cell = selected.find(
                    (cell) => cell.weekday === day && cell.startMinute === time,
                  );
                  const tone = cell
                    ? heatTone(cell[metric], domain)
                    : "unknown";
                  return (
                    <td key={day} className="p-1">
                      {cell ? (
                        <button
                          onClick={() => onSelect(cell)}
                          title={weekCellLabel(cell, metric)}
                          aria-label={weekCellLabel(cell, metric)}
                          className={`w-full rounded p-2 focus-visible:outline-2 focus-visible:outline-primary ${tone === "unknown" ? "bg-muted/40 text-muted-foreground" : HEAT_CLASSES[tone]}`}
                        >
                          {formatMetric(cell[metric], "h")}
                        </button>
                      ) : (
                        <span
                          className="block rounded bg-muted/20 p-2 text-center text-muted-foreground"
                          aria-label={`${DAYS[day]} ${minuteLabel(time)} unavailable`}
                        >
                          —
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {times.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">
          Average-week evidence is unavailable for this month.
        </p>
      ) : null}
    </Panel>
  );
}
