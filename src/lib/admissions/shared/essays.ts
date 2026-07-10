// Admissions Case Management — client-safe essay-status constants.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing essays.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-60..CM-63.

/** Essay progress stage (mirrors admissions_essay_status). */
export type AdmissionsEssayStatus =
  | "not_started"
  | "brainstorming"
  | "drafting"
  | "feedback"
  | "final";

/** All valid essay stages, for boundary validation. */
export const ADMISSIONS_ESSAY_STATUSES: readonly AdmissionsEssayStatus[] = [
  "not_started",
  "brainstorming",
  "drafting",
  "feedback",
  "final",
];
