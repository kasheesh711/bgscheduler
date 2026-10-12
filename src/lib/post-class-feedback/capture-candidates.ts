import { deductionEvidenceIssue, type DeductionCandidateEvidence } from "./deduction-evidence";

type CaptureCandidateEvidence = DeductionCandidateEvidence & {
  fieldFailures: string[];
  enforcementPaused?: boolean;
  timingReviewRequired: boolean;
  assessmentDeadlineAt: string | null;
};

/** Read-only projection of the existing deduction rules at the stored deadline. */
export function captureCandidateDecision(session: { deadlineAt: Date; deductionStatus: string }, evidence: CaptureCandidateEvidence | undefined) {
  if (evidence?.enforcementPaused) return { capture: false, unresolved: false };
  if (["waived", "reversed"].includes(session.deductionStatus)) return { capture: false, unresolved: false };
  if (!evidence?.assessment || evidence.timingReviewRequired || evidence.assessmentDeadlineAt !== session.deadlineAt.toISOString()) {
    return { capture: false, unresolved: true };
  }
  const assessment = evidence.assessment;
  // Before the deadline, an absent or invalid comment has not yet become a
  // violation. Use the stored content-policy failures to prepare that class.
  // This projection does not create or approve a deduction.
  const projected = {
    ...evidence,
    assessment: {
      ...assessment,
      sourceReady: assessment.sourceStatus === "ready",
      objectiveViolation: assessment.objectiveViolation || evidence.fieldFailures.length > 0,
    },
  };
  const issue = deductionEvidenceIssue(projected);
  if (!issue) return { capture: true, unresolved: false };
  const unresolved = evidence.sessionSourceStatus !== "ready" || !evidence.formMappingValid || evidence.hasBlockingGlobalSourceIssue || assessment.sourceStatus !== "ready";
  return { capture: false, unresolved };
}
