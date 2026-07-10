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
import type {
  AdmissionsAppStatus,
  AdmissionsDecisionEvent,
} from "@/lib/admissions/colleges";
import type { AdmissionsTaskStatus } from "@/lib/admissions/checklists";
import type { AdmissionsEssayStatus } from "@/lib/admissions/essays";
import type { AdmissionsTaskOwner } from "@/lib/admissions/meetings";
import type { AdmissionsRecommenderAskStatus } from "@/lib/admissions/recommenders";
import type { ScholarshipStatus } from "@/lib/admissions/shared/college-details";
import type {
  AdmissionsTestSittingStatus,
  AdmissionsTestType,
} from "@/lib/admissions/testing";
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

  // Account and child switching
  roleParent: { th: "ผู้ปกครอง · ดูอย่างเดียว", en: "Parent · View only" },
  signOut: { th: "ออกจากระบบ", en: "Sign out" },
  childrenTitle: { th: "สลับโปรไฟล์นักเรียน", en: "Switch student" },
  currentChild: { th: "กำลังดู", en: "Viewing" },

  // Profile
  profileTitle: { th: "ข้อมูลนักเรียน", en: "Student profile" },
  profileEmpty: { th: "ยังไม่มีรายละเอียดที่แชร์", en: "No shared profile details yet." },
  profilePreferredName: { th: "ชื่อที่ใช้", en: "Preferred name" },
  profilePhone: { th: "โทรศัพท์", en: "Phone" },
  profileSchool: { th: "โรงเรียน", en: "School" },
  profileSchoolCounselor: { th: "ที่ปรึกษาโรงเรียน", en: "School counselor" },
  profileGraduationYear: { th: "ปีที่จบ", en: "Graduation year" },

  // Academics
  academicsTitle: { th: "ผลการเรียน", en: "Academics" },
  academicsEmpty: { th: "ยังไม่มีข้อมูลผลการเรียน", en: "No academic records yet." },
  academicsEffectiveDate: { th: "ข้อมูล ณ วันที่ {date}", en: "Effective {date}" },
  academicsCoursePlan: { th: "แผนรายวิชา 4 ปี", en: "Four-year course plan" },
  academicsSubjects: { th: "รายวิชา", en: "Subjects" },
  academicsTranscript: { th: "ใบแสดงผลการเรียน", en: "Transcript" },
  academicsSchoolProfile: { th: "ข้อมูลโรงเรียน", en: "School profile" },
  openLink: { th: "เปิดลิงก์", en: "Open link" },

  // Checklist
  checklistTitle: { th: "รายการตรวจสอบทั้งหมด", en: "Full checklist" },
  checklistEmpty: { th: "ยังไม่มีรายการงาน", en: "No checklist items yet." },
  checklistOwner: { th: "ผู้รับผิดชอบ: {owner}", en: "Owner: {owner}" },
  checklistDue: { th: "กำหนด {date}", en: "Due {date}" },

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
  collegeFirstMajor: { th: "สาขาอันดับ 1", en: "First-choice major" },
  collegeSecondMajor: { th: "สาขาอันดับ 2", en: "Second-choice major" },
  collegeCompleteness: { th: "ความครบถ้วนของใบสมัคร", en: "Application completeness" },
  collegeComplete: { th: "ครบถ้วน", en: "Complete" },
  collegeIncomplete: { th: "ยังไม่ครบ", en: "Incomplete" },
  collegeRecs: { th: "จดหมายแนะนำ {done}/{total}", en: "Recommendations {done}/{total}" },
  collegeTranscript: { th: "ทรานสคริปต์", en: "Transcript" },
  collegeSchoolReport: { th: "รายงานโรงเรียน", en: "School report" },
  collegeScoreSends: { th: "ส่งคะแนน {count}", en: "Score sends {count}" },
  collegeDecisions: { th: "ผลการสมัคร", en: "Decisions" },
  collegeRequirements: { th: "ข้อกำหนดเพิ่มเติม", en: "Additional requirements" },
  collegeAdmissionsSite: { th: "เว็บไซต์รับสมัคร", en: "Admissions website" },
  collegePortalSite: { th: "พอร์ทัลผู้สมัคร", en: "Applicant portal" },

  // Recommenders
  recommendersTitle: { th: "ผู้เขียนจดหมายแนะนำ", en: "Recommenders" },
  recommendersEmpty: { th: "ยังไม่มีผู้เขียนจดหมายแนะนำ", en: "No recommenders yet." },
  recommenderSubmitted: { th: "ส่งแล้ว", en: "Submitted" },
  recommenderPending: { th: "รอดำเนินการ", en: "Pending" },

  // Essays
  essaysTitle: { th: "เรียงความ", en: "Essays" },
  essaysEmpty: { th: "ยังไม่มีเรียงความ", en: "No essays yet." },
  essayGeneral: { th: "เรียงความหลัก", en: "General essay" },
  essayGoogleDoc: { th: "เปิด Google Doc ที่แชร์", en: "Open shared Google Doc" },

  // Activities and awards
  activitiesTitle: { th: "กิจกรรมนอกหลักสูตร", en: "Activities" },
  activitiesEmpty: { th: "ยังไม่มีกิจกรรม", en: "No activities yet." },
  awardsTitle: { th: "เกียรติบัตรและรางวัล", en: "Honors & awards" },
  awardsEmpty: { th: "ยังไม่มีรางวัล", en: "No awards yet." },
  awardOrganization: { th: "องค์กร", en: "Organization" },
  awardRecognition: { th: "ระดับการยอมรับ", en: "Recognition" },

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
  testingSubject: { th: "วิชา: {subject}", en: "Subject: {subject}" },
  testingRegistrationDeadline: { th: "ลงทะเบียนภายใน {date}", en: "Register by {date}" },
  testingLateDeadline: { th: "ลงทะเบียนล่าช้าภายใน {date}", en: "Late registration by {date}" },
  testingScoreDetails: { th: "รายละเอียดคะแนน", en: "Score details" },

  // Scholarships and financial aid
  moneyTitle: { th: "ทุนและความช่วยเหลือทางการเงิน", en: "Scholarships & financial aid" },
  moneyEmpty: { th: "ยังไม่มีข้อมูลทางการเงิน", en: "No scholarship or aid information yet." },
  scholarshipsTitle: { th: "ทุนการศึกษา", en: "Scholarships" },
  financialAidTitle: { th: "เปรียบเทียบความช่วยเหลือทางการเงิน", en: "Financial aid comparison" },
  scholarshipProvider: { th: "ผู้ให้ทุน", en: "Provider" },
  scholarshipRequirements: { th: "ข้อกำหนด", en: "Requirements" },
  scholarshipOutcome: { th: "ผลลัพธ์", en: "Outcome" },
  scholarshipOffered: { th: "จำนวนที่ได้รับ", en: "Offered amount" },
  aidCost: { th: "ค่าใช้จ่ายรวม", en: "Cost of attendance" },
  aidGift: { th: "เงินช่วยเหลือที่ไม่ต้องคืน", en: "Grants & gift aid" },
  aidLoans: { th: "เงินกู้", en: "Loans" },
  aidWorkStudy: { th: "งานระหว่างเรียน", en: "Work-study" },
  aidNetCost: { th: "ค่าใช้จ่ายสุทธิ", en: "Net cost" },
  aidRemaining: { th: "ยอดคงเหลือ", en: "Remaining balance" },

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

