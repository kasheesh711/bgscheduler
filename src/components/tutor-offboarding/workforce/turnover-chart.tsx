"use client";
import { useMemo } from "react";
import type { ChartConfiguration } from "chart.js";
import type { WorkforceMonth } from "@/lib/tutor-offboarding/workforce/types";
import {
  ChartCanvas,
  chartColors,
} from "@/components/sales-dashboard/chart-canvas";
import { Panel, Tag } from "../atoms";
import { formatMetric, metricReason, monthLabel } from "./presentation";
export function TurnoverChart({
  months,
  selectedMonth,
  onSelect,
  onPeople,
}: {
  months: WorkforceMonth[];
  selectedMonth: string;
  onSelect: (month: string) => void;
  onPeople?: (month: string) => void;
}) {
  const config = useMemo<ChartConfiguration>(() => {
    const colors = chartColors();
    return {
      type: "bar",
      data: {
        labels: months.map((m) => monthLabel(m.month)),
        datasets: [
          {
            label: "Joined · people",
            data: months.map((m) => m.joinsCount.value),
            backgroundColor: colors.chart[0],
            yAxisID: "people",
          },
          {
            label: "Completed departures · people",
            data: months.map((m) => m.departuresCount.value),
            backgroundColor: colors.chart[1],
            yAxisID: "people",
          },
          {
            type: "line",
            label: "Turnover · %",
            data: months.map((m) => m.turnoverPercent.value),
            borderColor: colors.chart[2],
            backgroundColor: colors.chart[2],
            yAxisID: "percent",
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: colors.mutedForeground },
          },
        },
        scales: {
          people: {
            beginAtZero: true,
            title: { display: true, text: "People" },
            ticks: { precision: 0 },
          },
          percent: {
            position: "right",
            beginAtZero: true,
            title: { display: true, text: "Turnover (%)" },
            grid: { drawOnChartArea: false },
          },
          x: { ticks: { color: colors.mutedForeground } },
        },
        onClick: (_, elements) => {
          const index = elements[0]?.index;
          if (index !== undefined) onSelect(months[index].month);
        },
      },
    };
  }, [months, onSelect]);
  return (
    <Panel aria-label="Monthly workforce trends">
      <div className="space-y-1 border-b px-5 py-4">
        <h3 className="font-semibold">1. Workforce trends</h3>
        <p className="text-xs text-muted-foreground">
          Completed sheet-marked departures ÷ start-of-month reconstructed Wise
          roster × 100. Tutors with remaining classes stay pending.
        </p>
      </div>
      <div className="h-72 px-3 py-4">
        <ChartCanvas
          config={config}
          ariaLabel="Monthly joins and departures in people, turnover on a separate percentage axis. The table below contains all values."
          className="h-full"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            Monthly workforce counts, calculation and people drilldown
          </caption>
          <thead className="bg-muted/30">
            <tr>
              {[
                "Month",
                "Opening roster",
                "Joined",
                "Departed",
                "Pending",
                "Turnover calculation",
              ].map((label) => (
                <th
                  scope="col"
                  key={label}
                  className="whitespace-nowrap px-4 py-3 font-medium"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((month) => (
              <tr
                key={month.month}
                className={
                  month.month === selectedMonth ? "bg-primary/5" : "border-t"
                }
              >
                <th scope="row" className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => onSelect(month.month)}
                    className="rounded text-left text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                    aria-current={
                      month.month === selectedMonth ? "true" : undefined
                    }
                  >
                    {monthLabel(month.month)}
                  </button>
                  {month.partialMonth ? (
                    <Tag className="mt-1">Partial month</Tag>
                  ) : null}
                </th>
                {[
                  month.openingRosterCount,
                  month.joinsCount,
                  month.departuresCount,
                  month.pendingCount,
                ].map((metric, index) => (
                  <td
                    className="px-4 py-3"
                    key={index}
                    title={metricReason(metric)}
                  >
                    {formatMetric(metric)}
                  </td>
                ))}
                <td
                  className="min-w-48 px-4 py-3"
                  title={metricReason(month.turnoverPercent)}
                >
                  {`${formatMetric(month.departuresCount)} ÷ ${formatMetric(month.openingRosterCount)} × 100 = ${formatMetric(month.turnoverPercent, "%")}`}
                  <button
                    className="mt-1 block text-primary underline focus-visible:outline-2"
                    onClick={() => onPeople?.(month.month)}
                  >
                    See people counted
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {months.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">
          No monthly workforce evidence is available for this range.
        </p>
      ) : null}
    </Panel>
  );
}
