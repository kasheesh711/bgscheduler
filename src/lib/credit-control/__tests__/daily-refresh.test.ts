import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
vi.mock("@/lib/db/transaction", () => ({ withDatabaseTransaction: async (db: Database, fn: (db: Database) => Promise<unknown>) => fn(db) }));
import { bangkokDailyWindow, claimDailyRefresh } from "../daily-refresh";
function fakeDb(results: unknown[][]) {
  return { execute: vi.fn(async () => ({ rows: results.shift() ?? [] })) } as unknown as Database;
}
describe("daily refresh eligibility", () => {
  it("uses Bangkok days rather than UTC days and admits only scheduled recovery windows", () => {
    expect(bangkokDailyWindow(new Date("2026-09-10T23:20:00Z"), "shared")).toMatchObject({ day: "2026-09-11", slot: 380 });
    expect(bangkokDailyWindow(new Date("2026-09-10T17:00:00Z"), "shared")).toMatchObject({ day: "2026-09-11", slot: undefined });
    expect(bangkokDailyWindow(new Date("2026-09-11T00:20:00Z"), "shared").slot).toBe(440);
    expect(bangkokDailyWindow(new Date("2026-09-11T01:25:00Z"), "progress").slot).toBe(505);
    expect(bangkokDailyWindow(new Date("2026-09-11T01:55:00Z"), "progress").slot).toBeUndefined();
  });
  it("ordinary ticks perform no acquisition or database/Wise work", async () => {
    const db = fakeDb([]), claim = vi.fn();
    expect(await claimDailyRefresh(db, "shared", new Date("2026-09-11T04:20:00Z"), claim)).toMatchObject({ skipped: true });
    expect(db.execute).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
  });
  it("skips after today's success, before acquiring another run", async () => {
    const db = fakeDb([[], [{ id: "success" }]]), claim = vi.fn();
    expect(await claimDailyRefresh(db, "shared", new Date("2026-09-10T23:50:00Z"), claim)).toMatchObject({ reason: "daily_refresh_complete" });
    expect(claim).not.toHaveBeenCalled();
  });
  it("does not retry a recorded slot or exceed three scheduled attempts", async () => {
    for (const attempts of [[{ metadata: { dailySlot: 410 } }], [{ metadata: {} }, { metadata: {} }, { metadata: {} }]]) {
      const claim = vi.fn(), db = fakeDb([[], [], attempts]);
      expect(await claimDailyRefresh(db, "shared", new Date("2026-09-10T23:50:00Z"), claim)).toMatchObject({ skipped: true });
      expect(claim).not.toHaveBeenCalled();
    }
  });
  it("progress cannot acquire a run without today's shared snapshot", async () => {
    const db = fakeDb([[], [], [], []]), claim = vi.fn();
    expect(await claimDailyRefresh(db, "progress", new Date("2026-09-11T00:25:00Z"), claim)).toMatchObject({ reason: "waiting_for_today_shared_snapshot" });
    expect(claim).not.toHaveBeenCalled();
  });
  it("claims and records the daily slot inside the transaction", async () => {
    const db = fakeDb([[], [], [], []]), claim = vi.fn(async () => ({ syncRunId: "run" }));
    expect(await claimDailyRefresh(db, "shared", new Date("2026-09-10T23:20:00Z"), claim)).toEqual({ syncRunId: "run" });
    expect(claim).toHaveBeenCalledWith(db); expect(db.execute).toHaveBeenCalledTimes(4);
  });
});
