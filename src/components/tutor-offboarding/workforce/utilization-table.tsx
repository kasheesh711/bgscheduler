"use client";

import { useMemo, useState } from "react";
import { scaleLinear } from "d3";
import { Input } from "@/components/ui/input";
import type {
  WorkforceMetric,
  WorkforcePersonRow,
  WorkforcePersonMonth,
  WorkforceUtilizationMetrics,
} from "@/lib/tutor-offboarding/workforce/types";
import { Panel, Tag } from "../atoms";
import { INK } from "./charts";
import {
  formatMetric,
  metricReason,
  METRIC_LABELS,
  RATE_LABELS,
  rateFormula,
  type DisplayMetric,
} from "./presentation";

const PAGE_SIZE = 10;
type SortDirection = "asc" | "desc";

export function sortPeople(
  people: WorkforcePersonRow[],
  key: DisplayMetric,
  direction: SortDirection,
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

function selectedMetrics(
  person: WorkforcePersonRow,
  month?: string,
): WorkforceUtilizationMetrics | WorkforcePersonMonth {
  if (!month) return person;
  const selected = person.months.find((row) => row.month === month);
  if (selected) return selected;
  const unavailable = () => ({
    value: null,
    completeness: "unknown" as const,
    reasonCodes: ["NO_DATA_FOR_SELECTED_MONTH"],
  });
  const metricKeys = [
    ...Object.keys(METRIC_LABELS),
    "utilizationReservedHours",
    "utilizationCreditConsumedHours",
    "utilizationRecordedTeachingHours",
    "coverageHours",
    "expectedCoverageHours",
    "coveragePercent",
  ];
  return Object.fromEntries(
    metricKeys.map((key) => [key, unavailable()]),
  ) as unknown as WorkforceUtilizationMetrics;
}

function calculationLines(
  metrics: WorkforceUtilizationMetrics | WorkforcePersonMonth,
  periodLabel: string,
) {
  return [
    ["Gross offered hours", metrics.offeredHours],
    ["Approved leave", metrics.leaveHours],
    ["Usable hours", metrics.usableHours],
    ["Booked tutor-hours", metrics.bookedHours],
    ["Reserved hours", metrics.reservedHours],
    ["Reserved hours on covered dates", metrics.utilizationReservedHours],
    [
      `Credit-consumed hours (${periodLabel} total)`,
      metrics.creditConsumedHours,
    ],
    [
      "Credit-consumed hours on covered dates",
      metrics.utilizationCreditConsumedHours,
    ],
    ["Recorded teaching hours", metrics.recordedTeachingHours],
    ["Free hours", metrics.freeHours],
    ["Outside offered hours", metrics.outsideHours],
    ["Overlapping booking hours", metrics.overlapHours],
  ] as const;
}

function creditCoverageLabel(metric: WorkforceMetric) {
  const coverage = metric.creditCoverage;
  if (!coverage) return null;
  return `Credit coverage: ${coverage.computedClasses} computed of ${coverage.totalClasses} classes; ${coverage.estimatedClasses} estimated, ${coverage.unknownClasses} unknown.`;
}

function personSummary(
  person: WorkforcePersonRow,
  metrics: WorkforceUtilizationMetrics | WorkforcePersonMonth,
) {
  return [
    `Open ${person.displayName}'s weekly schedule.`,
    `Usable availability ${formatMetric(metrics.usableHours, "h")}.`,
    `Reserved hours on covered dates ${formatMetric(metrics.utilizationReservedHours, "h")}.`,
    `Credit-used hours on supported dates ${formatMetric(metrics.utilizationCreditConsumedHours, "h")}.`,
    `Full selected-period credit total ${formatMetric(metrics.creditConsumedHours, "h")}.`,
    `Availability history covers ${formatMetric(metrics.coveragePercent, "%")} of the selected period.`,
  ].join(" ");
}

export function UtilizationTable({
  people,
  onSelect,
  selectedMonth,
}: {
  people: WorkforcePersonRow[];
  onSelect: (person: WorkforcePersonRow) => void;
  selectedMonth?: string;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<DisplayMetric>("freeHours");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const monthPeople = useMemo(
    () =>
      people.map((person) => ({
        person,
        metrics: selectedMetrics(person, selectedMonth),
      })),
    [people, selectedMonth],
  );
  const filtered = monthPeople.filter(({ person }) =>
    person.displayName.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const sortRows = filtered.map(({ person, metrics }) => ({
    ...person,
    ...metrics,
  }));
  const orderedKeys = sortPeople(sortRows, sort, direction).map(
    (person) => person.canonicalKey,
  );
  const byKey = new Map(
    filtered.map((entry) => [entry.person.canonicalKey, entry]),
  );
  const ordered = orderedKeys.map((key) => byKey.get(key)!);
  const visible = ordered.slice(0, visibleCount);
  const remaining = Math.max(0, ordered.length - visible.length);

  const maxHours = Math.max(
    1,
    ...visible.flatMap(({ metrics }) => [
      metrics.usableHours.value ?? 0,
      metrics.utilizationReservedHours.value ?? 0,
      metrics.utilizationCreditConsumedHours.value ?? 0,
    ]),
  );
  const x = scaleLinear().domain([0, maxHours]).range([0, 100]);
  const ticks = x.ticks(4);

  const sortOptions: { key: DisplayMetric; label: string }[] = [
    { key: "freeHours", label: "Free hours" },
    { key: "reservedUtilizationPercent", label: "Reserved utilization" },
    { key: "consumedUtilizationPercent", label: "Credit utilization" },
    { key: "creditConsumedHours", label: "Credit-consumed hours" },
  ];

  return (
    <Panel aria-label="Tutor capacity by person">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b px-5 py-4">
        <div>
          <h3 className="font-semibold">Tutor capacity</h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            {selectedMonth ? `${selectedMonth} · ` : "Selected range · "}
            Available, booked and credit-used hours on dates with recorded
            availability.
          </p>
        </div>
        <Input
          aria-label="Search tutor or teaching administrator"
          placeholder="Find a person…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setVisibleCount(PAGE_SIZE);
          }}
          className="max-w-64"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 px-5 py-3 text-xs">
        <label className="flex items-center gap-2">
          Sort by
          <select
            aria-label="Sort people"
            value={sort}
            onChange={(event) => setSort(event.target.value as DisplayMetric)}
            className="rounded border bg-background p-2"
          >
            {sortOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded border px-3 py-2"
          aria-label="Reverse sort direction"
          onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}
        >
          {direction === "desc" ? "Highest first ↓" : "Lowest first ↑"}
        </button>
        {selectedMonth ? (
          <span className="text-muted-foreground">
            Showing {visible.length} of {ordered.length} people
          </span>
        ) : null}
      </div>

      {visible.length > 0 ? (
        <div className="px-5 pb-5">
          <div className="mb-3 grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] gap-3 pl-1 text-[11px] text-muted-foreground sm:gap-5">
            <span>Person</span>
            <div className="flex justify-between" aria-hidden="true">
              {ticks.map((tick) => (
                <span key={tick}>
                  {formatMetric(
                    { value: tick, completeness: "complete", reasonCodes: [] },
                    "h",
                  )}
                </span>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {visible.map(({ person, metrics }) => {
              const creditCoverage =
                creditCoverageLabel(metrics.creditConsumedHours) ??
                creditCoverageLabel(metrics.utilizationCreditConsumedHours);
              const series = [
                {
                  label: "Usable availability",
                  metric: metrics.usableHours,
                  color: INK.supply,
                },
                {
                  label: "Booked · covered dates",
                  metric: metrics.utilizationReservedHours,
                  color: INK.actual,
                },
                {
                  label: "Credit used · covered dates",
                  metric: metrics.utilizationCreditConsumedHours,
                  color: INK.credit,
                },
              ];
              return (
                <article
                  key={person.canonicalKey}
                  className="rounded-lg border bg-card p-3 sm:p-4"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(person)}
                    aria-label={personSummary(person, metrics)}
                    className="mb-3 flex w-full flex-wrap items-center justify-between gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <span>
                      <span className="font-medium text-primary underline-offset-2 hover:underline">
                        {person.displayName}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {person.role === "teaching_admin"
                          ? "Teaching admin"
                          : person.role === "tutor"
                            ? "Tutor"
                            : "Role unavailable"}
                      </span>
                    </span>
                    {person.pendingDeparture ? (
                      <Tag tone="amber">Pending departure</Tag>
                    ) : null}
                  </button>

                  <div
                    className="mb-3 flex justify-between gap-2 text-[11px] text-muted-foreground"
                    aria-label={`Availability history coverage: ${formatMetric(metrics.coveragePercent, "%")}`}
                  >
                    <span>Availability history coverage</span>
                    <span>{formatMetric(metrics.coveragePercent, "%")}</span>
                  </div>

                  {series.every((item) => item.metric.value === null) ? (
                    <p className="text-xs text-muted-foreground">
                      Availability was not recorded for this{" "}
                      {selectedMonth ? "month" : "period"}.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {series.map(({ label, metric, color }) => (
                        <div
                          key={label}
                          className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] items-center gap-3 sm:gap-5"
                        >
                          <span className="text-xs text-muted-foreground">
                            {label}
                          </span>
                          <div className="flex min-w-0 items-center gap-3">
                            <div
                              className="relative h-3 min-w-0 flex-1 rounded bg-muted/70"
                              aria-hidden="true"
                            >
                              {metric.value !== null ? (
                                <div
                                  className="absolute inset-y-0 left-0 rounded"
                                  style={{
                                    width: `${x(Math.max(0, metric.value))}%`,
                                    backgroundColor: color,
                                  }}
                                />
                              ) : null}
                            </div>
                            <span className="w-20 shrink-0 text-right text-xs font-medium tabular-nums">
                              {formatMetric(metric, "h")}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="mt-3 text-xs text-muted-foreground">
                    Credit-used {selectedMonth ? "this month" : "in this range"}
                    : {formatMetric(metrics.creditConsumedHours, "h")}
                    {metrics.creditConsumedHours.completeness === "partial"
                      ? " · partial estimate"
                      : " full-period total"}
                    {creditCoverage
                      ? ` · ${creditCoverage.replace("Credit coverage: ", "")}`
                      : ""}
                  </p>

                  <details className="mt-3 border-t pt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      View calculations and data quality
                    </summary>
                    <div className="mt-3 space-y-3">
                      <p className="text-muted-foreground">
                        Utilization compares usable hours after approved leave
                        with booked and credit-used hours on those same
                        supported dates. Rates above 100% are preserved.
                      </p>
                      <p className="text-muted-foreground">
                        Availability history covers{" "}
                        {formatMetric(metrics.coverageHours, "h")} of{" "}
                        {formatMetric(metrics.expectedCoverageHours, "h")}{" "}
                        calendar time in this period.
                      </p>
                      <dl className="grid gap-2 sm:grid-cols-2">
                        {calculationLines(
                          metrics,
                          selectedMonth ? "selected-month" : "selected-range",
                        ).map(([label, value]) => (
                          <div
                            key={label}
                            className="flex justify-between gap-3 border-b border-dashed pb-1"
                          >
                            <dt>{label}</dt>
                            <dd
                              className="text-right tabular-nums"
                              title={metricReason(value)}
                            >
                              {formatMetric(value, "h")}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {creditCoverage ? (
                        <p className="text-muted-foreground">
                          {creditCoverage}
                        </p>
                      ) : null}
                      <div className="grid gap-2 sm:grid-cols-3">
                        {(
                          Object.keys(
                            RATE_LABELS,
                          ) as (keyof typeof RATE_LABELS)[]
                        ).map((key) => (
                          <div
                            key={key}
                            className="rounded bg-muted/40 p-2"
                            title={metricReason(metrics[key])}
                          >
                            <div className="text-muted-foreground">
                              {RATE_LABELS[key]}
                            </div>
                            <div className="mt-1 font-medium tabular-nums">
                              {rateFormula(metrics, key)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
          {remaining > 0 ? (
            <button
              type="button"
              className="mt-4 rounded border px-4 py-2 text-sm hover:bg-muted/50"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              Show more ({remaining} remaining)
            </button>
          ) : null}
        </div>
      ) : (
        <p className="p-5 text-sm text-muted-foreground">
          No people match this selection.
        </p>
      )}
    </Panel>
  );
}
