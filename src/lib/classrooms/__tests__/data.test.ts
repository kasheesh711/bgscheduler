import { describe, expect, it } from "vitest";
import { buildTeacherSchedule, formatBangkokMinute } from "../data";

describe("classroom data helpers", () => {
  it("formats Bangkok minutes as HH:mm", () => {
    expect(formatBangkokMinute(9 * 60 + 5)).toBe("09:05");
    expect(formatBangkokMinute(23 * 60 + 30)).toBe("23:30");
  });

  it("builds teacher schedule times from Bangkok minutes instead of stored timestamps", () => {
    const schedule = buildTeacherSchedule([
      {
        id: "row-1",
        tutorDisplayName: "Kevin",
        startTime: new Date("2026-05-15T16:00:00.000Z"),
        endTime: new Date("2026-05-15T17:00:00.000Z"),
        startMinute: 9 * 60,
        endMinute: 10 * 60,
        assignedRoom: "Think Outside the Box",
        status: "assigned",
        studentName: "Student One",
        subject: "Math",
        classType: "ONE_TO_ONE",
        sessionType: "OFFLINE",
      },
    ], "2026-05-16");

    expect(schedule.tutors).toEqual([
      {
        tutorDisplayName: "Kevin",
        blocks: [
          {
            rowId: "row-1",
            date: "2026-05-16",
            startTime: "09:00",
            endTime: "10:00",
            room: "Think Outside the Box",
            studentName: "Student One",
            subject: "Math",
            classType: "ONE_TO_ONE",
            sessionType: "OFFLINE",
          },
        ],
      },
    ]);
  });
});
