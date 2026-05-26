import { createHash } from "node:crypto";
import {
  assignClassrooms,
  REMOTE_NO_ROOM_NEEDED,
  type AssignmentResultRow,
  type AssignmentSession,
  type ExternalRoomBlock,
} from "./assignment-engine";
import {
  NO_ROOM_AVAILABLE,
  type ClassroomRoomDefinition,
} from "./rooms";

export type AssignmentChangeType = "manual" | "carried" | "added" | "changed" | "rescheduled" | "moved";
export type AutomationEventType = "added" | "changed" | "rescheduled" | "canceled" | "moved";
export type ClassroomPublishStatus = "not_published" | "skipped" | "success" | "failed";

export interface PreviousAssignmentRow extends AssignmentSession {
  id: string;
  minCapacity: number;
  needsTv: boolean;
  preferredRoom: string | null;
  overrideRoom: string | null;
  assignedRoom: string;
  status: "assigned" | "needs_review" | "no_room" | "remote";
  warnings: string[];
  ruleTrace: string[];
  publishStatus: ClassroomPublishStatus;
  publishError: string | null;
  publishedAt: Date | null;
  assignmentFingerprint: string | null;
  sourceRowId?: string | null;
  changeType?: string | null;
}

export interface ReconciledAssignmentRow extends AssignmentResultRow {
  sourceRowId: string | null;
  changeType: AssignmentChangeType;
  assignmentFingerprint: string;
  publishStatus: ClassroomPublishStatus;
  publishError: string | null;
  publishedAt: Date | null;
}

export interface ClassroomAutomationEvent {
  type: AutomationEventType;
  wiseSessionId: string;
  sourceRowId: string | null;
  message: string;
  metadata: Record<string, unknown>;
}

export interface ReconciliationResult {
  rows: ReconciledAssignmentRow[];
  events: ClassroomAutomationEvent[];
  summary: Record<string, number>;
}

interface ReconcileInput {
  sessions: AssignmentSession[];
  previousRows: PreviousAssignmentRow[];
  rooms: ClassroomRoomDefinition[];
  externalRoomBlocks?: ExternalRoomBlock[];
}

const FINGERPRINT_FIELDS: Array<keyof AssignmentSession> = [
  "groupId",
  "wiseTeacherId",
  "wiseTeacherUserId",
  "wiseSessionId",
  "wiseClassId",
  "startTime",
  "endTime",
  "weekday",
  "startMinute",
  "endMinute",
  "wiseStatus",
  "sessionType",
  "studentName",
  "studentCount",
  "subject",
  "classType",
  "title",
];

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

export function assignmentFingerprint(session: AssignmentSession): string {
  const payload = Object.fromEntries(
    FINGERPRINT_FIELDS.map((field) => [field, stableValue(session[field])]),
  );
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 24);
}

function rowsOverlap(
  left: Pick<AssignmentSession, "startMinute" | "endMinute">,
  right: Pick<AssignmentSession, "startMinute" | "endMinute">,
): boolean {
  return left.startMinute < right.endMinute && right.startMinute < left.endMinute;
}

function blocksRoom(row: Pick<ReconciledAssignmentRow, "status" | "assignedRoom">): boolean {
  return (
    row.status === "assigned" &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.assignedRoom !== REMOTE_NO_ROOM_NEEDED
  );
}

function rowToExternalBlock(row: ReconciledAssignmentRow): ExternalRoomBlock | null {
  if (!blocksRoom(row)) return null;
  return {
    wiseSessionId: row.wiseSessionId,
    className: row.studentName ?? row.title ?? null,
    location: row.assignedRoom,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  };
}

function previousRowToSession(row: PreviousAssignmentRow): AssignmentSession {
  return {
    groupId: row.groupId,
    tutorDisplayName: row.tutorDisplayName,
    wiseTeacherId: row.wiseTeacherId,
    wiseTeacherUserId: row.wiseTeacherUserId,
    wiseSessionId: row.wiseSessionId,
    wiseClassId: row.wiseClassId,
    startTime: row.startTime,
    endTime: row.endTime,
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    wiseStatus: row.wiseStatus,
    sessionType: row.sessionType,
    currentWiseLocation: row.currentWiseLocation,
    studentName: row.studentName,
    studentCount: row.studentCount,
    subject: row.subject,
    classType: row.classType,
    title: row.title,
  };
}

