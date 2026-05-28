import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseClient } from "@/lib/wise/client";
import {
  fetchCreditSessions,
  fetchCreditStudents,
  fetchSessionCredits,
  fetchSessionTeacherFeedback,
  type WiseCreditSession,
  type WiseCreditStudent,
} from "@/lib/credit-control/wise";
import {
  CREDIT_CONTROL_INSERT_CHUNK_SIZE,
  CreditControlInsertError,
  runCreditControlSync,
  serializeCreditControlSyncError,
} from "@/lib/credit-control/sync";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/credit-control/wise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credit-control/wise")>();
  return {
    ...actual,
    fetchCreditStudents: vi.fn(),
    fetchCreditSessions: vi.fn(),
    fetchSessionCredits: vi.fn(),
    fetchSessionTeacherFeedback: vi.fn(),
  };
});

type InsertEvent = {
  type: "insert";
  table: unknown;
  rows: unknown[];
};

type UpdateEvent = {
  type: "update";
  table: unknown;
  setValue: Record<string, unknown>;
};

type DbEvent = InsertEvent | UpdateEvent;

function fakeClient(): WiseClient {
  return { get: vi.fn() } as unknown as WiseClient;
}

function makeStudent(): WiseCreditStudent {
  return {
    _id: "student-1",
    name: "Ada Lovelace",
    activated: true,
    parents: [{ name: "Parent Lovelace" }],
    classrooms: [{
      _id: "class-1",
      name: "Math Package",
      subject: "Math",
      classType: "REGULAR",
    }],
  };
}

function makeFutureSessions(count: number): WiseCreditSession[] {
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(Date.UTC(2026, 4, 27, 8, index % 60));
    return {
      _id: `session-${index}`,
      classId: {
        _id: "class-1",
        name: "Math Package",
        subject: "Math",
        classType: "REGULAR",
      },
      scheduledStartTime: start,
      scheduledEndTime: new Date(start.getTime() + 60 * 60 * 1000),
      meetingStatus: "UPCOMING",
      duration: 60 * 60 * 1000,
      students: ["student-1"],
    };
  });
}

function assignCause<T extends Error>(error: T, cause: unknown): T {
  Object.defineProperty(error, "cause", {
    value: cause,
    configurable: true,
  });
  return error;
}

function makeDbMock(options: {
  snapshotId?: string;
  failSessionChunkIndex?: number;
  insertError?: Error;
} = {}): { db: Database; events: DbEvent[] } {
  const events: DbEvent[] = [];
  const snapshotId = options.snapshotId ?? "snapshot-1";
  let sessionChunkIndex = 0;

  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        const rows = Array.isArray(value) ? value : [value];
        events.push({ type: "insert", table, rows });

        if (table === schema.creditControlSnapshots) {
          return {
            returning: vi.fn().mockResolvedValue([{ id: snapshotId }]),
          };
        }

        if (table === schema.creditControlSyncRuns) {
          return {
            returning: vi.fn().mockResolvedValue([{ id: "run-1" }]),
          };
        }

        if (table === schema.creditControlSessions) {
          const currentChunk = sessionChunkIndex;
          sessionChunkIndex += 1;
          if (currentChunk === options.failSessionChunkIndex) {
            return Promise.reject(options.insertError ?? new Error("insert failed"));
          }
        }

        return Promise.resolve([]);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((setValue: Record<string, unknown>) => {
        events.push({ type: "update", table, setValue });
        return {
          where: vi.fn().mockResolvedValue([]),
        };
      }),
    })),
  } as unknown as Database;

  return { db, events };
}

function latestUpdate(events: DbEvent[], status: string): UpdateEvent | undefined {
  return events
    .filter((event): event is UpdateEvent => (
      event.type === "update" &&
      event.table === schema.creditControlSyncRuns &&
      event.setValue.status === status
    ))
    .at(-1);
}

