// Admissions Case Management — parent projection: the ONLY builder of
// parent-facing payloads (whitelist).
//
// Design: docs/casemanagementsystem_design.md §2.3 (explicit DTO; "new fields
// must be added to the DTO deliberately — leaks are structural, not
// conventional"), §5.3 (parent single-scroll page contents). PRD CM-130 and
// the §3 visibility rules (§3.6).
//
// Core rules:
// - Every field on ParentDashboard is built FIELD-BY-FIELD from named source
//   values — no spreads of database rows or sibling DTOs — so adding a column
//   upstream can never leak here without a deliberate edit to this file.
// - Forbidden by construction: aid fields (aidOffered/aidNotes), counselor
//   commentary (counselorStage, staff_only note bodies), per-college
//   completeness detail, unreleased scores (CM-83), member email addresses,
//   wiseStudentKey, and anything audit-related. None of those source fields
//   are ever assigned to the DTO.
// - Raw test scores appear ONLY when a counselor set scoreReleasedToParent
//   (CM-83); otherwise the `score` key is OMITTED entirely (never null), so
//   serialized payloads carry no trace of an unreleased score.
// - sharedNotes re-filters to visibility "shared_with_family" on top of
//   notes.ts's role-shaped read (defense in depth, fail-closed).
// - All date comparisons use Asia/Bangkok calendar semantics, matching
//   calendar.ts / testing.ts.
//
// Error contract (admissionsErrorResponse maps these): malformed caseId /
// missing case → Error("NotFound"); guards upstream (requireCaseAccess) own
// Forbidden.

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCases,
  admissionsCohorts,
  admissionsStudents,
} from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import { listAnnouncementsForCase } from "./announcements";
import { getUpcomingDeadlines, type CalendarItemSource } from "./calendar";
import { computeProgress } from "./checklists";
import {
  ADMISSIONS_APP_ROUND_LABELS,
  listCollegesForCase,
  type AdmissionsAppRound,
  type AdmissionsAppStatus,
  type AdmissionsCollegeCategory,
} from "./colleges";
import type { AdmissionsPhaseKey } from "./config";
import { isUuidShaped } from "./members";
import { listNotesForRole } from "./notes";
import { getPhaseProgress } from "./student-home";
import {
  listSittingsForCase,
  parseScoreValue,
  type AdmissionsTestType,
} from "./testing";
import type { AdmissionsCaseStatus } from "./types";

/** Upcoming deadlines shown on the parent dashboard (design §5.3). */
export const PARENT_UPCOMING_DEADLINES_LIMIT = 10;

/** Announcements shown on the parent dashboard, newest first. */
export const PARENT_ANNOUNCEMENTS_LIMIT = 10;

// ── Parent DTO (exhaustive and closed — design §2.3) ────────────────────

/** Overall checklist progress for parents: counts only, no verification detail. */
export interface ParentProgressSummary {
  done: number;
  total: number;
  /** 0–100 integer; 0 when the case has no tasks. */
  percent: number;
}

/** One per-phase progress ring for parents (season-relevant phases only). */
export interface ParentPhaseProgress {
  phase: AdmissionsPhaseKey;
  label: string;
  done: number;
  total: number;
  /** 0–100 integer. */
  percent: number;
}

/**
 * One college list row for parents: name/round/status/deadline/category ONLY
 * (design §2.3) — no aid fields, no completeness detail, no IPEDS internals.
 */
export interface ParentCollegeListEntry {
  instName: string;
  round: AdmissionsAppRound;
  /** Display label for `round` (ADMISSIONS_APP_ROUND_LABELS). */
  roundLabel: string;
  appStatus: AdmissionsAppStatus;
  /** Application deadline, "YYYY-MM-DD"; null when not set. */
  deadline: string | null;
  category: AdmissionsCollegeCategory;
}

/** One upcoming dated item for parents (aggregated calendar, CM-100). */
export interface ParentDeadline {
  source: CalendarItemSource;
  title: string;
  /** "YYYY-MM-DD" (Asia/Bangkok calendar semantics). */
  date: string;
  overdue: boolean;
}

/** One announcement for parents — author identity deliberately omitted. */
export interface ParentAnnouncement {
  title: string;
  body: string;
  createdAt: string;
}

