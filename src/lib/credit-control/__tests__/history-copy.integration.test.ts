import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseClient } from "@/lib/wise/client";
import { buildStudentPackageKey } from "@/lib/credit-control/helpers";
import { CREDIT_CONTROL_INSERT_CHUNK_SIZE, runCreditControlSync } from "../sync";
import {
  fetchCreditSessions, fetchCreditStudents, fetchSessionCredits, fetchSessionTeacherFeedback,
  type WiseCreditSession, type WiseCreditStudent,
} from "../wise";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("../wise", async (importOriginal) => ({
  ...await importOriginal<typeof import("../wise")>(),
  fetchCreditStudents: vi.fn(), fetchCreditSessions: vi.fn(),
  fetchSessionCredits: vi.fn(), fetchSessionTeacherFeedback: vi.fn(),
}));

const NOW = new Date("2026-10-01T06:00:00Z");
const OBSERVED_AT = new Date("2026-10-01T04:00:00Z");
const PAST_START = new Date("2026-09-29T09:00:00Z");
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
let queries: Array<{ query: string; params: unknown[] }>;

const client = {
  get: vi.fn(), getStats: () => ({ requests: 0, byPath: {} }),
} as unknown as WiseClient;

beforeAll(async () => {
  handle = await startTestDb();
  db = drizzle(handle.pool, { schema, logger: {
    logQuery(query, params) { queries.push({ query, params }); },
  } }) as unknown as Database;
});
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await handle.db.execute(sql`DROP FUNCTION IF EXISTS cc_test_copy_failure() CASCADE`);
  await handle.db.execute(sql`TRUNCATE credit_control_snapshots, credit_control_sync_runs CASCADE`);
  queries = [];
  vi.clearAllMocks();
  vi.stubEnv("CREDIT_CONTROL_MODE", "retired");
  vi.stubEnv("CREDIT_REFRESH_MAX_AGE_MINUTES", "180");
  vi.mocked(fetchCreditStudents).mockResolvedValue([]);
  vi.mocked(fetchCreditSessions).mockResolvedValue([]);
  vi.mocked(fetchSessionCredits).mockResolvedValue({
    credits: { total: 20, consumed: 2, remaining: 18, available: 17, bookedSessions: 1 },
    sessionCreditHistory: [],
  });
  vi.mocked(fetchSessionTeacherFeedback).mockResolvedValue("Fresh review");
});
afterEach(() => vi.unstubAllEnvs());

function student(id: string, classes: Array<{ id: string; name: string }>, activated = true): WiseCreditStudent {
  return { _id: id, name: `Renamed ${id}`, activated, parents: [{ name: `Parent ${id}` }],
    classrooms: classes.map(row => ({ _id: row.id, name: row.name, subject: "Math", classType: "REGULAR" })) };
}
function session(id: string, classId: string, studentId: string, future = false): WiseCreditSession {
  const start = future ? new Date("2026-10-02T09:00:00Z") : PAST_START;
  return { _id: id, classId: { _id: classId, name: `Package ${classId}`, subject: "Math", classType: "REGULAR" },
    scheduledStartTime: start, scheduledEndTime: new Date(start.getTime() + 3_600_000),
    duration: 3_600_000, meetingStatus: future ? "UPCOMING" : "ENDED", students: [studentId] };
}
async function priorSnapshot(pairs: Array<{ classId: string; studentId: string; remaining?: number; excluded?: boolean }>) {
  const [snapshot] = await handle.db.insert(schema.creditControlSnapshots).values({ active: true, generatedAt: OBSERVED_AT }).returning();
  await handle.db.insert(schema.creditControlSyncRuns).values({ status: "success", snapshotId: snapshot.id, promotedSnapshotId: snapshot.id });
  const packages = pairs.map(row => ({ snapshotId: snapshot.id, wiseClassId: row.classId, wiseStudentId: row.studentId,
    studentKey: `Old ${row.studentId}`, packageKey: `Old ${row.classId}`, studentName: `Old ${row.studentId}`, packageName: `Old ${row.classId}`,
    totalCredits: 20, consumedCredits: 4, remainingCredits: row.remaining ?? 16, availableCredits: 15, bookedSessions: 2,
    excludedReason: row.excluded ? "trial" : null,
    creditsObservedAt: row.excluded ? new Date("2026-01-01T00:00:00Z") : OBSERVED_AT }));
  for (let offset = 0; offset < packages.length; offset += 500) {
    await handle.db.insert(schema.creditControlPackages).values(packages.slice(offset, offset + 500));
  }
  return snapshot.id;
}
function history(snapshotId: string, classId: string, studentId: string, id: string, credit: number,
  raw: Record<string, unknown> = { synthetic: id }) {
  return { snapshotId, wiseClassId: classId, wiseStudentId: studentId, wiseCreditHistoryId: id,
    packageKey: `Old ${classId}`, credit, type: credit > 0 ? "SESSION" : null,
    meetingStatus: "ENDED", durationMinutes: 90, createdAtWise: PAST_START, raw };
}
async function ledger(snapshotId: string) {
  const h = schema.creditControlCreditHistory;
  const rows = await handle.db.select({
    wiseClassId: h.wiseClassId, wiseStudentId: h.wiseStudentId, wiseCreditHistoryId: h.wiseCreditHistoryId,
    packageKey: h.packageKey, credit: h.credit, type: h.type, meetingStatus: h.meetingStatus,
    durationMinutes: h.durationMinutes, createdAtWise: h.createdAtWise, raw: h.raw,
  }).from(h).where(eq(h.snapshotId, snapshotId));
  return rows.sort((a, b) => `${a.wiseStudentId}:${a.wiseClassId}:${a.wiseCreditHistoryId}`.localeCompare(`${b.wiseStudentId}:${b.wiseClassId}:${b.wiseCreditHistoryId}`));
}
function copyQueries() { return queries.filter(row => /WITH copied AS/.test(row.query)); }
function historyReads() { return queries.filter(row => /^select .* from "credit_control_credit_history"/.test(row.query)); }

