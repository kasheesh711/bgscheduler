import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicScheduleShell } from "../public-schedule-shell";
import type { StudentSchedulePayload } from "@/lib/student-schedule/types";

const payload: StudentSchedulePayload = {
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
  sessions: [
    {
      wiseSessionId: "a",
      dateKey: "2026-08-03",
      startTime: "2026-08-03T09:00:00.000Z",
      endTime: "2026-08-03T10:30:00.000Z",
      startLabel: "16:00",
      endLabel: "17:30",
      subject: "Mathematics",
      packageName: "Maths pack",
      teacherName: "Kru Nok",
      durationMinutes: 90,
      meetingStatus: "SCHEDULED",
    },
  ],
  generatedAt: "2026-08-05T03:00:00.000Z",
};

function render() {
  return renderToStaticMarkup(
    <PublicScheduleShell
      payload={payload}
      todayKey="2026-08-11"
      headerRow={<div data-testid="slot-header" />}
      agenda={<div data-testid="slot-agenda" />}
      desktopCalendar={<div data-testid="slot-grid" />}
      footer={<div data-testid="slot-footer" />}
    />,
  );
}

function wrapperClass(html: string, testid: string): string {
  const match = new RegExp(`<div[^>]*data-testid="${testid}"[^>]*class="([^"]*)"`).exec(html)
    ?? new RegExp(`<div[^>]*class="([^"]*)"[^>]*data-testid="${testid}"`).exec(html);
  return match?.[1] ?? "";
}

describe("PublicScheduleShell", () => {
  it("SSRs the auto contract: agenda below lg, calendar at lg and up", () => {
    const html = render();
    expect(wrapperClass(html, "shell-agenda")).toContain("lg:hidden");
    const calendar = wrapperClass(html, "shell-calendar");
    expect(calendar).toContain("hidden");
    expect(calendar).toContain("lg:block");
    expect(calendar).toContain("lg:max-w-5xl");
  });

  it("splits the calendar slot into a print-safe grid and a screen-only mini calendar", () => {
    const html = render();
    expect(html).toContain("hidden lg:block print:block");
    expect(html).toContain("lg:hidden print:hidden");
    expect(html).toContain('data-testid="parent-mini-calendar"');
  });

  it("renders the toggle with Thai labels and no pressed segment before hydration", () => {
    const html = render();
    expect(html).toContain("รายการ");
    expect(html).toContain("ปฏิทิน");
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('role="group"');
    expect(html).toContain("min-h-11");
  });

  it("mounts every slot inside the scroll-owning Thai shell", () => {
    const html = render();
    for (const slot of ["slot-header", "slot-agenda", "slot-grid", "slot-footer"]) {
      expect(html).toContain(`data-testid="${slot}"`);
    }
    expect(html).toContain('lang="th"');
    expect(html).toContain("font-thai");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("sticky top-0");
  });
});
