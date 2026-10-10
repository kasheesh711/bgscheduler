import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseApiError, type WiseClient } from "@/lib/wise/client";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { neon } from "@neondatabase/serverless";
vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(() => vi.fn()) }));
import { z } from "zod";
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

import { captureCreditControlWorkforceEvidence } from "@/lib/tutor-offboarding/workforce/credit-control-capture";
vi.mock("@/lib/tutor-offboarding/workforce/credit-control-capture", () => ({ captureCreditControlWorkforceEvidence: vi.fn(async () => ({ sessions: [] })) }));
vi.mock("@/lib/tutor-offboarding/workforce/growth/capture", () => ({ captureGrowthBookingMetadata: vi.fn() }));
vi.mock("@/lib/tutor-offboarding/workforce/growth/reconcile", () => ({ captureGrowthLifecycle: vi.fn() }));
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
  /** True once `.where(...)` runs, i.e. the UPDATE is not table-wide. */
  bounded: boolean;
};

type DbEvent = InsertEvent | UpdateEvent;

function fakeClient(): WiseClient {
  return {
    get: vi.fn(),
    getStats: vi.fn(() => ({ requests: 0, byPath: {} })),
  } as unknown as WiseClient;
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
  /** Rows each `select().from(table)` resolves to; missing tables resolve empty. */
  selectRows?: Map<unknown, unknown[]>;
  /** Tables whose `select()` rejects, for the prior-snapshot failure paths. */
  failSelectTables?: unknown[];
  anchorRows?: unknown[];
  anchorReadError?: boolean;
  insertWait?: (table: unknown, rows: unknown[]) => Promise<unknown>;
} = {}): { db: Database; events: DbEvent[] } {
  const events: DbEvent[] = [];
  const snapshotId = options.snapshotId ?? "snapshot-1";
  let sessionChunkIndex = 0;

  const db = {
    execute: vi.fn(async()=>{if(options.anchorReadError)throw new Error('Anchor read failed');return {rows:options.anchorRows??[]};}),
    select: vi.fn(() => {
      let source: unknown;
      const chain = {
        from: vi.fn((table: unknown) => {
          source = table;
          return chain;
        }),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (
          resolve: (rows: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) => {
          if (options.failSelectTables?.includes(source)) {
            return Promise.reject(new Error("select failed")).then(resolve, reject);
          }
          return Promise.resolve(options.selectRows?.get(source) ?? []).then(resolve, reject);
        },
      };
      return chain;
    }),
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

        return options.insertWait?.(table, rows) ?? Promise.resolve([]);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((setValue: Record<string, unknown>) => {
        const event: UpdateEvent = { type: "update", table, setValue, bounded: false };
        events.push(event);
        return {
          where: vi.fn(() => {
            event.bounded = true;
            return Promise.resolve([]);
          }),
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

  it("limits future source classes to 30 days while keeping 120 past days and correct snapshot metadata", async () => {
    const now = new Date("2026-10-10T06:00:00Z"), { db, events } = makeDbMock();
    expect((await runCreditControlSync(db, fakeClient(), "institute-1", now, { syncRunId: "run-1" })).success).toBe(true);
    expect(fetchCreditSessions).toHaveBeenCalledWith(expect.anything(), "institute-1", "PAST", new Date(+now - 120 * 86_400_000), now);
    expect(fetchCreditSessions).toHaveBeenCalledWith(expect.anything(), "institute-1", "FUTURE", now, new Date(+now + 30 * 86_400_000));
    const snapshot = events.find((event): event is InsertEvent => event.type === "insert" && event.table === schema.creditControlSnapshots);
    expect(snapshot?.rows[0]).toMatchObject({ metadata: { pastWindowDays: 120, futureWindowDays: 30 } });
  });

  it("keeps every snapshot-table insert below the PostgreSQL parameter limit", () => {
    expect(CREDIT_CONTROL_INSERT_CHUNK_SIZE).toBe(2_000);
    for (const table of [schema.creditControlStudents, schema.creditControlPackages, schema.creditControlSessions, schema.creditControlCreditHistory]) {
      expect(CREDIT_CONTROL_INSERT_CHUNK_SIZE * Object.keys(getTableColumns(table)).length).toBeLessThan(65_535);
    }
  });

  it.each(["timeout", "upstream failure"])("retains the prior snapshot after a daily credit-fetch %s", async kind => {
    const { db, events } = makeDbMock();
    const controller = new AbortController();
    vi.mocked(fetchSessionCredits).mockImplementation(async () => {
      if (kind === "timeout") controller.abort(new Error("Refresh deadline exceeded"));
      throw new Error("Wise unavailable");
    });
    const result = await runCreditControlSync(db, fakeClient(), "institute-1", new Date("2026-09-11T00:00:00Z"), {
      syncRunId: "run-1", signal: controller.signal, requireComplete: true,
    });
    expect(result.success).toBe(false);
    expect(events.some(event => event.table === schema.creditControlSnapshots)).toBe(false);
    expect(latestUpdate(events, "failed")).toBeDefined();
  });

  it("records every failed pair and actual calls without private error payloads", async () => {
    const { db, events } = makeDbMock();
    const student = makeStudent();
    student.classrooms = Array.from({ length: 5 }, (_, i) => ({ _id: `class-${i + 1}`, name: "Math Package", subject: "Math" }));
    vi.mocked(fetchCreditStudents).mockResolvedValue([student]);
    const invalid = z.object({ credit: z.number() }).safeParse({ credit: "secret-body" });
    if (invalid.success) throw new Error("Fixture must reject invalid credit.");
    const errors = [new WiseApiError(429, "secret-body", "https://private.invalid/?key=secret-key", 60000), invalid.error,
      new Error("secret-body https://private.invalid/?key=secret-key"), new DOMException("secret-body", "TimeoutError"), new DOMException("secret-body", "AbortError")];
    vi.mocked(fetchSessionCredits).mockImplementation(async (_client, _institute, classId) => { throw errors[Number(classId.slice(-1)) - 1]; });
    const client = fakeClient();
    vi.mocked(client.getStats).mockReturnValue({ requests: 42, byPath: { "/institutes/{id}/classes/{id}/students/{id}/sessionCredits": 42 } });
    const result = await runCreditControlSync(db, client, "institute-1", new Date("2026-09-11T00:00:00Z"), { syncRunId: "run-1", requireComplete: true });
    expect(result.success).toBe(false);
    expect(result.errorSummary).toContain("5 credit fetches failed");
    expect(events.some(event => event.table === schema.creditControlSnapshots)).toBe(false);
    const update = latestUpdate(events, "failed")!;
    const query = new PgDialect().sqlToQuery(update.setValue.metadata as Parameters<PgDialect["sqlToQuery"]>[0]);
    const metadata = JSON.parse(query.params[0] as string);
    expect(metadata.wiseCallCount).toBe(42);
    expect(metadata.wiseTopPaths).toEqual({ "/institutes/{id}/classes/{id}/students/{id}/sessionCredits": 42 });
    expect(metadata.failedCreditPairs).toBe(5);
    expect(metadata.failedPairs).toHaveLength(5);
    expect(metadata.failedPairs.map((row: { wiseClassId: string }) => row.wiseClassId).sort()).toEqual(student.classrooms.map(row => row._id).sort());
    expect(metadata.failedPairs.every((row: { wiseStudentId: string }) => row.wiseStudentId === student._id)).toBe(true);
    expect(metadata.failedPairs.find((row: { wiseClassId: string }) => row.wiseClassId === "class-1")).toMatchObject({ reason: "http", status: 429, retryAfterMs: 60000 });
    expect(metadata.failedPairs.find((row: { wiseClassId: string }) => row.wiseClassId === "class-2")).toMatchObject({ reason: "invalid_response", validationIssues: [{ code: "invalid_type", path: "credit" }] });
    expect(metadata.failedPairs.filter((row: { reason: string }) => row.reason === "aborted")).toHaveLength(2);
    expect(JSON.stringify(metadata)).not.toMatch(/secret-body|secret-key|private\.invalid/);
    expect(update.bounded).toBe(true);
  });

  it("records upstream Wise failure calls and cooldown without a raw URL or body", async () => {
    const { db, events } = makeDbMock();
    vi.mocked(fetchCreditStudents).mockRejectedValue(new WiseApiError(429, "secret-body", "https://private.invalid/?key=secret-key", 30000));
    const client = fakeClient();
    vi.mocked(client.getStats).mockReturnValue({ requests: 4, byPath: { "/institutes/{id}/students": 4 } });
    const result = await runCreditControlSync(db, client, "institute-1", new Date("2026-09-11T00:00:00Z"), { syncRunId: "run-1", requireComplete: true });
    expect(result.success).toBe(false);
    const update = latestUpdate(events, "failed")!;
    const query = new PgDialect().sqlToQuery(update.setValue.metadata as Parameters<PgDialect["sqlToQuery"]>[0]);
    const metadata = JSON.parse(query.params[0] as string);
    expect(metadata.wiseCallCount).toBe(4);
    expect(metadata.wiseFailure).toEqual({ status: 429, retryAfterMs: 30000 });
    expect(metadata).not.toHaveProperty("failedCreditPairs");
    expect(metadata).not.toHaveProperty("failedPairs");
    expect(JSON.stringify({ metadata, errorSummary: result.errorSummary })).not.toMatch(/secret-body|secret-key|private\.invalid/);
    expect(events.some(event => event.table === schema.creditControlSnapshots)).toBe(false);
  });

  it("captures fetched evidence only after promotion and tolerates unavailable analytics", async () => {
    const { db, events } = makeDbMock();
    vi.mocked(captureCreditControlWorkforceEvidence).mockImplementationOnce(async (_db, input) => {
      expect(events.some(event => event.type === "update" && event.table === schema.creditControlSnapshots)).toBe(true);
      expect(input.sessions).toHaveLength(101);
      expect(input.pairs[0].creditsObservedAt.toISOString()).toBe("2026-09-11T00:00:00.000Z");
      throw new Error("analytics unavailable");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runCreditControlSync(db, fakeClient(), "institute-1", new Date("2026-09-11T00:00:00Z"), { syncRunId: "run-1" });
    expect(result.success).toBe(true);
    expect(captureCreditControlWorkforceEvidence).toHaveBeenCalledTimes(1);
    log.mockRestore();
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
    expect(sessionInsertEvents.map((event) => event.rows.length)).toEqual([101]);
    expect(snapshotLinkIndex).toBeLessThan(events.indexOf(sessionInsertEvents[0]));
  });

  // REL-01: the promote is a single bounded UPDATE. Without a WHERE it
  // rewrote every credit_control_snapshots row on every sync.
  it("promotes the snapshot with a bounded UPDATE", async () => {
    const { db, events } = makeDbMock();

    await runCreditControlSync(
      db,
      fakeClient(),
      "institute-1",
      new Date("2026-05-26T08:00:00.000Z"),
      { syncRunId: "run-1" },
    );

    const promotion = events.find((event): event is UpdateEvent => (
      event.type === "update" &&
      event.table === schema.creditControlSnapshots
    ));

    expect(promotion).toBeDefined();
    expect(promotion?.bounded).toBe(true);
  });

  it("records the run's Wise call count in sync-run metadata", async () => {
    const { db, events } = makeDbMock();
    const client = {
      get: vi.fn(),
      getStats: vi.fn(() => ({
        requests: 42,
        byPath: { "/institutes/{id}/students": 2, "/institutes/{id}/sessions": 40 },
      })),
    } as unknown as WiseClient;

    await runCreditControlSync(
      db,
      client,
      "institute-1",
      new Date("2026-05-26T08:00:00.000Z"),
      { syncRunId: "run-1" },
    );

    expect(latestUpdate(events, "success")?.setValue.metadata).toMatchObject({
      wiseCallCount: 42,
      wiseTopPaths: { "/institutes/{id}/sessions": 40, "/institutes/{id}/students": 2 },
    });
  });

  it("persists the trimmed Wise session title, blank when Wise omits it", async () => {
    const [titled, untitled] = makeFutureSessions(2);
    titled.title = "  In-Person Session-Biology HL  ";
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => (
      status === "PAST" ? [] : [titled, untitled]
    ));
    const { db, events } = makeDbMock();

    await runCreditControlSync(
      db,
      fakeClient(),
      "institute-1",
      new Date("2026-05-26T08:00:00.000Z"),
      { syncRunId: "run-1" },
    );

    const sessionRows = events
      .filter((event): event is InsertEvent => (
        event.type === "insert" && event.table === schema.creditControlSessions
      ))
      .flatMap((event) => event.rows) as Array<{ wiseSessionId: string; title: string }>;

    expect(sessionRows.find((row) => row.wiseSessionId === titled._id)?.title)
      .toBe("In-Person Session-Biology HL");
    expect(sessionRows.find((row) => row.wiseSessionId === untitled._id)?.title).toBe("");
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
    // A full chunk plus one session requires a second chunk
    // exists for the failure to land in.
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => (
      status === "PAST" ? [] : makeFutureSessions(CREDIT_CONTROL_INSERT_CHUNK_SIZE + 1)
    ));
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

// ── CRED-01: dirty-pair reuse ───────────────────────────────────────────
//
// `fetchSessionCredits` is one Wise GET per (class, student) pair and was the
// single largest consumer of the institute's rate limit. These cover which
// pairs still cost a call and what a carried-forward pair writes.

const PRIOR_SNAPSHOT_ID = "snapshot-0";
const NOW = new Date("2026-05-26T08:00:00.000Z");
/** Two hours before NOW — inside the 180-minute default reuse window. */
const OBSERVED_AT = new Date("2026-05-26T06:00:00.000Z");

type PriorPackageRow = {
  wiseClassId: string;
  wiseStudentId: string;
  totalCredits: number;
  consumedCredits: number;
  remainingCredits: number;
  availableCredits: number;
  bookedSessions: number;
  excludedReason: string | null;
  creditsObservedAt: Date;
};

function priorPackage(overrides: Partial<PriorPackageRow> = {}): PriorPackageRow {
  return {
    wiseClassId: "class-1",
    wiseStudentId: "student-1",
    totalCredits: 20,
    consumedCredits: 4,
    remainingCredits: 16,
    availableCredits: 15,
    bookedSessions: 2,
    excludedReason: null,
    creditsObservedAt: OBSERVED_AT,
    ...overrides,
  };
}

function makePairStudents(options: { secondPackageName?: string; secondActivated?: boolean } = {}): WiseCreditStudent[] {
  return [
    {
      _id: "student-1",
      name: "Ada Lovelace",
      activated: true,
      parents: [{ name: "Parent Lovelace" }],
      classrooms: [{ _id: "class-1", name: "Math Package", subject: "Math", classType: "REGULAR" }],
    },
    {
      _id: "student-2",
      name: "Grace Hopper",
      activated: options.secondActivated ?? true,
      parents: [{ name: "Parent Hopper" }],
      classrooms: [{
        _id: "class-2",
        name: options.secondPackageName ?? "Physics Package",
        subject: "Physics",
        classType: "REGULAR",
      }],
    },
  ];
}

function makeSession(options: {
  id: string;
  classId: string;
  studentId: string;
  start: Date;
  meetingStatus?: string;
}): WiseCreditSession {
  return {
    _id: options.id,
    classId: { _id: options.classId, name: "Package", subject: "Subject", classType: "REGULAR" },
    scheduledStartTime: options.start,
    scheduledEndTime: new Date(options.start.getTime() + 60 * 60 * 1000),
    meetingStatus: options.meetingStatus ?? "UPCOMING",
    duration: 60 * 60 * 1000,
    students: [options.studentId],
  };
}

function priorSnapshotRows(
  packages: PriorPackageRow[],
  history: Array<Record<string, unknown>> = [],
  pendingSessions: Array<Record<string, unknown>> = [],
): Map<unknown, unknown[]> {
  return new Map<unknown, unknown[]>([
    [schema.creditControlSnapshots, [{ id: PRIOR_SNAPSHOT_ID }]],
    [schema.creditControlPackages, packages],
    [schema.creditControlSessions, pendingSessions],
    [schema.creditControlCreditHistory, history],
  ]);
}

function insertedRows<T>(events: DbEvent[], table: unknown): T[] {
  return events
    .filter((event): event is InsertEvent => event.type === "insert" && event.table === table)
    .flatMap((event) => event.rows) as T[];
}

function creditPairCalls(): Array<[string, string]> {
  return vi.mocked(fetchSessionCredits).mock.calls.map((call) => [call[2], call[3]] as [string, string]);
}

describe("runCreditControlSync — pair reuse (CRED-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchCreditStudents).mockResolvedValue(makePairStudents());
    vi.mocked(fetchCreditSessions).mockResolvedValue([]);
    vi.mocked(fetchSessionCredits).mockImplementation(async (_client, _institute, classId) => ({
      credits: {
        total: 10,
        consumed: 2,
        remaining: classId === "class-2" ? 3 : 8,
        available: 7,
        bookedSessions: 1,
      },
      sessionCreditHistory: [],
    }));
    vi.mocked(fetchSessionTeacherFeedback).mockResolvedValue("");
  });

  async function run(db: Database) {
    return runCreditControlSync(db, fakeClient(), "institute-1", NOW, { syncRunId: "run-1" });
  }

  it("carries a quiet pair's package row, history, and observation time forward", async () => {
    const { db, events } = makeDbMock({
      selectRows: priorSnapshotRows(
        [
          priorPackage(),
          // Low balance → always refetched, never carried.
          priorPackage({ wiseClassId: "class-2", wiseStudentId: "student-2", remainingCredits: 1 }),
        ],
        [{
          wiseCreditHistoryId: "history-1",
          wiseClassId: "class-1",
          wiseStudentId: "student-1",
          credit: 1.5,
          type: "SESSION",
          meetingStatus: "ENDED",
          durationMinutes: 90,
          createdAtWise: new Date("2026-05-20T03:00:00.000Z"),
          raw: { _id: "history-1", classroom: { subject: "Math" } },
        }],
      ),
    });

    await run(db);

    expect(creditPairCalls()).toEqual([["class-2", "student-2"]]);

    const packageRows = insertedRows<{
      wiseClassId: string;
      totalCredits: number;
      remainingCredits: number;
      creditsObservedAt: Date;
    }>(events, schema.creditControlPackages);
    const carried = packageRows.find((row) => row.wiseClassId === "class-1");
    const refetched = packageRows.find((row) => row.wiseClassId === "class-2");

    // The carried row keeps the PREVIOUS balance and the instant it was
    // observed — not zeros, and not "now".
    expect(carried).toMatchObject({ totalCredits: 20, remainingCredits: 16 });
    expect(carried?.creditsObservedAt).toEqual(OBSERVED_AT);
    expect(refetched).toMatchObject({ remainingCredits: 3 });
    expect(refetched?.creditsObservedAt).toEqual(NOW);

    // History is copied, not fabricated, and re-keyed to this run's package.
    const historyRows = insertedRows<Record<string, unknown>>(events, schema.creditControlCreditHistory);
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]).toMatchObject({
      snapshotId: "snapshot-1",
      wiseCreditHistoryId: "history-1",
      wiseClassId: "class-1",
      wiseStudentId: "student-1",
      packageKey: "Ada Lovelace|||Math Package",
      credit: 1.5,
      durationMinutes: 90,
      raw: { _id: "history-1", classroom: { subject: "Math" } },
    });

    expect(latestUpdate(events, "success")?.setValue.metadata).toMatchObject({
      pairsRefetched: 1,
      pairsReused: 1,
      pairsSkippedExcluded: 0,
    });
  });

  // SAFETY: the property the whole rule rests on. A balance a human would be
  // asked to act on is never served from the previous snapshot.
  it("SAFETY: always refetches a low-balance pair even when observed seconds ago", async () => {
    const justObserved = new Date(NOW.getTime() - 1_000);
    const { db } = makeDbMock({
      selectRows: priorSnapshotRows([
        priorPackage({ creditsObservedAt: justObserved }),
        priorPackage({
          wiseClassId: "class-2",
          wiseStudentId: "student-2",
          remainingCredits: 5,
          creditsObservedAt: justObserved,
        }),
      ]),
    });

    await run(db);

    expect(creditPairCalls()).toEqual([["class-2", "student-2"]]);
  });

  // Pending deductions are what the dashboard subtracts before deciding a
  // balance is low, so a comfortable raw balance can still be a hot pair.
  it("counts pending teacher-feedback deductions when testing the hot band", async () => {
    const { db } = makeDbMock({
      selectRows: priorSnapshotRows(
        [priorPackage({ remainingCredits: 8 })],
        [],
        // 3 x 90 minutes = 4.5 credits pending → adjusted 3.5, inside the band.
        Array.from({ length: 3 }, () => ({
          wiseClassId: "class-1",
          wiseStudentId: "student-1",
          durationMinutes: 90,
        })),
      ),
    });
    vi.mocked(fetchCreditStudents).mockResolvedValue([makePairStudents()[0]]);

    await run(db);

    expect(creditPairCalls()).toEqual([["class-1", "student-1"]]);
  });

  it("refetches a pair whose session ended since the balance was observed", async () => {
    const { db } = makeDbMock({
      selectRows: priorSnapshotRows([
        priorPackage(),
        priorPackage({ wiseClassId: "class-2", wiseStudentId: "student-2" }),
      ]),
    });
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _institute, status) => (
      status === "PAST"
        ? [makeSession({
          id: "past-1",
          classId: "class-1",
          studentId: "student-1",
          // Ends 06:30, after the 06:00 observation.
          start: new Date("2026-05-26T05:30:00.000Z"),
          meetingStatus: "ENDED",
        })]
        : []
    ));

    await run(db);

    expect(creditPairCalls()).toEqual([["class-1", "student-1"]]);
  });

  it("skips the Wise call for a package the prior snapshot marked excluded", async () => {
    vi.mocked(fetchCreditStudents).mockResolvedValue(makePairStudents({ secondPackageName: "Trial Package" }));
    const { db, events } = makeDbMock({
      selectRows: priorSnapshotRows([
        priorPackage(),
        priorPackage({
          wiseClassId: "class-2",
          wiseStudentId: "student-2",
          // Excluded pairs are skipped whatever their balance or age says.
          remainingCredits: 0,
          creditsObservedAt: new Date("2026-01-01T00:00:00.000Z"),
          excludedReason: "trial",
        }),
      ]),
    });

    await run(db);

    expect(creditPairCalls()).toEqual([]);

    const excluded = insertedRows<{ wiseClassId: string; excludedReason: string | null; remainingCredits: number }>(
      events,
      schema.creditControlPackages,
    ).find((row) => row.wiseClassId === "class-2");
    expect(excluded).toMatchObject({ excludedReason: "trial", remainingCredits: 0 });

    expect(latestUpdate(events, "success")?.setValue.metadata).toMatchObject({
      pairsRefetched: 0,
      pairsReused: 1,
      pairsSkippedExcluded: 1,
    });
  });

  it("refetches every pair when CREDIT_REFRESH_MAX_AGE_MINUTES is 0", async () => {
    const original = process.env.CREDIT_REFRESH_MAX_AGE_MINUTES;
    process.env.CREDIT_REFRESH_MAX_AGE_MINUTES = "0";
    vi.mocked(fetchCreditStudents).mockResolvedValue(makePairStudents({ secondPackageName: "Trial Package" }));

    try {
      const { db, events } = makeDbMock({
        selectRows: priorSnapshotRows([
          priorPackage(),
          priorPackage({ wiseClassId: "class-2", wiseStudentId: "student-2", excludedReason: "trial" }),
        ]),
      });

      await run(db);

      expect(creditPairCalls().sort()).toEqual([["class-1", "student-1"], ["class-2", "student-2"]]);
      expect(latestUpdate(events, "success")?.setValue.metadata).toMatchObject({
        pairsRefetched: 2,
        pairsReused: 0,
        pairsSkippedExcluded: 0,
      });
    } finally {
      if (original === undefined) delete process.env.CREDIT_REFRESH_MAX_AGE_MINUTES;
      else process.env.CREDIT_REFRESH_MAX_AGE_MINUTES = original;
    }
  });

  // A pair written with zeroed credits reads as a drained balance and puts a
  // family at the top of the follow-up queue, so every read failure refetches.
  it("refetches, never zeroes, when the prior snapshot cannot be read", async () => {
    const { db, events } = makeDbMock({
      selectRows: priorSnapshotRows([priorPackage()]),
      failSelectTables: [schema.creditControlPackages],
    });

    await run(db);

    expect(creditPairCalls().sort()).toEqual([["class-1", "student-1"], ["class-2", "student-2"]]);
    const packageRows = insertedRows<{ remainingCredits: number; totalCredits: number }>(
      events,
      schema.creditControlPackages,
    );
    expect(packageRows).toHaveLength(2);
    expect(packageRows.every((row) => row.totalCredits === 10)).toBe(true);
    expect(latestUpdate(events, "success")?.setValue.metadata).toMatchObject({
      pairsRefetched: 2,
      pairsReused: 0,
    });
  });

  it("refetches the carried pairs when their prior history cannot be read", async () => {
    const { db, events } = makeDbMock({
      selectRows: priorSnapshotRows([
        priorPackage(),
        priorPackage({ wiseClassId: "class-2", wiseStudentId: "student-2" }),
      ]),
      failSelectTables: [schema.creditControlCreditHistory],
    });

    await run(db);

    expect(creditPairCalls().sort()).toEqual([["class-1", "student-1"], ["class-2", "student-2"]]);
    expect(latestUpdate(events, "success")?.setValue.metadata).toMatchObject({
      pairsRefetched: 2,
      pairsReused: 0,
      pairsSkippedExcluded: 0,
    });
  });

  // The roster branch of collectPairs skips de-activated students; the session
  // branch deliberately does NOT. Measured 2026-09-04: 770 of 1,271 students in
  // the active snapshot are de-activated and 120 of those still have future
  // sessions, and credit_control_sessions is the only source for the parent
  // monthly schedule. Gating here would blank a parent-facing page to save a few
  // hundred Wise calls, so the asymmetry is intentional and pinned here.
  it("keeps de-activated students seen through the session feed, so their sessions survive", async () => {
    vi.mocked(fetchCreditStudents).mockResolvedValue(makePairStudents({ secondActivated: false }));
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _institute, status) => (
      status === "PAST"
        ? []
        : [makeSession({
          id: "future-1",
          classId: "class-2",
          studentId: "student-2",
          start: new Date("2026-05-27T03:00:00.000Z"),
        })]
    ));
    const { db, events } = makeDbMock();

    const result = await run(db);

    expect(creditPairCalls()).toEqual([
      ["class-1", "student-1"],
      ["class-2", "student-2"],
    ]);
    expect(result.packageCount).toBe(2);
    // The future session row survives — this is what the parent schedule reads.
    expect(insertedRows<unknown>(events, schema.creditControlSessions)).toHaveLength(1);
  });
});

