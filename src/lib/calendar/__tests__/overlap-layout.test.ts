import { describe, expect, it } from "vitest";
import { computeOverlapColumns } from "../overlap-layout";

describe("computeOverlapColumns", () => {
  it("gives a single non-overlapping session its own column", () => {
    const layout = computeOverlapColumns([{ startMinute: 600, endMinute: 660 }]);
    expect(layout).toEqual([{ column: 0, totalColumns: 1 }]);
  });

  it("assigns two overlapping sessions to independent lanes sharing the same total", () => {
    const layout = computeOverlapColumns([
      { startMinute: 600, endMinute: 660 }, // 10:00-11:00
      { startMinute: 630, endMinute: 690 }, // 10:30-11:30
    ]);
    expect(layout).toEqual([
      { column: 0, totalColumns: 2 },
      { column: 1, totalColumns: 2 },
    ]);
  });

  it("gives a three-way staggered cluster totalColumns:3 for every member", () => {
    const layout = computeOverlapColumns([
      { startMinute: 600, endMinute: 660 }, // 10:00-11:00
      { startMinute: 620, endMinute: 680 }, // 10:20-11:20
      { startMinute: 640, endMinute: 700 }, // 10:40-11:40
    ]);
    expect(layout.map(l => l.totalColumns)).toEqual([3, 3, 3]);
    expect(layout.map(l => l.column).sort()).toEqual([0, 1, 2]);
  });

  it("keeps two separate non-overlapping clusters independent", () => {
    const layout = computeOverlapColumns([
      { startMinute: 480, endMinute: 540 }, // 08:00-09:00 cluster A
      { startMinute: 500, endMinute: 560 }, // 08:20-09:20 cluster A
      { startMinute: 720, endMinute: 780 }, // 12:00-13:00 cluster B, alone
    ]);
    expect(layout[0].totalColumns).toBe(2);
    expect(layout[1].totalColumns).toBe(2);
    expect(layout[2]).toEqual({ column: 0, totalColumns: 1 });
  });

  it("returns an empty array for no sessions", () => {
    expect(computeOverlapColumns([])).toEqual([]);
  });
});
