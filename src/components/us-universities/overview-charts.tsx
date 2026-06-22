"use client";

// ── US Universities — Overview charts ──────────────────────────────────
// Four Chart.js visuals summarizing the active IPEDS slice. Each chart is a
// self-contained <Card> backed by <ChartCanvas>; configs are memoized so the
// canvas only re-instantiates when its data changes. The scatter wires
// Chart.js onClick back to an institution unitId for drill-in.

import { useMemo } from "react";
import type { ChartConfiguration } from "chart.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChartCanvas, chartColors } from "@/components/sales-dashboard/chart-canvas";
import { CONTROL_LABELS } from "@/lib/us-universities/constants";
import type {
  AcceptanceBucket,
  AcceptanceTrendPoint,
  ControlFacet,
  ScatterPoint,
  StateFacet,
} from "@/lib/us-universities/types";
import { cn } from "@/lib/utils";
import {
  acceptanceBucketToFilter,
  controlToFilter,
  stateToFilter,
  topStates,
} from "@/lib/us-universities/chart-filters";
import type { OverviewChartsProps } from "./view-types";

// ── Pure data builders (exported for unit tests) ───────────────────────

/** Bar-chart data for the acceptance-rate selectivity buckets. */
export function buildAcceptanceBarData(buckets: AcceptanceBucket[], color: string) {
  return {
    labels: buckets.map((bucket) => bucket.label),
    datasets: [
      {
        label: "Institutions",
        data: buckets.map((bucket) => bucket.count),
        backgroundColor: color,
        borderRadius: 4,
      },
    ],
  };
}

/** A scatter point carrying its unitId so chart clicks can resolve a target. */
export interface ScatterDatumWithId {
  x: number;
  y: number;
  unitId: number;
  name: string;
}

/**
 * One scatter dataset per control type (Public / Private nonprofit / Private
 * for-profit), keeping only points with BOTH cost and gradRate present so
 * missing metrics are never coerced to 0. Each datum carries its unitId for
 * click-to-open.
 */
export function buildScatterData(points: ScatterPoint[], palette: string[]) {
  const controlOrder = [1, 2, 3] as const;
  const datasets = controlOrder.map((control, index) => {
    const data: ScatterDatumWithId[] = points
      .filter(
        (point) =>
          point.control === control &&
          point.cost != null &&
          point.gradRate != null,
      )
      .map((point) => ({
        x: point.cost as number,
        y: point.gradRate as number,
        unitId: point.unitId,
        name: point.name,
      }));
    return {
      label: CONTROL_LABELS[control] ?? `Control ${control}`,
      data,
      backgroundColor: palette[index % palette.length],
      pointRadius: 4,
      pointHoverRadius: 6,
    };
  });
  return { datasets };
}

/** Horizontal-bar data for the top-N states by institution count. */
export function buildStateBarData(states: StateFacet[], color: string, topN = 15) {
  const top = [...states]
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
  return {
    labels: top.map((facet) => facet.state),
    datasets: [
      {
        label: "Institutions",
        data: top.map((facet) => facet.count),
        backgroundColor: color,
        borderRadius: 4,
      },
    ],
  };
}

/**
 * Line-chart data for average acceptance rate over time. Drops years whose
 * avgAcceptance is null so missing data is never plotted as 0 (fail-closed).
 */
export function buildAcceptanceTrendData(trend: AcceptanceTrendPoint[], color: string) {
  const points = trend.filter((point) => point.avgAcceptance != null);
  return {
    labels: points.map((point) => point.dataYear),
    datasets: [
      {
        label: "Avg. acceptance rate",
        data: points.map((point) => point.avgAcceptance as number),
        borderColor: color,
        backgroundColor: color,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
      },
    ],
  };
}

/** Doughnut data for the public/private control mix. */
export function buildControlDoughnutData(controls: ControlFacet[], palette: string[]) {
  return {
    labels: controls.map((facet) => facet.label),
    datasets: [
      {
        label: "Institutions",
        data: controls.map((facet) => facet.count),
        backgroundColor: controls.map((_, index) => palette[index % palette.length]),
        borderWidth: 0,
      },
    ],
  };
}

// ── Component ──────────────────────────────────────────────────────────

