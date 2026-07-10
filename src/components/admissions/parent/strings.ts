// ----------------------------------------------------------------------------
// Admissions parent dashboard — bilingual static UI strings (design §5.3,
// PRD CM-131).
//
// Every STATIC string on the parent surface lives here as a {th, en} pair,
// rendered Thai-FIRST (default locale "th", persisted th/en toggle). Data
// values (student name, cohort, college names, round labels, announcement
// bodies, note bodies, dates, scores) are rendered verbatim and are NEVER
// translated — only the chrome around them is bilingual.
//
// Deliberately dependency-free: no i18n library (locked stack). Type-only
// imports keep the enum keys aligned with the owning lib modules without a
// runtime dependency.
// ----------------------------------------------------------------------------

import type { CalendarItemSource } from "@/lib/admissions/calendar";
import type { AdmissionsAppStatus } from "@/lib/admissions/colleges";
import type { AdmissionsTestType } from "@/lib/admissions/testing";
import type { AdmissionsCaseStatus } from "@/lib/admissions/types";

// ── Locale model ────────────────────────────────────────────────────────

/** Parent surface locale — Thai-first (CM-131). */
export type ParentLocale = "th" | "en";

/** One static UI string in both languages. */
export interface ParentBilingualString {
  th: string;
  en: string;
}

/** localStorage key persisting the parent's th/en choice (CM-131). */
export const PARENT_LOCALE_STORAGE_KEY = "bgscheduler.admissions.parent-locale";

/**
 * Resolves a raw stored value to a locale. Anything other than the exact
 * string "en" — null, garbage, casing variants — falls back to "th"
 * (fail-closed Thai-first, never guess).
 */
export function resolveParentLocale(raw: string | null): ParentLocale {
  return raw === "en" ? "en" : "th";
}

/**
 * Reads the persisted locale from a storage-like object. A missing storage
 * (SSR) or a throwing storage (privacy mode) falls back to "th" — the parent
 * surface must render either way.
 */
