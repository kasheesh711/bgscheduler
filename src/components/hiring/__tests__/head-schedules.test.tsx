import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HeadWeek } from "@/lib/hiring/head-schedule";
import { HeadCalendar, HeadSchedules } from "../head-schedules";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const day = (date: string, office: { start: string; end: string } | null, blocks: HeadWeek["days"][number]["blocks"] = []) => ({
  date,
  office,
  blocks,
});
const hours = { start: "10:00", end: "16:00" };
const week = (patch: Partial<HeadWeek> = {}): HeadWeek => ({
  key: "Peat",
  name: "Kasidej (Peat)",
  subjects: ["Mathematics", "Physics"],
  weekStart: "2026-11-02",
  mocks: 1,
  limit: 2,
  stale: false,
  days: [
    day("2026-11-02", hours, [
      { kind: "exam", start: "10:00", end: "12:00", candidateId: "c1", candidate: "Nina Porter", subject: "Mathematics", clash: false },
      { kind: "mock", start: "12:00", end: "13:00", candidateId: "c1", candidate: "Nina Porter", subject: "Mathematics", clash: false },
      { kind: "wise", start: "15:00", end: "16:00", clash: false },
    ]),
    day("2026-11-03", null),
    day("2026-11-04", hours),
    day("2026-11-05", hours),
    day("2026-11-06", hours),
  ],
  visits: [
    {
      candidateId: "c1",
      candidate: "Nina Porter",
      subject: "Mathematics",
      examStart: "2026-11-02T03:00:00.000Z",
      mockStart: "2026-11-02T05:00:00.000Z",
      mockEnd: "2026-11-02T06:00:00.000Z",
      clash: false,
    },
  ],
  ...patch,
});
const calendar = (w: HeadWeek) => renderToStaticMarkup(<HeadCalendar week={w} onOpen={() => {}} />);

describe("HeadCalendar", () => {
  it("draws five day columns, hatches a day out of office, and labels every kind of block", () => {
    const html = calendar(week());
    for (const label of ["Mon 2", "Tue 3", "Wed 4", "Thu 5", "Fri 6"]) expect(html).toContain(label);
    expect(html).toContain("Not in office");
    expect(html.match(/calOff/g)).toHaveLength(1);
    expect(html).toContain("09:00");
    expect(html).toContain("19:00");
    expect(html).toContain("Exam · head not needed");
    expect(html).toContain("Wise class");
    // The mock opens the candidate; the exam and the class do not.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Office days: Mon 10:00–16:00 · Wed 10:00–16:00");
    expect(html).toContain("Mock, Nina Porter · Mathematics, 12:00 to 13:00");
    expect(html).toContain("Free in office hours");
    expect(html).toContain("Exam (does not need the head)");
  });

  it("places blocks at 56 px an hour from 09:00", () => {
    const html = calendar(week());
    // Mock at 12:00 is 3 hours down: 168 px, plus the 1 px inset. One hour long: 56 - 2.
    expect(html).toContain("top:169px;height:54px");
  });

  it("shows no banner for good data, a stale banner for old data, and a clash banner naming the candidate", () => {
    const clean = calendar(week());
    expect(clean).not.toContain("old or incomplete");
    expect(clean).not.toContain("Staff must act");
    expect(calendar(week({ stale: true }))).toContain("old or incomplete");
    const clash = week();
    clash.visits[0].clash = true;
    clash.days[0].blocks[1].clash = true;
    const html = calendar(clash);
    expect(html).toContain("overlaps the mock with Nina Porter");
    expect(html).toContain("The app did not move the visit. Staff must act.");
    expect(html).toContain("Mock · clash");
    expect(html).toContain("bClash");
  });

  it("carries no student name and no session title", () => {
    expect(calendar(week())).not.toMatch(/studentName|title="/);
  });
});

describe("HeadSchedules", () => {
  const heads = [
    { canonicalKey: "Peat", subjects: ["Mathematics" as const], email: "peat@example.com" },
    { canonicalKey: "Ek", subjects: ["Physics" as const], email: "ek@example.com" },
  ];
  const view = (bookings: unknown[] = []) =>
    renderToStaticMarkup(<HeadSchedules heads={heads} bookings={bookings as never} onOpenCandidate={() => {}} />);

  it("shows a switch for each head, a week switch that starts on the current week, and a loading state", () => {
    const html = view();
    expect(html).toContain("Peat");
    expect(html).toContain("Ek");
    expect(html).toContain("Loading schedule");
    // The current week is the first week: Previous is off, Next is on.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
  });

  it("counts a head's confirmed mocks in the shown week on the tab", () => {
    const html = view([
      { kind: "mock", status: "confirmed", interviewerKey: "Peat", startTime: new Date() },
      { kind: "mock", status: "cancelled", interviewerKey: "Peat", startTime: new Date() },
      { kind: "paper", status: "confirmed", interviewerKey: null, startTime: new Date() },
    ]);
    expect(html).toMatch(/Peat <span[^>]*>1<\/span>/);
    expect(html).toMatch(/Ek <span[^>]*>0<\/span>/);
  });

  it("explains an empty head list", () => {
    expect(renderToStaticMarkup(<HeadSchedules heads={[]} bookings={[]} onOpenCandidate={() => {}} />)).toContain("Rules and setup");
  });
});
