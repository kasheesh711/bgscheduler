import { assignmentTutorKey, CONTINUITY_GAP_MINUTES, physicalRoom, policiesFromMetadata, policyForTutor, roomQualityMetrics } from "./room-policy";
import { isOnsiteSessionType } from "./session-mode";

export interface ScheduleSourceRow {
  id: string;
  canonicalKey?: string | null;
  tutorDisplayName: string;
  wiseSessionId?: string;
  startMinute: number;
  endMinute: number;
  assignedRoom: string;
  status: string;
  publishStatus?: string;
  sessionType?: string | null;
  studentName?: string | null;
  subject?: string | null;
  classType?: string | null;
  title?: string | null;
  warnings?: string[];
}

export function formatScheduleMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function buildTeacherSchedule(rows: ScheduleSourceRow[], date: string, metadata: Record<string, unknown> = {}) {
  const policies = policiesFromMetadata(metadata);
  const byTutor = new Map<string, ScheduleSourceRow[]>();
  for (const row of rows) {
    const key = assignmentTutorKey(row);
    byTutor.set(key, [...(byTutor.get(key) ?? []), row]);
  }
  const tutors = [...byTutor].map(([canonicalKey, group]) => {
    group.sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.id.localeCompare(b.id));
    const policy = policyForTutor(group[0], policies);
    const usualRooms = policy?.rooms ?? [];
    const blocks = group.map((row, index) => {
      const prior = group[index - 1];
      const physical = ["assigned", "needs_review"].includes(row.status);
      const priorPhysical = prior && ["assigned", "needs_review"].includes(prior.status);
      const roomChange = Boolean(physical && priorPhysical && row.startMinute >= prior.endMinute && physicalRoom(row.assignedRoom) !== physicalRoom(prior.assignedRoom));
      const shortGapChange = roomChange && row.startMinute - prior.endMinute <= CONTINUITY_GAP_MINUTES;
      const outsideUsualRooms = physical && usualRooms.length > 0 && !usualRooms.some(room => physicalRoom(room) === physicalRoom(row.assignedRoom));
      const exceptionReasons = [
        ...(outsideUsualRooms ? ["Outside usual rooms for this class"] : []),
        ...(shortGapChange ? ["Room change between consecutive classes"] : []),
        ...(policy?.unavailableRooms?.length ? [`Usual room unavailable: ${policy.unavailableRooms.join(", ")}`] : []),
        ...(row.status === "no_room" ? ["Room not yet assigned — check with the team"] : []),
        ...(row.status === "needs_review" ? ["Assignment needs review"] : []),
      ];
      const publication = row.status === "remote" ? "remote" : row.status !== "assigned" ? "needs_review"
        : row.publishStatus === "failed" ? "failed" : isOnsiteSessionType(row.sessionType) && row.publishStatus !== "success" ? "draft" : "ready";
      return { rowId: row.id, date, startMinute: row.startMinute, endMinute: row.endMinute,
        startTime: formatScheduleMinute(row.startMinute), endTime: formatScheduleMinute(row.endMinute),
        room: row.status === "remote" ? "Remote / no room needed" : row.status === "no_room" ? "Room TBC" : row.assignedRoom,
        status: row.status, publication, sessionType: row.sessionType ?? null,
        studentName: row.studentName ?? null, subject: row.subject ?? null, classType: row.classType ?? null, title: row.title ?? null,
        roomChange, shortGapChange, outsideUsualRooms, exceptionReasons };
    });
    return { canonicalKey, tutorDisplayName: group[0].tutorDisplayName, usualRooms,
      unavailableRooms: policy?.unavailableRooms ?? [],
      roomChanges: blocks.filter(block => block.shortGapChange).length, blocks };
  }).sort((a, b) => a.tutorDisplayName.localeCompare(b.tutorDisplayName) || a.canonicalKey.localeCompare(b.canonicalKey));
  return { tutors, quality: roomQualityMetrics(rows.map(row => ({ ...row, wiseSessionId: row.wiseSessionId ?? row.id })), policies) };
}

export type ProjectedTeacherSchedule = ReturnType<typeof buildTeacherSchedule>;