describe("runCreditControlSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchCreditStudents).mockResolvedValue([makeStudent()]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => (
      status === "PAST" ? [] : makeFutureSessions(101)
    ));
    vi.mocked(fetchSessionCredits).mockResolvedValue({
      credits: {
        total: 10,
        consumed: 2,
        remaining: 8,
        available: 7,
        bookedSessions: 1,
      },
      sessionCreditHistory: [],
    });
    vi.mocked(fetchSessionTeacherFeedback).mockResolvedValue("");
  });

  it("uses 100-row chunks for credit-control inserts", () => {
    expect(CREDIT_CONTROL_INSERT_CHUNK_SIZE).toBe(100);
  });

  it("attaches the candidate snapshot id before inserting snapshot rows", async () => {
    const { db, events } = makeDbMock();

    const result = await runCreditControlSync(
      db,
      fakeClient(),
      "institute-1",
      new Date("2026-05-26T08:00:00.000Z"),
      { syncRunId: "run-1" },
    );

    expect(result).toMatchObject({
      success: true,
      snapshotId: "snapshot-1",
      promotedSnapshotId: "snapshot-1",
      sessionCount: 101,
    });

    const snapshotLinkIndex = events.findIndex((event) => (
      event.type === "update" &&
      event.table === schema.creditControlSyncRuns &&
      event.setValue.snapshotId === "snapshot-1" &&
      !("status" in event.setValue)
    ));
    const sessionInsertEvents = events.filter((event): event is InsertEvent => (
      event.type === "insert" &&
      event.table === schema.creditControlSessions
    ));

    expect(snapshotLinkIndex).toBeGreaterThan(-1);
    expect(sessionInsertEvents.map((event) => event.rows.length)).toEqual([100, 1]);
    expect(snapshotLinkIndex).toBeLessThan(events.indexOf(sessionInsertEvents[0]));
  });

  it("dedupes duplicate Wise session/student rows before inserting sessions", async () => {
    const duplicateSession = makeFutureSessions(1)[0];
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => (
      status === "PAST" ? [] : [duplicateSession, { ...duplicateSession, students: ["student-1", "student-1"] }]
    ));
    const { db, events } = makeDbMock();

    const result = await runCreditControlSync(
      db,
      fakeClient(),
      "institute-1",
      new Date("2026-05-26T08:00:00.000Z"),
      { syncRunId: "run-1" },
    );

    const sessionInsertEvents = events.filter((event): event is InsertEvent => (
      event.type === "insert" &&
      event.table === schema.creditControlSessions
    ));

    expect(result).toMatchObject({
      success: true,
      sessionCount: 1,
    });
    expect(sessionInsertEvents.map((event) => event.rows.length)).toEqual([1]);
  });

  it("keeps failed sync runs traceable to the candidate snapshot", async () => {
    const dbCause = Object.assign(new Error("duplicate key value violates unique constraint"), {
      name: "NeonDbError",
      code: "23505",
      detail: "Key (snapshot_id, wise_session_id, wise_student_id) already exists.",
      constraint: "cc_sessions_snapshot_session_student_idx",
    });
    const drizzleError = assignCause(
      new Error(`Failed query: insert into credit_control_sessions values ${"x".repeat(5_000)}`),
      dbCause,
    );
    const { db, events } = makeDbMock({
      failSessionChunkIndex: 1,
      insertError: drizzleError,
    });

    const result = await runCreditControlSync(
      db,
      fakeClient(),
      "institute-1",
      new Date("2026-05-26T08:00:00.000Z"),
      { syncRunId: "run-1" },
    );

    expect(result.success).toBe(false);
    expect(result.snapshotId).toBe("snapshot-1");
    expect(result.errorSummary).toContain("credit_control_sessions chunk 2");
    expect(result.errorSummary).toContain("db code 23505");
    expect(result.errorSummary?.length).toBeLessThanOrEqual(2_000);

    const snapshotLink = events.find((event) => (
      event.type === "update" &&
      event.table === schema.creditControlSyncRuns &&
      event.setValue.snapshotId === "snapshot-1"
    ));
    const failedUpdate = latestUpdate(events, "failed");

    expect(snapshotLink).toBeDefined();
    expect(failedUpdate?.setValue.errorSummary).toBe(result.errorSummary);
    expect(failedUpdate?.setValue.metadata).toBeDefined();
    expect(failedUpdate?.setValue).not.toHaveProperty("snapshotId");
  });
});

describe("serializeCreditControlSyncError", () => {
  it("captures insert context, nested causes, database fields, and caps large messages", () => {
    const dbCause = Object.assign(new Error("database rejected the row"), {
      name: "NeonDbError",
      code: "23505",
      detail: "Key already exists.",
      constraint: "cc_sessions_snapshot_session_student_idx",
    });
    const drizzleError = assignCause(new Error(`Failed query: ${"x".repeat(10_000)}`), dbCause);
    const wrapped = new CreditControlInsertError({
      tableName: "credit_control_sessions",
      totalRows: 101,
      chunkIndex: 1,
      chunkStart: 100,
      chunkSize: 1,
    }, drizzleError);

    const serialized = serializeCreditControlSyncError(wrapped);

    expect(serialized.errorSummary).toContain("credit_control_sessions chunk 2");
    expect(serialized.errorSummary).toContain("db code 23505");
    expect(serialized.errorSummary).toContain("constraint cc_sessions_snapshot_session_student_idx");
    expect(serialized.errorSummary.length).toBeLessThanOrEqual(2_000);
    expect(serialized.error.insert).toEqual({
      tableName: "credit_control_sessions",
      totalRows: 101,
      chunkIndex: 1,
      chunkStart: 100,
      chunkSize: 1,
    });
    expect(serialized.error.cause?.name).toBe("Error");
    expect(serialized.error.cause?.message.length).toBeLessThanOrEqual(2_000);
    expect(serialized.error.cause?.cause).toMatchObject({
      name: "NeonDbError",
      fields: {
        code: "23505",
        detail: "Key already exists.",
        constraint: "cc_sessions_snapshot_session_student_idx",
      },
    });
  });
});
