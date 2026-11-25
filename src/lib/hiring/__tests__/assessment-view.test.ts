import { describe, expect, it } from "vitest";
import { arrivals, assessmentRows, bangkokDay, hireBlockers, laneOf, paperScore } from "../assessment-view";
import { LEGACY_RUBRIC_ITEMS, RUBRIC_ITEMS, type MockRubric } from "../marking-sheet";

const NOW = new Date("2026-11-04T05:00:00Z"); // Wednesday, noon in Bangkok.
const at = (iso: string) => new Date(iso);
const visit = (id: string, candidateId: string, examIso: string, patch = {}) => [
  { candidateId, kind: "paper" as const, status: "confirmed", startTime: at(examIso), endTime: at(examIso), visitId: id, interviewerKey: null, subjects: ["Mathematics"], ...patch },
  { candidateId, kind: "mock" as const, status: "confirmed", startTime: new Date(at(examIso).getTime() + 7200000), endTime: at(examIso), visitId: id, interviewerKey: "Peat", subjects: ["Mathematics"], ...patch },
];
const result = (status = "done", source = "ai") => ({ candidateId: "c", subject: "Mathematics", status, source });

describe("assessmentRows", () => {
  it("makes one row for a visit, with the mock time and the head", () => {
    const rows = assessmentRows(visit("v", "c", "2026-11-05T03:00:00Z"), [], [], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "v", candidateId: "c", subject: "Mathematics", headKey: "Peat", started: false, history: false });
    expect(rows[0].mockAt?.toISOString()).toBe("2026-11-05T05:00:00.000Z");
  });
  it("keeps a finished visit and a no-show, and drops a cancelled visit when the person has another", () => {
    const rows = assessmentRows(
      [...visit("past", "a", "2026-11-01T03:00:00Z"), ...visit("gone", "a", "2026-11-06T03:00:00Z", { status: "cancelled" }), ...visit("absent", "d", "2026-11-02T03:00:00Z", { status: "no_show" })],
      [],
      [],
      NOW,
    );
    expect(rows.map((r) => [r.key, r.status, r.started])).toEqual([["absent", "no_show", true], ["past", "confirmed", true]]);
  });
  it("keeps a row for someone whose only visit was cancelled, so a person can still reject them", () => {
    const rows = assessmentRows(visit("gone", "b", "2026-11-06T03:00:00Z", { status: "cancelled" }), [], [], NOW);
    expect(rows.map((r) => [r.key, r.status])).toEqual([["gone", "cancelled"]]);
    expect(laneOf(rows[0], [], [], [], false, NOW)).toBe("finished");
  });
  it("makes a row for each old-flow booking", () => {
    const old = { candidateId: "c", status: "confirmed", startTime: at("2026-11-05T03:00:00Z"), endTime: at("2026-11-05T04:00:00Z"), interviewerKey: "Ek", subjects: ["Physics"] };
    const rows = assessmentRows([{ ...old, kind: "paper" }, { ...old, kind: "mock", startTime: at("2026-11-06T03:00:00Z") }], [], [], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[1].headKey).toBe("Ek");
  });
  it("lists what is coming first, soonest first, then the past, newest first, then tracker history", () => {
    const rows = assessmentRows(
      [...visit("later", "a", "2026-11-09T03:00:00Z"), ...visit("soon", "b", "2026-11-05T03:00:00Z"), ...visit("old", "d", "2026-10-01T03:00:00Z"), ...visit("recent", "e", "2026-11-01T03:00:00Z")],
      [{ ...result("done", "tracker"), candidateId: "h", history: { date: "24 ก.ย. 2026" } }],
      [],
      NOW,
    );
    expect(rows.map((r) => r.key)).toEqual(["soon", "later", "recent", "old", "history:h"]);
    expect(rows[4]).toMatchObject({ dateText: "24 ก.ย. 2026", history: true });
  });
  it("gives one history row per person, and none for someone with a booking", () => {
    const tracker = (candidateId: string) => ({ ...result("done", "tracker"), candidateId });
    const rows = assessmentRows(visit("v", "booked", "2026-11-05T03:00:00Z"), [tracker("h"), tracker("booked")], [tracker("h")], NOW);
    expect(rows.map((r) => r.key)).toEqual(["v", "history:h"]);
  });
});

