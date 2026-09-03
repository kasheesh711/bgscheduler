import { afterEach, describe, expect, it } from "vitest";
import { ALERT_THRESHOLD } from "@/lib/credit-control/config";
import {
  CREDIT_HOT_BALANCE_CREDITS,
  CREDIT_REFRESH_MAX_AGE_MINUTES_DEFAULT,
  decidePairRefresh,
  getCreditRefreshMaxAgeMinutes,
  priorAdjustedRemaining,
  type PairRefreshInput,
  type PriorPairCredits,
} from "@/lib/credit-control/refresh-policy";

const NOW = new Date("2026-09-02T10:00:00.000Z");

function prior(overrides: Partial<PriorPairCredits> = {}): PriorPairCredits {
  return {
    remainingCredits: 20,
    pendingDeductionCredits: 0,
    excludedReason: null,
    // Two hours old: inside the 180-minute default window.
    creditsObservedAt: new Date("2026-09-02T08:00:00.000Z"),
    ...overrides,
  };
}

function decide(overrides: Partial<PairRefreshInput> = {}) {
  return decidePairRefresh({
    prior: prior(),
    currentlyExcluded: false,
    lastSessionEndAt: null,
    now: NOW,
    maxAgeMinutes: CREDIT_REFRESH_MAX_AGE_MINUTES_DEFAULT,
    ...overrides,
  });
}

