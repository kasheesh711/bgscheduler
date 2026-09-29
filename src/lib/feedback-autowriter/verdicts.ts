import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { AutowriterCriticalCategory, AutowriterVerdictSeverity } from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { AutowriterReviewError } from "./api";
import { recordIncident } from "./incidents";

const R = schema.feedbackAutowriterReviews;
const P = schema.feedbackAutowriterPosts;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const S = schema.feedbackAutowriterSessions;

export const CRITICAL_CATEGORY_LABELS: Record<AutowriterCriticalCategory, string> = {
  wrong_person: "Wrong person",
  billing_status: "Billing or status error",
  invented_content: "Invented content",
  should_not_have_posted: "Should not have posted",
};

export interface VerdictInput {
  wiseSessionId: string;
  /** The first shot's fields_sha256 the reviewer saw; a mismatch means the page is stale. */
  fieldsSha256: string;
  verdict: "approve" | "needs_fix";
  severity: AutowriterVerdictSeverity | null;
  criticalCategory: AutowriterCriticalCategory | null;
  note: string | null;
  reviewer: string;
  source: "dashboard" | "backfill";
}

export interface RecordedVerdict {
  verdictId: string;
  supersedesId: string | null;
  resolvedFlags: number;
  criticalIncident: boolean;
}

/** Severity and category must agree with the verdict (the table's CHECKs say the same). */
export function verdictShapeProblem(input: Pick<VerdictInput, "verdict" | "severity" | "criticalCategory">): string | null {
  if (input.verdict === "approve") {
    return input.severity !== null || input.criticalCategory !== null ? "An approval carries no severity or category." : null;
  }
  if (input.severity === null) return "Needs fix requires a severity.";
  if (input.severity === "critical" && input.criticalCategory === null) return "A critical verdict requires a category.";
  if (input.severity !== "critical" && input.criticalCategory !== null) return "Only a critical verdict has a category.";
  return null;
}

/**
 * Append the owner's verdict on a class's first shot and make it the current one, in one transaction: the verdict
 * row, `reviews.current_verdict_id`, the flags it answers, and — for a critical verdict — a critical incident for
 * the push outbox. Refuses a stale page (the pinned first-shot hash differs) and classes without a review row.
 */
export async function recordVerdict(db: Database, input: VerdictInput): Promise<RecordedVerdict> {
  const problem = verdictShapeProblem(input);
  if (problem) throw new AutowriterReviewError(problem, 400);
  return withDatabaseTransaction(db, async (tx) => {
    const [review] = await tx.select({
      currentVerdictId: R.currentVerdictId,
      firstPostId: R.firstPostId,
      fieldsSha256: P.fieldsSha256,
    }).from(R)
      .innerJoin(P, eq(P.id, R.firstPostId))
      .where(eq(R.wiseSessionId, input.wiseSessionId))
      .for("update", { of: R });
    if (!review) throw new AutowriterReviewError("No posted class to review with that session id.", 404);
    if (review.fieldsSha256 !== input.fieldsSha256) {
      throw new AutowriterReviewError("The post shown is not the recorded first shot. Refresh and review again.", 409);
    }
    const [verdict] = await tx.insert(V).values({
      wiseSessionId: input.wiseSessionId,
      targetKind: "post",
      postId: review.firstPostId,
      fieldsSha256: input.fieldsSha256,
      verdict: input.verdict,
      severity: input.severity,
      criticalCategory: input.criticalCategory,
      note: input.note,
      reviewer: input.reviewer,
      source: input.source,
      supersedesId: review.currentVerdictId,
    }).returning({ id: V.id });
    await tx.update(R).set({ currentVerdictId: verdict.id, reviewedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(R.wiseSessionId, input.wiseSessionId));
    const resolved = await tx.update(FL).set({ resolvedByVerdictId: verdict.id })
      .where(and(eq(FL.wiseSessionId, input.wiseSessionId), isNull(FL.resolvedByVerdictId)))
      .returning({ id: FL.id });
    // The owner has reviewed the posted class: its Soniox transcript (kept for review, at most 72 h) may go.
    // Only a settled `verified` row, and only the first verdict's time.
    await tx.update(S).set({
      metadata: sql`feedback_autowriter_sessions.metadata || jsonb_build_object('triagedAt', now()::text)`,
      updatedAt: sql`now()`,
    }).where(and(eq(S.wiseSessionId, input.wiseSessionId), eq(S.state, "verified"), sql`not (feedback_autowriter_sessions.metadata ? 'triagedAt')`));
    let criticalIncident = false;
    if (input.severity === "critical" && input.criticalCategory) {
      criticalIncident = await recordIncident(tx, {
        dedupeKey: `critical_verdict:${verdict.id}`,
        kind: "critical_verdict",
        severity: "critical",
        wiseSessionId: input.wiseSessionId,
        summary: `Critical verdict: ${CRITICAL_CATEGORY_LABELS[input.criticalCategory]} (recorded by ${input.reviewer})`,
        detail: { verdictId: verdict.id, category: input.criticalCategory, reviewer: input.reviewer },
      });
    }
    return { verdictId: verdict.id, supersedesId: review.currentVerdictId, resolvedFlags: resolved.length, criticalIncident };
  });
}
