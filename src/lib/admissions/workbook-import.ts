import { createHash } from "node:crypto";
import {
  COMMON_APP_DESCRIPTION_MAX_CHARS,
  COMMON_APP_HOURS_PER_WEEK_MAX,
  COMMON_APP_ORGANIZATION_MAX_CHARS,
  COMMON_APP_POSITION_MAX_CHARS,
  COMMON_APP_WEEKS_PER_YEAR_MAX,
  UC_ACTIVITY_CATEGORIES,
  UC_DESCRIPTION_MAX_CHARS,
} from "./shared/activities";
import {
  normalizeTestScoreDetails,
  type AdmissionsTestScoreDetails,
} from "./shared/testing";
import {
  admissionsCoursePlanItemSchema,
  admissionsIbAcademicPayloadSchema,
  admissionsUkAcademicPayloadSchema,
  admissionsUsAcademicPayloadSchema,
  type AcademicRecordPayload,
  type AdmissionsIbAcademicPayload,
  type AdmissionsUkAcademicPayload,
  type AdmissionsUsAcademicPayload,
} from "./shared/academics";
import { isSafeAdmissionsUrl } from "./shared/urls";

/**
 * Bounded ranges from the BeGifted student workbook. Hidden master grids and
 * password-bearing portal columns are deliberately excluded from reads. The
 * import service splits the application tracker around CW while preserving
 * this logical D:DD parser contract.
 */
export const ADMISSIONS_WORKBOOK_RANGES = {
  meetings: { sheetName: "Meetings", range: "A1:F12" },
  tasks: { sheetName: "Tasks", range: "A1:L198" },
  aboutYou: { sheetName: "About You", range: "A1:H80" },
  academics: { sheetName: "Academics", range: "A1:Q100" },
  tests: { sheetName: "Tests", range: "A1:P55" },
  activities: { sheetName: "Activities -", range: "A1:U278" },
  majorsCareers: { sheetName: "Majors & Careers", range: "A1:M106" },
  collegeCriteria: { sheetName: "College Criteria", range: "A1:S91" },
  researchNotes: { sheetName: "Research Notes", range: "A1:I198" },
  essayPrompts: { sheetName: "Essay Prompts", range: "A1:P976" },
  demonstratedInterest: { sheetName: "Demonstrate Interest", range: "A1:G32" },
  applications: { sheetName: "ApplicationTracker", range: "D33:DD52" },
  financialAid: { sheetName: " FinAidComparisons", range: "A1:P43" },
  scholarships: { sheetName: "ScholarshipTracker", range: "A1:J34" },
} as const;

export type AdmissionsWorkbookRangeKey = keyof typeof ADMISSIONS_WORKBOOK_RANGES;
export type AdmissionsWorkbookRanges = Partial<Record<AdmissionsWorkbookRangeKey, unknown[][]>>;

export type AdmissionsImportIssueSeverity = "warning" | "error";

export interface AdmissionsImportIssue {
  severity: AdmissionsImportIssueSeverity;
  code: string;
  sheetName: string;
  range: string | null;
  message: string;
}

