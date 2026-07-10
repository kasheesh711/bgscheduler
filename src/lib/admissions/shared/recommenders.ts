// Admissions Case Management — client-safe recommender/college-doc constants.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing recommenders.ts re-exports
// these symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-50 (ask-status
// machine) and CM-46 (per-college doc completeness).

/** Recommender ask lifecycle (mirrors admissions_rec_status, CM-50). */
export type AdmissionsRecommenderAskStatus = "planned" | "asked" | "agreed" | "declined";

/** All valid ask statuses, for boundary validation. */
export const ADMISSIONS_RECOMMENDER_ASK_STATUSES: readonly AdmissionsRecommenderAskStatus[] = [
  "planned",
  "asked",
  "agreed",
  "declined",
];

/**
 * Forward-only ask-status machine (CM-50): planned → asked → agreed|declined.
 * agreed and declined are terminal (no outgoing moves). Keys are the current
 * status; values are the statuses it may move to.
 */
export const RECOMMENDER_ASK_STATUS_TRANSITIONS: Readonly<
  Record<AdmissionsRecommenderAskStatus, readonly AdmissionsRecommenderAskStatus[]>
> = {
  planned: ["asked"],
  asked: ["agreed", "declined"],
  agreed: [],
  declined: [],
};

/**
 * True when `from → to` is a legal ask-status move (CM-50). A same-status
 * "move" returns false — updateRecommender treats it as a no-op, not a
 * transition, so this predicate only answers "is this a real forward move".
 */
export function isValidAskStatusTransition(
  from: AdmissionsRecommenderAskStatus,
  to: AdmissionsRecommenderAskStatus,
): boolean {
  return RECOMMENDER_ASK_STATUS_TRANSITIONS[from].includes(to);
}

/** College-doc kinds tracked for per-college completeness (CM-46). */
export type AdmissionsCollegeDocType = "transcript" | "school_report" | "score_send";

/** All valid college-doc types, for boundary validation. */
export const ADMISSIONS_COLLEGE_DOC_TYPES: readonly AdmissionsCollegeDocType[] = [
  "transcript",
  "school_report",
  "score_send",
];

/** Type predicate for stored doc_type text (fail-closed reads skip unknowns). */
export function isAdmissionsCollegeDocType(value: string): value is AdmissionsCollegeDocType {
  return (ADMISSIONS_COLLEGE_DOC_TYPES as readonly string[]).includes(value);
}
