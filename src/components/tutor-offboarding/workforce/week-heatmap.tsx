"use client";
import { useState } from "react";
import type { WorkforceWeekCell } from "@/lib/tutor-offboarding/workforce/types";
import { scaleBand, scaleSequential, interpolateRgb } from "d3";
import { useId } from "react";
import { activate, ChartPanel, useChartWidth } from "./charts";
import {
  formatMetric,
  metricReason,
  heatDomain,
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
  const [metric, setMetric] = useState<DisplayMetric>("freeHours"),
    { ref, width } = useChartWidth();
  const pattern = useId().replaceAll(":", "");
  const selected = cells.filter((c) => c.month === month),
    times = [...new Set(selected.map((c) => c.startMinute))].sort(
      (a, b) => a - b,
    ),
    domain = heatDomain(cells, metric);
  const x = scaleBand<number>()
      .domain([1, 2, 3, 4, 5, 6, 0])
      .range([48, width - 6])
      .padding(0.06),
    y = scaleBand<number>()
      .domain(times)
      .range([30, 30 + times.length * 44])
      .padding(0.08),
    color = scaleSequential(interpolateRgb("#eaf5fb", "#087bb5")).domain([
      0,
      domain,
    ]);
  return (
    <ChartPanel
      title={`Average week · ${monthLabel(month)}`}
      subtitle="Hours per supported weekday · 30-minute buckets · Bangkok"
      action={
        <select
          aria-label="Week measure"
          value={metric}
          onChange={(e) => setMetric(e.target.value as DisplayMetric)}
          className="max-w-48 rounded border bg-background p-2 text-xs"
        >
          {(
            [
              "freeHours",
              "usableHours",
              "bookedHours",
              "creditConsumedHours",
              "recordedTeachingHours",
            ] as DisplayMetric[]
          ).map((k) => (
            <option key={k} value={k}>
              {METRIC_LABELS[k]}
            </option>
          ))}
        </select>
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">
        {METRIC_LABELS[metric]} · fixed 0–{domain.toFixed(2)} h · ▧ Unknown · ~
        Partial
      </p>
      <div ref={ref} className="max-h-[500px] overflow-auto">
        <svg
          width={width}
          height={Math.max(80, times.length * 44 + 40)}
          role="group"
          aria-label="Average week hours by weekday and half-hour interval"
          style={{ fontSize: 11 }}
        >
          <defs>
            <pattern
              id={pattern}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="#edf0f2" />
              <path d="M0 6L6 0" stroke="#cbd3db" strokeWidth=".8" />
            </pattern>
          </defs>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <text
              key={d}
              x={x(d)! + x.bandwidth() / 2}
              y="18"
              textAnchor="middle"
              fill="currentColor"
            >
              {DAYS[d]}
            </text>
          ))}
          {times.map((t) => (
            <g key={t}>
              <text
                x="42"
                y={y(t)! + y.bandwidth() / 2 + 4}
                textAnchor="end"
                fill="currentColor"
              >
                {minuteLabel(t)}
              </text>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const c = selected.find(
                    (v) => v.startMinute === t && v.weekday === d,
                  ),
                  v = c?.[metric],
                  unknown = v?.value == null;
                return (
                  <g
                    key={d}
                    role={c ? "button" : undefined}
                    tabIndex={c ? 0 : undefined}
                    aria-label={
                      c
                        ? weekCellLabel(c, metric)
                        : `${DAYS[d]} ${minuteLabel(t)} unavailable`
                    }
                    onClick={() => c && onSelect(c)}
                    onKeyDown={(e) => c && activate(e, () => onSelect(c))}
                    className="cursor-pointer focus:outline-2 focus:outline-primary"
                  >
                    <rect
                      x={x(d)}
                      y={y(t)}
                      width={x.bandwidth()}
                      height={y.bandwidth()}
                      rx="3"
                      fill={unknown ? `url(#${pattern})` : color(v!.value!)}
                      stroke={
                        v?.completeness === "partial" ? "#d97706" : "none"
                      }
                    />
                    <text
                      x={x(d)! + x.bandwidth() / 2}
                      y={y(t)! + y.bandwidth() / 2 + 4}
                      textAnchor="middle"
                      fill={
                        !unknown && v!.value! > domain * 0.6
                          ? "white"
                          : "#334155"
                      }
                    >
                      {unknown
                        ? "?"
                        : `${v?.completeness === "partial" ? "~" : ""}${formatMetric(v)}`}
                    </text>
                    {c && <title>{weekCellLabel(c, metric)}</title>}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      {!times.length && (
        <p className="text-sm text-muted-foreground">
          Average-week evidence is unavailable for this month.
        </p>
      )}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          View monthly totals & support
        </summary>
        <ul className="mt-3 space-y-2">
          {selected.map((c) => (
            <li key={c.key}>
              <button
                className="text-left text-primary"
                onClick={() => onSelect(c)}
              >
                {weekCellLabel(c, metric)}
              </button>
            </li>
          ))}
        </ul>
      </details>
    </ChartPanel>
  );
}
