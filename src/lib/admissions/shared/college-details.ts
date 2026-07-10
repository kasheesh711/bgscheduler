export const COLLEGE_REQUIREMENT_KINDS = [
  "college_questions",
  "honors_program",
  "interview",
  "portfolio",
  "srar",
  "fafsa",
  "css_profile",
  "scholarship",
  "other",
] as const;

export type CollegeRequirementKind = (typeof COLLEGE_REQUIREMENT_KINDS)[number];

export const INTEREST_EVENT_TYPES = [
  "information_session",
  "campus_visit",
  "college_fair",
  "interview",
  "email",
  "webinar",
  "other",
] as const;

export type InterestEventType = (typeof INTEREST_EVENT_TYPES)[number];

export const SCHOLARSHIP_STATUSES = [
  "researching",
  "planned",
  "in_progress",
  "submitted",
  "awarded",
  "declined",
  "not_selected",
] as const;

export type ScholarshipStatus = (typeof SCHOLARSHIP_STATUSES)[number];

export interface CollegeResearchSource extends Record<string, unknown> {
  label: string;
  url?: string;
}
