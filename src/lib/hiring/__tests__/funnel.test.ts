import { describe, expect, it } from "vitest";
import { buildFunnel, isoWeek, percentile, roundTo, windowStart, type FunnelInput } from "../funnel";

const NOW = new Date("2026-11-17T17:30:00Z"); // 18 Nov 00:30 Bangkok, ISO week 2026-W47
const day = (d: string) => `2026-${d}T03:00:00Z`;
const candidate = (id: string, stage: string, created: string, patch: Partial<FunnelInput["candidates"][number]> = {}) => ({
  id,
  stage,
  createdAt: day(created),
  seekJobId: "95633167",
  preScreenRepliedAt: null,
  callReview: null,
  ...patch,
});
const empty: FunnelInput = { candidates: [], bookings: [], calls: [], inviteOutbox: [], decisions: [], funnelEvents: [] };

describe("funnel helpers", () => {
  it("matches Postgres percentile_cont and round", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([0, 10], 0.9)).toBe(9);
    expect(roundTo(0.25, 1)).toBe(0.3);
    expect(roundTo(-0.25, 1)).toBe(-0.3);
  });
  it("names ISO weeks on the Bangkok calendar", () => {
    expect(isoWeek(NOW.getTime())).toBe("2026-W47");
    // 1 Jan 2021 was a Friday, so it is in the last week of 2020.
    expect(isoWeek(Date.parse("2021-01-01T03:00:00Z"))).toBe("2020-W53");
    // 23:30 UTC on Sunday is Monday in Bangkok.
    expect(isoWeek(Date.parse("2026-11-15T23:30:00Z"))).toBe("2026-W47");
  });
  it("starts the window on Monday of the week eleven weeks back", () => {
    expect(new Date(windowStart(NOW)).toISOString()).toBe("2026-08-30T17:00:00.000Z");
  });
});

describe("buildFunnel", () => {
  const data: FunnelInput = {
    ...empty,
    candidates: [
      candidate("old", "stopped", "08-01"),
      candidate("a", "new", "11-16"),
      candidate("b", "new", "10-31", { seekJobId: null }),
      candidate("c", "review", "10-31"),
      candidate("d", "review", "10-31"),
      candidate("e", "onsite_booked", "11-01", { preScreenRepliedAt: day("11-05") }),
      candidate("f", "new", "11-01"),
      candidate("g", "paper_passed", "10-31"),
    ],
    inviteOutbox: [
      { key: "a:call-invite", status: "sent", sentAt: day("11-17") },
      { key: "e:call-invite", status: "sent", sentAt: day("11-02") },
      { key: "e:pre-screen", status: "sent", sentAt: day("11-04") },
      { key: "f:call-invite", status: "pending", sentAt: null },
    ],
    funnelEvents: [
      { candidateId: "d", action: "move-to-review", at: day("11-15") },
      { candidateId: "e", action: "invite_onsite", at: day("11-06") },
      { candidateId: "e", action: "call-booked", at: day("11-03") },
    ],
    bookings: [
      { candidateId: "e", kind: "paper", status: "confirmed", startTime: day("11-10"), createdAt: day("11-07") },
      { candidateId: "e", kind: "mock", status: "confirmed", startTime: day("11-10"), createdAt: day("11-07") },
    ],
    calls: [{ candidateId: "a", start: day("11-20") }],
  };
  const report = buildFunnel(data, NOW);
  const all = report.groups.all;

  it("counts each step by event or by the current stage", () => {
    expect(report.excludedBeforeWindow).toBe(1);
    expect(all.reached).toEqual({ applied: 7, contacted: 3, replied: 1, onsite_invited: 2, visit_booked: 2, visited: 2, offer: 0 });
    expect(all.conv.contacted).toBe(0.429);
    expect(all.conv.offer).toBe(0);
    expect(report.groups["campaign:tracker-only"].reached.applied).toBe(1);
    expect(report.groups["week:2026-W47"].reached.applied).toBe(1);
  });

  it("gives no rate when the step before has nobody", () => {
    expect(buildFunnel({ ...empty, candidates: [candidate("x", "new", "11-16")] }, NOW).groups.all.conv.visited).toBeNull();
  });

  it("dates stages from events and marks stuck candidates", () => {
    expect(all.currentStage["new (call booked)"]).toMatchObject({ n: 1, stuck: 0, stuckAfterDays: 3 });
    // c has no move-to-review event: its time starts at import, so it is stuck. d moved 2.6 days ago.
    expect(all.currentStage.review).toMatchObject({ n: 2, stuck: 1, sinceIsImportTime: 1, stuckIds: ["c"] });
    // The visit was 7.6 days ago, over the 3-day rule.
    expect(all.currentStage.onsite_booked).toMatchObject({ n: 1, stuck: 1, stuckAfterDays: 3, medianDays: 7.6 });
    expect(all.currentStage.paper_passed).toMatchObject({ stuck: 1, stuckAfterDays: 14 });
    expect(all.currentStage.new).toMatchObject({ n: 2, stuck: 2 });
    expect(all.stuck).toBe(5);
  });

  it("measures days between steps only where both ends have a time", () => {
    expect(all.stepDays.applied_to_contacted).toEqual({ n: 2, median: 1, p90: 1 });
    expect(all.stepDays.call_link_to_call_booked).toEqual({ n: 1, median: 1, p90: 1 });
    expect(all.stepDays.form_sent_to_replied).toEqual({ n: 1, median: 1, p90: 1 });
    expect(all.stepDays.booked_to_visit).toEqual({ n: 1, median: 3, p90: 3 });
    expect(all.stepDays.visit_to_offer).toBeUndefined();
  });
});
