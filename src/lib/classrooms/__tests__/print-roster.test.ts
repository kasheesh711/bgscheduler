import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WiseSession } from "@/lib/wise/types";
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn(() => ({})) }));
vi.mock("@/lib/wise/fetchers", () => ({ fetchAllFutureSessions: vi.fn(), fetchWiseSessionDetail: vi.fn() }));
vi.mock("@/lib/credit-control/wise", () => ({ fetchCreditStudents: vi.fn() }));
import { fetchAllFutureSessions, fetchWiseSessionDetail } from "@/lib/wise/fetchers";
import { fetchCreditStudents } from "@/lib/credit-control/wise";
import { loadPrintRosters, projectPrintRoster, type PrintRosterSource } from "../print-roster";
// Drizzle reads timestamp-without-time-zone values as Dates with Bangkok wall-clock UTC fields.
const source: PrintRosterSource = { id: "row", wiseSessionId: "session", wiseClassId: "class", wiseTeacherUserId: "teacher", startTime: new Date("2099-09-12T09:00:00Z"), endTime: new Date("2099-09-12T10:00:00Z"), sessionType: "OFFLINE" };
const session = (patch: Partial<WiseSession> = {}): WiseSession => ({ _id: "session", classId: "class", userId: "teacher", scheduledStartTime: "2099-09-12T02:00:00Z", scheduledEndTime: "2099-09-12T03:00:00Z", type: "OFFLINE", meetingStatus: "SCHEDULED", students: [{ _id: "a", name: "แสงดาว" }], ...patch });
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-11T10:00:00Z")); });
afterEach(() => vi.useRealTimers());
describe("exact session roster projection", () => {
  it.each([
    ["2099-09-12T09:00:00Z", "2099-09-12T10:00:00Z", "2099-09-12T02:00:00Z", "2099-09-12T03:00:00Z"],
    ["2099-09-12T00:30:00Z", "2099-09-12T01:30:00Z", "2099-09-11T17:30:00Z", "2099-09-11T18:30:00Z"],
  ])("compares saved Bangkok wall-clock times with Wise instants: %s", (savedStart, savedEnd, liveStart, liveEnd) => {
    const result = projectPrintRoster({ ...source, startTime: new Date(savedStart), endTime: new Date(savedEnd) }, session({ scheduledStartTime: liveStart, scheduledEndTime: liveEnd }), new Map());
    expect(result).toMatchObject({ sessionState: "current", warnings: [] });
  });
  it("deduplicates IDs while retaining identical names for different students, including Thai", () => {
    const result = projectPrintRoster(source, session({ students: ["a", { _id: "a", name: "แสงดาว" }, "b", "c"] }), new Map([["a", "Older name"], ["b", "Same Name"], ["c", "Same Name"]]));
    expect(result).toMatchObject({ rosterStatus: "verified", studentCount: 3, sessionState: "current" });
    expect(result.students).toEqual(expect.arrayContaining(["แสงดาว", "Same Name", "Same Name"]));
    expect(result.students).toHaveLength(3);
  });
  it("never derives membership from titles, participants or course membership", () => {
    const result = projectPrintRoster(source, session({ students: undefined, title: "Not a student", participants: [{ _id: "a", name: "Not enrollment" }], classId: { _id: "class", name: "Package name" } }), new Map([["a", "Directory name"]]));
    expect(result.students).toEqual([]); expect(result.rosterStatus).toBe("incomplete");
  });
  it("warns about missing names and incomplete counts; a verified empty roster stays empty", () => {
    expect(projectPrintRoster(source, session({ students: ["missing"], studentCount: 3 }), new Map())).toMatchObject({ students: [], rosterStatus: "incomplete", studentCount: 3 });
    expect(projectPrintRoster(source, session({ students: [] }), new Map())).toMatchObject({ students: [], rosterStatus: "verified" });
  });
  it.each(["CANCELLED", "CANCELED"])("detects %s without losing the student list", status => {
    expect(projectPrintRoster(source, session({ meetingStatus: status }), new Map())).toMatchObject({ sessionState: "cancelled", students: ["แสงดาว"], warnings: [expect.stringContaining("Regenerate assignments")] });
  });
  it.each<Partial<WiseSession>>([{ scheduledStartTime: "2099-09-13T02:00:00Z", scheduledEndTime: "2099-09-13T03:00:00Z" }, { scheduledStartTime: "2099-09-12T03:00:00Z", scheduledEndTime: "2099-09-12T04:00:00Z" }, { scheduledStartTime: "2099-09-12T09:00:00Z", scheduledEndTime: "2099-09-12T10:00:00Z" }, { userId: "other" }, { classId: "other" }, { type: "ONLINE" }])("detects a changed saved session: %j", patch => {
    expect(projectPrintRoster(source, session(patch), new Map()).sessionState).toBe("rescheduled");
  });
  it("fails closed for a wrong ID, absent session or invalid times", () => {
    for (const live of [undefined, session({ _id: "wrong" }), session({ scheduledStartTime: "invalid" })]) expect(projectPrintRoster(source, live, new Map()).sessionState).toBe("unverified");
  });
});
describe("report-wide roster refresh", () => {
  it.each([
    ["2099-09-12T01:59:59Z", false],
    ["2099-09-12T02:00:00Z", true],
    ["2099-09-12T02:30:00Z", true],
  ])("refreshes started Bangkok sessions at the actual instant: %s", async (now, started) => {
    vi.setSystemTime(new Date(now));
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([session()]);
    vi.mocked(fetchWiseSessionDetail).mockResolvedValue(session());
    const result = await loadPrintRosters([source]);
    expect(fetchWiseSessionDetail).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(result.byRow.get(source.id)?.sessionState).toBe("current");
  });
  it("shares one strict sweep and one necessary directory read across all seven days", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ ...source, id: `row-${i}`, wiseSessionId: `session-${i}` }));
    vi.mocked(fetchAllFutureSessions).mockResolvedValue(rows.map(row => session({ _id: row.wiseSessionId, students: ["a"] })));
    vi.mocked(fetchCreditStudents).mockResolvedValue([{ _id: "a", name: "Student", activated: true, parents: [], classrooms: [] }]);
    const result = await loadPrintRosters(rows);
    expect(fetchAllFutureSessions).toHaveBeenCalledExactlyOnceWith({}, expect.any(String), expect.objectContaining({ strict: true, deadlineAt: expect.any(Number) }));
    expect(fetchCreditStudents).toHaveBeenCalledTimes(1); expect(fetchWiseSessionDetail).not.toHaveBeenCalled();
    expect([...result.byRow.values()].every(row => row.students[0] === "Student")).toBe(true);
  });
  it("avoids the directory when expanded names suffice, and refreshes changed rosters", async () => {
    vi.mocked(fetchAllFutureSessions).mockResolvedValueOnce([session()]).mockResolvedValueOnce([session({ students: [{ _id: "b", name: "New student" }] })]);
    expect((await loadPrintRosters([source])).byRow.get("row")?.students).toEqual(["แสงดาว"]);
    expect((await loadPrintRosters([source])).byRow.get("row")?.students).toEqual(["New student"]);
    expect(fetchCreditStudents).not.toHaveBeenCalled();
  });
  it("reads exact session details for absent, incomplete and already-started sessions", async () => {
    const rows = [source, { ...source, id: "two", wiseSessionId: "two" }, { ...source, id: "past", wiseSessionId: "past", startTime: new Date("2020-01-01") }];
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([session({ _id: "two", students: [], studentCount: 2 }), session({ _id: "past" })]);
    vi.mocked(fetchWiseSessionDetail).mockImplementation(async (_, __, id) => session({ _id: id }));
    await loadPrintRosters(rows);
    expect(fetchWiseSessionDetail).toHaveBeenCalledTimes(3);
    for (const row of rows) expect(fetchWiseSessionDetail).toHaveBeenCalledWith({}, "class", row.wiseSessionId, expect.objectContaining({ deadlineAt: expect.any(Number) }));
  });
  it.each([null, "old-class"])("uses the exact live session's class ID when the saved class ID is %s", async savedClassId => {
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([session({ classId: { _id: "current-class", name: "Not attendance" }, students: undefined })]);
    vi.mocked(fetchWiseSessionDetail).mockResolvedValue(session({ classId: "current-class", students: [{ _id: "a", name: "Verified student" }] }));
    const result = await loadPrintRosters([{ ...source, wiseClassId: savedClassId }]);
    expect(fetchWiseSessionDetail).toHaveBeenCalledExactlyOnceWith({}, "current-class", "session", expect.objectContaining({ deadlineAt: expect.any(Number) }));
    expect(result.byRow.get("row")).toMatchObject({ students: ["Verified student"], rosterStatus: "verified", sessionState: savedClassId ? "rescheduled" : "current" });
    expect(result.refreshFailed).toBe(false);
    expect(fetchCreditStudents).not.toHaveBeenCalled();
  });
  it("fails a strict sweep; marks detail/directory failures for retry instead of stale printing", async () => {
    vi.mocked(fetchAllFutureSessions).mockRejectedValueOnce(new Error("Wise down"));
    await expect(loadPrintRosters([source])).rejects.toThrow("Wise down");
    vi.mocked(fetchAllFutureSessions).mockResolvedValueOnce([]);
    vi.mocked(fetchWiseSessionDetail).mockRejectedValue(new Error("Wise down"));
    expect(await loadPrintRosters([source])).toMatchObject({ refreshFailed: true });
    vi.mocked(fetchAllFutureSessions).mockResolvedValueOnce([session({ students: ["a"] })]);
    vi.mocked(fetchCreditStudents).mockRejectedValue(new Error("Wise down"));
    expect(await loadPrintRosters([source])).toMatchObject({ refreshFailed: true });
  });
  it("marks missing session identities for review without inferring a roster", async () => {
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([]);
    const result = await loadPrintRosters([{ ...source, wiseClassId: null }]);
    expect(result.byRow.get("row")).toMatchObject({ rosterStatus: "unavailable", sessionState: "unverified" });
    expect(fetchWiseSessionDetail).not.toHaveBeenCalled();
  });
});
