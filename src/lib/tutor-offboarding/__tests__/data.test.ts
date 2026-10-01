import { describe, expect, it } from "vitest";
import { buildOffboardingDashboard, evaluateFreshness, openDecisionsByKey } from "../data";
import type { DecisionRecord, FeedTimestamps, OffboardingAccount, OffboardingSignals, PersonSignals } from "../types";

const NOW = new Date("2026-10-01T05:00:00.000Z");
const FRESH: FeedTimestamps = {
  tutorSnapshot: "2026-10-01T04:30:00.000Z",
  progressTests: "2026-10-01T02:57:00.000Z",
  postClass: "2026-10-01T03:13:00.000Z",
  wiseActivity: "2026-10-01T03:02:00.000Z",
  leaveRequests: "2026-10-01T03:15:00.000Z",
};
const VIEWER = { email: "admin@example.com", isOwner: false, canRemove: false };

function account(key: string, overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: `t-${key}`, wiseUserId: `u-${key}`, displayName: `${key} (${key})`, isOnlineVariant: false, email: `${key.toLowerCase()}@example.com`,
    status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z", courseCount: 2, activated: true,
    availabilityKnown: true, workingHourWindows: 3, ...overrides,
  };
}

function person(key: string, overrides: Partial<PersonSignals> = {}): PersonSignals {
  return {
    canonicalKey: key, displayName: key, accounts: [account(key)], lastTaughtAt: "2026-06-03T03:00:00.000Z",
    lastTaughtBySource: { ledger: null, pastBlocks: "2026-06-03T03:00:00.000Z", postClass: null },
    upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null,
    fullTime: false, ...overrides,
  };
}

function signals(people: PersonSignals[]): OffboardingSignals {
  return { snapshotId: "snap", snapshotCreatedAt: "2026-10-01T04:30:00.000Z", generatedAt: "2026-10-01T04:45:00.000Z", people, taughtDates: {} };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d1", canonicalKey: "Gus", note: "Back in January", snoozeUntil: "2026-12-30T05:00:00.000Z", likelihoodAtDecision: 96,
    bandAtDecision: "very_likely_gone", reasons: [], decidedByEmail: "admin@example.com", decidedAt: "2026-09-30T05:00:00.000Z",
    revokedAt: null, revokedByEmail: null, ...overrides,
  };
}

describe("buildOffboardingDashboard", () => {
  it("sorts the inbox by likelihood and routes staff, exclusions and active people out of it", () => {
    const data = buildOffboardingDashboard({
      signals: signals([
        person("Aria"),                                                   // 96: very likely gone
        person("Bodhi", { lastTaughtAt: "2026-09-01T03:00:00.000Z" }),    // 70: likely gone
        person("Cleo", { lastTeacherActionAt: "2026-09-21T03:00:00.000Z" }), // 76: likely gone
        person("Dara", { upcomingSessions: 3 }),                          // teaching
        person("Emil", { accounts: [account("Emil", { relation: "ADMIN" })] }), // staff
        person("Fern", { lastTaughtAt: "2026-09-28T03:00:00.000Z" }),    // active
        person("Gus"),                                                    // snoozed
      ]),
      feeds: FRESH, decisions: [decision()], grants: null, viewer: VIEWER, now: NOW,
    });
    expect(data.inbox.map((row) => [row.signals.canonicalKey, row.score.likelihood])).toEqual([["Aria", 96], ["Cleo", 76], ["Bodhi", 70]]);
    expect(data.staff.map((row) => row.signals.canonicalKey)).toEqual(["Emil"]);
    expect(data.excluded.map((row) => [row.signals.canonicalKey, row.score.exclusion?.code])).toEqual([["Dara", "teaching"], ["Gus", "still_with_us"]]);
    expect(data.excluded[1].openDecision?.id).toBe("d1");
    expect(data.activeCount).toBe(1);
    expect(data.summary).toEqual({ veryLikely: 1, likely: 2, unclear: 0, veryLikelyAccounts: 1 });
    expect(data.decisions[0]).toMatchObject({ id: "d1", displayName: "Gus" });
    expect(data).toMatchObject({ servedAt: NOW.toISOString(), generatedAt: "2026-10-01T04:45:00.000Z", snapshotCreatedAt: "2026-10-01T04:30:00.000Z" });
    expect(data.curve.tutorsObserved).toBe(0);
  });

  it("marks every score provisional and blocks removal when a feed is stale (OFF-07)", () => {
    const data = buildOffboardingDashboard({
      signals: signals([person("Aria")]), feeds: { ...FRESH, tutorSnapshot: "2026-10-01T02:00:00.000Z" },
      decisions: [], grants: null, viewer: VIEWER, now: NOW,
    });
    expect(data.freshness.ok).toBe(false);
    expect(data.inbox[0].score).toMatchObject({ removable: false, removableBlockedBy: "Data is out of date" });
  });
});

