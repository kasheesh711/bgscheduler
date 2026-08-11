import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ParentScheduleAgenda } from "../parent-schedule-agenda";
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
    <ParentScheduleAgenda payload={payload(sessions)} todayKey={todayKey} />,
  );
}

describe("ParentScheduleAgenda", () => {
  it("renders a section per session day only — no grid, no empty-day rows", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03" }),
      session({ wiseSessionId: "b", dateKey: "2026-08-03", startLabel: "18:00" }),
      session({ wiseSessionId: "c", dateKey: "2026-08-20" }),
    ]);
    expect(html.match(/data-testid="agenda-day"/g)).toHaveLength(2);
    expect(html.match(/data-testid="agenda-session"/g)).toHaveLength(3);
    expect(html).not.toContain('data-testid="schedule-day-cell"');
  });

  it("heads each day with the Thai weekday and day number", () => {
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).toContain("วันจันทร์ที่ 3");
  });

  it("badges today exactly once when todayKey lands on a session day", () => {
    const html = render(
      [
        session({ wiseSessionId: "a", dateKey: "2026-08-03" }),
        session({ wiseSessionId: "b", dateKey: "2026-08-11" }),
      ],
      "2026-08-11",
    );
    expect(html.match(/data-today/g)).toHaveLength(1);
    expect(html).toContain("วันนี้");
  });

  it("draws no today, past or scroll-target state without todayKey", () => {
    // The print-safe default: a document with no clock renders no clock states.
    const html = render([session({ wiseSessionId: "a", dateKey: "2026-08-03" })]);
    expect(html).not.toContain("data-today");
    expect(html).not.toContain("data-past");
    expect(html).not.toContain("agenda-scroll-target");
  });

  it("anchors the scroll target on today when today has sessions", () => {
    const html = render(
      [session({ wiseSessionId: "a", dateKey: "2026-08-11" })],
      "2026-08-11",
    );
    expect(html).toMatch(/id="agenda-scroll-target"[^>]*data-date="2026-08-11"|data-date="2026-08-11"[^>]*id="agenda-scroll-target"/);
  });

  it("anchors the next upcoming day when today has no sessions", () => {
    const html = render(
      [
        session({ wiseSessionId: "a", dateKey: "2026-08-03" }),
        session({ wiseSessionId: "b", dateKey: "2026-08-20" }),
      ],
      "2026-08-11",
    );
    const anchored = /<section[^>]*id="agenda-scroll-target"[^>]*>/.exec(html);
    expect(anchored?.[0]).toContain('data-date="2026-08-20"');
  });

  it("sets no scroll target when the whole month is in the past", () => {
    const html = render(
      [session({ wiseSessionId: "a", dateKey: "2026-08-20" })],
      "2026-08-31",
    );
    expect(html).not.toContain("agenda-scroll-target");
  });

  it("dims past days but never drops them", () => {
    const html = render(
      [
        session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Physics" }),
        session({ wiseSessionId: "b", dateKey: "2026-08-20" }),
      ],
      "2026-08-11",
    );
    const past = /<section[^>]*data-past[^>]*>/.exec(html);
    expect(past?.[0]).toContain('data-date="2026-08-03"');
    expect(past?.[0]).toContain("opacity-60");
    expect(html.match(/data-past/g)).toHaveLength(1);
    expect(html).toContain("Physics");
  });

  it("renders the TBC placeholder rather than an empty teacher line", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-13", teacherName: TEACHER_TBC }),
    ]);
    expect(html).toContain(TEACHER_TBC);
  });

  it("labels a session with its time range, subject, teacher and duration", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Physics", teacherName: "Kru Ploy" }),
    ]);
    expect(html).toContain("16:00–17:30");
    expect(html).toContain("Physics");
    expect(html).toContain("Kru Ploy");
    expect(html).toContain("90 นาที");
  });

  it("drops the dash when Wise gave no end time", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", endLabel: "", endTime: null }),
    ]);
    expect(html).not.toContain("16:00–");
    expect(html).toContain("16:00");
  });

  it("keeps days and sessions in payload order", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "Physics" }),
      session({ wiseSessionId: "b", dateKey: "2026-08-03", subject: "Chemistry", startLabel: "18:00" }),
      session({ wiseSessionId: "c", dateKey: "2026-08-20", subject: "Biology" }),
    ]);
    expect(html.indexOf("วันจันทร์ที่ 3")).toBeLessThan(html.indexOf("วันพฤหัสบดีที่ 20"));
    expect(html.indexOf("Physics")).toBeLessThan(html.indexOf("Chemistry"));
    expect(html.indexOf("Chemistry")).toBeLessThan(html.indexOf("Biology"));
  });

  it("survives a session with an empty subject", () => {
    const html = render([
      session({ wiseSessionId: "a", dateKey: "2026-08-03", subject: "" }),
    ]);
    expect(html).toContain("16:00–17:30");
    expect(html.match(/data-testid="agenda-session"/g)).toHaveLength(1);
  });
});
