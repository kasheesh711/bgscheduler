import { describe, expect, it, vi } from "vitest";
import type { WiseClient } from "@/lib/wise/client";
import {
  durationMsToMinutes,
  fetchCreditSessions,
  fetchCreditStudents,
  fetchSessionCredits,
} from "@/lib/credit-control/wise";
import {
  buildStudentPackageKey,
  formatDate,
} from "@/lib/credit-control/helpers";
import {
  buildActiveStudentSet,
  buildPendingDeductionContext,
  buildStudentAdminOwnershipMap,
  buildUpcomingSessionMap,
  getPackageExclusionReason,
} from "@/lib/credit-control/packages";
import type { SheetSnapshot } from "@/lib/credit-control/domain";

function fakeClient(get: unknown): WiseClient {
  return { get: get as WiseClient["get"] } as WiseClient;
}

function snapshot(header: string[], rows: unknown[][]): SheetSnapshot {
  return {
    sheetName: "test",
    headerRowIndex: 0,
    dataRowStartIndex: 2,
    cols: Object.fromEntries(header.map((name, index) => [name, index])),
    rows,
  };
}

describe("credit-control Wise fetchers", () => {
  it("paginates students with parent data requested", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      _id: `student-${index}`,
      name: `Student ${index}`,
      activated: true,
      parents: [{ name: `Parent ${index}` }],
      classrooms: [],
    }));
    const get = vi
      .fn<WiseClient["get"]>()
      .mockResolvedValueOnce({ data: { students: firstPage, count: 101 } })
      .mockResolvedValueOnce({
        data: {
          students: [{
            _id: "student-100",
            name: "Student 100",
            activated: true,
            parents: [{ name: "Parent 100" }],
            classrooms: [],
          }],
          count: 101,
        },
      });

    const students = await fetchCreditStudents(fakeClient(get), "institute-1");

    expect(students).toHaveLength(101);
    expect(get).toHaveBeenNthCalledWith(1, "/institutes/v3/institute-1/students", {
      page_number: "1",
      page_size: "100",
      showParents: "true",
    });
    expect(get).toHaveBeenNthCalledWith(2, "/institutes/v3/institute-1/students", {
      page_number: "2",
      page_size: "100",
      showParents: "true",
    });
  });

  it("parses session dates and paginates by date window", async () => {
    const get = vi
      .fn<WiseClient["get"]>()
      .mockResolvedValueOnce({
        data: {
          sessions: [{
            _id: "session-1",
            classId: { _id: "class-1", name: "Math", subject: "Math" },
            scheduledStartTime: "2026-05-01T10:00:00.000Z",
            scheduledEndTime: "2026-05-01T11:30:00.000Z",
            meetingStatus: "UPCOMING",
            duration: 5_400_000,
            students: ["student-1"],
          }],
          count: 1,
        },
      });

    const sessions = await fetchCreditSessions(
      fakeClient(get),
      "institute-1",
      "FUTURE",
      new Date("2026-05-01T00:00:00.000Z"),
      new Date("2026-05-31T00:00:00.000Z"),
    );

    expect(sessions[0].scheduledStartTime).toBeInstanceOf(Date);
    expect(durationMsToMinutes(sessions[0].duration)).toBe(90);
    expect(get).toHaveBeenCalledWith("/institutes/institute-1/sessions", {
      status: "FUTURE",
      paginateBy: "DATE",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      page_number: "1",
      page_size: "100",
    });
  });

  it("splits long session date ranges into Wise-safe windows", async () => {
    const get = vi.fn<WiseClient["get"]>().mockResolvedValue({
      data: {
        sessions: [],
        count: 0,
      },
    });

    await fetchCreditSessions(
      fakeClient(get),
      "institute-1",
      "PAST",
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-03-05T00:00:00.000Z"),
    );

    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.map((call) => call[1])).toEqual([
      {
        status: "PAST",
        paginateBy: "DATE",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        page_number: "1",
        page_size: "100",
      },
      {
        status: "PAST",
        paginateBy: "DATE",
        startDate: "2026-02-01",
        endDate: "2026-03-03",
        page_number: "1",
        page_size: "100",
      },
      {
        status: "PAST",
        paginateBy: "DATE",
        startDate: "2026-03-04",
        endDate: "2026-03-05",
        page_number: "1",
        page_size: "100",
      },
    ]);
  });

  it("parses per-student session credits and history", async () => {
    const get = vi.fn<WiseClient["get"]>().mockResolvedValueOnce({
      data: {
        credits: {
          total: "10",
          consumed: "3",
          bookedSessions: "2",
          remaining: "7",
          available: "5",
        },
        sessionCreditHistory: [{
          _id: "session-1",
          credit: "1.5",
          duration: 5_400_000,
          meetingStatus: "ENDED",
          type: "SESSION",
          createdAt: "2026-05-01T10:00:00.000Z",
        }],
      },
    });

    const credits = await fetchSessionCredits(fakeClient(get), "institute-1", "class-1", "student-1");

    expect(credits.credits.remaining).toBe(7);
    expect(credits.sessionCreditHistory[0].credit).toBe(1.5);
    expect(get).toHaveBeenCalledWith(
      "/institutes/institute-1/classes/class-1/students/student-1/sessionCredits",
      { fetchHistory: "true" },
    );
  });
});

