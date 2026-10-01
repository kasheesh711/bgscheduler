import { describe, expect, it } from "vitest";
import { curveSentence, formatAge, formatDay, formatDayYear, topLineSentence } from "../format";
import { dashboardFixture } from "./fixtures";

describe("format", () => {
  it("formats Bangkok days", () => {
    expect(formatDay("2026-06-03T03:00:00.000Z")).toBe("3 Jun");
    expect(formatDay("2026-02-28T17:00:00.000Z")).toBe("1 Mar");
    expect(formatDayYear("2026-01-20T00:00:00.000Z")).toBe("20 Jan 2026");
  });

  it("says how old the data is", () => {
    const now = new Date("2026-10-01T05:00:00.000Z");
    expect(formatAge("2026-10-01T04:48:00.000Z", now)).toBe("12 min old");
    expect(formatAge("2026-10-01T01:00:00.000Z", now)).toBe("4 h old");
    expect(formatAge("2026-09-28T05:00:00.000Z", now)).toBe("3 days old");
  });

  it("writes the top line in plain words", () => {
    expect(topLineSentence({ veryLikely: 23, veryLikelyAccounts: 41, likely: 1, unclear: 1 }))
      .toBe("23 tutors (41 Wise accounts) are very likely no longer with us; 1 likely, 1 unclear.");
    expect(topLineSentence({ veryLikely: 1, veryLikelyAccounts: 2, likely: 0, unclear: 0 }))
      .toBe("1 tutor (2 Wise accounts) is very likely no longer with us.");
    expect(topLineSentence({ veryLikely: 0, veryLikelyAccounts: 0, likely: 2, unclear: 0 }))
      .toBe("No tutor is very likely gone; 2 likely.");
    expect(topLineSentence({ veryLikely: 0, veryLikelyAccounts: 0, likely: 0, unclear: 0 }))
      .toBe("No tutors look like they have left. Nothing to review.");
  });

  it("states the calibration in one sentence", () => {
    const { curve } = dashboardFixture();
    expect(curveSentence(curve)).toBe("Idle 60+ days → 91% never came back · based on 60 tutors since 1 Mar");
    expect(curveSentence({ ...curve, points: curve.points.map((point) => ({ ...point, usedDefault: true, goneProbability: 0.9 })) }))
      .toBe("Idle 60+ days → 90% never came back · default estimate until there is enough history");
  });
});
