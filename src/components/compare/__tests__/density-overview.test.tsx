import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompareSessionBlock, CompareTutor } from "@/lib/search/types";
import { DensityOverview, buildDensityRows } from "../density-overview";

function readSource(): string {
  return readFileSync(
    path.join(process.cwd(), "src/components/compare/density-overview.tsx"),
    "utf8",
  );
}

function makeSession(overrides: Partial<CompareSessionBlock>): CompareSessionBlock {
  return {
    title: "Session",
    studentName: "Student",
    subject: "Math",
    classType: "Class",
    sessionType: "online",
    recurrenceId: "rec-1",
    location: "Online",
    modality: "online",
    modalityConfidence: "high",
    startTime: "09:00",
    endTime: "10:30",
    weekday: 1,
    startMinute: 540,
    endMinute: 630,
    ...overrides,
  };
}

function makeTutor(overrides: Partial<CompareTutor> = {}): CompareTutor {
  return {
    tutorGroupId: "tutor-1",
    displayName: "Kevin",
    supportedModes: ["online"],
    qualifications: [],
    sessions: [],
    availabilityWindows: [],
    leaves: [],
    dataIssues: [],
    weeklyHoursBooked: 0,
    studentCount: 0,
    ...overrides,
  };
}

function makeChip(overrides: { tutorGroupId?: string; displayName?: string; color?: string } = {}) {
  return {
    tutorGroupId: "tutor-1",
    displayName: "Kevin",
    color: "#3b82f6",
    ...overrides,
  };
}

describe("buildDensityRows", () => {
  it("aggregates Monday booked minutes and session counts", () => {
    const rows = buildDensityRows(
      [
        makeTutor({
          sessions: [
            makeSession({ startMinute: 540, endMinute: 630 }),
            makeSession({ startMinute: 660, endMinute: 720 }),
          ],
          availabilityWindows: [{ weekday: 1, startMinute: 480, endMinute: 1020, modality: "online" }],
        }),
      ],
      [makeChip()],
    );

    const monday = rows[0]?.days.find((day) => day.weekday === 1);

    expect(monday?.bookedMinutes).toBe(150);
    expect(monday?.sessionCount).toBe(2);
    expect(monday?.fillRatio).toBeGreaterThan(0);
  });

  it("returns zero-fill seven-day rows for tutors with no sessions", () => {
    const rows = buildDensityRows([makeTutor()], [makeChip()]);

    expect(rows[0]?.days).toHaveLength(7);
    expect(rows[0]?.days.every((day) => day.bookedMinutes === 0)).toBe(true);
    expect(rows[0]?.days.every((day) => day.sessionCount === 0)).toBe(true);
    expect(rows[0]?.days.every((day) => day.fillRatio === 0)).toBe(true);
  });

  it("preserves weeklyHoursBooked for row labels", () => {
    const rows = buildDensityRows([makeTutor({ weeklyHoursBooked: 7.5 })], [makeChip()]);

    expect(rows[0]?.weeklyHoursBooked).toBe(7.5);
  });
});

describe("DensityOverview", () => {
  it("renders static button markup with text-equivalent labels", () => {
    const html = renderToStaticMarkup(
      <DensityOverview
        tutors={[
          makeTutor({
            weeklyHoursBooked: 1.5,
            sessions: [makeSession({ startMinute: 540, endMinute: 630 })],
          }),
        ]}
        tutorChips={[makeChip()]}
        activeDay={1}
        onDayClick={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Visible week booking density"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-current="date"');
    expect(html).toContain("Mon: Kevin, 1.5h booked, 1 session(s). Open day view.");
  });

  it("keeps the source static, read-only, and non-color-only", () => {
    const source = readSource();

    expect(source).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|insertAdjacentHTML/);
    expect(source).not.toMatch(/animate-|pulse|shimmer|transition-/);
    expect(source).not.toMatch(/bg-available|bg-blocked|bg-free-slot/);
    expect(source).not.toMatch(/utilization|% summary/);
  });
});
