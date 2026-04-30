/**
 * TCOV-07 — Orchestrator emits conflict_model data_issue when modality contradicts.
 *
 * This test verifies the persistence path:
 *   detectSessionModalityConflict fires -> orchestrator pushes into allIssues
 *   -> orchestrator inserts via db.insert(schema.dataIssues).values(chunk)
 *
 * It does not re-test the conflict-detection matrix; compare.test.ts owns that.
 */

// === Discovery: db.insert chain inventory for data_issues ===
// Enumerated from src/lib/sync/orchestrator.ts at HEAD on 2026-04-30.
//
// DB call inventory:
//   - insert(syncRuns).values({ status }).returning({ id }) at run start
//   - insert(snapshots).values({ active: false }).returning({ id })
//   - update(syncRuns).set({ snapshotId }).where(...)
//   - select().from(tutorAliases)
//   - insert(tutorIdentityGroups).values(...).returning({ id }) per group
//   - insert(tutorIdentityGroupMembers).values(chunk)
//   - update(tutorIdentityGroups).set({ supportedModality }).where(...)
//   - insert(recurringAvailabilityWindows/datedLeaves/rawTeacherTags/
//       subjectLevelQualifications/futureSessionBlocks/tutors).values(chunk)
//   - insert(dataIssues).values(chunk) when allIssues is non-empty
//   - insert(snapshotStats).values({...})
//   - update(snapshots).set({ active: sql }).where(...) on promotion
//   - update(syncRuns).set({ status: "success", ... }).where(...)
//
// WiseClient call inventory:
//   - get(`/institutes/${instituteId}/teachers`)
//   - get(`/institutes/${instituteId}/teachers/${teacherUserId}/availability`, ...)
//   - get(`/institutes/${instituteId}/sessions`, ...)
//
// Modality fixture design:
//   - Conflict combo: paired group => supportedModality "both",
//     isOnlineVariant=true, sessionType="onsite".
//   - Consistent combo: paired group => supportedModality "both",
//     isOnlineVariant=true, sessionType="online".
// === End discovery ===

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
import type {
  WiseAvailabilityEnvelope,
  WiseSession,
  WiseSessionsResponse,
  WiseTeacher,
  WiseTeachersResponse,
} from "@/lib/wise/types";

type InsertValues = unknown[] | Record<string, unknown>;

interface FakeDbHandle {
  db: Database;
  insertSpy: ReturnType<typeof vi.fn>;
  valuesSpy: ReturnType<typeof vi.fn>;
}

function makeFakeDb(): FakeDbHandle {
  let groupCounter = 0;
  const valuesSpy = vi.fn((rows: InsertValues) => Promise.resolve(rows));

  const insertSpy = vi.fn((target: unknown) => {
    const api = {
      _values: undefined as InsertValues | undefined,
      values(rows: InsertValues) {
        api._values = rows;
        valuesSpy(rows);
        return api;
      },
      returning(_fields?: unknown) {
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

  const updateSpy = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  const selectSpy = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([]),
        then: (onFulfilled: (rows: unknown[]) => unknown) =>
          Promise.resolve([]).then(onFulfilled),
      })),
      then: (onFulfilled: (rows: unknown[]) => unknown) =>
        Promise.resolve([]).then(onFulfilled),
    })),
  }));

  return {
    db: {
      insert: insertSpy,
      update: updateSpy,
      select: selectSpy,
    } as unknown as Database,
    insertSpy,
    valuesSpy,
  };
}

type FakeWiseResponse =
  | WiseTeachersResponse
  | WiseAvailabilityEnvelope
  | WiseSessionsResponse;

function makeClient(sessionType: string) {
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
    data: { workingHours: { slots: [] }, leaves: [] },
  };
  const sessions: WiseSession[] = [
    {
      _id: "s-conflict-1",
      userId: { _id: "u-lily-online", name: "Alice (Lily) Smith Online" },
      scheduledStartTime: "2030-05-06T03:00:00.000Z",
      scheduledEndTime: "2030-05-06T04:00:00.000Z",
      meetingStatus: "CONFIRMED",
      type: sessionType,
    },
  ];

  return {
    async get<T = FakeWiseResponse>(path: string): Promise<T> {
      if (path.endsWith("/teachers")) {
        return { data: { teachers } } as T;
      }
      if (path.includes("/availability")) {
        return availability as T;
      }
      if (path.endsWith("/sessions")) {
        return { data: { sessions, page_count: 1, page_number: 1 } } as T;
      }
      throw new Error(`fake WiseClient: unmocked path ${path}`);
    },
  };
}

function conflictRows(valuesSpy: ReturnType<typeof vi.fn>) {
  return valuesSpy.mock.calls
    .map(([rows]) => rows)
    .flatMap((rows) => (Array.isArray(rows) ? rows : [rows]))
    .filter((row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && (row as { type?: unknown }).type === "conflict_model",
    );
}

describe("runFullSync — modality conflict persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists conflict_model when paired teacher record contradicts sessionType", async () => {
    const handle = makeFakeDb();

    const result = await runFullSync(
      handle.db,
      makeClient("onsite") as never,
      "inst-test",
    );

    expect(result.success).toBe(true);
    expect(handle.insertSpy).toHaveBeenCalledWith(schema.dataIssues);

    const rows = conflictRows(handle.valuesSpy);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "conflict_model",
      entityType: "future_session_block",
      entityId: "s-conflict-1",
      severity: "high",
    });
    expect(rows[0].metadata).toMatchObject({
      isOnlineVariant: true,
      sessionType: "onsite",
      groupCanonicalKey: "Lily",
    });
  });

  it("does not emit conflict_model when paired signals agree", async () => {
    const handle = makeFakeDb();

    const result = await runFullSync(
      handle.db,
      makeClient("online") as never,
      "inst-test",
    );

    expect(result.success).toBe(true);
    expect(conflictRows(handle.valuesSpy)).toHaveLength(0);
  });
});