/**
 * One test sitting's milestone flags for parents (CM-83): progress booleans
 * always; the raw score ONLY when a counselor released it — the `score` key
 * is omitted entirely (never null) for unreleased or non-numeric scores.
 */
export interface ParentTestingMilestone {
  testType: AdmissionsTestType;
  /** Test date, "YYYY-MM-DD". */
  testDate: string;
  /** Registration window closed (deadline strictly before today, Bangkok) or no registration step (null deadline). */
  registered: boolean;
  /** Test date is strictly before today (Bangkok). */
  taken: boolean;
  /** A score has been recorded on the sitting. */
  scoreReceived: boolean;
  /** Present ONLY when scoreReleasedToParent AND the score parses numerically. */
  score?: number;
}

/** One family-shared note — author identity deliberately omitted. */
export interface ParentSharedNote {
  body: string;
  createdAt: string;
}

/**
 * The complete parent-facing payload (design §2.3). This interface is
 * exhaustive and closed: parent routes serve this shape and nothing else, and
 * every field is assembled field-by-field in buildParentDashboard — a new
 * field reaches parents only via a deliberate edit here.
 */
export interface ParentDashboard {
  studentName: string;
  cohortName: string;
  caseStatus: AdmissionsCaseStatus;
  progress: ParentProgressSummary;
  /** Season-relevant per-phase rings, canonical phase order. */
  phaseProgress: ParentPhaseProgress[];
  /** College list, deadline ascending (nulls last). */
  collegeList: ParentCollegeListEntry[];
  /** Next open deadlines (≤10), overdue first. */
  upcomingDeadlines: ParentDeadline[];
  /** Case + cohort announcements (≤10), newest first. */
  announcements: ParentAnnouncement[];
  /** Per-sitting milestone flags, next sitting first. */
  testingMilestones: ParentTestingMilestone[];
  /** Only visibility "shared_with_family" notes, newest first. */
  sharedNotes: ParentSharedNote[];
}

/** buildParentDashboard options. */
export interface BuildParentDashboardOptions {
  /** Reference instant for deadlines/milestones; defaults to the current time. */
  now?: Date;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in calendar.ts / testing.ts / student-home.ts).
 */
function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

// ── Builder (the ONLY parent payload assembly point) ────────────────────

/**
 * Builds the parent dashboard payload for one case (design §2.3/§5.3, PRD
 * CM-130). Parent routes must call ONLY this helper — it is the structural
 * whitelist between staff data and the family surface.
 *
 * 1. Resolve the case header with a column-scoped select (status, student
 *    fullName, cohort name) joined through admissions_students and
 *    admissions_cohorts — sensitive student columns (wiseStudentKey, emails,
 *    externalLinks) are never even fetched. Malformed caseId or a missing/
 *    soft-deleted case throws "NotFound".
 * 2. progress: checklists.ts's CM-24 rollup reduced to {done, total, percent}
 *    (verification detail is staff-facing and dropped).
 * 3. phaseProgress: student-home.ts's season-relevant rings reduced to
 *    {phase, label, done, total, percent}.
 * 4. collegeList: colleges.ts's live rows reduced to name/round/status/
 *    deadline/category plus a display roundLabel — aid fields, completeness,
 *    and IPEDS internals never cross (design §2.3).
 * 5. upcomingDeadlines: calendar.ts's open items (≤10, overdue first) reduced
 *    to {source, title, date, overdue}.
 * 6. announcements: family-visible by design (CM-90), capped at 10 newest,
 *    reduced to {title, body, createdAt} — author email dropped.
 * 7. testingMilestones: per sitting {testType, testDate, registered, taken,
 *    scoreReceived} where registered = registration deadline strictly before
 *    today (Bangkok) or no registration step (null deadline), taken = test
 *    date strictly before today, scoreReceived = a score is recorded. The raw
 *    `score` is attached ONLY when scoreReleasedToParent (CM-83) AND it
 *    parses as a plain number (fail-closed) — otherwise the key is omitted
 *    entirely, so unreleased scores leave no trace in the serialized payload.
 * 8. sharedNotes: notes.ts's parent-shaped read re-filtered to
 *    "shared_with_family" (defense in depth), reduced to {body, createdAt} —
 *    author email and visibility dropped.
 *
 * @returns the closed ParentDashboard DTO.
 */