describe("evaluateFreshness", () => {
  it("allows 2 hours for the snapshot and 3 days for the other feeds; a feed that never ran is stale", () => {
    const report = evaluateFreshness({ ...FRESH, progressTests: "2026-09-28T06:00:00.000Z", leaveRequests: null }, NOW);
    expect(report.ok).toBe(false);
    expect(report.feeds.map((feed) => [feed.key, feed.fresh])).toEqual([
      ["tutorSnapshot", true], ["progressTests", true], ["postClass", true], ["wiseActivity", true], ["leaveRequests", false],
    ]);
    expect(evaluateFreshness(FRESH, NOW).ok).toBe(true);
  });
});

describe("openDecisionsByKey", () => {
  it("keeps the latest open decision per person and ignores undone or expired ones", () => {
    const open = openDecisionsByKey([
      decision({ id: "old", decidedAt: "2026-09-01T00:00:00.000Z" }),
      decision({ id: "new", decidedAt: "2026-09-30T00:00:00.000Z" }),
      decision({ id: "undone", canonicalKey: "Hana", revokedAt: "2026-09-30T06:00:00.000Z" }),
      decision({ id: "expired", canonicalKey: "Ivo", snoozeUntil: "2026-09-30T00:00:00.000Z" }),
    ], NOW);
    expect([...open.entries()].map(([key, value]) => [key, value.id])).toEqual([["Gus", "new"]]);
  });
});


describe("source consistency", () => {
  it("treats invalid and future feed dates as provisional (OFF-07)", () => {
    expect(evaluateFreshness({ ...FRESH, progressTests: "invalid" }, NOW).ok).toBe(false);
    expect(evaluateFreshness({ ...FRESH, progressTests: "2026-10-01T06:00:00.000Z" }, NOW).ok).toBe(false);
  });

  it("blocks removal if cached people and fresh feed timestamps name different snapshots", () => {
    const data = buildOffboardingDashboard({ signals: signals([person("Aria")]),
      feeds: { ...FRESH, tutorSnapshot: "2026-10-01T04:50:00.000Z" }, decisions: [], grants: null, viewer: VIEWER, now: NOW });
    expect(data.freshness.ok).toBe(false);
    expect(data.inbox[0].score.removable).toBe(false);
  });

  it("adds termination evidence to every group and shows confirmed people with an active score", () => {
    const terminationSnapshot = { checkedAt: NOW.toISOString(), lastError: null,
      rows: ["Aria", "Fern", "Dara", "Emil"].map((name, index) => ({ sourceRow: index + 2,
        fullName: `${name} Example`, wiseName: `${name} (${name})`, nickname: name,
        emails: [`${name.toLowerCase()}@example.com`], terminated: true })) };
    const data = buildOffboardingDashboard({ signals: signals([person("Aria"),
      person("Fern", { lastTaughtAt: "2026-09-28T03:00:00.000Z" }),
      person("Dara", { upcomingSessions: 1 }),
      person("Emil", { accounts: [account("Emil", { relation: "ADMIN" })] })]),
      feeds: FRESH, decisions: [], grants: null, viewer: VIEWER, now: NOW, terminationSnapshot });
    expect(data.terminationSource).toMatchObject({ status: "ready", matchedPeople: 4 });
    const fern = data.inbox.find((row) => row.signals.canonicalKey === "Fern")!;
    expect(fern.termination).toMatchObject({ sourceRow: 3, match: "email" });
    expect(fern.score).toMatchObject({ band: "active", likelihood: 3, removable: false, removableBlockedBy: "Looks active" });
    expect(data.activeCount).toBe(0);
    expect(data.excluded[0].termination).toBeDefined();
    expect(data.staff[0].termination).toBeDefined();
    expect(data.excluded[0].score.exclusion?.code).toBe("teaching");
    expect(data.staff[0].score.exclusion?.code).toBe("wise_admin");
  });
});