describe('bounded current detail reads', () => {
 const now = new Date('2026-05-26T08:00:00Z'), at = new Date('2026-05-20T08:00:00Z');
 function fixture(count: number) {
  const students = Array.from({ length: count }, (_, i) => ({ ...makeStudent(), _id: `student-${i}`, name: `Student ${i}`, classrooms: [{ ...makeStudent().classrooms[0], _id: `class-${i}` }] }));
  const past = students.map((student, i) => ({ ...makeFutureSessions(1)[0], _id: `session-${i}`, classId: student.classrooms[0], students: [student._id], scheduledStartTime: at, scheduledEndTime: new Date(+at + 3600000), meetingStatus: 'ENDED' }));
  const retained = past.map((session, i) => ({ snapshotId: 'old-complete-source', wiseSessionId: session._id, wiseClassId: `class-${i}`, wiseStudentId: `student-${i}`, studentKey: `old-key-${i}`, packageKey: `old-package-${i}`, studentName: students[i].name, packageName: 'Math Package', subject: 'Math', title: 'Original lesson', scheduledStartTime: at, scheduledEndTime: session.scheduledEndTime, durationMinutes: 60, meetingStatus: 'ENDED', sessionKind: 'past', teacherFeedback: 'Original note', creditApplied: 1, wiseTeacherUserId: 'original-tutor', wiseTeacherId: null, teacherName: 'Original tutor' }));
  vi.mocked(fetchCreditStudents).mockResolvedValue(students);
  vi.mocked(fetchCreditSessions).mockImplementation(async (_c, _i, status) => status === 'PAST' ? past : []);
  vi.mocked(fetchSessionTeacherFeedback).mockResolvedValue('');
  vi.mocked(fetchSessionCredits).mockImplementation(async (_c, _i, classId) => ({ credits: { total: 10, consumed: 1, remaining: 9, available: 9, bookedSessions: 0 }, sessionCreditHistory: [{ _id: `history-${classId.slice(6)}`, credit: 1, type: 'SESSION', createdAt: at }] }));
  const { db, events } = makeDbMock({ selectRows: new Map<unknown, unknown[]>([[schema.creditControlSnapshots, [{ id: 'old-complete-source' }]], [schema.creditControlSessions, retained]]) });
  return { db, events, retained };
 }
 function detail(i: number, credit: number) {
  return { data: { _id: `session-${i}`, classId: `class-${i}`, attendanceRecorded: true, meetingStatus: 'ENDED', participants: [{ wiseUserId: 'peer', credits: 99 }, { wiseUserId: `student-${i}`, credits: credit }] } };
 }
 beforeEach(() => vi.clearAllMocks());
 it('bounds concurrent reads at 15 and preserves input order, exact student credits, and original rows', async () => {
  const { db, events, retained } = fixture(20), client = fakeClient();
  const pending = new Map<number, (response: unknown) => void>();
  let active = 0, peak = 0, attempts = 0;
  vi.mocked(client.get).mockImplementation(async (path) => {
   const i = Number(path.split('/').at(-1)!.slice(8)); attempts++; active++; peak = Math.max(peak, active);
   return await new Promise(resolve => pending.set(i, resolve)).finally(() => active--);
  });
  const run = runCreditControlSync(db, client, 'institute-1', now, { syncRunId: 'run-1', requireComplete: true });
  await vi.waitFor(() => expect(pending.size).toBe(15));
  expect(attempts).toBe(15);
  for (let i = 14; i >= 0; i--) pending.get(i)!(detail(i, i % 3 === 0 ? -1 : i % 3 === 1 ? 0 : .5));
  await vi.waitFor(() => expect(pending.size).toBe(20));
  for (let i = 19; i >= 15; i--) pending.get(i)!(detail(i, i % 3 === 0 ? -1 : i % 3 === 1 ? 0 : .5));
  expect((await run).success).toBe(true);
  expect(peak).toBe(15); expect(attempts).toBe(20); expect(active).toBe(0);
  const histories = insertedRows<{ wiseCreditHistoryId: string }>(events, schema.creditControlCreditHistory);
  expect(histories.map(row => row.wiseCreditHistoryId)).toEqual(Array.from({ length: 20 }, (_, i) => `history-${i}`));
  const sessions = insertedRows<{ wiseSessionId: string; creditApplied: number }>(events, schema.creditControlSessions);
  expect(sessions.map(row => row.creditApplied)).toEqual(Array.from({ length: 20 }, (_, i) => i % 3 === 2 ? .5 : 0));
  expect(retained.every(row => row.creditApplied === 1 && row.wiseTeacherUserId === 'original-tutor')).toBe(true);
 });
 it.each(['failure', 'abort', 'wrong student'])('waits for in-flight reads and refuses all data insertion and promotion on %s', async kind => {
  const { db, events } = fixture(2), client = fakeClient(), controller = new AbortController();
  let attempts = 0, settled = false, release!: () => void;
  vi.mocked(client.get).mockImplementation(async (path) => {
   attempts++;
   if (path.endsWith('session-0')) {
    if (kind === 'abort') { controller.abort(new Error('Deadline reached')); throw controller.signal.reason; }
    if (kind === 'wrong student') return { data: { ...detail(0, 1).data, participants: [{ wiseUserId: 'peer', credits: 99 }] } };
    throw new WiseApiError(503, 'PRIVATE', 'PRIVATE', 500);
   }
   await new Promise<void>(resolve => { release = resolve; }); return detail(1, .5);
  });
  vi.mocked(client.getStats).mockImplementation(() => ({ requests: attempts, byPath: { '/detail': attempts } }));
  const run = runCreditControlSync(db, client, 'institute-1', now, { syncRunId: 'run-1', requireComplete: true, signal: controller.signal }).then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(attempts).toBe(2));
  await Promise.resolve(); expect(settled).toBe(false); release();
  expect((await run).success).toBe(false);
  const update = latestUpdate(events, 'failed')!;
  const query = new PgDialect().sqlToQuery(update.setValue.metadata as Parameters<PgDialect['sqlToQuery']>[0]);
  expect(JSON.parse(query.params[0] as string)).toMatchObject({ wiseCallCount: 2 });
  expect(insertedRows(events, schema.creditControlSessions)).toHaveLength(0);
  expect(insertedRows(events, schema.creditControlCreditHistory)).toHaveLength(0);
  expect(events.some(event => event.type === 'update' && event.table === schema.creditControlSnapshots)).toBe(false);
 });
});