export interface AdmissionsImportFieldChange {
  target: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ImportedMeeting {
  /** Stable worksheet row identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  meetingDate: string | null;
  time: string | null;
  status: string | null;
  notes: string | null;
  nextSteps: string | null;
}

export interface ImportedTask {
  /** Stable worksheet row identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  title: string;
  status: string | null;
  topic: string | null;
  instructions: string | null;
  resourceUrl: string | null;
  notes: string | null;
  startDate: string | null;
  dueDate: string | null;
}

export interface ImportedActivity {
  /** Stable worksheet block identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  name: string;
  fullDescription: string | null;
  gradeLevels: string[];
  hoursPerWeek: number | null;
  weeksPerYear: number | null;
  commonApp: {
    position: string;
    organization: string;
    description: string;
  } | null;
  uc: { category: string; description: string } | null;
}

export interface ImportedAward {
  /** Stable worksheet block identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  title: string;
  organization: string | null;
  gradeLevels: string[];
  recognitionLevels: string[];
  eligibilityNarrative: string | null;
  achievementNarrative: string | null;
}

export interface ImportedTestSitting {
  /** Stable worksheet row identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  testType: string;
  testDate: string | null;
  subject: string | null;
  scoreDetails: Record<string, string | number>;
}

/** Converts legacy score cells through the same strict schema as live writes. */
export function normalizeImportedTestScoreDetails(
  sitting: ImportedTestSitting,
): AdmissionsTestScoreDetails | null {
  const source = sitting.scoreDetails;
  let candidate: Record<string, unknown>;
  if (sitting.testType === "sat") {
    candidate = {
      testType: "sat",
      math: Number(source.math),
      readingWriting: Number(source.readingWriting),
    };
  } else if (sitting.testType === "act") {
    candidate = {
      testType: "act",
      english: Number(source.english),
      math: Number(source.math),
      reading: Number(source.reading),
      science: Number(source.science),
    };
  } else if (sitting.testType === "ap" || sitting.testType === "ib") {
    candidate = { testType: sitting.testType, score: Number(source.score) };
  } else if (sitting.testType === "toefl") {
    candidate = {
      testType: "toefl",
      reading: Number(source.reading),
      listening: Number(source.listening),
      speaking: Number(source.speaking),
      writing: Number(source.writing),
    };
  } else if (sitting.testType === "ielts") {
    candidate = {
      testType: "ielts",
      listening: Number(source.listening),
      reading: Number(source.reading),
      writing: Number(source.writing),
      speaking: Number(source.speaking),
    };
  } else {
    candidate = {
      testType: "other",
      score: Number(source.score ?? source.total ?? source.overall),
    };
  }
  try {
    return normalizeTestScoreDetails(candidate);
  } catch {
    return null;
  }
}

export interface ImportedCollegeResearch {
  /** Stable worksheet block identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  collegeName: string;
  sources: string[];
  fitAssessment: string | null;
  academicNotes: string | null;
  generalNotes: string | null;
  campusVisitNotes: string | null;
  questions: string | null;
}

export interface ImportedInterestEvent {
  /** Stable worksheet date/notes cell pair used to reconcile reimports. */
  sourceRef?: string;
  collegeName: string;
  eventDate: string | null;
  notes: string | null;
}

export interface ImportedApplication {
  /** Stable ApplicationTracker row identity used to reconcile reimports. */
  sourceRef?: string;
  collegeName: string;
  overallStatus: string | null;
  deadline: string | null;
  round: string | null;
  admissionsUrl: string | null;
  firstChoiceMajor: string | null;
  secondChoiceMajor: string | null;
  collegeQuestionsStatus: string | null;
  essayStatus: string | null;
  testStatus: string | null;
  recommendationStatus: string | null;
  transcriptStatus: string | null;
  demonstratedInterestPolicy: string | null;
  demonstratedInterestWays: string | null;
  honorsProgramStatus: string | null;
  interviewStatus: string | null;
  portfolioStatus: string | null;
  scholarshipStatus: string | null;
  financialAidStatus: string | null;
  financialAidDeadline: string | null;
  fafsaStatus: string | null;
  decision: string | null;
  portalUrl: string | null;
  acceptedProgram: string | null;
  scholarshipType: string | null;
  scholarshipAmount: number | null;
  studentDecision: string | null;
  notes: string | null;
}

export interface ImportedFinancialAidOffer {
  /** Stable comparison-table column identity used to reconcile reimports. */
  sourceRef?: string;
  collegeName: string;
  /** Derived from the case cohort in the case-aware preview service. */
  awardYear?: number;
  cost: Record<string, number>;
  giftAid: Record<string, number>;
  loans: Record<string, number>;
  remainingBalance: number | null;
}

export interface ImportedScholarship {
  /** Stable worksheet row identity used to reconcile changed-source reimports. */
  sourceRef?: string;
  name: string;
  provider: string | null;
  providerAddress: string | null;
  contact: string | null;
  /** Optional columns supported by customized copies of the template. */
  url?: string | null;
  requirements?: string | null;
  offeredAmount?: number | null;
  collegeName?: string | null;
  deadline: string | null;
  submittedDate: string | null;
  outcome: string | null;
  notes: string | null;
}

export interface AdmissionsWorkbookPreview {
  spreadsheetId: string;
  sourceFingerprint: string;
  sourceTitle: string | null;
  profile: Record<string, string>;
  academics: Record<string, unknown>;
  /** Validated records derived from the visible Academics grid. */
  canonicalAcademicRecords: AcademicRecordPayload[];
  collegeCriteria: Record<string, unknown>;
  majorsCareers: Record<string, unknown>;
  meetings: ImportedMeeting[];
  tasks: ImportedTask[];
  activities: ImportedActivity[];
  awards: ImportedAward[];
  tests: ImportedTestSitting[];
  research: ImportedCollegeResearch[];
  interestEvents: ImportedInterestEvent[];
  applications: ImportedApplication[];
  essayPrompts: Array<{
    sourceRef?: string;
    collegeName: string;
    prompt: string;
    status: string | null;
    sourceUrl: string | null;
  }>;
  financialAid: ImportedFinancialAidOffer[];
  scholarships: ImportedScholarship[];
  issues: AdmissionsImportIssue[];
  changes: AdmissionsImportFieldChange[];
  counts: Record<string, number>;
}

/** Canonical student columns that are safe to source from About You. */
export interface ImportedCanonicalStudentProfile {
  fullName?: string;
  preferredName?: string;
  phone?: string;
  school?: string;
  schoolCounselor?: string;
}

export interface ImportedUsAcademicOmission {
  field: "gpa_unweighted" | "gpa_weighted" | "class_rank" | "class_size" | "gpa_scale";
  value: string | null;
  reason: string;
}

export interface ImportedUsAcademicDerivation {
  payload: AdmissionsUsAcademicPayload | null;
  omissions: ImportedUsAcademicOmission[];
}

export interface ImportedAcademicGridOmission {
  system: "us" | "ib" | "a_level_igcse";
  sourceRef: string;
  value: string | null;
  reason: string;
}

export interface ImportedAcademicRecordsDerivation {
  payloads: AcademicRecordPayload[];
  omissions: ImportedAcademicGridOmission[];
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DMY_DATE_PATTERN = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/;
const URL_PATTERN = /^https?:\/\//i;
const FORBIDDEN_IDENTITY_FIELD_PATTERN =
  /(^|_)(passport|national_id|nationalid|social_security|ssn|password|login_credential)(_|$)/i;

export function extractAdmissionsSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new Error("Invalid Google Sheet URL or spreadsheet ID");
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  return String(value).trim();
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText ? valueText : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = text(value).replace(/[$฿,%\s,]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function explicitDateValue(raw: string): { matched: boolean; value: string | null } {
  if (DATE_ONLY_PATTERN.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    return {
      matched: true,
      value: isValidCalendarDate(year!, month!, day!) ? raw : null,
    };
  }
  const match = DMY_DATE_PATTERN.exec(raw);
  if (!match) return { matched: false, value: null };
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[2]);
  const day = Number(match[1]);
  return {
    matched: true,
    value: isValidCalendarDate(year, month, day)
      ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : null,
  };
}

function dateValue(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const explicit = explicitDateValue(raw);
  if (explicit.matched) return explicit.value;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function hasImpossibleExplicitDate(value: unknown): boolean {
  const raw = text(value);
  if (!raw) return false;
  const explicit = explicitDateValue(raw);
  return explicit.matched && explicit.value === null;
}

function urlContainsCredentials(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

function collectImportedUrlIssue(
  issues: AdmissionsImportIssue[],
  input: {
    value: string | null | undefined;
    label: string;
    sheetName: string;
    range: string | null;
  },
): void {
  if (!input.value || isSafeAdmissionsUrl(input.value)) return;
  const containsCredentials = urlContainsCredentials(input.value);
  issues.push({
    severity: "error",
    code: containsCredentials ? "credentialed_url" : "invalid_external_url",
    sheetName: input.sheetName,
    range: input.range,
    message: containsCredentials
      ? `${input.label} contains embedded credentials and cannot be imported.`
      : `${input.label} must be an absolute http(s) URL without embedded credentials.`,
  });
}

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "false" || normalized === "# chars" || normalized === "select type" || normalized === "avg";
}

/** Converts a legacy checklist label to a canonical sent/not-sent state. */
export function normalizeImportedSentStatus(value: string | null | undefined): boolean | null {
  const normalized = text(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return null;
  if (
    /\bunsent\b|\bnot\s+(?:yet\s+)?(?:sent|submitted|received|complete|done)\b|\bnever\s+(?:sent|submitted)\b|\bincomplete\b|\bmissing\b|\bpending\b|\bto do\b|\bno\b/.test(normalized)
  ) {
    return false;
  }
  if (/\bsent\b|\bsubmitted\b|\breceived\b|\bcomplete\b|\bdone\b|\byes\b|\bwaived\b|\bfinished\b/.test(normalized)) {
    return true;
  }
  return null;
}

function compactRecord(entries: Array<[string, unknown]>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalized = text(value);
    if (normalized && !isPlaceholder(normalized)) result[key] = normalized;
  }
  return result;
}

const ABOUT_YOU_CANONICAL_KEY_ALIASES: Readonly<Record<string, string>> = {
  address: "home_address",
  cell_phone: "primary_phone",
  email: "personal_email",
  birthdate: "date_of_birth",
  citizenship: "countries_of_citizenship",
  high_school: "current_school",
  other_high_schools: "previous_schools",
};

function canonicalAboutYouKey(key: string): string {
  return ABOUT_YOU_CANONICAL_KEY_ALIASES[key] ?? key;
}

function parseProfile(rows: unknown[][]): Record<string, string> {
  const cell = (row: number, column: number) => rows[row - 1]?.[column - 1];
  const mapped = compactRecord([
    ["legal_name", cell(5, 2)],
    ["preferred_name", cell(5, 3)],
    ["home_address", cell(5, 4)],
    ["primary_phone", cell(5, 6)],
    ["personal_email", cell(5, 7)],
    ["date_of_birth", dateValue(cell(7, 2)) ?? cell(7, 2)],
    ["place_of_birth", cell(7, 3)],
    ["countries_of_citizenship", cell(7, 4)],
    ["visa", cell(7, 5)],
    ["legal_sex", cell(7, 6)],
    ["gender_identity", cell(7, 7)],
    ["favorite_snack", cell(9, 2)],
    ["languages", cell(9, 3)],
    ["hispanic_latino", cell(9, 4)],
    ["race_ethnicity", cell(9, 6)],
    ["pronouns", cell(9, 7)],
    ["current_school", cell(12, 2)],
    ["graduation_year", cell(12, 4)],
    ["parent_guardian_1", cell(12, 5)],
    ["parent_guardian_2", cell(12, 6)],
    ["gpa_unweighted", cell(14, 2)],
    ["gpa_weighted", cell(14, 3)],
    ["previous_schools", cell(14, 4)],
    ["parent_marital_status", cell(14, 5)],
    ["siblings", cell(14, 6)],
    ["class_rank", cell(16, 2)],
    ["class_size", cell(16, 3)],
    ["colleges_attended", cell(16, 4)],
    ["personality_type", cell(19, 2)],
  ]);
  // The template continues beyond the compact header block and has evolved
  // over time. Preserve additional label/value pairs so household, school
  // history, language, citizenship, and contact fields remain inspectable,
  // while explicitly dropping government-ID and credential labels.
  const discovered = parseLabelValueSheet(rows);
  for (const [key, value] of Object.entries(discovered)) {
    const canonicalKey = canonicalAboutYouKey(key);
    if (
      !FORBIDDEN_IDENTITY_FIELD_PATTERN.test(canonicalKey) &&
      typeof value === "string" &&
      mapped[canonicalKey] === undefined
    ) {
      mapped[canonicalKey] = value;
    }
  }
  return mapped;
}

/**
 * Projects only non-identity student columns. `personal_email` is intentionally
 * absent: workbook imports must never change membership or sign-in identity.
 */
export function deriveCanonicalStudentProfile(
  profile: Record<string, string>,
): ImportedCanonicalStudentProfile {
  return Object.fromEntries([
    ["fullName", profile.legal_name],
    ["preferredName", profile.preferred_name],
    ["phone", profile.primary_phone],
    ["school", profile.current_school],
    ["schoolCounselor", profile.school_counselor_contact],
  ].flatMap(([key, value]) => {
    const normalized = value?.trim();
    return normalized ? [[key, normalized]] : [];
  })) as ImportedCanonicalStudentProfile;
}

interface ParsedLegacyGpa {
  value: number | null;
  explicitScale: 4 | 5 | 100 | null;
  scaleSpecified: boolean;
}

function parseLegacyGpa(raw: string | undefined): ParsedLegacyGpa {
  if (!raw?.trim()) return { value: null, explicitScale: null, scaleSpecified: false };
  const normalized = raw.trim().replace(/,/g, "");
  const valueMatch = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!valueMatch) return { value: null, explicitScale: null, scaleSpecified: false };
  const value = Number(valueMatch[0]);
  const scaleMatch = normalized.match(/(?:\/|out\s+of|scale(?:\s+of)?)[\s:]*(\d+(?:\.\d+)?)/i);
  const scaleNumber = scaleMatch ? Number(scaleMatch[1]) : null;
  const explicitScale = scaleNumber === 4 || scaleNumber === 5 || scaleNumber === 100
    ? scaleNumber
    : null;
  return {
    value: Number.isFinite(value) && value >= 0 && value <= 100 ? value : null,
    explicitScale,
    scaleSpecified: Boolean(scaleMatch),
  };
}

function inferLegacyGpaScale(
  unweighted: ParsedLegacyGpa,
  weighted: ParsedLegacyGpa,
): 4 | 5 | 100 | null {
  for (const candidate of [unweighted, weighted]) {
    if (candidate.value === null) continue;
    if (candidate.scaleSpecified) return candidate.explicitScale;
    if (candidate.value <= 4) return 4;
    if (candidate.value <= 5) return 5;
    // Values between 5 and 50 are too ambiguous to call a 100-point GPA.
    if (candidate.value >= 50 && candidate.value <= 100) return 100;
    return null;
  }
  return null;
}

function parsePositiveInteger(raw: string | undefined): number | null {
  if (!raw?.trim() || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Converts the explicit US GPA/rank header fields only. International-school
 * worksheet grids remain in `legacy_academics` for counselor verification.
 */
export function deriveImportedUsAcademicPayload(
  profile: Record<string, string>,
): ImportedUsAcademicDerivation {
  const omissions: ImportedUsAcademicOmission[] = [];
  const unweighted = parseLegacyGpa(profile.gpa_unweighted);
  const weighted = parseLegacyGpa(profile.gpa_weighted);
  const hasUnweightedSource = Boolean(profile.gpa_unweighted?.trim());
  const hasWeightedSource = Boolean(profile.gpa_weighted?.trim());
  if (hasUnweightedSource && unweighted.value === null) {
    omissions.push({
      field: "gpa_unweighted",
      value: profile.gpa_unweighted ?? null,
      reason: "Unweighted GPA is not a number between 0 and 100.",
    });
  }
  if (hasWeightedSource && weighted.value === null) {
    omissions.push({
      field: "gpa_weighted",
      value: profile.gpa_weighted ?? null,
      reason: "Weighted GPA is not a number between 0 and 100.",
    });
  }

  const classRank = parsePositiveInteger(profile.class_rank);
  const classSize = parsePositiveInteger(profile.class_size);
  if (profile.class_rank?.trim() && classRank === null) {
    omissions.push({
      field: "class_rank",
      value: profile.class_rank,
      reason: "Class rank must be a positive whole number.",
    });
  }
  if (profile.class_size?.trim() && classSize === null) {
    omissions.push({
      field: "class_size",
      value: profile.class_size,
      reason: "Class size must be a positive whole number.",
    });
  }

  const scale = inferLegacyGpaScale(unweighted, weighted);
  const hasAnyAcademicSource = hasUnweightedSource || hasWeightedSource ||
    Boolean(profile.class_rank?.trim()) || Boolean(profile.class_size?.trim());
  if (!scale) {
    if (hasAnyAcademicSource) {
      omissions.push({
        field: "gpa_scale",
        value: profile.gpa_unweighted ?? profile.gpa_weighted ?? null,
        reason: "A 4-, 5-, or 100-point GPA scale could not be inferred safely.",
      });
    }
    return { payload: null, omissions };
  }

  let safeRank = classRank;
  if (safeRank !== null && classSize !== null && safeRank > classSize) {
    omissions.push({
      field: "class_rank",
      value: profile.class_rank ?? null,
      reason: "Class rank exceeds class size.",
    });
    safeRank = null;
  }
  if (unweighted.value !== null && unweighted.value > scale) {
    omissions.push({
      field: "gpa_unweighted",
      value: profile.gpa_unweighted ?? null,
      reason: `Unweighted GPA exceeds the inferred ${scale}-point scale.`,
    });
  }

  const candidate = {
    system: "us" as const,
    gpaScale: scale,
    ...(unweighted.value !== null && unweighted.value <= scale
      ? { unweightedGpa: unweighted.value }
      : {}),
    ...(weighted.value !== null ? { weightedGpa: weighted.value } : {}),
    ...(safeRank !== null ? { classRank: safeRank } : {}),
    ...(classSize !== null ? { classSize } : {}),
    fourYearCoursePlan: [],
  };
  const parsed = admissionsUsAcademicPayloadSchema.safeParse(candidate);
  return parsed.success ? { payload: parsed.data, omissions } : { payload: null, omissions: [
    ...omissions,
    {
      field: "gpa_scale",
      value: String(scale),
      reason: "The inferred US academic record did not pass canonical validation.",
    },
  ] };
}

const ACADEMIC_COURSE_ROWS = Array.from({ length: 13 }, (_, index) => index + 3);
const ACADEMIC_GRADE_COLUMNS = [
  { column: 5, gradeLevel: "9" as const },
  { column: 7, gradeLevel: "10" as const },
  { column: 9, gradeLevel: "11" as const },
  { column: 11, gradeLevel: "12" as const },
];

function academicSourceRef(rowIndex: number, startColumn: string, endColumn: string): string {
  return `Academics!${startColumn}${rowIndex + 1}:${endColumn}${rowIndex + 1}`;
}

function parseIbGrade(value: unknown): number | null {
  const normalized = text(value);
  if (!/^[1-7]$/.test(normalized)) return null;
  return Number(normalized);
}

function parseIbCoreGrade(value: unknown): "A" | "B" | "C" | "D" | "E" | null {
  const normalized = text(value).toUpperCase();
  return /^[A-E]$/.test(normalized)
    ? normalized as "A" | "B" | "C" | "D" | "E"
    : null;
}

function parseCasCompletion(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const normalized = text(value).toLowerCase();
  if (!normalized) return null;
  if (/^(false|no|n|incomplete|not complete|pending)$/.test(normalized)) return false;
  if (/^(true|yes|y|x|complete|completed|done)$/.test(normalized)) return true;
  return null;
}

function parseUkQualification(
  value: unknown,
): "igcse" | "as" | "a_level" | null {
  const normalized = text(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (/\bigcse\b|\bgcse\b/.test(normalized)) return "igcse";
  if (/^(as|as level)$/.test(normalized)) return "as";
  if (/\ba level\b|\badvanced level\b/.test(normalized)) return "a_level";
  return null;
}

function findExplicitAcademicUrl(
  rows: unknown[][],
  include: RegExp,
  exclude?: RegExp,
): string | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const label = text(row[columnIndex]);
      if (!include.test(label) || (exclude?.test(label) ?? false)) continue;
      const candidates = [
        row[columnIndex + 1],
        row[columnIndex + 2],
        rows[rowIndex + 1]?.[columnIndex],
        rows[rowIndex + 1]?.[columnIndex + 1],
      ];
      const url = candidates.map(text).find((candidate) => URL_PATTERN.test(candidate));
      if (url) return url;
    }
  }
  return null;
}

/**
 * Converts the student-owned cells in Academics!A1:Q100 into the same strict
 * payload variants used by the live academics API. Static labels and formula
 * defaults never create records on their own. Anything that cannot be mapped
 * without guessing remains in `legacy_academics` and is surfaced as a warning.
 */
export function deriveImportedAcademicRecords(
  profile: Record<string, string>,
  rows: unknown[][],
): ImportedAcademicRecordsDerivation {
  const payloads: AcademicRecordPayload[] = [];
  const omissions: ImportedAcademicGridOmission[] = [];
  const curriculumTrack = text(rows[1]?.[3]);
  const normalizedCurriculumTrack = curriculumTrack.toLowerCase();
  const curriculumHasMyp = /\bmyp\b/.test(normalizedCurriculumTrack);
  const curriculumHasDp = /\bdp\b|diploma programme/.test(normalizedCurriculumTrack);
  const transcriptUrl = findExplicitAcademicUrl(
    rows,
    /transcript/i,
    /gpa|school\s+profile|image|convert/i,
  );
  const schoolProfileUrl = findExplicitAcademicUrl(
    rows,
    /school\s+profile/i,
    /transcript|image|convert/i,
  );
  const academicLinks = {
    ...(transcriptUrl ? { transcriptUrl } : {}),
    ...(schoolProfileUrl ? { schoolProfileUrl } : {}),
  };
  const rawCourseRigor = text(rows[43]?.[7]);
  const normalizedCourseRigor = rawCourseRigor.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const courseRigor = normalizedCourseRigor === "most demanding"
    ? "most_demanding" as const
    : normalizedCourseRigor === "very demanding"
      ? "very_demanding" as const
      : normalizedCourseRigor === "demanding"
        ? "demanding" as const
        : normalizedCourseRigor === "average"
          ? "average" as const
          : null;
  if (rawCourseRigor && !courseRigor) omissions.push({
    system: "us",
    sourceRef: "Academics!H44",
    value: rawCourseRigor,
    reason: "Course rigor must be Most demanding, Very demanding, Demanding, or Average to map exactly.",
  });

  const coursePlan: AdmissionsUsAcademicPayload["fourYearCoursePlan"] = [];
  for (const rowIndex of ACADEMIC_COURSE_ROWS) {
    const row = rows[rowIndex] ?? [];
    const courseTitle = text(row[2]);
    const level = nullableText(row[3]);
    for (const { column, gradeLevel } of ACADEMIC_GRADE_COLUMNS) {
      const finalGrade = text(row[column]);
      if (!finalGrade || isPlaceholder(finalGrade)) continue;
      const sourceRef = academicSourceRef(
        rowIndex,
        String.fromCharCode(65 + column),
        String.fromCharCode(65 + column),
      );
      const parsed = admissionsCoursePlanItemSchema.safeParse({
        gradeLevel,
        courseTitle,
        level,
        finalGrade,
      });
      if (parsed.success) {
        coursePlan.push(parsed.data);
      } else {
        omissions.push({
          system: "us",
          sourceRef,
          value: finalGrade,
          reason: courseTitle
            ? "The course title, level, or grade does not satisfy the canonical course-plan limits."
            : "A grade is present without a subject label.",
        });
      }
    }
  }

  const gridWeightedGpa = text(rows[29]?.[3]);
  const gridUnweightedGpa = text(rows[30]?.[3]);
  const gridCoreGpa = text(rows[33]?.[3]);
  const gridClassRank = text(rows[28]?.[3]);
  const academicProfile = {
    ...profile,
    ...(gridWeightedGpa ? { gpa_weighted: gridWeightedGpa } : {}),
    ...(gridUnweightedGpa ? { gpa_unweighted: gridUnweightedGpa } : {}),
    ...(gridClassRank ? { class_rank: gridClassRank } : {}),
  };
  const coreGpa = parseLegacyGpa(gridCoreGpa);
  const usesCoreAsScaleCarrier = Boolean(
    gridCoreGpa && !academicProfile.gpa_unweighted && !academicProfile.gpa_weighted,
  );
  if (usesCoreAsScaleCarrier) academicProfile.gpa_unweighted = gridCoreGpa;
  const us = deriveImportedUsAcademicPayload(academicProfile);
  for (const omission of us.omissions) {
    const sourceRef = omission.field === "gpa_weighted" && gridWeightedGpa
      ? "Academics!D30"
      : omission.field === "gpa_unweighted" && gridUnweightedGpa
        ? "Academics!D31"
        : omission.field === "class_rank" && gridClassRank
          ? "Academics!D29"
          : omission.field === "gpa_scale" && (gridUnweightedGpa || gridWeightedGpa || gridCoreGpa)
            ? "Academics!D30:D34"
            : null;
    if (sourceRef) omissions.push({
      system: "us",
      sourceRef,
      value: omission.value,
      reason: omission.reason,
    });
  }
  if (us.payload) {
    let safeCoreGpa: number | null = null;
    if (gridCoreGpa) {
      if (coreGpa.value === null) {
        omissions.push({
          system: "us",
          sourceRef: "Academics!D34",
          value: gridCoreGpa,
          reason: "Core GPA is not a number between 0 and 100.",
        });
      } else if (
        (coreGpa.explicitScale !== null && coreGpa.explicitScale !== us.payload.gpaScale) ||
        coreGpa.value > us.payload.gpaScale
      ) {
        omissions.push({
          system: "us",
          sourceRef: "Academics!D34",
          value: gridCoreGpa,
          reason: `Core GPA is inconsistent with the derived ${us.payload.gpaScale}-point scale.`,
        });
      } else {
        safeCoreGpa = coreGpa.value;
      }
    }
    const basePayload = usesCoreAsScaleCarrier
      ? Object.fromEntries(
        Object.entries(us.payload).filter(([key]) => key !== "unweightedGpa"),
      )
      : us.payload;
    const parsed = admissionsUsAcademicPayloadSchema.safeParse({
      ...basePayload,
      ...(safeCoreGpa !== null ? { coreGpa: safeCoreGpa } : {}),
      fourYearCoursePlan: coursePlan,
      ...(courseRigor ? { courseRigor } : {}),
      ...academicLinks,
    });
    if (parsed.success) payloads.push(parsed.data);
    else {
      omissions.push({
        system: "us",
        sourceRef: "Academics!C4:L16",
        value: null,
        reason: "The four-year course plan did not pass canonical validation.",
      });
      payloads.push(us.payload);
    }
  } else if (coursePlan.length) {
    omissions.push({
      system: "us",
      sourceRef: "Academics!C4:L16",
      value: null,
      reason: "Course-plan rows were preserved in the legacy archive because a 4-, 5-, or 100-point GPA scale could not be derived safely.",
    });
  }

  const ibSubjects: AdmissionsIbAcademicPayload["subjects"] = [];
  for (const rowIndex of ACADEMIC_COURSE_ROWS) {
    const row = rows[rowIndex] ?? [];
    const subject = text(row[2]);
    const rowLevel = text(row[3]);
    if (!curriculumHasMyp && !/\bmyp\b/i.test(rowLevel)) continue;
    // The canonical contract has one MYP grade per subject. Prefer the latest
    // visible MYP year (G10), falling back to G9; both originals remain raw.
    const gradeSource = text(row[7]) ? row[7] : row[5];
    const rawGrade = text(gradeSource);
    if (!rawGrade || isPlaceholder(rawGrade)) continue;
    const finalGrade = parseIbGrade(gradeSource);
    if (!subject || finalGrade === null) {
      omissions.push({
        system: "ib",
        sourceRef: academicSourceRef(rowIndex, "C", "H"),
        value: rawGrade,
        reason: !subject
          ? "An MYP grade is present without a subject label."
          : "MYP grades must be whole numbers from 1 through 7.",
      });
      continue;
    }
    ibSubjects.push({ subject, level: "MYP", finalGrade });
  }

  for (let offset = 0; offset < 6; offset += 1) {
    const column = offset + 2;
    const subject = text(rows[offset + 3]?.[2]);
    const rawGrade = text(rows[67]?.[column]);
    const rawLevel = text(rows[68]?.[column]).toUpperCase();
    if (!rawGrade && !rawLevel) continue;
    const predictedGrade = parseIbGrade(rows[67]?.[column]);
    const level = rawLevel === "HL" || rawLevel === "SL" ? rawLevel : null;
    if (!subject || predictedGrade === null || !level) {
      omissions.push({
        system: "ib",
        sourceRef: `Academics!${String.fromCharCode(65 + column)}68:${String.fromCharCode(65 + column)}69`,
        value: [rawGrade, rawLevel].filter(Boolean).join(" / ") || null,
        reason: "Each DP entry needs a subject, an HL/SL level, and a predicted grade from 1 through 7.",
      });
      continue;
    }
    ibSubjects.push({ subject, level, predictedGrade });
  }

  const rawTok = text(rows[69]?.[3]);
  const rawEe = text(rows[69]?.[5]);
  const rawCas = text(rows[69]?.[9]);
  const rawPredictedTotal = text(rows[72]?.[3]);
  const tokGrade = parseIbCoreGrade(rows[69]?.[3]);
  const extendedEssayGrade = parseIbCoreGrade(rows[69]?.[5]);
  // An unchecked template checkbox is rendered as boolean false even before a
  // student touches the sheet. Only a non-blank rendered value is canonical.
  const casCompleted = rawCas ? parseCasCompletion(rows[69]?.[9]) : null;
  const predictedTotalNumber = numberValue(rows[72]?.[3]);
  const predictedTotal = predictedTotalNumber !== null &&
      Number.isInteger(predictedTotalNumber) && predictedTotalNumber >= 1 && predictedTotalNumber <= 45
    ? predictedTotalNumber
    : null;
  if (rawTok && tokGrade === null) omissions.push({
    system: "ib",
    sourceRef: "Academics!D70",
    value: rawTok,
    reason: "TOK grade must be A, B, C, D, or E.",
  });
  if (rawEe && extendedEssayGrade === null) omissions.push({
    system: "ib",
    sourceRef: "Academics!F70",
    value: rawEe,
    reason: "Extended Essay grade must be A, B, C, D, or E.",
  });
  if (rawCas && casCompleted === null) omissions.push({
    system: "ib",
    sourceRef: "Academics!J70",
    value: rawCas,
    reason: "CAS completion must be an explicit yes/no or complete/incomplete value.",
  });
  if (rawPredictedTotal && predictedTotalNumber !== 0 && predictedTotal === null) omissions.push({
    system: "ib",
    sourceRef: "Academics!D73",
    value: rawPredictedTotal,
    reason: "IB predicted total must be a whole number from 1 through 45.",
  });

  const hasValidIbCore = Boolean(
    tokGrade || extendedEssayGrade || casCompleted !== null || predictedTotal !== null,
  );
  const hasValidMypSubject = ibSubjects.some((subject) => subject.level === "MYP");
  const hasValidDpSubject = ibSubjects.some(
    (subject) => subject.level === "HL" || subject.level === "SL",
  );
  if (ibSubjects.length || hasValidIbCore) {
    const program = hasValidMypSubject && hasValidDpSubject
      ? "myp_dp" as const
      : hasValidDpSubject
        ? "dp" as const
        : hasValidMypSubject
          ? "myp" as const
          : curriculumHasMyp && curriculumHasDp
            ? "myp_dp" as const
            : curriculumHasMyp
              ? "myp" as const
              : "dp" as const;
    const candidate = {
      system: "ib" as const,
      program,
      subjects: ibSubjects,
      ...(tokGrade ? { tokGrade } : {}),
      ...(extendedEssayGrade ? { extendedEssayGrade } : {}),
      ...(casCompleted !== null ? { casCompleted } : {}),
      ...(predictedTotal !== null ? { predictedTotal } : {}),
      ...academicLinks,
    };
    const parsed = admissionsIbAcademicPayloadSchema.safeParse(candidate);
    if (parsed.success) payloads.push(parsed.data);
    else omissions.push({
      system: "ib",
      sourceRef: "Academics!C4:J73",
      value: null,
      reason: "The mapped IB record did not pass canonical validation and remains only in the legacy archive.",
    });
  }

  const ukSubjects: AdmissionsUkAcademicPayload["subjects"] = [];
  // Current template data slots start on row 79. Scanning 77–84 also keeps
  // compatibility with earlier copies where the summary was shifted upward.
  for (let rowIndex = 76; rowIndex <= 83 && rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const subject = text(row[1]);
    const board = text(row[3]);
    const rawLevel = text(row[5]);
    const predictedRaw = text(row[7]);
    const achievedRaw = text(row[9]);
    if (!subject && !board && !rawLevel && !predictedRaw && !achievedRaw) continue;
    if (/^subject$/i.test(subject) || /^\(ucas/i.test(subject)) continue;
    const qualification = parseUkQualification(rawLevel);
    if (!subject || !board || !qualification) {
      omissions.push({
        system: "a_level_igcse",
        sourceRef: academicSourceRef(rowIndex, "B", "J"),
        value: [subject, board, rawLevel].filter(Boolean).join(" / ") || null,
        reason: "Each UK academic row needs a subject, an exam board, and an explicit IGCSE, AS, or A-Level qualification.",
      });
      continue;
    }
    const predictedGrade = predictedRaw.length <= 30 ? predictedRaw || null : null;
    const achievedGrade = achievedRaw.length <= 30 ? achievedRaw || null : null;
    if (predictedRaw.length > 30 || achievedRaw.length > 30) omissions.push({
      system: "a_level_igcse",
      sourceRef: academicSourceRef(rowIndex, "H", "J"),
      value: predictedRaw.length > 30 ? predictedRaw : achievedRaw,
      reason: "Predicted and achieved grade labels may contain at most 30 characters; the overlong value was left in the legacy archive.",
    });
    ukSubjects.push({
      qualification,
      subject,
      board,
      ...(predictedGrade ? { predictedGrade } : {}),
      ...(achievedGrade ? { achievedGrade } : {}),
    });
  }
  if (ukSubjects.length) {
    const parsed = admissionsUkAcademicPayloadSchema.safeParse({
      system: "a_level_igcse",
      subjects: ukSubjects,
      ...(curriculumTrack ? { curriculumNotes: curriculumTrack } : {}),
      ...academicLinks,
    });
    if (parsed.success) payloads.push(parsed.data);
    else omissions.push({
      system: "a_level_igcse",
      sourceRef: "Academics!B77:J84",
      value: null,
      reason: "The mapped A-Level/IGCSE record did not pass canonical validation and remains only in the legacy archive.",
    });
  }

  return { payloads, omissions };
}

function parseLabelValueSheet(rows: unknown[][]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const consumedValueCells = new Set<string>();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      if (consumedValueCells.has(`${rowIndex}:${columnIndex}`)) continue;
      const label = text(row[columnIndex]);
      if (!label || label === "FALSE" || label.length > 120) continue;
      const right = row[columnIndex + 1];
      const below = rows[rowIndex + 1]?.[columnIndex];
      const usesRight = Boolean(text(right) && text(right) !== "FALSE");
      const value = usesRight ? right : below;
      const normalized = text(value);
      if (!normalized || normalized === label || isPlaceholder(normalized)) continue;
      consumedValueCells.add(usesRight
        ? `${rowIndex}:${columnIndex + 1}`
        : `${rowIndex + 1}:${columnIndex}`);
      const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80);
      if (key && !FORBIDDEN_IDENTITY_FIELD_PATTERN.test(key) && result[key] === undefined) {
        result[key] = normalized;
      }
    }
  }
  return result;
}

function parseMeetings(rows: unknown[][]): ImportedMeeting[] {
  return rows.slice(2).flatMap((row, rowOffset) => {
    const meetingDate = dateValue(row?.[2]);
    const notes = nullableText(row?.[4]);
    const nextSteps = nullableText(row?.[5]);
    if (!meetingDate && !notes && !nextSteps) return [];
    return [{
      sourceRef: `Meetings!A${rowOffset + 3}:F${rowOffset + 3}`,
      status: nullableText(row?.[1]),
      meetingDate,
      time: nullableText(row?.[3]),
      notes,
      nextSteps,
    }];
  });
}

function parseTasks(rows: unknown[][]): ImportedTask[] {
  return rows.slice(2).flatMap((row, rowOffset) => {
    const title = text(row?.[3]) || text(row?.[0]);
    if (!title || /completed assignments/i.test(title)) return [];
    return [{
      sourceRef: `Tasks!A${rowOffset + 3}:L${rowOffset + 3}`,
      title,
      status: nullableText(row?.[2]),
      topic: nullableText(row?.[4]),
      instructions: nullableText(row?.[5]),
      resourceUrl: URL_PATTERN.test(text(row?.[6])) ? text(row?.[6]) : null,
      notes: nullableText(row?.[8]),
      startDate: dateValue(row?.[9]),
      dueDate: dateValue(row?.[10]),
    }];
  });
}

function parseActivities(rows: unknown[][]): { activities: ImportedActivity[]; awards: ImportedAward[] } {
  const activities: ImportedActivity[] = [];
  const awards: ImportedAward[] = [];
  for (let start = 3; start < rows.length; start += 12) {
    const name = text(rows[start]?.[1]);
    if (!name || /engagement scale|include on app|notes/i.test(name)) continue;
    const gradeLevels = ["9", "10", "11", "12"].filter((_, index) => {
      const value = rows[start + index]?.[4];
      return value === true || /^(true|yes|x)$/i.test(text(value));
    });
    const commonPosition = text(rows[start]?.[9]);
    const commonOrganization = text(rows[start + 2]?.[9]);
    const commonDescription = text(rows[start + 5]?.[9]);
    const ucCategory = text(rows[start + 2]?.[14]);
    const ucDescription = text(rows[start + 5]?.[14]);
    const fullDescription = nullableText(rows[start]?.[7]) ?? nullableText(rows[start + 5]?.[7]);

    if (/award|honou?r/i.test(ucCategory)) {
      awards.push({
        sourceRef: `Activities -!A${start + 1}:U${Math.min(start + 12, rows.length)}`,
        // Awards use an unbounded text column. Preserve the counselor/student
        // wording exactly instead of silently truncating identity fields.
        title: name,
        organization: nullableText(commonOrganization),
        gradeLevels,
        recognitionLevels: [],
        eligibilityNarrative: nullableText(rows[start + 1]?.[20]),
        achievementNarrative: nullableText(rows[start + 3]?.[20]),
      });
      continue;
    }
    activities.push({
      sourceRef: `Activities -!A${start + 1}:U${Math.min(start + 12, rows.length)}`,
      name,
      fullDescription,
      gradeLevels,
      hoursPerWeek: numberValue(rows[start + 5]?.[5]),
      weeksPerYear: numberValue(rows[start + 5]?.[6]),
      commonApp: commonPosition || commonOrganization || commonDescription
        ? { position: commonPosition, organization: commonOrganization, description: commonDescription }
        : null,
      uc: ucCategory || ucDescription ? { category: ucCategory, description: ucDescription } : null,
    });
  }
  return { activities, awards };
}

function parseTests(rows: unknown[][]): ImportedTestSitting[] {
  const sittings: ImportedTestSitting[] = [];
  const parseScoreRows = (
    testType: string,
    start: number,
    end: number,
    keys: string[],
  ) => {
    for (let rowIndex = start; rowIndex < Math.min(end, rows.length); rowIndex += 1) {
      const row = rows[rowIndex] ?? [];
      const testDate = dateValue(row[7]);
      const details = Object.fromEntries(keys.flatMap((key, index) => {
        const value = row[8 + index];
        const numeric = numberValue(value);
        return text(value) ? [[key, numeric ?? text(value)]] : [];
      }));
      if (!testDate && Object.keys(details).length === 0) continue;
      sittings.push({
        sourceRef: `Tests!H${rowIndex + 1}:P${rowIndex + 1}`,
        testType,
        testDate,
        subject: null,
        scoreDetails: details,
      });
    }
  };
  parseScoreRows("sat", 4, 18, ["readingWriting", "math", "total", "psatIndex"]);
  parseScoreRows("act", 23, 38, ["english", "math", "reading", "science", "composite"]);
  for (let rowIndex = 40; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const subject = text(row[8]);
    const score = numberValue(row[10]);
    const testDate = dateValue(row[7]);
    if (!subject && score === null && !testDate) continue;
    sittings.push({
      sourceRef: `Tests!H${rowIndex + 1}:P${rowIndex + 1}`,
      testType: "ap",
      testDate,
      subject: subject || null,
      scoreDetails: score === null ? {} : { score },
    });
  }
  return sittings;
}

function parseResearch(rows: unknown[][]): ImportedCollegeResearch[] {
  const result: ImportedCollegeResearch[] = [];
  for (let start = 2; start < rows.length; start += 8) {
    const collegeName = text(rows[start]?.[1]);
    if (!collegeName || /fit factor|campus visit/i.test(collegeName)) continue;
    const sources: string[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const checked = rows[start + offset]?.[2];
      const source = text(rows[start + offset]?.[3]);
      if (source && (checked === true || /^(true|yes|x)$/i.test(text(checked)))) sources.push(source);
    }
    result.push({
      sourceRef: `Research Notes!A${start + 1}:I${Math.min(start + 8, rows.length)}`,
      collegeName,
      sources,
      fitAssessment: nullableText(rows[start + 2]?.[1]),
      academicNotes: nullableText(rows[start]?.[4]),
      generalNotes: nullableText(rows[start]?.[5]),
      campusVisitNotes: nullableText(rows[start]?.[6]),
      questions: nullableText(rows[start]?.[7]),
    });
  }
  return result;
}

function parseInterestEvents(rows: unknown[][]): ImportedInterestEvent[] {
  const result: ImportedInterestEvent[] = [];
  for (const [rowOffset, row] of rows.slice(7).entries()) {
    const collegeName = text(row?.[0]);
    if (!collegeName || /^©/.test(collegeName)) continue;
    for (const dateIndex of [1, 3, 5]) {
      const eventDate = dateValue(row?.[dateIndex]);
      const notes = nullableText(row?.[dateIndex + 1]);
      if (eventDate || notes) result.push({
        sourceRef: `Demonstrate Interest!R${rowOffset + 8}C${dateIndex + 1}:R${rowOffset + 8}C${dateIndex + 2}`,
        collegeName,
        eventDate,
        notes,
      });
    }
  }
  return result;
}

/** Absolute ApplicationTracker column → index within the D:DD import range. */
function applicationCell(row: unknown[], absoluteColumn: number): unknown {
  return row[absoluteColumn - 4];
}

function parseApplications(rows: unknown[][]): ImportedApplication[] {
  const results: ImportedApplication[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const collegeName = text(applicationCell(row, 4));
    if (!collegeName) continue;
    results.push({
      sourceRef: `ApplicationTracker!D${index + 33}:DD${index + 33}`,
      collegeName,
      overallStatus: nullableText(applicationCell(row, 5)),
      deadline: dateValue(applicationCell(row, 30)),
      round: nullableText(applicationCell(row, 31)),
      admissionsUrl: nullableText(applicationCell(row, 33)),
      collegeQuestionsStatus: nullableText(applicationCell(row, 34)),
      firstChoiceMajor: nullableText(applicationCell(row, 36)),
      secondChoiceMajor: nullableText(applicationCell(row, 37)),
      essayStatus: nullableText(applicationCell(row, 38)),
      testStatus: nullableText(applicationCell(row, 40)),
      recommendationStatus: nullableText(applicationCell(row, 59)),
      transcriptStatus: nullableText(applicationCell(row, 65)),
      demonstratedInterestPolicy: nullableText(applicationCell(row, 70)),
      demonstratedInterestWays: nullableText(applicationCell(row, 71)),
      honorsProgramStatus: nullableText(applicationCell(row, 73)),
      interviewStatus: nullableText(applicationCell(row, 76)),
      portfolioStatus: nullableText(applicationCell(row, 81)),
      scholarshipStatus: nullableText(applicationCell(row, 85)),
      financialAidStatus: nullableText(applicationCell(row, 89)),
      financialAidDeadline: dateValue(applicationCell(row, 91)),
      fafsaStatus: nullableText(applicationCell(row, 92)),
      decision: nullableText(applicationCell(row, 98)),
      portalUrl: nullableText(applicationCell(row, 99)),
      acceptedProgram: nullableText(applicationCell(row, 103)),
      scholarshipType: nullableText(applicationCell(row, 104)),
      scholarshipAmount: numberValue(applicationCell(row, 105)),
      studentDecision: nullableText(applicationCell(row, 106)),
      notes: nullableText(applicationCell(row, 107)),
    });
  }
  return results;
}

function parseEssayPrompts(rows: unknown[][]) {
  return rows.slice(2).flatMap((row, rowOffset) => {
    const collegeName = text(row?.[1]);
    const sourceUrl = URL_PATTERN.test(text(row?.[2])) ? text(row?.[2]) : null;
    const prompts = [4, 6, 8, 10, 12].flatMap((columnIndex) => {
      const prompt = text(row?.[columnIndex]);
      if (!prompt) return [];
      return [{
        sourceRef: `Essay Prompts!R${rowOffset + 3}C${columnIndex + 1}:R${rowOffset + 3}C${columnIndex + 2}`,
        collegeName,
        prompt,
        status: nullableText(row?.[columnIndex + 1]),
        sourceUrl,
      }];
    });
    return collegeName ? prompts : [];
  });
}

function parseFinancialAid(rows: unknown[][]): ImportedFinancialAidOffer[] {
  const collegeNames = rows[1]?.slice(2, 14).map(text) ?? [];
  const labels = new Map<string, number>();
  rows.forEach((row, index) => {
    const label = text(row?.[1]) || text(row?.[0]);
    if (label) labels.set(label.toLowerCase(), index);
  });
  const value = (label: string, column: number) => {
    const rowIndex = labels.get(label.toLowerCase());
    return rowIndex === undefined ? null : numberValue(rows[rowIndex]?.[column]);
  };
  return collegeNames.flatMap((collegeName, offset) => {
    if (!collegeName || /^college \d+$/i.test(collegeName)) return [];
    const column = offset + 2;
    return [{
      sourceRef: ` FinAidComparisons!column:${column + 1}`,
      collegeName,
      cost: {
        tuitionFees: value("Tuition & Fees", column) ?? 0,
        roomBoard: value("Room & Board", column) ?? 0,
        booksSupplies: value("Books & Supplies", column) ?? 0,
        transportation: value("Transportation", column) ?? 0,
        miscellaneous: value("Misc. Expenses", column) ?? 0,
      },
      giftAid: {
        pellGrant: value("Federal Pell Grant", column) ?? 0,
        seogGrant: value("Federal SEOG Grant", column) ?? 0,
        stateGrants: value("State Grants", column) ?? 0,
        collegeGrants: value("College Grants/Scholarships", column) ?? 0,
        otherGrants: value("Other Grants/Scholarships", column) ?? 0,
      },
      loans: {
        subsidized: value("Federal Loan Subsidized", column) ?? 0,
        unsubsidized: value("Federal Loan - Unsubsidized", column) ?? 0,
        workStudy: value("Federal Work Study", column) ?? 0,
        parentPlus: value("Parent Loans (PLUS)", column) ?? 0,
        other: value("Other Loans", column) ?? 0,
      },
      remainingBalance: value("Remaining Balance After Loans", column),
    }];
  });
}

function parseScholarships(rows: unknown[][]): ImportedScholarship[] {
  const normalizeHeader = (value: unknown) => text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const headerIndex = rows.findIndex((row) => row.some((value) =>
    /^(scholarship )?name$/.test(normalizeHeader(value))));
  const resolvedHeaderIndex = headerIndex >= 0 ? headerIndex : 1;
  const headers = (rows[resolvedHeaderIndex] ?? []).map(normalizeHeader);
  const findColumn = (...patterns: RegExp[]): number | null => {
    const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    return index >= 0 ? index : null;
  };
  const legacyColumn = (column: number): number | null => headerIndex >= 0 ? null : column;
  const nameColumn = findColumn(/^(scholarship )?name$/) ?? 0;
  const providerColumn = findColumn(/^(sponsor|provider)( name)?$/, /^organization$/) ?? legacyColumn(1);
  const addressColumn = findColumn(/^(sponsor|provider) address$/, /^address$/) ?? legacyColumn(2);
  const deadlineColumn = findColumn(/^deadline( date)?$/, /^due date$/) ?? legacyColumn(5);
  const submittedColumn = findColumn(/^date submitted$/, /^submitted( date)?$/) ?? legacyColumn(6);
  const outcomeColumn = findColumn(/^(final )?outcome$/, /^decision$/) ?? legacyColumn(7);
  const notesColumn = findColumn(/^notes?$/) ?? legacyColumn(8);
  const urlColumn = findColumn(
    /^(scholarship |provider )?(url|link|website)$/,
    /^application (url|link)$/,
  );
  const requirementsColumn = findColumn(
    /^(requirements?|eligibility|eligibility criteria|application requirements?)$/,
  );
  const amountColumn = findColumn(
    /^(offered|award|scholarship)( amount)?$/,
    /^(offered|award|scholarship) amount$/,
    /^amount$/,
  );
  const collegeColumn = findColumn(
    /^(college|institution|school)( name)?$/,
    /^(associated|applicable) (college|institution|school)$/,
  );
  const contactColumns = headers.flatMap((header, index) =>
    /^(contact( person)?|phone( number)?|e ?mail|phone ?\/ ?e ?mail)$/.test(header)
      ? [index]
      : []);
  const resolvedContactColumns = contactColumns.length
    ? contactColumns
    : headerIndex >= 0 ? [] : [3, 4];
  const at = (row: unknown[], column: number | null): unknown =>
    column === null ? null : row[column];

  return rows.slice(resolvedHeaderIndex + 1).flatMap((row, rowOffset) => {
    const name = text(row?.[nameColumn]);
    if (!name) return [];
    const sourceRow = resolvedHeaderIndex + rowOffset + 2;
    return [{
      sourceRef: `ScholarshipTracker!A${sourceRow}:J${sourceRow}`,
      name,
      provider: nullableText(at(row, providerColumn)),
      providerAddress: nullableText(at(row, addressColumn)),
      contact: resolvedContactColumns.map((column) => text(row?.[column]))
        .filter(Boolean).join(" · ") || null,
      url: urlColumn === null ? null : nullableText(row?.[urlColumn]),
      requirements: requirementsColumn === null
        ? null
        : nullableText(row?.[requirementsColumn]),
      offeredAmount: amountColumn === null ? null : numberValue(row?.[amountColumn]),
      collegeName: collegeColumn === null ? null : nullableText(row?.[collegeColumn]),
      deadline: dateValue(at(row, deadlineColumn)),
      submittedDate: dateValue(at(row, submittedColumn)),
      outcome: nullableText(at(row, outcomeColumn)),
      notes: nullableText(at(row, notesColumn)),
    }];
  });
}

const FINANCIAL_AID_AMOUNT_LABELS = new Set([
  "tuition & fees",
  "room & board",
  "books & supplies",
  "transportation",
  "misc. expenses",
  "federal pell grant",
  "federal seog grant",
  "state grants",
  "college grants/scholarships",
  "other grants/scholarships",
  "federal loan subsidized",
  "federal loan - unsubsidized",
  "federal work study",
  "parent loans (plus)",
  "other loans",
  "remaining balance after loans",
]);

function a1Column(columnIndex: number): string {
  let value = columnIndex + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function collectFinancialAidAmountIssues(
  rows: unknown[][],
  issues: AdmissionsImportIssue[],
): void {
  const collegeNames = rows[1]?.slice(2, 14).map(text) ?? [];
  rows.forEach((row, rowIndex) => {
    const label = (text(row?.[1]) || text(row?.[0])).toLowerCase();
    if (!FINANCIAL_AID_AMOUNT_LABELS.has(label)) return;
    collegeNames.forEach((collegeName, offset) => {
      if (!collegeName || /^college \d+$/i.test(collegeName)) return;
      const columnIndex = offset + 2;
      const raw = row?.[columnIndex];
      if (!hasCellText(raw)) return;
      const amount = numberValue(raw);
      if (amount !== null && Number.isFinite(amount) && amount >= 0) return;
      const cell = `${a1Column(columnIndex)}${rowIndex + 1}`;
      issues.push({
        severity: "error",
        code: "invalid_financial_aid_amount",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.financialAid.sheetName,
        range: cell,
        message: `${collegeName} ${label} must be a finite, non-negative amount (${cell}).`,
      });
    });
  });
}

function hasCellText(value: unknown): boolean {
  return text(value) !== "";
}

function sourceFingerprint(ranges: AdmissionsWorkbookRanges): string {
  const normalized = Object.keys(ranges)
    .sort()
    .map((key) => [key, ranges[key as AdmissionsWorkbookRangeKey] ?? []]);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function collectImpossibleDateIssues(
  ranges: AdmissionsWorkbookRanges,
  issues: AdmissionsImportIssue[],
): void {
  const add = (value: unknown, sheetName: string, cell: string) => {
    if (!hasImpossibleExplicitDate(value)) return;
    issues.push({
      severity: "error",
      code: "invalid_date",
      sheetName,
      range: cell,
      message: `Invalid calendar date "${text(value)}" in ${cell}. Use a real D/M/Y date.`,
    });
  };

  add(ranges.aboutYou?.[6]?.[1], ADMISSIONS_WORKBOOK_RANGES.aboutYou.sheetName, "B7");
  ranges.meetings?.forEach((row, index) => {
    add(row?.[2], ADMISSIONS_WORKBOOK_RANGES.meetings.sheetName, `C${index + 1}`);
  });
  ranges.tasks?.forEach((row, index) => {
    add(row?.[9], ADMISSIONS_WORKBOOK_RANGES.tasks.sheetName, `J${index + 1}`);
    add(row?.[10], ADMISSIONS_WORKBOOK_RANGES.tasks.sheetName, `K${index + 1}`);
  });
  ranges.tests?.forEach((row, index) => {
    add(row?.[7], ADMISSIONS_WORKBOOK_RANGES.tests.sheetName, `H${index + 1}`);
  });
  ranges.demonstratedInterest?.forEach((row, index) => {
    add(row?.[1], ADMISSIONS_WORKBOOK_RANGES.demonstratedInterest.sheetName, `B${index + 1}`);
    add(row?.[3], ADMISSIONS_WORKBOOK_RANGES.demonstratedInterest.sheetName, `D${index + 1}`);
    add(row?.[5], ADMISSIONS_WORKBOOK_RANGES.demonstratedInterest.sheetName, `F${index + 1}`);
  });
  ranges.applications?.forEach((row, index) => {
    add(applicationCell(row, 30), ADMISSIONS_WORKBOOK_RANGES.applications.sheetName, `AD${index + 33}`);
    add(applicationCell(row, 91), ADMISSIONS_WORKBOOK_RANGES.applications.sheetName, `CM${index + 33}`);
  });
  ranges.scholarships?.forEach((row, index) => {
    add(row?.[5], ADMISSIONS_WORKBOOK_RANGES.scholarships.sheetName, `F${index + 1}`);
    add(row?.[6], ADMISSIONS_WORKBOOK_RANGES.scholarships.sheetName, `G${index + 1}`);
  });
}

function collectAcademicCredentialIssues(
  rows: unknown[][],
  issues: AdmissionsImportIssue[],
): void {
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const raw = text(value);
      if (!urlContainsCredentials(raw)) return;
      issues.push({
        severity: "error",
        code: "credentialed_url",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.academics.sheetName,
        range: `${a1Column(columnIndex)}${rowIndex + 1}`,
        message: "Academic document link contains embedded credentials and cannot be imported.",
      });
    });
  });
}

