import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { allocateDueLeaveWork, reconcileLeaveWork } from "../work-reconcile";
import { assertLeaveAdmin, countDueLeaveAssignments, hydrateAssignments, LeaveWorkConflict, mutateLeaveWork, setWorkState } from "../work-data";
import { familyComplete } from "../work-model";
import { LEAVE_ROSTER_PEOPLE, parseRosterMonth } from "../roster";
import { importLeaveSourceRows, recoverAbandonedLeaveRuns } from "../sync";
import { processLeaveNormalizations } from "../processing";
import { parseLeaveRequestSheetRows } from "../parser";
import type { LeaveInterpretation } from "../work-types";
import { LeaveNormalizationUnavailable } from "../normalization";
import september from "./fixtures/september-roster.json";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
let creditId: string;
const today = "2026-09-08";
const care = LEAVE_ROSTER_PEOPLE.find((p) => p.key === "care")!;
const palm = LEAVE_ROSTER_PEOPLE.find((p) => p.key === "palm")!;
const baseInterpretation: LeaveInterpretation = { disposition: "active", windows: [{ startDate: "2026-09-06", endDate: "2026-10-03", startMinute: 0, endMinute: 1440 }], completion: [], errors: [], explanation: "Full-day leave." };

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await db.execute(sql`truncate leave_requests, leave_assignments, leave_roster_people, leave_work_state, leave_request_sync_runs, credit_control_snapshots, snapshots, admin_users, line_contacts cascade`);
  await db.insert(s.adminUsers).values(LEAVE_ROSTER_PEOPLE.map((p) => ({ email: p.email, name: p.name })));
  await db.insert(s.leaveRosterPeople).values(LEAVE_ROSTER_PEOPLE);
  await db.insert(s.leaveRosterShifts).values(parseRosterMonth(september).map((r) => ({ ...r, fetchedAt: new Date(`${today}T03:00:00Z`) })));
  await setWorkState(db, "roster", { readAt: `${today}T03:00:00Z` });
  const [snap] = await db.insert(s.snapshots).values({ active: true }).returning();
  const [group] = await db.insert(s.tutorIdentityGroups).values({ snapshotId: snap.id, canonicalKey: "buzz", displayName: "Buzz" }).returning();
  await db.insert(s.tutorIdentityGroupMembers).values({ snapshotId: snap.id, groupId: group.id, wiseTeacherId: "wise-teacher", wiseUserId: "wise-teacher-user", wiseDisplayName: "Buzz" });
  const [credit] = await db.insert(s.creditControlSnapshots).values({ active: true }).returning();
  creditId = credit?.id ?? (await db.select().from(s.creditControlSnapshots))[0].id;
});

async function source(row: number, interpretation = baseInterpretation) {
  const [request] = await db.insert(s.leaveRequests).values({ spreadsheetId: "test", sheetName: "Form Responses 1", sourceRowNumber: row, sourceFingerprint: `row-${row}`, currentNormalizationKey: `key-${row}`, tutorName: "Buzz", tutorCanonicalKey: "buzz", tutorDisplayName: "Buzz", matchConfidence: "name", startDate: "2026-09-06", endDate: "2026-10-03", sourceSheetStatus: interpretation.completion[0]?.evidence ?? null }).returning();
  await db.insert(s.leaveNormalizations).values({ requestId: request.id, inputKey: `key-${row}`, input: {}, model: "gpt-6-astra", promptVersion: "test", status: "ok", result: interpretation });
  return request;
}

async function session(id: string, date = "2026-09-15", students = [{ key: "s1", parent: "Parent A" }], status = "UPCOMING", startHourUtc = "03") {
  for (const student of students) {
    await db.insert(s.creditControlStudents).values({ snapshotId: creditId, wiseStudentId: student.key, studentKey: student.key, studentName: student.key, parentName: student.parent }).onConflictDoNothing();
    await db.insert(s.creditControlSessions).values({ snapshotId: creditId, wiseSessionId: id, wiseClassId: `class-${id}`, wiseStudentId: student.key, studentKey: student.key, packageKey: `package-${student.key}`, studentName: student.key, packageName: "Maths", subject: "Maths", title: "Maths class", scheduledStartTime: new Date(`${date}T${startHourUtc}:00:00Z`), scheduledEndTime: new Date(`${date}T${String(Number(startHourUtc) + 1).padStart(2, "0")}:00:00Z`), meetingStatus: status, sessionKind: "future", wiseTeacherId: "wise-teacher" });
  }
}
const board = async () => hydrateAssignments(db, await db.select().from(s.leaveAssignments));
async function check(kind: "class" | "family", actor = care, checked = true) {
  const [a] = await board(); const task = kind === "class" ? a.classes[0] : a.families[0];
  return mutateLeaveWork(db, a.id, { kind, entityId: task.id, expectedVersion: task.version, checked, mutationKey: randomUUID() }, actor);
}

