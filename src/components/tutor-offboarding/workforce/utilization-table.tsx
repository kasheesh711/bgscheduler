"use client";
import { useState } from "react";
import type { WorkforcePersonRow } from "@/lib/tutor-offboarding/workforce/types";
import { Panel, Tag } from "../atoms";
import { scaleLinear } from "d3";
import { activate, INK, useChartWidth } from "./charts";
import { Input } from "@/components/ui/input";
import {
  formatMetric,
  metricReason,
  RATE_LABELS,
  rateFormula,
  type DisplayMetric,
} from "./presentation";
export function sortPeople(
  people: WorkforcePersonRow[],
  key: DisplayMetric,
  direction: "asc" | "desc",
) {
  return [...people].sort((a, b) => {
    const av = a[key].value,
      bv = b[key].value;
    if (av === null)
      return bv === null ? a.displayName.localeCompare(b.displayName) : 1;
    if (bv === null) return -1;
    return (
      (av - bv) * (direction === "asc" ? 1 : -1) ||
      a.displayName.localeCompare(b.displayName)
    );
  });
}
export function UtilizationTable({
  people,
  onSelect,
}: {
  people: WorkforcePersonRow[];
  onSelect: (person: WorkforcePersonRow) => void;
}) {
  const { ref, width } = useChartWidth();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DisplayMetric>("consumedUtilizationPercent");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const filtered = sortPeople(
    people.filter((person) =>
      person.displayName.toLowerCase().includes(search.toLowerCase()),
    ),
    sort,
    direction,
  );
  const columns: DisplayMetric[] = [
    "offeredHours",
    "leaveHours",
    "usableHours",
    "bookedHours",
    "creditConsumedHours",
    "recordedTeachingHours",
    "reservedUtilizationPercent",
    "consumedUtilizationPercent",
    "recordedTeachingUtilizationPercent",
  ];
  const labels: Record<string, string> = {
    offeredHours: "Gross offered hours",
    leaveHours: "Approved leave",
    usableHours: "Usable hours",
    bookedHours: "Booked tutor-hours",
    creditConsumedHours: "Credit-consumed hours",
    recordedTeachingHours: "Recorded teaching hours",
    ...RATE_LABELS,
  };
  const rateKeys = Object.keys(RATE_LABELS) as (keyof typeof RATE_LABELS)[];
  const colors = [INK.supply, INK.credit, INK.actual];
  const left = width < 480 ? 90 : 160,
    right = width < 480 ? 64 : 90;
  const max = Math.max(
    100,
    ...filtered.flatMap((p) => rateKeys.map((k) => p[k].value ?? 0)),
  );
  const x = scaleLinear()
    .domain([0, max * 1.08])
    .range([left, width - right]);
  return (
    <Panel aria-label="Individual utilization">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="font-semibold">Tutor utilization</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Selected range · All three rates use usable hours after approved
            leave, with numerators limited to the same supported dates. Rates
            over 100% remain visible.
          </p>
        </div>
        <Input
          aria-label="Search tutor or teaching administrator"
          placeholder="Find a person…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-64"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 px-5 pt-3 text-xs">
        <label>
          Sort{" "}
          <select
            aria-label="Sort utilization"
            value={sort}
            onChange={(e) => setSort(e.target.value as DisplayMetric)}
            className="ml-2 rounded border bg-background p-2"
          >
            {columns.map((k) => (
              <option key={k} value={k}>
                {labels[k]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded border px-3 py-2"
          aria-label="Reverse sort direction"
          onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}
        >
          {direction === "desc" ? "Highest first ↓" : "Lowest first ↑"}
        </button>
        {rateKeys.map((k, i) => (
          <span key={k} style={{ color: colors[i] }}>
            {i === 0 ? "●" : i === 1 ? "◆" : "■"} {RATE_LABELS[k]}
          </span>
        ))}
      </div>
      <div ref={ref} className="px-4 pt-4">
        <svg
          width="100%"
          height={Math.max(110, filtered.length * 69 + 40)}
          viewBox={`0 0 ${width} ${Math.max(110, filtered.length * 69 + 40)}`}
          role="group"
          aria-label="Three utilization rates by person, with 100 percent reference"
          style={{ fontSize: 11 }}
        >
          {x.ticks(width < 480 ? 3 : 5).map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1="25"
                y2={filtered.length * 69 + 30}
                stroke={t === 100 ? INK.loss : INK.grid}
                strokeDasharray={t === 100 ? "4 3" : undefined}
              />
              <text x={x(t)} y="15" textAnchor="middle" fill="currentColor">
                {t}%
              </text>
            </g>
          ))}
          <line
            x1={x(100)}
            x2={x(100)}
            y1="25"
            y2={filtered.length * 69 + 30}
            stroke={INK.loss}
            strokeDasharray="4 3"
          />
          {filtered.map((p, i) => (
            <g
              key={p.canonicalKey}
              tabIndex={0}
              role="button"
              aria-label={`Open ${p.displayName} evidence: ${rateKeys.map((k) => `${RATE_LABELS[k]} ${formatMetric(p[k], "%")}`).join(", ")}`}
              onClick={() => onSelect(p)}
              onKeyDown={(e) => activate(e, () => onSelect(p))}
              className="cursor-pointer focus:outline-2 focus:outline-primary"
            >
              <rect
                x="0"
                y={30 + i * 69}
                width={width}
                height="66"
                fill="transparent"
              />
              <text x="0" y={51 + i * 69} fontWeight="600" fill="currentColor">
                {p.displayName.slice(0, width < 480 ? 13 : 22)}
              </text>
              <text x="0" y={67 + i * 69} fontSize="10" fill="currentColor">
                {p.pendingDeparture
                  ? "Pending departure"
                  : p.role === "teaching_admin"
                    ? "Teaching admin"
                    : "Tutor"}
              </text>
              {rateKeys.map((k, j) => {
                const v = p[k].value,
                  cy = 41 + i * 69 + j * 16;
                return (
                  <g key={k}>
                    <line
                      x1={left}
                      x2={width - right}
                      y1={cy}
                      y2={cy}
                      stroke={INK.grid}
                      strokeWidth=".6"
                    />
                    {v !== null ? (
                      j === 0 ? (
                        <circle cx={x(v)} cy={cy} r="4" fill={colors[j]} />
                      ) : j === 1 ? (
                        <path
                          d={`M${x(v)} ${cy - 5}l5 5-5 5-5-5Z`}
                          fill={colors[j]}
                        />
                      ) : (
                        <rect
                          x={x(v) - 4}
                          y={cy - 4}
                          width="8"
                          height="8"
                          fill={colors[j]}
                        />
                      )
                    ) : (
                      <text x={left + 4} y={cy + 4} fill="currentColor">
                        ?
                      </text>
                    )}
                    <text x={width - right + 8} y={cy + 4} fill={colors[j]}>
                      {v === null ? "Unknown" : formatMetric(p[k], "%")}
                    </text>
                    <title>{rateFormula(p, k)}</title>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <details className="px-5 pb-4 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          View data & exceptions
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">
              Tutor and teaching administrator hours and utilization for the
              selected range
            </caption>
            <thead className="bg-muted/30">
              <tr>
                <th scope="col" className="min-w-44 px-4 py-3">
                  Person
                </th>
                {columns.map((key) => (
                  <th
                    key={key}
                    scope="col"
                    className="min-w-28 px-3 py-3"
                    aria-sort={
                      sort === key
                        ? direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      className="rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
                      onClick={() => {
                        setSort(key);
                        setDirection(
                          sort === key && direction === "desc" ? "asc" : "desc",
                        );
                      }}
                    >
                      {labels[key]}{" "}
                      {sort === key ? (direction === "desc" ? "↓" : "↑") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((person) => (
                <tr className="border-t align-top" key={person.canonicalKey}>
                  <th scope="row" className="px-4 py-3">
                    <button
                      onClick={() => onSelect(person)}
                      className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      {person.displayName}
                    </button>
                    <p className="mt-1 font-normal text-muted-foreground">
                      {person.role === "teaching_admin"
                        ? "Teaching admin"
                        : person.role === "tutor"
                          ? "Tutor"
                          : "Role unavailable"}
                    </p>
                    {person.pendingDeparture ? (
                      <Tag tone="amber" className="mt-2">
                        Pending departure
                      </Tag>
                    ) : null}
                    {(person.outsideHours.value ?? 0) > 0 ||
                    (person.overlapHours.value ?? 0) > 0 ? (
                      <p className="mt-2 font-normal text-amber-700 dark:text-amber-300">
                        Outside hours: {formatMetric(person.outsideHours, "h")}{" "}
                        · Overlap: {formatMetric(person.overlapHours, "h")}
                      </p>
                    ) : null}
                  </th>
                  {columns.map((key) => (
                    <td
                      key={key}
                      className={`px-3 py-3 ${(person[key].value ?? 0) > 100 && key.endsWith("Percent") ? "font-semibold text-amber-700 dark:text-amber-300" : ""}`}
                      title={
                        key in RATE_LABELS
                          ? rateFormula(person, key as keyof typeof RATE_LABELS)
                          : metricReason(person[key])
                      }
                    >
                      {formatMetric(
                        person[key],
                        key.endsWith("Percent") ? "%" : "h",
                      )}
                      {person[key].completeness === "partial" ? (
                        <span className="mt-1 block text-[10px] text-muted-foreground">
                          Partial support
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {filtered.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">
          No people match this selection.
        </p>
      ) : null}
    </Panel>
  );
}
