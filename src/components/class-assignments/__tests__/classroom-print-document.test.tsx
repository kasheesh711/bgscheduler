import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassroomPrintDocument } from "../classroom-print-document";
import { buildClassroomPrintDay, type ClassroomPrintReport } from "@/lib/classrooms/print-report";
import type { PrintRoster } from "@/lib/classrooms/print-roster";

const run = { id: "run", assignmentDate: "2099-09-12", changeSummary: {} };
const row = (id: string, patch: Partial<Parameters<typeof buildClassroomPrintDay>[1][number]> = {}) => ({
  id, runId: "run", canonicalKey: id, tutorDisplayName: `Tutor ${id}`, wiseSessionId: id, wiseClassId: "class",
  startTime: new Date("2099-09-12T09:00:00Z"), endTime: new Date("2099-09-12T10:00:00Z"),
  startMinute: 540, endMinute: 600, sessionType: "OFFLINE", assignedRoom: "Room A", status: "assigned", publishStatus: "success", ...patch,
});
const catalog = [{ id: "a", name: "Room A", sortOrder: 0, capacity: 5, active: true }];
const roster = (patch: Partial<PrintRoster> = {}): PrintRoster => ({ students: ["Student One"], studentCount: 1, rosterStatus: "verified", sessionState: "current", warnings: [], ...patch });

function fixtureReport(): ClassroomPrintReport {
  const rows = [row("one")];
  const rosters = new Map([["one", roster()]]);
  const day = buildClassroomPrintDay(run, rows, catalog, rosters);
  return { generatedAt: "2099-09-11T10:00:00Z", rosterCheckedAt: "2099-09-11T10:00:00Z", refreshFailed: false, days: [day] };
}

describe("ClassroomPrintDocument grid view", () => {
  it("shows real grid output (a room title) synchronously, with no async wait needed", () => {
    const report = fixtureReport();
    const html = renderToStaticMarkup(<ClassroomPrintDocument report={report} view="grid" missingDates={[]} />);
    expect(html).toContain("Room A");
  });

  it("never renders tutor/room card markup for the grid view", () => {
    const report = fixtureReport();
    const html = renderToStaticMarkup(<ClassroomPrintDocument report={report} view="grid" missingDates={[]} />);
    // ClassroomPrintCard always carries data-print-card; grid view must never mount one (cards:[] for every day).
    expect(html).not.toContain("data-print-card");
  });
});

describe("ClassroomPrintDocument tutors view (regression smoke)", () => {
  it("renders without throwing, offers all 3 print-grouping options, and keeps tutor cards in the hidden measure div", () => {
    const report = fixtureReport();
    const html = renderToStaticMarkup(<ClassroomPrintDocument report={report} view="tutors" missingDates={[]} />);
    // React SSR injects selected="" onto the option matching the controlled value, so match loosely on value+label pairs.
    expect(html).toMatch(/<option value="tutors"[^>]*>By tutor<\/option>/);
    expect(html).toContain('<option value="rooms">By room</option>');
    expect(html).toContain('<option value="grid">Full day (all rooms)</option>');
    expect(html).toContain("data-print-card");
  });
});
