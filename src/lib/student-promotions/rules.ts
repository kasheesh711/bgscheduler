export const STUDENT_PROMOTION_TARGET_DATE = "2026-07-01";
export const STUDENT_PROMOTION_CRON_READY_AT_UTC = "2026-06-30T17:05:00.000Z";
export const WISE_GRADE_REGISTRATION_FIELD_ID = "if89sblj";
export const WISE_GRADE_REGISTRATION_FIELD_LABEL = "Current Year/Grade level";

export type PromotionTransition = "year8_to_year9" | "year11_to_year12" | "year13_to_university";

export interface ParsedGrade {
  raw: string;
  kind: "year" | "grade" | "blank" | "unparsed";
  currentYear: number | null;
}

export const YEAR_8_SOURCE_SUBJECTS = [
  "Y2-8 / G1-7 (Int.)",
  "(2-STU) Y2-8 / G1-7 (Int.)",
  "(3-STU) Y2-8 / G1-7 (Int.)",
  "Y2-8 / G1-7 (Int.) Master",
  "(2-STU) Y2-8 / G1-7 (Int.) Master",
  "(3-STU) Y2-8 / G1-7 (Int.) Master",
] as const;

export const YEAR_11_SOURCE_SUBJECTS = [
  "Y9-11 / G8-10 (Int.)",
  "(2-STU) Y9-11 / G8-10 (Int.)",
  "(3-STU) Y9-11 / G8-10 (Int.)",
  "Y9-11 / G8-10 (Int.) Master",
  "(2-STU) Y9-11 / G8-10 (Int.) Master",
] as const;

export const YEAR_13_SOURCE_SUBJECTS = [
  "Y12-13 / G11-12 (Int.)",
  "(2-STU) Y12-13 / G11-12 (Int.)",
  "(3-STU) Y12-13 / G11-12 (Int.)",
  "Y12-13 / G11-12 (Int.) Master",
  "(2-STU) Y12-13 / G11-12 (Int.) Master",
  "(3-STU) Y12-13 / G11-12 (Int.) Master",
] as const;

export const GRADUATION_COURSE_SUBJECT_TARGETS: Record<string, { target: string; transition: "year13_to_university" }> = {
  "Y12-13 / G11-12 (Int.)": {
    target: "University",
    transition: "year13_to_university",
  },
  "(2-STU) Y12-13 / G11-12 (Int.)": {
    target: "(2-STU) University",
    transition: "year13_to_university",
  },
  "(3-STU) Y12-13 / G11-12 (Int.)": {
    target: "(3-STU) University",
    transition: "year13_to_university",
  },
  "Y12-13 / G11-12 (Int.) Master": {
    target: "University Master",
    transition: "year13_to_university",
  },
  "(2-STU) Y12-13 / G11-12 (Int.) Master": {
    target: "(2-STU) University Master",
    transition: "year13_to_university",
  },
  "(3-STU) Y12-13 / G11-12 (Int.) Master": {
    target: "(3-STU) University Master",
    transition: "year13_to_university",
  },
};

export const COURSE_SUBJECT_TARGETS: Record<string, { target: string | null; transition: PromotionTransition }> = {
  "Y2-8 / G1-7 (Int.)": {
    target: "Y9-11 / G8-10 (Int.)",
    transition: "year8_to_year9",
  },
  "(2-STU) Y2-8 / G1-7 (Int.)": {
    target: "(2-STU) Y9-11 / G8-10 (Int.)",
    transition: "year8_to_year9",
  },
  "(3-STU) Y2-8 / G1-7 (Int.)": {
    target: "(3-STU) Y9-11 / G8-10 (Int.)",
    transition: "year8_to_year9",
  },
  "Y2-8 / G1-7 (Int.) Master": {
    target: "Y9-11 / G8-10 (Int.) Master",
    transition: "year8_to_year9",
  },
  "(2-STU) Y2-8 / G1-7 (Int.) Master": {
    target: "(2-STU) Y9-11 / G8-10 (Int.) Master",
    transition: "year8_to_year9",
  },
  "(3-STU) Y2-8 / G1-7 (Int.) Master": {
    target: null,
    transition: "year8_to_year9",
  },
  "Y9-11 / G8-10 (Int.)": {
    target: "Y12-13 / G11-12 (Int.)",
    transition: "year11_to_year12",
  },
  "(2-STU) Y9-11 / G8-10 (Int.)": {
    target: "(2-STU) Y12-13 / G11-12 (Int.)",
    transition: "year11_to_year12",
  },
  "(3-STU) Y9-11 / G8-10 (Int.)": {
    target: "(3-STU) Y12-13 / G11-12 (Int.)",
    transition: "year11_to_year12",
  },
  "Y9-11 / G8-10 (Int.) Master": {
    target: "Y12-13 / G11-12 (Int.) Master",
    transition: "year11_to_year12",
  },
  "(2-STU) Y9-11 / G8-10 (Int.) Master": {
    target: "(2-STU) Y12-13 / G11-12 (Int.) Master",
    transition: "year11_to_year12",
  },
};

const RANGE_COURSE_PATTERN = /\b(?:y\s*\d+\s*-\s*\d+|g\s*\d+\s*-\s*\d+|grade\s*\d+\s*-\s*\d+)\b/i;

export function parseWiseGrade(value: string | null | undefined): ParsedGrade {
  const raw = String(value ?? "").trim();
  if (!raw) return { raw, kind: "blank", currentYear: null };
  const normalized = raw.toLowerCase();

  const year = normalized.match(/(?:^|\b)(?:year|yr|y)\s*(\d{1,2})(?:\b|$)/);
  if (year) {
    return { raw, kind: "year", currentYear: Number(year[1]) };
  }

  const grade = normalized.match(/(?:^|\b)(?:grade|gr|g)\s*(\d{1,2})(?:\b|$)/);
  if (grade) {
    return { raw, kind: "grade", currentYear: Number(grade[1]) + 1 };
  }

  return { raw, kind: "unparsed", currentYear: null };
}

export function formatPromotedGrade(currentYear: number): string {
  return `Year ${currentYear + 1} / Grade ${currentYear}`;
}

export function requiredYearForTransition(transition: PromotionTransition): number {
  if (transition === "year8_to_year9") return 8;
  if (transition === "year11_to_year12") return 11;
  return 13;
}

export function gradeActionTypeFor(currentYear: number, subjects: string[]): string {
  if (currentYear === 13) return "graduation_review";
  if (currentYear === 8 && subjects.some((subject) => COURSE_SUBJECT_TARGETS[subject]?.transition === "year8_to_year9")) {
    return "year8_course_and_grade";
  }
  if (currentYear === 11 && subjects.some((subject) => COURSE_SUBJECT_TARGETS[subject]?.transition === "year11_to_year12")) {
    return "year11_course_and_grade";
  }
  return "grade_increment_only";
}

export function isUnmappedRangeCourseSubject(subject: string): boolean {
  return RANGE_COURSE_PATTERN.test(subject)
    && !COURSE_SUBJECT_TARGETS[subject]
    && !GRADUATION_COURSE_SUBJECT_TARGETS[subject];
}
