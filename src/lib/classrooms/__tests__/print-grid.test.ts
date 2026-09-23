import { describe, expect, it } from "vitest";
import {
  buildPrintGrid, splitGridColumnsIntoPages, studentNickname, blockLabel,
  type PrintGridSourceBlock, type PrintGridRoom,
} from "../print-grid";

function room(id: string, name: string, sortOrder: number, patch: Partial<PrintGridRoom> = {}): PrintGridRoom {
  return { id, name, capacity: 3, sortOrder, ...patch };
}
function block(rowId: string, patch: Partial<PrintGridSourceBlock> = {}): PrintGridSourceBlock {
  return { rowId, tutorDisplayName: "Tutor", startMinute: 600, endMinute: 660, room: "Room A", status: "assigned", students: [], ...patch };
}

describe("studentNickname", () => {
  it("extracts the parenthesized nickname", () => {
    expect(studentNickname("Somchai Jaidee (Ka)")).toBe("Ka");
  });
  it("falls back to the first word when there is no nickname", () => {
    expect(studentNickname("Somchai Jaidee")).toBe("Somchai");
  });
  it("returns an em dash for an empty name", () => {
    expect(studentNickname("")).toBe("—");
    expect(studentNickname("   ")).toBe("—");
  });
});

describe("blockLabel", () => {
  it("returns an em dash for an empty roster", () => {
    expect(blockLabel([])).toBe("—");
  });
  it("labels a single student by nickname", () => {
    expect(blockLabel(["Somchai Jaidee (Ka)"])).toBe("Ka");
  });
  it("adds a +N suffix for extra students, counted from the first student's nickname", () => {
    expect(blockLabel(["Somchai Jaidee (Ka)", "Somsri (Su)", "Third (Th)"])).toBe("Ka +2");
  });
});

describe("buildPrintGrid classification", () => {
  const catalog = [room("r1", "Room A", 0), room("r2", "Room B", 1, { category: "online_only" })];

  it("routes a remote status block into the Online column, not needing a centre room", () => {
    const grid = buildPrintGrid([block("remote1", { status: "remote", room: "REMOTE_NO_ROOM_NEEDED" })], catalog, 0);
    const online = grid.columns.find(c => c.kind === "online")!;
    expect(online.blocks.map(b => b.rowId)).toEqual(["remote1"]);
    expect(grid.day.noRoom).toBe(0); // remote never needs a centre room, so it can't be "no room"
  });

  it("routes an assigned/needs_review block matching an active catalog room into that room's column", () => {
    const grid = buildPrintGrid([
      block("a1", { status: "assigned", room: "Room A" }),
      block("a2", { status: "needs_review", room: "Room A" }),
    ], catalog, 0);
    const roomA = grid.columns.find(c => c.key === "r1")!;
    expect(roomA.blocks.map(b => b.rowId).sort()).toEqual(["a1", "a2"]);
    // needs_review status is preserved on the block for Task 2 to style amber.
    expect(roomA.blocks.find(b => b.rowId === "a2")!.status).toBe("needs_review");
  });

  it("routes a no_room status block into the No room column", () => {
    const grid = buildPrintGrid([block("n1", { status: "no_room", room: "NO_ROOM_AVAILABLE" })], catalog, 0);
    const noRoom = grid.columns.find(c => c.kind === "no_room")!;
    expect(noRoom.blocks.map(b => b.rowId)).toEqual(["n1"]);
    expect(noRoom.title).toBe("No room (1)");
  });

  it("routes an assigned/needs_review block whose room text matches no active catalog room into No room", () => {
    const grid = buildPrintGrid([block("u1", { status: "assigned", room: "Closed Room" })], catalog, 0);
    const noRoom = grid.columns.find(c => c.kind === "no_room")!;
    expect(noRoom.blocks.map(b => b.rowId)).toEqual(["u1"]);
  });

  it("treats an online-booth room as its own room column, distinct from the Online (no room) column", () => {
    const grid = buildPrintGrid([block("b1", { status: "assigned", room: "Room B" })], catalog, 0);
    const roomB = grid.columns.find(c => c.key === "r2")!;
    expect(roomB.kind).toBe("room");
    expect(roomB.category).toBe("online_only");
    expect(roomB.blocks.map(b => b.rowId)).toEqual(["b1"]);
    const online = grid.columns.find(c => c.kind === "online")!;
    expect(online.blocks).toEqual([]);
  });

  it("passes cancelledCount through unchanged", () => {
    const grid = buildPrintGrid([], catalog, 7);
    expect(grid.cancelledCount).toBe(7);
  });
});

