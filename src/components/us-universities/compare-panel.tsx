"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ChartConfiguration } from "chart.js";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import { cn } from "@/lib/utils";
import { CONTROL_LABELS, MAX_COMPARE } from "@/lib/us-universities/constants";
import type { CompareInstitution } from "@/lib/us-universities/types";
import type { ComparePanelProps } from "./view-types";
import { InstitutionSearchCombobox } from "./institution-search-combobox";

// -----------------------------------------------------------------------------
// Side-by-side institution comparison. Fetches the compare payload whenever the
// selected unit-id set changes (abortable), renders a metric grid (one row per
// metric, one column per school) with the best value per row highlighted, and a
// SAT score-range floating-bar chart. Missing numeric metrics render as "—"
// (fail-closed UI rule: never coerce null to 0).
// -----------------------------------------------------------------------------

/** Currency formatter for cost metrics; null → em dash (fail-closed UI rule). */
const fmtMoney = (v: number | null | undefined): string =>
  v == null ? "—" : `$${v.toLocaleString("en-US")}`;

/** Percent formatter rounded to a tenth; null → em dash. */
const fmtPct = (v: number | null | undefined): string =>
  v == null ? "—" : `${Math.round(v * 10) / 10}%`;

/**
 * Index of the "best" value in a row given a direction. Ignores nulls; returns
 * null when every value is missing or when fewer than two real values exist
 * (nothing meaningful to highlight). Ties resolve to the first occurrence.
 */
export function bestIndexForMetric(
  values: (number | null)[],
  direction: "high" | "low",
): number | null {
  let bestIdx: number | null = null;
  let bestVal: number | null = null;
  let realCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    realCount += 1;
    if (
      bestVal == null ||
      (direction === "high" ? v > bestVal : v < bestVal)
    ) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return realCount >= 2 ? bestIdx : null;
}

/** Render a p25–p75 band, collapsing missing endpoints to an em dash. */
export function formatRange(p25: number | null, p75: number | null): string {
  if (p25 == null && p75 == null) return "—";
  return `${p25 == null ? "—" : p25}–${p75 == null ? "—" : p75}`;
}

type MetricDirection = "high" | "low";

interface MetricRow {
  label: string;
  /** Raw comparable values used for best-value detection (null = missing). */
  values: (number | null)[];
  /** Display strings, one per institution. */
  display: string[];
  direction: MetricDirection | null;
}

function buildMetricRows(institutions: CompareInstitution[]): MetricRow[] {
  const col = <T,>(pick: (inst: CompareInstitution) => T): T[] =>
    institutions.map(pick);

  const rows: MetricRow[] = [
    {
      label: "Acceptance %",
      values: col((i) => i.acceptanceRate ?? null),
      display: col((i) => fmtPct(i.acceptanceRate)),
      direction: "low",
    },
    {
      label: "SAT reading (p25–p75)",
      values: col((i) => i.satReadingP75 ?? null),
      display: col((i) => formatRange(i.satReadingP25, i.satReadingP75)),
      direction: "high",
    },
    {
      label: "SAT math (p25–p75)",
      values: col((i) => i.satMathP75 ?? null),
      display: col((i) => formatRange(i.satMathP25, i.satMathP75)),
      direction: "high",
    },
    {
      label: "ACT composite (p25–p75)",
      values: col((i) => i.actCompositeP75 ?? null),
      display: col((i) => formatRange(i.actCompositeP25, i.actCompositeP75)),
      direction: "high",
    },
    {
      label: "Tuition (in-state)",
      values: col((i) => i.tuitionInState ?? null),
      display: col((i) => fmtMoney(i.tuitionInState)),
      direction: "low",
    },
    {
      label: "Total price (in-state)",
      values: col((i) => i.totalPriceInState ?? null),
      display: col((i) => fmtMoney(i.totalPriceInState)),
      direction: "low",
    },
    {
      label: "Avg net price",
      values: col((i) => i.avgNetPrice ?? null),
      display: col((i) => fmtMoney(i.avgNetPrice)),
      direction: "low",
    },
    {
      label: "Grad rate 6yr %",
      values: col((i) => i.gradRateBach6yr ?? null),
      display: col((i) => fmtPct(i.gradRateBach6yr)),
      direction: "high",
    },
    {
      label: "Retention % (FT)",
      values: col((i) => i.retentionFt ?? null),
      display: col((i) => fmtPct(i.retentionFt)),
      direction: "high",
    },
    {
      label: "Enrollment",
      values: col((i) => i.enrollmentTotal ?? null),
      display: col((i) =>
        i.enrollmentTotal == null ? "—" : i.enrollmentTotal.toLocaleString("en-US"),
      ),
      direction: null,
    },
    {
      label: "Student-faculty ratio",
      values: col((i) => i.studentFacultyRatio ?? null),
      display: col((i) =>
        i.studentFacultyRatio == null ? "—" : `${i.studentFacultyRatio}:1`,
      ),
      direction: "low",
    },
    {
      label: "Top major",
      values: col(() => null),
      display: col((i) => i.topMajor?.label ?? "—"),
      direction: null,
    },
  ];

  return rows;
}

/**
 * Floating-bar SAT chart config: one bar per school spanning combined SAT
 * (reading p25 + math p25) to (reading p75 + math p75). Schools missing either
 * SAT endpoint are omitted from the chart (cannot draw a band).
 */
