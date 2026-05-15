import { describe, expect, it, vi } from "vitest";
import { getTeacherScheduleForRun } from "../data";

function makeTeacherScheduleDb(rows: unknown[]) {
  let selectCall = 0;
  return {
    select: vi.fn(() => {
      const call = selectCall;
      selectCall += 1;
      if (call === 0) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ assignmentDate: "2026-05-15" }]),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(rows),
          })),
        })),
      };
    }),
  };
}

describe("classroom teacher schedule timezone formatting", () => {
  it("uses Bangkok minute columns instead of converting serialized row timestamps", async () => {
    const db = makeTeacherScheduleDb([
      {
        id: "row-1",
        tutorDisplayName: "Kevin",
        startTime: new Date("2026-05-15T09:00:00.000Z"),
        endTime: new Date("2026-05-15T10:00:00.000Z"),
        startMinute: 9 * 60,
        endMinute: 10 * 60,
        status: "assigned",
        assignedRoom: "Focus",
        studentName: "Student One",
        subject: "Math",
        classType: "ONE_TO_ONE",
        sessionType: "OFFLINE",
      },
    ]);

    const schedule = await getTeacherScheduleForRun(db as never, "run-1");

    expect(schedule.tutors[0].blocks[0]).toMatchObject({
      date: "2026-05-15",
      startTime: "09:00",
      endTime: "10:00",
    });
  });
});
