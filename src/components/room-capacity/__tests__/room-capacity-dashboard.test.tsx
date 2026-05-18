import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DailyTrend, MonthlySummary, RoomTable, WeekdayFilter } from "../room-capacity-dashboard";
import type {
  RoomUtilizationDailyRow,
  RoomUtilizationMonthlyRow,
  RoomUtilizationRoomRow,
} from "@/lib/room-capacity/types";

function dailyRow(overrides: Partial<RoomUtilizationDailyRow> = {}): RoomUtilizationDailyRow {
  return {
    date: overrides.date ?? "2026-03-02",
    weekday: overrides.weekday ?? 1,
    occupiedMinutes: overrides.occupiedMinutes ?? 120,
    availableMinutes: overrides.availableMinutes ?? 1_000,
    utilizationPct: overrides.utilizationPct ?? 12,
    sessionCount: overrides.sessionCount ?? 2,
    missingLocationCount: overrides.missingLocationCount ?? 0,
    unknownRoomCount: overrides.unknownRoomCount ?? 0,
    excludedStatusCount: overrides.excludedStatusCount ?? 0,
    overlapMinutes: overrides.overlapMinutes ?? 0,
  };
}

function monthlyRow(overrides: Partial<RoomUtilizationMonthlyRow> = {}): RoomUtilizationMonthlyRow {
  return {
    month: overrides.month ?? "2026-03",
    startDate: overrides.startDate ?? "2026-03-01",
    endDate: overrides.endDate ?? "2026-03-31",
    occupiedMinutes: overrides.occupiedMinutes ?? 12_000,
    availableMinutes: overrides.availableMinutes ?? 48_000,
    utilizationPct: overrides.utilizationPct ?? 25,
    sessionCount: overrides.sessionCount ?? 200,
    missingLocationCount: overrides.missingLocationCount ?? 2,
    unknownRoomCount: overrides.unknownRoomCount ?? 1,
    excludedStatusCount: overrides.excludedStatusCount ?? 5,
    overlapMinutes: overrides.overlapMinutes ?? 60,
  };
}

function roomRow(overrides: Partial<RoomUtilizationRoomRow> = {}): RoomUtilizationRoomRow {
  return {
    roomName: overrides.roomName ?? "Focus",
    capacity: overrides.capacity ?? 2,
    category: overrides.category ?? "standard",
    occupiedMinutes: overrides.occupiedMinutes ?? 600,
    availableMinutes: overrides.availableMinutes ?? 2_000,
    utilizationPct: overrides.utilizationPct ?? 30,
    sessionCount: overrides.sessionCount ?? 10,
    overlapMinutes: overrides.overlapMinutes ?? 30,
  };
}

describe("room utilization dashboard components", () => {
  it("renders daily macro utilization instead of a weekly load heatmap", () => {
    const html = renderToStaticMarkup(
      <DailyTrend rows={[
        dailyRow({ date: "2026-03-02", weekday: 1, utilizationPct: 12 }),
        dailyRow({ date: "2026-03-03", weekday: 2, utilizationPct: 115 }),
      ]} />,
    );

    expect(html).toContain("Daily utilization");
    expect(html).toContain("2 Mar");
    expect(html).toContain("3 Mar");
    expect(html).not.toContain("Weekly heatmap");
    expect(html).not.toContain("Peak room load");
  });

  it("renders monthly utilization summary with occupied and available room-hours", () => {
    const html = renderToStaticMarkup(<MonthlySummary rows={[monthlyRow()]} />);

    expect(html).toContain("Monthly utilization");
    expect(html).toContain("Mar 2026");
    expect(html).toContain("25%");
    expect(html).toContain("200h");
    expect(html).toContain("800h");
    expect(html).toContain("200");
  });

  it("renders per-room utilization sorted table data and overlap minutes", () => {
    const html = renderToStaticMarkup(
      <RoomTable rows={[
        roomRow({ roomName: "Relax (TV)", category: "standard", utilizationPct: 80, overlapMinutes: 120 }),
        roomRow({ roomName: "I learned (online)", category: "online_only", utilizationPct: 10 }),
      ]} />,
    );

    expect(html).toContain("Per-room utilization");
    expect(html).toContain("Relax (TV)");
    expect(html).toContain("I learned (online)");
    expect(html).toContain("online only");
    expect(html).toContain("80%");
    expect(html).toContain("2h");
  });

  it("renders weekday filter controls", () => {
    const html = renderToStaticMarkup(
      <WeekdayFilter selectedWeekdays={[1, 3, 6]} onChange={() => undefined} />,
    );

    expect(html).toContain("Days");
    expect(html).toContain("All");
    expect(html).toContain("Mon");
    expect(html).toContain("Wed");
    expect(html).toContain("Sat");
    expect(html).toContain("aria-pressed=\"true\"");
  });
});
