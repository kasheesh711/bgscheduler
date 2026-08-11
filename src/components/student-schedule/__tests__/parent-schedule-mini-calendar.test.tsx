import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CHIP_CAP,
  ParentScheduleMiniCalendar,
  buildParentMiniCalendarModel,
} from "../parent-schedule-mini-calendar";
import type { StudentSchedulePayload, StudentScheduleSession } from "@/lib/student-schedule/types";

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

describe("buildParentMiniCalendarModel", () => {
  it("builds 42 Monday-start cells", () => {
    const model = buildParentMiniCalendarModel(payload([]));
    expect(model.days).toHaveLength(42);
    // August 2026 starts on a Saturday; the Monday-start grid opens on 27 July.
    expect(model.days[0].dateKey).toBe("2026-07-27");
    expect(model.days[0].inMonth).toBe(false);
  });

  it("builds one chip per session with the shared subject colours", () => {
    const model = buildParentMiniCalendarModel(
      payload([
        session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Mathematics" }),
        session({ wiseSessionId: "b", dateKey: "2026-08-03", subject: "English" }),
      ]),
    );
    const day = model.days.find((cell) => cell.dateKey === "2026-08-03")!;
    expect(day.sessionCount).toBe(2);
    expect(day.chips).toEqual([
      { subject: "Mathematics", color: "#3b82f6" },
      { subject: "English", color: "#e67e22" },
    ]);
    expect(day.overflow).toBe(0);
  });

  it("caps chips at CHIP_CAP and reports the overflow", () => {
    const busy = Array.from({ length: CHIP_CAP + 2 }, (_, index) =>
      session({ wiseSessionId: `s${index}`, dateKey: "2026-08-20", subject: `Subject ${index}` }),
    );
    const day = buildParentMiniCalendarModel(payload(busy)).days.find(
      (cell) => cell.dateKey === "2026-08-20",
    )!;
    expect(day.chips).toHaveLength(CHIP_CAP);
    expect(day.overflow).toBe(2);
  });

  it("keeps out-of-month cells blank", () => {
    const model = buildParentMiniCalendarModel(
      payload([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]),
    );
    for (const cell of model.days.filter((day) => !day.inMonth)) {
      expect(cell.sessionCount).toBe(0);
      expect(cell.chips).toEqual([]);
    }
  });

  it("marks today only when todayKey is given", () => {
    const rows = [session({ wiseSessionId: "a", dateKey: "2026-08-11" })];
    const withToday = buildParentMiniCalendarModel(payload(rows), "2026-08-11");
    expect(withToday.days.filter((cell) => cell.isToday)).toHaveLength(1);
    const without = buildParentMiniCalendarModel(payload(rows));
    expect(without.days.some((cell) => cell.isToday)).toBe(false);
  });
});

describe("ParentScheduleMiniCalendar", () => {
  function render(sessions: StudentScheduleSession[], todayKey?: string) {
    return renderToStaticMarkup(
      <ParentScheduleMiniCalendar
        payload={payload(sessions)}
        todayKey={todayKey}
        onSelectDay={() => {}}
      />,
    );
  }

  it("renders 42 cells with buttons only on session days", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03" }),
      session({ wiseSessionId: "b", dateKey: "2026-08-20" }),
    ]);
    expect(html.match(/data-testid="mini-day"/g)).toHaveLength(42);
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("shows the subject name on a colour-tinted chip", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).toContain("Mathematics");
    expect(html).toContain("truncate");
    expect(html).toContain("text-[9px]");
    expect(html).toContain("background-color:rgba(59, 130, 246, 0.18)");
    expect(html).toContain("border-left:2px solid #3b82f6");
  });

  it("labels a tappable day with the Thai heading and class count", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).toContain("วันจันทร์ที่ 3");
    expect(html).toContain("คาบเรียน");
  });

  it("shows the +N overflow marker past the chip cap", () => {
    const busy = Array.from({ length: CHIP_CAP + 2 }, (_, index) =>
      session({ wiseSessionId: `s${index}`, dateKey: "2026-08-20", subject: `Subject ${index}` }),
    );
    const html = render(busy);
    expect(html).toContain("+2");
    expect(html.match(/Subject \d/g)).toHaveLength(CHIP_CAP);
  });

  it("renders no legend", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Mathematics" }),
      session({ wiseSessionId: "b", dateKey: "2026-08-05", subject: "English" }),
    ]);
    // Subjects appear once per chip only — no legend row repeats them.
    expect(html.match(/Mathematics/g)).toHaveLength(1);
    expect(html.match(/English/g)).toHaveLength(1);
  });

  it("renders all seven Monday-start Thai initials", () => {
    const html = render([]);
    for (const initial of ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"]) {
      expect(html).toContain(`>${initial}<`);
    }
  });

  it("draws the today ring only with todayKey", () => {
    const rows = [session({ wiseSessionId: "a", dateKey: "2026-08-11" })];
    expect(render(rows, "2026-08-11")).toContain("bg-primary");
    expect(render(rows)).not.toContain("bg-primary");
  });
});
