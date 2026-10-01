import { describe, expect, it } from "vitest";
import type { CalibrationCurve } from "../calibration";
import { bandFor, scorePerson, type ScoreContext } from "../score";
import type { OffboardingAccount, PersonSignals } from "../types";

const NOW = new Date("2026-10-01T05:00:00.000Z"); // 12:00 Bangkok

const CURVE: CalibrationCurve = {
  tutorsObserved: 72,
  historyStart: "2026-02-28T17:00:00.000Z",
  points: [
    { thresholdDays: 21, returned: 13, stillIdle: 21, goneProbability: 0.6, usedDefault: false },
    { thresholdDays: 30, returned: 8, stillIdle: 19, goneProbability: 0.7, usedDefault: false },
    { thresholdDays: 45, returned: 4, stillIdle: 15, goneProbability: 0.78, usedDefault: false },
    { thresholdDays: 60, returned: 1, stillIdle: 15, goneProbability: 0.9, usedDefault: false },
    { thresholdDays: 90, returned: 0, stillIdle: 14, goneProbability: 0.96, usedDefault: false },
  ],
};

function account(overrides: Partial<OffboardingAccount> = {}): OffboardingAccount {
  return {
    wiseTeacherId: "t1", wiseUserId: "u1", displayName: "Aria (Aria)", isOnlineVariant: false, email: "aria@example.com",
    status: "active", relation: "TEACHER", joinedOn: "2026-01-20T00:00:00.000Z", courseCount: 3, activated: true,
    availabilityKnown: true, workingHourWindows: 4, ...overrides,
  };
}

function person(overrides: Partial<PersonSignals> = {}): PersonSignals {
  return {
    canonicalKey: "Aria", displayName: "Aria", accounts: [account()],
    lastTaughtAt: "2026-06-03T03:00:00.000Z", // 120 days before NOW
    lastTaughtBySource: { ledger: "2026-06-03T03:00:00.000Z", pastBlocks: null, postClass: null },
    upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null,
    lastTeacherActionAt: null, lastAdminActionAt: null, fullTime: false, ...overrides,
  };
}

function ctx(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return { now: NOW, curve: CURVE, snoozedKeys: new Set(), freshnessOk: true, ...overrides };
}

describe("bandFor", () => {
  it("cuts the bands at 90, 70 and 40", () => {
    expect([90, 89, 70, 69, 40, 39].map(bandFor)).toEqual([
      "very_likely_gone", "likely_gone", "likely_gone", "unclear", "unclear", "active",
    ]);
  });
});