describe('snapshot original credit evidence preservation',()=>{
 const now=new Date('2026-05-26T08:00:00Z'),at=new Date('2026-05-20T08:00:00Z');
 const raw={_id:'old-session',createdAt:'2026-05-20T09:01:02.345Z',duration:3600000,type:'SESSION',classroom:{_id:'class-1'},credit:1};
 const anchor={snapshotId:'old-complete-source',wiseSessionId:'old-session',wiseClassId:'class-1',wiseStudentId:'student-1',raw};
 const past={...makeFutureSessions(1)[0],_id:'old-session',scheduledStartTime:at,scheduledEndTime:new Date(+at+3600000),meetingStatus:'ENDED'};
 const retained={id:'old-row',snapshotId:'old-complete-source',createdAt:at,wiseSessionId:'old-session',wiseClassId:'class-1',wiseStudentId:'student-1',studentKey:'prior-key',packageKey:'prior-package',studentName:'Prior name',packageName:'Prior package',subject:'Math',title:'Original lesson',scheduledStartTime:at,scheduledEndTime:past.scheduledEndTime,durationMinutes:60,meetingStatus:'ENDED',sessionKind:'past',teacherFeedback:'Verified note',creditApplied:1,wiseTeacherUserId:'original-tutor',wiseTeacherId:null,teacherName:'Original tutor'};
 beforeEach(()=>{
  vi.clearAllMocks();vi.mocked(fetchCreditStudents).mockResolvedValue([makeStudent()]);
  vi.mocked(fetchCreditSessions).mockImplementation(async(_c,_i,status)=>status==='PAST'?[past]:[]);
  vi.mocked(fetchSessionTeacherFeedback).mockResolvedValue('');
 });
 function history(credit:number,direct=false){vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:10,consumed:credit,remaining:10-credit,available:10-credit,bookedSessions:0},sessionCreditHistory:[{...raw,_id:direct?'old-session':'renamed-history',createdAt:new Date(raw.createdAt),credit}]});}
 function fixture(anchors:unknown[]=[anchor],keep=true){return makeDbMock({anchorRows:anchors,selectRows:new Map<unknown,unknown[]>([[schema.creditControlSnapshots,[{id:'old-complete-source'}]],[schema.creditControlSessions,keep?[retained]:[]]])});}
 const rows=(events:DbEvent[],table:unknown)=>events.filter((event):event is InsertEvent=>event.type==='insert'&&event.table===table).flatMap(event=>event.rows) as Record<string,unknown>[];
 it.each([1,0,-1,.5])('uses exact current renamed credit %s and keeps history raw IDs unchanged',async credit=>{
  history(credit);const {db,events}=fixture();const result=await runCreditControlSync(db,fakeClient(),'institute-1',now,{syncRunId:'run-1',requireComplete:true});
  expect(result.success).toBe(true);expect(rows(events,schema.creditControlSessions)[0].creditApplied).toBe(Math.max(0,credit));
  const saved=rows(events,schema.creditControlCreditHistory);expect(saved).toHaveLength(1);expect(saved[0].wiseCreditHistoryId).toBe('renamed-history');expect((saved[0].raw as Record<string,unknown>)._id).toBe('renamed-history');
  expect((rows(events,schema.creditControlSnapshots)[0].metadata as Record<string,unknown>).creditAnchorSnapshotIds).toEqual(['old-complete-source']);
  expect(retained.creditApplied).toBe(1);
 });
 it('keeps direct current zero before any renamed positive credit',async()=>{
  history(0,true);const value=await vi.mocked(fetchSessionCredits).getMockImplementation()!({} as never,'','','');
  vi.mocked(fetchSessionCredits).mockResolvedValue({...value,sessionCreditHistory:[...value.sessionCreditHistory,{...raw,_id:'renamed-history',createdAt:new Date(raw.createdAt),credit:1}]});
  const {db,events}=fixture();expect((await runCreditControlSync(db,fakeClient(),'institute-1',now,{syncRunId:'run-1',requireComplete:true})).success).toBe(true);
  expect(rows(events,schema.creditControlSessions)[0].creditApplied).toBe(0);
 });
 it.each([1,0])('preserves a feed-absent prior row with current credit %s and original tutor evidence',async credit=>{
  history(credit);vi.mocked(fetchCreditSessions).mockResolvedValue([]);const {db,events}=fixture();
  expect((await runCreditControlSync(db,fakeClient(),'institute-1',now,{syncRunId:'run-1',requireComplete:true})).success).toBe(true);
  const saved=rows(events,schema.creditControlSessions);expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({wiseSessionId:'old-session',creditApplied:credit,wiseTeacherUserId:'original-tutor',teacherFeedback:'Verified note',studentName:'Ada Lovelace'});expect(saved[0]).not.toHaveProperty('id');expect(saved[0]).not.toHaveProperty('createdAt');
 });
 it('restores a prior zero-credit row when current exact credit becomes positive',async()=>{
  history(1);vi.mocked(fetchCreditSessions).mockResolvedValue([]);
  const {db,events}=makeDbMock({anchorRows:[anchor],selectRows:new Map<unknown,unknown[]>([[schema.creditControlSnapshots,[{id:'old-complete-source'}]],[schema.creditControlSessions,[{...retained,creditApplied:0}]]])});
  expect((await runCreditControlSync(db,fakeClient(),'institute-1',now,{syncRunId:'run-1',requireComplete:true})).success).toBe(true);expect(rows(events,schema.creditControlSessions)[0].creditApplied).toBe(1);
 });
 it('uses exact current detail for ambiguity and stops promotion if detail fails',async()=>{
  history(1);const value=await vi.mocked(fetchSessionCredits).getMockImplementation()!({} as never,'','','');
  vi.mocked(fetchSessionCredits).mockResolvedValue({...value,sessionCreditHistory:[...value.sessionCreditHistory,{...raw,_id:'duplicate',createdAt:new Date(raw.createdAt),credit:1}]});
  const client=fakeClient();vi.mocked(client.get).mockRejectedValue(new Error('Exact current detail failed'));
  const {db,events}=fixture();const result=await runCreditControlSync(db,client,'institute-1',now,{syncRunId:'run-1',requireComplete:true});
  expect(result.success).toBe(false);expect(events.some(e=>e.type==='update'&&e.table===schema.creditControlSnapshots)).toBe(false);
 });
 it('uses the named student detail when the original history is missing',async()=>{
  history(1);vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:10,consumed:1,remaining:9,available:9,bookedSessions:0},sessionCreditHistory:[]});
  const client=fakeClient();vi.mocked(client.get).mockResolvedValue({data:{_id:'old-session',classId:'class-1',attendanceRecorded:true,meetingStatus:'ENDED',participants:[{wiseUserId:'peer',credits:4},{wiseUserId:'student-1',credits:.5}]}});
  const {db,events}=fixture([]);expect((await runCreditControlSync(db,client,'institute-1',now,{syncRunId:'run-1',requireComplete:true})).success).toBe(true);expect(rows(events,schema.creditControlSessions)[0].creditApplied).toBe(.5);
 });
 it('does not borrow an original anchor from another student',async()=>{
  history(1);const {db,events}=fixture([{...anchor,wiseStudentId:'peer'}],false);
  expect((await runCreditControlSync(db,fakeClient(),'institute-1',now,{syncRunId:'run-1',requireComplete:true})).success).toBe(true);expect(rows(events,schema.creditControlSessions)[0].creditApplied).toBe(0);
 });
 it('stops before candidate creation when original evidence cannot be read',async()=>{
  history(1);const {db,events}=makeDbMock({anchorReadError:true});expect((await runCreditControlSync(db,fakeClient(),'institute-1',now,{syncRunId:'run-1',requireComplete:true})).success).toBe(false);expect(rows(events,schema.creditControlSnapshots)).toHaveLength(0);
 });
});


