import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { PostClassValidationError } from "./errors";
import { postClassDeductionExemption } from "./deduction-exemption";
import type { SessionDeductionExemption } from "./types";

export interface DeductionCandidateEvidence {
  deductionExemption?: SessionDeductionExemption | null;
  sessionEligible: boolean;
  sessionSourceStatus: string;
  formMappingValid: boolean;
  hasBlockingGlobalSourceIssue: boolean;
  assessment: {
    sourceReady: boolean;
    sourceStatus: string;
    enforcementMode: string;
    objectiveViolation: boolean;
    rawOnTime: boolean;
    adjustedCompliant: boolean;
    policyApplies: boolean;
  } | null;
}

export function assertPostClassDeductionCandidateStillActionable(
  evidence: DeductionCandidateEvidence,
): void {
  if (evidence.deductionExemption) {
    throw new PostClassValidationError(`The session is exempt from deductions (${evidence.deductionExemption.reason}).`);
  }
  if (!evidence.sessionEligible) {
    throw new PostClassValidationError("The session is no longer eligible for a deduction.");
  }
  if (
    evidence.sessionSourceStatus !== "ready" ||
    !evidence.formMappingValid ||
    evidence.hasBlockingGlobalSourceIssue ||
    !evidence.assessment ||
    !evidence.assessment.sourceReady ||
    evidence.assessment.sourceStatus !== "ready"
  ) {
    throw new PostClassValidationError(
      "Current Wise evidence is paused or ambiguous; resync before continuing.",
    );
  }
  if (
    evidence.assessment.enforcementMode !== "live" ||
    !evidence.assessment.policyApplies
  ) {
    throw new PostClassValidationError("The current assessment is outside live enforcement.");
  }
  if (evidence.assessment.rawOnTime || evidence.assessment.adjustedCompliant) {
    throw new PostClassValidationError("The session is compliant and cannot be deducted.");
  }
  if (!evidence.assessment.objectiveViolation) {
    throw new PostClassValidationError("The current assessment is no longer an objective violation.");
  }
}

export function deductionEvidenceIssue(evidence: DeductionCandidateEvidence | undefined): string | null {
  if (!evidence) return "Current deduction evidence could not be verified.";
  try {
    assertPostClassDeductionCandidateStillActionable(evidence);
    return null;
  } catch (error) {
    if (error instanceof PostClassValidationError) return error.message;
    throw error;
  }
}

/** One shared current-policy/current-mapping read for approval, publishing and reconciliation. */
export async function loadCurrentDeductionEvidence(db: Database, sessionIds: string[]) {
  const result = new Map<string, DeductionCandidateEvidence & { fieldFailures: string[] }>();
  if (!sessionIds.length) return result;
  const [[settings], [blockingIssue], sessions] = await Promise.all([
    db.select().from(schema.postClassSettings).where(eq(schema.postClassSettings.id, "default")).limit(1),
    db.select({ id: schema.postClassSourceIssues.id }).from(schema.postClassSourceIssues).where(and(
      eq(schema.postClassSourceIssues.scope, "global"), eq(schema.postClassSourceIssues.status, "open"),
      eq(schema.postClassSourceIssues.blocksEnforcement, true),
    )).limit(1),
    db.select().from(schema.postClassSessions).where(inArray(schema.postClassSessions.id, sessionIds)),
  ]);
  if (!settings) return result;
  const latestVersionIds = sessions.flatMap(s => s.latestFeedbackVersionId ? [s.latestFeedbackVersionId] : []);
  // Only the canonical current version may excuse a deduction. A deleted or
  // superseded absence note in immutable history must not clear a later class.
  const versions = latestVersionIds.length ? await db.select().from(schema.postClassFeedbackVersions)
    .where(inArray(schema.postClassFeedbackVersions.id, latestVersionIds)) : [];
  const versionById = new Map(versions.map(v => [v.id, v]));
  const assessments = await db.selectDistinctOn([schema.postClassAssessments.sessionId])
    .from(schema.postClassAssessments).where(and(
      inArray(schema.postClassAssessments.sessionId, sessionIds),
      eq(schema.postClassAssessments.policyVersion, settings.policyVersion),
      eq(schema.postClassAssessments.mappingVersion, settings.formMappingVersion),
    )).orderBy(asc(schema.postClassAssessments.sessionId), desc(schema.postClassAssessments.assessedAt),
      desc(schema.postClassAssessments.createdAt), desc(schema.postClassAssessments.id));
  const bySession = new Map(assessments.map(a => [a.sessionId, a]));
  for (const session of sessions) {
    const a = bySession.get(session.id);
    const v = session.latestFeedbackVersionId ? versionById.get(session.latestFeedbackVersionId) : null;
    result.set(session.id, {
      deductionExemption: session.sourceStatus === "ready" && settings.formMappingValid && !blockingIssue ? postClassDeductionExemption({
        canonicalTutorKey: session.canonicalTutorKey, className: session.className,
        subject: typeof session.sourceMetadata.subject === "string" ? session.sourceMetadata.subject : null,
        feedbackFields: v?.profile.trim().toLocaleLowerCase("en-US") === "teacher" ? [v] : [],
      }) : null,
      sessionEligible: session.eligible && session.wiseDeletedAt === null,
      sessionSourceStatus: session.sourceStatus,
      formMappingValid: settings.formMappingValid,
      hasBlockingGlobalSourceIssue: Boolean(blockingIssue),
      fieldFailures: a?.fieldFailures ?? [],
      assessment: a ? { ...a, policyApplies: a.details?.policyApplies === true } : null,
    });
  }
  return result;
}
