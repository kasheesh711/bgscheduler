import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db";
import { assertCaptureSessionCurrent, listCaptureSessions, loadPriorFeedback, requireCaptureSession, type CaptureScope } from "../sessions";
import type { CaptureSession } from "../model";

const now = new Date("2026-10-01T04:30:00Z");
const scope = { email: "tutor@example.test", keys: ["Tutor Example"] };
const identity = {
  groupId: "group-one", canonicalKey: "Tutor Example", displayName: "Tutor Example",
  wiseTeacherId: "teacher-one", wiseUserId: "user-one", isOnlineVariant: false, supportedModality: "onsite",
};
const future = {
  groupId: "group-one", wiseTeacherId: "teacher-one", wiseTeacherUserId: "user-one",
  wiseSessionId: "session-one", wiseClassId: "class-one", studentIds: ["student-one"], studentCount: 1,
  resolvedStudentName: "Synthetic Student", studentName: "Year 9 Mathematics", classType: "ONE_TO_ONE",
  startTime: new Date("2026-10-01T10:00:00Z"), endTime: new Date("2026-10-01T12:00:00Z"),
  wiseStatus: "IN_PROGRESS", sessionType: "OFFLINE", title: "In-Person Session-Mathematics", sourceRowCount: 1,
};
const ended = {
  wiseSessionId: "ended-one", wiseClassId: "class-one", wiseStudentId: "student-one",
  wiseTeacherId: "teacher-one", wiseTeacherUserId: "user-one", studentName: "Synthetic Student",
  title: "In-Person Session-Mathematics", classType: "ONE_TO_ONE", sessionKind: "past", meetingStatus: "ENDED",
  scheduledStartTime: new Date("2026-10-01T01:00:00Z"), scheduledEndTime: new Date("2026-10-01T02:00:00Z"),
  sourceRowCount: 1,
};
const saved: CaptureSession = {
  sessionId: "session-one", classId: "class-one", studentId: "student-one", studentName: "Synthetic Student",
  teacherKey: "Tutor Example", teacherName: "Tutor Example", title: "In-Person Session-Mathematics",
  startTime: "2026-10-01T03:00:00.000Z", endTime: "2026-10-01T05:00:00.000Z", wiseUrl: "https://learn.begiftededucation.com/",
};
const prior = {
  wiseSessionId: "prior-one", wiseClassId: "class-one", canonicalTutorKey: "Tutor Example", wiseStudentId: "student-one",
  scheduledEndAt: new Date("2026-09-30T03:00:00Z"), sourceStatus: "ready", finalStatus: "ENDED", wiseDeletedAt: null,
  participantCount: 1, profile: "teacher", topics: "Linear equations", performance: "Explained one worked example",
  improvement: "Check signs", homework: "Two practice problems",
};

