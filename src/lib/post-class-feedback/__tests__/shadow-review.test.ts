import { describe, expect, it } from "vitest";

import { selectFreshPostClassShadowSync } from "../shadow-review";

function run(overrides: Partial<Parameters<typeof selectFreshPostClassShadowSync>[0][number]> = {}) {
  return {
    id: "sync-current",
    finishedAt: new Date("2026-07-21T03:00:00.000Z"),
    detailFetchedCount: 3,
    sessionCount: 3,
    assessedCount: 2,
    metadata: { outcome: "success", policyVersion: 2, mappingVersion: 4 },
    ...overrides,
  };
}

describe("selectFreshPostClassShadowSync", () => {
  const mappingUpdatedAt = new Date("2026-07-21T02:00:00.000Z");

  it("accepts a non-empty successful run using the current mapping", () => {
    expect(selectFreshPostClassShadowSync([run()], 2, 4, mappingUpdatedAt)?.id).toBe("sync-current");
  });

  it.each([
    ["old policy", run({ metadata: { outcome: "success", policyVersion: 1, mappingVersion: 4 } })],
    ["old mapping", run({ metadata: { outcome: "success", policyVersion: 2, mappingVersion: 3 } })],
    ["partial outcome", run({ metadata: { outcome: "partial", policyVersion: 2, mappingVersion: 4 } })],
    ["configuration-conflicted run", run({ metadata: { outcome: "failed", policyVersion: 2, mappingVersion: 4 } })],
    ["before mapping edit", run({ finishedAt: new Date("2026-07-21T01:59:59.999Z") })],
    ["no details", run({ detailFetchedCount: 0 })],
    ["no sessions", run({ sessionCount: 0 })],
    ["no assessments", run({ assessedCount: 0 })],
  ])("rejects %s evidence", (_label, candidate) => {
    expect(selectFreshPostClassShadowSync([candidate], 2, 4, mappingUpdatedAt)).toBeNull();
  });
});
