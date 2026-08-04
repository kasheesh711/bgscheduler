import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ScheduleMonthCalendar,
  buildSubjectColorMap,
} from "../schedule-month-calendar";
import { TEACHER_TBC, type StudentSchedulePayload, type StudentScheduleSession } from "@/lib/student-schedule/types";

function session(
  overrides: Partial<StudentScheduleSession> & { wiseSessionId: string; dateKey: string },
): StudentScheduleSession {
  return {
    startTime: `${overrides.dateKey}T09:00:00.000Z`,
    endTime: `${overrides.dateKey}T10:30:00.000Z`,
    startLabel: "16:00",
    endLabel: "17:30",
    subject: "Mathematics",
    packageName: "Maths pack",
    teacherName: "Kru Nok",
    durationMinutes: 90,
    meetingStatus: "SCHEDULED",
    ...overrides,
  };
}

function payload(sessions: StudentScheduleSession[]): StudentSchedulePayload {
  return {
    student: {
      studentKey: "praetara (prapang.an) angsukuntorn::suchada angsukuntorn",
      wiseStudentId: "stu_1",
      studentName: "Praetara (Prapang.An) Angsukuntorn",
      parentName: "Suchada Angsukuntorn",
      code: "Prapang.An",
      shortName: "Prapang",
    },
    monthKey: "2026-08",
    monthLabel: "August 2026",
    sessions,
    generatedAt: "2026-08-05T03:00:00.000Z",
  };
}

function render(sessions: StudentScheduleSession[], todayKey?: string) {
  return renderToStaticMarkup(
    <ScheduleMonthCalendar payload={payload(sessions)} todayKey={todayKey} />,
  );
}

describe("buildSubjectColorMap", () => {
  it("gives every subject in a document a distinct colour", () => {
    // Regression: a content hash put Mathematics and English on the same blue.
    const subjects = ["English", "Mathematics", "Physics", "Chemistry", "Biology", "Thai"];
    const colors = buildSubjectColorMap(
      subjects.map((subject, index) =>
        session({ wiseSessionId: `s${index}`, dateKey: "2026-08-03", subject })),
    );
    expect(colors.size).toBe(subjects.length);
    expect(new Set(colors.values()).size).toBe(subjects.length);
  });

  it("keeps one colour per subject across repeats", () => {
    const colors = buildSubjectColorMap([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Mathematics" }),
      session({ wiseSessionId: "b", dateKey: "2026-08-05", subject: "English" }),
      session({ wiseSessionId: "c", dateKey: "2026-08-10", subject: "Mathematics" }),
    ]);
    expect(colors.size).toBe(2);
    expect(colors.get("Mathematics")).not.toBe(colors.get("English"));
  });

  it("is deterministic, so admin preview and parent page agree", () => {
    const sessions = [
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Mathematics" }),
      session({ wiseSessionId: "b", dateKey: "2026-08-04", subject: "Physics" }),
    ];
    expect([...buildSubjectColorMap(sessions)]).toEqual([...buildSubjectColorMap(sessions)]);
  });
});

describe("ScheduleMonthCalendar", () => {
  it("renders a 42-cell grid with Monday-start headers", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html.match(/data-testid="schedule-day-cell"/g)).toHaveLength(42);
    expect(html.indexOf(">Mo<")).toBeLessThan(html.indexOf(">Su<"));
  });

  it("shows every class on a busy day — never a '+N more' overflow", () => {
    // A parent-facing document must not silently hide a class.
    const busy = Array.from({ length: 4 }, (_, index) =>
      session({
        wiseSessionId: `s${index}`,
        dateKey: "2026-08-20",
        subject: `Subject ${index}`,
        startLabel: `0${index + 6}:00`,
      }));
    const html = render(busy);
    for (let index = 0; index < 4; index += 1) {
      expect(html).toContain(`Subject ${index}`);
    }
    expect(html).not.toMatch(/\+\d+ more/);
  });

  it("renders the TBC placeholder rather than an empty teacher line", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-13", teacherName: TEACHER_TBC }),
    ]);
    expect(html).toContain(TEACHER_TBC);
  });

  it("right-aligns the day number and the today badge alike", () => {
    // Regression: `text-right` could not position an inline-flex today badge,
    // so the badge drifted to the left of its cell.
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-05" })], "2026-08-05");
    expect(html).toContain("flex justify-end");
    expect(html).not.toContain("ml-auto inline-flex");
    expect(html).toContain("rounded-full");
  });

  it("renders both the month grid and the mobile week list", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).toContain("schedule-month-grid");
    expect(html).toContain("schedule-mobile-list");
    // Print CSS hides the list so a printed month never duplicates a class.
    expect(html).toContain("lg:hidden");
  });

  it("shows an explicit empty state instead of a blank grid", () => {
    const html = render([]);
    expect(html).toContain("No classes scheduled in August 2026");
    expect(html).not.toContain('data-testid="schedule-day-cell"');
  });

  it("labels a session with its time range, subject and teacher", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Physics", teacherName: "Kru Ploy" }),
    ]);
    expect(html).toContain("16:00–17:30");
    expect(html).toContain("Physics");
    expect(html).toContain("Kru Ploy");
  });

  it("drops the dash when Wise gave no end time", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", endLabel: "", endTime: null }),
    ]);
    expect(html).not.toContain("16:00–");
    expect(html).toContain("16:00");
  });
});
