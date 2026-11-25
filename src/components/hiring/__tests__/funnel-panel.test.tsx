import { describe, expect, it, vi } from "vitest";
import { buildFunnel, type FunnelInput } from "@/lib/hiring/funnel";
import { matchesFilter } from "../candidate-table";
import { NO_FILTER, type HiringCandidate } from "../dashboard";
import { groupOptions, pickGroup } from "../funnel-panel";

vi.mock("next/font/google", () => ({ Instrument_Serif: () => ({ variable: "" }) }));

const NOW = new Date("2026-11-17T17:30:00Z");
const day = (d: string) => `2026-${d}T03:00:00Z`;
const data: FunnelInput = {
  candidates: [
    { id: "a", stage: "review", createdAt: day("10-31"), seekJobId: "95633167", preScreenRepliedAt: null, callReview: null },
    { id: "b", stage: "new", createdAt: day("11-16"), seekJobId: null, preScreenRepliedAt: null, callReview: null },
    { id: "c", stage: "stopped", createdAt: day("11-10"), seekJobId: "95633167", preScreenRepliedAt: null, callReview: null },
  ],
  bookings: [],
  calls: [],
  inviteOutbox: [{ key: "b:call-invite", status: "sent", sentAt: day("11-17") }],
  decisions: [],
  funnelEvents: [],
};
const report = buildFunnel(data, NOW);
const campaigns = [{ jobId: "95633167", label: "International Curriculum Tutors" }];

describe("funnel panel", () => {
  it("lists all, each campaign, each month and each week", () => {
    expect(groupOptions(report, campaigns).map((o) => o.label)).toEqual([
      "All candidates",
      "Campaign: International Curriculum Tutors (SEEK 95633167)",
      "Campaign: Tracker only (no SEEK job)",
      "Applied in Nov 2026",
      "Applied in Oct 2026",
      "Applied in week 47 of 2026",
      "Applied in week 46 of 2026",
      "Applied in week 44 of 2026",
    ]);
  });

  it("counts a week group as one week and a group from its first applicant, at least one week", () => {
    expect(report.groups["week:2026-W47"].weeks).toBe(1);
    expect(report.groups["campaign:95633167"].weeks).toBeCloseTo(17.6 / 7, 1);
    expect(report.groups["campaign:tracker-only"].weeks).toBe(1); // 1.6 days, floored to one week
    // A month is its own days in the window: all of October, and November to now.
    expect(report.groups["month:2026-10"].weeks).toBeCloseTo(31 / 7, 1);
    expect(report.groups["month:2026-10"].reached.applied).toBe(1);
    expect(report.groups["month:2026-11"].weeks).toBeCloseTo(17 / 7, 1);
  });

  it("counts each candidate once at the furthest step, also when a step is skipped", () => {
    // "b" has a call link (contacted). "v" has a visit booking and no form reply: the call-first flow.
    const skipped = buildFunnel(
      { ...data, candidates: [...data.candidates, { ...data.candidates[1], id: "v" }], bookings: [{ candidateId: "v", kind: "paper", status: "booked", startTime: day("11-20"), createdAt: day("11-17") }] },
      NOW,
    ).groups.all;
    expect(skipped.reached.replied).toBeLessThan(skipped.reached.visit_booked);
    expect(Object.values(skipped.furthest).reduce((a, b) => a + b, 0)).toBe(skipped.reached.applied);
    expect(skipped.furthest.visit_booked).toBe(1);
  });

  it("falls back to all when the chosen group is gone after a reload", () => {
    expect(pickGroup(report, "campaign:95633167")).toBe("campaign:95633167");
    expect(pickGroup(report, "campaign:gone")).toBe("all");
  });

  it("filters the candidate table to the stuck ids only", () => {
    const person = { id: "x", stage: "review" } as unknown as HiringCandidate;
    expect(matchesFilter(person, { ...NO_FILTER, ids: ["y"] }, new Set(), new Map())).toBe(false);
    expect(matchesFilter(person, { ...NO_FILTER, ids: ["x"] }, new Set(), new Map())).toBe(true);
  });
});