export async function buildParentDashboard(
  caseId: string,
  options: BuildParentDashboardOptions = {},
  db: Database = getDb(),
): Promise<ParentDashboard> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  const now = options.now ?? new Date();
  const todayKey = getBangkokDateKey(now);

  // Step 1 — case header (column-scoped: no sensitive student columns).
  const headerRows = await db
    .select({
      status: admissionsCases.status,
      studentFullName: admissionsStudents.fullName,
      cohortName: admissionsCohorts.name,
    })
    .from(admissionsCases)
    .innerJoin(admissionsStudents, eq(admissionsCases.studentId, admissionsStudents.id))
    .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
    .where(and(
      eq(admissionsCases.id, caseId),
      isNull(admissionsCases.deletedAt),
      isNull(admissionsStudents.deletedAt),
    ))
    .limit(1);
  const header = headerRows[0];
  if (!header) throw new Error("NotFound");

  // Step 2 — overall progress (verifiedCount deliberately dropped).
  const fullProgress = await computeProgress(caseId, db);
  const progress: ParentProgressSummary = {
    done: fullProgress.done,
    total: fullProgress.total,
    percent: fullProgress.percent,
  };

  // Step 3 — per-phase rings (verifiedCount deliberately dropped).
  const rings = await getPhaseProgress(caseId, { now }, db);
  const phaseProgress: ParentPhaseProgress[] = rings.map((ring) => ({
    phase: ring.phase,
    label: ring.label,
    done: ring.done,
    total: ring.total,
    percent: ring.percent,
  }));

  // Step 4 — college list (no aid, no completeness, no IPEDS internals).
  const collegeRows = await listCollegesForCase(caseId, {}, db);
  const collegeList: ParentCollegeListEntry[] = collegeRows.map((row) => ({
    instName: row.instName,
    round: row.round,
    roundLabel: ADMISSIONS_APP_ROUND_LABELS[row.round],
    appStatus: row.appStatus,
    deadline: row.deadline,
    category: row.category,
  }));

  // Step 5 — next open deadlines across modules (≤10, overdue first).
  const deadlineItems = await getUpcomingDeadlines(
    caseId,
    PARENT_UPCOMING_DEADLINES_LIMIT,
    now,
    db,
  );
  const upcomingDeadlines: ParentDeadline[] = deadlineItems.map((item) => ({
    source: item.source,
    title: item.title,
    date: item.date,
    overdue: item.overdue,
  }));

  // Step 6 — announcements (≤10 newest; author email dropped).
  const announcementRows = (await listAnnouncementsForCase(caseId, db))
    .slice(0, PARENT_ANNOUNCEMENTS_LIMIT);
  const announcements: ParentAnnouncement[] = announcementRows.map((row) => ({
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
  }));

  // Step 7 — testing milestones (raw score ONLY when released, CM-83).
  const sittings = await listSittingsForCase(caseId, { now }, db);
  const testingMilestones: ParentTestingMilestone[] = sittings.map((sitting) => {
    const milestone: ParentTestingMilestone = {
      testType: sitting.testType,
      testDate: sitting.testDate,
      registered:
        sitting.registrationDeadline === null ||
        sitting.registrationDeadline < todayKey,
      taken: sitting.testDate < todayKey,
      scoreReceived: sitting.actualScore !== null,
    };
    if (sitting.scoreReleasedToParent && sitting.actualScore !== null) {
      const numericScore = parseScoreValue(sitting.actualScore);
      if (numericScore !== null) milestone.score = numericScore;
    }
    return milestone;
  });

  // Step 8 — family-shared notes (re-filtered fail-closed; author dropped).
  const noteRows = await listNotesForRole(caseId, "parent", db);
  const sharedNotes: ParentSharedNote[] = noteRows
    .filter((note) => note.visibility === "shared_with_family")
    .map((note) => ({
      body: note.body,
      createdAt: note.createdAt,
    }));

  return {
    studentName: header.studentFullName,
    cohortName: header.cohortName,
    caseStatus: header.status,
    progress,
    phaseProgress,
    collegeList,
    upcomingDeadlines,
    announcements,
    testingMilestones,
    sharedNotes,
  };
}