export const PARENT_TASK_STATUS_STRINGS: Record<AdmissionsTaskStatus, ParentBilingualString> = {
  not_started: { th: "ยังไม่เริ่ม", en: "Not started" },
  in_progress: { th: "กำลังดำเนินการ", en: "In progress" },
  done: { th: "เสร็จแล้ว", en: "Done" },
};

export const PARENT_TASK_OWNER_STRINGS: Record<AdmissionsTaskOwner, ParentBilingualString> = {
  student: { th: "นักเรียน", en: "Student" },
  counselor: { th: "ที่ปรึกษา", en: "Counselor" },
  parent: { th: "ผู้ปกครอง", en: "Parent" },
};

export const PARENT_ESSAY_STATUS_STRINGS: Record<AdmissionsEssayStatus, ParentBilingualString> = {
  not_started: { th: "ยังไม่เริ่ม", en: "Not started" },
  brainstorming: { th: "ระดมความคิด", en: "Brainstorming" },
  drafting: { th: "กำลังร่าง", en: "Drafting" },
  feedback: { th: "รับคำแนะนำ", en: "Feedback" },
  final: { th: "ฉบับสมบูรณ์", en: "Final" },
};

export const PARENT_RECOMMENDER_STATUS_STRINGS: Record<
  AdmissionsRecommenderAskStatus,
  ParentBilingualString
> = {
  planned: { th: "วางแผนไว้", en: "Planned" },
  asked: { th: "ขอแล้ว", en: "Asked" },
  agreed: { th: "ตอบรับแล้ว", en: "Agreed" },
  declined: { th: "ปฏิเสธ", en: "Declined" },
};

export const PARENT_DECISION_STRINGS: Record<AdmissionsDecisionEvent, ParentBilingualString> = {
  submitted: { th: "ส่งใบสมัครแล้ว", en: "Submitted" },
  deferred: { th: "เลื่อนพิจารณา", en: "Deferred" },
  waitlisted: { th: "รายชื่อสำรอง", en: "Waitlisted" },
  accepted: { th: "ตอบรับ", en: "Accepted" },
  denied: { th: "ไม่รับ", en: "Denied" },
  withdrawn: { th: "ถอนใบสมัคร", en: "Withdrawn" },
  committed: { th: "ยืนยันเข้าเรียน", en: "Committed" },
};

export const PARENT_TEST_STATUS_STRINGS: Record<
  AdmissionsTestSittingStatus,
  ParentBilingualString
> = {
  planned: { th: "วางแผน", en: "Planned" },
  registered: { th: "ลงทะเบียนแล้ว", en: "Registered" },
  taken: { th: "สอบแล้ว", en: "Taken" },
  score_received: { th: "ได้รับคะแนนแล้ว", en: "Score received" },
  canceled: { th: "ยกเลิก", en: "Canceled" },
};

export const PARENT_SCHOLARSHIP_STATUS_STRINGS: Record<
  ScholarshipStatus,
  ParentBilingualString
> = {
  researching: { th: "กำลังค้นหา", en: "Researching" },
  planned: { th: "วางแผน", en: "Planned" },
  in_progress: { th: "กำลังดำเนินการ", en: "In progress" },
  submitted: { th: "ส่งแล้ว", en: "Submitted" },
  awarded: { th: "ได้รับทุน", en: "Awarded" },
  declined: { th: "ปฏิเสธทุน", en: "Declined" },
  not_selected: { th: "ไม่ได้รับเลือก", en: "Not selected" },
};
