import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { feedbackAtomSyncRuns, feedbackIsebRollouts } from "@/lib/db/schema";
import { activeFormatGuide, validateIsebFormat } from "./format";
import { normalizeFields } from "./first-shot";
import { evidenceHash } from "./atom/evidence";
import { passingStoredVerdict } from "./judge";
import { AutowriterReviewError } from "./api";
import { validateAtomStatisticClaims } from "./atom/statistics";
import type { AtomLessonEvidence } from "./atom/types";

export const ISEB_ROLLOUT_ID = "iseb-format-1-mimi-2";
export function hasIsebApproval(row: typeof feedbackIsebRollouts.$inferSelect | null): boolean {
  return Boolean(row?.approvedAt && row.approvedBy && row.comparisonHash);
}
export function hasAtomProof(row: typeof feedbackIsebRollouts.$inferSelect | null): boolean {
  return hasIsebApproval(row) && Boolean(row?.cloudProofRunId && row.unattendedConfirmedBy);
}
export function isSuccessfulCloudCollection(run: typeof feedbackAtomSyncRuns.$inferSelect | null): boolean {
  const snapshots = run?.counts.snapshots;
  const activities = run?.counts.activities;
  return Boolean(run && run.status === "succeeded" && run.triggerSource === "cron" && run.deploymentId?.trim() &&
    typeof snapshots === "number" && Number.isSafeInteger(snapshots) && snapshots > 0 &&
    typeof activities === "number" && Number.isSafeInteger(activities) && activities > 0);
}
export async function readIsebRollout(db: Database) {
  const [row] = await db.select().from(feedbackIsebRollouts).where(eq(feedbackIsebRollouts.id, ISEB_ROLLOUT_ID)).limit(1);
  return row ?? null;
}
export async function approvedFormatGuide(db: Database, tutorKey: string | undefined, classDetails: readonly string[]) {
  const guide = activeFormatGuide(tutorKey, classDetails);
  if (!guide) return null;
  const row = await readIsebRollout(db);
  return hasIsebApproval(row) ? guide : null;
}
export async function atomRolloutApproved(db: Database): Promise<boolean> {
  const row = await readIsebRollout(db);
  return hasAtomProof(row);
}

/** The exact reviewed comparison bundle, not a count supplied by a caller. */
export function validateComparisonBundle(receipt: Record<string, unknown>, hash: string): boolean {
  if (evidenceHash(receipt) !== hash || !Array.isArray(receipt.comparisons)) return false;
  const rows = receipt.comparisons as Array<Record<string, unknown>>;
  if (rows.length !== 20 || new Set(rows.map(row => row.id)).size !== 20) return false;
  if (rows.filter(row => row.tutor === "Mimi").length !== 10) return false;
  if (!["Kevin", "Gift", "Ek", "Peat"].every(tutor => rows.some(row => row.tutor === tutor))) return false;
  return rows.every(row => {
    const result = row.result as Record<string, unknown> | undefined;
    const format = result?.formatGuide as { id?: string; version?: number } | undefined;
    const style = result?.styleGuide as { id?: string; version?: number } | undefined;
    const fields = result?.fields && typeof result.fields === "object" ? normalizeFields(result.fields as Record<string, unknown>) : null;
    return ["Mimi", "Kevin", "Gift", "Ek", "Peat"].includes(String(row.tutor)) && result?.kind === "draft" &&
      format?.id === "iseb" && format.version === 1 && (row.tutor !== "Mimi" || (style?.id === "mimi" && style.version === 2)) &&
      passingStoredVerdict(result.judge) && /^[a-f0-9]{64}$/u.test(String(row.sourceHash)) && Boolean(fields && !validateIsebFormat(fields).length &&
        !validateAtomStatisticClaims(fields, result.atomEvidence as AtomLessonEvidence | null ?? null).length);
  });
}
export async function approveIsebComparisons(db: Database, hash: string, actor: string) {
  const row = await readIsebRollout(db);
  if (!row || row.comparisonHash !== hash || !validateComparisonBundle(row.receipt, hash)) {
    throw new AutowriterReviewError("The complete, current 20-draft comparison is required before approval.", 409);
  }
  const changed = await db.update(feedbackIsebRollouts).set({ approvedAt: new Date(), approvedBy: actor })
    .where(eq(feedbackIsebRollouts.comparisonHash, hash)).returning();
  if (!changed.length) throw new AutowriterReviewError("The comparison changed. Reload before approving.", 409);
}
export async function confirmUnattendedAtomProof(db: Database, runId: string, actor: string) {
  const [run] = await db.select().from(feedbackAtomSyncRuns).where(eq(feedbackAtomSyncRuns.id, runId)).limit(1);
  if (!run || !isSuccessfulCloudCollection(run)) {
    throw new AutowriterReviewError("Choose a successful scheduled cloud run that retrieved completed activities while Codex and the local computer were off.", 409);
  }
  const changed = await db.update(feedbackIsebRollouts).set({ cloudProofRunId: run.id, unattendedConfirmedBy: actor })
    .where(eq(feedbackIsebRollouts.id, ISEB_ROLLOUT_ID)).returning();
  if (!changed.length) throw new AutowriterReviewError("Save the comparison bundle first.", 409);
}
