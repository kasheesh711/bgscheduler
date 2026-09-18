import type { Database } from "@/lib/db";
import type { WiseSession } from "@/lib/wise/types";
import { getWiseSessionClassId, getWiseSessionClassType, getWiseSessionTeacherUserId } from "@/lib/wise/types";
import { sessionStudentIds, isBlockingStatus } from "@/lib/normalization/sessions";
import { getLocalMinuteOfDay } from "@/lib/normalization/timezone";
import type { AssignmentSession, ExternalRoomBlock } from "./assignment-engine";
import type { ClassroomRoomDefinition } from "./rooms";
import { getClassroomSessionMode, isOnlineSessionType } from "./session-mode";
import { classroomTimestampToWiseIso } from "./timestamps";
import { assignmentFingerprint, type ReconciliationResult } from "./reconciliation";
import { planClassroomOverflow } from "./overflow-planner";
import { loadStudentModeEvidence } from "./mode-history-data";
import type { StudentModeEvidence } from "./overflow-types";

export function sessionMatchesLive(row: AssignmentSession, live?: WiseSession): boolean {
  if (!live || live._id !== row.wiseSessionId || !isBlockingStatus(live.meetingStatus)) return false;
  const ids = sessionStudentIds(live);
  const teacher = getWiseSessionTeacherUserId(live);
  return getWiseSessionClassId(live) === row.wiseClassId
    && (getWiseSessionClassType(live) ?? null) === (row.classType ?? null)
    && getClassroomSessionMode(live.type) === getClassroomSessionMode(row.sessionType)
    && Date.parse(live.scheduledStartTime) === Date.parse(classroomTimestampToWiseIso(row.startTime))
    && Date.parse(live.scheduledEndTime) === Date.parse(classroomTimestampToWiseIso(row.endTime))
    && getLocalMinuteOfDay(live.scheduledStartTime) === row.startMinute
    && getLocalMinuteOfDay(live.scheduledEndTime) === row.endMinute
    && Boolean(teacher) && [row.wiseTeacherId, row.wiseTeacherUserId].includes(teacher)
    && JSON.stringify(ids?.slice().sort() ?? null) === JSON.stringify(row.studentIds?.slice().sort() ?? null)
    && (typeof live.studentCount !== "number" || live.studentCount === row.studentCount);
}

export function liveVerifiedOnlineIds(rows: AssignmentSession[], live: WiseSession[]): Set<string> {
  const byId = new Map(live.map(row => [row._id, row]));
  return new Set(rows.filter(row => isOnlineSessionType(row.sessionType) && sessionMatchesLive(row, byId.get(row.wiseSessionId))).map(row => row.wiseSessionId));
}

export async function improveOverflowAllocation(db: Database, input: {
  reconciliation: ReconciliationResult;
  rooms: ClassroomRoomDefinition[];
  assignmentDate: string;
  snapshotId: string;
  snapshotFinishedAt: string | null;
  liveSessions: WiseSession[];
  externalRoomBlocks: ExternalRoomBlock[];
  frozenSessionIds: ReadonlySet<string>;
  unverifiedReasons?: string[];
  now?: Date;
}) {
  const { reconciliation } = input;
  if (!reconciliation.rows.some(row => row.status === "no_room")) return { reconciliation, plan: null };
  const now = input.now ?? new Date();
  const live = new Map(input.liveSessions.map(row => [row._id, row]));
  const reasons = [...(input.unverifiedReasons ?? [])];
  for (const row of reconciliation.rows) {
    // Already-started rows are retained by the existing allocator; never candidates for emergency moves.
    if (Date.parse(classroomTimestampToWiseIso(row.startTime)) <= now.getTime()) continue;
    if (!sessionMatchesLive(row, live.get(row.wiseSessionId))) reasons.push(`Session ${row.wiseSessionId} differs from the live Wise read; refresh before relying on suggestions.`);
  }
  let historyCheckedAt: string | null = null, historyWarning: string | null = null;
  let evidence = new Map<string, StudentModeEvidence>();
  if (!reasons.length) {
    try {
      evidence = await loadStudentModeEvidence(db, reconciliation.rows.flatMap(row => row.studentIds ?? []), now);
      historyCheckedAt = now.toISOString();
    } catch {
      historyWarning = "Student history could not be loaded. Candidates are labelled unknown; history ranking is unverified.";
    }
  }
  const result = await planClassroomOverflow({ ...input, rows: reconciliation.rows, evidence, now,
    sourceSnapshotId: input.snapshotId, sourceCheckedAt: now.toISOString(), snapshotFinishedAt: input.snapshotFinishedAt, historyCheckedAt,
    unverifiedReasons: reasons });
  if (result.plan && historyWarning) { result.plan.warnings.push(historyWarning); result.plan.rankingComplete = false; }
  const original = new Map(reconciliation.rows.map(row => [row.wiseSessionId, row]));
  const changed = result.actualRows.filter(row => row.assignedRoom !== original.get(row.wiseSessionId)?.assignedRoom
    || row.overflowReleaseRoom !== original.get(row.wiseSessionId)?.overflowReleaseRoom);
  const changedIds = new Set(changed.map(row => row.wiseSessionId));
  return { plan: result.plan, reconciliation: {
    rows: result.actualRows.map(row => changedIds.has(row.wiseSessionId) ? { ...row, changeType: "moved" as const,
      assignmentFingerprint: assignmentFingerprint(row), publishStatus: "not_published" as const, publishError: null, publishedAt: null } : row),
    events: [...reconciliation.events, ...changed.map(row => ({ type: "moved" as const, wiseSessionId: row.wiseSessionId,
      sourceRowId: row.sourceRowId, message: `Overflow relief: ${original.get(row.wiseSessionId)?.assignedRoom} → ${row.assignedRoom}`,
      metadata: { reason: "overflow_relief", modalityChanged: false } }))],
    summary: { ...reconciliation.summary, overflowMoved: changed.length },
  } };
}
