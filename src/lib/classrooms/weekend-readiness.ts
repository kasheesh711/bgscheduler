import type { AssignmentResultRow, ExternalRoomBlock } from "./assignment-engine";
import type { ClassroomRoomDefinition } from "./rooms";
import { physicalRoom } from "./room-policy";
import { getClassroomSessionMode, isOnsiteSessionType } from "./session-mode";

export type WeekendReadiness = "clear" | "attention" | "unverified";
export interface WeekendFinding {
  date: string;
  kind: "no_room" | "conflict" | "review" | "unverified";
  wiseSessionId?: string;
  tutor?: string;
  className?: string;
  startMinute?: number;
  endMinute?: number;
  room?: string;
  requiredCapacity?: number;
  needsTv?: boolean;
  message: string;
}
export interface WeekendReport {
  checkedAt: string;
  dates: [string, string];
  snapshotId: string | null;
  snapshotFinishedAt: string | null;
  readiness: WeekendReadiness;
  days: Array<{ date: string; liveSessions: number; plannedSessions: number; noRoomCount: number }>;
  findings: WeekendFinding[];
}

const overlaps = (a: { startMinute: number; endMinute: number }, b: { startMinute: number; endMinute: number }) =>
  a.startMinute < b.endMinute && b.startMinute < a.endMinute;

export type ReadinessRow = Pick<AssignmentResultRow, "status" | "wiseSessionId" | "tutorDisplayName" | "studentName" | "title" | "subject"
  | "startMinute" | "endMinute" | "currentWiseLocation" | "assignedRoom" | "minCapacity" | "needsTv" | "warnings" | "sessionType">;

/** Findings describe classes affected, never mislabel an allocator limit as a proven room deficit. */
export function assignmentReadinessFindings(input: {
  date: string;
  rows: ReadinessRow[];
  rooms: ClassroomRoomDefinition[];
  externalRoomBlocks?: ExternalRoomBlock[];
  liveRoomBlocks?: ExternalRoomBlock[];
}): WeekendFinding[] {
  const findings: WeekendFinding[] = [];
  for (const row of input.rows) {
    const context = { date: input.date, wiseSessionId: row.wiseSessionId, tutor: row.tutorDisplayName,
      className: row.studentName || row.title || row.subject || undefined, startMinute: row.startMinute,
      endMinute: row.endMinute, room: row.currentWiseLocation || row.assignedRoom,
      requiredCapacity: row.minCapacity, needsTv: row.needsTv };
    if (getClassroomSessionMode(row.sessionType) === "unknown") findings.push({ ...context, kind: "unverified",
      message: "Class modality is unknown; classroom coverage cannot be confirmed." });
    if (row.status === "remote") continue;
    if (isOnsiteSessionType(row.sessionType) && row.currentWiseLocation) {
      const bookedRoom = input.rooms.find(room => physicalRoom(room.name) === physicalRoom(row.currentWiseLocation!));
      if (!bookedRoom?.active || bookedRoom.category === "online_only" || bookedRoom.capacity < row.minCapacity || (row.needsTv && !bookedRoom.hasTv)) {
        findings.push({ ...context, kind: "review", message: `The existing Wise booking in ${row.currentWiseLocation} does not satisfy the class requirements. Any proposed correction still needs to be applied.` });
      }
    }
    if (row.status === "no_room") {
      findings.push({ ...context, kind: "no_room", message: row.warnings.includes("room_repair_search_exhausted")
        ? "No safe room assignment found within the search limit; staff review required."
        : "This class has no compatible available classroom." });
    } else if (row.status === "needs_review") {
      findings.push({ ...context, kind: "review", message: row.warnings.includes("needs_review_missing_capacity")
        ? "Class size is unknown; the required room capacity must be confirmed."
        : "The room assignment or its requirements could not be confirmed and need staff review." });
    } else {
      const room = input.rooms.find(room => physicalRoom(room.name) === physicalRoom(row.assignedRoom));
      if (!room?.active || room.capacity < row.minCapacity || (row.needsTv && !room.hasTv)
        || (isOnsiteSessionType(row.sessionType) && room.category === "online_only")) {
        findings.push({ ...context, kind: "review", message: "Assigned classroom does not satisfy the class requirements." });
      }
    }
    const planned = input.rows.filter(other => other.status !== "remote" && other.status !== "no_room")
      .map(other => ({ ...other, location: other.assignedRoom }));
    if (row.status !== "no_room" && [...planned, ...(input.externalRoomBlocks ?? [])].some(other =>
      other.wiseSessionId !== row.wiseSessionId && physicalRoom(other.location) === physicalRoom(row.assignedRoom) && overlaps(row, other))) {
      findings.push({ ...context, kind: "conflict", message: `The proposed room ${row.assignedRoom} is occupied by another class at this time.` });
    }
  }
  // A feasible preview does not repair live double bookings. They remain actionable until applied.
  const blocks = input.liveRoomBlocks ?? [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.wiseSessionId === b.wiseSessionId || physicalRoom(a.location) !== physicalRoom(b.location) || !overlaps(a, b)) continue;
      for (const [block, other] of [[a, b], [b, a]]) {
        const row = input.rows.find(row => row.wiseSessionId === block.wiseSessionId);
        findings.push({ date: input.date, kind: "conflict", wiseSessionId: block.wiseSessionId,
          tutor: row?.tutorDisplayName, className: block.className ?? undefined, room: block.location,
          startMinute: Math.max(block.startMinute, other.startMinute), endMinute: Math.min(block.endMinute, other.endMinute),
          message: `Wise has overlapping bookings in ${block.location}. Any proposed move still needs to be applied.` });
      }
    }
  }
  return [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()];
}

export function readinessForFindings(findings: WeekendFinding[]): WeekendReadiness {
  return findings.some(finding => finding.kind === "unverified") ? "unverified" : findings.length ? "attention" : "clear";
}

export function notificationForReport(readiness: WeekendReadiness, previousSentKind: string | null): "warning" | "resolved" | null {
  return readiness !== "clear" ? "warning" : previousSentKind === "warning" ? "resolved" : null;
}
