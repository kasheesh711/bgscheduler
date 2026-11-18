import { describe, expect, it } from "vitest";
import { isRoleView, openHeadDecisions, weekCalls, workWeek } from "../role-views";

describe("role views", () => {
  it("knows the role screens by name", () => {
    expect(["hr", "admin", "heads"].every(isRoleView)).toBe(true);
    expect([null, "overview", "HR"].some(isRoleView)).toBe(false);
  });
  it("gives Monday to Friday of this Bangkok week, and next week on a weekend", () => {
    // Wednesday 18 Nov 2026, 09:00 Bangkok.
    expect(workWeek(new Date("2026-11-18T02:00:00Z"))).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    // Sunday 22 Nov 23:30 UTC is Monday 23 Nov in Bangkok.
    expect(workWeek(new Date("2026-11-22T23:30:00Z"))[0]).toBe("2026-11-23");
    // Saturday 21 Nov in Bangkok.
    expect(workWeek(new Date("2026-11-21T05:00:00Z"))[0]).toBe("2026-11-23");
  });
  it("puts each booked call on its Bangkok day, first call first", () => {
    const week = weekCalls(
      [
        { candidateId: "b", start: "2026-11-18T08:00:00Z" },
        { candidateId: "a", start: "2026-11-18T03:30:00Z" },
        // 18:30 UTC on Thursday is Friday 01:30 in Bangkok.
        { candidateId: "c", start: "2026-11-19T18:30:00Z" },
        { candidateId: "a", start: "2026-11-30T03:00:00Z" },
      ],
      [{ id: "a", name: "Ann" }, { id: "b", name: "Bo" }],
      new Date("2026-11-18T02:00:00Z"),
    );
    expect(week[2]).toMatchObject({ date: "2026-11-18", today: true, calls: [{ name: "Ann", time: "10:30" }, { name: "Bo", time: "15:00" }] });
    expect(week[4].calls).toEqual([{ candidateId: "c", name: "Candidate", time: "01:30" }]);
    expect(week.flatMap((d) => d.calls)).toHaveLength(3);
  });
  it("keeps the newest head decision for each candidate until that result is sent", () => {
    const row = (candidateId: string | null, decision: "hire" | "reject") => ({ candidateId, decision, reason: "", head: "Peat", draftProblem: null, at: "2026-11-18T02:00:00Z" });
    const open = openHeadDecisions(
      [row("a", "reject"), row("a", "hire"), row("b", "hire"), row("c", "hire"), row(null, "hire")],
      [
        { candidateId: "b", decision: "hire", status: "sent" },
        // A draft, and a sent result of the other kind, do not close the head's decision.
        { candidateId: "c", decision: "hire", status: "draft" },
        { candidateId: "a", decision: "hire", status: "sent" },
      ],
    );
    expect(open.map((d) => [d.candidateId, d.decision])).toEqual([["a", "reject"], ["c", "hire"]]);
  });
});
