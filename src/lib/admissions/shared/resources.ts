// Admissions Case Management — client-safe resource-topic constants.
//
// Pure module: no database, audit, or server-only imports — safe to import
// from "use client" components. The db-facing resources.ts re-exports these
// symbols so existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-92 (resource library
// topics mirror the 10 checklist phases plus a "general" bucket).

import { ADMISSIONS_CHECKLIST_PHASES, type AdmissionsPhaseKey } from "./config";
import { admissionsHttpsUrlSchema } from "./urls";

/** Resource topic: one of the 10 checklist phase keys, or "general". */
export type AdmissionsResourceTopic = AdmissionsPhaseKey | "general";

/**
 * The canonical resource topics in display order (CM-92): the 10 checklist
 * phases from config.ts followed by the "general" catch-all bucket.
 */
export const ADMISSIONS_RESOURCE_TOPICS: ReadonlyArray<{
  key: AdmissionsResourceTopic;
  label: string;
}> = [
  ...ADMISSIONS_CHECKLIST_PHASES,
  { key: "general", label: "General" },
];

/** Type guard: is `value` a known resource topic key? */
export function isAdmissionsResourceTopic(value: string): value is AdmissionsResourceTopic {
  return ADMISSIONS_RESOURCE_TOPICS.some((entry) => entry.key === value);
}

/** Display label for a resource topic key, or null when the key is unknown. */
export function getResourceTopicLabel(topic: string): string | null {
  const entry = ADMISSIONS_RESOURCE_TOPICS.find((candidate) => candidate.key === topic);
  return entry ? entry.label : null;
}

/**
 * Resource URL validation (CM-92): a well-formed absolute URL that MUST use
 * https — plain http, other schemes, and non-URLs are all rejected. Shared by
 * the lib mutations and the route body schemas so both layers enforce the
 * same rule.
 */
export const admissionsResourceUrlSchema = admissionsHttpsUrlSchema;
