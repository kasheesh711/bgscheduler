import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import type { AtomLessonEvidence } from "./types";

/**
 * The evidence's own vocabulary, or a description of how it was checked, written into a post a parent reads (7 Oct:
 * "In the matched portion of Extra practice … Assistance was not marked for this portion, so I am reporting the
 * result without treating it as proof of independent mastery").
 */
const EVIDENCE_WORDING = /\bmatched[\s_-]+(?:portion|part)\b|\bwhole_activity\b|\bnot[_ ]marked[_ ](?:as[_ ])?assisted\b|\bassistance\s+(?:was|is|has)\s+not\s+(?:been\s+)?(?:marked|flagged|recorded)\b|\b(?:proof|evidence)\s+of\s+independent\s+mastery\b|\b(?:attempted|total)Questions\b|\bAtom\s+(?:evidence|data|record)\b/iu;

/** A result repeated in a transcript is not independently matched Atom evidence. */
export function validateAtomStatisticClaims(fields: FeedbackFieldAnswers, evidence: AtomLessonEvidence | null): string[] {
  if (!evidence) return [];
  const wording = (["topics", "performance", "improvement", "homework"] as const)
    .filter(field => EVIDENCE_WORDING.test(fields[field])).map(field => `atom:evidence_wording:${field}`);
  if (evidence.status === "matched") return wording;
  const resultClaim = /\b(?:scored?|results?|marks?|SAS)\b[^.!?\n]{0,80}\b\d+|\b\d+\s*(?:\/|out of)\s*\d+\b[^.!?\n]{0,50}\b(?:correct|scores?|marks?|answers?|questions?)\b|\b(?:got|achieved|answered|completed)\b[^.!?\n]{0,40}\b\d+\s*(?:\/|out of)\s*\d+|\b\d+\s+(?:correct answers?|answers? correct|questions? correct)\b/iu;
  return [...wording, ...(["topics", "performance", "improvement"] as const).some(field => resultClaim.test(fields[field]))
    ? ["atom:unmatched_result_statistic"] : []];
}
