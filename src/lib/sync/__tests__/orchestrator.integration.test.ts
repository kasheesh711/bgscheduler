/**
 * TCOV-02 — Orchestrator integration test against real Postgres (testcontainer).
 *
 * Run only via `npm run test:integration` (requires Docker daemon).
 *
 * SCOPE: This file covers runFullSync's happy-path persistence + atomic
 * promotion + fail-mid-promotion (unresolvedRatio gate). The PAST-01 diff
 * hook end-to-end interaction is OWNED BY TCOV-04 (08.6-05).
 */

// === Discovery: WiseClient call inventory ===
// Enumerated from src/lib/wise/fetchers.ts at HEAD on 2026-04-30.
//
// Minimal WiseClient interface used by runFullSync:
//   - get<WiseTeachersResponse>(`/institutes/${instituteId}/teachers`)
//       -> { data: { teachers: WiseTeacher[] } }
//   - get<WiseAvailabilityEnvelope>(
//       `/institutes/${instituteId}/teachers/${teacherUserId}/availability`,
//       { startTime, endTime },
//     )
//       -> { data: { workingHours?: { slots }, leaves?: WiseLeave[] } }
//       AVAIL-01: called in two tiers — 4 near windows (days 0-28) every run,
//       then 22 far windows (days 28-182) unless a fresh
//       wise_teacher_availability_cache row covers them.
//   - get<WiseSessionsResponse>(
//       `/institutes/${instituteId}/sessions`,
//       { status: "FUTURE", paginateBy: "COUNT", page_number, page_size },
//     )
//       -> { data: { sessions: WiseSession[], page_count: number } }
// === End discovery ===

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { runFullSync } from "@/lib/sync/orchestrator";
import { normalizeLeaves } from "@/lib/normalization/leaves";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type {
  WiseAvailabilityEnvelope,
  WiseLeave,
  WiseSession,
  WiseSessionsResponse,
  WiseTeacher,
  WiseTeachersResponse,
} from "@/lib/wise/types";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

const instituteId = "inst-test";

type FakeWiseResponse =
  | WiseTeachersResponse
  | WiseAvailabilityEnvelope
  | WiseSessionsResponse;

interface FakeWiseClient {
  get<T = FakeWiseResponse>(path: string, params?: Record<string, string>): Promise<T>;
  // EFF-00: runFullSync reads client.getStats() on both the success and the
  // failure path. Without it every test in this file dies in the catch block
  // with "client.getStats is not a function", masking the real assertion.
  getStats(): { requests: number; byPath: Record<string, number> };
}

const NO_STATS = () => ({ requests: 0, byPath: {} as Record<string, number> });

function makeClient(opts: {
  teachers: WiseTeacher[];
  availabilityByUserId?: Map<string, WiseAvailabilityEnvelope>;
  sessions?: WiseSession[];
}): FakeWiseClient {
  return {
    async get<T>(path: string): Promise<T> {
      if (path === `/institutes/${instituteId}/teachers`) {
        return { data: { teachers: opts.teachers } } as T;
      }

      const availabilityMatch = path.match(
        new RegExp(`/institutes/${instituteId}/teachers/([^/]+)/availability`),
      );
      if (availabilityMatch) {
        const userId = availabilityMatch[1];
        return (
          opts.availabilityByUserId?.get(userId) ?? {
            data: { workingHours: { slots: [] }, leaves: [] },
          }
        ) as T;
      }

      if (path === `/institutes/${instituteId}/sessions`) {
        return {
          data: {
            sessions: opts.sessions ?? [],
            page_number: 1,
            page_count: 1,
            totalRecords: opts.sessions?.length ?? 0,
          },
        } as T;
      }

      throw new Error(`fake WiseClient: unmocked path ${path}`);
    },
    getStats: NO_STATS,
  };
}

