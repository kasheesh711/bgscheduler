"use client";
import { useState } from "react";
import type { WorkforceSubjectRow } from "@/lib/tutor-offboarding/workforce/types";
import { Panel } from "../atoms";
import {
  formatMetric,
  metricReason,
  monthLabel,
  hierarchyKey,
  visibleSubjectRows,
  heatDomain,
  heatTone,
  HEAT_CLASSES,
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
  const [metric, setMetric] = useState<DisplayMetric>("freeHours");
  const visible = visibleSubjectRows(rows, expanded);
  const groups = [
    ...new Map(visible.map((row) => [hierarchyKey(row), row])).entries(),
  ];
  const domain = metric.endsWith("Percent") ? 100 : heatDomain(rows, metric);
  const unit = metric.endsWith("Hours")
    ? "h"
    : metric.endsWith("Percent")
      ? "%"
      : "";
  return (
    <Panel aria-label="Subject supply and demand">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="font-semibold">2. Subject supply and demand</h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Shared capacity can serve several qualified subjects. Subject rows
            overlap; use overall totals for the unique pool. Student bookings
            are booked demand, not unmet demand.
          </p>
        </div>
        <label className="text-xs">
          Heat-map measure
          <select
            className="mt-1 block max-w-full rounded-md border bg-background p-2"
            value={metric}
            onChange={(e) => setMetric(e.target.value as DisplayMetric)}
          >
            {Object.entries(METRIC_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-xs text-muted-foreground">
        <span>
          {METRIC_LABELS[metric]} · {unit || "count"} · fixed scale 0–
          {domain.toFixed(1)}
        </span>
        <span className="rounded bg-muted px-2 py-1">Unavailable ≠ zero</span>
        <span>Expand subject → curriculum → level</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            Monthly {METRIC_LABELS[metric]}, overlapping subject capacity must
            not be summed
          </caption>
          <thead>
            <tr className="bg-muted/20">
              <th scope="col" className="min-w-44 px-4 py-3">
                Subject / curriculum / level
              </th>
              {months.map((month) => (
                <th scope="col" key={month} className="min-w-28 px-2 py-3">
                  {monthLabel(month)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([key, representative]) => {
              const hasChildren = rows.some(
                (row) =>
                  row.depth === representative.depth + 1 &&
                  row.subject === representative.subject &&
                  (representative.depth === 0 ||
                    row.curriculum === representative.curriculum),
              );
              return (
                <tr key={key} className="border-t">
                  <th
                    scope="row"
                    className="px-4 py-3"
                    style={{ paddingLeft: 16 + representative.depth * 16 }}
                  >
                    {hasChildren ? (
                      <button
                        type="button"
                        className="rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
                        aria-expanded={expanded.has(key)}
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {expanded.has(key) ? "−" : "+"}{" "}
                        {representative.depth === 0
                          ? representative.subject
                          : representative.depth === 1
                            ? representative.curriculum
                            : representative.level}
                      </button>
                    ) : (
                      <span>
                        {representative.level ??
                          representative.curriculum ??
                          representative.subject}
                      </span>
                    )}
                  </th>
                  {months.map((month) => {
                    const row = visible.find(
                      (value) =>
                        hierarchyKey(value) === key && value.month === month,
                    );
                    const tone = row
                      ? heatTone(row[metric], domain)
                      : "unknown";
                    return (
                      <td key={month} className="p-1">
                        {row ? (
                          <button
                            type="button"
                            onClick={() => onSelect(row)}
                            className={`w-full rounded-md px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-primary ${tone === "unknown" ? "bg-muted/40 text-muted-foreground" : HEAT_CLASSES[tone]}`}
                            aria-label={`${key}, ${monthLabel(month)}, ${METRIC_LABELS[metric]}: ${formatMetric(row[metric], unit)}. ${metricReason(row[metric])}`}
                            title={metricReason(row[metric])}
                          >
                            {formatMetric(row[metric], unit)}
                            {row[metric].completeness === "partial" ? (
                              <span className="block text-[10px]">
                                Partial support
                              </span>
                            ) : null}
                          </button>
                        ) : (
                          <span className="block p-3 text-muted-foreground">
                            Unavailable
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {groups.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">
          No reviewed academic-subject rows match these filters. Review source
          quality for unmapped classes.
        </p>
      ) : null}
    </Panel>
  );
}
