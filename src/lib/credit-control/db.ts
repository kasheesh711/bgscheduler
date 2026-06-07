import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  ADMIN_OWNER_REGISTRY,
  SHEET_AGGREGATIONS,
  SHEET_CREDIT_CONTROL,
  SHEET_REMAINING_CREDITS,
  SHEET_STUDENTS,
  SHEET_STUDENTS_COURSES,
  SHEET_UPCOMING,
  UNASSIGNED_ADMIN_KEY,
  UNASSIGNED_ADMIN_NAME,
} from "@/lib/credit-control/config";
import { buildDashboardStudentKey, buildStudentPackageKey, formatDate } from "@/lib/credit-control/helpers";
import type { ActionStateMap, AdminOwnership, DashboardSources, SheetSnapshot } from "@/lib/credit-control/domain";
import type { StudentActionStatus } from "@/types/credit-control";

const ADMIN_BY_KEY = new Map<string, { label: string; fullName: string }>(
  ADMIN_OWNER_REGISTRY.map((admin) => [admin.key, { label: admin.label, fullName: admin.fullName }]),
);

export interface CreditControlActiveSnapshot {
  id: string;
  generatedAt: Date;
}

export interface FollowUpStateInput {
  studentKey: string;
  studentName: string;
  parentName: string;
  status: StudentActionStatus;
  updatedByEmail: string;
  updatedByName: string;
}

export interface FollowUpLogInput {
  studentKey: string;
  studentName: string;
  parentName: string;
  actionType: "set" | "clear" | "bulk-set" | "bulk-clear" | "auto-clear";
  status: StudentActionStatus | null;
  actorEmail: string;
  actorName: string;
}

export interface InactiveInput {
  studentKey: string;
  studentName: string;
  parentName: string;
  markedByEmail: string;
  /** "manual" (default) or "auto-churn". */
  source?: string;
  /** Total remaining credits at removal; used for genuine-top-up reactivation. */
  removedAtRemaining?: number | null;
}

export interface AdminOwnershipInput {
  studentKey: string;
  adminKey: string;
  assignedByEmail: string;
}

function buildSnapshot(sheetName: string, header: string[], rows: unknown[][]): SheetSnapshot {
  return {
    sheetName,
    headerRowIndex: 0,
    dataRowStartIndex: 2,
    cols: Object.fromEntries(header.map((name, index) => [name, index])),
    rows,
  };
}

export async function getActiveCreditSnapshot(db: Database = getDb()): Promise<CreditControlActiveSnapshot | null> {
  const [snapshot] = await db
    .select({
      id: schema.creditControlSnapshots.id,
      generatedAt: schema.creditControlSnapshots.generatedAt,
    })
    .from(schema.creditControlSnapshots)
    .where(eq(schema.creditControlSnapshots.active, true))
    .orderBy(desc(schema.creditControlSnapshots.generatedAt))
    .limit(1);

  return snapshot ?? null;
}

export async function loadCreditControlSources(db: Database = getDb()): Promise<{
  sources: DashboardSources;
  snapshot: CreditControlActiveSnapshot;
}> {
  const snapshot = await getActiveCreditSnapshot(db);
  if (!snapshot) {
    throw new Error("No active credit-control snapshot found. Run credit sync first.");
  }

  const [students, packages, sessions] = await Promise.all([
    db
      .select()
      .from(schema.creditControlStudents)
      .where(eq(schema.creditControlStudents.snapshotId, snapshot.id)),
    db
      .select()
      .from(schema.creditControlPackages)
      .where(eq(schema.creditControlPackages.snapshotId, snapshot.id)),
    db
      .select()
      .from(schema.creditControlSessions)
      .where(eq(schema.creditControlSessions.snapshotId, snapshot.id)),
  ]);

  const activeStudentNames = new Set(packages.filter((row) => !row.excludedReason).map((row) => row.studentName));

  const aggregationRows = packages.map((row) => [
    row.studentName,
    row.parentName,
    row.packageName,
    row.remainingCredits,
    row.totalCredits,
  ]);

  const creditControlRows = sessions
    .filter((row) => row.sessionKind === "past")
    .map((row) => [
      row.studentName,
      row.packageName,
      row.meetingStatus,
      row.teacherFeedback ?? "",
      row.creditApplied,
      row.durationMinutes,
      formatDate(new Date(row.scheduledStartTime)),
      "",
      row.wiseSessionId,
    ]);

  const upcomingRows = sessions
    .filter((row) => row.sessionKind === "future")
    .map((row) => [
      row.studentName,
      row.packageName,
      row.meetingStatus,
      row.durationMinutes,
      formatDate(new Date(row.scheduledStartTime)),
    ]);

  const studentRows = students.map((row) => [
    row.studentName,
    activeStudentNames.has(row.studentName) ? "0" : "N/A",
  ]);

  const studentCourseRows = packages.map((row) => [
    row.studentName,
    row.packageName,
    row.subject || row.packageName,
  ]);

  return {
    snapshot,
    sources: {
      aggregations: buildSnapshot(SHEET_AGGREGATIONS, [
        "Student Name",
        "Parent Name",
        "Class Subject",
        "Current Remaining Credits",
        "Current Total Credits",
      ], aggregationRows),
      creditControl: buildSnapshot(SHEET_CREDIT_CONTROL, [
        "Student Name",
        "Package/Program",
        "final_status",
        "teacher_feedback",
        "credits_consumed",
        "session_duration",
        "session_date",
        "Should_Credit",
        "session_id",
      ], creditControlRows),
      upcoming: buildSnapshot(SHEET_UPCOMING, [
        "Student Name",
        "Package/Program",
        "Session Status",
        "Session Duration",
        "Scheduled Date",
      ], upcomingRows),
      students: buildSnapshot(SHEET_STUDENTS, ["student_name", "Remaining Credits"], studentRows),
      studentsCourses: buildSnapshot(SHEET_STUDENTS_COURSES, [
        "Student Name",
        "Student Full Name",
        "Class Subject",
      ], studentCourseRows),
      remainingCredits: buildSnapshot(SHEET_REMAINING_CREDITS, ["Student", "Admin"], []),
    },
  };
}

