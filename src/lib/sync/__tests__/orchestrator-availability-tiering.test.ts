/**
 * AVAIL-01 — near/far leave tiering in runFullSync.
 *
 * Covers the three things that decide whether the tiering is safe:
 *   1. a FRESH cache entry skips the far-tier Wise calls;
 *   2. a STALE entry does not;
 *   3. an EMPTY cache fetches the far tier live for EVERY teacher and no
 *      teacher lands in the snapshot with an empty leave set.
 *
 * (3) is the one that matters. The search engine decides leave conflicts with
 * `Array.some()`, so a leave row that was never fetched is indistinguishable
 * from "no leave" and the tutor is reported Available during real leave. Any
 * regression that lets a cache miss produce an empty leave set must fail here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/sync/past-sessions-diff-hook", () => ({
  runPastSessionsDiffHook: vi.fn().mockResolvedValue({
    capturedCount: 0,
    issues: [],
    durationMs: 0,
  }),
}));

import { runFullSync } from "../orchestrator";
import * as schema from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import type { WiseLeave } from "@/lib/wise/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const instituteId = "inst-test";

const TEACHERS = [
  { teacherId: "t-lily-onsite", userId: "u-lily-onsite", name: "Alice (Lily) Smith" },
  { teacherId: "t-lily-online", userId: "u-lily-online", name: "Alice (Lily) Smith Online" },
];

// ── Fake Postgres ────────────────────────────────────────────────────────

interface FakeDbHandle {
  db: Database;
  insertedRows: Map<unknown, Record<string, unknown>[]>;
  groupUpdates: Record<string, unknown>[];
  syncRunUpdates: Record<string, unknown>[];
  cacheUpserts: Record<string, unknown>[];
}

function makeFakeDb(cacheRows: Record<string, unknown>[] = []): FakeDbHandle {
  const insertedRows = new Map<unknown, Record<string, unknown>[]>();
  const groupUpdates: Record<string, unknown>[] = [];
  const syncRunUpdates: Record<string, unknown>[] = [];
  const cacheUpserts: Record<string, unknown>[] = [];
  let groupCounter = 0;

  function record(target: unknown, rows: unknown) {
    const list = Array.isArray(rows) ? rows : [rows];
    const existing = insertedRows.get(target) ?? [];
    existing.push(...(list as Record<string, unknown>[]));
    insertedRows.set(target, existing);
  }

  const insert = vi.fn((target: unknown) => {
    const api = {
      values(rows: unknown) {
        record(target, rows);
        if (target === schema.wiseTeacherAvailabilityCache) {
          cacheUpserts.push(...(rows as Record<string, unknown>[]));
        }
        return api;
      },
      onConflictDoUpdate() {
        return Promise.resolve(undefined);
      },
      returning() {
        if (target === schema.syncRuns) return Promise.resolve([{ id: "sync-run-1" }]);
        if (target === schema.snapshots) return Promise.resolve([{ id: "snapshot-1" }]);
        if (target === schema.tutorIdentityGroups) {
          groupCounter += 1;
          return Promise.resolve([{ id: `group-${groupCounter}` }]);
        }
        return Promise.resolve([]);
      },
      then(onFulfilled: (value: unknown) => unknown) {
        return Promise.resolve(undefined).then(onFulfilled);
      },
    };
    return api;
  });

  const update = vi.fn((target: unknown) => ({
    set: vi.fn((values: Record<string, unknown>) => {
      if (target === schema.tutorIdentityGroups) groupUpdates.push(values);
      if (target === schema.syncRuns) syncRunUpdates.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  }));

  const select = vi.fn(() => {
    let target: unknown;
    const rows = () =>
      target === schema.wiseTeacherAvailabilityCache ? cacheRows : ([] as unknown[]);
    const chain = {
      from(t: unknown) {
        target = t;
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return Promise.resolve(rows());
      },
      then(onFulfilled: (value: unknown[]) => unknown) {
        return Promise.resolve(rows()).then(onFulfilled);
      },
    };
    return chain;
  });

  return {
    db: { insert, update, select } as unknown as Database,
    insertedRows,
    groupUpdates,
    syncRunUpdates,
    cacheUpserts,
  };
}

// ── Fake Wise ────────────────────────────────────────────────────────────

interface AvailabilityCall {
  userId: string;
  startDay: number;
}

/**
 * Emits a leave in the near tier (day 3) and one in the far tier (day 40), so a
 * teacher whose far tier was skipped is distinguishable from one whose far tier
 * was fetched.
 */