describe("decidePairRefresh", () => {
  // The whole point of the rule: everything a human is asked to act on stays
  // fetched, so the hot band has to sit above the band the worklist escalates.
  it("keeps the hot band a superset of the alert band", () => {
    expect(CREDIT_HOT_BALANCE_CREDITS).toBeGreaterThan(ALERT_THRESHOLD);
    expect(CREDIT_HOT_BALANCE_CREDITS).toBe(ALERT_THRESHOLD * 3);
  });

  it("reuses a quiet, comfortable, recently observed pair", () => {
    expect(decide()).toEqual({ action: "reuse", reason: "quiet" });
  });

  // SAFETY: this is the property that makes reuse safe at all. A low balance is
  // never carried forward, no matter how fresh the observation is, because a
  // top-up gives Wise no signal and a stale low number gets a paid-up parent
  // chased for money.
  it("SAFETY: always refetches a low-balance pair even when just observed", () => {
    const justObserved = { creditsObservedAt: new Date(NOW.getTime() - 1_000) };

    expect(decide({ prior: prior({ ...justObserved, remainingCredits: 0 }) }))
      .toEqual({ action: "refetch", reason: "low-balance" });
    expect(decide({ prior: prior({ ...justObserved, remainingCredits: ALERT_THRESHOLD }) }))
      .toEqual({ action: "refetch", reason: "low-balance" });
    expect(decide({ prior: prior({ ...justObserved, remainingCredits: CREDIT_HOT_BALANCE_CREDITS - 0.5 }) }))
      .toEqual({ action: "refetch", reason: "low-balance" });
    // Exactly at the band edge is comfortable enough to age.
    expect(decide({ prior: prior({ ...justObserved, remainingCredits: CREDIT_HOT_BALANCE_CREDITS }) }))
      .toEqual({ action: "reuse", reason: "quiet" });
  });

  // The dashboard renders remaining MINUS deductions still pending teacher
  // feedback, so the hot test has to run on the same adjusted figure.
  it("tests the hot band against adjusted remaining, not raw remaining", () => {
    const pendingPair = prior({ remainingCredits: 8, pendingDeductionCredits: 3 });

    expect(priorAdjustedRemaining(pendingPair)).toBe(5);
    expect(decide({ prior: pendingPair })).toEqual({ action: "refetch", reason: "low-balance" });
    expect(decide({ prior: prior({ remainingCredits: 8, pendingDeductionCredits: 1 }) }))
      .toEqual({ action: "reuse", reason: "quiet" });
  });

  it("refetches a pair with no prior row", () => {
    expect(decide({ prior: null })).toEqual({ action: "refetch", reason: "no-prior-row" });
    // Even an excluded-looking new pair is fetched: without a prior row there
    // is nothing to carry forward, and a zeroed row reads as a drained balance.
    expect(decide({ prior: null, currentlyExcluded: true }))
      .toEqual({ action: "refetch", reason: "no-prior-row" });
  });

  it("refetches when a session ended at or after the last observation", () => {
    const observedAt = new Date("2026-09-02T08:00:00.000Z");

    expect(decide({ prior: prior({ creditsObservedAt: observedAt }), lastSessionEndAt: observedAt }))
      .toEqual({ action: "refetch", reason: "session-ended" });
    expect(decide({
      prior: prior({ creditsObservedAt: observedAt }),
      lastSessionEndAt: new Date("2026-09-02T09:30:00.000Z"),
    })).toEqual({ action: "refetch", reason: "session-ended" });
    // A session that ended BEFORE the observation is already priced in.
    expect(decide({
      prior: prior({ creditsObservedAt: observedAt }),
      lastSessionEndAt: new Date("2026-09-02T07:59:59.000Z"),
    })).toEqual({ action: "reuse", reason: "quiet" });
  });

  // The fixture was observed exactly 120 minutes before NOW.
  it("refetches once the observation is older than the max age", () => {
    expect(decide({ maxAgeMinutes: 119 })).toEqual({ action: "refetch", reason: "stale" });
    expect(decide({ maxAgeMinutes: 120 })).toEqual({ action: "reuse", reason: "quiet" });
  });

  it("skips the call only when the prior row AND this run agree the package is excluded", () => {
    expect(decide({ prior: prior({ excludedReason: "trial" }), currentlyExcluded: true }))
      .toEqual({ action: "skip", reason: "excluded" });
    // Renamed out of the excluded keywords → resume fetching it.
    expect(decide({ prior: prior({ excludedReason: "trial" }), currentlyExcluded: false }))
      .toEqual({ action: "reuse", reason: "quiet" });
    // Newly excluded but never fetched as excluded → this run still fetches.
    expect(decide({ prior: prior({ excludedReason: null }), currentlyExcluded: true }))
      .toEqual({ action: "reuse", reason: "quiet" });
  });

  it("skips excluded pairs regardless of balance, age, or attendance", () => {
    const excluded = prior({
      excludedReason: "pretest",
      remainingCredits: 0,
      creditsObservedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(decide({ prior: excluded, currentlyExcluded: true, lastSessionEndAt: NOW }))
      .toEqual({ action: "skip", reason: "excluded" });
  });

  it("refetches everything when the max age is zero", () => {
    for (const overrides of [
      {},
      { prior: prior({ excludedReason: "trial" }), currentlyExcluded: true },
      { prior: prior({ remainingCredits: 1_000 }) },
    ] satisfies Partial<PairRefreshInput>[]) {
      expect(decide({ ...overrides, maxAgeMinutes: 0 }))
        .toEqual({ action: "refetch", reason: "reuse-disabled" });
    }
  });
});

describe("getCreditRefreshMaxAgeMinutes", () => {
  const original = process.env.CREDIT_REFRESH_MAX_AGE_MINUTES;

  afterEach(() => {
    if (original === undefined) delete process.env.CREDIT_REFRESH_MAX_AGE_MINUTES;
    else process.env.CREDIT_REFRESH_MAX_AGE_MINUTES = original;
  });

  it("defaults to 180 minutes when unset or blank", () => {
    expect(getCreditRefreshMaxAgeMinutes(undefined)).toBe(CREDIT_REFRESH_MAX_AGE_MINUTES_DEFAULT);
    expect(getCreditRefreshMaxAgeMinutes("  ")).toBe(CREDIT_REFRESH_MAX_AGE_MINUTES_DEFAULT);
  });

  it("reads a configured value, with 0 as the off-switch", () => {
    expect(getCreditRefreshMaxAgeMinutes("45")).toBe(45);
    expect(getCreditRefreshMaxAgeMinutes("0")).toBe(0);
  });

  // Fail closed: a typo must not silently buy a longer reuse window.
  it("treats an unparseable or negative value as always-refetch", () => {
    expect(getCreditRefreshMaxAgeMinutes("soon")).toBe(0);
    expect(getCreditRefreshMaxAgeMinutes("-30")).toBe(0);
  });

  it("reads process.env by default", () => {
    process.env.CREDIT_REFRESH_MAX_AGE_MINUTES = "30";
    expect(getCreditRefreshMaxAgeMinutes()).toBe(30);
  });
});
