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
} = {}): { db: Database; events: DbEvent[] } {
  const events: DbEvent[] = [];
  const snapshotId = options.snapshotId ?? "snapshot-1";
  let sessionChunkIndex = 0;

  const db = {
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

        return Promise.resolve([]);
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

  // 500 rows x 22 columns on credit_control_sessions is ~11k bind parameters,
  // well inside the 65,535 Postgres allows, so the ceiling stays safe.
  it("uses 500-row chunks for credit-control inserts", () => {
    expect(CREDIT_CONTROL_INSERT_CHUNK_SIZE).toBe(500);
    expect(CREDIT_CONTROL_INSERT_CHUNK_SIZE * 22).toBeLessThan(65_535);
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
    // 501 sessions spill past the 500-row chunk ceiling, so a second chunk
    // exists for the failure to land in.
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _instituteId, status) => (
      status === "PAST" ? [] : makeFutureSessions(501)
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