function makeTieringWiseClient(options: { rejectFarForUserId?: string } = {}) {
  const availabilityCalls: AvailabilityCall[] = [];
  const origins = new Map<string, number>();

  const client = {
    async get(path: string, params?: Record<string, string>) {
      if (path.endsWith("/teachers")) {
        return {
          data: {
            teachers: TEACHERS.map((t) => ({
              _id: t.teacherId,
              userId: { _id: t.userId, name: t.name },
              tags: [],
            })),
          },
        };
      }

      if (path.endsWith("/sessions")) {
        return { data: { sessions: [], page_count: 1, page_number: 1 } };
      }

      const match = path.match(/\/teachers\/([^/]+)\/availability$/);
      if (!match) throw new Error(`fake WiseClient: unmocked path ${path}`);

      const userId = match[1];
      const start = new Date(params!.startTime).getTime();
      if (!origins.has(userId)) origins.set(userId, start);
      const startDay = Math.round((start - origins.get(userId)!) / DAY_MS);
      availabilityCalls.push({ userId, startDay });

      if (startDay >= 28 && options.rejectFarForUserId === userId) {
        throw new Error("429 RATE_LIMITED");
      }

      const origin = origins.get(userId)!;
      const leaves: WiseLeave[] = [];
      if (startDay === 0) {
        leaves.push({
          _id: `near-${userId}`,
          startTime: new Date(origin + 3 * DAY_MS).toISOString(),
          endTime: new Date(origin + 3 * DAY_MS + 2 * 60 * 60 * 1000).toISOString(),
        });
      }
      if (startDay === 35) {
        leaves.push({
          _id: `far-${userId}`,
          startTime: new Date(origin + 40 * DAY_MS).toISOString(),
          endTime: new Date(origin + 40 * DAY_MS + 2 * 60 * 60 * 1000).toISOString(),
        });
      }

      return {
        data: {
          ...(startDay === 0
            ? { workingHours: { slots: [{ day: 1, startTime: "10:00", endTime: "12:00" }] } }
            : {}),
          leaves,
        },
      };
    },
    getStats() {
      return { requests: availabilityCalls.length, byPath: {} };
    },
  };

  return { client, availabilityCalls };
}

function callsFor(calls: AvailabilityCall[], userId: string): AvailabilityCall[] {
  return calls.filter((c) => c.userId === userId);
}

function cacheRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    teacherUserId: userId,
    farLeaves: [
      {
        _id: `cached-far-${userId}`,
        startTime: "2027-01-04T02:00:00.000Z",
        endTime: "2027-01-04T10:00:00.000Z",
      },
    ],
    farHorizonDays: 180,
    farWindowStartDay: 28,
    fetchedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h old
    fetchError: null,
    ...overrides,
  };
}

function leaveRowsByTeacher(handle: FakeDbHandle): Map<string, Record<string, unknown>[]> {
  const rows = handle.insertedRows.get(schema.datedLeaves) ?? [];
  const byTeacher = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row.wiseTeacherId);
    byTeacher.set(key, [...(byTeacher.get(key) ?? []), row]);
  }
  return byTeacher;
}

function successMetadata(handle: FakeDbHandle): Record<string, unknown> {
  const run = handle.syncRunUpdates.find((u) => u.status === "success");
  return (run?.metadata ?? {}) as Record<string, unknown>;
}