describe("bounded snapshot persistence", () => {
  function rows(events: DbEvent[], table: unknown): Record<string, unknown>[] {
    return events.flatMap(event => event.type === "insert" && event.table === table ? event.rows as Record<string, unknown>[] : []);
  }
  function prepare(count: number) {
    vi.mocked(fetchCreditStudents).mockResolvedValue([makeStudent()]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => status === "PAST" ? [] : makeFutureSessions(count));
    vi.mocked(fetchSessionCredits).mockResolvedValue({ credits: { total: 20, consumed: 0, remaining: 20, available: 20, bookedSessions: 0 }, sessionCreditHistory: [] });
    vi.mocked(fetchSessionTeacherFeedback).mockResolvedValue("");
  }
  it("bounds simultaneous writes, retains every row, and waits before promotion", async () => {
    prepare(14_001);
    let pending = 0, peak = 0;
    const release: Array<() => void> = [];
    const { db, events } = makeDbMock({ insertWait: async (table) => {
      if (table !== schema.creditControlSessions) return [];
      pending++; peak = Math.max(peak, pending);
      if (release.length < 6) await new Promise<void>(resolve => release.push(resolve));
      pending--; return [];
    } });
    const result = runCreditControlSync(db, fakeClient(), "institute-1", new Date(), { syncRunId: "run-1" });
    await vi.waitFor(() => expect(release).toHaveLength(6));
    expect(latestUpdate(events, "success")).toBeUndefined();
    expect(events.some(e => e.type === "update" && e.table === schema.creditControlSnapshots)).toBe(false);
    release.toReversed().forEach(resolve => resolve());
    expect((await result).success).toBe(true);
    expect(peak).toBe(6);
    expect(pending).toBe(0);
    const actual = rows(events, schema.creditControlSessions);
    expect(actual).toHaveLength(14_001);
    expect(new Set(actual.map(row => row.wiseSessionId)).size).toBe(14_001);
    expect(events.filter((e): e is InsertEvent => e.type === "insert" && e.table === schema.creditControlSessions).every(e => e.rows.length <= 2_000)).toBe(true);
  });
  it.each(["failure", "abort"])("settles active writes after %s and retains the old active snapshot", async kind => {
    prepare(14_001);
    const controller = new AbortController();
    const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const { db, events } = makeDbMock({ insertWait: async (table) => {
      if (table !== schema.creditControlSessions) return [];
      await new Promise<void>((resolve, reject) => pending.push({ resolve, reject })); return [];
    } });
    let finished = false;
    const promise = runCreditControlSync(db, fakeClient(), "institute-1", new Date(), { syncRunId: "run-1", signal: controller.signal }).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(pending).toHaveLength(6));
    if (kind === "failure") pending[1].reject(new Error("write failed"));
    else { controller.abort(new Error("expired")); pending[1].resolve(); }
    await vi.waitFor(() => expect(events.filter(e => e.type === "insert" && e.table === schema.creditControlSessions)).toHaveLength(6));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    pending.forEach((entry, index) => { if (index !== 1) entry.resolve(); });
    expect((await promise).success).toBe(false);
    expect(events.some(e => e.type === "update" && e.table === schema.creditControlSnapshots)).toBe(false);
    expect(latestUpdate(events, "failed")).toBeDefined();
  });
  it("uses the bounded writer only for child rows and preserves the base database for status and promotion", async () => {
    prepare(2_001);
    const base = makeDbMock(), writer = makeDbMock();
    expect((await runCreditControlSync(base.db, fakeClient(), "institute-1", new Date(), { syncRunId: "run-1", writeDb: writer.db })).success).toBe(true);
    expect(rows(writer.events, schema.creditControlSessions)).toHaveLength(2_001);
    expect(rows(base.events, schema.creditControlSessions)).toHaveLength(0);
    expect(latestUpdate(base.events, "success")).toBeDefined();
    expect(writer.events.every(e => e.type === "insert")).toBe(true);
  });
  it("gives scoped HTTP writes an abort signal without changing the shared client", () => {
    const priorUrl = process.env.DATABASE_URL, priorDb = globalThis.__bgscheduler_db;
    try {
      process.env.DATABASE_URL = "postgresql://test:test@example.invalid/test";
      globalThis.__bgscheduler_db = undefined;
      const base = getDb(), signal = new AbortController().signal;
      expect(getDb({ signal })).not.toBe(base);
      expect(vi.mocked(neon)).toHaveBeenLastCalledWith(process.env.DATABASE_URL, { fetchOptions: { signal } });
      expect(getDb()).toBe(base);
    } finally { if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl; globalThis.__bgscheduler_db = priorDb; }
  });
});


