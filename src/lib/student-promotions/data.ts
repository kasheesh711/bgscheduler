import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { markCreditInactive } from "@/lib/credit-control/db";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { extractTierTag, normalizeTierLabel } from "@/lib/payroll/domain";
import {
  buildRateRuleLookup,
  normalizePayrollRateCourse,
  payrollStudentBand,
  rateRuleKey,
  type PayrollRateRuleRow,
} from "@/lib/payroll/rate-card";
import { WiseClient } from "@/lib/wise/client";
import {
  fetchAllTeachers,
  fetchAllFutureSessions,
  fetchWiseAcceptedStudents,
  fetchWiseCourse,
  fetchWiseCourseParticipants,
  fetchWiseStudentRegistrationData,
  updateSessionSubject,
  updateWiseCourseSubject,
  updateWiseStudentRegistrationAnswers,
  type WisePromotionStudent,
  type WiseRegistrationField,
} from "@/lib/wise/fetchers";
import {
  getWiseSessionClassId,
  getWiseSessionClassSubject,
  getWiseSessionTeacherUserId,
  getWiseTeacherDisplayName,
  getWiseTeacherUserId,
  type WiseSession,
  type WiseTeacher,
} from "@/lib/wise/types";
import {
  COURSE_SUBJECT_TARGETS,
  GRADUATION_COURSE_SUBJECT_TARGETS,
  STUDENT_PROMOTION_CRON_READY_AT_UTC,
  STUDENT_PROMOTION_TARGET_DATE,
  WISE_GRADE_REGISTRATION_FIELD_ID,
  WISE_GRADE_REGISTRATION_FIELD_LABEL,
  formatPromotedGrade,
  gradeActionTypeFor,
  isUnmappedRangeCourseSubject,
  parseWiseGrade,
  requiredYearForTransition,
  type PromotionTransition,
} from "./rules";

export interface StudentPromotionActor {
  email: string;
  name: string;
}

export type StudentPromotionRunRow = typeof schema.studentPromotionRuns.$inferSelect;
export type StudentPromotionGradeActionRow = typeof schema.studentPromotionGradeActions.$inferSelect;
export type StudentPromotionCourseActionRow = typeof schema.studentPromotionCourseActions.$inferSelect;
export type StudentPromotionFutureSessionActionRow = typeof schema.studentPromotionFutureSessionActions.$inferSelect;
export type StudentPromotionGraduationActionRow = typeof schema.studentPromotionGraduationActions.$inferSelect;
export type StudentPromotionPayRateImpactRow = typeof schema.studentPromotionPayRateImpacts.$inferSelect;

export type StudentPromotionGraduationDisposition = "inactive" | "university";
export type StudentPromotionPayRateReviewStatus = "verified_correct" | "incorrect";

export interface StudentPromotionRunDetail {
  run: StudentPromotionRunRow;
  gradeActions: StudentPromotionGradeActionRow[];
  courseActions: StudentPromotionCourseActionRow[];
  futureSessionActions: StudentPromotionFutureSessionActionRow[];
  graduationActions: StudentPromotionGraduationActionRow[];
  payRateImpacts: StudentPromotionPayRateImpactRow[];
  freshness: StudentPromotionFreshness;
  summary: {
    pendingGradeActions: number;
    skippedGradeActions: number;
    appliedGradeActions: number;
    failedGradeActions: number;
    pendingCourseActions: number;
    skippedCourseActions: number;
    appliedCourseActions: number;
    failedCourseActions: number;
    pendingFutureSessionActions: number;
    skippedFutureSessionActions: number;
    appliedFutureSessionActions: number;
    failedFutureSessionActions: number;
    pendingGraduationActions: number;
    inactiveGraduationActions: number;
    universityGraduationActions: number;
    appliedGraduationActions: number;
    failedGraduationActions: number;
    pendingPayRateImpacts: number;
    verifiedPayRateImpacts: number;
    incorrectPayRateImpacts: number;
    blockedPayRateImpacts: number;
  };
}

export interface StudentPromotionFreshness {
  sourceSnapshotId: string | null;
  sourceSnapshotGeneratedAt: Date | null;
  sourceSnapshotStudentCount: number;
  activeCreditControlSnapshotId: string | null;
  activeCreditControlSnapshotGeneratedAt: Date | null;
  activeCreditControlStudentCount: number;
  activeSnapshotIsNewer: boolean;
  runIsOlderThan24Hours: boolean;
}

interface CreditControlSnapshotSummary {
  id: string;
  generatedAt: Date;
  studentCount: number;
}

interface SnapshotStudent {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  activated: boolean;
}

interface SnapshotPackage {
  wiseStudentId: string;
  wiseClassId: string;
  studentKey: string;
  studentName: string;
  parentName: string;
  subject: string;
  classType: string | null;
}

interface StudentRegistrationState {
  wiseStudentId: string;
  gradeRaw: string;
  fields: WiseRegistrationField[];
}

interface DryRunInput {
  actor: StudentPromotionActor;
  targetDate?: string;
  db?: Database;
  client?: WiseClient;
}

interface VerifyRunInput {
  runId: string;
  actor: StudentPromotionActor;
  endpointVerificationNote: string;
  db?: Database;
}

interface ApplyRunInput {
  runId?: string;
  actor?: StudentPromotionActor;
  trigger: "cron" | "admin";
  now?: Date;
  db?: Database;
  client?: WiseClient;
  allowBeforeTarget?: boolean;
}

interface ApplyFutureSessionsInput {
  runId: string;
  actor: StudentPromotionActor;
  db?: Database;
  client?: WiseClient;
}

interface UpdateGraduationDispositionInput {
  runId: string;
  actionId: string;
  disposition: StudentPromotionGraduationDisposition;
  actor: StudentPromotionActor;
  db?: Database;
  client?: WiseClient;
}

interface ReviewPayRateImpactInput {
  runId: string;
  impactId: string;
  status: StudentPromotionPayRateReviewStatus;
  note?: string | null;
  actor: StudentPromotionActor;
  db?: Database;
}

interface ReadbackInput {
  runId: string;
  db?: Database;
  client?: WiseClient;
}

const REGISTRATION_FETCH_CONCURRENCY = 4;
const WISE_WRITE_CONCURRENCY = 3;
const WISE_REQUEST_MIN_INTERVAL_MS = 130;
export const STUDENT_PROMOTION_FUTURE_SESSION_START_UTC = "2026-06-30T17:00:00.000Z";
export const WISE_SESSION_SUBJECT_UPDATE_CONFIRMATION = "apply-future-session-subjects";

const WISE_SESSION_SUBJECT_UPDATE_VERIFIED_ENV = "WISE_SESSION_SUBJECT_UPDATE_VERIFIED";
const SOURCE_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS = new Set([
  "year_2_8_grade_1_7",
  "year_2_8_grade_1_7_master",
  "year_9_11_grade_8_10",
  "year_9_11_grade_8_10_master",
  "year_12_13_grade_11_12",
  "year_12_13_grade_11_12_master",
]);
const PROMOTED_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS = new Set([
  "year_9_11_grade_8_10",
  "year_9_11_grade_8_10_master",
  "year_12_13_grade_11_12",
  "year_12_13_grade_11_12_master",
  "university_level",
  "university_level_master",
]);

type GradeReadbackStatus =
  | "promoted_exact"
  | "promoted_equivalent"
  | "missing_from_run"
  | "skipped_needs_review"
  | "wrong_grade"
  | "unparseable_grade"
  | "fetch_failed";

type CourseReadbackStatus =
  | "target_matched"
  | "skipped_needs_review"
  | "subject_drift"
  | "roster_drift"
  | "fetch_failed";

type FutureSessionReadbackStatus =
  | "target_matched"
  | "pending_update"
  | "manual_required"
  | "subject_drift"
  | "missing_class_id"
  | "missing_session_id"
  | "failed";

export interface StudentPromotionGradeReadbackRow {
  wiseStudentId: string;
  studentName: string;
  expectedTargetGrade: string | null;
  expectedPromotedYear: number | null;
  currentGradeRaw: string;
  currentYear: number | null;
  status: GradeReadbackStatus;
  detail: string | null;
}

export interface StudentPromotionCourseReadbackRow {
  wiseClassId: string;
  currentSubjectAtAudit: string;
  expectedTargetSubject: string | null;
  liveSubject: string;
  status: CourseReadbackStatus;
  detail: string | null;
}

export interface StudentPromotionFutureSessionReadbackRow {
  wiseClassId: string | null;
  wiseSessionId: string | null;
  courseActionId: string | null;
  scheduledStartTime: string | null;
  currentSubjectAtAudit: string | null;
  expectedTargetSubject: string | null;
  liveSubject: string;
  currentNormalizedCourseKey: string | null;
  targetNormalizedCourseKey: string | null;
  payrollCourseKeyMatches: boolean;
  status: FutureSessionReadbackStatus;
  detail: string | null;
}

export interface StudentPromotionReadbackResult {
  runId: string;
  checkedAt: Date;
  liveAcceptedStudentCount: number;
  runGradeActionCount: number;
  gradeSummary: Record<GradeReadbackStatus, number>;
  courseSummary: Record<CourseReadbackStatus, number>;
  futureSessionSummary: Record<FutureSessionReadbackStatus, number>;
  gradeRows: StudentPromotionGradeReadbackRow[];
  courseRows: StudentPromotionCourseReadbackRow[];
  futureSessionRows: StudentPromotionFutureSessionReadbackRow[];
}

export type GradeApplyDecision =
  | { kind: "skipped" }
  | { kind: "already_target" }
  | { kind: "grade_drift"; message: string }
  | { kind: "write_required" };

function createPromotionWiseClient(): WiseClient {
  const userId = process.env.WISE_USER_ID;
  const apiKey = process.env.WISE_API_KEY;
  const namespace = process.env.WISE_NAMESPACE ?? "begifted-education";
  if (!userId || !apiKey) {
    throw new Error("WISE_USER_ID and WISE_API_KEY are required for student promotions");
  }
  return new WiseClient({ userId, apiKey, namespace, maxConcurrency: 6 });
}

function instituteIdFromEnv(): string {
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";
  if (!instituteId) throw new Error("WISE_INSTITUTE_ID is required for student promotions");
  return instituteId;
}

function createRateGate(minIntervalMs: number) {
  let nextSlot = Date.now();
  return async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function insertGradeActionChunks(
  db: Database,
  rows: Array<typeof schema.studentPromotionGradeActions.$inferInsert>,
) {
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (chunk.length) await db.insert(schema.studentPromotionGradeActions).values(chunk);
  }
}

async function insertCourseActionChunks(
  db: Database,
  rows: Array<typeof schema.studentPromotionCourseActions.$inferInsert>,
) {
  for (let index = 0; index < rows.length; index += 250) {
    const chunk = rows.slice(index, index + 250);
    if (chunk.length) await db.insert(schema.studentPromotionCourseActions).values(chunk);
  }
}

async function insertGraduationActionChunks(
  db: Database,
  rows: Array<typeof schema.studentPromotionGraduationActions.$inferInsert>,
) {
  for (let index = 0; index < rows.length; index += 250) {
    const chunk = rows.slice(index, index + 250);
    if (chunk.length) await db.insert(schema.studentPromotionGraduationActions).values(chunk);
  }
}

