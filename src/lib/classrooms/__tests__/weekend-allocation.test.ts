import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import type { WiseSession } from "@/lib/wise/types";

vi.mock("@/lib/classrooms/data", () => ({ CLASSROOM_ASSIGNMENT_FRESHNESS_MS: 900_000,
  getFreshClassroomSnapshotForAssignment: vi.fn(), runIncrementalClassroomAssignment: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn(() => ({})) }));
vi.mock("@/lib/wise/day-sessions", () => ({ fetchWiseSessionsForBangkokDates: vi.fn() }));
vi.mock("@/lib/room-booking/service", () => ({ reservationRoomBlocks: vi.fn() }));
vi.mock("@/lib/classrooms/recovery-data", () => ({ loadClassroomRecoveryContext: vi.fn(), prepareClassroomRecoveryDay: vi.fn(), recoveryRoomPolicies: vi.fn(() => ({ policies: new Map() })) }));

import { getFreshClassroomSnapshotForAssignment, runIncrementalClassroomAssignment } from "../data";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { reservationRoomBlocks } from "@/lib/room-booking/service";
import { loadClassroomRecoveryContext, prepareClassroomRecoveryDay } from "../recovery-data";
import { previewWeekendReadiness, weekendPublication } from "../weekend-preview";

const dates: [string, string] = ["2099-09-19", "2099-09-20"];
const room = { id: "room", name: "Classroom", capacity: 4, active: true, hasTv: true, category: "standard" as const, sortOrder: 1 };
const row = (date = dates[0]) => ({ wiseSessionId: `session-${date}`, wiseClassId: "class", wiseTeacherId: "teacher", wiseTeacherUserId: "teacher",
  canonicalKey: "teacher", groupId: "group", tutorDisplayName: "Tutor", startTime: new Date(`${date}T10:00:00Z`), endTime: new Date(`${date}T11:00:00Z`),
  startMinute: 600, endMinute: 660, weekday: 6, wiseStatus: "UPCOMING", isBlocking: true, sessionType: "OFFLINE", classType: "ONE_TO_ONE",
  studentCount: 1, studentIds: ["student"], studentName: "Student", minCapacity: 1, needsTv: false, assignedRoom: room.name,
  currentWiseLocation: room.name, status: "assigned" as const, warnings: [], ruleTrace: [], preferredRoom: room.name, overrideRoom: null });
const live = (date = dates[0]): WiseSession => ({ _id: `session-${date}`, classId: { _id: "class", classType: "ONE_TO_ONE" }, userId: "teacher",
  scheduledStartTime: `${date}T03:00:00Z`, scheduledEndTime: `${date}T04:00:00Z`, type: "OFFLINE", meetingStatus: "UPCOMING",
  students: ["student"], studentCount: 1, location: room.name });
const db = {} as Database;
beforeEach(() => {
  vi.mocked(getFreshClassroomSnapshotForAssignment).mockResolvedValue({ snapshotId: "snapshot", snapshotMeta: {
    snapshotId: "snapshot", latestSyncFinishedAt: new Date().toISOString(), fresh: true, staleAgeMs: 0 } });
  vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue(dates.map(live));
  vi.mocked(reservationRoomBlocks).mockResolvedValue([]);
  vi.mocked(loadClassroomRecoveryContext).mockResolvedValue({ rooms: [room], latestRuns: [] } as never);
  vi.mocked(prepareClassroomRecoveryDay).mockImplementation(async (_context, _live, date) => ({
    day: [live(date)], sessions: [row(date)], previousRows: [], findings: [], liveRoomBlocks: [],
    externalRoomBlocks: [], confirmedInactiveSessionIds: new Set(), frozenSessionIds: new Set(),
  }));
  vi.mocked(runIncrementalClassroomAssignment).mockImplementation(async (_db, { date }) => ({
    run: { id: `run-${date}`, createdAt: new Date() }, rows: [row(date)], overflowPlan: null,
  }) as never);
});
afterEach(() => vi.resetAllMocks());

