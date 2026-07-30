/**
 * The activation gate.
 *
 * Note what deliberately changed here: a run whose `outcome` is `"partial"` now
 * PASSES when its pipeline-health metadata is good. That assertion used to be
 * inverted, and reverting it would re-break activation permanently — a
 * `session_not_found` for a session Wise deleted can never resolve, so any
 * tenant accumulates `partial` runs forever. `outcome` is no longer read at
 * all; the gate keys on `globalSourceHealthy` / `mappingObservedHealthy` plus a
 * live open-global-issue count, which are strictly stronger statements about
 * whether the pipeline can be trusted. See the module header for why blocking
 * on session-scoped issues bought no safety.
 */

import { describe, expect, it } from "vitest";

import {
  classifyPostClassShadowReviewEvidence,
  type PostClassShadowSyncEvidence,
} from "../shadow-review";

const MAPPING_UPDATED_AT = new Date("2026-07-21T02:00:00.000Z");

function run(overrides: Partial<PostClassShadowSyncEvidence> = {}): PostClassShadowSyncEvidence {
  return {
    id: "sync-current",
    finishedAt: new Date("2026-07-21T03:00:00.000Z"),
    detailFetchedCount: 10,
    sessionCount: 10,
    assessedCount: 9,
    metadata: {
      outcome: "success",
      policyVersion: 2,
      mappingVersion: 4,
      candidateCount: 10,
      readySessionCount: 10,
      globalSourceHealthy: true,
      mappingObservedHealthy: true,
    },
    ...overrides,
  };
}

function classify(
  candidate: PostClassShadowSyncEvidence,
  overrides: Partial<Parameters<typeof classifyPostClassShadowReviewEvidence>[1]> = {},
) {
  return classifyPostClassShadowReviewEvidence([candidate], {
    policyVersion: 2,
    mappingVersion: 4,
    mappingUpdatedAt: MAPPING_UPDATED_AT,
    openBlockingGlobalIssues: 0,
    ...overrides,
  });
}

function metadata(patch: Record<string, unknown>): PostClassShadowSyncEvidence {
  return run({ metadata: { ...run().metadata, ...patch } });
}

function blockedKeys(verdict: ReturnType<typeof classify>): string[] {
  return verdict.blockedBy.map((condition) => condition.key);
}

describe("classifyPostClassShadowReviewEvidence", () => {
  it("accepts a healthy, non-empty run against the current mapping", () => {
    const verdict = classify(run());
    expect(verdict.ready).toBe(true);
    expect(verdict.evidence?.id).toBe("sync-current");
    expect(verdict.blockedBy).toEqual([]);
  });

  it("accepts a run marked partial when its pipeline health is proven", () => {
    // The inverted assertion. A run can be "partial" purely because one session
    // had an ambiguous tutor identity; policy.ts already refuses to assess or
    // deduct against that session, so it says nothing about the pipeline.
    const verdict = classify(metadata({ outcome: "partial" }));
    expect(verdict.ready).toBe(true);
  });

  it.each([
    ["old policy version", metadata({ policyVersion: 1 })],
    ["old mapping version", metadata({ mappingVersion: 3 })],
    ["a run predating the mapping edit", run({ finishedAt: new Date("2026-07-21T01:59:59.999Z") })],
    ["an unfinished run", run({ finishedAt: null })],
  ])("finds no usable evidence in %s", (_label, candidate) => {
    const verdict = classify(candidate);
    expect(verdict.ready).toBe(false);
    expect(verdict.evidence).toBeNull();
    expect(blockedKeys(verdict)).toEqual(["run_present"]);
  });

  it.each([
    ["unproven global source health", metadata({ globalSourceHealthy: false }), "global_source_healthy"],
    ["a mapping never observed parsing", metadata({ mappingObservedHealthy: false }), "mapping_observed_healthy"],
    ["no detail fetched", run({ detailFetchedCount: 0 }), "detail_fetched"],
    ["no sessions observed", run({ sessionCount: 0, assessedCount: 0 }), "sessions_seen"],
    ["no sessions assessed", run({ assessedCount: 0 }), "sessions_assessed"],
  ])("blocks on %s", (_label, candidate, key) => {
    const verdict = classify(candidate);
    expect(verdict.ready).toBe(false);
    expect(blockedKeys(verdict)).toContain(key);
  });

  it("fails closed when the health metadata is absent entirely", () => {
    const verdict = classify(run({
      metadata: { outcome: "success", policyVersion: 2, mappingVersion: 4 },
    }));
    expect(verdict.ready).toBe(false);
    expect(blockedKeys(verdict)).toEqual(expect.arrayContaining([
      "global_source_healthy",
      "mapping_observed_healthy",
    ]));
  });

  it("blocks on an open blocking global issue even when the run reported healthy", () => {
    // The condition the old gate lacked: it read a historical per-run counter,
    // never the live issue table every other money gate consults.
    const verdict = classify(run(), { openBlockingGlobalIssues: 2 });
    expect(verdict.ready).toBe(false);
    expect(blockedKeys(verdict)).toContain("no_open_global_issues");
  });

  describe("session-issue rates", () => {
    const messy = metadata({ readySessionCount: 4 });

    it("blocks when too many sessions are unresolved, and reports the exact count", () => {
      const verdict = classify(messy);
      expect(verdict.ready).toBe(false);
      expect(blockedKeys(verdict)).toContain("resolvable_rate");
      expect(verdict.acknowledgeableTotal).toBe(6);
    });

    it("passes when the exact count is acknowledged with a reason", () => {
      const verdict = classify(messy, {
        acknowledgements: { sessionIssues: 6, reason: "Six known deleted classes, checked in Wise." },
      });
      expect(verdict.ready).toBe(true);
    });

    it("rejects a stale count", () => {
      const verdict = classify(messy, {
        acknowledgements: { sessionIssues: 5, reason: "Looks fine." },
      });
      expect(verdict.ready).toBe(false);
      expect(blockedKeys(verdict)).toContain("resolvable_rate");
    });

    it("rejects an acknowledgement with no reason", () => {
      const verdict = classify(messy, { acknowledgements: { sessionIssues: 6, reason: "  " } });
      expect(verdict.ready).toBe(false);
    });

    it("never lets an acknowledgement clear an absolute condition", () => {
      const verdict = classify(metadata({ readySessionCount: 4, globalSourceHealthy: false }), {
        acknowledgements: { sessionIssues: 6, reason: "Accepting the unresolved sessions." },
      });
      expect(verdict.ready).toBe(false);
      expect(blockedKeys(verdict)).toEqual(["global_source_healthy"]);
    });

    it("blocks when most candidates could not be read from Wise", () => {
      const verdict = classify(run({ detailFetchedCount: 3 }));
      expect(blockedKeys(verdict)).toContain("readable_rate");
    });
  });

  it("reports every condition, passed or not, for the checklist UI", () => {
    const verdict = classify(run());
    expect(verdict.conditions.map((condition) => condition.key)).toEqual([
      "run_present",
      "global_source_healthy",
      "mapping_observed_healthy",
      "no_open_global_issues",
      "detail_fetched",
      "sessions_seen",
      "sessions_assessed",
      "readable_rate",
      "resolvable_rate",
    ]);
    expect(verdict.conditions.every((condition) => condition.detail.length > 0)).toBe(true);
  });
});