describe("credit-control business rules", () => {
  it("excludes Pretest and Trial packages by class/package text", () => {
    expect(getPackageExclusionReason("SAT Pretest", "SAT")).toBe("pretest");
    expect(getPackageExclusionReason("Math", "Trial Lesson")).toBe("trial");
    expect(getPackageExclusionReason("Math", "Regular Package")).toBeNull();
  });

  it("uses duration fallback for ended sessions without a positive credit-history match", () => {
    const students = snapshot(["student_name", "Remaining Credits"], [["Ada", "0"]]);
    const activeStudents = buildActiveStudentSet(students);
    const creditControl = snapshot(
      [
        "Student Name",
        "Package/Program",
        "final_status",
        "teacher_feedback",
        "credits_consumed",
        "session_duration",
        "session_date",
        "Should_Credit",
        "session_id",
      ],
      [["Ada", "Math", "ENDED", "", 0, 90, "2026-05-01", "", "session-1"]],
    );

    const pending = buildPendingDeductionContext(
      creditControl,
      activeStudents,
      {},
      new Date("2026-05-18T00:00:00.000Z"),
    );

    expect(Object.values(pending.amountsByKey)).toEqual([1.5]);
    expect(pending.fallbackRows[0]).toMatchObject({
      sessionId: "session-1",
      deductionSource: "session_duration",
      usingFallback: true,
    });
  });

  it("projects only upcoming non-excluded sessions after today", () => {
    const students = snapshot(["student_name", "Remaining Credits"], [["Ada", "0"]]);
    const activeStudents = buildActiveStudentSet(students);
    const upcoming = snapshot(
      ["Student Name", "Package/Program", "Session Status", "Session Duration", "Scheduled Date"],
      [
        ["Ada", "Math", "UPCOMING", 90, "2026-05-19"],
        ["Ada", "Math", "CANCELLED", 90, "2026-05-20"],
        ["Ada", "Trial", "UPCOMING", 90, "2026-05-21"],
      ],
    );

    const sessions = buildUpcomingSessionMap(
      upcoming,
      activeStudents,
      { [buildStudentPackageKey("Ada", "Trial")]: "trial" },
      new Date("2026-05-18T00:00:00.000Z"),
    );

    const [session] = Object.values(sessions)[0];
    expect(formatDate(session.date)).toBe("2026-05-19");
    expect(session.durationMin).toBe(90);
  });

  it("preserves RemainingCredits admin majority vote and first-row tie break", () => {
    const ownership = buildStudentAdminOwnershipMap(snapshot(
      ["Student", "Admin"],
      [
        ["Shared Student", "Panida (Petchy) Wiya"],
        ["Shared Student", "Chiraya (Palm) Takornkulwut"],
        ["Shared Student", "Panida (Petchy) Wiya"],
        ["Tie Student", "Kittiya (Care) Taweesinprasarn"],
        ["Tie Student", "Suphitsara (Muk) Manosamrit"],
      ],
    ));

    expect(ownership["Shared Student"].key).toBe("petchy");
    expect(ownership["Tie Student"].key).toBe("care");
  });
});
