import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BreakdownChart,
  BreakdownTable,
  DashboardErrorState,
  filtersFromSearchParams,
  isStale,
  KpiCard,
  MetricTable,
  MonthlyVisitsChart,
  WeeklyVisitsChart,
  withGrain,
} from "../foot-traffic-dashboard";

const summary = { studentVisits: 12, uniqueStudents: 8, onsiteClasses: 9, averageVisitsPerClass: 1.33, unidentifiedVisits: 0 };
const period = { key: "2026-09", label: "Sep 2026", periodStart: "2026-09-01", periodEnd: "2026-09-30", isPartial: true, ...summary };
const breakdown = { key: "Focus", label: "Focus", ...summary };

describe("onsite foot-traffic dashboard visualizations", () => {
  it("gives charts accessible names, descriptions and direct mark labels", () => {
    const weekly = renderToStaticMarkup(<WeeklyVisitsChart rows={[period]} />);
    const monthly = renderToStaticMarkup(<MonthlyVisitsChart rows={[period]} septemberMtd />);
    const room = renderToStaticMarkup(<BreakdownChart rows={[breakdown]} label="Room" />);
    expect(weekly).toContain('role="img"');
    expect(weekly).toContain("Every orange point is directly labelled");
    expect(weekly).toContain(">12</text>");
    expect(monthly).toContain("Partial periods are marked");
    expect(monthly).toContain("Sep*");
    expect(room).toContain('aria-label="Student visits by room, directly labelled"');
  });

  it("renders KPI values and exact tables beneath the chart model", () => {
    const kpi = renderToStaticMarkup(<KpiCard label="Student-visits" value="12" detail="1 unidentified" primary />);
    const periodTable = renderToStaticMarkup(<MetricTable rows={[period]} monthly />);
    const roomTable = renderToStaticMarkup(<BreakdownTable rows={[breakdown]} label="Room" />);
    expect(kpi).toContain("Student-visits");
    expect(periodTable).toContain("MTD");
    expect(periodTable).toContain("1.33");
    expect(roomTable).toContain("Focus");
    expect(roomTable).toContain(">12<");
  });

  it("renders a visible empty state instead of an empty chart", () => {
    expect(renderToStaticMarkup(<WeeklyVisitsChart rows={[]} />)).toContain("No qualifying observations");
  });

  it("round-trips URL-backed filters into each CSV action", () => {
    const query = "startDate=2026-03-01&endDate=2026-09-30&room=Focus&weekdays=1%2C3&weekday=5";
    expect(filtersFromSearchParams(new URLSearchParams(query))).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-09-30",
      rooms: ["Focus"],
      weekdays: [1, 3, 5],
    });
    const exportUrl = new URL(withGrain(query, "visits"), "https://example.test");
    expect(exportUrl.pathname).toBe("/api/onsite-foot-traffic/export");
    expect(exportUrl.searchParams.get("grain")).toBe("visits");
    expect(exportUrl.searchParams.get("room")).toBe("Focus");
  });

  it("detects stale or missing source freshness and renders a retryable error state", () => {
    const now = new Date("2026-09-04T12:00:00.000Z").getTime();
    expect(isStale(null, now)).toBe(true);
    expect(isStale("2026-09-03T00:00:00.000Z", now)).toBe(false);
    expect(isStale("2026-09-02T23:59:59.999Z", now)).toBe(true);
    const error = renderToStaticMarkup(<DashboardErrorState error="Wise unavailable" onRetry={() => undefined} />);
    expect(error).toContain("Foot traffic unavailable");
    expect(error).toContain("Wise unavailable");
    expect(error).toContain("Retry");
  });
});