describe("scorePerson", () => {
  it("scores a long-idle tutor from the curve and explains it", () => {
    const score = scorePerson(person(), ctx());
    expect(score).toMatchObject({ likelihood: 96, band: "very_likely_gone", idleDays: 120, neverTaught: false, exclusion: null, removable: true, removableBlockedBy: null });
    expect(score.reasons).toEqual([{ code: "idle_gap", direction: "toward_gone", text: "Last class 120 days ago (3 Jun)" }]);
  });

  it("adds supporting evidence and never claims certainty", () => {
    const score = scorePerson(person({ accounts: [account({ workingHourWindows: 0, courseCount: 0, activated: false })] }), ctx());
    expect(score.likelihood).toBe(99);
    expect(score.reasons.map((reason) => reason.text)).toEqual([
      "Last class 120 days ago (3 Jun)",
      "No working hours set in Wise",
      "Not assigned to any Wise course",
      "Never activated their Wise login",
    ]);
  });

  it("lets unknown signals add nothing (OFF-02)", () => {
    const unknown = account({ workingHourWindows: 0, availabilityKnown: false, courseCount: null, activated: null });
    expect(scorePerson(person({ accounts: [unknown] }), ctx()).likelihood).toBe(96);
    // Evidence must hold for every account: one known course keeps "no courses" off.
    const mixed = [account({ courseCount: 0 }), account({ wiseTeacherId: "t2", courseCount: 2 })];
    expect(scorePerson(person({ accounts: mixed }), ctx()).reasons.map((reason) => reason.code)).toEqual(["idle_gap"]);
  });

  it("lowers the score for recent Wise activity and for leave", () => {
    const recent = person({ lastTeacherActionAt: "2026-09-21T03:00:00.000Z" });
    expect(scorePerson(recent, ctx())).toMatchObject({ likelihood: 76, band: "likely_gone" });
    const onLeave = person({ lastTeacherActionAt: "2026-09-21T03:00:00.000Z", upcomingLeaveUntil: "2026-10-20T10:00:00.000Z" });
    const score = scorePerson(onLeave, ctx());
    expect(score).toMatchObject({ likelihood: 42, band: "unclear" });
    expect(score.reasons.slice(1)).toEqual([
      { code: "recent_wise_action", direction: "toward_active", text: "Used Wise on 21 Sep" },
      { code: "on_leave", direction: "toward_active", text: "On leave until 20 Oct" },
    ]);
  });

  it("measures a never-taught person from 1 Mar or from their joined date (OFF-14)", () => {
    const longAgo = scorePerson(person({ lastTaughtAt: null }), ctx());
    expect(longAgo).toMatchObject({ idleDays: 214, neverTaught: true, likelihood: 96, removable: true });
    expect(longAgo.reasons[0]).toEqual({ code: "no_class_on_record", direction: "toward_gone", text: "No class on record since 1 Mar" });
    const joinedJuly = scorePerson(person({ lastTaughtAt: null, accounts: [account({ joinedOn: "2026-07-10T03:00:00.000Z" })] }), ctx());
    expect(joinedJuly).toMatchObject({ idleDays: 83, likelihood: 90, band: "very_likely_gone" });
    expect(joinedJuly.reasons[0].text).toBe("No class on record since 10 Jul");
  });

  it("applies the exclusions in order, first match wins", () => {
    const cases: Array<[Partial<PersonSignals>, string, string]> = [
      [{ accounts: [account({ relation: "ADMIN" })], upcomingSessions: 2 }, "wise_admin", "Wise admin account (staff)"],
      [{ upcomingSessions: 1 }, "teaching", "Teaching: 1 upcoming class"],
      [{ upcomingSessions: 3 }, "teaching", "Teaching: 3 upcoming classes"],
      [{ fullTime: true }, "full_time", "Full-time tutor (office attendance)"],
      [{ accounts: [account({ status: "identity_conflict" })] }, "identity_conflict", "Identity needs fixing in Wise first"],
      [{ lastTaughtAt: null, accounts: [account({ joinedOn: null })] }, "awaiting_details", "Waiting for Wise account details (next sync)"],
      [{ lastTaughtAt: null, accounts: [account({ joinedOn: "2026-09-11T03:00:00.000Z" })] }, "new_account", "New account, not started yet"],
    ];
    for (const [overrides, code, text] of cases) {
      const score = scorePerson(person(overrides), ctx());
      expect(score.exclusion).toEqual({ code, text });
      expect(score).toMatchObject({ removable: false, removableBlockedBy: null });
    }
    expect(scorePerson(person(), ctx({ snoozedKeys: new Set(["Aria"]) })).exclusion).toEqual({ code: "still_with_us", text: "Marked still with us" });
  });

  it("explains why a person outside the exclusions is not removable yet", () => {
    const recent = scorePerson(person({ lastTaughtAt: "2026-09-01T03:00:00.000Z" }), ctx());
    expect(recent).toMatchObject({ likelihood: 70, band: "likely_gone", removable: false, removableBlockedBy: "Last class 30 days ago; removal opens at 45 days" });
    expect(scorePerson(person(), ctx({ freshnessOk: false })).removableBlockedBy).toBe("Data is out of date");
    expect(scorePerson(person({ accounts: [account({ relation: null })] }), ctx()).removableBlockedBy).toBe("Waiting for Wise account details");
    expect(scorePerson(person({ lastTaughtAt: "2026-09-26T03:00:00.000Z" }), ctx())).toMatchObject({ band: "active", removableBlockedBy: "Looks active" });
  });
});
