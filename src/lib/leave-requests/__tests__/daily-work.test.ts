import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import september from "./fixtures/september-roster.json";
import { parseRosterMonth, rosterMonth } from "../roster";
import { humanStatus, normalizationInput, normalizationKey, normalizeLeave, validateInterpretation } from "../normalization";
import { parseLeaveRequestSheetRows } from "../parser";
import { buildFamilyWork } from "../work-reconcile";
import { familyComplete, formatWorkTime, processingDate, sessionOverlapsLeave, sortAssignments } from "../work-model";
import { LeaveAssignmentCard } from "@/components/leave-requests/leave-requests-workspace";
import type { ClassWork, LeaveInterpretation, WorkAssignment, WorkStudent } from "../work-types";

const student = (key: string, parent: string | null): WorkStudent => ({ studentKey: key, wiseStudentId: key, name: key, parentName: parent, contacts: [] });
const classTask = (students: WorkStudent[]): ClassWork => ({ id: "task", assignmentId: "assignment", wiseSessionId: "wise", wiseClassId: "class", startTime: "2026-09-15T03:00:00.000Z", endTime: "2026-09-15T04:00:00.000Z", subject: "Maths", title: "Maths", students, revision: "r1", sourceRequestIds: [], wiseStatus: "FUTURE", issue: null, active: true, cancelled: null, version: 1 });
const input = () => normalizationInput(parseLeaveRequestSheetRows([[], [46273, "Buzz", "buzz@example.com", 46277, 46277, "Morning (Before 12)", "8:00-12:00 / 15:00 - 19:00", "Yes", "2", "", "", "", "", "", "", "", "", "", "Done // Care"]])[0]);

afterEach(() => vi.unstubAllGlobals());

describe("Bangkok daily work", () => {
  it("makes 15 September work due on 8 September, including month/year boundaries", () => {
    expect(processingDate("2026-09-15")).toBe("2026-09-08");
    expect(processingDate("2026-10-03")).toBe("2026-09-26");
    expect(processingDate("2027-01-02")).toBe("2026-12-26");
    expect(processingDate("2026-09-10") < "2026-09-08").toBe(true);
  });
  it("uses original UTC times exactly once, and supports split windows", () => {
    expect(formatWorkTime("2026-09-12T03:00:00Z")).toBe("10:00");
    const windows = [{ startDate: "2026-09-12", endDate: "2026-09-12", startMinute: 480, endMinute: 720 }, { startDate: "2026-09-12", endDate: "2026-09-12", startMinute: 900, endMinute: 1140 }];
    expect(sessionOverlapsLeave(new Date("2026-09-12T03:00Z"), new Date("2026-09-12T04:00Z"), windows)).toBe(true);
    expect(sessionOverlapsLeave(new Date("2026-09-12T06:00Z"), new Date("2026-09-12T07:00Z"), windows)).toBe(false);
    expect(sessionOverlapsLeave(new Date("2026-09-12T08:00Z"), new Date("2026-09-12T09:00Z"), windows)).toBe(true);
  });
  it("sorts late arrivals before today's work and completed assignments", () => {
    const items = [{ id: "done", done: true, dueDate: "2026-09-01", classDate: "2026-09-08", teacherName: "Z" }, { id: "today", done: false, dueDate: "2026-09-08", classDate: "2026-09-15", teacherName: "A" }, { id: "late", done: false, dueDate: "2026-09-03", classDate: "2026-09-10", teacherName: "B" }];
    expect(sortAssignments(items as WorkAssignment[], "2026-09-08").map((a) => a.id)).toEqual(["late", "today", "done"]);
  });
});

describe("actual September roster", () => {
  it("resolves coloured blank cells against that month's shift legend", () => {
    const day = parseRosterMonth(september).filter((s) => s.date === "2026-09-08");
    expect(day.map((s) => [s.personKey, s.status, s.startMinute, s.endMinute])).toEqual([
      ["petchy", "working", 480, 1020], ["care", "off", null, null], ["palm", "working", 600, 1140], ["aya", "working", 540, 1080], ["muk", "sick", null, null],
    ]);
    expect(day[0].note).toBeNull();
    expect(parseRosterMonth(september)).toHaveLength(150);
  });
  it("interprets swap notes on their cell date and excludes off/unknown cells", () => {
    const all = parseRosterMonth(september);
    const swap = all.find((s) => /SW off 8\/9/i.test(s.note ?? ""));
    expect(swap).toBeDefined();
    expect(swap?.status).toBe("off");
    expect(swap?.date).not.toBe("2026-09-08");
    expect(parseRosterMonth({ properties: { title: "Sep_26" }, data: [] })).toEqual([]);
    expect(rosterMonth("July_26")).toBe("2026-07");
    expect(rosterMonth("Jan 27")).toBe("2027-01");
    expect(rosterMonth("Notes")).toBeNull();
  });
});

