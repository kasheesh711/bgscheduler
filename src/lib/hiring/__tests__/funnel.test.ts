import { describe, expect, it } from "vitest";
import { buildFunnel, cohortWindow, isoWeek, percentile, roundTo, windowStart, type FunnelInput } from "../funnel";

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
  it("clips the selected ISO week at the Bangkok snapshot across a calendar year", () => {
    for (const [snapshot, key, monday] of [
      ["2027-01-02T12:00:00+07:00", "week:2026-W53", "2026-12-28T00:00:00+07:00"],
      ["2024-12-31T12:00:00+07:00", "week:2025-W01", "2024-12-30T00:00:00+07:00"],
    ]) {
      const report = buildFunnel(empty, new Date(snapshot));
      expect(cohortWindow(report, key)).toEqual({
        from: Date.parse(monday), until: Date.parse(snapshot), clippedStart: false, clippedEnd: true,
      });
    }
  });
  it("starts the window on Monday of the week eleven weeks back", () => {
    expect(new Date(windowStart(NOW)).toISOString()).toBe("2026-08-30T17:00:00.000Z");
  });
});

describe("buildFunnel", () => {
  it("counts dated outcomes through the snapshot and keeps later appointments as plans", () => {
    const snapshot = NOW.toISOString();
    const future = new Date(+NOW + 1).toISOString();
    const before = new Date(+NOW - 86_400_000).toISOString();
    const source = (id: string, eventAt: string): FunnelInput => ({
      candidates: [candidate(id, "onsite_booked", "11-10", { preScreenRepliedAt: eventAt, callReview: { good: { at: eventAt } } })],
      inviteOutbox: ["call-invite", "pre-screen", "visit-invite:2"].map(key => ({ key: id + ":" + key, status: "sent", sentAt: eventAt })),
      funnelEvents: ["call-booked", "invite_onsite", "onsite-release", "move-to-review"].map(action => ({ candidateId: id, action, at: eventAt })),
      bookings: [{ candidateId: id, kind: "paper", status: "confirmed", createdAt: eventAt, startTime: snapshot }],
      calls: [],
      decisions: [{ candidateId: id, decision: "hire", status: "sent", sentAt: eventAt }],
    });
    const after = buildFunnel(source("later", future), NOW).groups.all;
    expect(after.documented).toEqual({ applied: 1, contacted: 0, replied: 0, onsite_invited: 0, visit_booked: 0, visited: 0, offer: 0 });
    expect(after.atLeast.visit_booked).toBe(1); // The current stage still implies a booking.
    expect(after.stepDays).toEqual({});
    const edge = buildFunnel(source("edge", snapshot), NOW).groups.all;
    expect(Object.values(edge.documented)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    const planned = buildFunnel({
      ...empty, candidates: [candidate("visit", "onsite_booked", "11-10"), candidate("call", "new", "11-10")],
      bookings: [{ candidateId: "visit", kind: "paper", status: "confirmed", createdAt: before, startTime: future }],
      calls: [{ candidateId: "call", start: future }],
      funnelEvents: [{ candidateId: "call", action: "call-booked", at: future }],
      inviteOutbox: [{ key: "call:call-invite", status: "sent", sentAt: before }],
    }, NOW);
    expect(planned.groups.all.documented.visit_booked).toBe(1);
    expect(planned.groups.all.documented.visited).toBe(0);
    expect(planned.groups.all.stepDays.booked_to_visit).toBeUndefined();
    expect(planned.groups.all.stepDays.call_link_to_call_booked).toBeUndefined();
    expect(planned.byCandidate.call).toMatchObject({ stageKey: "new (call booked)", stuck: false });
    expect(planned.byCandidate.visit.stuck).toBe(false);
  });

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
    // a's call is on 20 Nov, still ahead: days count from the call link (17 Nov), and it cannot be stuck yet.
    expect(all.currentStage["new (call booked)"]).toMatchObject({ n: 1, stuck: 0, stuckAfterDays: null, medianDays: 0.6 });
    // c has no move-to-review event: its time starts at import. Never emailed, so never stuck (Kevin, 25 Nov 2026).
    expect(all.currentStage.review).toMatchObject({ n: 2, stuck: 0, sinceIsImportTime: 1, stuckIds: [] });
    // The visit was 7.6 days ago, over the 3-day rule.
    expect(all.currentStage.onsite_booked).toMatchObject({ n: 1, stuck: 1, stuckAfterDays: 3, medianDays: 7.6 });
    expect(all.currentStage.paper_passed).toMatchObject({ stuck: 1, stuckAfterDays: 14 });
    expect(all.currentStage.new).toMatchObject({ n: 2, stuck: 0 });
    expect(all.stuck).toBe(2);
  });

  it("never gives negative days: a future call counts from its booking time", () => {
    const r = buildFunnel(
      {
        ...empty,
        candidates: [candidate("x", "new", "11-10"), candidate("y", "new", "11-01")],
        calls: [
          { candidateId: "x", start: day("11-25") },
          { candidateId: "y", start: day("11-12") },
        ],
        // x booked on 12 Nov, then rebooked on 15 Nov: days count from the rebooking.
        funnelEvents: [
          { candidateId: "x", action: "call-booked", at: day("11-12") },
          { candidateId: "x", action: "call-booked", at: day("11-15") },
        ],
      },
      NOW,
    );
    expect(r.byCandidate.x).toEqual({ stageKey: "new (call booked)", daysInStage: 2.6041666666666665, stuck: false });
    // y's call was 12 Nov and nobody recorded the result: 5.6 days after the call, over the 3-day rule.
    // Before any email nobody is stuck (Kevin, 25 Nov 2026), a call that has passed included.
    expect(r.byCandidate.y).toMatchObject({ stageKey: "new (call booked)", stuck: false });
    expect(r.byCandidate.y.daysInStage).toBeCloseTo(5.604);
  });

  it("distinguishes an imported stage age from an invitation sent at that same time", () => {
    const sentAt = day("11-01");
    const result = buildFunnel({
      ...empty,
      candidates: [candidate("import", "pre_screen", "11-01"), candidate("sent", "pre_screen", "11-01")],
      inviteOutbox: [{ key: "sent:pre-screen", status: "sent", sentAt }],
    }, NOW);
    expect(result.byCandidate.import.importDateOnly).toBe(true);
    expect(result.byCandidate.sent.importDateOnly).toBeUndefined();
    expect(result.byCandidate.sent.daysInStage).toEqual(result.byCandidate.import.daysInStage);
  });

  it("covers every candidate in byCandidate, also those before the window", () => {
    expect(Object.keys(report.byCandidate).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "old"]);
    expect(report.byCandidate.old).toMatchObject({ stageKey: "stopped", stuck: false });
  });

  it("measures days between steps only where both ends have a time", () => {
    const move = (from: string, to: string) => ({ from: Date.parse(day(from)), to: Date.parse(day(to)) });
    expect(all.stepDays.applied_to_contacted).toEqual({ n: 2, median: 1, p90: 1, moves: { a: move("11-16", "11-17"), e: move("11-01", "11-02") } });
    expect(all.stepDays.call_link_to_call_booked).toEqual({ n: 1, median: 1, p90: 1, moves: { e: move("11-02", "11-03") } });
    expect(all.stepDays.form_sent_to_replied).toEqual({ n: 1, median: 1, p90: 1, moves: { e: move("11-04", "11-05") } });
    expect(all.stepDays.booked_to_visit).toEqual({ n: 1, median: 3, p90: 3, moves: { e: move("11-07", "11-10") } });
    expect(all.stepDays.visit_to_offer).toBeUndefined();
  });
});