describe("hireBlockers", () => {
  it("needs a paper and a mock", () => {
    expect(hireBlockers([], [])).toHaveLength(2);
    expect(hireBlockers([result()], [result()])).toEqual([]);
  });
  it("blocks on any unfinished paper, including one of several", () => {
    expect(hireBlockers([result(), result("marking")], [result()])[0]).toMatch(/A paper is not finished/);
    expect(hireBlockers([result("failed")], [result()])[0]).toMatch(/not finished/);
    expect(hireBlockers([result("uploaded")], [result()])[0]).toMatch(/not finished/);
  });
  it("blocks on a result a person has not cleared", () => {
    expect(hireBlockers([result("needs_check")], [result()])[0]).toMatch(/check/);
    expect(hireBlockers([result()], [result("needs_check")])[0]).toMatch(/check/);
  });
  it("blocks hire until the school's required checks are Yes on a new-form mock", () => {
    const items = Object.fromEntries(RUBRIC_ITEMS.map((id) => [id, 7])) as MockRubric["items"];
    const mock = (checksDone: boolean | null) => ({ ...result(), rubric: { items, comments: "", checksDone } });
    expect(hireBlockers([result()], [mock(true)])).toEqual([]);
    expect(hireBlockers([result()], [mock(false)])).toEqual(["The school's required checks are not Yes on the mock result."]);
    expect(hireBlockers([result()], [mock(null)])).toEqual(["The school's required checks are not Yes on the mock result."]);
    // The old 10-item form has no checks answer, so it does not block.
    const legacy = Object.fromEntries(LEGACY_RUBRIC_ITEMS.map((id) => [id, 7])) as MockRubric["items"];
    expect(hireBlockers([result()], [{ ...result(), rubric: { items: legacy, comments: "" } }])).toEqual([]);
  });
  it("needs one finished mock, so a failed second mock does not block", () => {
    expect(hireBlockers([result()], [result(), result("failed")])).toEqual([]);
    expect(hireBlockers([result()], [result("failed")])[0]).toMatch(/mock is not finished/);
  });
  it("does not count a past tracker result as a result of this visit", () => {
    expect(hireBlockers([result("done", "tracker")], [result("done", "tracker")])).toEqual(["No paper result yet.", "No mock result yet."]);
    expect(hireBlockers([result("done", "tracker"), result()], [result()])).toEqual([]);
  });
});

describe("laneOf", () => {
  const row = (patch = {}) => ({ key: "k", candidateId: "c", at: at("2026-11-03T03:00:00Z"), mockAt: null as Date | null, dateText: null, subject: "M", headKey: "Peat", status: "confirmed", started: true, history: false, kinds: ["paper", "mock"] as ("paper" | "mock")[], ...patch });
  it("asks for the scan of a past test, but not of a no-show, a future visit or a decided person", () => {
    expect(laneOf(row(), [], [], [], false, NOW)).toBe("late_scan");
    expect(laneOf(row({ mockAt: at("2026-11-06T04:00:00Z") }), [], [], [], false, NOW)).toBe("scan");
    expect(laneOf(row({ mockAt: at("2026-11-04T04:00:00Z") }), [], [], [], false, NOW)).toBe("late_scan");
    expect(laneOf(row({ status: "no_show" }), [], [], [], false, NOW)).toBe("finished");
    expect(laneOf(row({ started: false }), [], [], [], false, NOW)).toBe("upcoming");
    expect(laneOf(row(), [], [], [], true, NOW)).toBe("finished");
  });
  it("still asks for the scan when only a tracker result exists, and asks an old-flow mock only for its rubric", () => {
    expect(laneOf(row(), [result("done", "tracker")], [], [], false, NOW)).toBe("late_scan");
    expect(laneOf(row({ kinds: ["mock"], mockAt: at("2026-11-03T03:00:00Z") }), [], [], [], false, NOW)).toBe("rubric");
  });
  it("puts a result to check or a failed marking first, even before the visit", () => {
    expect(laneOf(row({ started: false }), [result("needs_check")], [], ["needs_check"], false, NOW)).toBe("check");
    expect(laneOf(row(), [result("failed")], [], ["failed"], false, NOW)).toBe("check");
    expect(laneOf(row(), [{ ...result("marking"), stuck: true }], [], ["marking"], false, NOW)).toBe("check");
  });
  it("waits while a head checks or the AI marks, and sends a not-passed paper to a decision", () => {
    expect(laneOf(row(), [result()], [], ["checking"], false, NOW)).toBe("waiting");
    expect(laneOf(row(), [result("marking")], [], ["marking"], false, NOW)).toBe("waiting");
    expect(laneOf(row(), [result()], [], ["fail"], false, NOW)).toBe("decide");
  });
  it("asks for the rubric after the mock, then offers the decision", () => {
    const after = row({ mockAt: at("2026-11-04T04:00:00Z") });
    expect(laneOf(after, [result()], [], ["pass"], false, NOW)).toBe("rubric");
    expect(laneOf(after, [result()], [result()], ["pass"], false, NOW)).toBe("decide");
    expect(laneOf(row({ mockAt: at("2026-11-06T04:00:00Z") }), [result()], [], ["pass"], false, NOW)).toBe("waiting");
  });
  it("never puts tracker history in the work list", () => {
    expect(laneOf(row({ history: true }), [result("done", "tracker")], [result("done", "tracker")], [], false, NOW)).toBe("finished");
  });
});

