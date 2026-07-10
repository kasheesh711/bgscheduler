// Admissions Case Management — client-safe college-list status unions.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing colleges.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-40..CM-44 (college
// list rounds/statuses/categories) and CM-43 (decision chain events).

/** Application round (mirrors admissions_app_round). */
export type AdmissionsAppRound =
  | "ed"
  | "ed2"
  | "ea"
  | "rea"
  | "rd"
  | "rolling"
  | "priority"
  | "other";

/** All valid application rounds, for boundary validation. */
export const ADMISSIONS_APP_ROUNDS: readonly AdmissionsAppRound[] = [
  "ed",
  "ed2",
  "ea",
  "rea",
  "rd",
  "rolling",
  "priority",
  "other",
];

/** Display labels for application rounds (calendar titles, UI chips). */
export const ADMISSIONS_APP_ROUND_LABELS: Record<AdmissionsAppRound, string> = {
  ed: "ED",
  ed2: "ED II",
  ea: "EA",
  rea: "REA",
  rd: "RD",
  rolling: "Rolling",
  priority: "Priority",
  other: "Other",
};

/** Application progress (mirrors admissions_app_status). */
export type AdmissionsAppStatus = "researching" | "applying" | "submitted" | "complete";

/** All valid application statuses, for boundary validation. */
export const ADMISSIONS_APP_STATUSES: readonly AdmissionsAppStatus[] = [
  "researching",
  "applying",
  "submitted",
  "complete",
];

/** Reach/match/safety category (mirrors admissions_college_category). */
export type AdmissionsCollegeCategory = "reach" | "match" | "safety" | "unset";

/** All valid list categories, for boundary validation. */
export const ADMISSIONS_COLLEGE_CATEGORIES: readonly AdmissionsCollegeCategory[] = [
  "reach",
  "match",
  "safety",
  "unset",
];

/** Decision-chain event (mirrors admissions_decision_event). */
export type AdmissionsDecisionEvent =
  | "submitted"
  | "deferred"
  | "waitlisted"
  | "accepted"
  | "denied"
  | "withdrawn"
  | "committed";

/** All valid decision events, for boundary validation. */
export const ADMISSIONS_DECISION_EVENTS: readonly AdmissionsDecisionEvent[] = [
  "submitted",
  "deferred",
  "waitlisted",
  "accepted",
  "denied",
  "withdrawn",
  "committed",
];
