import { bangkokDateKey } from "@/lib/room-capacity/dates";
import { getLocalMinuteOfDay } from "@/lib/normalization/timezone";
import type { AssignmentSession, ExternalRoomBlock } from "./assignment-engine";
import { reconcileClassroomAssignments, type PreviousAssignmentRow } from "./reconciliation";
import { normalizeTutorName, type ClassroomRoomDefinition } from "./rooms";

/** Pure, read-only recovery planning. A missing live session is never assumed safe to move. */
export function previewClassroomRecovery(input: {
  assignmentDate: string;
  now: Date;
  liveSessions: AssignmentSession[];
  previousRows: PreviousAssignmentRow[];
  rooms: ClassroomRoomDefinition[];
  externalRoomBlocks?: ExternalRoomBlock[];
  confirmedInactiveSessionIds?: ReadonlySet<string>;
}) {
  const today = bangkokDateKey(input.now);
  const cutoff = input.assignmentDate < today ? Infinity
    : input.assignmentDate > today ? -Infinity : getLocalMinuteOfDay(input.now);
  const liveById = new Map(input.liveSessions.map(row => [row.wiseSessionId, row]));
  const all = new Map<string, AssignmentSession>(input.previousRows
    .filter(row => !input.confirmedInactiveSessionIds?.has(row.wiseSessionId))
    .map(row => [row.wiseSessionId, row]));
  for (const row of input.liveSessions) all.set(row.wiseSessionId, row);
  const frozen = [...all.values()].filter(row => row.startMinute <= cutoff || !liveById.has(row.wiseSessionId))
    .map(row => ({ ...row, freezeReason: row.startMinute <= cutoff ? "already_started" : "not_confirmed_live" }));
  const movable = input.liveSessions.filter(row => row.startMinute > cutoff);
  const externalRoomBlocks = [...(input.externalRoomBlocks ?? []), ...frozen.flatMap(row =>
    row.currentWiseLocation ? [{ wiseSessionId: row.wiseSessionId, className: null,
      location: row.currentWiseLocation, startMinute: row.startMinute, endMinute: row.endMinute }] : [])];
  const ids = new Set(movable.map(row => row.wiseSessionId));
  const currentGroupByTutor = new Map(input.liveSessions.map(row => [normalizeTutorName(row.tutorDisplayName), row.groupId]));
  const result = reconcileClassroomAssignments({ sessions: movable,
    previousRows: input.previousRows.filter(row => ids.has(row.wiseSessionId)),
    rooms: input.rooms, externalRoomBlocks,
    contextSessions: frozen.map(row => ({ ...row,
      groupId: currentGroupByTutor.get(normalizeTutorName(row.tutorDisplayName)) ?? row.groupId })),
  });
  return { generatedAt: input.now.toISOString(), assignmentDate: input.assignmentDate,
    frozen, externalRoomBlocks, ...result };
}
