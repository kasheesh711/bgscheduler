// Admissions Case Management — client-safe checklist-phase constants.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing config.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-20 (10-phase SummitEd
// checklist template, About You → Transition).

/**
 * The 10 checklist phases mirroring the SummitEd workbook (PRD CM-20),
 * in canonical order. `key` is the stable identifier persisted on
 * admissions_template_items.phase / admissions_case_tasks.phase; `label`
 * is the display string.
 */
export const ADMISSIONS_CHECKLIST_PHASES = [
  { key: "about_you", label: "About You" },
  { key: "academics", label: "Academics" },
  { key: "testing", label: "Testing" },
  { key: "activities", label: "Activities & Awards" },
  { key: "college_research", label: "College Research" },
  { key: "essays", label: "Essays" },
  { key: "recommendations", label: "Recommendations" },
  { key: "applications", label: "Applications" },
  { key: "decisions_aid", label: "Decisions & Financial Aid" },
  { key: "transition", label: "Transition to College" },
] as const;

/** Stable checklist phase key ("about_you" … "transition"). */
export type AdmissionsPhaseKey = (typeof ADMISSIONS_CHECKLIST_PHASES)[number]["key"];

/** Type guard: is `value` one of the 10 canonical checklist phase keys? */
export function isAdmissionsPhaseKey(value: string): value is AdmissionsPhaseKey {
  return ADMISSIONS_CHECKLIST_PHASES.some((entry) => entry.key === value);
}

/** Display label for a phase key, or null when the key is unknown. */
export function getAdmissionsPhaseLabel(phaseKey: string): string | null {
  const phase = ADMISSIONS_CHECKLIST_PHASES.find((entry) => entry.key === phaseKey);
  return phase ? phase.label : null;
}