describe("automatic interpretation", () => {
  it("caches meaningful input while preserving human corrections", () => {
    const before = input();
    expect(normalizationKey(before)).toBe(normalizationKey({ ...before, humanStatus: humanStatus("Done // Care [BGScheduler: families 2/2, Wise 1/1]") }));
    expect(normalizationKey(before)).not.toBe(normalizationKey({ ...before, humanStatus: "เต็มวันแทน" }));
    expect(normalizationKey(before)).not.toBe(normalizationKey(before, "another-model"));
    expect(normalizationKey(before)).not.toBe(normalizationKey(before, undefined, "new-prompt"));
  });
  it("calls Luna low via Responses and automatically accepts a full-day correction", async () => {
    const value: LeaveInterpretation = { disposition: "active", windows: [{ startDate: "2026-10-03", endDate: "2026-10-03", startMinute: 0, endMinute: 1440 }], completion: [], explanation: "The human Status corrects the leave to a full day.", errors: [] };
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ output_text: JSON.stringify(value) }) });
    vi.stubGlobal("fetch", request);
    const result = await normalizeLeave({ ...input(), startDate: "2026-10-03", endDate: "2026-10-03", humanStatus: "เต็มวันแทน" });
    expect(result).toEqual(value);
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.input[1].content).toContain("เต็มวันแทน");
    vi.unstubAllEnvs();
  });
  it("retains duplicate provenance and date-specific partial completion", () => {
    const source = { ...input(), startDate: "2026-09-06", endDate: "2026-09-14", humanStatus: "วันที่ 6 ยกเลิกคลาสและแจ้งผู้ปกครองเรียบร้อย // เหลือวันที่ 11-14 Sep" };
    const value: LeaveInterpretation = { disposition: "active", windows: [{ startDate: source.startDate, endDate: source.endDate, startMinute: 0, endMinute: 1440 }], completion: [{ dates: ["2026-09-06"], parentsInformed: true, classesCancelled: true, actorLabel: null, evidence: "วันที่ 6 ยกเลิกคลาสและแจ้งผู้ปกครองเรียบร้อย" }], explanation: "6 September completed; later dates remain.", errors: [] };
    expect(validateInterpretation(value, source).completion[0].dates).toEqual(["2026-09-06"]);
    expect(validateInterpretation({ ...value, disposition: "duplicate", completion: [] }, source).disposition).toBe("duplicate");
    expect(() => validateInterpretation({ ...value, windows: [{ ...value.windows[0], startDate: "2026-02-31" }] }, source)).toThrow();
    expect(() => validateInterpretation({ ...value, completion: [{ ...value.completion[0], evidence: "Made up" }] }, source)).toThrow();
  });
});

describe("families and shared classes", () => {
  it("groups siblings but keeps unrelated and unknown families separate", () => {
    const task = classTask([student("Sibling A", "Parent A"), student("Sibling B", "Parent A"), student("Other child", "Parent B"), student("Unknown 1", null), student("Unknown 2", null)]);
    const families = buildFamilyWork([task]);
    expect(families).toHaveLength(4);
    expect(families.find((f) => f.label === "Parent A")?.students).toHaveLength(2);
    expect(families.every((f) => f.coverage[0].sessionId === "wise")).toBe(true);
  });
  it("uses verified relationships and reopens only families whose class content changed", () => {
    const first = student("A", null), second = student("B", null);
    first.contacts = second.contacts = [{ id: "verified-parent", name: null, url: null }];
    expect(buildFamilyWork([classTask([first, second])])).toHaveLength(1);
    const prior = buildFamilyWork([classTask([student("A", "Parent A")])])[0];
    const next = buildFamilyWork([classTask([student("A", "Parent A"), student("B", "Parent B")])]).find((f) => f.label === "Parent A")!;
    expect(next.coverage).toEqual(prior.coverage);
    expect(familyComplete({ informed: { source: "admin", actorEmail: "care@example.com", actorName: "Care", completedAt: "2026-09-08T03:00Z", recordedAt: "2026-09-08T03:00Z", note: null }, coverage: [{ sessionId: "wise", revision: "new-time" }], informedCoverage: prior.coverage })).toBe(false);
  });
  it("renders ownership, class date, due date and accessible real checkboxes inline", () => {
    const task = classTask([student("A", "Parent")]);
    const assignment: WorkAssignment = { id: "assignment", teacherKey: "buzz", teacherName: "Buzz", classDate: "2026-09-15", dueDate: "2026-09-08", ownerEmail: "care@example.com", ownerName: "Care", assignedDate: "2026-09-08", sourceRequestIds: [], issue: null, done: false, version: 1, classes: [task], families: buildFamilyWork([task]).map((f) => ({ ...f, id: "family", assignmentId: "assignment", informed: null, informedCoverage: [], active: true, version: 1 })) };
    const html = renderToStaticMarkup(React.createElement(LeaveAssignmentCard, { assignment, viewerEmail: "care@example.com", roster: [], admins: [], date: "2026-09-08", pending: new Set<string>(), expanded: true, onExpand: () => {}, onMutate: () => {}, onDetails: () => {} }));
    expect(html).toContain("Tue 15 Sep"); expect(html).toContain("Tue 8 Sep"); expect(html).toContain("Care");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Parent informed"); expect(html).toContain("Cancelled in Wise"); expect(html).toContain("10:00");
    expect(html).not.toContain("17:00");
  });
});
