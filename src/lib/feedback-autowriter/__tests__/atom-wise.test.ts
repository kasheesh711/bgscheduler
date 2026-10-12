import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";
import { fetchWiseSessionsForBangkokDates } from "@/lib/wise/day-sessions";
import { fetchAllFutureSessions } from "@/lib/wise/fetchers";
import { ATOM_TIMETABLE_ATTEMPTS, fetchAtomLessonTimetable } from "../atom/wise";
vi.mock("@/lib/wise/day-sessions", () => ({ fetchWiseSessionsForBangkokDates: vi.fn() }));
vi.mock("@/lib/wise/fetchers", () => ({ fetchAllFutureSessions: vi.fn() }));
const client = {} as WiseClient;
const options = { now: new Date("2026-10-01T06:00:00Z"), deadlineAt: Date.now() + 60000 };
const row = (id: string, start = "2026-10-01T02:00:00Z") => ({ _id: id, scheduledStartTime: start,
  scheduledEndTime: new Date(Date.parse(start) + 3600000).toISOString(), userId: "teacher", students: ["student"],
  classId: "class", title: "Maths", type: "SCHEDULED", meetingStatus: "ENDED" }) as unknown as WiseSession;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([]); vi.mocked(fetchAllFutureSessions).mockResolvedValue([]); });
describe("Atom complete Wise timetable", () => {
  it("uses strict full FUTURE pagination and filters dates locally, including Bangkok midnight", async () => {
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([row("previous", "2026-09-30T16:59:00Z"), row("midnight", "2026-09-30T17:00:00Z"), row("next", "2026-10-01T17:00:00Z")]);
    expect((await fetchAtomLessonTimetable(client, "i", ["2026-10-01"], options)).map(s => s._id)).toEqual(["midnight"]);
    expect(fetchAllFutureSessions).toHaveBeenCalledWith(client, "i", { strict: true, deadlineAt: options.deadlineAt });
    expect(fetchWiseSessionsForBangkokDates).toHaveBeenCalledWith(client, "i", ["2026-10-01"], { ...options, pastOnly: true });
  });
  it("coalesces the same ended occurrence appearing in both statuses", async () => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([row("same")]);
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([row("same")]);
    expect(await fetchAtomLessonTimetable(client, "i", ["2026-10-01"], options)).toHaveLength(1);
  });
  it.each(["STARTED", "SCHEDULED", "FUTURE"])("keeps the PAST record when FUTURE still shows %s for an ended class", async status => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([row("same")]);
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([{ ...row("same"), meetingStatus: status } as unknown as WiseSession]);
    const result = await fetchAtomLessonTimetable(client, "i", ["2026-10-01"], options);
    expect(result).toHaveLength(1);
    expect(result[0].meetingStatus).toBe("ENDED");
  });
  it.each([["ENDED", "CANCELLED"], ["CANCELED", "STARTED"]])("rejects a cancellation on only one side (%s / %s)", async (past, future) => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([{ ...row("same"), meetingStatus: past } as unknown as WiseSession]);
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([{ ...row("same"), meetingStatus: future } as unknown as WiseSession]);
    await expect(fetchAtomLessonTimetable(client, "i", ["2026-10-01"], options)).rejects.toThrow("conflict");
  });
  it.each(["students", "userId", "scheduledStartTime", "title"] as const)("rejects conflicting %s across statuses", async key => {
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([row("same")]);
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([{ ...row("same"), [key]: key === "students" ? ["other"] : key === "scheduledStartTime" ? "2026-10-01T03:00:00Z" : "other" } as unknown as WiseSession]);
    await expect(fetchAtomLessonTimetable(client, "i", ["2026-10-01"], options)).rejects.toThrow("conflict");
  });
  it("does not return partial PAST evidence when the full FUTURE read keeps failing", async () => {
    const sleep = vi.fn(async () => undefined);
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([row("past")]);
    vi.mocked(fetchAllFutureSessions).mockRejectedValue(new Error("incomplete pagination"));
    await expect(fetchAtomLessonTimetable(client, "i", ["2026-10-01"], { ...options, sleep })).rejects.toThrow("incomplete");
    expect(fetchAllFutureSessions).toHaveBeenCalledTimes(ATOM_TIMETABLE_ATTEMPTS);
    expect(sleep.mock.calls).toEqual([[5000], [10000]]);
  });
  it("reads the whole timetable again when a class ending mid-read shows one session on two pages", async () => {
    const sleep = vi.fn(async () => undefined);
    vi.mocked(fetchWiseSessionsForBangkokDates)
      .mockRejectedValueOnce(new Error("Invalid, duplicate or out-of-date Wise session for 2026-10-01"))
      .mockResolvedValue([row("past")]);
    const result = await fetchAtomLessonTimetable(client, "i", ["2026-10-01"], { ...options, sleep });
    expect(result.map(s => s._id)).toEqual(["past"]);
    expect(fetchWiseSessionsForBangkokDates).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it("does not retry a real PAST/FUTURE conflict or a read with no time left", async () => {
    const sleep = vi.fn(async () => undefined);
    vi.mocked(fetchWiseSessionsForBangkokDates).mockResolvedValue([row("same")]);
    vi.mocked(fetchAllFutureSessions).mockResolvedValue([{ ...row("same"), title: "other" } as unknown as WiseSession]);
    await expect(fetchAtomLessonTimetable(client, "i", ["2026-10-01"], { ...options, sleep })).rejects.toThrow("conflict");
    vi.mocked(fetchAllFutureSessions).mockRejectedValue(new Error("Wise session read contains duplicate, missing, or invalid session data"));
    await expect(fetchAtomLessonTimetable(client, "i", ["2026-10-01"], { ...options, deadlineAt: Date.now() + 10_000, sleep }))
      .rejects.toThrow("duplicate");
    expect(sleep).not.toHaveBeenCalled();
  });
  it("does not fetch FUTURE for historical-only comparisons", async () => {
    await fetchAtomLessonTimetable(client, "i", ["2026-09-29"], options);
    expect(fetchAllFutureSessions).not.toHaveBeenCalled();
  });
});