function happyPathClient(): FakeWiseClient {
  const teachers: WiseTeacher[] = [
    {
      _id: "t-lily-onsite",
      userId: { _id: "u-lily-onsite", name: "Alice (Lily) Smith" },
      tags: [],
    },
    {
      _id: "t-lily-online",
      userId: { _id: "u-lily-online", name: "Alice (Lily) Smith Online" },
      tags: [],
    },
  ];

  const availability: WiseAvailabilityEnvelope = {
    data: {
      workingHours: {
        slots: [{ day: 1, startTime: "10:00", endTime: "12:00" }],
      },
      leaves: [],
    },
  };

  const futureSession: WiseSession = {
    _id: "s-lily-1",
    userId: { _id: "u-lily-online", name: "Alice (Lily) Smith Online" },
    scheduledStartTime: "2030-05-06T03:00:00.000Z",
    scheduledEndTime: "2030-05-06T04:00:00.000Z",
    meetingStatus: "CONFIRMED",
    type: "online",
    title: "Lily Math",
    classId: { name: "Student A", subject: "Math", classType: "Regular" },
  };

  return makeClient({
    teachers,
    availabilityByUserId: new Map([
      ["u-lily-onsite", availability],
      ["u-lily-online", availability],
    ]),
    sessions: [futureSession],
  });
}

function unresolvedIdentityClient(): FakeWiseClient {
  const teachers: WiseTeacher[] = [
    {
      _id: "t-unresolved",
      userId: { _id: "u-unresolved", name: "Unmatched Teacher" },
      tags: [],
    },
  ];

  return makeClient({
    teachers,
    availabilityByUserId: new Map([
      [
        "u-unresolved",
        {
          data: {
            workingHours: {
              slots: [{ day: 2, startTime: "10:00", endTime: "11:00" }],
            },
            leaves: [],
          },
        },
      ],
    ]),
    sessions: [],
  });
}

/**
 * AVAIL-01 — window-aware fake Wise.
 *
 * Returns the fixture leaves that INTERSECT the requested 7-day window, the way
 * Wise does, so a leave straddling the near/far boundary comes back from both
 * tiers. Records the first window start per teacher, which is the orchestrator's
 * own `from` instant — the anchor the single-tier expectation is rebuilt from.
 */
function makeLeaveWindowClient(opts: {
  teachers: WiseTeacher[];
  leavesByUserId: Map<string, WiseLeave[]>;
}) {
  const firstWindowStart = new Map<string, Date>();
  const windowsByUserId = new Map<string, { start: Date; end: Date }[]>();

  const client: FakeWiseClient = {
    async get<T>(path: string, params?: Record<string, string>): Promise<T> {
      if (path === `/institutes/${instituteId}/teachers`) {
        return { data: { teachers: opts.teachers } } as T;
      }

      const availabilityMatch = path.match(
        new RegExp(`/institutes/${instituteId}/teachers/([^/]+)/availability`),
      );
      if (availabilityMatch) {
        const userId = availabilityMatch[1];
        const start = new Date(params!.startTime);
        const end = new Date(params!.endTime);
        if (!firstWindowStart.has(userId)) firstWindowStart.set(userId, start);
        windowsByUserId.set(userId, [...(windowsByUserId.get(userId) ?? []), { start, end }]);

        const leaves = (opts.leavesByUserId.get(userId) ?? []).filter(
          (leave) => new Date(leave.startTime) < end && new Date(leave.endTime) > start,
        );

        return {
          data: {
            ...(start.getTime() === firstWindowStart.get(userId)!.getTime()
              ? { workingHours: { slots: [{ day: 1, startTime: "10:00", endTime: "12:00" }] } }
              : {}),
            leaves,
          },
        } as T;
      }

      if (path === `/institutes/${instituteId}/sessions`) {
        return {
          data: { sessions: [], page_number: 1, page_count: 1, totalRecords: 0 },
        } as T;
      }

      throw new Error(`fake WiseClient: unmocked path ${path}`);
    },
    getStats: NO_STATS,
  };

  return { client, firstWindowStart, windowsByUserId };
}

/**
 * The leave multiset the PRE-TIERING single-tier loop would have collected:
 * 26 contiguous 7-day windows from `from`. Deliberately an independent
 * reimplementation of the old path rather than a call into the new fetchers.
 */
function singleTierLeaves(from: Date, fixtures: WiseLeave[]): WiseLeave[] {
  const collected: WiseLeave[] = [];
  for (let i = 0; i < 26; i += 1) {
    const start = addDays(from, i * 7);
    const end = addDays(start, 7);
    collected.push(
      ...fixtures.filter(
        (leave) => new Date(leave.startTime) < end && new Date(leave.endTime) > start,
      ),
    );
  }
  return collected;
}