async function upsertFutureSessionActionChunks(
  db: Database,
  rows: Array<typeof schema.studentPromotionFutureSessionActions.$inferInsert>,
) {
  for (let index = 0; index < rows.length; index += 250) {
    const chunk = rows.slice(index, index + 250);
    if (!chunk.length) continue;
    await db
      .insert(schema.studentPromotionFutureSessionActions)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          schema.studentPromotionFutureSessionActions.runId,
          schema.studentPromotionFutureSessionActions.wiseSessionId,
        ],
        set: {
          courseActionId: sql`excluded.course_action_id`,
          wiseClassId: sql`excluded.wise_class_id`,
          scheduledStartTime: sql`excluded.scheduled_start_time`,
          currentSubject: sql`excluded.current_subject`,
          targetSubject: sql`excluded.target_subject`,
          currentNormalizedCourseKey: sql`excluded.current_normalized_course_key`,
          targetNormalizedCourseKey: sql`excluded.target_normalized_course_key`,
          status: sql`excluded.status`,
          skipReason: sql`excluded.skip_reason`,
          responsePayload: sql`excluded.response_payload`,
          errorMessage: sql`excluded.error_message`,
          appliedAt: sql`excluded.applied_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

function registrationGradeAnswer(fields: WiseRegistrationField[]): string {
  const field = fields.find((item) => item.questionId === WISE_GRADE_REGISTRATION_FIELD_ID);
  return String(field?.answer ?? "").trim();
}

function studentDisplayName(student: WisePromotionStudent, fallback?: SnapshotStudent): string {
  return String(student.name ?? fallback?.studentName ?? "").trim();
}

function setFrom<T>(values: Iterable<T>): Set<T> {
  return new Set(values);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = setFrom(right);
  return left.every((value) => rightSet.has(value));
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function wiseSessionStartDate(session: Pick<WiseSession, "scheduledStartTime">): Date | null {
  const date = new Date(session.scheduledStartTime);
  return Number.isNaN(date.getTime()) ? null : date;
}

function wiseSessionSubject(session: WiseSession): string {
  const classSubject = getWiseSessionClassSubject(session)?.trim();
  if (classSubject) return classSubject;
  const directSubject = session.subject;
  return typeof directSubject === "string" ? directSubject.trim() : "";
}

function futureSessionStartCutoff(): Date {
  return new Date(STUDENT_PROMOTION_FUTURE_SESSION_START_UTC);
}

function futureSessionSubjectUpdateGateEnabled(): boolean {
  return process.env[WISE_SESSION_SUBJECT_UPDATE_VERIFIED_ENV] === "true";
}

export function studentPromotionFutureSessionCourseActionEligible(
  action: Pick<StudentPromotionCourseActionRow, "currentSubject" | "targetSubject" | "status">,
): boolean {
  if (!action.targetSubject || (action.status !== "pending" && action.status !== "applied")) return false;
  const currentKey = normalizePayrollRateCourse(action.currentSubject);
  const targetKey = normalizePayrollRateCourse(action.targetSubject);
  return Boolean(
    currentKey
      && targetKey
      && SOURCE_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS.has(currentKey)
      && PROMOTED_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS.has(targetKey),
  );
}

export function studentPromotionFutureSessionEligible(input: {
  session: WiseSession;
  courseAction: Pick<StudentPromotionCourseActionRow, "wiseClassId" | "currentSubject" | "targetSubject" | "status">;
}): boolean {
  if (!studentPromotionFutureSessionCourseActionEligible(input.courseAction)) return false;
  const start = wiseSessionStartDate(input.session);
  if (!start || start.getTime() < futureSessionStartCutoff().getTime()) return false;
  return getWiseSessionClassId(input.session) === input.courseAction.wiseClassId;
}

function classifyFutureSessionAction(input: {
  courseAction: Pick<StudentPromotionCourseActionRow, "currentSubject" | "targetSubject">;
  currentSubject: string;
}): Pick<
  typeof schema.studentPromotionFutureSessionActions.$inferInsert,
  "status" | "skipReason" | "errorMessage" | "currentNormalizedCourseKey" | "targetNormalizedCourseKey" | "responsePayload" | "appliedAt"
> {
  const targetSubject = input.courseAction.targetSubject ?? "";
  const currentNormalizedCourseKey = normalizePayrollRateCourse(input.currentSubject);
  const expectedCurrentNormalizedCourseKey = normalizePayrollRateCourse(input.courseAction.currentSubject);
  const targetNormalizedCourseKey = normalizePayrollRateCourse(targetSubject);
  const now = new Date();

  if (!targetNormalizedCourseKey || !PROMOTED_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS.has(targetNormalizedCourseKey)) {
    return {
      status: "skipped",
      skipReason: "payroll_course_unmapped",
      errorMessage: `Target subject ${targetSubject || "(blank)"} does not normalize to a promoted payroll course key`,
      currentNormalizedCourseKey,
      targetNormalizedCourseKey,
      responsePayload: undefined,
      appliedAt: undefined,
    };
  }

  if (input.currentSubject === targetSubject || currentNormalizedCourseKey === targetNormalizedCourseKey) {
    return {
      status: "applied",
      skipReason: null,
      errorMessage: input.currentSubject === targetSubject
        ? null
        : "Session subject text is non-canonical but payroll normalization matches the promoted course key",
      currentNormalizedCourseKey,
      targetNormalizedCourseKey,
      responsePayload: {
        idempotent: true,
        payrollCourseKeyMatches: currentNormalizedCourseKey === targetNormalizedCourseKey,
      },
      appliedAt: now,
    };
  }

  if (input.currentSubject === input.courseAction.currentSubject || currentNormalizedCourseKey === expectedCurrentNormalizedCourseKey) {
    return {
      status: "pending",
      skipReason: null,
      errorMessage: null,
      currentNormalizedCourseKey,
      targetNormalizedCourseKey,
      responsePayload: undefined,
      appliedAt: undefined,
    };
  }

  return {
    status: "skipped",
    skipReason: "session_subject_drift",
    errorMessage: `Current session subject changed from ${input.courseAction.currentSubject} to ${input.currentSubject || "(blank)"}`,
    currentNormalizedCourseKey,
    targetNormalizedCourseKey,
    responsePayload: undefined,
    appliedAt: undefined,
  };
}

function transitionForUnmappedSubject(subject: string): PromotionTransition | null {
  if (/(?:y\s*2\s*-\s*8|g\s*1\s*-\s*7|grade\s*1\s*-\s*7)/i.test(subject)) return "year8_to_year9";
  if (/(?:y\s*9\s*-\s*11|g\s*8\s*-\s*10|grade\s*8\s*-\s*10)/i.test(subject)) return "year11_to_year12";
  if (/(?:y\s*12\s*-\s*13|g\s*11\s*-\s*12|grade\s*11\s*-\s*12)/i.test(subject)) return "year13_to_university";
  return null;
}

function activeCourseSubjectsByStudent(packages: SnapshotPackage[]): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const row of packages) {
    const subjects = map.get(row.wiseStudentId) ?? new Set<string>();
    subjects.add(row.subject);
    map.set(row.wiseStudentId, subjects);
  }
  return new Map([...map.entries()].map(([studentId, subjects]) => [studentId, [...subjects]]));
}

function classRowsByWiseClass(packages: SnapshotPackage[]) {
  const map = new Map<string, { wiseClassId: string; subject: string; studentIds: Set<string> }>();
  for (const row of packages) {
    const existing = map.get(row.wiseClassId) ?? {
      wiseClassId: row.wiseClassId,
      subject: row.subject,
      studentIds: new Set<string>(),
    };
    existing.studentIds.add(row.wiseStudentId);
    map.set(row.wiseClassId, existing);
  }
  return [...map.values()];
}

function buildCourseActions(
  runId: string,
  packages: SnapshotPackage[],
  currentYearByStudent: Map<string, number | null>,
): Array<typeof schema.studentPromotionCourseActions.$inferInsert> {
  const rows: Array<typeof schema.studentPromotionCourseActions.$inferInsert> = [];

  for (const classroom of classRowsByWiseClass(packages)) {
    const mapped = COURSE_SUBJECT_TARGETS[classroom.subject] ?? GRADUATION_COURSE_SUBJECT_TARGETS[classroom.subject];
    const unmappedTransition = !mapped && isUnmappedRangeCourseSubject(classroom.subject)
      ? transitionForUnmappedSubject(classroom.subject)
      : null;
    const transition = mapped?.transition ?? unmappedTransition;
    if (!transition) continue;

    const studentIds = sortedUnique(classroom.studentIds);
    const requiredYear = requiredYearForTransition(transition);
    const qualifyingStudentIds = studentIds.filter((studentId) => currentYearByStudent.get(studentId) === requiredYear);
    const unparseableStudentIds = studentIds.filter((studentId) => currentYearByStudent.get(studentId) === null);

    if (!mapped) {
      if (qualifyingStudentIds.length > 0 || unparseableStudentIds.length > 0) {
        rows.push({
          runId,
          wiseClassId: classroom.wiseClassId,
          currentSubject: classroom.subject,
          targetSubject: null,
          transitionType: "unmapped_course_variant",
          studentIds,
          qualifyingStudentIds,
          status: "skipped",
          skipReason: "unmapped_course_variant",
        });
      }
      continue;
    }

    if (qualifyingStudentIds.length === 0) {
      if (unparseableStudentIds.length > 0) {
        rows.push({
          runId,
          wiseClassId: classroom.wiseClassId,
          currentSubject: classroom.subject,
          targetSubject: mapped.target,
          transitionType: mapped.transition,
          studentIds,
          qualifyingStudentIds,
          status: "skipped",
          skipReason: "grade_missing_or_unparsed_review",
        });
      }
      continue;
    }

    if (!mapped.target) {
      rows.push({
        runId,
        wiseClassId: classroom.wiseClassId,
        currentSubject: classroom.subject,
        targetSubject: null,
        transitionType: mapped.transition,
        studentIds,
        qualifyingStudentIds,
        status: "skipped",
        skipReason: "unmapped_target_subject",
      });
      continue;
    }

    if (qualifyingStudentIds.length !== studentIds.length) {
      rows.push({
        runId,
        wiseClassId: classroom.wiseClassId,
        currentSubject: classroom.subject,
        targetSubject: mapped.target,
        transitionType: mapped.transition,
        studentIds,
        qualifyingStudentIds,
        status: "skipped",
        skipReason: "mixed_class_roster",
      });
      continue;
    }

    if (mapped.transition === "year13_to_university") {
      rows.push({
        runId,
        wiseClassId: classroom.wiseClassId,
        currentSubject: classroom.subject,
        targetSubject: mapped.target,
        transitionType: mapped.transition,
        studentIds,
        qualifyingStudentIds,
        status: "skipped",
        skipReason: "graduation_disposition_pending",
      });
      continue;
    }

    rows.push({
      runId,
      wiseClassId: classroom.wiseClassId,
      currentSubject: classroom.subject,
      targetSubject: mapped.target,
      transitionType: mapped.transition,
      studentIds,
      qualifyingStudentIds,
      status: "pending",
    });
  }

  return rows;
}

async function loadActiveCreditControlSnapshot(db: Database) {
  const [snapshot] = await db
    .select()
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);

  if (!snapshot) throw new Error("No active Credit Control snapshot found");

  const [students, packages] = await Promise.all([
    db
      .select({
        wiseStudentId: schema.creditControlStudents.wiseStudentId,
        studentKey: schema.creditControlStudents.studentKey,
        studentName: schema.creditControlStudents.studentName,
        parentName: schema.creditControlStudents.parentName,
        activated: schema.creditControlStudents.activated,
      })
      .from(schema.creditControlStudents)
      .where(eq(schema.creditControlStudents.snapshotId, snapshot.id)),
    db
      .select({
        wiseStudentId: schema.creditControlPackages.wiseStudentId,
        wiseClassId: schema.creditControlPackages.wiseClassId,
        studentKey: schema.creditControlPackages.studentKey,
        studentName: schema.creditControlPackages.studentName,
        parentName: schema.creditControlPackages.parentName,
        subject: schema.creditControlPackages.subject,
        classType: schema.creditControlPackages.classType,
      })
      .from(schema.creditControlPackages)
      .where(eq(schema.creditControlPackages.snapshotId, snapshot.id)),
  ]);

  return {
    snapshot,
    students: students satisfies SnapshotStudent[],
    packages: packages satisfies SnapshotPackage[],
  };
}

async function loadCreditControlSnapshotSummary(
  db: Database,
  snapshotId: string | null,
): Promise<CreditControlSnapshotSummary | null> {
  if (!snapshotId) return null;

  const [snapshot] = await db
    .select({
      id: schema.creditControlSnapshots.id,
      generatedAt: schema.creditControlSnapshots.generatedAt,
    })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.id, snapshotId))
    .limit(1);

  if (!snapshot) return null;

  const [studentCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.creditControlStudents)
    .where(eq(schema.creditControlStudents.snapshotId, snapshot.id));

  return {
    id: snapshot.id,
    generatedAt: snapshot.generatedAt,
    studentCount: studentCount?.count ?? 0,
  };
}

async function loadActiveCreditControlSnapshotSummary(
  db: Database,
): Promise<CreditControlSnapshotSummary | null> {
  const [snapshot] = await db
    .select({
      id: schema.creditControlSnapshots.id,
      generatedAt: schema.creditControlSnapshots.generatedAt,
    })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);

  return snapshot ? loadCreditControlSnapshotSummary(db, snapshot.id) : null;
}

export function buildStudentPromotionFreshness(input: {
  runCreatedAt: Date;
  sourceSnapshotId: string | null;
  sourceSnapshotGeneratedAt: Date | null;
  sourceSnapshotStudentCount: number;
  activeSnapshotId: string | null;
  activeSnapshotGeneratedAt: Date | null;
  activeSnapshotStudentCount: number;
  now?: Date;
}): StudentPromotionFreshness {
  const now = input.now ?? new Date();
  const activeSnapshotIsNewer = Boolean(
    input.sourceSnapshotGeneratedAt
      && input.activeSnapshotGeneratedAt
      && input.activeSnapshotGeneratedAt.getTime() > input.sourceSnapshotGeneratedAt.getTime(),
  );
  const runIsOlderThan24Hours = now.getTime() - input.runCreatedAt.getTime() > 24 * 60 * 60 * 1000;

  return {
    sourceSnapshotId: input.sourceSnapshotId,
    sourceSnapshotGeneratedAt: input.sourceSnapshotGeneratedAt,
    sourceSnapshotStudentCount: input.sourceSnapshotStudentCount,
    activeCreditControlSnapshotId: input.activeSnapshotId,
    activeCreditControlSnapshotGeneratedAt: input.activeSnapshotGeneratedAt,
    activeCreditControlStudentCount: input.activeSnapshotStudentCount,
    activeSnapshotIsNewer,
    runIsOlderThan24Hours,
  };
}

export function studentPromotionRunNeedsFreshAudit(detail: StudentPromotionRunDetail): boolean {
  return detail.freshness.activeSnapshotIsNewer || detail.freshness.runIsOlderThan24Hours;
}

function assertStudentPromotionRunFresh(detail: StudentPromotionRunDetail, action: "verify" | "apply") {
  if (!studentPromotionRunNeedsFreshAudit(detail)) return;
  if (detail.freshness.activeSnapshotIsNewer) {
    throw new Error(
      `Cannot ${action} this promotion run because the active Credit Control snapshot is newer; run a fresh audit first`,
    );
  }
  throw new Error(`Cannot ${action} this promotion run because it is more than 24 hours old; run a fresh audit first`);
}

export function missingLiveAcceptedStudentIds(
  detail: StudentPromotionRunDetail,
  liveStudents: WisePromotionStudent[],
): string[] {
  const runStudentIds = new Set(detail.gradeActions.map((row) => row.wiseStudentId));
  return sortedUnique(liveStudents.map((student) => student._id).filter((id) => id && !runStudentIds.has(id)));
}

function assertRunCoversLiveAcceptedStudents(
  detail: StudentPromotionRunDetail,
  liveStudents: WisePromotionStudent[],
) {
  const missingIds = missingLiveAcceptedStudentIds(detail, liveStudents);
  if (missingIds.length === 0) return;
  throw new Error(
    `Cannot apply this promotion run because ${missingIds.length} live accepted Wise students are missing from it; run a fresh audit first`,
  );
}

function assertGraduationAndPayRateReviewComplete(detail: StudentPromotionRunDetail) {
  const unresolvedGraduations = detail.graduationActions.filter((row) => !row.disposition);
  const blockedPayImpacts = detail.payRateImpacts.filter((row) => row.reviewStatus === "blocked" || row.blockerReason);
  const pendingPayImpacts = detail.payRateImpacts.filter((row) => row.reviewStatus === "pending_review");
  const incorrectPayImpacts = detail.payRateImpacts.filter((row) => row.reviewStatus === "incorrect");
  const messages: string[] = [];

  if (unresolvedGraduations.length > 0) {
    messages.push(`${unresolvedGraduations.length} Year 13 graduation decisions are unresolved`);
  }
  if (blockedPayImpacts.length > 0) {
    messages.push(`${blockedPayImpacts.length} pay-rate impact rows have missing tier/rate-card data`);
  }
  if (pendingPayImpacts.length > 0) {
    messages.push(`${pendingPayImpacts.length} pay-rate impact rows are not verified`);
  }
  if (incorrectPayImpacts.length > 0) {
    messages.push(`${incorrectPayImpacts.length} pay-rate impact rows are marked incorrect`);
  }

  if (messages.length > 0) {
    throw new Error(`Cannot verify this promotion run: ${messages.join("; ")}`);
  }
}

export function classifyGradeApplyDecision(
  action: Pick<StudentPromotionGradeActionRow, "targetGrade" | "parsedCurrentYear" | "currentGradeRaw">,
  currentRaw: string,
): GradeApplyDecision {
  if (!action.targetGrade || action.parsedCurrentYear === null) return { kind: "skipped" };
  if (currentRaw === action.targetGrade) return { kind: "already_target" };

  const parsed = parseWiseGrade(currentRaw);
  if (parsed.currentYear !== action.parsedCurrentYear) {
    return {
      kind: "grade_drift",
      message: `Current grade changed from ${action.currentGradeRaw || "(blank)"} to ${currentRaw || "(blank)"}`,
    };
  }

  return { kind: "write_required" };
}

function emptyGradeSummary(): Record<GradeReadbackStatus, number> {
  return {
    promoted_exact: 0,
    promoted_equivalent: 0,
    missing_from_run: 0,
    skipped_needs_review: 0,
    wrong_grade: 0,
    unparseable_grade: 0,
    fetch_failed: 0,
  };
}

function emptyCourseSummary(): Record<CourseReadbackStatus, number> {
  return {
    target_matched: 0,
    skipped_needs_review: 0,
    subject_drift: 0,
    roster_drift: 0,
    fetch_failed: 0,
  };
}

function emptyFutureSessionSummary(): Record<FutureSessionReadbackStatus, number> {
  return {
    target_matched: 0,
    pending_update: 0,
    manual_required: 0,
    subject_drift: 0,
    missing_class_id: 0,
    missing_session_id: 0,
    failed: 0,
  };
}

function summarizeGradeReadback(rows: StudentPromotionGradeReadbackRow[]): Record<GradeReadbackStatus, number> {
  const summary = emptyGradeSummary();
  for (const row of rows) summary[row.status] += 1;
  return summary;
}

function summarizeCourseReadback(rows: StudentPromotionCourseReadbackRow[]): Record<CourseReadbackStatus, number> {
  const summary = emptyCourseSummary();
  for (const row of rows) summary[row.status] += 1;
  return summary;
}

function summarizeFutureSessionReadback(
  rows: StudentPromotionFutureSessionReadbackRow[],
): Record<FutureSessionReadbackStatus, number> {
  const summary = emptyFutureSessionSummary();
  for (const row of rows) summary[row.status] += 1;
  return summary;
}

export function buildStudentPromotionGradeReadbackRows(
  detail: StudentPromotionRunDetail,
  liveStudents: WisePromotionStudent[],
  registrations: Array<{
    wiseStudentId: string;
    gradeRaw: string;
    errorMessage?: string | null;
  }>,
): StudentPromotionGradeReadbackRow[] {
  const actionByStudent = new Map(detail.gradeActions.map((action) => [action.wiseStudentId, action]));
  const registrationByStudent = new Map(registrations.map((registration) => [registration.wiseStudentId, registration]));

  return liveStudents.map((student) => {
    const action = actionByStudent.get(student._id);
    const registration = registrationByStudent.get(student._id);
    const parsed = parseWiseGrade(registration?.gradeRaw ?? "");
    const expectedPromotedYear = action?.parsedCurrentYear === null || action?.parsedCurrentYear === undefined
      ? null
      : action.parsedCurrentYear + 1;

    if (registration?.errorMessage) {
      return {
        wiseStudentId: student._id,
        studentName: studentDisplayName(student),
        expectedTargetGrade: action?.targetGrade ?? null,
        expectedPromotedYear,
        currentGradeRaw: registration.gradeRaw,
        currentYear: parsed.currentYear,
        status: "fetch_failed",
        detail: registration.errorMessage,
      };
    }

    if (!action) {
      return {
        wiseStudentId: student._id,
        studentName: studentDisplayName(student),
        expectedTargetGrade: null,
        expectedPromotedYear: null,
        currentGradeRaw: registration?.gradeRaw ?? "",
        currentYear: parsed.currentYear,
        status: "missing_from_run",
        detail: "Live accepted student was not present in the verified promotion run",
      };
    }

    if (!action.targetGrade || expectedPromotedYear === null) {
      return {
        wiseStudentId: student._id,
        studentName: action.studentName || studentDisplayName(student),
        expectedTargetGrade: action.targetGrade,
        expectedPromotedYear,
        currentGradeRaw: registration?.gradeRaw ?? "",
        currentYear: parsed.currentYear,
        status: "skipped_needs_review",
        detail: action.skipReason ?? "Promotion action has no target grade",
      };
    }

    if ((registration?.gradeRaw ?? "") === action.targetGrade) {
      return {
        wiseStudentId: student._id,
        studentName: action.studentName || studentDisplayName(student),
        expectedTargetGrade: action.targetGrade,
        expectedPromotedYear,
        currentGradeRaw: registration?.gradeRaw ?? "",
        currentYear: parsed.currentYear,
        status: "promoted_exact",
        detail: null,
      };
    }

    if (parsed.currentYear === expectedPromotedYear) {
      return {
        wiseStudentId: student._id,
        studentName: action.studentName || studentDisplayName(student),
        expectedTargetGrade: action.targetGrade,
        expectedPromotedYear,
        currentGradeRaw: registration?.gradeRaw ?? "",
        currentYear: parsed.currentYear,
        status: "promoted_equivalent",
        detail: "Promoted year is correct but Wise text is not canonical",
      };
    }

    return {
      wiseStudentId: student._id,
      studentName: action.studentName || studentDisplayName(student),
      expectedTargetGrade: action.targetGrade,
      expectedPromotedYear,
      currentGradeRaw: registration?.gradeRaw ?? "",
      currentYear: parsed.currentYear,
      status: parsed.currentYear === null ? "unparseable_grade" : "wrong_grade",
      detail: parsed.currentYear === null
        ? "Current Wise grade is blank or unparseable"
        : `Expected promoted year ${expectedPromotedYear}; found year ${parsed.currentYear}`,
    };
  });
}

export function classifyCourseReadback(
  action: Pick<StudentPromotionCourseActionRow, "wiseClassId" | "targetSubject" | "currentSubject" | "studentIds">,
  input: { liveSubject?: string; liveStudentIds?: string[]; errorMessage?: string | null },
): StudentPromotionCourseReadbackRow {
  if (!action.targetSubject) {
    return {
      wiseClassId: "wiseClassId" in action ? String(action.wiseClassId) : "",
      currentSubjectAtAudit: action.currentSubject,
      expectedTargetSubject: null,
      liveSubject: input.liveSubject ?? "",
      status: "skipped_needs_review",
      detail: "Promotion course action has no target subject",
    };
  }

  if (input.errorMessage) {
    return {
      wiseClassId: "wiseClassId" in action ? String(action.wiseClassId) : "",
      currentSubjectAtAudit: action.currentSubject,
      expectedTargetSubject: action.targetSubject,
      liveSubject: input.liveSubject ?? "",
      status: "fetch_failed",
      detail: input.errorMessage,
    };
  }

  const liveStudentIds = sortedUnique(input.liveStudentIds ?? []);
  if (liveStudentIds.length === 0 || !sameStringSet(liveStudentIds, action.studentIds)) {
    return {
      wiseClassId: "wiseClassId" in action ? String(action.wiseClassId) : "",
      currentSubjectAtAudit: action.currentSubject,
      expectedTargetSubject: action.targetSubject,
      liveSubject: input.liveSubject ?? "",
      status: "roster_drift",
      detail: liveStudentIds.length === 0
        ? "Unable to verify live Wise course roster"
        : "Live Wise course roster differs from the promotion run",
    };
  }

  if ((input.liveSubject ?? "") === action.targetSubject) {
    return {
      wiseClassId: "wiseClassId" in action ? String(action.wiseClassId) : "",
      currentSubjectAtAudit: action.currentSubject,
      expectedTargetSubject: action.targetSubject,
      liveSubject: input.liveSubject ?? "",
      status: "target_matched",
      detail: null,
    };
  }

  return {
    wiseClassId: "wiseClassId" in action ? String(action.wiseClassId) : "",
    currentSubjectAtAudit: action.currentSubject,
    expectedTargetSubject: action.targetSubject,
    liveSubject: input.liveSubject ?? "",
    status: "subject_drift",
    detail: `Expected ${action.targetSubject}; found ${input.liveSubject || "(blank)"}`,
  };
}

export function buildStudentPromotionFutureSessionActionRows(
  detail: Pick<StudentPromotionRunDetail, "run" | "courseActions">,
  liveSessions: WiseSession[],
): Array<typeof schema.studentPromotionFutureSessionActions.$inferInsert> {
  const courseActionByClass = new Map(
    detail.courseActions
      .filter(studentPromotionFutureSessionCourseActionEligible)
      .map((action) => [action.wiseClassId, action]),
  );
  const rows: Array<typeof schema.studentPromotionFutureSessionActions.$inferInsert> = [];
  const now = new Date();

  for (const session of liveSessions) {
    const wiseClassId = getWiseSessionClassId(session);
    if (!wiseClassId) continue;
    const courseAction = courseActionByClass.get(wiseClassId);
    if (!courseAction || !studentPromotionFutureSessionEligible({ session, courseAction })) continue;
    const scheduledStartTime = wiseSessionStartDate(session);
    if (!scheduledStartTime || !session._id || !courseAction.targetSubject) continue;
    const currentSubject = wiseSessionSubject(session);
    const classification = classifyFutureSessionAction({ courseAction, currentSubject });

    rows.push({
      runId: detail.run.id,
      courseActionId: courseAction.id,
      wiseClassId,
      wiseSessionId: session._id,
      scheduledStartTime,
      currentSubject,
      targetSubject: courseAction.targetSubject,
      currentNormalizedCourseKey: classification.currentNormalizedCourseKey,
      targetNormalizedCourseKey: classification.targetNormalizedCourseKey,
      status: classification.status,
      skipReason: classification.skipReason,
      responsePayload: classification.responsePayload,
      errorMessage: classification.errorMessage,
      appliedAt: classification.appliedAt,
      updatedAt: now,
    });
  }

  return rows;
}

type PayRateImpactInsert = typeof schema.studentPromotionPayRateImpacts.$inferInsert;

interface ActiveRateCardInput {
  hasActiveRateCard: boolean;
  rules: PayrollRateRuleRow[];
}

function teacherMaps(teachers: WiseTeacher[]) {
  const byId = new Map<string, WiseTeacher>();
  const byUserId = new Map<string, WiseTeacher>();
  for (const teacher of teachers) {
    if (teacher._id) byId.set(teacher._id, teacher);
    const userId = getWiseTeacherUserId(teacher);
    if (userId) byUserId.set(userId, teacher);
  }
  return { byId, byUserId };
}

function teacherForSession(
  session: WiseSession,
  maps: ReturnType<typeof teacherMaps>,
): { teacher: WiseTeacher | null; teacherWiseId: string | null; teacherWiseUserId: string | null; teacherName: string } {
  const sessionTeacherUserId = getWiseSessionTeacherUserId(session) ?? null;
  const sessionTeacherId = typeof session.teacherId === "string" && session.teacherId ? session.teacherId : null;
  const teacher = (sessionTeacherUserId ? maps.byUserId.get(sessionTeacherUserId) ?? maps.byId.get(sessionTeacherUserId) : undefined)
    ?? (sessionTeacherId ? maps.byId.get(sessionTeacherId) : undefined)
    ?? null;
  const teacherWiseUserId = teacher ? getWiseTeacherUserId(teacher) ?? sessionTeacherUserId : sessionTeacherUserId;
  const teacherWiseId = teacher?._id ?? sessionTeacherId ?? null;
  return {
    teacher,
    teacherWiseId,
    teacherWiseUserId,
    teacherName: teacher ? getWiseTeacherDisplayName(teacher) : String(session.teacherName ?? teacherWiseUserId ?? teacherWiseId ?? "Unknown teacher"),
  };
}

function payRateBlockerReason(input: {
  hasActiveRateCard: boolean;
  teacherWiseUserId: string | null;
  normalizedTier: string;
  currentNormalizedCourseKey: string | null;
  targetNormalizedCourseKey: string | null;
  beforeRule: PayrollRateRuleRow | undefined;
  afterRule: PayrollRateRuleRow | undefined;
}): string | null {
  if (!input.hasActiveRateCard) return "missing_active_rate_card";
  if (!input.teacherWiseUserId || input.normalizedTier === "Unassigned") return "missing_teacher_tier";
  if (!input.currentNormalizedCourseKey || !input.targetNormalizedCourseKey) return "unmapped_course";
  if (!input.beforeRule) return "missing_before_rate_rule";
  if (!input.afterRule) return "missing_after_rate_rule";
  return null;
}

function payRateImpactMaterialKey(row: Pick<
  StudentPromotionPayRateImpactRow,
  | "courseActionId"
  | "wiseClassId"
  | "teacherWiseId"
  | "teacherWiseUserId"
  | "normalizedTier"
  | "studentBand"
  | "currentNormalizedCourseKey"
  | "targetNormalizedCourseKey"
  | "beforeRateRuleId"
  | "afterRateRuleId"
  | "beforeExpectedHourlyRate"
  | "afterExpectedHourlyRate"
  | "futureSessionCount"
  | "firstSessionStartTime"
  | "lastSessionStartTime"
  | "affectedStudentIds"
  | "blockerReason"
>): string {
  return JSON.stringify({
    courseActionId: row.courseActionId,
    wiseClassId: row.wiseClassId,
    teacherWiseId: row.teacherWiseId,
    teacherWiseUserId: row.teacherWiseUserId,
    normalizedTier: row.normalizedTier,
    studentBand: row.studentBand,
    currentNormalizedCourseKey: row.currentNormalizedCourseKey,
    targetNormalizedCourseKey: row.targetNormalizedCourseKey,
    beforeRateRuleId: row.beforeRateRuleId,
    afterRateRuleId: row.afterRateRuleId,
    beforeExpectedHourlyRate: row.beforeExpectedHourlyRate,
    afterExpectedHourlyRate: row.afterExpectedHourlyRate,
    futureSessionCount: row.futureSessionCount,
    firstSessionStartTime: row.firstSessionStartTime?.toISOString() ?? null,
    lastSessionStartTime: row.lastSessionStartTime?.toISOString() ?? null,
    affectedStudentIds: row.affectedStudentIds,
    blockerReason: row.blockerReason,
  });
}

export function buildStudentPromotionPayRateImpactRows(input: {
  detail: Pick<StudentPromotionRunDetail, "run" | "gradeActions" | "courseActions">;
  liveSessions: WiseSession[];
  teachers: WiseTeacher[];
  activeRateCard: ActiveRateCardInput;
}): PayRateImpactInsert[] {
  const courseActionByClass = new Map(
    input.detail.courseActions
      .filter(studentPromotionFutureSessionCourseActionEligible)
      .map((action) => [action.wiseClassId, action]),
  );
  const nameByStudentId = new Map(input.detail.gradeActions.map((row) => [row.wiseStudentId, row.studentName]));
  const teachers = teacherMaps(input.teachers);
  const rateRules = buildRateRuleLookup(input.activeRateCard.rules);
  const groups = new Map<string, PayRateImpactInsert>();
  const now = new Date();

  for (const session of input.liveSessions) {
    const wiseClassId = getWiseSessionClassId(session);
    if (!wiseClassId) continue;
    const courseAction = courseActionByClass.get(wiseClassId);
    if (!courseAction || !studentPromotionFutureSessionEligible({ session, courseAction })) continue;
    if (!courseAction.targetSubject) continue;

    const start = wiseSessionStartDate(session);
    if (!start) continue;

    const teacher = teacherForSession(session, teachers);
    const rawTier = teacher.teacher ? extractTierTag(teacher.teacher.tags) : null;
    const normalizedTier = normalizeTierLabel(rawTier);
    const studentBand = payrollStudentBand(session.studentCount ?? courseAction.studentIds.length);
    const currentNormalizedCourseKey = normalizePayrollRateCourse(courseAction.currentSubject);
    const targetNormalizedCourseKey = normalizePayrollRateCourse(courseAction.targetSubject);
    const beforeRule = currentNormalizedCourseKey && normalizedTier !== "Unassigned"
      ? rateRules.get(rateRuleKey({ studentBand, normalizedCourseKey: currentNormalizedCourseKey, tierKey: normalizedTier }))
      : undefined;
    const afterRule = targetNormalizedCourseKey && normalizedTier !== "Unassigned"
      ? rateRules.get(rateRuleKey({ studentBand, normalizedCourseKey: targetNormalizedCourseKey, tierKey: normalizedTier }))
      : undefined;
    const blockerReason = payRateBlockerReason({
      hasActiveRateCard: input.activeRateCard.hasActiveRateCard,
      teacherWiseUserId: teacher.teacherWiseUserId,
      normalizedTier,
      currentNormalizedCourseKey,
      targetNormalizedCourseKey,
      beforeRule,
      afterRule,
    });
    const affectedStudentIds = sortedUnique(
      courseAction.qualifyingStudentIds.length > 0 ? courseAction.qualifyingStudentIds : courseAction.studentIds,
    );
    const impactKey = [
      courseAction.id,
      teacher.teacherWiseUserId ?? teacher.teacherWiseId ?? "unknown_teacher",
      studentBand,
      currentNormalizedCourseKey ?? "unmapped_current",
      targetNormalizedCourseKey ?? "unmapped_target",
    ].join("|");

    const existing = groups.get(impactKey);
    const firstSessionStartTime = existing?.firstSessionStartTime && existing.firstSessionStartTime < start
      ? existing.firstSessionStartTime
      : start;
    const lastSessionStartTime = existing?.lastSessionStartTime && existing.lastSessionStartTime > start
      ? existing.lastSessionStartTime
      : start;

    groups.set(impactKey, {
      runId: input.detail.run.id,
      courseActionId: courseAction.id,
      impactKey,
      wiseClassId,
      teacherWiseId: teacher.teacherWiseId,
      teacherWiseUserId: teacher.teacherWiseUserId,
      teacherName: teacher.teacherName,
      rawTier,
      normalizedTier,
      studentBand,
      currentSubject: courseAction.currentSubject,
      targetSubject: courseAction.targetSubject,
      currentNormalizedCourseKey,
      targetNormalizedCourseKey,
      beforeRateRuleId: beforeRule?.id ?? null,
      afterRateRuleId: afterRule?.id ?? null,
      beforeExpectedHourlyRate: beforeRule?.expectedRevenuePerHour ?? null,
      afterExpectedHourlyRate: afterRule?.expectedRevenuePerHour ?? null,
      rateDelta: beforeRule && afterRule ? afterRule.expectedRevenuePerHour - beforeRule.expectedRevenuePerHour : null,
      futureSessionCount: (existing?.futureSessionCount ?? 0) + 1,
      firstSessionStartTime,
      lastSessionStartTime,
      affectedStudentIds,
      affectedStudentNames: affectedStudentIds.map((studentId) => nameByStudentId.get(studentId) ?? studentId),
      reviewStatus: blockerReason ? "blocked" : "pending_review",
      blockerReason,
      reviewedByEmail: null,
      reviewedByName: null,
      reviewedAt: null,
      reviewNote: null,
      updatedAt: now,
    });
  }

  return [...groups.values()].sort((left, right) => (
    (left.teacherName ?? "").localeCompare(right.teacherName ?? "")
    || left.wiseClassId.localeCompare(right.wiseClassId)
    || left.studentBand.localeCompare(right.studentBand)
    || left.currentSubject.localeCompare(right.currentSubject)
  ));
}

export function buildStudentPromotionFutureSessionReadbackRows(
  detail: Pick<StudentPromotionRunDetail, "courseActions" | "futureSessionActions">,
  liveSessions: WiseSession[],
): StudentPromotionFutureSessionReadbackRow[] {
  const gateEnabled = futureSessionSubjectUpdateGateEnabled();
  const courseActionByClass = new Map(
    detail.courseActions
      .filter(studentPromotionFutureSessionCourseActionEligible)
      .map((action) => [action.wiseClassId, action]),
  );
  const futureActionBySession = new Map(detail.futureSessionActions.map((action) => [action.wiseSessionId, action]));
  const rows: StudentPromotionFutureSessionReadbackRow[] = [];
  const seenSessionIds = new Set<string>();

  for (const session of liveSessions) {
    const scheduledStartTime = wiseSessionStartDate(session);
    if (!scheduledStartTime || scheduledStartTime.getTime() < futureSessionStartCutoff().getTime()) continue;
    const liveSubject = wiseSessionSubject(session);
    const wiseSessionId = session._id || null;
    const wiseClassId = getWiseSessionClassId(session) ?? null;

    if (!wiseSessionId) {
      rows.push({
        wiseClassId,
        wiseSessionId,
        courseActionId: null,
        scheduledStartTime: scheduledStartTime.toISOString(),
        currentSubjectAtAudit: null,
        expectedTargetSubject: null,
        liveSubject,
        currentNormalizedCourseKey: normalizePayrollRateCourse(liveSubject),
        targetNormalizedCourseKey: null,
        payrollCourseKeyMatches: false,
        status: "missing_session_id",
        detail: "Wise future session did not include a session id",
      });
      continue;
    }

    seenSessionIds.add(wiseSessionId);
    if (!wiseClassId) {
      const liveKey = normalizePayrollRateCourse(liveSubject);
      if (liveKey && (SOURCE_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS.has(liveKey) || PROMOTED_SCHOOL_CURRICULUM_PAYROLL_COURSE_KEYS.has(liveKey))) {
        rows.push({
          wiseClassId,
          wiseSessionId,
          courseActionId: null,
          scheduledStartTime: scheduledStartTime.toISOString(),
          currentSubjectAtAudit: null,
          expectedTargetSubject: null,
          liveSubject,
          currentNormalizedCourseKey: liveKey,
          targetNormalizedCourseKey: null,
          payrollCourseKeyMatches: false,
          status: "missing_class_id",
          detail: "Wise future session did not include a class id",
        });
      }
      continue;
    }

    const courseAction = courseActionByClass.get(wiseClassId);
    if (!courseAction || !courseAction.targetSubject) continue;
    const classification = classifyFutureSessionAction({ courseAction, currentSubject: liveSubject });
    const targetKey = classification.targetNormalizedCourseKey;
    const currentKey = classification.currentNormalizedCourseKey;
    const payrollCourseKeyMatches = Boolean(currentKey && targetKey && currentKey === targetKey);
    const persisted = futureActionBySession.get(wiseSessionId);
    const failedWrite = persisted?.status === "failed";
    const status: FutureSessionReadbackStatus = failedWrite
      ? "failed"
      : classification.status === "applied"
        ? "target_matched"
        : classification.status === "pending"
          ? gateEnabled ? "pending_update" : "manual_required"
          : "subject_drift";

    rows.push({
      wiseClassId,
      wiseSessionId,
      courseActionId: courseAction.id,
      scheduledStartTime: scheduledStartTime.toISOString(),
      currentSubjectAtAudit: courseAction.currentSubject,
      expectedTargetSubject: courseAction.targetSubject,
      liveSubject,
      currentNormalizedCourseKey: currentKey ?? null,
      targetNormalizedCourseKey: targetKey ?? null,
      payrollCourseKeyMatches,
      status,
      detail: failedWrite
        ? persisted?.errorMessage ?? "Previous session subject write failed"
        : classification.errorMessage ?? null,
    });
  }

  for (const action of detail.futureSessionActions) {
    if (seenSessionIds.has(action.wiseSessionId)) continue;
    rows.push({
      wiseClassId: action.wiseClassId,
      wiseSessionId: action.wiseSessionId,
      courseActionId: action.courseActionId,
      scheduledStartTime: action.scheduledStartTime.toISOString(),
      currentSubjectAtAudit: null,
      expectedTargetSubject: action.targetSubject,
      liveSubject: action.currentSubject,
      currentNormalizedCourseKey: action.currentNormalizedCourseKey,
      targetNormalizedCourseKey: action.targetNormalizedCourseKey,
      payrollCourseKeyMatches: false,
      status: "failed",
      detail: action.errorMessage ?? "Previously audited future session was not returned by live Wise FUTURE sessions",
    });
  }

  return rows.sort((left, right) => String(left.scheduledStartTime ?? "").localeCompare(String(right.scheduledStartTime ?? "")));
}

async function fetchRegistrationStates(
  client: WiseClient,
  instituteId: string,
  students: WisePromotionStudent[],
): Promise<StudentRegistrationState[]> {
  const gate = createRateGate(WISE_REQUEST_MIN_INTERVAL_MS);

  return mapLimit(students, REGISTRATION_FETCH_CONCURRENCY, async (student) => {
    await gate();
    const registration = await fetchWiseStudentRegistrationData(client, instituteId, student._id);
    const fields = registration.registrationData?.fields ?? [];
    return {
      wiseStudentId: student._id,
      gradeRaw: registrationGradeAnswer(fields),
      fields,
    };
  });
}

async function fetchReadbackRegistrationRows(
  client: WiseClient,
  instituteId: string,
  students: WisePromotionStudent[],
): Promise<Array<{ wiseStudentId: string; gradeRaw: string; errorMessage?: string | null }>> {
  const gate = createRateGate(WISE_REQUEST_MIN_INTERVAL_MS);

  return mapLimit(students, REGISTRATION_FETCH_CONCURRENCY, async (student) => {
    try {
      await gate();
      const registration = await fetchWiseStudentRegistrationData(client, instituteId, student._id);
      return {
        wiseStudentId: student._id,
        gradeRaw: registrationGradeAnswer(registration.registrationData?.fields ?? []),
        errorMessage: null,
      };
    } catch (error) {
      return {
        wiseStudentId: student._id,
        gradeRaw: "",
        errorMessage: error instanceof Error ? error.message : "Registration fetch failed",
      };
    }
  });
}

async function fetchCourseReadbackRows(
  client: WiseClient,
  courseActions: StudentPromotionCourseActionRow[],
): Promise<StudentPromotionCourseReadbackRow[]> {
  const gate = createRateGate(WISE_REQUEST_MIN_INTERVAL_MS);

  return mapLimit(courseActions, REGISTRATION_FETCH_CONCURRENCY, async (action) => {
    if (!action.targetSubject) {
      return classifyCourseReadback(action, {});
    }

    try {
      await gate();
      const course = await fetchWiseCourse(client, action.wiseClassId);
      await gate();
      const participants = await fetchWiseCourseParticipants(client, action.wiseClassId);
      return classifyCourseReadback(action, {
        liveSubject: course?.subject?.trim() ?? "",
        liveStudentIds: studentIdsFromParticipants(participants as unknown[]),
      });
    } catch (error) {
      return classifyCourseReadback(action, {
        errorMessage: error instanceof Error ? error.message : "Course readback failed",
      });
    }
  });
}

async function refreshStudentPromotionFutureSessionActions(input: {
  db: Database;
  detail: StudentPromotionRunDetail;
  client: WiseClient;
  instituteId: string;
  liveSessions?: WiseSession[];
}): Promise<StudentPromotionFutureSessionActionRow[]> {
  const liveSessions = input.liveSessions ?? await fetchAllFutureSessions(input.client, input.instituteId);
  const rows = buildStudentPromotionFutureSessionActionRows(input.detail, liveSessions);
  const now = new Date();
  const seenSessionIds = sortedUnique(rows.map((row) => row.wiseSessionId));
  const hasEligibleCourseAction = input.detail.courseActions.some(studentPromotionFutureSessionCourseActionEligible);

  if (rows.length > 0) {
    await upsertFutureSessionActionChunks(input.db, rows);
  }

  if (seenSessionIds.length > 0) {
    await input.db
      .update(schema.studentPromotionFutureSessionActions)
      .set({
        status: "failed",
        errorMessage: "Previously audited future session was not returned by live Wise FUTURE sessions",
        updatedAt: now,
      })
      .where(and(
        eq(schema.studentPromotionFutureSessionActions.runId, input.detail.run.id),
        notInArray(schema.studentPromotionFutureSessionActions.wiseSessionId, seenSessionIds),
      ));
  } else if (hasEligibleCourseAction) {
    await input.db
      .update(schema.studentPromotionFutureSessionActions)
      .set({
        status: "failed",
        errorMessage: "No matching live Wise FUTURE sessions were returned during refresh",
        updatedAt: now,
      })
      .where(eq(schema.studentPromotionFutureSessionActions.runId, input.detail.run.id));
  }

  return input.db
    .select()
    .from(schema.studentPromotionFutureSessionActions)
    .where(eq(schema.studentPromotionFutureSessionActions.runId, input.detail.run.id));
}

async function loadActivePayrollRateCard(input: { db: Database }): Promise<ActiveRateCardInput> {
  const [version] = await input.db
    .select()
    .from(schema.payrollRateCardVersions)
    .where(eq(schema.payrollRateCardVersions.active, true))
    .orderBy(desc(schema.payrollRateCardVersions.createdAt))
    .limit(1);

  if (!version) return { hasActiveRateCard: false, rules: [] };

  const rules = await input.db
    .select()
    .from(schema.payrollRateRules)
    .where(eq(schema.payrollRateRules.versionId, version.id));

  return { hasActiveRateCard: true, rules };
}

async function insertPayRateImpactChunks(
  db: Database,
  rows: PayRateImpactInsert[],
) {
  for (let index = 0; index < rows.length; index += 250) {
    const chunk = rows.slice(index, index + 250);
    if (chunk.length) await db.insert(schema.studentPromotionPayRateImpacts).values(chunk);
  }
}

function preservePayRateImpactReview(
  row: PayRateImpactInsert,
  existing: StudentPromotionPayRateImpactRow | undefined,
): PayRateImpactInsert {
  if (!existing || row.blockerReason) return row;
  const comparable = {
    id: existing.id,
    createdAt: existing.createdAt,
    ...row,
  } as StudentPromotionPayRateImpactRow;
  if (payRateImpactMaterialKey(existing) !== payRateImpactMaterialKey(comparable)) return row;
  if (existing.reviewStatus !== "verified_correct" && existing.reviewStatus !== "incorrect") return row;
  return {
    ...row,
    reviewStatus: existing.reviewStatus,
    reviewedByEmail: existing.reviewedByEmail,
    reviewedByName: existing.reviewedByName,
    reviewedAt: existing.reviewedAt,
    reviewNote: existing.reviewNote,
  };
}

async function refreshStudentPromotionPayRateImpacts(input: {
  db: Database;
  detail: StudentPromotionRunDetail;
  client: WiseClient;
  instituteId: string;
  liveSessions?: WiseSession[];
  teachers?: WiseTeacher[];
}): Promise<StudentPromotionPayRateImpactRow[]> {
  const [liveSessions, teachers, activeRateCard, existingRows] = await Promise.all([
    input.liveSessions ? Promise.resolve(input.liveSessions) : fetchAllFutureSessions(input.client, input.instituteId),
    input.teachers ? Promise.resolve(input.teachers) : fetchAllTeachers(input.client, input.instituteId),
    loadActivePayrollRateCard({ db: input.db }),
    input.db
      .select()
      .from(schema.studentPromotionPayRateImpacts)
      .where(eq(schema.studentPromotionPayRateImpacts.runId, input.detail.run.id)),
  ]);
  const existingByKey = new Map(existingRows.map((row) => [row.impactKey, row]));
  const rows = buildStudentPromotionPayRateImpactRows({
    detail: input.detail,
    liveSessions,
    teachers,
    activeRateCard,
  }).map((row) => preservePayRateImpactReview(row, existingByKey.get(row.impactKey)));

  await input.db
    .delete(schema.studentPromotionPayRateImpacts)
    .where(eq(schema.studentPromotionPayRateImpacts.runId, input.detail.run.id));
  await insertPayRateImpactChunks(input.db, rows);

  return input.db
    .select()
    .from(schema.studentPromotionPayRateImpacts)
    .where(eq(schema.studentPromotionPayRateImpacts.runId, input.detail.run.id));
}

async function refreshGraduationCourseActions(
  db: Database,
  detail: StudentPromotionRunDetail,
): Promise<void> {
  const dispositionByStudent = new Map(
    detail.graduationActions.map((row) => [row.wiseStudentId, row.disposition]),
  );
  const now = new Date();

  await Promise.all(detail.courseActions
    .filter((action) => action.transitionType === "year13_to_university")
    .map(async (action) => {
      let status: "pending" | "skipped" | "applied" | "failed" = action.status;
      let skipReason: string | null = action.skipReason;
      let errorMessage = action.errorMessage;

      const dispositions = action.qualifyingStudentIds.map((studentId) => dispositionByStudent.get(studentId) ?? null);
      const hasPendingDisposition = dispositions.some((disposition) => !disposition);
      const allUniversity = dispositions.length > 0 && dispositions.every((disposition) => disposition === "university");
      const allInactive = dispositions.length > 0 && dispositions.every((disposition) => disposition === "inactive");

      if (!action.targetSubject) {
        status = "skipped";
        skipReason = "unmapped_target_subject";
      } else if (action.qualifyingStudentIds.length === 0 || action.qualifyingStudentIds.length !== action.studentIds.length) {
        status = "skipped";
        skipReason = "mixed_class_roster";
      } else if (hasPendingDisposition) {
        status = "skipped";
        skipReason = "graduation_disposition_pending";
      } else if (allUniversity) {
        status = action.status === "applied" ? "applied" : "pending";
        skipReason = null;
        errorMessage = null;
      } else if (allInactive) {
        status = "skipped";
        skipReason = "graduation_inactive";
      } else {
        status = "skipped";
        skipReason = "graduation_mixed_disposition";
      }

      await db
        .update(schema.studentPromotionCourseActions)
        .set({ status, skipReason, errorMessage, updatedAt: now })
        .where(eq(schema.studentPromotionCourseActions.id, action.id));
    }));
}

export async function createStudentPromotionDryRun(input: DryRunInput): Promise<StudentPromotionRunDetail> {
  const db = input.db ?? getDb();
  const client = input.client ?? createPromotionWiseClient();
  const instituteId = instituteIdFromEnv();
  const targetDate = input.targetDate ?? STUDENT_PROMOTION_TARGET_DATE;

  const [{ snapshot, students: snapshotStudents, packages }, wiseStudents] = await Promise.all([
    loadActiveCreditControlSnapshot(db),
    fetchWiseAcceptedStudents(client, instituteId),
  ]);

  const registrationStates = await fetchRegistrationStates(client, instituteId, wiseStudents);
  const snapshotStudentById = new Map(snapshotStudents.map((student) => [student.wiseStudentId, student]));
  const subjectsByStudent = activeCourseSubjectsByStudent(packages);
  const registrationByStudent = new Map(registrationStates.map((state) => [state.wiseStudentId, state]));
  const currentYearByStudent = new Map<string, number | null>();

  const [run] = await db
    .insert(schema.studentPromotionRuns)
    .values({
      targetDate,
      status: "draft",
      sourceSnapshotId: snapshot.id,
      wiseAcceptedStudentCount: wiseStudents.length,
      websiteSnapshotStudentCount: snapshotStudents.length,
      createdByEmail: input.actor.email,
      createdByName: input.actor.name,
      metadata: {
        gradeRegistrationFieldId: WISE_GRADE_REGISTRATION_FIELD_ID,
        gradeRegistrationFieldLabel: WISE_GRADE_REGISTRATION_FIELD_LABEL,
        sourceSnapshotGeneratedAt: snapshot.generatedAt.toISOString(),
      },
    })
    .returning();

  const gradeRows: Array<typeof schema.studentPromotionGradeActions.$inferInsert> = [];
  const graduationRows: Array<typeof schema.studentPromotionGraduationActions.$inferInsert> = [];
  let gradeOnlyCount = 0;
  let year8CourseMoveCount = 0;
  let year11CourseMoveCount = 0;
  let skippedGradeCount = 0;

  for (const wiseStudent of wiseStudents) {
    const registration = registrationByStudent.get(wiseStudent._id);
    const parsed = parseWiseGrade(registration?.gradeRaw);
    currentYearByStudent.set(wiseStudent._id, parsed.currentYear);
    const subjects = subjectsByStudent.get(wiseStudent._id) ?? [];
    const fallback = snapshotStudentById.get(wiseStudent._id);
    const isGraduatingYear13 = parsed.currentYear === 13;
    const actionType = parsed.currentYear === null
      ? parsed.kind === "blank" ? "missing_grade_review" : "unparsed_grade_review"
      : gradeActionTypeFor(parsed.currentYear, subjects);
    const status = parsed.currentYear === null || isGraduatingYear13 ? "skipped" : "pending";
    const targetGrade = parsed.currentYear === null || isGraduatingYear13 ? null : formatPromotedGrade(parsed.currentYear);

    if (status === "skipped") {
      skippedGradeCount += 1;
    } else if (actionType === "year8_course_and_grade") {
      year8CourseMoveCount += 1;
    } else if (actionType === "year11_course_and_grade") {
      year11CourseMoveCount += 1;
    } else {
      gradeOnlyCount += 1;
    }

    gradeRows.push({
      runId: run.id,
      wiseStudentId: wiseStudent._id,
      studentName: studentDisplayName(wiseStudent, fallback),
      studentKey: fallback?.studentKey ?? "",
      currentGradeRaw: parsed.raw,
      parsedCurrentYear: parsed.currentYear,
      targetGrade,
      actionType,
      status,
      skipReason: status === "skipped" ? actionType : null,
    });

    if (isGraduatingYear13) {
      graduationRows.push({
        runId: run.id,
        wiseStudentId: wiseStudent._id,
        studentName: studentDisplayName(wiseStudent, fallback),
        parentName: fallback?.parentName ?? "",
        studentKey: fallback?.studentKey ?? "",
        currentGradeRaw: parsed.raw,
        status: "pending_review",
      });
    }
  }

  const courseRows = buildCourseActions(run.id, packages, currentYearByStudent);
  const pendingCourseActionCount = courseRows.filter((row) => row.status === "pending").length;
  const skippedCourseActionCount = courseRows.filter((row) => row.status === "skipped").length;

  await insertGradeActionChunks(db, gradeRows);
  await insertCourseActionChunks(db, courseRows);
  await insertGraduationActionChunks(db, graduationRows);
  await db
    .update(schema.studentPromotionRuns)
    .set({
      gradeOnlyCount,
      year8CourseMoveCount,
      year11CourseMoveCount,
      skippedGradeCount,
      pendingCourseActionCount,
      skippedCourseActionCount,
      updatedAt: new Date(),
    })
    .where(eq(schema.studentPromotionRuns.id, run.id));

  const liveSessions = await fetchAllFutureSessions(client, instituteId);
  await refreshStudentPromotionFutureSessionActions({
    db,
    detail: await getStudentPromotionRunDetail(run.id, db),
    client,
    instituteId,
    liveSessions,
  });
  await refreshStudentPromotionPayRateImpacts({
    db,
    detail: await getStudentPromotionRunDetail(run.id, db),
    client,
    instituteId,
    liveSessions,
  });

  return getStudentPromotionRunDetail(run.id, db);
}

export async function getStudentPromotionRunDetail(runId: string, db: Database = getDb()): Promise<StudentPromotionRunDetail> {
  const [run] = await db
    .select()
    .from(schema.studentPromotionRuns)
    .where(eq(schema.studentPromotionRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Student promotion run not found");

  const [
    gradeActions,
    courseActions,
    futureSessionActions,
    graduationActions,
    payRateImpacts,
    sourceSnapshot,
    activeSnapshot,
  ] = await Promise.all([
    db
      .select()
      .from(schema.studentPromotionGradeActions)
      .where(eq(schema.studentPromotionGradeActions.runId, runId)),
    db
      .select()
      .from(schema.studentPromotionCourseActions)
      .where(eq(schema.studentPromotionCourseActions.runId, runId)),
    db
      .select()
      .from(schema.studentPromotionFutureSessionActions)
      .where(eq(schema.studentPromotionFutureSessionActions.runId, runId)),
    db
      .select()
      .from(schema.studentPromotionGraduationActions)
      .where(eq(schema.studentPromotionGraduationActions.runId, runId)),
    db
      .select()
      .from(schema.studentPromotionPayRateImpacts)
      .where(eq(schema.studentPromotionPayRateImpacts.runId, runId)),
    loadCreditControlSnapshotSummary(db, run.sourceSnapshotId),
    loadActiveCreditControlSnapshotSummary(db),
  ]);
  const freshness = buildStudentPromotionFreshness({
    runCreatedAt: run.createdAt,
    sourceSnapshotId: run.sourceSnapshotId,
    sourceSnapshotGeneratedAt: sourceSnapshot?.generatedAt ?? null,
    sourceSnapshotStudentCount: sourceSnapshot?.studentCount ?? run.websiteSnapshotStudentCount,
    activeSnapshotId: activeSnapshot?.id ?? null,
    activeSnapshotGeneratedAt: activeSnapshot?.generatedAt ?? null,
    activeSnapshotStudentCount: activeSnapshot?.studentCount ?? 0,
  });

  return {
    run,
    gradeActions,
    courseActions,
    futureSessionActions,
    graduationActions,
    payRateImpacts,
    freshness,
    summary: {
      pendingGradeActions: gradeActions.filter((row) => row.status === "pending").length,
      skippedGradeActions: gradeActions.filter((row) => row.status === "skipped").length,
      appliedGradeActions: gradeActions.filter((row) => row.status === "applied").length,
      failedGradeActions: gradeActions.filter((row) => row.status === "failed").length,
      pendingCourseActions: courseActions.filter((row) => row.status === "pending").length,
      skippedCourseActions: courseActions.filter((row) => row.status === "skipped").length,
      appliedCourseActions: courseActions.filter((row) => row.status === "applied").length,
      failedCourseActions: courseActions.filter((row) => row.status === "failed").length,
      pendingFutureSessionActions: futureSessionActions.filter((row) => row.status === "pending").length,
      skippedFutureSessionActions: futureSessionActions.filter((row) => row.status === "skipped").length,
      appliedFutureSessionActions: futureSessionActions.filter((row) => row.status === "applied").length,
      failedFutureSessionActions: futureSessionActions.filter((row) => row.status === "failed").length,
      pendingGraduationActions: graduationActions.filter((row) => !row.disposition || row.status === "pending_review").length,
      inactiveGraduationActions: graduationActions.filter((row) => row.disposition === "inactive").length,
      universityGraduationActions: graduationActions.filter((row) => row.disposition === "university").length,
      appliedGraduationActions: graduationActions.filter((row) => row.status === "applied").length,
      failedGraduationActions: graduationActions.filter((row) => row.status === "failed").length,
      pendingPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "pending_review").length,
      verifiedPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "verified_correct").length,
      incorrectPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "incorrect").length,
      blockedPayRateImpacts: payRateImpacts.filter((row) => row.reviewStatus === "blocked" || row.blockerReason).length,
    },
  };
}

export async function getLatestStudentPromotionRunDetail(db: Database = getDb()): Promise<StudentPromotionRunDetail | null> {
  const [run] = await db
    .select({ id: schema.studentPromotionRuns.id })
    .from(schema.studentPromotionRuns)
    .where(eq(schema.studentPromotionRuns.targetDate, STUDENT_PROMOTION_TARGET_DATE))
    .orderBy(desc(schema.studentPromotionRuns.createdAt))
    .limit(1);
  return run ? getStudentPromotionRunDetail(run.id, db) : null;
}

export async function verifyStudentPromotionRun(input: VerifyRunInput): Promise<StudentPromotionRunDetail> {
  const db = input.db ?? getDb();
  const detail = await getStudentPromotionRunDetail(input.runId, db);
  if (detail.run.status !== "draft") {
    throw new Error("Only draft promotion runs can be verified");
  }
  assertStudentPromotionRunFresh(detail, "verify");
  assertGraduationAndPayRateReviewComplete(detail);
  const selectedGraduationActions = detail.graduationActions.filter((row) => row.disposition).length;
  if (
    detail.summary.pendingGradeActions === 0
    && detail.summary.pendingCourseActions === 0
    && selectedGraduationActions === 0
  ) {
    throw new Error("Promotion run has no pending actions to verify");
  }
  const note = input.endpointVerificationNote.trim();
  if (!note) throw new Error("Endpoint verification note is required");

  await db
    .update(schema.studentPromotionRuns)
    .set({
      status: "verified",
      verifiedAt: new Date(),
      verifiedByEmail: input.actor.email,
      verifiedByName: input.actor.name,
      endpointVerificationNote: note,
      updatedAt: new Date(),
    })
    .where(eq(schema.studentPromotionRuns.id, input.runId));

  return getStudentPromotionRunDetail(input.runId, db);
}

export async function updateStudentPromotionGraduationDisposition(
  input: UpdateGraduationDispositionInput,
): Promise<StudentPromotionRunDetail> {
  const db = input.db ?? getDb();
  if (input.disposition !== "inactive" && input.disposition !== "university") {
    throw new Error("Graduation disposition must be inactive or university");
  }

  const detail = await getStudentPromotionRunDetail(input.runId, db);
  if (detail.run.status !== "draft") {
    throw new Error("Graduation dispositions can only be changed on draft promotion runs");
  }
  const action = detail.graduationActions.find((row) => row.id === input.actionId);
  if (!action) throw new Error("Graduation action not found");

  const now = new Date();
  await db
    .update(schema.studentPromotionGraduationActions)
    .set({
      disposition: input.disposition,
      status: "selected",
      reviewedByEmail: input.actor.email,
      reviewedByName: input.actor.name,
      reviewedAt: now,
      errorMessage: null,
      updatedAt: now,
    })
    .where(and(
      eq(schema.studentPromotionGraduationActions.id, input.actionId),
      eq(schema.studentPromotionGraduationActions.runId, input.runId),
    ));

  await refreshGraduationCourseActions(db, await getStudentPromotionRunDetail(input.runId, db));
  const client = input.client ?? createPromotionWiseClient();
  const instituteId = instituteIdFromEnv();
  const liveSessions = await fetchAllFutureSessions(client, instituteId);
  await refreshStudentPromotionFutureSessionActions({
    db,
    detail: await getStudentPromotionRunDetail(input.runId, db),
    client,
    instituteId,
    liveSessions,
  });
  await refreshStudentPromotionPayRateImpacts({
    db,
    detail: await getStudentPromotionRunDetail(input.runId, db),
    client,
    instituteId,
    liveSessions,
  });

  return getStudentPromotionRunDetail(input.runId, db);
}

export async function reviewStudentPromotionPayRateImpact(
  input: ReviewPayRateImpactInput,
): Promise<StudentPromotionRunDetail> {
  const db = input.db ?? getDb();
  if (input.status !== "verified_correct" && input.status !== "incorrect") {
    throw new Error("Pay-rate review status must be verified_correct or incorrect");
  }

  const detail = await getStudentPromotionRunDetail(input.runId, db);
  if (detail.run.status !== "draft") {
    throw new Error("Pay-rate impacts can only be reviewed on draft promotion runs");
  }
  const impact = detail.payRateImpacts.find((row) => row.id === input.impactId);
  if (!impact) throw new Error("Pay-rate impact row not found");
  if (input.status === "verified_correct" && (impact.reviewStatus === "blocked" || impact.blockerReason)) {
    throw new Error("Blocked pay-rate impacts cannot be verified correct until tier/rate-card data is fixed and the audit is rerun");
  }

  const now = new Date();
  await db
    .update(schema.studentPromotionPayRateImpacts)
    .set({
      reviewStatus: input.status,
      reviewedByEmail: input.actor.email,
      reviewedByName: input.actor.name,
      reviewedAt: now,
      reviewNote: input.note?.trim() || null,
      updatedAt: now,
    })
    .where(and(
      eq(schema.studentPromotionPayRateImpacts.id, input.impactId),
      eq(schema.studentPromotionPayRateImpacts.runId, input.runId),
    ));

  return getStudentPromotionRunDetail(input.runId, db);
}

function promotionApplyWindowOpen(now: Date): boolean {
  return now.getTime() >= new Date(STUDENT_PROMOTION_CRON_READY_AT_UTC).getTime();
}

function participantWiseStudentId(row: Record<string, unknown>): string | null {
  if (typeof row._id === "string" && row._id) return row._id;
  if (typeof row.userId === "string" && row.userId) return row.userId;
  if (row.userId && typeof row.userId === "object" && "_id" in row.userId) {
    const id = (row.userId as { _id?: unknown })._id;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

function studentIdsFromParticipants(participants: unknown[]): string[] {
  return sortedUnique(participants.flatMap((participant) => {
    if (!participant || typeof participant !== "object") return [];
    const row = participant as Record<string, unknown>;
    const profile = String(row.profile ?? "").toLowerCase();
    if (profile && profile !== "student") return [];
    const id = participantWiseStudentId(row);
    return id ? [id] : [];
  }));
}

async function applyGradeAction(
  db: Database,
  client: WiseClient,
  instituteId: string,
  action: StudentPromotionGradeActionRow,
  gate: () => Promise<void>,
): Promise<"applied" | "failed" | "skipped"> {
  if (!action.targetGrade || action.parsedCurrentYear === null) return "skipped";
  try {
    await gate();
    const registration = await fetchWiseStudentRegistrationData(client, instituteId, action.wiseStudentId);
    const currentRaw = registrationGradeAnswer(registration.registrationData?.fields ?? []);
    const now = new Date();
    const decision = classifyGradeApplyDecision(action, currentRaw);

    if (decision.kind === "skipped") return "skipped";

    if (decision.kind === "already_target") {
      await db
        .update(schema.studentPromotionGradeActions)
        .set({ status: "applied", appliedAt: now, updatedAt: now, responsePayload: { idempotent: true } })
        .where(eq(schema.studentPromotionGradeActions.id, action.id));
      return "applied";
    }

    if (decision.kind === "grade_drift") {
      await db
        .update(schema.studentPromotionGradeActions)
        .set({
          status: "skipped",
          skipReason: "grade_drift",
          errorMessage: decision.message,
          updatedAt: now,
        })
        .where(eq(schema.studentPromotionGradeActions.id, action.id));
      return "skipped";
    }

    const requestPayload = {
      answers: [{ questionId: WISE_GRADE_REGISTRATION_FIELD_ID, answer: action.targetGrade }],
    };
    await gate();
    const response = await updateWiseStudentRegistrationAnswers(
      client,
      instituteId,
      action.wiseStudentId,
      requestPayload.answers,
    );
    await db
      .update(schema.studentPromotionGradeActions)
      .set({
        status: "applied",
        requestPayload,
        responsePayload: response as Record<string, unknown>,
        appliedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.studentPromotionGradeActions.id, action.id));
    return "applied";
  } catch (error) {
    await db
      .update(schema.studentPromotionGradeActions)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Grade update failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.studentPromotionGradeActions.id, action.id));
    return "failed";
  }
}

async function applyCourseAction(
  db: Database,
  client: WiseClient,
  action: StudentPromotionCourseActionRow,
  gate: () => Promise<void>,
): Promise<"applied" | "failed" | "skipped"> {
  if (!action.targetSubject) return "skipped";
  try {
    await gate();
    const course = await fetchWiseCourse(client, action.wiseClassId);
    const currentSubject = course?.subject?.trim() ?? "";
    const now = new Date();

    if (currentSubject === action.targetSubject) {
      await db
        .update(schema.studentPromotionCourseActions)
        .set({ status: "applied", appliedAt: now, updatedAt: now, responsePayload: { idempotent: true } })
        .where(eq(schema.studentPromotionCourseActions.id, action.id));
      return "applied";
    }

    if (currentSubject !== action.currentSubject) {
      await db
        .update(schema.studentPromotionCourseActions)
        .set({
          status: "skipped",
          skipReason: "course_subject_drift",
          errorMessage: `Current subject changed from ${action.currentSubject} to ${currentSubject || "(blank)"}`,
          updatedAt: now,
        })
        .where(eq(schema.studentPromotionCourseActions.id, action.id));
      return "skipped";
    }

    await gate();
    const participants = await fetchWiseCourseParticipants(client, action.wiseClassId);
    const liveStudentIds = studentIdsFromParticipants(participants as unknown[]);
    if (liveStudentIds.length === 0 || !sameStringSet(liveStudentIds, action.studentIds)) {
      await db
        .update(schema.studentPromotionCourseActions)
        .set({
          status: "skipped",
          skipReason: "course_roster_drift",
          errorMessage: liveStudentIds.length === 0
            ? "Unable to verify live Wise course roster"
            : "Live Wise course roster differs from verified run",
          updatedAt: now,
        })
        .where(eq(schema.studentPromotionCourseActions.id, action.id));
      return "skipped";
    }

    const requestPayload = { classId: action.wiseClassId, subject: action.targetSubject };
    await gate();
    const response = await updateWiseCourseSubject(client, action.wiseClassId, action.targetSubject);
    await db
      .update(schema.studentPromotionCourseActions)
      .set({
        status: "applied",
        requestPayload,
        responsePayload: response as Record<string, unknown>,
        appliedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.studentPromotionCourseActions.id, action.id));
    return "applied";
  } catch (error) {
    await db
      .update(schema.studentPromotionCourseActions)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Course update failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.studentPromotionCourseActions.id, action.id));
    return "failed";
  }
}

async function applyGraduationAction(
  db: Database,
  action: StudentPromotionGraduationActionRow,
  actor: StudentPromotionActor | undefined,
  trigger: "cron" | "admin",
): Promise<"applied" | "failed" | "skipped"> {
  if (!action.disposition) return "skipped";

  try {
    const now = new Date();
    if (action.disposition === "inactive") {
      if (!action.studentKey) {
        throw new Error("Cannot mark graduate inactive because the Credit Control student key is missing");
      }
      await markCreditInactive({
        studentKey: action.studentKey,
        studentName: action.studentName,
        parentName: action.parentName,
        markedByEmail: actor?.email ?? trigger,
        source: "student-promotion-graduation",
        removedAtRemaining: null,
      }, db);
    }

    await db
      .update(schema.studentPromotionGraduationActions)
      .set({
        status: "applied",
        appliedAt: now,
        updatedAt: now,
        errorMessage: null,
      })
      .where(eq(schema.studentPromotionGraduationActions.id, action.id));
    return "applied";
  } catch (error) {
    await db
      .update(schema.studentPromotionGraduationActions)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Graduation action failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.studentPromotionGraduationActions.id, action.id));
    return "failed";
  }
}

export async function applyVerifiedStudentPromotionRun(input: ApplyRunInput): Promise<StudentPromotionRunDetail> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  if (!input.allowBeforeTarget && !promotionApplyWindowOpen(now)) {
    throw new Error("Student promotions cannot be applied before July 1, 2026 Bangkok time");
  }

  const runId = input.runId ?? (await latestVerifiedRunId(db));
  const detail = await getStudentPromotionRunDetail(runId, db);

  if (detail.run.status === "applied" || detail.run.status === "applied_with_errors") {
    return detail;
  }
  if (detail.run.status !== "verified") {
    throw new Error("Only verified student promotion runs can be applied");
  }

  assertStudentPromotionRunFresh(detail, "apply");

  const client = input.client ?? createPromotionWiseClient();
  const instituteId = instituteIdFromEnv();
  const liveStudents = await fetchWiseAcceptedStudents(client, instituteId);
  assertRunCoversLiveAcceptedStudents(detail, liveStudents);

  await db
    .update(schema.studentPromotionRuns)
    .set({
      status: "applying",
      applyStartedAt: now,
      appliedByEmail: input.actor?.email ?? input.trigger,
      appliedByName: input.actor?.name ?? input.trigger,
      updatedAt: now,
    })
    .where(eq(schema.studentPromotionRuns.id, runId));

  const gate = createRateGate(WISE_REQUEST_MIN_INTERVAL_MS);
  const pendingGradeActions = detail.gradeActions.filter((row) => row.status === "pending");
  const pendingCourseActions = detail.courseActions.filter((row) => row.status === "pending");
  const selectedGraduationActions = detail.graduationActions.filter((row) => row.status === "selected" && row.disposition);

  const gradeResults = await mapLimit(
    pendingGradeActions,
    WISE_WRITE_CONCURRENCY,
    (action) => applyGradeAction(db, client, instituteId, action, gate),
  );
  const courseResults = await mapLimit(
    pendingCourseActions,
    WISE_WRITE_CONCURRENCY,
    (action) => applyCourseAction(db, client, action, gate),
  );
  const graduationResults = await mapLimit(
    selectedGraduationActions,
    WISE_WRITE_CONCURRENCY,
    (action) => applyGraduationAction(db, action, input.actor, input.trigger),
  );
  const failures = [...gradeResults, ...courseResults, ...graduationResults].filter((result) => result === "failed").length;
  const driftSkips = [...gradeResults, ...courseResults, ...graduationResults].filter((result) => result === "skipped").length;
  const terminalStatus = failures > 0 || driftSkips > 0 ? "applied_with_errors" : "applied";

  await db
    .update(schema.studentPromotionRuns)
    .set({
      status: terminalStatus,
      applyFinishedAt: new Date(),
      errorSummary: terminalStatus === "applied"
        ? null
        : `${failures} failed actions; ${driftSkips} skipped actions during apply`,
      updatedAt: new Date(),
    })
    .where(eq(schema.studentPromotionRuns.id, runId));

  await refreshStudentPromotionFutureSessionActions({
    db,
    detail: await getStudentPromotionRunDetail(runId, db),
    client,
    instituteId,
  });

  return getStudentPromotionRunDetail(runId, db);
}

async function applyFutureSessionAction(
  db: Database,
  client: WiseClient,
  action: StudentPromotionFutureSessionActionRow,
  gate: () => Promise<void>,
): Promise<"applied" | "failed" | "skipped"> {
  if (action.status !== "pending") return "skipped";
  try {
    const requestPayload = {
      classId: action.wiseClassId,
      sessionId: action.wiseSessionId,
      updateType: "SINGLE",
      subject: action.targetSubject,
    };
    await gate();
    const response = await updateSessionSubject(client, action.wiseClassId, action.wiseSessionId, action.targetSubject);
    const now = new Date();
    await db
      .update(schema.studentPromotionFutureSessionActions)
      .set({
        status: "applied",
        requestPayload,
        responsePayload: response as Record<string, unknown>,
        appliedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.studentPromotionFutureSessionActions.id, action.id));
    return "applied";
  } catch (error) {
    await db
      .update(schema.studentPromotionFutureSessionActions)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Future session subject update failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.studentPromotionFutureSessionActions.id, action.id));
    return "failed";
  }
}

export async function applyStudentPromotionFutureSessionActions(
  input: ApplyFutureSessionsInput,
): Promise<StudentPromotionRunDetail> {
  if (!futureSessionSubjectUpdateGateEnabled()) {
    throw new Error(`${WISE_SESSION_SUBJECT_UPDATE_VERIFIED_ENV}=true is required before Wise session subject writes`);
  }

  const db = input.db ?? getDb();
  const detail = await getStudentPromotionRunDetail(input.runId, db);
  if (detail.run.status !== "applied" && detail.run.status !== "applied_with_errors") {
    throw new Error("Future session subject updates require the verified student promotion run to be applied first");
  }

  const client = input.client ?? createPromotionWiseClient();
  const instituteId = instituteIdFromEnv();
  const liveSessions = await fetchAllFutureSessions(client, instituteId);
  const futureSessionActions = await refreshStudentPromotionFutureSessionActions({
    db,
    detail,
    client,
    instituteId,
    liveSessions,
  });
  const pendingActions = futureSessionActions.filter((action) => action.status === "pending");
  const gate = createRateGate(WISE_REQUEST_MIN_INTERVAL_MS);
  await mapLimit(
    pendingActions,
    WISE_WRITE_CONCURRENCY,
    (action) => applyFutureSessionAction(db, client, action, gate),
  );

  await db
    .update(schema.studentPromotionRuns)
    .set({
      metadata: {
        ...detail.run.metadata,
        lastFutureSessionSubjectApply: {
          appliedByEmail: input.actor.email,
          appliedByName: input.actor.name,
          attemptedAt: new Date().toISOString(),
          pendingActionCount: pendingActions.length,
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(schema.studentPromotionRuns.id, input.runId));

  return getStudentPromotionRunDetail(input.runId, db);
}

export async function runStudentPromotionReadback(input: ReadbackInput): Promise<StudentPromotionReadbackResult> {
  const db = input.db ?? getDb();
  const detail = await getStudentPromotionRunDetail(input.runId, db);
  const client = input.client ?? createPromotionWiseClient();
  const instituteId = instituteIdFromEnv();
  const liveStudents = await fetchWiseAcceptedStudents(client, instituteId);
  const [registrationRows, courseRows, liveSessions] = await Promise.all([
    fetchReadbackRegistrationRows(client, instituteId, liveStudents),
    fetchCourseReadbackRows(client, detail.courseActions),
    fetchAllFutureSessions(client, instituteId),
  ]);
  const futureSessionActions = await refreshStudentPromotionFutureSessionActions({
    db,
    detail,
    client,
    instituteId,
    liveSessions,
  });
  const gradeRows = buildStudentPromotionGradeReadbackRows(detail, liveStudents, registrationRows);
  const futureSessionRows = buildStudentPromotionFutureSessionReadbackRows(
    { courseActions: detail.courseActions, futureSessionActions },
    liveSessions,
  );

  return {
    runId: detail.run.id,
    checkedAt: new Date(),
    liveAcceptedStudentCount: liveStudents.length,
    runGradeActionCount: detail.gradeActions.length,
    gradeSummary: summarizeGradeReadback(gradeRows),
    courseSummary: summarizeCourseReadback(courseRows),
    futureSessionSummary: summarizeFutureSessionReadback(futureSessionRows),
    gradeRows,
    courseRows,
    futureSessionRows,
  };
}

async function latestVerifiedRunId(db: Database): Promise<string> {
  const [run] = await db
    .select({ id: schema.studentPromotionRuns.id })
    .from(schema.studentPromotionRuns)
    .where(and(
      eq(schema.studentPromotionRuns.targetDate, STUDENT_PROMOTION_TARGET_DATE),
      eq(schema.studentPromotionRuns.status, "verified"),
    ))
    .orderBy(desc(schema.studentPromotionRuns.verifiedAt), desc(schema.studentPromotionRuns.createdAt))
    .limit(1);
  if (!run) throw new Error("No verified student promotion run found");
  return run.id;
}
