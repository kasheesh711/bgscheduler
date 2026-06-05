import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/lib/db";
import { attachActionStatesToStudents } from "@/lib/credit-control/action-helpers";
import { buildDashboardModel } from "@/lib/credit-control/analytics";
import { CREDIT_CONTROL_CACHE_TAG, UNASSIGNED_ADMIN_KEY, UNASSIGNED_ADMIN_NAME } from "@/lib/credit-control/config";
import {
  appendCreditFollowUpLog,
  bulkGetCreditAdminOwnership,
  deleteCreditFollowUpState,
  listCreditInactive,
  loadCreditActionStateMap,
  loadCreditControlSources,
} from "@/lib/credit-control/db";
import {
  buildActiveStudentSet,
  buildDashboardStudents,
  buildExcludedPackageReasons,
  buildPendingDeductionContext,
  buildUpcomingSessionMap,
} from "@/lib/credit-control/packages";
import { formatDate, getTodayDate, parseDate } from "@/lib/credit-control/helpers";
import type { DashboardPayload, AdminViewKey } from "@/types/credit-control";

const SYSTEM_ACTOR_EMAIL = "system@begifted.local";
const SYSTEM_ACTOR_NAME = "System";

export async function getCreditControlPayload(
  todayKey = formatDate(getTodayDate())!,
  options: { clearRecoveredActionStates?: boolean } = {},
): Promise<DashboardPayload> {
  "use cache";
  cacheTag(CREDIT_CONTROL_CACHE_TAG);
  cacheLife({ stale: 60, revalidate: 60, expire: 300 });

  const today = parseDate(todayKey) ?? getTodayDate();
  const db = getDb();
  const { sources, snapshot } = await loadCreditControlSources(db);

  const activeStudents = buildActiveStudentSet(sources.students);
  const excludedPackageReasons = buildExcludedPackageReasons(sources.studentsCourses);
  const pendingDeductionContext = buildPendingDeductionContext(
    sources.creditControl,
    activeStudents,
    excludedPackageReasons,
    today,
  );
  const upcomingSessionMap = buildUpcomingSessionMap(
    sources.upcoming,
    activeStudents,
    excludedPackageReasons,
    today,
  );
  const students = buildDashboardStudents(
    sources.aggregations,
    activeStudents,
    excludedPackageReasons,
    pendingDeductionContext,
    upcomingSessionMap,
    today,
    {},
  );

  const studentKeys = students.map((student) => student.studentKey);
  const [actionStateMap, inactiveRows, ownershipMap] = await Promise.all([
    loadCreditActionStateMap(db),
    listCreditInactive(db),
    bulkGetCreditAdminOwnership(studentKeys, db),
  ]);

  for (const student of students) {
    const ownership = ownershipMap.get(student.studentKey);
    if (!ownership) continue;
    student.adminOwnerKey = ownership.key as AdminViewKey;
    student.adminOwnerName = ownership.name || UNASSIGNED_ADMIN_NAME;
    student.adminOwnershipSource = ownership.source || "postgres-sidecar";
  }

  attachActionStatesToStudents(students, today, actionStateMap);
  if (options.clearRecoveredActionStates !== false) {
    await clearRecoveredActionStates(students);
  }

  const inactiveSet = new Set(inactiveRows.map((row) => row.studentKey));
  const filteredStudents = inactiveSet.size > 0
    ? students.filter((student) => !inactiveSet.has(student.studentKey))
    : students;

  return buildDashboardModel(
    filteredStudents,
    { lastSnapshot: null, history: [] },
    today,
    snapshot.generatedAt,
  ).payload as DashboardPayload;
}

export async function clearRecoveredActionStates(students: Array<{
  studentKey: string;
  student: string;
  parent: string;
  actionState: unknown;
  packages: Array<{ status: string }>;
}>): Promise<void> {
  const recovered = students.filter(
    (student) =>
      student.actionState &&
      !student.packages.some((pkg) => pkg.status === "notify" || pkg.status === "watch"),
  );
  if (recovered.length === 0) return;

  await Promise.all(recovered.map(async (student) => {
    await deleteCreditFollowUpState(student.studentKey);
    await appendCreditFollowUpLog({
      studentKey: student.studentKey,
      studentName: student.student,
      parentName: student.parent,
      actionType: "auto-clear",
      status: null,
      actorEmail: SYSTEM_ACTOR_EMAIL,
      actorName: SYSTEM_ACTOR_NAME,
    });
    student.actionState = null;
  }));
}

export function defaultCreditAdminOwnership() {
  return {
    key: UNASSIGNED_ADMIN_KEY,
    name: UNASSIGNED_ADMIN_NAME,
    source: "unassigned",
  };
}
