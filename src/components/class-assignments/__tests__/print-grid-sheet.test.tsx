import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClassroomPrintGridSheet } from "../print-grid-sheet";
import { dateLabel } from "../classroom-print-document";
import styles from "../classroom-print.module.css";
import type { PrintDay } from "../print-pagination";
import { buildPrintGrid, splitGridColumnsIntoPages, type PrintGridRoom, type PrintGridSourceBlock } from "@/lib/classrooms/print-grid";

function day(patch: Partial<PrintDay> = {}): PrintDay {
  return { runId: "run", date: "2099-09-12", revision: "abc12345", draft: false, tutors: [], rooms: [], exceptions: [], roomExceptions: [],
    grid: buildPrintGrid([], [], 0), ...patch };
}

describe("ClassroomPrintGridSheet", () => {
  // A single-room catalog with two concurrent room-needing blocks forces roomsNeeded(2) > roomCount(1): an "over" hour.
  // The second block's room text matches no catalog room, so it lands in "No room" and forces the summary list/count too.
  const catalog: PrintGridRoom[] = [{ id: "r1", name: "Room A", sortOrder: 0, capacity: 3, hasTv: false, category: "standard" }];
  const blocks: PrintGridSourceBlock[] = [
    { rowId: "b1", tutorDisplayName: "Tutor One", startMinute: 600, endMinute: 660, room: "Room A", status: "assigned", students: ["Somchai Jaidee (Ka)"] },
    { rowId: "b2", tutorDisplayName: "Tutor Two", startMinute: 600, endMinute: 660, room: "Nonexistent Room", status: "assigned", students: ["Somsri (Su)"] },
  ];
  const grid = buildPrintGrid(blocks, catalog, 2);
  const pages = splitGridColumnsIntoPages(grid.columns);
  const fixtureDay = day({ grid });

  it("renders the eyebrow, date heading and day summary line", () => {
    const html = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(html).toContain("BeGifted · Daily classrooms · ALL ROOMS");
    expect(html).toContain(dateLabel(fixtureDay.date));
    expect(html).toContain(grid.daySummaryLine);
  });

  it("shows a Room N range label alongside No room / Online when the page carries them", () => {
    const html = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(html).toContain("Room 1");
    expect(html).toContain("No room");
    expect(html).toContain("Online");
  });

  it("marks the over-capacity rail hour in red/bold styling", () => {
    const html = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(grid.hours.find(h => h.hourStart === 600)?.over).toBe(true);
    expect(html).toContain(styles.gridRailOver);
    expect(html).toContain("2/1 rooms");
  });

  it("shows a room block with tutor, label and time range text", () => {
    const html = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(html).toContain("Tutor One");
    expect(html).toContain("Ka");
    expect(html).toContain("10:00–11:00");
  });

  it("includes the No-room column's live count in its title, and lists it in the summary panel", () => {
    const html = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(html).toContain("No room (1)");
    expect(html).toContain("Still need a room (1)");
    expect(html).toContain("Tutor Two");
  });

  it("shows the cancelled note on page 1 only, using the live cancelledCount", () => {
    const page1 = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(page1).toContain("2 cancelled in Wise not shown");
  });

  it("shows revision and page text in the footer", () => {
    const html = renderToStaticMarkup(<ClassroomPrintGridSheet day={fixtureDay} page={pages[0]} pageIndex={0} pageCount={pages.length}
      generatedAt="2099-09-11T10:00:00Z" rosterCheckedAt="2099-09-11T10:00:00Z" />);
    expect(html).toContain("Revision abc12345");
    expect(html).toContain(`Page 1 of ${pages.length}`);
  });
});
