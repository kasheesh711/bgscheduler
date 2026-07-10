// Admissions Case Management — client-safe activity limits, closed value
// lists, and the Common App / UC variant-block Zod schemas.
//
// Pure module: imports only zod — safe to import from "use client"
// components. The db-facing activities.ts re-exports these symbols so
// existing lib/route/test consumers keep their import paths.
//
// Design: docs/casemanagementsystem_design.md — PRD CM-70/CM-71 (activity
// hard limits and platform variant blocks).

import { z } from "zod";

// ── Hard limits (CM-70/71) — UI counters must mirror these ──────────────

/** Max live (non-deleted) activities per case (CM-70 "≤ ~20"). */
export const MAX_ACTIVE_ACTIVITIES_PER_CASE = 20;

/** Max activities in the Common App rank list (CM-71 "top 10"). */
export const MAX_COMMON_APP_RANKED_ACTIVITIES = 10;

/** Common App position/leadership hard char limit. */
export const COMMON_APP_POSITION_MAX_CHARS = 50;

/** Common App organization name hard char limit. */
export const COMMON_APP_ORGANIZATION_MAX_CHARS = 100;

/** Common App activity description hard char limit. */
export const COMMON_APP_DESCRIPTION_MAX_CHARS = 150;

/** Common App hours-per-week upper bound (a week has 168 hours). */
export const COMMON_APP_HOURS_PER_WEEK_MAX = 168;

/** Common App weeks-per-year upper bound. */
export const COMMON_APP_WEEKS_PER_YEAR_MAX = 52;

/** UC activity description hard char limit. */
export const UC_DESCRIPTION_MAX_CHARS = 350;

// ── Closed value lists ──────────────────────────────────────────────────

/** Common App grade-level participation options ("post" = post-graduate). */
export const ADMISSIONS_ACTIVITY_GRADES = ["9", "10", "11", "12", "post"] as const;

/** One Common App grade-level option. */
export type AdmissionsActivityGrade = (typeof ADMISSIONS_ACTIVITY_GRADES)[number];

/** Common App participation-timing options. */
export const ADMISSIONS_ACTIVITY_TIMINGS = ["school_year", "school_break", "all_year"] as const;

/** One Common App participation-timing option. */
export type AdmissionsActivityTiming = (typeof ADMISSIONS_ACTIVITY_TIMINGS)[number];

/**
 * The official UC application activity categories (UC "Activities & awards"
 * section), encoded as stable snake_case keys.
 */
export const UC_ACTIVITY_CATEGORIES = [
  "award_or_honor",
  "educational_prep_program",
  "extracurricular_activity",
  "other_coursework",
  "volunteering_community_service",
  "work_experience",
] as const;

/** One official UC activity category key. */
export type UcActivityCategory = (typeof UC_ACTIVITY_CATEGORIES)[number];

/** Display labels for the official UC categories (UI dropdown source). */
export const UC_ACTIVITY_CATEGORY_LABELS: Record<UcActivityCategory, string> = {
  award_or_honor: "Award or honor",
  educational_prep_program: "Educational preparation program",
  extracurricular_activity: "Extracurricular activity",
  other_coursework: "Other coursework",
  volunteering_community_service: "Volunteering / community service",
  work_experience: "Work experience",
};

// ── Zod blocks (module-scope, .safeParse only) ──────────────────────────

/**
 * Common App variant block stored in admissions_activities.common_app
 * (CM-70). Every field is optional — students fill drafts incrementally —
 * but each present field is HARD-capped; unknown keys are rejected
 * (strictObject). `grades` is a duplicate-free subset of
 * ADMISSIONS_ACTIVITY_GRADES.
 */
export const admissionsCommonAppBlockSchema = z.strictObject({
  position: z.string().max(COMMON_APP_POSITION_MAX_CHARS),
  organization: z.string().max(COMMON_APP_ORGANIZATION_MAX_CHARS),
  description: z.string().max(COMMON_APP_DESCRIPTION_MAX_CHARS),
  hrsWeek: z.number().min(0).max(COMMON_APP_HOURS_PER_WEEK_MAX),
  weeksYear: z.number().int().min(0).max(COMMON_APP_WEEKS_PER_YEAR_MAX),
  grades: z
    .array(z.enum(ADMISSIONS_ACTIVITY_GRADES))
    .refine((grades) => new Set(grades).size === grades.length, {
      message: "duplicate grade levels",
    }),
  timing: z.enum(ADMISSIONS_ACTIVITY_TIMINGS),
}).partial();

/** Parsed Common App block ({ position?, organization?, … }). */
export type AdmissionsCommonAppBlock = z.infer<typeof admissionsCommonAppBlockSchema>;

/**
 * UC variant block stored in admissions_activities.uc (CM-70): description
 * hard-capped at UC_DESCRIPTION_MAX_CHARS, category from the official UC
 * list. Fields optional (draft-friendly); unknown keys rejected.
 */
export const admissionsUcBlockSchema = z.strictObject({
  description: z.string().max(UC_DESCRIPTION_MAX_CHARS),
  category: z.enum(UC_ACTIVITY_CATEGORIES),
}).partial();

/** Parsed UC block ({ description?, category? }). */
export type AdmissionsUcBlock = z.infer<typeof admissionsUcBlockSchema>;
