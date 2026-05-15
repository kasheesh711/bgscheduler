import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ForecastPanel, OvercapTable, WeeklyHeatmap } from "../room-capacity-dashboard";
import type { RoomCapacityForecastResponse, RoomCapacityMonthResponse } from "@/lib/room-capacity/types";

function monthData(): RoomCapacityMonthResponse {
  return {
    range: { startDate: "2026-05-15", endDate: "2026-05-21", generatedAt: "2026-05-15T00:00:00.000Z" },
    snapshotMeta: { snapshotId: "snapshot-1", syncedAt: "2026-05-15T00:00:00.000Z" },
    rooms: [{ id: "room-1", name: "Focus", capacity: 1, hasTv: false, category: "standard", active: true, sortOrder: 1 }],
    kpis: {
      currentOvercapIntervals: 1,
      impactedRooms: 1,
      projectedNoRoomSessions: 0,
      unmatchedCurrentAllocations: 0,
      peakLoadRatio: 2,
    },
    current: {
      overcaps: [
        {
          id: "overcap-1",
          source: "current",
          date: "2026-05-15",
          weekday: 5,
          roomName: "Focus",
          startMinute: 9 * 60,
          endMinute: 10 * 60,
          load: 2,
          capacity: 1,
          sessionCount: 2,
          tutors: ["Tutor A", "Tutor B"],
          classes: ["Math A", "Science B"],
        },
      ],
      unmatchedAllocations: [],
      heatmapCells: [
        {
          id: "cell-1",
          source: "current",
          date: "2026-05-15",
          weekday: 5,
          roomName: "Focus",
          startMinute: 9 * 60,
          endMinute: 9 * 60 + 30,
          load: 2,
          capacity: 1,
          loadRatio: 2,
          sessionCount: 2,
          status: "over_capacity",
        },
      ],
      daySummaries: [],
    },
    projected: {
      overcaps: [],
      noRoomRows: [],
      heatmapCells: [],
      daySummaries: [],
    },
  };
}

function forecast(status: "ready" | "missing" = "ready"): RoomCapacityForecastResponse {
  return {
    model: {
      status,
      modelRunId: status === "ready" ? "model-1" : null,
      sourceLabel: status === "ready" ? "Projection" : null,
      forecastStart: status === "ready" ? "2026-06-01" : null,
      forecastEnd: status === "ready" ? "2027-05-01" : null,
      importedAt: status === "ready" ? "2026-05-15T00:00:00.000Z" : null,
    },
    scenario: "Base",
    scenarios: ["Base", "Bear", "Bull"],
    generatedAt: "2026-05-15T00:00:00.000Z",
    weekdayResults: [
      {
        weekday: 1,
        weekdayName: "Monday",
        roomSlotFullDate: "2026-06-01",
        roomTutorFullDate: "2026-06-08",
        roomSlotReason: "No room slot",
        roomTutorReason: "No qualified available tutor",
      },
    ],
    monthlyDrivers: [],
  };
}

describe("room capacity dashboard components", () => {
  it("renders weekly heatmap labels and load titles", () => {
    const html = renderToStaticMarkup(
      <WeeklyHeatmap data={monthData()} source="current" weekOffset={0} onWeekOffsetChange={vi.fn()} />,
    );

    expect(html).toContain("Weekly heatmap");
    expect(html).toContain("Fri 15 May");
    expect(html).toContain("09:00");
    expect(html).toContain("2026-05-15 09:00 2/1");
  });

  it("renders overcap drilldown without student names", () => {
    const html = renderToStaticMarkup(<OvercapTable data={monthData()} />);

    expect(html).toContain("Current Wise overcaps");
    expect(html).toContain("Tutor A, Tutor B");
    expect(html).toContain("Math A, Science B");
    expect(html).toContain("2/1");
    expect(html).not.toContain("Student");
  });

  it("renders forecast ready and missing states", () => {
    const readyHtml = renderToStaticMarkup(
      <ForecastPanel forecast={forecast()} scenario="Base" onScenarioChange={vi.fn()} />,
    );
    const missingHtml = renderToStaticMarkup(
      <ForecastPanel forecast={forecast("missing")} scenario="Base" onScenarioChange={vi.fn()} />,
    );

    expect(readyHtml).toContain("Saturation forecast");
    expect(readyHtml).toContain("Monday");
    expect(readyHtml).toContain("Room slot full");
    expect(readyHtml).toContain("Mon, 1 Jun 2026");
    expect(missingHtml).toContain("Forecast aggregates have not been imported yet");
  });
});
