import { describe, expect, it } from "vitest";
import { buildClassroomPrintDay, printRunsSchema, printViewSchema, type ClassroomPrintReport } from "../print-report";
import type { PrintRoster } from "../print-roster";
import { buildPrintCards, paginatePrintCards, splitPrintCard } from "@/components/class-assignments/print-pagination";
const run = { id: "run", assignmentDate: "2099-09-12", changeSummary: {} };
const row = (id: string, patch: Partial<Parameters<typeof buildClassroomPrintDay>[1][number]> = {}) => ({ id, runId: "run", canonicalKey: id, tutorDisplayName: `Tutor ${id}`, wiseSessionId: id, wiseClassId: "class", startTime: new Date("2099-09-12T02:00:00Z"), endTime: new Date("2099-09-12T03:00:00Z"), startMinute: 540, endMinute: 600, sessionType: "OFFLINE", assignedRoom: "Room B", status: "assigned", publishStatus: "success", ...patch });
const catalog = [{ id: "b", name: "Room B", sortOrder: 0, capacity: 2, active: true }, { id: "a", name: "Room A", sortOrder: 1, capacity: 5, active: true }, { id: "inactive", name: "Closed", sortOrder: 2, capacity: 5, active: false }];
const roster = (patch: Partial<PrintRoster> = {}): PrintRoster => ({ students: ["Student"], studentCount: 1, rosterStatus: "verified", sessionState: "current", warnings: [], ...patch });
const report = (day: ReturnType<typeof buildClassroomPrintDay>): ClassroomPrintReport => ({ days: [day], generatedAt: "2099-09-11T10:00:00Z", rosterCheckedAt: "2099-09-11T10:00:00Z", refreshFailed: false });
describe("shared classroom print data", () => {
  it("keeps catalog ordering and empty rooms, sorts time and tutors, separates exceptions and remote classes", () => {
    const rows = [row("z"), row("a", { startMinute: 480, endMinute: 540, assignedRoom: "Room B (TV)" }), row("cancelled"), row("rescheduled"), row("remote", { status: "remote", sessionType: "ONLINE" }), row("unassigned", { status: "no_room", assignedRoom: "NO_ROOM_AVAILABLE" }), row("closed", { assignedRoom: "Closed" })];
    const rosters = new Map(rows.map(r => [r.id, roster()]));
    rosters.set("cancelled", roster({ sessionState: "cancelled", warnings: ["Cancelled. Regenerate assignments."] }));
    rosters.set("rescheduled", roster({ sessionState: "rescheduled", warnings: ["Changed. Regenerate assignments."] }));
    const day = buildClassroomPrintDay(run, rows, catalog, rosters);
    expect(day.rooms.map(room => room.name)).toEqual(["Room B", "Room A"]);
    expect(day.rooms[0].blocks.map(block => block.rowId)).toEqual(["a", "z"]); expect(day.rooms[1].blocks).toEqual([]);
    expect(day.tutors.map(tutor => tutor.canonicalKey)).toEqual(["a", "closed", "remote", "unassigned", "z"]);
    expect(day.exceptions.map(block => block.rowId)).toEqual(["cancelled", "rescheduled"]);
    expect(day.roomExceptions.map(block => block.rowId)).toEqual(["cancelled", "closed", "rescheduled", "unassigned"]);
    expect(buildPrintCards(report(day), "rooms")[0].cards.map(card => card.kind)).toEqual(["room", "room", "exceptions"]);
  });
  it("warns on capacity and missing rosters, and revisions change with names and exception state", () => {
    const make = (value: PrintRoster) => buildClassroomPrintDay(run, [row("one")], catalog, new Map([["one", value]]));
    const initial = make(roster()); expect(initial.draft).toBe(false);
    expect(make(roster()).revision).toBe(initial.revision);
    expect(make(roster({ students: ["Changed name"] })).revision).not.toBe(initial.revision);
    expect(make(roster({ sessionState: "cancelled", warnings: ["Cancelled"] })).revision).not.toBe(initial.revision);
    const crowded = make(roster({ studentCount: 3, students: ["One", "Two", "Three"] }));
    expect(crowded.draft).toBe(true); expect(crowded.rooms[0].blocks[0].notes).toContain("Enrollment exceeds room capacity: 3 students / 2 places.");
    expect(make(roster({ rosterStatus: "incomplete" })).draft).toBe(true);
  });
  it("validates one to seven distinct selected runs and backwards-compatible views", () => {
    const ids = Array.from({ length: 7 }, () => crypto.randomUUID());
    expect(printRunsSchema.parse(ids)).toEqual(ids);
    expect(printRunsSchema.safeParse([...ids, crypto.randomUUID()]).success).toBe(false);
    expect(printRunsSchema.safeParse([ids[0], ids[0]]).success).toBe(false);
    expect(printViewSchema.parse("tutors")).toBe("tutors"); expect(printViewSchema.parse("rooms")).toBe("rooms");
  });
});
describe("print pagination", () => {
  const names = Array.from({ length: 81 }, (_, i) => `Student ${i} ชื่อยาว`);
  const day = buildClassroomPrintDay(run, [row("a"), row("b", { canonicalKey: "a", startMinute: 600 })], catalog, new Map([["a", roster({ students: names, studentCount: 81 })], ["b", roster()]]));
  const measure = (card: ReturnType<typeof buildPrintCards>[number]["cards"][number]) => 50 + card.blocks.reduce((n, b) => n + 25 + 20 * b.students.length, 0);
  it("splits very large class rosters with all students present exactly once and labelled continuation", () => {
    const card = buildPrintCards(report(day), "tutors")[0].cards[0];
    const parts = splitPrintCard(card, measure, 500);
    expect(parts.length).toBeGreaterThan(3); expect(parts.every(part => part.height <= 500)).toBe(true);
    expect(parts.flatMap(part => part.card.blocks.filter(block => block.rowId === "a").flatMap(block => block.students))).toEqual(names);
    expect(parts.slice(1).every(part => part.card.continued)).toBe(true);
    expect(parts[1].card.blocks[0].continued).toBe(true);
    expect(parts.flatMap(part => part.card.blocks).filter(block => block.rowId === "b")).toHaveLength(1);
  });
  it("packs tutors in two columns and gives each room/continuation a separate full-width page", () => {
    const tutors = paginatePrintCards(buildPrintCards(report(day), "tutors"), measure, 500);
    expect(tutors.every(page => page.columns.length === 2 && !page.fullWidth)).toBe(true);
    const rooms = paginatePrintCards(buildPrintCards(report(day), "rooms"), measure, 500);
    expect(rooms.every(page => page.fullWidth && page.columns[0].length === 1)).toBe(true);
    expect(rooms.at(-1)?.columns[0][0]).toMatchObject({ title: "Room A", blocks: [] });
  });
  it("refuses an unsplittable row instead of shrinking or clipping it", () => {
    const card = buildPrintCards(report(day), "rooms")[0].cards[0];
    expect(() => splitPrintCard(card, () => 1000, 500)).toThrow("cannot fit safely");
  });
});
