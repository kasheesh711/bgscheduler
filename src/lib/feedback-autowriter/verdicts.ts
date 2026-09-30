import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { AutowriterCriticalCategory, AutowriterVerdictSeverity } from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { AutowriterReviewError } from "./api";
import { recordIncident } from "./incidents";
import { downgradeOf, isAccurate } from "./quality";

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

/** The owner's words for the stored severities ("factual" is a major error: a real fix). */
export const SEVERITY_LABELS: Record<AutowriterVerdictSeverity, string> = {
  cosmetic: "Cosmetic",
  factual: "Major (real fix)",
  critical: "Critical",
};

export interface VerdictInput {
  wiseSessionId: string;
  /** The first shot's fields_sha256 the reviewer saw. */
  fieldsSha256: string;
  /** The current verdict the reviewer's page showed (null: none). */
  currentVerdictId: string | null;
  /** The open flags the reviewer's page showed; only these are resolved. */
  seenFlagIds: readonly string[];
  verdict: "approve" | "needs_fix";
  severity: AutowriterVerdictSeverity | null;
  criticalCategory: AutowriterCriticalCategory | null;
  note: string | null;
  /** The reviewer confirmed replacing a harsher judgement (critical, or major) with a milder verdict. */
  confirmDowngrade?: boolean;
  reviewer: string;
  source: "dashboard" | "backfill";
}

export interface RecordedVerdict {
  verdictId: string;
  supersedesId: string | null;
  resolvedFlags: number;
  criticalIncident: boolean;
  /** The judgement this verdict downgraded (a noted, confirmed owner act), or null. */
  downgradedFrom: "critical" | "factual" | null;
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

const STALE_PAGE = "New activity since you loaded this class (a new verdict or flag). Refresh and review again.";

/**
 * Append the owner's verdict on a class's first shot and make it current, in one transaction: the verdict row,
 * `reviews.current_verdict_id`, the flags the owner saw (only those — a flag raised since stays open), the end of
 * the transcript's review window for an accurate verdict (a major or critical one re-opens it), and — for a critical
 * verdict — a critical incident. Refused (409) when the page is stale: the class has another current verdict, or its
 * open flags are not exactly the ones shown. Replacing a harsher judgement with a milder verdict — a critical verdict
 * or critical flag with anything non-critical, a major verdict with cosmetic or Approve — is a deliberate downgrade:
 * it needs `confirmDowngrade` (409 without) and a note (400), and is recorded as `downgraded_from`.
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
    if (review.currentVerdictId !== input.currentVerdictId) throw new AutowriterReviewError(STALE_PAGE, 409);
    const openFlags = await tx.select({ id: FL.id, suggestedSeverity: FL.suggestedSeverity }).from(FL)
      .where(and(eq(FL.wiseSessionId, input.wiseSessionId), isNull(FL.resolvedByVerdictId)))
      .for("update");
    const seen = new Set(input.seenFlagIds);
    if (openFlags.length !== seen.size || openFlags.some((flag) => !seen.has(flag.id))) {
      throw new AutowriterReviewError(STALE_PAGE, 409);
    }
    const [current] = review.currentVerdictId
      ? await tx.select({ verdict: V.verdict, severity: V.severity }).from(V).where(eq(V.id, review.currentVerdictId))
      : [];
    const downgradedFrom = downgradeOf({
      current: current ?? null,
      openCriticalFlag: openFlags.some((flag) => flag.suggestedSeverity === "critical"),
      next: input,
    });
    if (downgradedFrom && input.confirmDowngrade !== true) {
      throw new AutowriterReviewError(
        `This replaces a ${downgradedFrom === "critical" ? "critical" : "major"} judgement with a milder verdict. `
          + "A verdict judges the first shot as posted: confirm the downgrade and say why in the note.", 409,
      );
    }
    if (downgradedFrom && !input.note?.trim()) {
      throw new AutowriterReviewError("A downgrade needs a note saying why.", 400);
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
      downgradedFrom,
    }).returning({ id: V.id });
    await tx.update(R).set({ currentVerdictId: verdict.id, reviewedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(R.wiseSessionId, input.wiseSessionId));
    const resolved = openFlags.length > 0
      ? await tx.update(FL).set({ resolvedByVerdictId: verdict.id })
        .where(and(inArray(FL.id, openFlags.map((flag) => flag.id)), isNull(FL.resolvedByVerdictId)))
        .returning({ id: FL.id })
      : [];
    // Triage of a verified post ends with an accurate verdict (approve, or a cosmetic fix): its Soniox transcript
    // (kept for review, at most 72 h) may then go. A major or critical verdict keeps it for the root-cause work until
    // the 72 h window closes — also when it replaces an earlier Approve that ended triage (the sweep has not deleted
    // the job yet unless it already ran). Housekeeping only: `updated_at` is left alone.
    if (isAccurate(input)) {
      await tx.update(S).set({
        metadata: sql`feedback_autowriter_sessions.metadata || jsonb_build_object('triagedAt', now()::text)`,
      }).where(and(eq(S.wiseSessionId, input.wiseSessionId), eq(S.state, "verified"), sql`not (feedback_autowriter_sessions.metadata ? 'triagedAt')`));
    } else {
      await tx.update(S).set({ metadata: sql`feedback_autowriter_sessions.metadata - 'triagedAt'` })
        .where(and(eq(S.wiseSessionId, input.wiseSessionId), sql`feedback_autowriter_sessions.metadata ? 'triagedAt'`));
    }
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
    return {
      verdictId: verdict.id,
      supersedesId: review.currentVerdictId,
      resolvedFlags: resolved.length,
      criticalIncident,
      downgradedFrom,
    };
  });
}
