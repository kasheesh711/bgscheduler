import { z } from "zod";

export const ADMISSIONS_AWARD_GRADE_LEVELS = [
  "9",
  "10",
  "11",
  "12",
  "postgraduate",
] as const;
export type AdmissionsAwardGradeLevel = (typeof ADMISSIONS_AWARD_GRADE_LEVELS)[number];

export const ADMISSIONS_AWARD_RECOGNITION_LEVELS = [
  "school",
  "regional",
  "state",
  "national",
  "international",
] as const;
export type AdmissionsAwardRecognitionLevel =
  (typeof ADMISSIONS_AWARD_RECOGNITION_LEVELS)[number];

export const UC_AWARD_ELIGIBILITY_MAX_CHARS = 250;
export const UC_AWARD_ACHIEVEMENT_MAX_CHARS = 350;
export const MAX_COMMON_APP_RANKED_AWARDS = 5;

export const admissionsAwardGradeLevelsSchema = z
  .array(z.enum(ADMISSIONS_AWARD_GRADE_LEVELS))
  .max(ADMISSIONS_AWARD_GRADE_LEVELS.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "Duplicate award grade levels are not allowed",
  });

export const admissionsAwardRecognitionLevelsSchema = z
  .array(z.enum(ADMISSIONS_AWARD_RECOGNITION_LEVELS))
  .max(ADMISSIONS_AWARD_RECOGNITION_LEVELS.length)
  .refine((values) => new Set(values).size === values.length, {
    message: "Duplicate recognition levels are not allowed",
  });

