import { describe, expect, it } from "vitest";
import { assessmentRows, hireBlockers, matchesChip, matchesRange } from "../assessment-view";

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
    expect(matchesChip(rows[0], "Needs upload", [], [], false)).toBe(false);
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
  it("needs one finished mock, so a failed second mock does not block", () => {
    expect(hireBlockers([result()], [result(), result("failed")])).toEqual([]);
    expect(hireBlockers([result()], [result("failed")])[0]).toMatch(/mock is not finished/);
  });
  it("counts tracker results", () => {
    expect(hireBlockers([result("done", "tracker")], [result("done", "tracker")])).toEqual([]);
  });
});

describe("filters", () => {
  const row = (patch = {}) => ({ key: "k", candidateId: "c", at: at("2026-11-05T03:00:00Z"), mockAt: null, dateText: null, subject: "M", headKey: "Peat", status: "confirmed", started: true, history: false, kinds: ["paper", "mock"] as ("paper" | "mock")[], ...patch });
  it("finds a started visit with a missing upload, but not a no-show or a future visit", () => {
    expect(matchesChip(row(), "Needs upload", [result()], [], false)).toBe(true);
    expect(matchesChip(row(), "Needs upload", [result()], [result()], false)).toBe(false);
    expect(matchesChip(row({ status: "no_show" }), "Needs upload", [], [], false)).toBe(false);
    expect(matchesChip(row({ started: false }), "Needs upload", [], [], false)).toBe(false);
  });
  it("stops asking for an upload once a decision was sent", () => {
    expect(matchesChip(row(), "Needs upload", [], [], true)).toBe(false);
  });
  it("asks an old-flow paper booking only for its paper", () => {
    expect(matchesChip(row({ kinds: ["paper"] }), "Needs upload", [result()], [], false)).toBe(false);
    expect(matchesChip(row({ kinds: ["paper"] }), "Needs upload", [], [], false)).toBe(true);
  });
  it("never offers a decision on tracker history", () => {
    expect(matchesChip(row({ history: true }), "Ready to decide", [result("done", "tracker")], [result("done", "tracker")], false)).toBe(false);
  });
  it("finds a result to check, and who is ready to decide, unless a decision was sent", () => {
    expect(matchesChip(row(), "Needs check", [result("needs_check")], [], false)).toBe(true);
    expect(matchesChip(row(), "Ready to decide", [result()], [result()], false)).toBe(true);
    expect(matchesChip(row(), "Ready to decide", [result()], [result()], true)).toBe(false);
  });
  it("hides tracker history until asked for", () => {
    expect(matchesChip(row({ history: true }), null, [], [], false)).toBe(false);
    expect(matchesChip(row({ history: true }), "Past results", [], [], false)).toBe(true);
    expect(matchesChip(row(), "Past results", [], [], false)).toBe(false);
  });
  it("splits dates by Bangkok week, upcoming and past", () => {
    expect(matchesRange(row(), "This week", NOW)).toBe(true);
    expect(matchesRange(row({ at: at("2026-11-12T03:00:00Z") }), "This week", NOW)).toBe(false);
    expect(matchesRange(row({ started: false }), "Upcoming", NOW)).toBe(true);
    expect(matchesRange(row(), "Upcoming", NOW)).toBe(false);
    expect(matchesRange(row(), "Past", NOW)).toBe(true);
    expect(matchesRange(row({ at: null, history: true }), "This week", NOW)).toBe(false);
  });
});