describe("paperScore", () => {
  const config = { paperPassRules: [{ subject: "Mathematics" as const, level: "IGCSE / GCSE" as const, percent: 80 }, { subject: "Mathematics" as const, level: "AS / A-Level" as const, percent: 80 }] };
  const q = (level: "IGCSE / GCSE" | "AS / A-Level", marks: number, max: number) => ({ id: level + marks, level, marks, max, reason: "", attempted: true, readable: true });
  const paper = (questions: ReturnType<typeof q>[], status = "done") => ({ id: "p", subject: "Mathematics", status, marks: { questions }, history: null });
  it("names the best try against its pass mark when nothing passed, as the head's check does", () => {
    expect(paperScore(paper([q("IGCSE / GCSE", 37, 49), q("AS / A-Level", 12, 21)]), config)).toMatchObject({ verdict: "fail", percent: 75.5, passMark: 80, level: "IGCSE / GCSE", scored: 37, max: 49 });
  });
  it("names the highest level passed", () => {
    expect(paperScore(paper([q("IGCSE / GCSE", 19, 20), q("AS / A-Level", 17, 20)]), config)).toMatchObject({ verdict: "pass", percent: 85, level: "AS / A-Level" });
  });
  it("shows a head's open check, then the head's answer", () => {
    const marks = [q("IGCSE / GCSE", 37, 49)];
    expect(paperScore(paper(marks), config, { resultId: "p", percent: 75.5, head: "Aey", headLabel: "Kru Aey", done: null })).toMatchObject({ verdict: "checking", head: "Kru Aey" });
    expect(paperScore(paper(marks), config, { resultId: "p", percent: 75.5, done: { passed: false, percent: 75.5, head: "Kru Aey" } })).toMatchObject({ verdict: "fail", percent: 75.5, head: "Kru Aey" });
  });
  it("lets current marks win over a head's answer given before they changed, and keeps a pass's own percent", () => {
    const passing = { ...paper([q("IGCSE / GCSE", 45, 49)]), updatedAt: "2026-11-04T05:00:00Z" };
    expect(paperScore(passing, config, { resultId: "p", percent: 75.5, done: { passed: false, percent: 75.5, head: "Kru Aey", at: "2026-11-03T05:00:00Z" } })).toMatchObject({ verdict: "pass", percent: 91.8 });
    expect(paperScore(passing, config, { resultId: "p", percent: 75.5, done: { passed: true, percent: 99, head: "Kru Aey", at: "2026-11-05T05:00:00Z" } })).toMatchObject({ verdict: "pass", percent: 91.8, head: "Kru Aey" });
  });
  it("says marking, failed or needs check before any verdict", () => {
    expect(paperScore(paper([], "marking"), config).verdict).toBe("marking");
    expect(paperScore({ ...paper([]), marks: null, status: "failed" }, config).verdict).toBe("failed");
    expect(paperScore(paper([q("IGCSE / GCSE", 45, 49)], "needs_check"), config).verdict).toBe("needs_check");
  });
});

describe("arrivals", () => {
  it("lists today's and the next six days' tests and mocks in time order, gives a test its visit's head, and drops cancelled ones", () => {
    const list = arrivals([
      ...visit("v", "c", "2026-11-04T01:00:00Z"),
      ...visit("x", "d", "2026-11-05T03:00:00Z", { status: "cancelled" }),
      ...visit("old", "e", "2026-11-03T17:30:00Z"),
      ...visit("far", "f", "2026-11-11T03:00:00Z"),
    ], NOW);
    expect(list.map((b) => [b.candidateId, b.kind, b.head])).toEqual([["e", "paper", "Peat"], ["e", "mock", "Peat"], ["c", "paper", "Peat"], ["c", "mock", "Peat"]]);
  });
  it("starts the day at Bangkok midnight", () => {
    expect(bangkokDay(NOW).toISOString()).toBe("2026-11-03T17:00:00.000Z");
  });
});
