import { and, desc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { WiseClient } from "@/lib/wise/client";
import {
  fetchWiseAcceptedStudents,
  fetchWiseCourse,
  fetchWiseCourseParticipants,
  fetchWiseStudentRegistrationData,
  updateWiseCourseSubject,
  updateWiseStudentRegistrationAnswers,
  type WisePromotionStudent,
  type WiseRegistrationField,
} from "@/lib/wise/fetchers";
import {
  COURSE_SUBJECT_TARGETS,
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

export interface StudentPromotionRunDetail {
  run: StudentPromotionRunRow;
  gradeActions: StudentPromotionGradeActionRow[];
  courseActions: StudentPromotionCourseActionRow[];
  summary: {
    pendingGradeActions: number;
    skippedGradeActions: number;
    appliedGradeActions: number;
    failedGradeActions: number;
    pendingCourseActions: number;
    skippedCourseActions: number;
    appliedCourseActions: number;
    failedCourseActions: number;
  };
}

interface SnapshotStudent {
  wiseStudentId: string;
  studentKey: string;
  studentName: string;
  activated: boolean;
}

interface SnapshotPackage {
  wiseStudentId: string;
  wiseClassId: string;
  studentKey: string;
  studentName: string;
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

const REGISTRATION_FETCH_CONCURRENCY = 4;
const WISE_WRITE_CONCURRENCY = 3;
const WISE_REQUEST_MIN_INTERVAL_MS = 130;

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

function transitionForUnmappedSubject(subject: string): PromotionTransition | null {
  if (/(?:y\s*2\s*-\s*8|g\s*1\s*-\s*7|grade\s*1\s*-\s*7)/i.test(subject)) return "year8_to_year9";
  if (/(?:y\s*9\s*-\s*11|g\s*8\s*-\s*10|grade\s*8\s*-\s*10)/i.test(subject)) return "year11_to_year12";
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
    const mapped = COURSE_SUBJECT_TARGETS[classroom.subject];
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
  const wiseStudentById = new Map(wiseStudents.map((student) => [student._id, student]));
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
    const actionType = parsed.currentYear === null
      ? parsed.kind === "blank" ? "missing_grade_review" : "unparsed_grade_review"
      : gradeActionTypeFor(parsed.currentYear, subjects);
    const status = parsed.currentYear === null ? "skipped" : "pending";
    const targetGrade = parsed.currentYear === null ? null : formatPromotedGrade(parsed.currentYear);

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
  }

  const courseRows = buildCourseActions(run.id, packages, currentYearByStudent);
  const pendingCourseActionCount = courseRows.filter((row) => row.status === "pending").length;
  const skippedCourseActionCount = courseRows.filter((row) => row.status === "skipped").length;

  await insertGradeActionChunks(db, gradeRows);
  await insertCourseActionChunks(db, courseRows);
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

  return getStudentPromotionRunDetail(run.id, db);
}

export async function getStudentPromotionRunDetail(runId: string, db: Database = getDb()): Promise<StudentPromotionRunDetail> {
  const [run] = await db
    .select()
    .from(schema.studentPromotionRuns)
    .where(eq(schema.studentPromotionRuns.id, runId))
    .limit(1);
  if (!run) throw new Error("Student promotion run not found");

  const [gradeActions, courseActions] = await Promise.all([
    db
      .select()
      .from(schema.studentPromotionGradeActions)
      .where(eq(schema.studentPromotionGradeActions.runId, runId)),
    db
      .select()
      .from(schema.studentPromotionCourseActions)
      .where(eq(schema.studentPromotionCourseActions.runId, runId)),
  ]);

  return {
    run,
    gradeActions,
    courseActions,
    summary: {
      pendingGradeActions: gradeActions.filter((row) => row.status === "pending").length,
      skippedGradeActions: gradeActions.filter((row) => row.status === "skipped").length,
      appliedGradeActions: gradeActions.filter((row) => row.status === "applied").length,
      failedGradeActions: gradeActions.filter((row) => row.status === "failed").length,
      pendingCourseActions: courseActions.filter((row) => row.status === "pending").length,
      skippedCourseActions: courseActions.filter((row) => row.status === "skipped").length,
      appliedCourseActions: courseActions.filter((row) => row.status === "applied").length,
      failedCourseActions: courseActions.filter((row) => row.status === "failed").length,
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
  if (detail.summary.pendingGradeActions === 0 && detail.summary.pendingCourseActions === 0) {
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
    const parsed = parseWiseGrade(currentRaw);
    const now = new Date();

    if (currentRaw === action.targetGrade) {
      await db
        .update(schema.studentPromotionGradeActions)
        .set({ status: "applied", appliedAt: now, updatedAt: now, responsePayload: { idempotent: true } })
        .where(eq(schema.studentPromotionGradeActions.id, action.id));
      return "applied";
    }

    if (parsed.currentYear !== action.parsedCurrentYear) {
      await db
        .update(schema.studentPromotionGradeActions)
        .set({
          status: "skipped",
          skipReason: "grade_drift",
          errorMessage: `Current grade changed from ${action.currentGradeRaw || "(blank)"} to ${currentRaw || "(blank)"}`,
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

  const client = input.client ?? createPromotionWiseClient();
  const instituteId = instituteIdFromEnv();
  const gate = createRateGate(WISE_REQUEST_MIN_INTERVAL_MS);
  const pendingGradeActions = detail.gradeActions.filter((row) => row.status === "pending");
  const pendingCourseActions = detail.courseActions.filter((row) => row.status === "pending");

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
  const failures = [...gradeResults, ...courseResults].filter((result) => result === "failed").length;
  const driftSkips = [...gradeResults, ...courseResults].filter((result) => result === "skipped").length;
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

  return getStudentPromotionRunDetail(runId, db);
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
