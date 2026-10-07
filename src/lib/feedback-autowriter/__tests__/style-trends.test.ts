import { describe, expect, it } from "vitest";
import { isoWeekKey, recurringStyleProblems, styleProblemCategory } from "../style-trends";

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 9, 7, 12) - hoursAgo * 3_600_000);
const flagged = (postId: string, problems: string[], formatProblems: string[] = [], hoursAgo = 1) =>
  ({ postId, status: "flagged", createdAt: at(hoursAgo), result: { formatProblems, verdict: { matches: false, problems } } });

describe("recurring style problems", () => {
  it("puts the reviewer's words into plain categories", () => {
    expect(styleProblemCategory("Replace the audit-style wording “matched portion”").key).toBe("audit_wording");
    expect(styleProblemCategory("The performance paragraph repeats the topic inventory").key).toBe("topic_repeat");
    expect(styleProblemCategory("Something else entirely").key).toBe("other");
  });
  it("raises a category once it is on three posts, counting each post's latest review once", () => {
    const trends = recurringStyleProblems([
      flagged("a", ["The paragraph repeats the topic list.", "Also repeats vocabulary."]),
      flagged("b", ["Restates the topics instead of performance."]),
      flagged("c", ["Repeats the topic list again."], ["style:numbering:topics"]),
      // An older review of c that passed is superseded by its latest; a passed post never counts.
      { postId: "c", status: "passed", createdAt: at(30), result: {} },
      { postId: "d", status: "passed", createdAt: at(2), result: { verdict: { matches: true, problems: [] } } },
      flagged("e", ["Use warmer pupil-facing tone."]),
    ]);
    expect(trends).toEqual([{ key: "topic_repeat", label: "the performance paragraph repeats the topic list", posts: ["a", "b", "c"],
      examples: ["The paragraph repeats the topic list.", "Restates the topics instead of performance."] }]);
  });
  it("counts deterministic checks by their code, without the field", () => {
    const trends = recurringStyleProblems(["x", "y", "z"].map((id, i) => flagged(id, [], [i ? "style:numbering:homework" : "style:numbering:topics"])));
    expect(trends.map((trend) => [trend.key, trend.posts.length])).toEqual([["check:style:numbering", 3]]);
  });
  it("keys a week the ISO way", () => {
    expect(isoWeekKey(new Date("2026-10-07T12:00:00Z"))).toBe("2026-W41");
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    // Monday 05:00 Bangkok is Sunday 22:00 UTC: already the new week.
    expect(isoWeekKey(new Date("2026-10-11T22:00:00Z"))).toBe("2026-W42");
    expect(styleProblemCategory("Give the number of questions attempted.").key).toBe("other");
  });
});
