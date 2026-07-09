// Admissions Case Management — shared domain types and DTO contracts.
//
// Type-only file: no runtime code. These shapes are the contract the rest of
// the admissions module (access guards, data layer, API routes, UI shells)
// builds against. Field names align with src/lib/db/schema.ts (admissions_*
// tables) and docs/casemanagementsystem_design.md §1/§4/§5.1. All timestamps
// in DTOs are ISO-8601 strings (serialized boundary); date-only columns are
// "YYYY-MM-DD" strings.

// ── Roles & access ──────────────────────────────────────────────────────

/** Global admissions role granted via registry/membership (design §2.1). */
export type AdmissionsRole = "counselor" | "student" | "parent";

/**
 * Effective within-case role, including the admin bypass.
 * Ordering (see roleAtLeast in config.ts): parent < student < counselor < admin.
 */
export type CaseRole = AdmissionsRole | "admin";

/**
 * Minimal authenticated session user for admissions routes (mirror of the
 * progress-tests AppSessionUser shape). `role` is the global JWT-derived
 * claim used for nav shaping only — per-case rights always come from
 * requireCaseAccess on every request.
 */
export interface AdmissionsSessionUser {
  email: string;
  name: string;
  role: CaseRole;
}

/** Result of a per-request case membership check (requireCaseAccess). */
export interface CaseAccess {
  caseId: string;
  email: string;
  role: CaseRole;
  isAdmin: boolean;
}

// ── Status unions (mirror pgEnums in schema.ts) ─────────────────────────

/** Case lifecycle (mirrors admissions_case_status). */
export type AdmissionsCaseStatus =
  | "active"
  | "committed"
  | "completed"
  | "withdrawn"
  | "archived";

/** Membership lifecycle (mirrors admissions_member_status). */
export type AdmissionsMemberStatus = "invited" | "active" | "revoked" | "bounced";

/** Note audience (mirrors admissions_note_visibility). */
export type AdmissionsNoteVisibility = "staff_only" | "shared_with_family";

// ── DTOs ────────────────────────────────────────────────────────────────

/** One caseload row for the counselor/admin table + board views (design §5.1). */
export interface AdmissionsCaseSummary {
  caseId: string;
  studentId: string;
  studentName: string;
  preferredName: string | null;
  cohortId: string;
  cohortName: string;
  graduationYear: number;
  status: AdmissionsCaseStatus;
  /** Active counselor member emails on the case (co-counseling supported). */
  counselorEmails: string[];
  /** Registry display names matching counselorEmails order; email fallback. */
  counselorNames: string[];
  /** Done-task percentage, 0–100 integer. */
  progressPercent: number;
  /** Earliest upcoming deadline across modules ("YYYY-MM-DD"), or null. */
  nextDeadline: string | null;
  /** Days since the last logged meeting; null when no meeting exists. */
  daysSinceLastTouch: number | null;
  /** Denormalized committed college name when the case has committed. */
  committedCollegeName: string | null;
  updatedAt: string;
}

/** Student identity block inside a case detail payload. */
export interface AdmissionsStudentDto {
  id: string;
  fullName: string;
  preferredName: string | null;
  studentEmail: string;
  phone: string | null;
  school: string | null;
  schoolCounselor: string | null;
  wiseStudentKey: string | null;
  externalLinks: Record<string, unknown>;
}

/** Cohort block inside case payloads. */
export interface AdmissionsCohortDto {
  id: string;
  name: string;
  graduationYear: number;
}

/**
 * One global counselor registry row (design §3, admissions_counselors —
 * sign-in resolution). `active: false` revokes counselor sign-in capability.
 */
export interface AdmissionsCounselorDto {
  id: string;
  email: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One case membership row (design §4 members routes). */
export interface AdmissionsMemberDto {
  id: string;
  caseId: string;
  email: string;
  role: AdmissionsRole;
  status: AdmissionsMemberStatus;
  invitedAt: string | null;
  activatedAt: string | null;
  revokedAt: string | null;
  addedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Full case detail for the case shell header + overview tab (design §5.1). */
export interface AdmissionsCaseDetail {
  caseId: string;
  status: AdmissionsCaseStatus;
  statusChangedAt: string;
  committedListItemId: string | null;
  committedCollegeName: string | null;
  driveFolder: string | null;
  student: AdmissionsStudentDto;
  cohort: AdmissionsCohortDto;
  members: AdmissionsMemberDto[];
  progressPercent: number;
  nextDeadline: string | null;
  lastMeetingDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One meeting log row (design §4 meetings routes). */
export interface AdmissionsMeetingDto {
  id: string;
  caseId: string;
  meetingDate: string;
  mode: string | null;
  attendees: string[];
  notes: string | null;
  nextMeetingDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One case note; visibility is always explicit (design §3, notes table). */
export interface AdmissionsNoteDto {
  id: string;
  caseId: string;
  authorEmail: string;
  body: string;
  visibility: AdmissionsNoteVisibility;
  createdAt: string;
  updatedAt: string;
}
