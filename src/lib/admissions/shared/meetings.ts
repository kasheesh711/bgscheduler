// Admissions Case Management — client-safe meeting/action-item constants.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing meetings.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-31 (action items
// create tasks with owners and due dates).

/** Checklist owner for meeting action items (mirrors admissions_task_owner). */
export type AdmissionsTaskOwner = "student" | "counselor" | "parent";

/** All valid action-item owners, for boundary validation. */
export const ADMISSIONS_TASK_OWNERS: readonly AdmissionsTaskOwner[] = [
  "student",
  "counselor",
  "parent",
];

/**
 * Phase stamped on admissions_case_tasks rows created from meeting action
 * items (CM-31). Deliberately NOT one of the 10 template phase keys — these
 * tasks are ad-hoc, so itemKey stays null and template linkage stays absent.
 */
export const MEETING_ACTION_ITEM_PHASE = "custom";