describe("Wednesday allocation checkpoint", () => {
  it("saves both dates without publishing, passing one fenced checkpoint and retaining overrides", async () => {
    const checkpoint = { id: "check", claimedAt: new Date() }, assertActive = vi.fn();
    const report = await previewWeekendReadiness(db, dates, { checkpoint, assertActive });
    expect(report.version).toBe(2);
    expect(report.days.map(day => [day.date, day.allocation, day.runId])).toEqual(dates.map(date => [date, "saved", `run-${date}`]));
    expect(runIncrementalClassroomAssignment).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(runIncrementalClassroomAssignment).mock.calls) expect(call[1]).toMatchObject({ forceReassign: false, weekendCheckpoint: checkpoint });
    expect(report.readiness).toBe("clear");
    expect(report.days[0].publication).toMatchObject({ state: "verified", verified: 1, pending: 0 });
    expect(assertActive).toHaveBeenCalledTimes(4);
  });
  it("still saves Sunday and reports a failed Saturday instead of losing the entire report", async () => {
    vi.mocked(runIncrementalClassroomAssignment).mockRejectedValueOnce(new Error("Saturday source changed"));
    const report = await previewWeekendReadiness(db, dates, { checkpoint: { id: "check", claimedAt: new Date() } });
    expect(report.days[0]).toMatchObject({ allocation: "failed", allocationError: "Saturday source changed", overflowPlan: null });
    expect(report.days[1]).toMatchObject({ allocation: "saved" });
    expect(report.readiness).toBe("unverified");
  });
  it("withholds a day with unresolved old lessons and keeps the other date independent", async () => {
    vi.mocked(prepareClassroomRecoveryDay).mockResolvedValueOnce({ day: [live()], sessions: [row()], previousRows: [],
      findings: [{ date: dates[0], kind: "unverified", message: "Missing lesson is not a confirmed cancellation" }],
      liveRoomBlocks: [], externalRoomBlocks: [], confirmedInactiveSessionIds: new Set(), frozenSessionIds: new Set() });
    const report = await previewWeekendReadiness(db, dates, { checkpoint: { id: "check", claimedAt: new Date() } });
    expect(report.days[0].allocation).toBe("blocked");
    expect(runIncrementalClassroomAssignment).toHaveBeenCalledTimes(1);
    expect(report.findings.map(finding => finding.message).join(" ")).toContain("not a confirmed cancellation");
  });
  it("never saves from a failed source sync even if a snapshot was promoted", async () => {
    const fresh = await getFreshClassroomSnapshotForAssignment(db);
    vi.mocked(getFreshClassroomSnapshotForAssignment).mockResolvedValue({ ...fresh,
      snapshotMeta: { ...fresh.snapshotMeta, syncErrorSummary: "Teacher identities require review" } });
    const report = await previewWeekendReadiness(db, dates, { checkpoint: { id: "check", claimedAt: new Date() } });
    expect(report.readiness).toBe("unverified");
    expect(runIncrementalClassroomAssignment).not.toHaveBeenCalled();
  });
  it("keeps follow-up checks read-only and includes confirmed reservations", async () => {
    vi.mocked(reservationRoomBlocks).mockResolvedValue([{ wiseSessionId: "reservation", className: "Reserved room", location: room.name, startMinute: 600, endMinute: 660 }]);
    const report = await previewWeekendReadiness(db, dates);
    expect(runIncrementalClassroomAssignment).not.toHaveBeenCalled();
    expect(report.days.every(day => day.allocation === "not_requested")).toBe(true);
    expect(report.days[0].overflowPlan?.proposedSwitches).toBe(1);
    expect(report.days[0].overflowPlan?.predictedRemainingOverflow).toBe(0);
    expect(report.days[0].noRoomCount).toBe(1);
    expect(report.readiness).toBe("attention");
  });
});

describe("actual Wise publication evidence", () => {
  it("ignores a stored success when the live location changed", () => {
    expect(weekendPublication([{ ...row(), publishStatus: "success" }], [{ ...live(), location: "Elsewhere" }], "checked"))
      .toMatchObject({ state: "not_published", verified: 0, pending: 1 });
  });
  it("accepts room aliases only for the same full lesson and roster", () => {
    expect(weekendPublication([row()], [{ ...live(), location: "Classroom (TV)" }], "checked").verified).toBe(1);
    expect(weekendPublication([row()], [{ ...live(), students: ["different-student"] }], "checked").verified).toBe(0);
  });
});
