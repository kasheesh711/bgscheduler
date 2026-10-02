import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { AtomLessonEvidence } from "./types";

/** A result repeated in a transcript is not independently matched Atom evidence. */
export function validateAtomStatisticClaims(fields: FeedbackFieldAnswers, evidence: AtomLessonEvidence | null): string[] {
  if (!evidence || evidence.status === "matched") return [];
  const resultClaim = /\b(?:scored?|results?|marks?|SAS)\b[^.!?\n]{0,80}\b\d+|\b\d+\s*(?:\/|out of)\s*\d+\b[^.!?\n]{0,50}\b(?:correct|scores?|marks?|answers?|questions?)\b|\b(?:got|achieved|answered|completed)\b[^.!?\n]{0,40}\b\d+\s*(?:\/|out of)\s*\d+|\b\d+\s+(?:correct answers?|answers? correct|questions? correct)\b/iu;
  return (["topics", "performance", "improvement"] as const).some(field => resultClaim.test(fields[field]))
    ? ["atom:unmatched_result_statistic"] : [];
}
