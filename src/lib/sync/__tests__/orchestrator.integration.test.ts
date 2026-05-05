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
//       Called once for the first 7-day window and 25 more times for leaves
//       across the default 180-day horizon.
//   - get<WiseSessionsResponse>(
//       `/institutes/${instituteId}/sessions`,
//       { status: "FUTURE", paginateBy: "COUNT", page_number, page_size },
//     )
//       -> { data: { sessions: WiseSession[], page_count: number } }
// === End discovery ===

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { runFullSync } from "@/lib/sync/orchestrator";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type {
  WiseAvailabilityEnvelope,
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
}

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
});
