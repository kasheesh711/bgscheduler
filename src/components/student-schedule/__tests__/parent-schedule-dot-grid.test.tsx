import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DOT_CAP,
  ParentScheduleDotGrid,
  buildParentDotGridModel,
} from "../parent-schedule-dot-grid";
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

describe("buildParentDotGridModel", () => {
  it("builds 42 Monday-start cells", () => {
    const model = buildParentDotGridModel(payload([]));
    expect(model.days).toHaveLength(42);
    // August 2026 starts on a Saturday; the Monday-start grid opens on 27 July.
    expect(model.days[0].dateKey).toBe("2026-07-27");
    expect(model.days[0].inMonth).toBe(false);
  });

  it("draws one dot per session in subject-map order", () => {
    const model = buildParentDotGridModel(
      payload([
        session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Mathematics" }),
        session({ wiseSessionId: "b", dateKey: "2026-08-03", subject: "English" }),
      ]),
    );
    const day = model.days.find((cell) => cell.dateKey === "2026-08-03")!;
    expect(day.sessionCount).toBe(2);
    expect(day.dots).toEqual(["#3b82f6", "#e67e22"]);
    expect(day.overflow).toBe(0);
  });

  it("caps dots at DOT_CAP and reports the overflow", () => {
    const busy = Array.from({ length: DOT_CAP + 1 }, (_, index) =>
      session({ wiseSessionId: `s${index}`, dateKey: "2026-08-20", subject: `Subject ${index}` }),
    );
    const day = buildParentDotGridModel(payload(busy)).days.find(
      (cell) => cell.dateKey === "2026-08-20",
    )!;
    expect(day.dots).toHaveLength(DOT_CAP);
    expect(day.overflow).toBe(1);
  });

  it("keeps out-of-month cells blank", () => {
    const model = buildParentDotGridModel(
      payload([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]),
    );
    for (const cell of model.days.filter((day) => !day.inMonth)) {
      expect(cell.sessionCount).toBe(0);
      expect(cell.dots).toEqual([]);
    }
  });

  it("marks today only when todayKey is given", () => {
    const rows = [session({ wiseSessionId: "a", dateKey: "2026-08-11" })];
    const withToday = buildParentDotGridModel(payload(rows), "2026-08-11");
    expect(withToday.days.filter((cell) => cell.isToday)).toHaveLength(1);
    const without = buildParentDotGridModel(payload(rows));
    expect(without.days.some((cell) => cell.isToday)).toBe(false);
  });

  it("builds the legend in first-appearance order without repeats", () => {
    const model = buildParentDotGridModel(
      payload([
        session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "English" }),
        session({ wiseSessionId: "b", dateKey: "2026-08-05", subject: "Mathematics" }),
        session({ wiseSessionId: "c", dateKey: "2026-08-08", subject: "English" }),
      ]),
    );
    expect(model.legend.map((entry) => entry.subject)).toEqual(["English", "Mathematics"]);
  });
});

describe("ParentScheduleDotGrid", () => {
  function render(sessions: StudentScheduleSession[], todayKey?: string) {
    return renderToStaticMarkup(
      <ParentScheduleDotGrid
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
    expect(html.match(/data-testid="dot-day"/g)).toHaveLength(42);
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("labels a tappable day with the Thai heading and class count", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).toContain("วันจันทร์ที่ 3");
    expect(html).toContain("คาบเรียน");
  });

  it("colours dots and legend chips from the shared subject map", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).toContain("background-color:#3b82f6");
    expect(html).toContain("Mathematics");
  });

  it("shows the +N overflow marker past the dot cap", () => {
    const busy = Array.from({ length: DOT_CAP + 1 }, (_, index) =>
      session({ wiseSessionId: `s${index}`, dateKey: "2026-08-20", subject: `Subject ${index}` }),
    );
    expect(render(busy)).toContain("+1");
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