type Query = { table: string; sql: string; params: unknown[]; limit?: number };
function database(patch: Record<string, unknown[]> = {}) {
  const rows: Record<string, unknown[]> = {
    snapshots: [{ id: "identity-snapshot", createdAt: new Date("2026-10-01T04:00:00Z") }],
    credit_control_snapshots: [{ id: "credit-snapshot", generatedAt: new Date("2026-10-01T04:00:00Z"), source: "wise" }],
    tutor_identity_group_members: [identity], future_session_blocks: [future], credit_control_sessions: [],
    post_class_sessions: [prior], ...patch,
  };
  const queries: Query[] = [];
  const db = { select: () => {
    const query: Query = { table: "", sql: "", params: [] };
    let result: unknown[] = [];
    const chain = {
      from: (table: Parameters<typeof getTableName>[0]) => {
        query.table = getTableName(table); result = rows[query.table] ?? []; queries.push(query); return chain;
      },
      where: (filter: SQL) => { Object.assign(query, new PgDialect().sqlToQuery(filter)); return chain; },
      innerJoin: () => chain, leftJoin: () => chain, orderBy: () => chain,
      limit: (limit: number) => { query.limit = limit; return chain; },
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result.slice(0, query.limit)).then(resolve),
    };
    return chain;
  } };
  vi.mocked(getDb).mockReturnValue(db as never);
  return queries;
}

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("authorized class selection", () => {
  it("lists ongoing and future onsite sessions from authoritative tutor snapshot rosters", async () => {
    const queries = database({
      future_session_blocks: [future, { ...future, wiseSessionId: "future-two", wiseStatus: "UPCOMING", startTime: new Date("2026-10-01T14:00:00Z"), endTime: new Date("2026-10-01T15:00:00Z") }],
      // Daily shared snapshots may be older: names are display-only, never roster grants.
      credit_control_snapshots: [{ id: "credit-snapshot", generatedAt: new Date("2026-10-01T00:00:00Z"), source: "wise" }],
    });
    const sessions = await listCaptureSessions(scope, "2026-10-01");
    expect(sessions.map(session => session.sessionId)).toEqual(["session-one", "future-two"]);
    expect(sessions[0]).toMatchObject({ studentId: "student-one", studentName: "Synthetic Student", teacherKey: "Tutor Example", startTime: "2026-10-01T03:00:00.000Z", endTime: "2026-10-01T05:00:00.000Z" });
    expect(sessions[0].wiseUrl).toContain("classId=class-one");
    const query = queries.find(query => query.table === "future_session_blocks")!;
    expect(query.params).toEqual(expect.arrayContaining(["identity-snapshot", "user-one"]));
    expect(query.sql).toContain('"future_session_blocks"."snapshot_id"');
    expect(queries.some(query => query.table === "credit_control_sessions")).toBe(false);
  });

  it("includes fresh recent ended sessions and keeps student/session IDs exact", async () => {
    database({ credit_control_sessions: [ended] });
    expect((await listCaptureSessions(scope, "2026-10-01")).map(session => session.sessionId)).toEqual(["ended-one", "session-one"]);
    await expect(requireCaptureSession(scope, "ended-one", "student-one")).resolves.toMatchObject({ sessionId: "ended-one", studentId: "student-one" });
    await expect(requireCaptureSession(scope, "ended-one", "student-other")).rejects.toMatchObject({ status: 404 });
  });

  it("requires a refresh for recent ended selection when the shared snapshot is stale", async () => {
    database({ future_session_blocks: [], credit_control_snapshots: [{ id: "credit-snapshot", generatedAt: new Date("2026-10-01T00:00:00Z"), source: "wise" }] });
    await expect(listCaptureSessions(scope, "2026-10-01")).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    { snapshots: [] },
    { snapshots: [{ id: "old", createdAt: new Date("2026-10-01T00:00:00Z") }] },
    { snapshots: [{ id: "future", createdAt: new Date("2026-10-02T04:00:00Z") }] },
    { snapshots: [{ id: "one", createdAt: now }, { id: "two", createdAt: now }] },
  ])("fails closed for absent, stale, future or ambiguous identity snapshots", async patch => {
    database(patch);
    await expect(listCaptureSessions(scope, "2026-10-01")).rejects.toMatchObject({ status: 503 });
  });

  it.each(["", "2026-02-30", "2026-09-23", "2026-09-30", "2026-10-02", "2026-10-03", "10/01/2026"])("rejects every date except today in Bangkok before reading data: %s", async date => {
    database();
    await expect(listCaptureSessions(scope, date)).rejects.toMatchObject({ status: 400 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    { studentIds: null }, { studentIds: [] }, { studentIds: ["student-one", "student-two"] },
    { studentIds: [""] }, { studentCount: 2 }, { classType: "GROUP" }, { classType: null },
    { sessionType: "SCHEDULED" }, { sessionType: null }, { title: "Online Session-Mathematics" },
    { wiseStatus: "CANCELLED" }, { wiseStatus: "CANCELED" }, { wiseStatus: "UNKNOWN" },
    { wiseTeacherUserId: null }, { wiseTeacherUserId: "unknown-user" }, { wiseTeacherId: "conflicting-teacher" },
    { groupId: "conflicting-group" }, { wiseClassId: null }, { sourceRowCount: 2 }, { knownDeleted: true },
    { endTime: new Date("2026-10-01T09:00:00Z") },
  ])("excludes incomplete, ambiguous, online or cancelled future sessions: %j", async patch => {
    database({ future_session_blocks: [{ ...future, ...patch }] });
    await expect(listCaptureSessions(scope, "2026-10-01")).resolves.toEqual([]);
  });

  it.each([
    { canonicalKey: "Other Tutor" }, { isOnlineVariant: true }, { supportedModality: "unresolved" },
  ])("does not grant a session through a similar teacher identity: %j", async patch => {
    database({ tutor_identity_group_members: [{ ...identity, ...patch }] });
    await expect(listCaptureSessions(scope, "2026-10-01")).resolves.toEqual([]);
  });

  it("rejects an account mapped to multiple canonical tutors even when one matches the caller", async () => {
    database({ tutor_identity_group_members: [identity, { ...identity, canonicalKey: "Different Tutor", groupId: "different-group" }] });
    await expect(listCaptureSessions(scope, "2026-10-01")).resolves.toEqual([]);
  });

  it.each([
    { classType: "GROUP" }, { sourceRowCount: 2 }, { title: "Unknown modality" }, { meetingStatus: "CANCELLED" },
    { wiseTeacherUserId: "other-user" }, { scheduledEndTime: null }, { scheduledEndTime: new Date("2026-10-01T06:00:00Z") },
    { hasCurrentScheduleEntry: true }, { knownDeleted: true },
  ])("rejects unsafe recent ended rows: %j", async patch => {
    database({ future_session_blocks: [], credit_control_sessions: [{ ...ended, ...patch }] });
    await expect(listCaptureSessions(scope, "2026-10-01")).resolves.toEqual([]);
  });

  it.each([null, undefined, [], ["Tutor Example", "Other Tutor"], [""], ["   "], "Tutor Example"])("denies unscoped, multiple or malformed keys before any session or prior-feedback query: %j", async keys => {
    database();
    const unscoped = { email: "admin@example.test", keys } as CaptureScope;
    await expect(listCaptureSessions(unscoped, "2026-10-01")).rejects.toMatchObject({ status: 403 });
    await expect(requireCaptureSession(unscoped, "session-one", "student-one")).rejects.toMatchObject({ status: 403 });
    await expect(loadPriorFeedback(unscoped, saved)).rejects.toMatchObject({ status: 403 });
    await expect(assertCaptureSessionCurrent(unscoped, saved)).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("does not list or create another tutor's class even for an admin pilot", async () => {
    database({ tutor_identity_group_members: [identity, { ...identity, canonicalKey: "Other Tutor", groupId: "other-group", wiseUserId: "other-user", wiseTeacherId: "other-teacher" }],
      future_session_blocks: [future, { ...future, wiseSessionId: "other-session", groupId: "other-group", wiseTeacherUserId: "other-user", wiseTeacherId: "other-teacher" }] });
    const admin = { email: "admin@example.test", keys: ["Tutor Example"] };
    expect((await listCaptureSessions(admin, "2026-10-01")).map(item => item.sessionId)).toEqual(["session-one"]);
    await expect(requireCaptureSession(admin, "other-session", "student-one")).rejects.toMatchObject({ status: 404 });
  });

  it.each(["2026-09-30", "2026-10-02"])("excludes forged %s session IDs from new selection even if the data layer returns them", async date => {
    database({ future_session_blocks: [{ ...future, startTime: new Date(`${date}T10:00:00Z`), endTime: new Date(`${date}T12:00:00Z`) }],
      credit_control_sessions: [{ ...ended, scheduledStartTime: new Date(`${date}T01:00:00Z`), scheduledEndTime: new Date(`${date}T02:00:00Z`) }] });
    await expect(listCaptureSessions(scope, "2026-10-01")).resolves.toEqual([]);
    await expect(requireCaptureSession(scope, "session-one", "student-one")).rejects.toMatchObject({ status: 404 });
    await expect(requireCaptureSession(scope, "ended-one", "student-one")).rejects.toMatchObject({ status: 404 });
  });

  it("rolls new selection over at Bangkok midnight while preserving an owned ended capture", async () => {
    vi.setSystemTime("2026-10-01T16:59:59Z");
    database({ snapshots: [{ id: "identity-snapshot", createdAt: new Date() }],
      credit_control_snapshots: [{ id: "credit-snapshot", generatedAt: new Date(), source: "wise" }],
      future_session_blocks: [{ ...future, wiseStatus: "ENDED" }] });
    await expect(requireCaptureSession(scope, "session-one", "student-one")).resolves.toMatchObject({ teacherKey: "Tutor Example" });
    vi.setSystemTime("2026-10-01T17:00:00Z");
    await expect(listCaptureSessions(scope, "2026-10-01")).rejects.toMatchObject({ status: 400 });
    await expect(requireCaptureSession(scope, "session-one", "student-one")).rejects.toMatchObject({ status: 404 });
    await expect(assertCaptureSessionCurrent(scope, saved)).resolves.toBeUndefined();
    database({ snapshots: [{ id: "identity-snapshot", createdAt: new Date() }], future_session_blocks: [] });
    await expect(assertCaptureSessionCurrent(scope, saved)).resolves.toBeUndefined();
  });

  it("rejects a selection lookup that completes after Bangkok midnight", async () => {
    vi.setSystemTime("2026-10-01T16:59:59Z");
    database({ snapshots: [{ id: "identity-snapshot", createdAt: new Date() }],
      credit_control_snapshots: [{ id: "credit-snapshot", generatedAt: new Date(), source: "wise" }],
      future_session_blocks: [{ ...future, wiseStatus: "ENDED" }] });
    const pending = requireCaptureSession(scope, "session-one", "student-one");
    vi.setSystemTime("2026-10-01T17:00:00Z");
    await expect(pending).rejects.toMatchObject({ status: 400 });
  });

  it("cannot resurrect a fresh cancellation from an older ended row", async () => {
    database({ future_session_blocks: [{ ...future, wiseSessionId: "ended-one", wiseStatus: "CANCELLED" }], credit_control_sessions: [ended] });
    await expect(listCaptureSessions(scope, "2026-10-01")).resolves.toEqual([]);
  });
});

describe("authorized prior feedback", () => {
  it("loads only prior ended feedback for the same student, class and canonical tutor", async () => {
    const queries = database();
    await expect(loadPriorFeedback(scope, saved)).resolves.toEqual([{ date: "2026-09-30", text: "Topics: Linear equations\nDemonstrated understanding: Explained one worked example\nDifficulties: Check signs\nHomework / next steps: Two practice problems" }]);
    const query = queries.find(query => query.table === "post_class_sessions")!;
    expect(query.params).toEqual(expect.arrayContaining(["student-one", "class-one", "Tutor Example", "session-one", "ready", "ENDED", "teacher"]));
    expect(query.sql).toContain('"post_class_sessions"."scheduled_end_at" <');
    expect(query.limit).toBe(3);
  });

  it("cannot use a saved session to read another tutor's feedback", async () => {
    database();
    await expect(loadPriorFeedback(scope, { ...saved, teacherKey: "Other Tutor" })).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    { wiseClassId: "other-class" }, { wiseStudentId: "other-student" }, { canonicalTutorKey: "Other Tutor" },
    { participantCount: 2 }, { wiseSessionId: "session-one" }, { sourceStatus: "unavailable" },
    { finalStatus: "CANCELLED" }, { wiseDeletedAt: now }, { profile: "student" },
    { scheduledEndAt: new Date("2026-10-02T03:00:00Z") },
  ])("excludes cross-student, group, unavailable and non-prior feedback: %j", async patch => {
    database({ post_class_sessions: [{ ...prior, ...patch }] });
    await expect(loadPriorFeedback(scope, saved)).resolves.toEqual([]);
  });
});

describe("current access to a saved capture", () => {
  it("revalidates the exact current schedule without consulting the daily student snapshot", async () => {
    const queries = database({ credit_control_snapshots: [] });
    await expect(assertCaptureSessionCurrent(scope, saved)).resolves.toBeUndefined();
    expect(queries.some(query => query.table.startsWith("credit_control_"))).toBe(false);
    const query = queries.find(query => query.table === "future_session_blocks")!;
    expect(query.params).toEqual(expect.arrayContaining(["identity-snapshot", "session-one"]));
    // Find a reassignment too: filtering by the old teacher here would look absent.
    expect(query.params).not.toContain("user-one");
    expect(query.limit).toBe(2);
  });

  it("keeps an owned ended capture usable after it leaves the future feed", async () => {
    const queries = database({ future_session_blocks: [], credit_control_snapshots: [] });
    await expect(assertCaptureSessionCurrent(scope, { ...saved, endTime: "2026-10-01T04:29:00Z" })).resolves.toBeUndefined();
    expect(queries.some(query => query.table.startsWith("credit_control_"))).toBe(false);
  });

  it.each(["2026-10-01T04:30:00Z", "2026-10-01T05:00:00Z", "2026-10-02T05:00:00Z"])("denies a missing schedule whose saved end has not passed: %s", async endTime => {
    database({ future_session_blocks: [] });
    await expect(assertCaptureSessionCurrent(scope, { ...saved, endTime })).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    { snapshots: [] },
    { snapshots: [{ id: "old", createdAt: new Date("2026-10-01T00:00:00Z") }] },
    { snapshots: [{ id: "future", createdAt: new Date("2026-10-02T04:00:00Z") }] },
    { snapshots: [{ id: "one", createdAt: now }, { id: "two", createdAt: now }] },
  ])("requires a single fresh active tutor snapshot even for an ended saved capture", async patch => {
    database({ future_session_blocks: [], ...patch });
    await expect(assertCaptureSessionCurrent(scope, { ...saved, endTime: "2026-10-01T04:29:00Z" })).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    { wiseClassId: "other-class" }, { studentIds: ["other-student"] }, { studentIds: null },
    { studentIds: ["student-one", "student-two"] }, { studentCount: 2 }, { classType: "GROUP" },
    { groupId: "other-group" }, { wiseTeacherUserId: "other-user" }, { wiseTeacherId: "other-teacher" },
    { sessionType: "SCHEDULED" }, { sessionType: null }, { title: "Online Session-Mathematics" },
    { wiseStatus: "CANCELLED" }, { wiseStatus: "CANCELED" }, { wiseStatus: "UNKNOWN" },
    { startTime: new Date("2026-10-01T11:00:00Z") }, { endTime: new Date("2026-10-01T13:00:00Z") },
  ])("denies changed or unverifiable current schedule data: %j", async patch => {
    database({ future_session_blocks: [{ ...future, ...patch }] });
    await expect(assertCaptureSessionCurrent(scope, saved)).rejects.toMatchObject({ status: 403 });
  });

  it("denies duplicate current schedule rows", async () => {
    database({ future_session_blocks: [future, future] });
    await expect(assertCaptureSessionCurrent(scope, saved)).rejects.toMatchObject({ status: 403 });
  });

  it("does not let an admin pilot reinterpret an earlier capture as another tutor's class", async () => {
    database({ tutor_identity_group_members: [{ ...identity, canonicalKey: "New Tutor" }] });
    await expect(assertCaptureSessionCurrent({ email: "admin@example.test", keys: ["Tutor Example"] }, saved)).rejects.toMatchObject({ status: 403 });
  });

  it.each([true, false])("denies a proven deletion whether the session remains in the future feed: %s", async remains => {
    database({ future_session_blocks: remains ? [future] : [], post_class_sessions: [{ wiseSessionId: "session-one", wiseDeletedAt: now }] });
    await expect(assertCaptureSessionCurrent(scope, { ...saved, endTime: "2026-10-01T04:29:00Z" })).rejects.toMatchObject({ status: 403 });
  });

  it("denies an explicit cancellation after the session left the future feed", async () => {
    database({ future_session_blocks: [], post_class_sessions: [{ wiseSessionId: "session-one", wiseDeletedAt: null, finalStatus: "CANCELLED" }] });
    await expect(assertCaptureSessionCurrent(scope, { ...saved, endTime: "2026-10-01T04:29:00Z" })).rejects.toMatchObject({ status: 403 });
  });

  it("checks the current scope before reading saved-session source data", async () => {
    database();
    await expect(assertCaptureSessionCurrent({ email: "other@example.test", keys: ["Other Tutor"] }, saved)).rejects.toMatchObject({ status: 403 });
    expect(getDb).not.toHaveBeenCalled();
  });
});
