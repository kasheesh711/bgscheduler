import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentFarCacheShape,
  isFarCacheFresh,
  loadFarLeaveCache,
  saveFarLeaveCache,
  type FarCacheShape,
  type FarLeaveCacheRow,
} from "../availability-cache";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";

const NOW = new Date("2026-09-02T10:00:00.000Z");
const SHAPE: FarCacheShape = { farHorizonDays: 180, farWindowStartDay: 28 };

function makeRow(overrides: Partial<FarLeaveCacheRow> = {}): FarLeaveCacheRow {
  return {
    teacherUserId: "u-1",
    farLeaves: [{ _id: "leave-1", startTime: "2026-11-01T02:00:00.000Z", endTime: "2026-11-01T10:00:00.000Z" }],
    farHorizonDays: 180,
    farWindowStartDay: 28,
    fetchedAt: new Date("2026-09-02T08:00:00.000Z"), // 2h old
    fetchError: null,
    ...overrides,
  };
}

describe("isFarCacheFresh", () => {
  it("is false for a missing row — never seen this teacher", () => {
    expect(isFarCacheFresh(undefined, NOW, 360, SHAPE)).toBe(false);
    expect(isFarCacheFresh(null, NOW, 360, SHAPE)).toBe(false);
  });

  it("is true for a row inside the max age", () => {
    expect(isFarCacheFresh(makeRow(), NOW, 360, SHAPE)).toBe(true);
  });

  it("is false for a row older than the max age", () => {
    const stale = makeRow({ fetchedAt: new Date("2026-09-02T03:59:00.000Z") }); // 361 min
    expect(isFarCacheFresh(stale, NOW, 360, SHAPE)).toBe(false);
  });

  it("treats an exactly-max-age row as fresh", () => {
    const boundary = makeRow({ fetchedAt: new Date("2026-09-02T04:00:00.000Z") }); // exactly 360 min
    expect(isFarCacheFresh(boundary, NOW, 360, SHAPE)).toBe(true);
  });

  it("is false when maxAgeMinutes is 0 — the operator disabled the cache", () => {
    expect(isFarCacheFresh(makeRow({ fetchedAt: NOW }), NOW, 0, SHAPE)).toBe(false);
  });

  it("is false when fetchError is set — a failed fetch proves nothing about leaves", () => {
    const failed = makeRow({ fetchedAt: NOW, fetchError: "429 RATE_LIMITED" });
    expect(isFarCacheFresh(failed, NOW, 360, SHAPE)).toBe(false);
  });

  it("is false when the configured horizon no longer matches the row", () => {
    expect(isFarCacheFresh(makeRow({ farHorizonDays: 90 }), NOW, 360, SHAPE)).toBe(false);
    expect(isFarCacheFresh(makeRow({ farWindowStartDay: 14 }), NOW, 360, SHAPE)).toBe(false);
  });

  it("tolerates clock skew rather than refetching the whole fleet", () => {
    const future = makeRow({ fetchedAt: new Date("2026-09-02T10:05:00.000Z") });
    expect(isFarCacheFresh(future, NOW, 360, SHAPE)).toBe(true);
  });
});

describe("currentFarCacheShape", () => {
  const originalHorizon = process.env.WISE_AVAILABILITY_HORIZON_DAYS;

  afterEach(() => {
    if (originalHorizon === undefined) delete process.env.WISE_AVAILABILITY_HORIZON_DAYS;
    else process.env.WISE_AVAILABILITY_HORIZON_DAYS = originalHorizon;
  });

  it("defaults to the 28/180 split", () => {
    delete process.env.WISE_AVAILABILITY_HORIZON_DAYS;
    expect(currentFarCacheShape()).toEqual({ farHorizonDays: 180, farWindowStartDay: 28 });
  });

  it("invalidates cached rows when the horizon is retuned", () => {
    process.env.WISE_AVAILABILITY_HORIZON_DAYS = "90";
    expect(currentFarCacheShape().farHorizonDays).toBe(90);
    // The default-shaped row above no longer matches, so it must be refetched.
    expect(isFarCacheFresh(makeRow(), NOW, 360)).toBe(false);
  });
});

function makeSelectDb(behaviour: () => Promise<unknown[]>): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => behaviour(),
      }),
    }),
  } as unknown as Database;
}

describe("loadFarLeaveCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty map without querying when there are no teacher ids", async () => {
    const select = vi.fn();
    const db = { select } as unknown as Database;

    expect(await loadFarLeaveCache(db, [])).toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
  });

  it("keys rows by teacherUserId", async () => {
    const db = makeSelectDb(async () => [
      {
        teacherUserId: "u-1",
        farLeaves: [{ startTime: "2026-11-01T02:00:00.000Z", endTime: "2026-11-01T10:00:00.000Z" }],
        farHorizonDays: 180,
        farWindowStartDay: 28,
        fetchedAt: new Date("2026-09-02T08:00:00.000Z"),
        fetchError: null,
      },
    ]);

    const cache = await loadFarLeaveCache(db, ["u-1", "u-2"]);
    expect(cache.size).toBe(1);
    expect(cache.get("u-1")?.farLeaves).toHaveLength(1);
    expect(cache.get("u-2")).toBeUndefined();
  });

  it("returns an empty map when the table does not exist, so every teacher fetches live", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const db = makeSelectDb(async () => {
      throw new Error('relation "wise_teacher_availability_cache" does not exist');
    });

    expect(await loadFarLeaveCache(db, ["u-1"])).toEqual(new Map());
  });

  it("returns an empty map on any other read failure — never a stale or partial set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeSelectDb(async () => {
      throw new Error("connection terminated unexpectedly");
    });

    expect(await loadFarLeaveCache(db, ["u-1"])).toEqual(new Map());
  });
});

describe("saveFarLeaveCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts on teacherUserId", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as unknown as Database;

    const written = await saveFarLeaveCache(db, [
      { teacherUserId: "u-1", farLeaves: [], farHorizonDays: 180, farWindowStartDay: 28 },
    ]);

    expect(written).toBe(1);
    expect(insert).toHaveBeenCalledWith(schema.wiseTeacherAvailabilityCache);
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ target: schema.wiseTeacherAvailabilityCache.teacherUserId }),
    );
  });

  it("does not write or throw for an empty batch", async () => {
    const insert = vi.fn();
    expect(await saveFarLeaveCache({ insert } as unknown as Database, [])).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("swallows write failures so a cache miss never fails a healthy sync", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Promise.reject(new Error('relation "wise_teacher_availability_cache" does not exist')),
        }),
      }),
    } as unknown as Database;

    await expect(
      saveFarLeaveCache(db, [
        { teacherUserId: "u-1", farLeaves: [], farHorizonDays: 180, farWindowStartDay: 28 },
      ]),
    ).resolves.toBe(0);
  });
});