describe("durable daily leave work", () => {
  it("shares one cancellation across duplicates, siblings and multiple families; allocates once using the real roster", async () => {
    await source(2); await source(3);
    await session("group", "2026-09-15", [{ key: "s1", parent: "Parent A" }, { key: "s2", parent: "Parent A" }, { key: "s3", parent: "Parent B" }]);
    await reconcileLeaveWork(db, today);
    expect(await countDueLeaveAssignments(db, "2026-09-07")).toEqual({ total: 0, overdue: 0 });
    expect(await countDueLeaveAssignments(db, today)).toEqual({ total: 1, overdue: 0 });
    expect(await allocateDueLeaveWork(db, today)).toBe(1);
    let [a] = await board();
    expect(a.families).toHaveLength(2); expect(a.classes).toHaveLength(1); expect(a.sourceRequestIds).toHaveLength(2);
    expect(a.ownerName).toBe("Aya"); // Care off and Muk sick are never candidates.
    await db.update(s.leaveRosterShifts).set({ status: "sick" }).where(eq(s.leaveRosterShifts.personKey, "aya"));
    expect(await allocateDueLeaveWork(db, today)).toBe(0);
    await mutateLeaveWork(db, a.id, { kind: "owner", entityId: a.id, expectedVersion: a.version, mutationKey: randomUUID(), ownerEmail: palm.email }, palm);
    [a] = await board(); expect(a.ownerEmail).toBe(palm.email);
  });

  it("returns a conflict for concurrent takeovers and preserves both independently checked tasks", async () => {
    await source(2); await session("class"); await reconcileLeaveWork(db, today);
    const [a] = await board();
    const results = await Promise.allSettled([care, palm].map((actor) => mutateLeaveWork(db, a.id, { kind: "owner", entityId: a.id, expectedVersion: a.version, mutationKey: randomUUID(), ownerEmail: actor.email }, actor)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: expect.any(LeaveWorkConflict) });
    const family = a.families[0], c = a.classes[0];
    await Promise.all([
      mutateLeaveWork(db, a.id, { kind: "family", entityId: family.id, expectedVersion: family.version, mutationKey: randomUUID(), checked: true }, care),
      mutateLeaveWork(db, a.id, { kind: "class", entityId: c.id, expectedVersion: c.version, mutationKey: randomUUID(), checked: true }, palm),
    ]);
    expect((await board())[0].done).toBe(true);
    await check("family", care, false); expect((await board())[0].done).toBe(false);
    expect((await board())[0].classes[0].cancelled?.actorEmail).toBe(palm.email);
  });

  it("rejects stale checkoffs, replays idempotent requests, and retains undo over repeated syncs", async () => {
    await source(2); await session("class"); await reconcileLeaveWork(db, today);
    const [a] = await board(); const family = a.families[0];
    const mutation = { kind: "family" as const, entityId: family.id, expectedVersion: family.version, mutationKey: randomUUID(), checked: true };
    await mutateLeaveWork(db, a.id, mutation, care);
    expect(await mutateLeaveWork(db, a.id, mutation, care)).toMatchObject({ replayed: true });
    await expect(mutateLeaveWork(db, a.id, { ...mutation, mutationKey: randomUUID() }, palm)).rejects.toBeInstanceOf(LeaveWorkConflict);
    await check("family", care, false);
    await reconcileLeaveWork(db, today); await reconcileLeaveWork(db, today);
    expect((await board())[0].families[0].informed).toBeNull();
  });

  it("preserves owners and progress over snapshot rotation, and reopens changed classes only", async () => {
    await source(2); await session("class-a"); await session("class-b", "2026-09-15", [{ key: "s2", parent: "Parent B" }]); await reconcileLeaveWork(db, today); await allocateDueLeaveWork(db, today);
    const [a] = await board();
    for (const family of a.families) await mutateLeaveWork(db, a.id, { kind: "family", entityId: family.id, expectedVersion: family.version, mutationKey: randomUUID(), checked: true }, care);
    await check("class");
    await db.update(s.creditControlSnapshots).set({ active: false });
    const [next] = await db.insert(s.creditControlSnapshots).values({ active: true }).returning(); creditId = next.id;
    await session("class-a"); await session("class-b", "2026-09-15", [{ key: "s2", parent: "Parent B" }], "UPCOMING", "05");
    await reconcileLeaveWork(db, today);
    const [b] = await board(); expect(b.ownerEmail).toBe(a.ownerEmail);
    expect(familyComplete(b.families.find((f) => f.label === "Parent A")!)).toBe(true);
    expect(familyComplete(b.families.find((f) => f.label === "Parent B")!)).toBe(false);
    expect(b.classes.find((c) => c.wiseSessionId === "class-a")?.cancelled?.actorEmail).toBe(care.email);
  });

  it("keeps disappearing unfinished classes and separates explicit Wise cancellation from notification", async () => {
    await source(2); await session("class", "2026-09-15", undefined, "CANCELLED"); await reconcileLeaveWork(db, today);
    let [a] = await board(); expect(a.classes[0].cancelled?.source).toBe("wise"); expect(a.families[0].informed).toBeNull(); expect(a.done).toBe(false);
    await db.update(s.creditControlSessions).set({ meetingStatus: "UPCOMING" }); await reconcileLeaveWork(db, today);
    await db.delete(s.creditControlSessions); await reconcileLeaveWork(db, today);
    [a] = await board(); expect(a.classes[0].active).toBe(true); expect(a.classes[0].cancelled).toBeNull(); expect(a.issue).toContain("missing");
  });

  it("moves a class between dates without leaving duplicate family work or losing its owner", async () => {
    await source(2); await session("moving"); await session("staying", "2026-09-15", [{ key: "s2", parent: "Parent B" }]);
    await reconcileLeaveWork(db, today); await allocateDueLeaveWork(db, today);
    const [before] = await board();
    await db.update(s.creditControlSessions).set({ scheduledStartTime: new Date("2026-09-16T03:00Z"), scheduledEndTime: new Date("2026-09-16T04:00Z") }).where(eq(s.creditControlSessions.wiseSessionId, "moving"));
    await reconcileLeaveWork(db, today); await reconcileLeaveWork(db, today);
    const rows = await board();
    const oldDate = rows.find((r) => r.classDate === "2026-09-15")!;
    const newDate = rows.find((r) => r.classDate === "2026-09-16")!;
    expect(newDate.ownerEmail).toBe(before.ownerEmail);
    expect(newDate.classes.map((c) => c.wiseSessionId)).toEqual(["moving"]);
    expect(oldDate.classes.map((c) => c.wiseSessionId)).toEqual(["staying"]);
    expect(oldDate.families.filter((f) => f.active).map((f) => f.label)).toEqual(["Parent B"]);
    expect(newDate.families.filter((f) => f.active).map((f) => f.label)).toEqual(["Parent A"]);
  });

  it("imports date-specific completion without invented timestamps and never applies it to later added classes", async () => {
    await source(2, { ...baseInterpretation, completion: [{ dates: ["2026-09-11"], parentsInformed: true, classesCancelled: true, actorLabel: "Care", evidence: "11 Sep done // Care" }] });
    await session("done", "2026-09-11"); await session("open", "2026-09-12"); await reconcileLeaveWork(db, today);
    let rows = await board(); expect(rows.find((r) => r.classDate === "2026-09-11")?.done).toBe(true); expect(rows.find((r) => r.classDate === "2026-09-12")?.done).toBe(false);
    expect(rows.find((r) => r.classDate === "2026-09-11")?.families[0].informed?.completedAt).toBeNull();
    await session("added", "2026-09-11", [{ key: "s2", parent: "Other parent" }]); await reconcileLeaveWork(db, today);
    rows = await board(); expect(rows.find((r) => r.classDate === "2026-09-11")?.done).toBe(false);
    expect(rows.find((r) => r.classDate === "2026-09-11")?.families.find((f) => f.label === "Other parent")?.informed).toBeNull();
  });

  it("leaves work unassigned when the month is missing; only authorized admins may take it", async () => {
    await source(2); await session("class", "2026-10-03"); await reconcileLeaveWork(db, today);
    expect(await allocateDueLeaveWork(db, "2026-09-26")).toBe(0);
    const [a] = await board(); expect(a.ownerEmail).toBeNull();
    await db.insert(s.adminUsers).values({ email: "restricted@example.com", allowedPages: ["/progress-tests"] });
    await expect(assertLeaveAdmin(db, "restricted@example.com")).rejects.toThrow("access");
  });

  it("preserves undone imported checkoffs and frozen evidence when catch-up resumes halfway", async () => {
    await source(2, { ...baseInterpretation, completion: [{ dates: [], parentsInformed: true, classesCancelled: true, actorLabel: "Care", evidence: "Done // Care" }] });
    await session("original"); await reconcileLeaveWork(db, today);
    await check("family", care, false); await check("class", care, false);
    // Simulate a kill before the normalization's final evidence checkpoint.
    await db.update(s.leaveNormalizations).set({ evidenceAppliedAt: null });
    await db.execute(sql`delete from leave_work_state where key like 'bundle:%'`);
    await session("new-after-checkpoint", "2026-09-15", [{ key: "new", parent: "New family" }]);
    await reconcileLeaveWork(db, today);
    const [a] = await board();
    expect(a.classes.every((c) => c.cancelled === null)).toBe(true);
    expect(a.families.every((f) => f.informed === null)).toBe(true);
  });
});