function classifyChange(session: AssignmentSession, previous: PreviousAssignmentRow | undefined): AssignmentChangeType {
  if (!previous) return "added";
  const previousFingerprint = previous.assignmentFingerprint ?? assignmentFingerprint(previousRowToSession(previous));
  const nextFingerprint = assignmentFingerprint(session);
  if (previousFingerprint === nextFingerprint) return "carried";
  const sameTime =
    previous.startTime.getTime() === session.startTime.getTime() &&
    previous.endTime.getTime() === session.endTime.getTime() &&
    previous.startMinute === session.startMinute &&
    previous.endMinute === session.endMinute;
  return sameTime ? "changed" : "rescheduled";
}

function carryRow(
  session: AssignmentSession,
  previous: PreviousAssignmentRow,
  fingerprint: string,
): ReconciledAssignmentRow {
  return {
    ...session,
    currentWiseLocation: previous.currentWiseLocation,
    minCapacity: previous.minCapacity,
    needsTv: previous.needsTv,
    preferredRoom: previous.preferredRoom,
    overrideRoom: previous.overrideRoom,
    assignedRoom: previous.assignedRoom,
    status: previous.status,
    warnings: previous.warnings,
    ruleTrace: previous.ruleTrace,
    sourceRowId: previous.id,
    changeType: "carried",
    assignmentFingerprint: fingerprint,
    publishStatus: previous.publishStatus,
    publishError: previous.publishError,
    publishedAt: previous.publishedAt,
  };
}

function resetPublish(row: AssignmentResultRow, input: {
  sourceRowId: string | null;
  changeType: AssignmentChangeType;
  fingerprint: string;
}): ReconciledAssignmentRow {
  return {
    ...row,
    sourceRowId: input.sourceRowId,
    changeType: input.changeType,
    assignmentFingerprint: input.fingerprint,
    publishStatus: "not_published",
    publishError: null,
    publishedAt: null,
  };
}

function preservePublish(
  row: AssignmentResultRow,
  previous: PreviousAssignmentRow,
  fingerprint: string,
): ReconciledAssignmentRow {
  return {
    ...row,
    sourceRowId: previous.id,
    changeType: "carried",
    assignmentFingerprint: fingerprint,
    publishStatus: previous.publishStatus,
    publishError: previous.publishError,
    publishedAt: previous.publishedAt,
  };
}

function makeOverrideMap(previousRows: PreviousAssignmentRow[]): Map<string, string | null> {
  const overrides = new Map<string, string | null>();
  for (const row of previousRows) {
    if (row.overrideRoom) overrides.set(row.wiseSessionId, row.overrideRoom);
  }
  return overrides;
}

function fixedBlocks(rows: ReconciledAssignmentRow[], externalRoomBlocks: ExternalRoomBlock[]): ExternalRoomBlock[] {
  return [
    ...externalRoomBlocks,
    ...rows.map(rowToExternalBlock).filter((block): block is ExternalRoomBlock => Boolean(block)),
  ];
}

function summarize(rows: ReconciledAssignmentRow[], events: ClassroomAutomationEvent[]): Record<string, number> {
  const summary: Record<string, number> = {
    carried: rows.filter((row) => row.changeType === "carried").length,
    added: rows.filter((row) => row.changeType === "added").length,
    changed: rows.filter((row) => row.changeType === "changed").length,
    rescheduled: rows.filter((row) => row.changeType === "rescheduled").length,
    moved: rows.filter((row) => row.changeType === "moved").length,
    canceled: events.filter((event) => event.type === "canceled").length,
  };
  return summary;
}

function changeMessage(type: AssignmentChangeType, session: AssignmentSession, previous?: PreviousAssignmentRow): string {
  if (type === "added") return `Added Wise session ${session.wiseSessionId}`;
  if (type === "rescheduled") {
    return `Rescheduled Wise session ${session.wiseSessionId} from ${previous?.startTime.toISOString()} to ${session.startTime.toISOString()}`;
  }
  return `Changed Wise session ${session.wiseSessionId}`;
}

