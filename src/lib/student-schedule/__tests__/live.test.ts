import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/credit-control/wise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/credit-control/wise")>();
  return { ...actual, fetchInstituteSessionsForDays: vi.fn() };
});

import { fetchInstituteSessionsForDays, type WiseCreditSession } from "@/lib/credit-control/wise";
import { fetchLiveMonthSessions, studentScheduleLiveEnabled } from "@/lib/student-schedule/live";

const mockedFetch = vi.mocked(fetchInstituteSessionsForDays);

function session(overrides: Partial<WiseCreditSession> = {}): WiseCreditSession {
  return {
    _id: "ses_1",
    classId: { _id: "class_1", name: "Math Class", subject: "Math" },
    scheduledStartTime: new Date("2026-08-13T08:00:00Z"), // 15:00 Bangkok
    scheduledEndTime: new Date("2026-08-13T09:30:00Z"),
    meetingStatus: "UPCOMING",
    duration: 5_400_000,
    students: ["stu_1"],
    ...overrides,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  globalThis.__bgscheduler_liveMonthSessionsCache = undefined;
  delete process.env.ENABLE_STUDENT_SCHEDULE_LIVE;
});

describe("studentScheduleLiveEnabled", () => {
  it("is true when unset", () => {
    expect(studentScheduleLiveEnabled()).toBe(true);
  });

  it("is true for any value other than the literal string \"false\"", () => {
    process.env.ENABLE_STUDENT_SCHEDULE_LIVE = "0";
    expect(studentScheduleLiveEnabled()).toBe(true);
  });

  it("is false only for exactly \"false\"", () => {
    process.env.ENABLE_STUDENT_SCHEDULE_LIVE = "false";
    expect(studentScheduleLiveEnabled()).toBe(false);
  });
});

describe("fetchLiveMonthSessions", () => {
  it("returns ok:false without calling the fetcher when the kill switch is off", async () => {
    process.env.ENABLE_STUDENT_SCHEDULE_LIVE = "false";
    const result = await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08" });
    expect(result).toEqual({ sessions: [], ok: false });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("filters the sweep to the requested student on success", async () => {
    mockedFetch.mockResolvedValue([
      session({ _id: "ses_1", students: ["stu_1"] }),
      session({ _id: "ses_2", students: ["stu_2"] }),
      session({ _id: "ses_3", students: ["stu_1", "stu_2"] }),
    ]);

    const result = await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08" });

    expect(result.ok).toBe(true);
    expect(result.sessions.map((s) => s._id)).toEqual(["ses_1", "ses_3"]);
  });

  it("pads the swept day list one Bangkok day before and after the month", async () => {
    mockedFetch.mockResolvedValue([]);

    await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08" });

    const days = mockedFetch.mock.calls[0][2];
    expect(days[0]).toBe("2026-07-31");
    expect(days[days.length - 1]).toBe("2026-09-01");
  });

  it("returns ok:false when the fetcher rejects", async () => {
    mockedFetch.mockRejectedValue(new Error("Wise API 500"));

    const result = await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08" });

    expect(result).toEqual({ sessions: [], ok: false });
  });

  it("returns ok:false when the sweep exceeds the deadline", async () => {
    mockedFetch.mockImplementation(() => new Promise(() => {}));

    const result = await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08", deadlineMs: 10 });

    expect(result).toEqual({ sessions: [], ok: false });
  });

  it("memoizes a successful sweep for the TTL window", async () => {
    mockedFetch.mockResolvedValue([session({ _id: "ses_1", students: ["stu_1"] })]);

    await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08" });
    await fetchLiveMonthSessions({ wiseStudentId: "stu_1", monthKey: "2026-08" });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