export function OverviewCharts({ overview, active, onSelect, onFilter }: OverviewChartsProps) {
  const acceptanceConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    return {
      type: "bar",
      data: buildAcceptanceBarData(overview.acceptanceBuckets, colors.chart[0]),
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_event, elements) => {
          if (!onFilter) return;
          const hit = elements[0];
          if (!hit) return;
          const bucket = overview.acceptanceBuckets[hit.index];
          if (bucket) onFilter(acceptanceBucketToFilter(bucket));
        },
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: "Institutions" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${Number(ctx.raw)} institutions`,
            },
          },
        },
      },
    };
  }, [overview.acceptanceBuckets, onFilter]);

  const scatterConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    const data = buildScatterData(overview.scatter, colors.chart);
    return {
      type: "scatter",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_event, elements) => {
          const hit = elements[0];
          if (!hit) return;
          const dataset = data.datasets[hit.datasetIndex];
          const datum = dataset?.data[hit.index];
          if (datum) onSelect(datum.unitId);
        },
        scales: {
          x: {
            title: { display: true, text: "In-state sticker price (USD)" },
            ticks: {
              callback: (value) => `$${Math.round(Number(value) / 1000)}k`,
            },
          },
          y: {
            title: { display: true, text: "6-year graduation rate (%)" },
            min: 0,
            max: 100,
          },
        },
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const datum = ctx.raw as ScatterDatumWithId;
                return ` ${datum.name}: $${datum.x.toLocaleString()}, ${datum.y}% grad`;
              },
            },
          },
        },
      },
    };
  }, [overview.scatter, onSelect]);

  const stateConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    return {
      type: "bar",
      data: buildStateBarData(overview.states, colors.chart[1]),
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_event, elements) => {
          if (!onFilter) return;
          const hit = elements[0];
          if (!hit) return;
          const facet = topStates(overview.states)[hit.index];
          if (facet) onFilter(stateToFilter(facet.state));
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: "Institutions" },
          },
          y: { grid: { display: false } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${Number(ctx.raw)} institutions`,
            },
          },
        },
      },
    };
  }, [overview.states, onFilter]);

  const acceptanceTrendConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    return {
      type: "line",
      data: buildAcceptanceTrendData(overview.acceptanceTrend, colors.chart[2]),
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: {
            beginAtZero: true,
            max: 100,
            title: { display: true, text: "Avg. acceptance rate (%)" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${Number(ctx.raw)}% acceptance`,
            },
          },
        },
      },
    };
  }, [overview.acceptanceTrend]);

  const controlConfig = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    return {
      type: "doughnut",
      data: buildControlDoughnutData(overview.controls, colors.chart),
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (_event, elements) => {
          if (!onFilter) return;
          const hit = elements[0];
          if (!hit) return;
          const facet = overview.controls[hit.index];
          if (facet) onFilter(controlToFilter(facet.control));
        },
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${Number(ctx.raw)}`,
            },
          },
        },
      },
    };
  }, [overview.controls, onFilter]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card className="min-h-[340px]">
        <CardHeader>
          <CardTitle>Admissions selectivity</CardTitle>
          <CardDescription>
            Institutions grouped by acceptance-rate band.
            {onFilter ? " Click to filter." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className={cn("flex min-h-[240px] flex-col", onFilter && "cursor-pointer")}>
          <ChartCanvas
            config={acceptanceConfig}
            active={active}
            ariaLabel="Number of institutions by acceptance-rate band"
          />
        </CardContent>
      </Card>

      <Card className="min-h-[340px]">
        <CardHeader>
          <CardTitle>Cost vs. 6-year graduation rate</CardTitle>
          <CardDescription>
            In-state sticker price against bachelor&apos;s graduation rate, colored by
            control. Click a point to open the institution.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-[240px] flex-col">
          <ChartCanvas
            config={scatterConfig}
            active={active}
            ariaLabel="Scatter plot of in-state cost versus six-year graduation rate, colored by institution control"
          />
        </CardContent>
      </Card>

      <Card className="min-h-[340px]">
        <CardHeader>
          <CardTitle>Universities by state</CardTitle>
          <CardDescription>
            Top 15 states by institution count.{onFilter ? " Click to filter." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className={cn("flex min-h-[240px] flex-col", onFilter && "cursor-pointer")}>
          <ChartCanvas
            config={stateConfig}
            active={active}
            ariaLabel="Top fifteen states by number of institutions"
          />
        </CardContent>
      </Card>

      <Card className="min-h-[340px]">
        <CardHeader>
          <CardTitle>Public vs. private mix</CardTitle>
          <CardDescription>
            Share of institutions by control type.{onFilter ? " Click to filter." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className={cn("flex min-h-[240px] flex-col", onFilter && "cursor-pointer")}>
          <ChartCanvas
            config={controlConfig}
            active={active}
            ariaLabel="Doughnut chart of institutions by control type"
          />
        </CardContent>
      </Card>

      <Card className="min-h-[340px]">
        <CardHeader>
          <CardTitle>Acceptance rate over time</CardTitle>
          <CardDescription>
            Average acceptance rate across four-year universities, by year.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-[240px] flex-col">
          <ChartCanvas
            config={acceptanceTrendConfig}
            active={active}
            ariaLabel="Line chart of average acceptance rate across four-year universities by year"
          />
        </CardContent>
      </Card>
    </div>
  );
}
