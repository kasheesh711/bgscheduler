// ----------------------------------------------------------------------------
// Admissions caseload — shared case-status display metadata for the table and
// board views (design §5.1/§5.4). Colors reuse existing semantic tokens only:
// active → primary (sky), committed → available (green), withdrawn → conflict
// (red), completed/archived → muted. No new colors.
// ----------------------------------------------------------------------------

import type { AdmissionsCaseStatus } from "@/lib/admissions/types";

/** Canonical lifecycle display order (design §3 admissions_case_status). */
export const CASE_STATUS_ORDER: readonly AdmissionsCaseStatus[] = [
  "active",
  "committed",
  "completed",
  "withdrawn",
  "archived",
];

/** Display labels per case status. */
export const CASE_STATUS_LABELS: Record<AdmissionsCaseStatus, string> = {
  active: "Active",
  committed: "Committed",
  completed: "Completed",
  withdrawn: "Withdrawn",
  archived: "Archived",
};

/** Badge classes per case status — existing semantic tokens only. */
export const CASE_STATUS_BADGE_CLASSES: Record<AdmissionsCaseStatus, string> = {
  active: "bg-primary/10 text-primary",
  committed: "bg-available/10 text-available",
  completed: "bg-muted text-muted-foreground",
  withdrawn: "bg-conflict/10 text-conflict",
  archived: "bg-muted text-muted-foreground",
};

/** Position of `status` in the canonical lifecycle order (0-based). */
export function getCaseStatusRank(status: AdmissionsCaseStatus): number {
  return CASE_STATUS_ORDER.indexOf(status);
}