export function buildAdmissionsWorkbookPreview(input: {
  spreadsheetUrlOrId: string;
  sourceTitle?: string | null;
  sheetTitles: string[];
  ranges: AdmissionsWorkbookRanges;
}): AdmissionsWorkbookPreview {
  const spreadsheetId = extractAdmissionsSpreadsheetId(input.spreadsheetUrlOrId);
  const issues: AdmissionsImportIssue[] = [];
  const titleSet = new Set(input.sheetTitles);
  const reportedMissingSheets = new Set<string>();
  for (const spec of Object.values(ADMISSIONS_WORKBOOK_RANGES)) {
    if (!titleSet.has(spec.sheetName) && !reportedMissingSheets.has(spec.sheetName)) {
      reportedMissingSheets.add(spec.sheetName);
      issues.push({
        severity: "warning",
        code: "missing_sheet",
        sheetName: spec.sheetName,
        range: spec.range,
        message: `Sheet ${spec.sheetName} was not found; that section will be skipped.`,
      });
    }
  }
  collectImpossibleDateIssues(input.ranges, issues);
  collectFinancialAidAmountIssues(input.ranges.financialAid ?? [], issues);
  collectAcademicCredentialIssues(input.ranges.academics ?? [], issues);

  const parsedActivities = parseActivities(input.ranges.activities ?? []);
  const applications = parseApplications(input.ranges.applications ?? []);
  const profile = parseProfile(input.ranges.aboutYou ?? []);
  const academicRecords = deriveImportedAcademicRecords(
    profile,
    input.ranges.academics ?? [],
  );
  const preview: AdmissionsWorkbookPreview = {
    spreadsheetId,
    sourceFingerprint: sourceFingerprint(input.ranges),
    sourceTitle: input.sourceTitle ?? null,
    profile,
    academics: parseLabelValueSheet(input.ranges.academics ?? []),
    canonicalAcademicRecords: academicRecords.payloads,
    collegeCriteria: parseLabelValueSheet(input.ranges.collegeCriteria ?? []),
    majorsCareers: parseLabelValueSheet(input.ranges.majorsCareers ?? []),
    meetings: parseMeetings(input.ranges.meetings ?? []),
    tasks: parseTasks(input.ranges.tasks ?? []),
    activities: parsedActivities.activities,
    awards: parsedActivities.awards,
    tests: parseTests(input.ranges.tests ?? []),
    research: parseResearch(input.ranges.researchNotes ?? []),
    interestEvents: parseInterestEvents(input.ranges.demonstratedInterest ?? []),
    applications,
    essayPrompts: parseEssayPrompts(input.ranges.essayPrompts ?? []),
    financialAid: parseFinancialAid(input.ranges.financialAid ?? []),
    scholarships: parseScholarships(input.ranges.scholarships ?? []),
    issues,
    changes: [],
    counts: {},
  };
  // Credential-bearing values were already reported from the raw grid above.
  // Remove them from the staff preview/archive payload as an additional
  // defense so a secret never enters import metadata, even on a forged client
  // request. Also reject link-shaped academic fields with non-web schemes.
  for (const [key, value] of Object.entries(preview.academics)) {
    if (typeof value !== "string") continue;
    const linkField = /transcript|school_?profile/i.test(key) &&
      (/url|link/i.test(key) || /^[a-z][a-z0-9+.-]*:/i.test(value));
    if (!linkField) continue;
    if (!isSafeAdmissionsUrl(value)) {
      if (!urlContainsCredentials(value)) {
        collectImportedUrlIssue(issues, {
          value,
          label: `Academic field ${key}`,
          sheetName: ADMISSIONS_WORKBOOK_RANGES.academics.sheetName,
          range: key,
        });
      }
      delete preview.academics[key];
    }
  }
  const academicDerivation = deriveImportedUsAcademicPayload(preview.profile);
  for (const omission of academicDerivation.omissions) {
    issues.push({
      severity: "warning",
      code: "invalid_academic_value",
      sheetName: ADMISSIONS_WORKBOOK_RANGES.aboutYou.sheetName,
      range: omission.field,
      message: `${omission.field}: ${omission.reason} The source value remains in the legacy import archive.`,
    });
  }
  for (const omission of academicRecords.omissions) {
    issues.push({
      severity: "warning",
      code: "incomplete_academic_record",
      sheetName: ADMISSIONS_WORKBOOK_RANGES.academics.sheetName,
      range: omission.sourceRef,
      message: `${omission.system}: ${omission.reason} The original cell remains in the read-only workbook archive.`,
    });
  }
  for (const academic of preview.canonicalAcademicRecords) {
    collectImportedUrlIssue(issues, {
      value: academic.transcriptUrl,
      label: `${academic.system} transcript link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.academics.sheetName,
      range: "transcriptUrl",
    });
    collectImportedUrlIssue(issues, {
      value: academic.schoolProfileUrl,
      label: `${academic.system} school-profile link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.academics.sheetName,
      range: "schoolProfileUrl",
    });
  }
  for (const task of preview.tasks) {
    collectImportedUrlIssue(issues, {
      value: task.resourceUrl,
      label: `${task.title} resource link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.tasks.sheetName,
      range: task.sourceRef ?? task.title,
    });
  }
  for (const essay of preview.essayPrompts) {
    collectImportedUrlIssue(issues, {
      value: essay.sourceUrl,
      label: `${essay.collegeName || "Essay"} prompt source link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.essayPrompts.sheetName,
      range: essay.sourceRef ?? essay.collegeName,
    });
  }
  for (const [index, test] of preview.tests.entries()) {
    if (!test.testDate) {
      issues.push({
        severity: "warning",
        code: "missing_date",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.tests.sheetName,
        range: `row ${index + 1}`,
        message: `${test.testType} test row has no valid date and will not be committed.`,
      });
    }
    if (
      Object.keys(test.scoreDetails).length > 0 &&
      normalizeImportedTestScoreDetails(test) === null
    ) {
      issues.push({
        severity: "error",
        code: "invalid_test_score",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.tests.sheetName,
        range: `row ${index + 1}`,
        message: `${test.testType} score values are outside the accepted test ranges.`,
      });
    }
  }
  for (const meeting of preview.meetings) {
    if (!meeting.meetingDate) {
      issues.push({
        severity: "warning",
        code: "missing_date",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.meetings.sheetName,
        range: meeting.sourceRef ?? null,
        message: "Meeting notes have no valid date and will not be committed.",
      });
    }
  }
  for (const [index, event] of preview.interestEvents.entries()) {
    if (!event.eventDate) {
      issues.push({
        severity: "warning",
        code: "missing_date",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.demonstratedInterest.sheetName,
        range: `event ${index + 1}`,
        message: `${event.collegeName} interest event has no valid date and will not be committed.`,
      });
    }
  }
  const recognizedRounds = new Set([
    "ed", "ed1", "ed2", "ea", "rea", "rd", "rolling", "priority", "other",
    "early decision", "early action", "regular decision",
  ]);
  for (const application of preview.applications) {
    collectImportedUrlIssue(issues, {
      value: application.admissionsUrl,
      label: `${application.collegeName} admissions link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
      range: application.sourceRef ?? application.collegeName,
    });
    collectImportedUrlIssue(issues, {
      value: application.portalUrl,
      label: `${application.collegeName} portal link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
      range: application.sourceRef ?? application.collegeName,
    });
    if (application.round && !recognizedRounds.has(application.round.trim().toLowerCase())) {
      issues.push({
        severity: "warning",
        code: "invalid_dropdown_value",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
        range: application.collegeName,
        message: `Unknown application round "${application.round}" will map to Other.`,
      });
    }
    if (application.decision || application.studentDecision || application.acceptedProgram) {
      issues.push({
        severity: "warning",
        code: "missing_date",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
        range: application.collegeName,
        message: `${application.collegeName} decision has no source event date; it will remain in the import archive and no application event will be created.`,
      });
    }
    if (
      application.transcriptStatus &&
      normalizeImportedSentStatus(application.transcriptStatus) === null
    ) {
      issues.push({
        severity: "warning",
        code: "invalid_dropdown_value",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
        range: application.collegeName,
        message: `Unknown transcript status "${application.transcriptStatus}" will remain in the import archive for manual review.`,
      });
    }
    if (application.recommendationStatus) {
      issues.push({
        severity: "warning",
        code: "manual_reconciliation_required",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
        range: application.collegeName,
        message: "The workbook has only an aggregate recommendation status, so no named recommender record will be guessed.",
      });
    }
    if (application.testStatus) {
      issues.push({
        severity: "warning",
        code: "manual_reconciliation_required",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.applications.sheetName,
        range: application.collegeName,
        message: "The workbook does not identify the test sitting behind this send status, so no score-send record will be guessed.",
      });
    }
  }
  for (const award of preview.awards) {
    if ((award.eligibilityNarrative?.length ?? 0) > 250) {
      issues.push({
        severity: "error",
        code: "character_limit_violation",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
        range: award.title,
        message: `${award.title} eligibility narrative exceeds 250 characters.`,
      });
    }
    if ((award.achievementNarrative?.length ?? 0) > 350) {
      issues.push({
        severity: "error",
        code: "character_limit_violation",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
        range: award.title,
        message: `${award.title} achievement narrative exceeds 350 characters.`,
      });
    }
  }
  for (const scholarship of preview.scholarships) {
    if (
      scholarship.offeredAmount !== null &&
      scholarship.offeredAmount !== undefined &&
      (!Number.isFinite(scholarship.offeredAmount) || scholarship.offeredAmount < 0)
    ) {
      issues.push({
        severity: "error",
        code: "invalid_scholarship_amount",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.scholarships.sheetName,
        range: scholarship.sourceRef ?? scholarship.name,
        message: `${scholarship.name} offered amount must be a finite, non-negative amount.`,
      });
    }
    collectImportedUrlIssue(issues, {
      value: scholarship.url,
      label: `${scholarship.name} link`,
      sheetName: ADMISSIONS_WORKBOOK_RANGES.scholarships.sheetName,
      range: scholarship.sourceRef ?? scholarship.name,
    });
  }
  const recognizedUcCategories = new Set<string>([
    ...UC_ACTIVITY_CATEGORIES,
    "award or honor",
    "educational preparation program",
    "extracurricular activity",
    "other coursework",
    "volunteering / community service",
    "volunteering community service",
    "work experience",
  ]);
  const activitiesByNormalizedName = new Map<string, ImportedActivity[]>();
  for (const activity of preview.activities) {
    const key = activity.name.trim().toLowerCase().replace(/\s+/g, " ");
    activitiesByNormalizedName.set(key, [
      ...(activitiesByNormalizedName.get(key) ?? []),
      activity,
    ]);
  }
  for (const [name, activities] of activitiesByNormalizedName) {
    if (!name || activities.length < 2) continue;
    issues.push({
      severity: "error",
      code: "duplicate_source_activity",
      sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
      range: activities.map((activity) => activity.sourceRef).filter(Boolean).join(", ") || name,
      message: `Multiple source activity blocks normalize to "${activities[0]!.name}". Rename or merge them before importing; the importer will not silently collapse distinct rows.`,
    });
  }
  for (const activity of preview.activities) {
    const charLimits: Array<[string, string | undefined, number]> = [
      ["Common App position", activity.commonApp?.position, COMMON_APP_POSITION_MAX_CHARS],
      ["Common App organization", activity.commonApp?.organization, COMMON_APP_ORGANIZATION_MAX_CHARS],
      ["Common App description", activity.commonApp?.description, COMMON_APP_DESCRIPTION_MAX_CHARS],
      ["UC description", activity.uc?.description, UC_DESCRIPTION_MAX_CHARS],
    ];
    for (const [field, value, limit] of charLimits) {
      if ((value?.length ?? 0) > limit) {
        issues.push({
          severity: "error",
          code: "character_limit_violation",
          sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
          range: activity.name,
          message: `${activity.name} ${field} exceeds ${limit} characters.`,
        });
      }
    }
    if (
      activity.hoursPerWeek !== null &&
      (activity.hoursPerWeek < 0 || activity.hoursPerWeek > COMMON_APP_HOURS_PER_WEEK_MAX)
    ) {
      issues.push({
        severity: "warning",
        code: "invalid_numeric_value",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
        range: activity.name,
        message: `${activity.name} hours per week is outside 0–${COMMON_APP_HOURS_PER_WEEK_MAX} and will be omitted.`,
      });
    }
    if (
      activity.weeksPerYear !== null &&
      (!Number.isInteger(activity.weeksPerYear) ||
        activity.weeksPerYear < 0 ||
        activity.weeksPerYear > COMMON_APP_WEEKS_PER_YEAR_MAX)
    ) {
      issues.push({
        severity: "warning",
        code: "invalid_numeric_value",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
        range: activity.name,
        message: `${activity.name} weeks per year is outside 0–${COMMON_APP_WEEKS_PER_YEAR_MAX} and will be omitted.`,
      });
    }
    const rawUcCategory = activity.uc?.category.trim().toLowerCase();
    if (rawUcCategory && !recognizedUcCategories.has(rawUcCategory)) {
      issues.push({
        severity: "warning",
        code: "invalid_dropdown_value",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
        range: activity.name,
        message: `Unknown UC activity category "${activity.uc?.category}" will be kept as a legacy note.`,
      });
    }
  }
  preview.counts = {
    profileFields: Object.keys(preview.profile).length,
    canonicalProfileFields: Object.keys(deriveCanonicalStudentProfile(preview.profile)).length,
    academicFields: Object.keys(preview.academics).length,
    canonicalAcademicRecords: preview.canonicalAcademicRecords.length,
    collegeCriteriaFields: Object.keys(preview.collegeCriteria).length,
    majorsCareersFields: Object.keys(preview.majorsCareers).length,
    meetings: preview.meetings.filter((meeting) => meeting.meetingDate).length,
    tasks: preview.tasks.length,
    activities: preview.activities.length,
    awards: preview.awards.length,
    tests: preview.tests.filter((test) => test.testDate).length,
    research: preview.research.length,
    interestEvents: preview.interestEvents.filter((event) => event.eventDate).length,
    applications: preview.applications.length,
    transcriptDocs: preview.applications.filter(
      (application) => normalizeImportedSentStatus(application.transcriptStatus) !== null,
    ).length,
    essayPrompts: preview.essayPrompts.length,
    financialAid: preview.financialAid.length,
    scholarships: preview.scholarships.length,
  };
  return preview;
}