async function seedExistingSnapshots(count: number) {
  const snapshots: { id: string; createdAt: Date }[] = [];

  for (let i = 0; i < count; i += 1) {
    const createdAt = new Date(Date.UTC(2026, 0, i + 1, 0, 0, 0));
    const [snapshot] = await handle.db
      .insert(schema.snapshots)
      .values({ active: i === 0, createdAt })
      .returning({ id: schema.snapshots.id });
    snapshots.push({ id: snapshot.id, createdAt });
  }

  return snapshots;
}

describe("runFullSync — TCOV-02 integration (real Postgres)", () => {
  it("persists a happy-path sync and promotes exactly one active snapshot", async () => {
    const result = await runFullSync(
      handle.db as unknown as Database,
      happyPathClient() as never,
      instituteId,
    );

    expect(result.success).toBe(true);
    expect(result.promotedSnapshotId).toBe(result.snapshotId);
    expect(result.teacherCount).toBe(2);
    expect(result.groupCount).toBe(1);

    const activeSnapshots = await handle.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.active, true));
    expect(activeSnapshots).toHaveLength(1);
    expect(activeSnapshots[0].id).toBe(result.promotedSnapshotId);

    const groups = await handle.db.select().from(schema.tutorIdentityGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalKey).toBe("Lily");
    expect(groups[0].supportedModality).toBe("both");

    const windows = await handle.db.select().from(schema.recurringAvailabilityWindows);
    expect(windows).toHaveLength(2);
    expect(new Set(windows.map((w) => w.weekday))).toEqual(new Set([1]));

    const sessions = await handle.db.select().from(schema.futureSessionBlocks);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].wiseSessionId).toBe("s-lily-1");

    const [syncRun] = await handle.db
      .select()
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.id, result.syncRunId));
    expect(syncRun.status).toBe("success");
    expect(syncRun.promotedSnapshotId).toBe(result.promotedSnapshotId);
  });

  it("prunes older inactive snapshots after a successful promoted sync", async () => {
    const existingSnapshots = await seedExistingSnapshots(33);

    const result = await runFullSync(
      handle.db as unknown as Database,
      happyPathClient() as never,
      instituteId,
    );

    expect(result.success).toBe(true);
    expect(result.promotedSnapshotId).toBe(result.snapshotId);

    const activeSnapshots = await handle.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.active, true));
    expect(activeSnapshots).toHaveLength(1);
    expect(activeSnapshots[0].id).toBe(result.promotedSnapshotId);

    const remainingSnapshots = await handle.db.select().from(schema.snapshots);
    expect(remainingSnapshots).toHaveLength(30);
    expect(remainingSnapshots.some((snapshot) => snapshot.id === existingSnapshots[0].id)).toBe(false);
    expect(remainingSnapshots.some((snapshot) => snapshot.id === result.promotedSnapshotId)).toBe(true);

    const [syncRun] = await handle.db
      .select()
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.id, result.syncRunId));
    const metadata = syncRun.metadata as { pruning?: { deletedSnapshots?: number } } | null;
    expect(metadata?.pruning?.deletedSnapshots).toBeGreaterThan(0);
  });

  it("keeps a promoted sync successful when pruning metadata update fails", async () => {
    await seedExistingSnapshots(33);
    await handle.db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_pruning_metadata_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'metadata write failed';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await handle.db.execute(sql`
      CREATE TRIGGER fail_pruning_metadata_update_trigger
      BEFORE UPDATE ON sync_runs
      FOR EACH ROW
      WHEN (NEW.metadata ? 'pruning')
      EXECUTE FUNCTION fail_pruning_metadata_update();
    `);

    try {
      const result = await runFullSync(
        handle.db as unknown as Database,
        happyPathClient() as never,
        instituteId,
      );

      expect(result.success).toBe(true);
      expect(result.promotedSnapshotId).toBe(result.snapshotId);

      const [syncRun] = await handle.db
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.id, result.syncRunId));
      expect(syncRun.status).toBe("success");
      expect(syncRun.errorSummary).toBeNull();
      expect(syncRun.promotedSnapshotId).toBe(result.promotedSnapshotId);
    } finally {
      await handle.db.execute(sql`
        DROP TRIGGER IF EXISTS fail_pruning_metadata_update_trigger ON sync_runs;
      `);
      await handle.db.execute(sql`
        DROP FUNCTION IF EXISTS fail_pruning_metadata_update();
      `);
    }
  });

  it("does not promote when unresolved identity ratio is at least 50 percent", async () => {
    const [prior] = await handle.db
      .insert(schema.snapshots)
      .values({ active: true })
      .returning({ id: schema.snapshots.id });

    const result = await runFullSync(
      handle.db as unknown as Database,
      unresolvedIdentityClient() as never,
      instituteId,
    );

    expect(result.success).toBe(true);
    expect(result.promotedSnapshotId).toBeNull();
    expect(result.snapshotId).not.toBe(prior.id);

    const activeSnapshots = await handle.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.active, true));
    expect(activeSnapshots).toHaveLength(1);
    expect(activeSnapshots[0].id).toBe(prior.id);

    const candidate = await handle.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.id, result.snapshotId!));
    expect(candidate).toHaveLength(1);
    expect(candidate[0].active).toBe(false);

    const issues = await handle.db
      .select()
      .from(schema.dataIssues)
      .where(eq(schema.dataIssues.snapshotId, result.snapshotId!));
    expect(issues.some((issue) => issue.type === "alias")).toBe(true);

    const [syncRun] = await handle.db
      .select()
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.id, result.syncRunId));
    const metadata = syncRun.metadata as { pruning?: unknown } | null;
    expect(metadata?.pruning).toBeUndefined();
  });

  it("AVAIL-01: near+far merge writes the same dated_leaves as the single-tier path", async () => {
    const teachers: WiseTeacher[] = [
      { _id: "t-lily-onsite", userId: { _id: "u-lily-onsite", name: "Alice (Lily) Smith" }, tags: [] },
      { _id: "t-lily-online", userId: { _id: "u-lily-online", name: "Alice (Lily) Smith Online" }, tags: [] },
    ];

    // One leave inside the near tier, one straddling the day-28 boundary (so it
    // is returned by BOTH tiers and must dedupe), one deep in the far tier.
    const base = new Date();
    const fixtures: WiseLeave[] = [
      {
        _id: "leave-near",
        startTime: addDays(base, 3).toISOString(),
        endTime: addDays(base, 4).toISOString(),
      },
      {
        _id: "leave-straddling-day-28",
        startTime: addDays(base, 27).toISOString(),
        endTime: addDays(base, 29).toISOString(),
      },
      {
        _id: "leave-far",
        startTime: addDays(base, 100).toISOString(),
        endTime: addDays(base, 101).toISOString(),
      },
    ];

    const { client, firstWindowStart, windowsByUserId } = makeLeaveWindowClient({
      teachers,
      leavesByUserId: new Map([
        ["u-lily-onsite", fixtures],
        ["u-lily-online", fixtures],
      ]),
    });

    const result = await runFullSync(
      handle.db as unknown as Database,
      client as never,
      instituteId,
    );
    expect(result.success).toBe(true);

    // Both tiers ran: 4 near windows + 22 far windows, tiling days 0..182.
    for (const userId of ["u-lily-onsite", "u-lily-online"]) {
      expect(windowsByUserId.get(userId)).toHaveLength(26);
    }

    const from = firstWindowStart.get("u-lily-onsite")!;
    const expected = normalizeLeaves(singleTierLeaves(from, fixtures));
    expect(expected).toHaveLength(3);

    const rows = await handle.db
      .select()
      .from(schema.datedLeaves)
      .where(eq(schema.datedLeaves.wiseTeacherId, "t-lily-onsite"));

    const actual = rows
      .map((row) => ({ start: new Date(row.startTime).getTime(), end: new Date(row.endTime).getTime() }))
      .sort((a, b) => a.start - b.start);
    const wanted = expected
      .map((leave) => ({ start: leave.startTime.getTime(), end: leave.endTime.getTime() }))
      .sort((a, b) => a.start - b.start);

    expect(actual).toEqual(wanted);

    // The far tier was fetched live, so it is now cached for the next run.
    const cached = await handle.db.select().from(schema.wiseTeacherAvailabilityCache);
    expect(cached.map((row) => row.teacherUserId).sort()).toEqual([
      "u-lily-online",
      "u-lily-onsite",
    ]);
    expect(cached[0].farHorizonDays).toBe(180);
    expect(cached[0].farWindowStartDay).toBe(28);

    // The group carries a full-horizon leave watermark.
    const [group] = await handle.db.select().from(schema.tutorIdentityGroups);
    expect(group.leavesCompleteThrough).not.toBeNull();
    expect(new Date(group.leavesCompleteThrough!).getTime()).toBeGreaterThan(
      addDays(from, 179).getTime(),
    );
  });
});