describe("explicit persistence deadline", () => {
  function prepare() {
    vi.mocked(fetchCreditStudents).mockResolvedValue([makeStudent()]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => status === "PAST" ? [] : makeFutureSessions(2_001));
    vi.mocked(fetchSessionCredits).mockResolvedValue({ credits: { total: 20, consumed: 0, remaining: 20, available: 20, bookedSessions: 0 }, sessionCreditHistory: [] });
  }
  it.each([false, true])("requires validated source before writes and an unexpired persistence deadline: expired=%s", async expired => {
    prepare();
    const source = new AbortController(), persistence = new AbortController();
    const { db, events } = makeDbMock({ insertWait: async () => {
      source.abort(new Error("source budget expired after validation"));
      if (expired) persistence.abort(new Error("persistence budget expired"));
      return [];
    } });
    const result = await runCreditControlSync(db, fakeClient(), "institute-1", new Date(), { syncRunId: "run-1", signal: source.signal, persistenceSignal: persistence.signal });
    expect(result.success).toBe(!expired);
    expect(events.some(e => e.type === "update" && e.table === schema.creditControlSnapshots)).toBe(!expired);
    expect(latestUpdate(events, expired ? "failed" : "success")).toBeDefined();
  });
  it("keeps all deadlines relative to request start and uses a separate bounded write client", async () => {
    const dbModule = await import("@/lib/db"), syncModule = await import("@/lib/credit-control/sync"), clientModule = await import("@/lib/wise/client");
    const requestModule = await import("@/lib/credit-control/run-sync-request");
    const oldMode = process.env.CREDIT_CONTROL_MODE, oldSitIns = process.env.TUTOR_SIT_INS_ENABLED;
    const start = new Date("2026-10-10T06:00:00Z"), signals: AbortSignal[] = [];
    vi.useFakeTimers(); vi.setSystemTime(start);
    try {
      process.env.CREDIT_CONTROL_MODE = "retired"; process.env.TUTOR_SIT_INS_ENABLED = "true";
      const base = {
        update: () => ({ set: () => ({ where: () => ({ returning: async () => { vi.setSystemTime(new Date(+start + 5_000)); return []; } }) }) }),
        select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
        insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: "run-1" }] }) }) }),
      } as unknown as Database;
      const writer = makeDbMock().db;
      const getDbSpy = vi.spyOn(dbModule, "getDb").mockImplementation(options => options?.signal ? writer : base);
      vi.spyOn(clientModule, "createWiseClient").mockReturnValue(fakeClient());
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const signal = new AbortController().signal; signals.push(signal); return signal; });
      const run = vi.spyOn(syncModule, "runCreditControlSync").mockResolvedValue({ success: true, snapshotId: "snapshot-1", promotedSnapshotId: "snapshot-1", studentCount: 1, packageCount: 1, sessionCount: 1, failedCreditPairs: 0 });
      expect((await requestModule.runCreditControlSyncRequest({ triggerSource: "admin" })).status).toBe(200);
      expect(timeout.mock.calls.map(call => call[0])).toEqual([755_000, 775_000, 770_000]);
      expect(getDbSpy.mock.calls[1][0]?.signal).toBe(signals[1]);
      expect(run.mock.calls[0][0]).toBe(base);
      expect(run.mock.calls[0][4]).toMatchObject({ signal: signals[0], persistenceSignal: signals[2], writeDb: writer, requireComplete: true });
    } finally {
      vi.restoreAllMocks(); vi.useRealTimers();
      if (oldMode === undefined) delete process.env.CREDIT_CONTROL_MODE; else process.env.CREDIT_CONTROL_MODE = oldMode;
      if (oldSitIns === undefined) delete process.env.TUTOR_SIT_INS_ENABLED; else process.env.TUTOR_SIT_INS_ENABLED = oldSitIns;
    }
  });
  it("propagates the scoped signal to the installed Neon HTTP request", async () => {
    const actual = await vi.importActual<typeof import("@neondatabase/serverless")>("@neondatabase/serverless");
    const original = actual.neonConfig.fetchFunction, controller = new AbortController();
    let received: AbortSignal | null = null;
    try {
      actual.neonConfig.fetchFunction = (async (_url: unknown, init: RequestInit) => {
        received = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => received!.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
      }) as typeof original;
      const client = actual.neon("postgresql://test:test@example.invalid/test", { fetchOptions: { signal: controller.signal } });
      const promise = client.query("select 1").then(() => null, error => error);
      await vi.waitFor(() => expect(received).toBe(controller.signal));
      controller.abort(new Error("bounded HTTP abort"));
      expect(String(await promise)).toContain("bounded HTTP abort");
    } finally { actual.neonConfig.fetchFunction = original; }
  });
});