// These tests run only against the disposable Postgres created by db-helper.
describe("Credit Control carried-history copy", () => {
  it("preserves mixed financial ledgers, fresh keys, feedback calls, and deactivated-student schedules", async () => {
    const priorId = await priorSnapshot([
      { classId: "quiet", studentId: "a" }, { classId: "hot", studentId: "a", remaining: 1 },
      { classId: "trial", studentId: "a", remaining: 0, excluded: true },
      { classId: "quiet-b", studentId: "b" }, { classId: "unselected", studentId: "other" },
    ]);
    const priorRows = [
      history(priorId, "quiet", "a", "paid-quiet", 1.5, { nested: { note: "untouched" }, list: [0, -1, null] }),
      history(priorId, "quiet", "a", "zero-quiet", 0), history(priorId, "quiet", "a", "negative-quiet", -1.25),
      history(priorId, "trial", "a", "paid-trial", 2), history(priorId, "quiet-b", "b", "old-b", 4),
      history(priorId, "hot", "a", "obsolete-hot", 777), history(priorId, "unselected", "other", "unselected", 9),
    ];
    await handle.db.insert(schema.creditControlCreditHistory).values(priorRows);
    const before = await ledger(priorId);
    vi.mocked(fetchCreditStudents).mockResolvedValue([
      student("a", [{ id: "quiet", name: "Renamed Math" }, { id: "hot", name: "Physics" }, { id: "trial", name: "Trial Package" }]),
      student("b", [], false),
    ]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client, _institute, status) => status === "PAST"
      ? [session("paid-quiet", "quiet", "a"), session("zero-quiet", "quiet", "a"), session("negative-quiet", "quiet", "a"),
        session("paid-hot", "hot", "a"), session("paid-trial", "trial", "a")]
      : [session("future-b", "quiet-b", "b", true)]);
    vi.mocked(fetchSessionCredits).mockResolvedValue({
      credits: { total: 20, consumed: 2, remaining: 18, available: 17, bookedSessions: 1 },
      sessionCreditHistory: [{ _id: "paid-hot", credit: 2, type: "SESSION", meetingStatus: "ENDED",
        duration: 3_600_000, createdAt: PAST_START, synthetic: "fresh" }],
    });

    const result = await runCreditControlSync(db, client, "synthetic-institute", NOW);
    expect(result).toMatchObject({ success: true, studentCount: 2, packageCount: 4, sessionCount: 6, failedCreditPairs: 0 });
    expect(vi.mocked(fetchSessionCredits).mock.calls.map(call => [call[2], call[3]])).toEqual([["hot", "a"]]);
    expect(vi.mocked(fetchSessionTeacherFeedback).mock.calls.map(call => call[2]).sort()).toEqual(["negative-quiet", "zero-quiet"]);

    const after = await ledger(result.snapshotId!);
    const expectedCarried = before.filter(row => ["quiet", "trial", "quiet-b"].includes(row.wiseClassId)).map(row => ({
      ...row, packageKey: buildStudentPackageKey(`Renamed ${row.wiseStudentId}`,
        row.wiseClassId === "quiet" ? "Renamed Math" : row.wiseClassId === "trial" ? "Trial Package" : "Package quiet-b"),
    }));
    expect(after.filter(row => row.wiseClassId !== "hot")).toEqual(expectedCarried);
    expect(after.filter(row => row.wiseClassId === "hot")).toEqual([{
      wiseClassId: "hot", wiseStudentId: "a", wiseCreditHistoryId: "paid-hot", packageKey: "Renamed a|||Physics",
      credit: 2, type: "SESSION", meetingStatus: "ENDED", durationMinutes: 60, createdAtWise: PAST_START,
      raw: { _id: "paid-hot", credit: 2, type: "SESSION", meetingStatus: "ENDED", duration: 3_600_000,
        createdAt: PAST_START.toISOString(), synthetic: "fresh" },
    }]);
    expect(await ledger(priorId)).toEqual(before);

    const packages = await handle.db.select().from(schema.creditControlPackages).where(eq(schema.creditControlPackages.snapshotId, result.snapshotId!));
    expect(packages.find(row => row.wiseClassId === "quiet")).toMatchObject({ remainingCredits: 16, creditsObservedAt: OBSERVED_AT });
    expect(packages.find(row => row.wiseClassId === "hot")).toMatchObject({ remainingCredits: 18, creditsObservedAt: NOW });
    expect(packages.find(row => row.wiseClassId === "trial")).toMatchObject({ remainingCredits: 0, creditsObservedAt: new Date("2026-01-01T00:00:00Z") });
    const sessions = await handle.db.select().from(schema.creditControlSessions).where(eq(schema.creditControlSessions.snapshotId, result.snapshotId!));
    expect(sessions.find(row => row.wiseSessionId === "paid-quiet")).toMatchObject({ creditApplied: 1.5, teacherFeedback: "" });
    expect(sessions.find(row => row.wiseSessionId === "negative-quiet")).toMatchObject({ creditApplied: 0, teacherFeedback: "Fresh review" });
    expect(sessions.find(row => row.wiseSessionId === "future-b")).toMatchObject({ wiseStudentId: "b", sessionKind: "future" });
    const [run] = await handle.db.select().from(schema.creditControlSyncRuns).where(eq(schema.creditControlSyncRuns.promotedSnapshotId, result.snapshotId!));
    expect(run.metadata).toMatchObject({ creditHistoryRows: 6, pairsRefetched: 1, pairsReused: 2, pairsSkippedExcluded: 1 });
  });

  it("copies 2,401 full history rows with two database requests and no raw-payload parameters", async () => {
    const priorId = await priorSnapshot([{ classId: "quiet", studentId: "a" }]);
    const marker = "synthetic-ledger-payload";
    const rows = Array.from({ length: 2401 }, (_, index) => history(priorId, "quiet", "a", `history-${index}`, index % 3 - 1,
      { marker, padding: marker.repeat(200), index }));
    for (let offset = 0; offset < rows.length; offset += 500) {
      await handle.db.insert(schema.creditControlCreditHistory).values(rows.slice(offset, offset + 500));
    }
    vi.mocked(fetchCreditStudents).mockResolvedValue([student("a", [{ id: "quiet", name: "Renamed Math" }])]);
    queries = [];

    const result = await runCreditControlSync(db, client, "synthetic-institute", NOW);
    expect(result.success).toBe(true);
    expect(historyReads()).toHaveLength(1);
    expect(historyReads()[0].query).not.toMatch(/"raw"|"duration_minutes"|"created_at_wise"/);
    expect(copyQueries()).toHaveLength(1);
    expect(queries.filter(row => row.query.includes("credit_control_credit_history"))).toHaveLength(2);
    expect(JSON.stringify(queries.flatMap(row => row.params))).not.toContain(marker);
    expect(fetchSessionCredits).not.toHaveBeenCalled();
    expect(await ledger(result.snapshotId!)).toEqual((await ledger(priorId)).map(row => ({ ...row, packageKey: "Renamed a|||Renamed Math" })));
    const [run] = await handle.db.select().from(schema.creditControlSyncRuns).where(eq(schema.creditControlSyncRuns.promotedSnapshotId, result.snapshotId!));
    expect(run.metadata.creditHistoryRows).toBe(rows.length);
    // Previously: one full-history read plus five 500-row inserts = six requests.
    expect(1 + Math.ceil(rows.length / CREDIT_CONTROL_INSERT_CHUNK_SIZE)).toBe(6);
  });

  it("reuses an empty ledger without an additional copy request", async () => {
    await priorSnapshot([{ classId: "quiet", studentId: "a" }]);
    vi.mocked(fetchCreditStudents).mockResolvedValue([student("a", [{ id: "quiet", name: "Math" }])]);
    queries = [];
    const result = await runCreditControlSync(db, client, "synthetic-institute", NOW);
    expect(result.success).toBe(true);
    expect(historyReads()).toHaveLength(1);
    expect(copyQueries()).toHaveLength(0);
    expect(fetchSessionCredits).not.toHaveBeenCalled();
    const [run] = await handle.db.select().from(schema.creditControlSyncRuns).where(eq(schema.creditControlSyncRuns.promotedSnapshotId, result.snapshotId!));
    expect(run.metadata).toMatchObject({ creditHistoryRows: 0, pairsReused: 1 });
  });

  it("keeps the prior snapshot active when the second 400-pair copy fails", async () => {
    const pairs = Array.from({ length: 401 }, (_, index) => ({ classId: `class-${index}`, studentId: `student-${index}` }));
    const priorId = await priorSnapshot(pairs);
    await handle.db.insert(schema.creditControlCreditHistory).values(pairs.map(row => history(priorId, row.classId, row.studentId, `history-${row.studentId}`, 1)));
    vi.mocked(fetchCreditStudents).mockResolvedValue(pairs.map(row => student(row.studentId, [{ id: row.classId, name: "Math" }])));
    await handle.db.execute(sql`
      CREATE FUNCTION cc_test_copy_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.wise_student_id = 'student-400' THEN
          RAISE EXCEPTION 'synthetic history-copy failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$
    `);
    await handle.db.execute(sql`CREATE TRIGGER cc_test_copy_failure BEFORE INSERT ON credit_control_credit_history
      FOR EACH ROW EXECUTE FUNCTION cc_test_copy_failure()`);
    queries = [];

    const result = await runCreditControlSync(db, client, "synthetic-institute", NOW);
    expect(result.success).toBe(false);
    expect(result.errorSummary).toContain("pair chunk 2 (1 pairs)");
    expect(result.errorSummary).toContain("P0001");
    expect(copyQueries()).toHaveLength(2);
    expect(copyQueries().map(row => row.params.length)).toEqual([1202, 5]);
    expect((await handle.db.select().from(schema.creditControlSnapshots).where(eq(schema.creditControlSnapshots.active, true))).map(row => row.id)).toEqual([priorId]);
    expect(await ledger(priorId)).toHaveLength(401);
    expect(await ledger(result.snapshotId!)).toHaveLength(400);
    const [run] = await handle.db.select().from(schema.creditControlSyncRuns).where(eq(schema.creditControlSyncRuns.snapshotId, result.snapshotId!));
    expect(run).toMatchObject({ status: "failed", promotedSnapshotId: null, snapshotId: result.snapshotId });
  });

  it("does not promote a copied candidate after the caller aborts", async () => {
    const priorId = await priorSnapshot([{ classId: "quiet", studentId: "a" }]);
    await handle.db.insert(schema.creditControlCreditHistory).values(history(priorId, "quiet", "a", "paid", 1));
    vi.mocked(fetchCreditStudents).mockResolvedValue([student("a", [{ id: "quiet", name: "Math" }])]);
    const controller = new AbortController();
    const abortingDb = drizzle(handle.pool, { schema, logger: {
      logQuery(query) {
        if (/WITH copied AS/.test(query)) controller.abort(new Error("Synthetic refresh deadline exceeded"));
      },
    } }) as unknown as Database;
    const result = await runCreditControlSync(abortingDb, client, "synthetic-institute", NOW, { signal: controller.signal, requireComplete: true });
    expect(result.success).toBe(false);
    expect(result.errorSummary).toContain("Synthetic refresh deadline exceeded");
    expect((await handle.db.select().from(schema.creditControlSnapshots).where(eq(schema.creditControlSnapshots.active, true))).map(row => row.id)).toEqual([priorId]);
    expect(await ledger(result.snapshotId!)).toHaveLength(1);
  });
});