export function buildSatChartConfig(
  institutions: CompareInstitution[],
  colors: ReturnType<typeof chartColors>,
): ChartConfiguration | null {
  const labels: string[] = [];
  const ranges: [number, number][] = [];
  const backgrounds: string[] = [];

  institutions.forEach((inst, index) => {
    const low =
      inst.satReadingP25 != null && inst.satMathP25 != null
        ? inst.satReadingP25 + inst.satMathP25
        : null;
    const high =
      inst.satReadingP75 != null && inst.satMathP75 != null
        ? inst.satReadingP75 + inst.satMathP75
        : null;
    if (low == null || high == null) return;
    labels.push(inst.instName);
    ranges.push([low, high]);
    backgrounds.push(colors.chart[index % colors.chart.length]);
  });

  if (ranges.length === 0) return null;

  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "SAT range (R+M, p25–p75)",
          data: ranges,
          backgroundColor: backgrounds,
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          min: 400,
          max: 1600,
          ticks: { color: colors.mutedForeground },
          grid: { color: colors.border },
        },
        y: {
          ticks: { color: colors.mutedForeground },
          grid: { display: false },
        },
      },
    },
  };
}

export function ComparePanel({ unitIds, onRemove, onAdd, onClear }: ComparePanelProps) {
  const [institutions, setInstitutions] = useState<CompareInstitution[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const idsKey = unitIds.join(",");

  useEffect(() => {
    if (unitIds.length === 0) {
      abortRef.current?.abort();
      setInstitutions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch(`/api/us-universities/compare?ids=${encodeURIComponent(idsKey)}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { institutions?: CompareInstitution[] }) => {
        setInstitutions(Array.isArray(data.institutions) ? data.institutions : []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Compare fetch failed", err);
        setInstitutions([]);
        setLoading(false);
      });

    return () => controller.abort();
    // idsKey is the stable serialization of unitIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const metricRows = useMemo(() => buildMetricRows(institutions), [institutions]);
  const chartConfig = useMemo(
    () => buildSatChartConfig(institutions, chartColors()),
    [institutions],
  );

  if (unitIds.length === 0) {
    return (
      <Card className="gap-3 p-6 text-center">
        <p className="text-sm font-medium text-foreground">Compare institutions</p>
        <p className="text-sm text-muted-foreground">
          Add up to {MAX_COMPARE} schools to see their stats side by side.
        </p>
        <div className="mx-auto w-full max-w-sm">
          <InstitutionSearchCombobox
            placeholder="Add an institution…"
            onSelect={(id) => onAdd(id)}
          />
        </div>
      </Card>
    );
  }

  const atCapacity = unitIds.length >= MAX_COMPARE;

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-1 flex-wrap gap-2">
          {/* Chips are driven by unitIds (not the fetched list) so every id in
              the compare set always has a remove control — even a phantom id the
              API did not return (e.g. an unknown id from a shared deep link). */}
          {unitIds.map((id) => {
            const inst = institutions.find((i) => i.unitId === id);
            const name = inst?.instName ?? `Institution #${id}`;
            return (
              <div
                key={id}
                className="flex min-w-40 flex-1 items-start justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{name}</p>
                  <p className="text-xs text-muted-foreground">
                    {inst
                      ? `${inst.control != null ? CONTROL_LABELS[inst.control] ?? "—" : "—"}${inst.stateAbbr ? ` · ${inst.stateAbbr}` : ""}`
                      : loading
                        ? "Loading…"
                        : "Not found"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${name}`}
                  onClick={() => onRemove(id)}
                >
                  <X />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="w-48">
            <InstitutionSearchCombobox
              placeholder={atCapacity ? `Max ${MAX_COMPARE} reached` : "Add institution…"}
              onSelect={(id) => {
                if (!atCapacity) onAdd(id);
              }}
            />
          </div>
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear all
          </Button>
        </div>
      </div>

      {loading && institutions.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading comparison…</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="border-b border-border px-2 py-2 text-left font-medium text-muted-foreground">
                    Metric
                  </th>
                  {institutions.map((inst) => (
                    <th
                      key={inst.unitId}
                      className="border-b border-border px-2 py-2 text-left font-medium text-foreground"
                    >
                      <span className="line-clamp-2">{inst.instName}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metricRows.map((row) => {
                  const bestIdx =
                    row.direction == null
                      ? null
                      : bestIndexForMetric(row.values, row.direction);
                  return (
                    <tr key={row.label} className="border-b border-border/60 last:border-b-0">
                      <th
                        scope="row"
                        className="px-2 py-2 text-left font-normal text-muted-foreground"
                      >
                        {row.label}
                      </th>
                      {row.display.map((value, colIdx) => (
                        <td
                          key={institutions[colIdx]?.unitId ?? colIdx}
                          className={cn(
                            "px-2 py-2 text-foreground/90 tabular-nums",
                            colIdx === bestIdx && "font-semibold text-foreground",
                          )}
                        >
                          {value}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {chartConfig ? (
            <div className="mt-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                SAT score ranges (reading + math, p25–p75)
              </p>
              <div className="h-56">
                <ChartCanvas
                  config={chartConfig}
                  ariaLabel="SAT score range comparison across selected institutions"
                />
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              SAT score ranges unavailable for the selected institutions.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