describe("runFullSync — AVAIL-01 near/far leave tiering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the far tier live for EVERY teacher when the cache is empty", async () => {
    const handle = makeFakeDb([]);
    const { client, availabilityCalls } = makeTieringWiseClient();

    const result = await runFullSync(handle.db, client as never, instituteId);
    expect(result.success).toBe(true);

    // One live far fetch per teacher — the fetcher call count equals the
    // teacher count, with no teacher silently skipped.
    const metadata = successMetadata(handle);
    expect(metadata.farTierFetched).toBe(TEACHERS.length);
    expect(metadata.farTierCacheHits).toBe(0);
    expect(metadata.nearHorizonDays).toBe(28);
    expect(metadata.farHorizonDays).toBe(180);

    for (const teacher of TEACHERS) {
      const calls = callsFor(availabilityCalls, teacher.userId);
      // 4 near windows + 22 far windows.
      expect(calls).toHaveLength(26);
      expect(calls.filter((c) => c.startDay >= 28)).toHaveLength(22);
    }

    // No teacher ends with an empty leave set when Wise returned leaves.
    const byTeacher = leaveRowsByTeacher(handle);
    expect(byTeacher.size).toBe(TEACHERS.length);
    for (const teacher of TEACHERS) {
      const rows = byTeacher.get(teacher.teacherId) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      // Both the near-tier leave (day 3) and the far-tier leave (day 40).
      expect(rows).toHaveLength(2);
    }

    // Every live fetch is queued for the single batched upsert.
    expect(handle.cacheUpserts).toHaveLength(TEACHERS.length);
    expect(handle.cacheUpserts.map((r) => r.teacherUserId).sort()).toEqual(
      TEACHERS.map((t) => t.userId).sort(),
    );
  });

  it("reuses a fresh cache entry instead of calling the far tier", async () => {
    const handle = makeFakeDb(TEACHERS.map((t) => cacheRow(t.userId)));
    const { client, availabilityCalls } = makeTieringWiseClient();

    const result = await runFullSync(handle.db, client as never, instituteId);
    expect(result.success).toBe(true);

    const metadata = successMetadata(handle);
    expect(metadata.farTierCacheHits).toBe(TEACHERS.length);
    expect(metadata.farTierFetched).toBe(0);

    for (const teacher of TEACHERS) {
      const calls = callsFor(availabilityCalls, teacher.userId);
      expect(calls).toHaveLength(4); // near tier only
      expect(calls.every((c) => c.startDay < 28)).toBe(true);
    }

    // The cached far leaves are still persisted — a cache hit must not shrink
    // the leave set.
    const byTeacher = leaveRowsByTeacher(handle);
    for (const teacher of TEACHERS) {
      expect(byTeacher.get(teacher.teacherId)).toHaveLength(2);
    }

    // Nothing to write back.
    expect(handle.cacheUpserts).toHaveLength(0);
  });

  it("refetches the far tier when the cached entry is stale", async () => {
    const stale = TEACHERS.map((t) =>
      cacheRow(t.userId, { fetchedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) }),
    );
    const handle = makeFakeDb(stale);
    const { client, availabilityCalls } = makeTieringWiseClient();

    const result = await runFullSync(handle.db, client as never, instituteId);
    expect(result.success).toBe(true);

    expect(successMetadata(handle).farTierFetched).toBe(TEACHERS.length);
    expect(successMetadata(handle).farTierCacheHits).toBe(0);
    for (const teacher of TEACHERS) {
      expect(callsFor(availabilityCalls, teacher.userId)).toHaveLength(26);
    }
  });

  it("refetches the far tier when the cached entry records a fetch error", async () => {
    const handle = makeFakeDb(
      TEACHERS.map((t) => cacheRow(t.userId, { fetchError: "429 RATE_LIMITED" })),
    );
    const { client, availabilityCalls } = makeTieringWiseClient();

    await runFullSync(handle.db, client as never, instituteId);

    expect(successMetadata(handle).farTierFetched).toBe(TEACHERS.length);
    for (const teacher of TEACHERS) {
      expect(callsFor(availabilityCalls, teacher.userId)).toHaveLength(26);
    }
  });

  it("refetches the far tier when the configured horizon no longer matches the row", async () => {
    const handle = makeFakeDb(TEACHERS.map((t) => cacheRow(t.userId, { farHorizonDays: 90 })));
    const { client, availabilityCalls } = makeTieringWiseClient();

    await runFullSync(handle.db, client as never, instituteId);

    expect(successMetadata(handle).farTierFetched).toBe(TEACHERS.length);
    for (const teacher of TEACHERS) {
      expect(callsFor(availabilityCalls, teacher.userId)).toHaveLength(26);
    }
  });

  it("writes a full-horizon leave watermark when both tiers land", async () => {
    const handle = makeFakeDb([]);
    const { client } = makeTieringWiseClient();

    const before = Date.now();
    await runFullSync(handle.db, client as never, instituteId);

    const watermark = handle.groupUpdates[0]?.leavesCompleteThrough as Date;
    expect(watermark).toBeInstanceOf(Date);
    expect(watermark.getTime()).toBeGreaterThan(before + 179 * DAY_MS);
  });

  it("collapses the group watermark to now when ONE identity variant's fetch fails", async () => {
    const handle = makeFakeDb([]);
    const { client } = makeTieringWiseClient({ rejectFarForUserId: "u-lily-online" });

    const before = Date.now();
    const result = await runFullSync(handle.db, client as never, instituteId);
    expect(result.success).toBe(true);

    // The surviving variant still supplies availability windows, so the group
    // stays searchable — the watermark is what stops it being reported
    // Available on a date whose leaves were never fetched.
    const watermark = handle.groupUpdates[0]?.leavesCompleteThrough as Date;
    expect(watermark).toBeInstanceOf(Date);
    expect(watermark.getTime()).toBeLessThanOrEqual(before + DAY_MS);

    // The existing per-teacher completeness data_issue is unchanged.
    const issues = handle.insertedRows.get(schema.dataIssues) ?? [];
    expect(
      issues.some(
        (i) => i.type === "completeness" && String(i.message).includes("429 RATE_LIMITED"),
      ),
    ).toBe(true);
  });
});

// These regressions exercise the pre-onboarding pipeline; the new pipeline has its own integration suite.
vi.mock("@/lib/tutor-onboarding/planner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tutor-onboarding/planner")>(),
  onboardingEnabled: () => false,
}));
