import { createHash } from "node:crypto";
import { ROOM_REPAIR_MAX_NODES } from "./assignment-repair";
import {
  assignClassrooms,
  repairClassroomAssignmentRows,
  REMOTE_NO_ROOM_NEEDED,
  type AssignmentResultRow,
  type AssignmentSession,
  type ContextSession,
  type ExternalRoomBlock,
  type FixedTutorAssignment,
} from "./assignment-engine";
import {
  NO_ROOM_AVAILABLE,
  normalizeTutorName,
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
  contextSessions?: ContextSession[];
}

const FINGERPRINT_FIELDS: Array<keyof AssignmentSession> = [
  "tutorDisplayName",
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
    FINGERPRINT_FIELDS.map((field) => [field, field === "tutorDisplayName"
      ? normalizeTutorName(session.tutorDisplayName) : stableValue(session[field])]),
  );
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Whether a row currently occupies a real physical room. Broader than "assigned by design": a
 * needs_review row (e.g. needs_review_missing_capacity) still carries a real assignedRoom, and a
 * full engine run adds any such row to occupancy and lastByTutor exactly like an assigned one --
 * assignment-engine.ts only excludes the NO_ROOM_AVAILABLE / REMOTE_NO_ROOM_NEEDED sentinels, not
 * the needs_review status. The reconciled path must match, or it silently double-books the room a
 * carried needs_review row holds (HI-01) and fails to seed continuity from it (MD-02).
 */
function holdsRoom(row: Pick<ReconciledAssignmentRow, "status" | "assignedRoom">): boolean {
  return (
    (row.status === "assigned" || row.status === "needs_review") &&
    row.assignedRoom !== NO_ROOM_AVAILABLE &&
    row.assignedRoom !== REMOTE_NO_ROOM_NEEDED
  );
}

function rowToExternalBlock(row: ReconciledAssignmentRow): ExternalRoomBlock | null {
  if (!holdsRoom(row)) return null;
  return {
    wiseSessionId: row.wiseSessionId,
    className: row.studentName ?? row.title ?? null,
    location: row.assignedRoom,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  };
}

/**
 * Projects a carried row into the minimal shape assignClassrooms needs to fold it into the
 * center-room chain walk (see ContextSession). Passed for every carried row regardless of status --
 * a full, non-reconciled run over the same final session set would see all of them.
 */
function rowToContextSession(row: ReconciledAssignmentRow): ContextSession {
  return {
    wiseSessionId: row.wiseSessionId,
    tutorDisplayName: row.tutorDisplayName,
    groupId: row.groupId,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    sessionType: row.sessionType,
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
  // Recompute with the current contract: stored hashes may include a snapshot-scoped group UUID.
  const previousFingerprint = assignmentFingerprint(previousRowToSession(previous));
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
    currentWiseLocation: session.currentWiseLocation,
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

function fixedTutorAssignmentsFrom(rows: ReconciledAssignmentRow[]): FixedTutorAssignment[] {
  return rows
    .filter((row) => holdsRoom(row))
    .map((row) => ({
      tutorDisplayName: row.tutorDisplayName,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      room: row.assignedRoom,
    }));
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

    if (changeType === "carried" && previous && previous.status !== "no_room") {
      carriedRows.push(carryRow(session, previous, fingerprint));
      continue;
    }

    pendingSessions.push(session);
    // Retry unresolved rows even when the Wise session did not change. Final comparison below
    // records an actual recovery as moved, rather than inventing a change to the Wise session.
    if (changeType === "carried") continue;
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
  const repairBudget = { remaining: ROOM_REPAIR_MAX_NODES };
  const assignPending = (
    sessions: AssignmentSession[],
    fixedRows: ReconciledAssignmentRow[],
  ): AssignmentResultRow[] => assignClassrooms(
    sessions,
    input.rooms,
    overrides,
    {
      repairBudget: fixedRows.length ? { remaining: 0 } : repairBudget,
      externalRoomBlocks: fixedBlocks(fixedRows, externalRoomBlocks),
      fixedTutorAssignments: fixedTutorAssignmentsFrom(fixedRows),
      // fixedRows is exactly today's still-carried rows (any status) at this point in the
      // reconcile. A full run would see all of them when walking the online<->onsite center-room
      // chain, so pass them as context -- without re-assigning, re-occupying, or re-seeding
      // continuity for them (that is already handled by externalRoomBlocks / fixedTutorAssignments
      // above). The repair pass works on the combined plan without repeating this allocation.
      contextSessions: [...fixedRows.map(rowToContextSession), ...(input.contextSessions ?? [])],
    },
  ).rows;

  // Validate retained Wise occupancy even when the first pass found rooms for every pending row.
  // Search starts from the existing plan, measuring moves against rooms already promised to tutors.
  const assignedDynamicRows = repairClassroomAssignmentRows(
    [...carriedRows, ...assignPending(pendingSessions, carriedRows)], input.rooms,
    { externalRoomBlocks, repairBudget },
  );

  const finalRows: ReconciledAssignmentRow[] = [];
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
