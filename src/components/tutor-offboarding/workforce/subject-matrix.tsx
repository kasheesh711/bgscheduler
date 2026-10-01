"use client";
import { useId, useState } from "react";
import { scaleBand, scaleSequential, interpolateRgb } from "d3";
import type { WorkforceSubjectRow } from "@/lib/tutor-offboarding/workforce/types";
import { activate, ChartPanel, useChartWidth } from "./charts";
import {
  formatMetric,
  metricReason,
  monthLabel,
  hierarchyKey,
  visibleSubjectRows,
  heatDomain,
  METRIC_LABELS,
  type DisplayMetric,
} from "./presentation";
export function SubjectMatrix({
  rows,
  months,
  onSelect,
}: {
  rows: WorkforceSubjectRow[];
  months: string[];
  onSelect: (row: WorkforceSubjectRow) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [metric, setMetric] = useState<DisplayMetric>("bookedHours");
  const { ref, width } = useChartWidth();
  const pattern = useId().replaceAll(":", "");
  const visible = visibleSubjectRows(rows, expanded),
    groups = [...new Map(visible.map((r) => [hierarchyKey(r), r])).entries()];
  const mobile = width < 480,
    left = mobile ? 106 : 175;
  const plotWidth = Math.max(width, left + months.length * 44 + 10),
    x = scaleBand()
      .domain(months)
      .range([left, plotWidth - 8])
      .padding(0.08),
    y = scaleBand()
      .domain(groups.map((g) => g[0]))
      .range([32, 32 + groups.length * 45])
      .padding(0.09);
  const domain = metric.endsWith("Percent") ? 100 : heatDomain(rows, metric),
    color = scaleSequential(interpolateRgb("#eaf5fb", "#087bb5")).domain([
      0,
      domain,
    ]);
  const unit = metric.endsWith("Hours")
    ? "h"
    : metric.endsWith("Percent")
      ? "%"
      : "";
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ChartPanel
      title="Subject supply & demand"
      subtitle="Subject pools overlap · capacity is shared"
      action={
        <label className="text-xs">
          <span className="sr-only">Heat-map measure</span>
          <select
            aria-label="Heat-map measure"
            className="max-w-48 rounded border bg-background p-2"
            value={metric}
            onChange={(e) => setMetric(e.target.value as DisplayMetric)}
          >
            {Object.entries(METRIC_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <p className="mb-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>
          {METRIC_LABELS[metric]} · {unit || "count"} · fixed 0–
          {domain.toFixed(1)}
        </span>
        <span>▧ Unavailable ≠ zero · ~ Partial</span>
      </p>
      <div ref={ref} className="overflow-x-auto">
        <svg
          width={plotWidth}
          height={Math.max(90, groups.length * 45 + 42)}
          role="group"
          aria-label={`Monthly ${METRIC_LABELS[metric]}, overlapping subject pools`}
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
          {months.map((m) => (
            <text
              key={m}
              x={x(m)! + x.bandwidth() / 2}
              y="18"
              textAnchor="middle"
              fill="currentColor"
            >
              {monthLabel(m).split(" ")[0]}
            </text>
          ))}
          {groups.map(([key, r]) => {
            const has = rows.some(
              (v) =>
                v.depth === r.depth + 1 &&
                v.subject === r.subject &&
                (r.depth === 0 || v.curriculum === r.curriculum),
            );
            const label =
              r.depth === 0
                ? r.subject
                : r.depth === 1
                  ? r.curriculum
                  : r.level;
            return (
              <g key={key}>
                <text
                  x={4 + r.depth * 9}
                  y={y(key)! + y.bandwidth() / 2 + 4}
                  fill="currentColor"
                  fontWeight={r.depth === 0 ? 600 : 400}
                  role={has ? "button" : undefined}
                  tabIndex={has ? 0 : undefined}
                  aria-expanded={has ? expanded.has(key) : undefined}
                  aria-label={
                    has
                      ? `${expanded.has(key) ? "Collapse" : "Expand"} ${label}`
                      : undefined
                  }
                  onClick={() => has && toggle(key)}
                  onKeyDown={(e) => has && activate(e, () => toggle(key))}
                  className={has ? "cursor-pointer focus:underline" : ""}
                >
                  {has ? (expanded.has(key) ? "− " : "+ ") : ""}
                  {String(label).slice(0, mobile ? 13 : 23)}
                </text>
                {months.map((m) => {
                  const row = visible.find(
                      (v) => hierarchyKey(v) === key && v.month === m,
                    ),
                    v = row?.[metric];
                  const unknown = v?.value == null;
                  return (
                    <g
                      key={m}
                      role={row ? "button" : undefined}
                      tabIndex={row ? 0 : undefined}
                      aria-label={`${key}, ${monthLabel(m)}, ${METRIC_LABELS[metric]}: ${formatMetric(v, unit)}. ${metricReason(v)}`}
                      onClick={() => row && onSelect(row)}
                      onKeyDown={(e) => row && activate(e, () => onSelect(row))}
                      className="cursor-pointer focus:outline-2 focus:outline-primary"
                    >
                      <rect
                        x={x(m)}
                        y={y(key)}
                        width={x.bandwidth()}
                        height={y.bandwidth()}
                        rx="3"
                        fill={unknown ? `url(#${pattern})` : color(v!.value!)}
                        stroke={
                          v?.completeness === "partial" ? "#d97706" : "none"
                        }
                        strokeDasharray="3 2"
                      />
                      <text
                        x={x(m)! + x.bandwidth() / 2}
                        y={y(key)! + y.bandwidth() / 2 + 4}
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
                      <title>{metricReason(v)}</title>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      {!groups.length && (
        <p className="text-sm text-muted-foreground">
          No mapped subject evidence. Review source quality for unmapped
          classes.
        </p>
      )}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          View data
        </summary>
        <table className="mt-3 w-full text-left">
          <thead>
            <tr>
              <th>Subject / month</th>
              <th>{METRIC_LABELS[metric]}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className="border-t">
                <th className="py-2 font-normal">
                  {hierarchyKey(r)} · {monthLabel(r.month)}
                </th>
                <td>
                  <button onClick={() => onSelect(r)} className="text-primary">
                    {formatMetric(r[metric], unit)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </ChartPanel>
  );
}