export function readStoredParentLocale(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ParentLocale {
  if (!storage) return "th";
  try {
    return resolveParentLocale(storage.getItem(PARENT_LOCALE_STORAGE_KEY));
  } catch {
    return "th";
  }
}

/**
 * Persists the locale choice to a storage-like object. Fire-and-forget: a
 * missing or throwing storage is silently ignored (the in-memory toggle
 * still works for the session).
 */
export function writeStoredParentLocale(
  storage: Pick<Storage, "setItem"> | null | undefined,
  locale: ParentLocale,
): void {
  if (!storage) return;
  try {
    storage.setItem(PARENT_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable (private mode / quota) — the toggle stays in-memory.
  }
}

/** Picks one language from a bilingual pair. */
export function pickParentString(
  entry: ParentBilingualString,
  locale: ParentLocale,
): string {
  return locale === "en" ? entry.en : entry.th;
}

/**
 * Picks one language and substitutes `{key}` placeholders from `vars`.
 * Unknown placeholders are left verbatim (fail-closed — never drop text).
 */
export function formatParentString(
  entry: ParentBilingualString,
  locale: ParentLocale,
  vars: Record<string, string>,
): string {
  return pickParentString(entry, locale).replace(
    /\{(\w+)\}/g,
    (match, key: string) => vars[key] ?? match,
  );
}

// ── Static strings (design §5.3 section order) ──────────────────────────

/** All static parent-dashboard UI strings (CM-131), keyed by usage. */
export const PARENT_STRINGS = {
  // Language toggle
  languageToggle: { th: "เปลี่ยนภาษา", en: "Change language" },
  languageThai: { th: "ไทย", en: "ไทย" },
  languageEnglish: { th: "EN", en: "EN" },

  // Progress
  progressTitle: { th: "ความคืบหน้า", en: "Progress" },
  progressOverall: { th: "ความคืบหน้าโดยรวม", en: "Overall progress" },
  progressDoneOfTotal: {
    th: "เสร็จแล้ว {done} จาก {total} รายการ",
    en: "{done} of {total} tasks done",
  },
  progressByPhase: { th: "ความคืบหน้าตามช่วง", en: "Progress by phase" },

  // Upcoming deadlines
  deadlinesTitle: { th: "กำหนดการที่ใกล้ถึง", en: "Upcoming deadlines" },
  deadlinesEmpty: {
    th: "ยังไม่มีกำหนดการเร็ว ๆ นี้",
    en: "No upcoming deadlines yet.",
  },
  deadlinesGroupOverdue: { th: "เลยกำหนด", en: "Overdue" },
  deadlinesGroupThisWeek: { th: "สัปดาห์นี้", en: "This week" },
  deadlinesGroupNextWeek: { th: "สัปดาห์หน้า", en: "Next week" },
  deadlinesGroupWeekOf: { th: "สัปดาห์วันที่ {date}", en: "Week of {date}" },
  overdueMarker: { th: "เลยกำหนด", en: "Overdue" },

  // College list
  collegesTitle: { th: "รายชื่อมหาวิทยาลัย", en: "College list" },
  collegesEmpty: {
    th: "ยังไม่มีมหาวิทยาลัยในรายชื่อ",
    en: "No colleges on the list yet.",
  },
  collegeDue: { th: "กำหนดส่ง {date}", en: "Due {date}" },

  // Announcements
  announcementsTitle: { th: "ประกาศ", en: "Announcements" },
  announcementsEmpty: { th: "ยังไม่มีประกาศ", en: "No announcements yet." },

  // Testing milestones
  testingTitle: { th: "ความคืบหน้าการสอบ", en: "Testing milestones" },
  testingEmpty: { th: "ยังไม่มีตารางสอบ", en: "No test sittings yet." },
  testingDate: { th: "วันสอบ {date}", en: "Test date {date}" },
  testingRegistered: { th: "ลงทะเบียนแล้ว", en: "Registered" },
  testingTaken: { th: "สอบแล้ว", en: "Taken" },
  testingScoreReceived: { th: "ได้รับคะแนนแล้ว", en: "Score received" },
  testingScore: { th: "คะแนน", en: "Score" },

  // Shared notes
  notesTitle: { th: "บันทึกจากที่ปรึกษา", en: "Notes from your counselor" },
  notesEmpty: { th: "ยังไม่มีบันทึกที่แชร์", en: "No shared notes yet." },
} as const satisfies Record<string, ParentBilingualString>;

// ── Enum label maps (static UI labels for data enum KEYS — the keys are ──
// ── data, the display labels are chrome, so they are bilingual) ─────────

/** Case lifecycle labels for the child header status chip. */
export const PARENT_CASE_STATUS_STRINGS: Record<
  AdmissionsCaseStatus,
  ParentBilingualString
> = {
  active: { th: "กำลังดำเนินการ", en: "Active" },
  committed: { th: "ยืนยันมหาวิทยาลัยแล้ว", en: "Committed" },
  completed: { th: "เสร็จสมบูรณ์", en: "Completed" },
  withdrawn: { th: "ถอนตัวแล้ว", en: "Withdrawn" },
  archived: { th: "เก็บถาวรแล้ว", en: "Archived" },
};

/** Application status chip labels for the college list. */
export const PARENT_APP_STATUS_STRINGS: Record<
  AdmissionsAppStatus,
  ParentBilingualString
> = {
  researching: { th: "กำลังหาข้อมูล", en: "Researching" },
  applying: { th: "กำลังสมัคร", en: "Applying" },
  submitted: { th: "ส่งใบสมัครแล้ว", en: "Submitted" },
  complete: { th: "เสร็จสมบูรณ์", en: "Complete" },
};

/** Deadline source badge labels (aggregated calendar, CM-100). */
export const PARENT_DEADLINE_SOURCE_STRINGS: Record<
  CalendarItemSource,
  ParentBilingualString
> = {
  task: { th: "งาน", en: "Task" },
  application: { th: "ใบสมัคร", en: "Application" },
  essay: { th: "เรียงความ", en: "Essay" },
  testing: { th: "การสอบ", en: "Testing" },
};

/**
 * Test-type labels. Acronyms are identical in both languages (they are
 * proper names, rendered verbatim); only "other" needs translation.
 */
export const PARENT_TEST_TYPE_STRINGS: Record<
  AdmissionsTestType,
  ParentBilingualString
> = {
  sat: { th: "SAT", en: "SAT" },
  act: { th: "ACT", en: "ACT" },
  ap: { th: "AP", en: "AP" },
  ib: { th: "IB", en: "IB" },
  toefl: { th: "TOEFL", en: "TOEFL" },
  ielts: { th: "IELTS", en: "IELTS" },
  other: { th: "การสอบอื่น ๆ", en: "Other test" },
};