describe("sync recovery and resumable normalization", () => {
  it("recovers the July stalled run while preserving the single-flight constraint", async () => {
    const [old] = await db.insert(s.leaveRequestSyncRuns).values({ triggerType: "cron", startedAt: new Date("2026-07-27T10:15:07.679Z") }).returning();
    expect(await recoverAbandonedLeaveRuns(db, new Date(`${today}T03:00:00Z`))).toEqual([{ id: old.id }]);
    await db.insert(s.leaveRequestSyncRuns).values({ triggerType: "manual" });
    await expect(db.insert(s.leaveRequestSyncRuns).values({ triggerType: "cron" })).rejects.toThrow();
    expect(await recoverAbandonedLeaveRuns(db)).toHaveLength(0);
  });

  it("imports all 78 missing rows in batches and resumes normalization without rebuilding unchanged source rows", async () => {
    const [run] = await db.insert(s.leaveRequestSyncRuns).values({ triggerType: "manual" }).returning();
    const parsed = parseLeaveRequestSheetRows([[], ...Array.from({ length: 78 }, (_, i) => [46273 + i / 86400, "Buzz", "buzz@example.com", 46280, 46280, "Full Day"]) ]);
    const matcher = { snapshotId: null, match: () => ({ tutorGroupId: null, tutorCanonicalKey: "buzz", tutorDisplayName: "Buzz", matchConfidence: "name" as const, matchReason: "fixture" }) };
    expect((await importLeaveSourceRows(db, parsed, matcher, run.id)).inserted).toHaveLength(78);
    expect((await importLeaveSourceRows(db, parsed, matcher, run.id)).updated).toHaveLength(0);
    const normalize = async () => baseInterpretation;
    expect(await processLeaveNormalizations(db, { budgetMs: 0, normalize })).toMatchObject({ processed: 0, remaining: 78 });
    expect(await processLeaveNormalizations(db, { budgetMs: 30_000, normalize })).toMatchObject({ processed: 78, remaining: 0 });
    expect(await processLeaveNormalizations(db, { normalize: async () => { throw new Error("must use cache"); } })).toMatchObject({ processed: 0, failed: 0 });
  });

  it("stops on a service outage, preserves pending work, and retries failures after restoration", async () => {
    const [run] = await db.insert(s.leaveRequestSyncRuns).values({ triggerType: "manual" }).returning();
    const parsed = parseLeaveRequestSheetRows([[], ...Array.from({ length: 6 }, (_, i) => [46273 + i / 86400, "Buzz", "buzz@example.com", 46280, 46280, "Full Day"])]);
    const matcher = { snapshotId: null, match: () => ({ tutorGroupId: null, tutorCanonicalKey: "buzz", tutorDisplayName: "Buzz", matchConfidence: "name" as const, matchReason: "fixture" }) };
    await importLeaveSourceRows(db, parsed, matcher, run.id);
    expect(await processLeaveNormalizations(db, { normalize: async () => { throw new LeaveNormalizationUnavailable("API credits exhausted"); } })).toMatchObject({ failed: 3, remaining: 3, serviceError: "API credits exhausted" });
    expect(await processLeaveNormalizations(db, { normalize: async () => baseInterpretation, retryFailures: true })).toMatchObject({ processed: 6, failed: 0, remaining: 0 });
  });
});