describe("buildPrintGrid lane assignment", () => {
  it("assigns overlap lanes within a single column using computeOverlapColumns", () => {
    const catalog = [room("r1", "Room A", 0)];
    const grid = buildPrintGrid([
      block("o1", { status: "assigned", room: "Room A", startMinute: 600, endMinute: 660 }),
      block("o2", { status: "assigned", room: "Room A", startMinute: 630, endMinute: 690 }),
    ], catalog, 0);
    const roomA = grid.columns.find(c => c.key === "r1")!;
    const byRow = new Map(roomA.blocks.map(b => [b.rowId, b]));
    expect(byRow.get("o1")!.totalColumns).toBe(2);
    expect(byRow.get("o2")!.totalColumns).toBe(2);
    expect(new Set([byRow.get("o1")!.column, byRow.get("o2")!.column])).toEqual(new Set([0, 1]));
  });
});

describe("buildPrintGrid bounds", () => {
  const catalog = [room("r1", "Room A", 0)];
  it("widens to an hour-aligned floor before 08:00, capped at GRID_FLOOR_MINUTE (07:00)", () => {
    const grid = buildPrintGrid([block("early", { status: "assigned", room: "Room A", startMinute: 6 * 60 + 10, endMinute: 6 * 60 + 40 })], catalog, 0);
    expect(grid.bounds.startMinute).toBe(7 * 60);
  });
  it("never extends past GRID_CEIL_MINUTE (21:00) even for a late-running block", () => {
    const grid = buildPrintGrid([block("late", { status: "assigned", room: "Room A", startMinute: 21 * 60 + 30, endMinute: 22 * 60 + 15 })], catalog, 0);
    expect(grid.bounds.endMinute).toBe(21 * 60);
  });
  it("keeps the default 08:00-21:00 bounds when no block requires widening", () => {
    const grid = buildPrintGrid([block("mid", { status: "assigned", room: "Room A", startMinute: 600, endMinute: 660 })], catalog, 0);
    expect(grid.bounds).toEqual({ startMinute: 8 * 60, endMinute: 21 * 60 });
  });
  it("widens hour-aligned for an in-range block outside the default but inside floor/ceiling", () => {
    const grid = buildPrintGrid([block("wide", { status: "assigned", room: "Room A", startMinute: 7 * 60 + 15, endMinute: 20 * 60 + 45 })], catalog, 0);
    expect(grid.bounds).toEqual({ startMinute: 7 * 60, endMinute: 21 * 60 });
  });
});

describe("splitGridColumnsIntoPages", () => {
  function makeCatalogColumns(n: number) {
    const catalog = Array.from({ length: n }, (_, i) => room(`r${i + 1}`, `Room ${i + 1}`, i));
    return buildPrintGrid([], catalog, 0).columns;
  }

  it("splits the real 24-room catalog into exactly 2 pages: 1-12 with a summary panel, then 13-24 + No room + Online", () => {
    const columns = makeCatalogColumns(24);
    const pages = splitGridColumnsIntoPages(columns);
    expect(pages).toHaveLength(2);
    expect(pages[0].columns.map(c => c.key)).toEqual(Array.from({ length: 12 }, (_, i) => `r${i + 1}`));
    expect(pages[0].hasSummaryPanel).toBe(true);
    expect(pages[1].columns.map(c => c.key)).toEqual([...Array.from({ length: 12 }, (_, i) => `r${13 + i}`), "no-room", "online"]);
    expect(pages[1].columns.reduce((sum, c) => sum + c.units, 0)).toBe(17);
    expect(pages[1].hasSummaryPanel).toBe(false);
  });

  it("generalizes to a 30-room synthetic catalog: 3 pages of 12 / 17 / 1+No room+Online", () => {
    const columns = makeCatalogColumns(30);
    const pages = splitGridColumnsIntoPages(columns);
    expect(pages).toHaveLength(3);
    expect(pages[0].columns).toHaveLength(12);
    expect(pages[1].columns).toHaveLength(17);
    expect(pages[2].columns.map(c => c.key)).toEqual(["r30", "no-room", "online"]);
  });

  it("falls back to a dedicated hasSummaryPanel:true empty-columns page when the per-page budget is pathologically tiny", () => {
    const columns = makeCatalogColumns(3); // 3 rooms + no-room(4 units) + online(1 unit)
    const pages = splitGridColumnsIntoPages(columns, 1, 5);
    expect(pages[0].columns.length).toBeGreaterThanOrEqual(1); // never drops the first column, even over budget
    expect(pages[1]).toEqual({ columns: [], hasSummaryPanel: true });
    // every column from the input still appears exactly once, undropped
    const allKeys = pages.flatMap(p => p.columns.map(c => c.key));
    expect(allKeys.sort()).toEqual(columns.map(c => c.key).sort());
  });
});