export async function loadCreditActionStateMap(db: Database = getDb()): Promise<ActionStateMap> {
  const rows = await db.select().from(schema.creditControlFollowUpState);
  const map: ActionStateMap = {};
  for (const row of rows) {
    map[row.studentKey] = {
      status: row.status as StudentActionStatus,
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: row.updatedByName,
      isToday: true,
    };
  }
  return map;
}

export async function upsertCreditFollowUpState(input: FollowUpStateInput, db: Database = getDb()): Promise<void> {
  await db
    .insert(schema.creditControlFollowUpState)
    .values(input)
    .onConflictDoUpdate({
      target: schema.creditControlFollowUpState.studentKey,
      set: {
        studentName: input.studentName,
        parentName: input.parentName,
        status: input.status,
        updatedAt: new Date(),
        updatedByEmail: input.updatedByEmail,
        updatedByName: input.updatedByName,
      },
    });
}

export async function appendCreditFollowUpLog(input: FollowUpLogInput, db: Database = getDb()): Promise<void> {
  await db.insert(schema.creditControlFollowUpLog).values(input);
}

export async function deleteCreditFollowUpState(studentKey: string, db: Database = getDb()): Promise<void> {
  await db
    .delete(schema.creditControlFollowUpState)
    .where(eq(schema.creditControlFollowUpState.studentKey, studentKey));
}

export async function readCreditActionHistory(
  studentKey: string,
  sinceDays = 7,
  db: Database = getDb(),
) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  return db
    .select()
    .from(schema.creditControlFollowUpLog)
    .where(and(
      eq(schema.creditControlFollowUpLog.studentKey, studentKey),
      gte(schema.creditControlFollowUpLog.createdAt, since),
    ))
    .orderBy(desc(schema.creditControlFollowUpLog.createdAt));
}

export async function listCreditInactive(db: Database = getDb()) {
  return db.select().from(schema.creditControlInactiveStudents);
}

export async function markCreditInactive(input: InactiveInput, db: Database = getDb()): Promise<void> {
  const source = input.source ?? "manual";
  const removedAtRemaining = input.removedAtRemaining ?? null;
  await db
    .insert(schema.creditControlInactiveStudents)
    .values({
      studentKey: input.studentKey,
      studentName: input.studentName,
      parentName: input.parentName,
      markedByEmail: input.markedByEmail,
      source,
      removedAtRemaining,
    })
    .onConflictDoUpdate({
      target: schema.creditControlInactiveStudents.studentKey,
      set: {
        studentName: input.studentName,
        parentName: input.parentName,
        markedAt: new Date(),
        markedByEmail: input.markedByEmail,
        source,
        removedAtRemaining,
      },
    });
}

export async function clearCreditInactive(studentKey: string, db: Database = getDb()): Promise<void> {
  await db
    .delete(schema.creditControlInactiveStudents)
    .where(eq(schema.creditControlInactiveStudents.studentKey, studentKey));
}

export async function bulkGetCreditAdminOwnership(
  studentKeys: string[],
  db: Database = getDb(),
): Promise<Map<string, AdminOwnership>> {
  if (studentKeys.length === 0) return new Map();
  const rows = await db
    .select()
    .from(schema.creditControlAdminOwnership)
    .where(inArray(schema.creditControlAdminOwnership.studentKey, studentKeys));

  const map = new Map<string, AdminOwnership>();
  for (const row of rows) {
    const registry = ADMIN_BY_KEY.get(row.adminKey);
    map.set(row.studentKey, {
      key: row.adminKey,
      name: registry?.label ?? (row.adminKey === UNASSIGNED_ADMIN_KEY ? UNASSIGNED_ADMIN_NAME : row.adminKey),
      source: "postgres-sidecar",
    });
  }
  return map;
}

export async function upsertCreditAdminOwnership(input: AdminOwnershipInput, db: Database = getDb()): Promise<void> {
  await db
    .insert(schema.creditControlAdminOwnership)
    .values(input)
    .onConflictDoUpdate({
      target: schema.creditControlAdminOwnership.studentKey,
      set: {
        adminKey: input.adminKey,
        assignedByEmail: input.assignedByEmail,
        updatedAt: new Date(),
      },
    });
}

export function fallbackStudentKey(studentName: string, parentName: string): string {
  return buildDashboardStudentKey(studentName, parentName);
}

export function fallbackPackageKey(studentName: string, packageName: string): string {
  return buildStudentPackageKey(studentName, packageName);
}
