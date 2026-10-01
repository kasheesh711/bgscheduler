import { describe, expect, it } from "vitest";
import { evidenceHash } from "../atom/evidence";
import { hasAtomProof, hasIsebApproval, isSuccessfulCloudCollection, validateComparisonBundle } from "../iseb-rollout";
import type { feedbackAtomSyncRuns, feedbackIsebRollouts } from "@/lib/db/schema";

const verdict = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
const fields = { topics: "1. Fractions", performance: "Tom checked his common denominators carefully and explained the addition clearly.", improvement: "1. Simplify the final fraction by checking for a common factor.", homework: "" };
function bundle() {
  return { comparisons: Array.from({ length: 20 }, (_, i) => ({
    id: String(i), tutor: i < 10 ? "Mimi" : ["Kevin", "Gift", "Ek", "Peat"][i % 4],
    sourceHash: "a".repeat(64), result: { kind: "draft", fields: { ...fields },
      styleGuide: i < 10 ? { id: "mimi", version: 2 } : null,
      formatGuide: { id: "iseb", version: 1 }, judge: { ...verdict, levels: { medium: verdict, high: verdict } } },
  })) };
}
describe("ISEB rollout receipts", () => {
  it("accepts only the hash of the complete 10 plus 10 comparison", () => {
    const receipt = bundle();
    expect(validateComparisonBundle(receipt, evidenceHash(receipt))).toBe(true);
    expect(validateComparisonBundle(receipt, "a".repeat(64))).toBe(false);
    receipt.comparisons.pop();
    expect(validateComparisonBundle(receipt, evidenceHash(receipt))).toBe(false);
  });
  it.each(["duplicate", "old_voice", "numbering", "failed_judge", "missing_tutor"])("rejects %s evidence", failure => {
    const receipt = bundle();
    if (failure === "duplicate") receipt.comparisons[1].id = receipt.comparisons[0].id;
    if (failure === "old_voice") receipt.comparisons[0].result.styleGuide!.version = 1;
    if (failure === "numbering") receipt.comparisons[0].result.fields.topics = "2. Fractions";
    if (failure === "failed_judge") receipt.comparisons[0].result.judge.levels.high = { ...verdict, faithful: false };
    if (failure === "missing_tutor") for (const row of receipt.comparisons) if (row.tutor === "Peat") row.tutor = "Kevin";
    expect(validateComparisonBundle(receipt, evidenceHash(receipt))).toBe(false);
  });
  it("keeps format approval separate from the additional Atom proof", () => {
    const row = { approvedAt: new Date(), approvedBy: "owner", comparisonHash: "hash" } as typeof feedbackIsebRollouts.$inferSelect;
    expect(hasIsebApproval(row)).toBe(true);
    expect(hasAtomProof(row)).toBe(false);
    expect(hasAtomProof({ ...row, cloudProofRunId: "run", unattendedConfirmedBy: "owner" })).toBe(true);
    expect(hasIsebApproval(null)).toBe(false);
  });
});
describe("unattended cloud proof", () => {
  const run: typeof feedbackAtomSyncRuns.$inferSelect = { id: "run", startedAt: new Date(), finishedAt: new Date(), errorCode: null,
    status: "succeeded", triggerSource: "cron", deploymentId: "dpl_cloud", counts: { snapshots: 1, activities: 1 } };
  it("accepts a successful scheduled retrieval", () => expect(isSuccessfulCloudCollection(run)).toBe(true));
  it.each([{}, { snapshots: 1 }, { snapshots: 0, activities: 1 }, { snapshots: 1, activities: 0 },
    { snapshots: "1", activities: "1" }, { snapshots: 1, activities: -1 }, { snapshots: 1, activities: NaN }])("rejects invalid counts %j", counts => {
    expect(isSuccessfulCloudCollection({ ...run, counts })).toBe(false);
  });
  it("rejects local runs, failed runs and interactive probes", () => {
    expect(isSuccessfulCloudCollection({ ...run, deploymentId: null })).toBe(false);
    expect(isSuccessfulCloudCollection({ ...run, status: "failed" })).toBe(false);
    expect(isSuccessfulCloudCollection({ ...run, triggerSource: "admin" })).toBe(false);
  });
});
