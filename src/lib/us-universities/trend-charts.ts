// ── Admissions-trend chart data builder (pure, exported for tests) ──────
// Moved from institution-profile.tsx so both the legacy profile dialog and the
// new InstitutionDossier share one source of truth. Fail-closed: null/NaN
// metric points become null gaps in the dataset, never plotted as 0.

import type { ChartConfiguration } from "chart.js";
import type { AdmissionsTrendPoint } from "./types";

/**
 * Build the Chart.js `data` object for the multi-year admissions line chart:
 * acceptance rate % and yield rate % by `dataYear`. Labels come from the years
 * (ascending). Null metric points are dropped (not plotted as 0) — fail-closed
 * — so each dataset only carries the years it actually has data for.
 */
export function buildAdmissionsTrendChartData(
  trend: AdmissionsTrendPoint[],
): ChartConfiguration<"line">["data"] {
  const labels = trend.map((point) => point.dataYear);
  const acceptance = trend.map((point) =>
    point.acceptanceRate == null || !Number.isFinite(point.acceptanceRate)
      ? null
      : point.acceptanceRate,
  );
  const yieldRate = trend.map((point) =>
    point.yieldRate == null || !Number.isFinite(point.yieldRate) ? null : point.yieldRate,
  );

  return {
    labels,
    datasets: [
      { label: "Acceptance rate %", data: acceptance, spanGaps: true },
      { label: "Yield rate %", data: yieldRate, spanGaps: true },
    ],
  };
}