export function reconcileClassroomAssignments(input: ReconcileInput): ReconciliationResult {
  const externalRoomBlocks = input.externalRoomBlocks ?? [];
  const previousBySessionId = new Map(input.previousRows.map((row) => [row.wiseSessionId, row]));
  const sessionById = new Map(input.sessions.map((session) => [session.wiseSessionId, session]));
  const currentIds = new Set(sessionById.keys());
  const events: ClassroomAutomationEvent[] = [];
  const carriedRows: ReconciledAssignmentRow[] = [];
  const pendingSessions: AssignmentSession[] = [];
  const changeTypeBySessionId = new Map<string, AssignmentChangeType>();

  for (const session of input.sessions) {
    const previous = previousBySessionId.get(session.wiseSessionId);
    const changeType = classifyChange(session, previous);
    const fingerprint = assignmentFingerprint(session);

    if (changeType === "carried" && previous) {
      carriedRows.push(carryRow(session, previous, fingerprint));
      continue;
    }

    pendingSessions.push(session);
    changeTypeBySessionId.set(session.wiseSessionId, changeType);
    events.push({
      type: changeType as AutomationEventType,
      wiseSessionId: session.wiseSessionId,
      sourceRowId: previous?.id ?? null,
      message: changeMessage(changeType, session, previous),
      metadata: {
        previousStartTime: previous?.startTime.toISOString() ?? null,
        previousEndTime: previous?.endTime.toISOString() ?? null,
        nextStartTime: session.startTime.toISOString(),
        nextEndTime: session.endTime.toISOString(),
      },
    });
  }

  for (const previous of input.previousRows) {
    if (currentIds.has(previous.wiseSessionId)) continue;
    events.push({
      type: "canceled",
      wiseSessionId: previous.wiseSessionId,
      sourceRowId: previous.id,
      message: `Canceled or removed Wise session ${previous.wiseSessionId}`,
      metadata: {
        previousStartTime: previous.startTime.toISOString(),
        previousEndTime: previous.endTime.toISOString(),
        previousAssignedRoom: previous.assignedRoom,
      },
    });
  }

  const overrides = makeOverrideMap(input.previousRows);
  const assignPending = (
    sessions: AssignmentSession[],
    fixedRows: ReconciledAssignmentRow[],
  ): AssignmentResultRow[] => assignClassrooms(
    sessions,
    input.rooms,
    overrides,
    { externalRoomBlocks: fixedBlocks(fixedRows, externalRoomBlocks) },
  ).rows;

  let finalCarriedRows = carriedRows;
  let assignedDynamicRows = assignPending(pendingSessions, finalCarriedRows);
  const failedDynamicRows = assignedDynamicRows.filter((row) => row.status === "no_room");

  if (failedDynamicRows.length > 0) {
    const unlockSessionIds = new Set(
      finalCarriedRows
        .filter((row) =>
          !row.overrideRoom &&
          blocksRoom(row) &&
          failedDynamicRows.some((failed) => rowsOverlap(row, failed))
        )
        .map((row) => row.wiseSessionId),
    );

    if (unlockSessionIds.size > 0) {
      const unlockedRows = finalCarriedRows.filter((row) => unlockSessionIds.has(row.wiseSessionId));
      finalCarriedRows = finalCarriedRows.filter((row) => !unlockSessionIds.has(row.wiseSessionId));
      assignedDynamicRows = assignPending(
        [
          ...pendingSessions,
          ...unlockedRows.map((row) => sessionById.get(row.wiseSessionId)).filter((session): session is AssignmentSession => Boolean(session)),
        ],
        finalCarriedRows,
      );
    }
  }

  const finalRows: ReconciledAssignmentRow[] = [...finalCarriedRows];
  for (const row of assignedDynamicRows) {
    const previous = previousBySessionId.get(row.wiseSessionId);
    const fingerprint = assignmentFingerprint(row);
    const originalChangeType = changeTypeBySessionId.get(row.wiseSessionId);

    if (!originalChangeType && previous) {
      const sameAssignment =
        previous.assignedRoom === row.assignedRoom &&
        previous.status === row.status &&
        JSON.stringify(previous.warnings) === JSON.stringify(row.warnings);
      if (sameAssignment) {
        finalRows.push(preservePublish(row, previous, fingerprint));
      } else {
        finalRows.push(resetPublish(row, {
          sourceRowId: previous.id,
          changeType: "moved",
          fingerprint,
        }));
        events.push({
          type: "moved",
          wiseSessionId: row.wiseSessionId,
          sourceRowId: previous.id,
          message: `Moved Wise session ${row.wiseSessionId} from ${previous.assignedRoom} to ${row.assignedRoom}`,
          metadata: {
            previousAssignedRoom: previous.assignedRoom,
            nextAssignedRoom: row.assignedRoom,
          },
        });
      }
      continue;
    }

    finalRows.push(resetPublish(row, {
      sourceRowId: previous?.id ?? null,
      changeType: originalChangeType ?? "added",
      fingerprint,
    }));
  }

  finalRows.sort((left, right) => {
    if (left.startMinute !== right.startMinute) return left.startMinute - right.startMinute;
    return left.tutorDisplayName.localeCompare(right.tutorDisplayName);
  });

  return {
    rows: finalRows,
    events,
    summary: summarize(finalRows, events),
  };
}
