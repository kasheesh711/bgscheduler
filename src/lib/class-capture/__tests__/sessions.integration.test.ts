import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import * as s from "@/lib/db/schema";
import type { Database } from "@/lib/db";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
import { getDb } from "@/lib/db";
import { listCaptureSessions } from "../sessions";

let handle: Awaited<ReturnType<typeof startTestDb>>;
const scope = { email: "tutor@example.test", keys: ["Tutor"] };
const now = new Date("2026-10-03T03:15:00Z");
const start = new Date("2026-10-03T02:00:00Z"), end = new Date("2026-10-03T03:00:00Z");
beforeAll(async () => { handle = await startTestDb(); vi.mocked(getDb).mockReturnValue(handle.db as unknown as Database); });
afterAll(async () => { if (handle) await stopTestDb(handle); });
afterEach(() => vi.useRealTimers());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const db = handle.db;
  await db.execute(sql`TRUNCATE snapshots, credit_control_snapshots, post_class_sessions CASCADE`);
  const [snapshot] = await db.insert(s.snapshots).values({ active: true, createdAt: now }).returning();
  const [credit] = await db.insert(s.creditControlSnapshots).values({ active: true, generatedAt: now, source: "wise" }).returning();
  const [group] = await db.insert(s.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: "Tutor", displayName: "Tutor", supportedModality: "onsite" }).returning();
  await db.insert(s.tutorIdentityGroupMembers).values({ snapshotId: snapshot.id, groupId: group.id, wiseTeacherId: "membership", wiseUserId: "user", wiseDisplayName: "Tutor" });
  const student = { snapshotId: credit.id, wiseStudentId: "student", studentKey: "student", studentName: "Synthetic pupil" };
  await db.insert(s.creditControlStudents).values(student);
  await db.insert(s.creditControlPackages).values({ ...student, wiseClassId: "class", packageKey: "package", packageName: "Maths", classType: "ONE_TO_ONE" });
  await db.insert(s.creditControlSessions).values({ ...student, wiseClassId: "class", packageKey: "package", packageName: "Maths", wiseSessionId: "session", wiseTeacherUserId: "user", wiseTeacherId: null, title: "On-site Session - Math", scheduledStartTime: start, scheduledEndTime: end, meetingStatus: "UPCOMING", sessionKind: "future" });
  const [completed] = await db.insert(s.postClassSessions).values({ wiseSessionId: "session", wiseClassId: "class", canonicalTutorKey: "Tutor", wiseTeacherUserId: "user", scheduledStartAt: start, scheduledEndAt: end, deadlineAt: end, finalStatus: "ENDED", sourceStatus: "ready", lastObservedAt: now }).returning();
  await db.insert(s.postClassSessionParticipants).values({ sessionId: completed.id, participantKey: "student", wiseStudentId: "student", studentName: "Synthetic pupil" });
});

describe("completed-class handoff against Postgres", () => {
  it("shows a verified ended class while the fresh student snapshot still says upcoming and omits membership ID", async () => {
    expect((await listCaptureSessions(scope, "2026-10-03")).map(row => row.sessionId)).toEqual(["session"]);
  });
  it.each([
    { finalStatus: "CANCELLED" }, { sourceStatus: "unavailable" as const }, { wiseDeletedAt: now },
    { canonicalTutorKey: "Other" }, { wiseTeacherUserId: "other-user" }, { wiseClassId: "other-class" },
    { scheduledStartAt: new Date("2026-10-03T01:00:00Z") }, { scheduledEndAt: new Date("2026-10-03T02:30:00Z") },
    { lastObservedAt: new Date("2026-10-02T20:00:00Z") }, { lastObservedAt: new Date("2026-10-04T03:00:00Z") },
  ])("rejects incomplete, stale or conflicting completion evidence: %j", async patch => {
    await handle.db.update(s.postClassSessions).set(patch);
    expect(await listCaptureSessions(scope, "2026-10-03")).toEqual([]);
  });
  it("rejects a different student or a second participant", async () => {
    await handle.db.update(s.postClassSessionParticipants).set({ wiseStudentId: "other-student" });
    expect(await listCaptureSessions(scope, "2026-10-03")).toEqual([]);
    const [row] = await handle.db.select().from(s.postClassSessions);
    await handle.db.insert(s.postClassSessionParticipants).values({ sessionId: row.id, participantKey: "second", wiseStudentId: "student", studentName: "Second" });
    expect(await listCaptureSessions(scope, "2026-10-03")).toEqual([]);
  });
});
