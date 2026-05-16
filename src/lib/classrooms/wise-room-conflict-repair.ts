import {
  getWiseSessionClassId,
  getWiseSessionClassName,
  getWiseSessionClassSubject,
  getWiseSessionTeacherUserId,
  getWiseUserName,
  type WiseSession,
} from "@/lib/wise/types";
import { isBlockingStatus } from "@/lib/normalization/sessions";
import {
  DEFAULT_CLASSROOM_ROOMS,
  exactWiseRoomName,
  ROOM_RELAX_TV,
  tvRoomRepairLocation,
} from "./rooms";

export const WISE_EMERGENCY_REPAIR_DISABLED_MESSAGE =
  "Wise emergency repair is disabled. Set ENABLE_WISE_EMERGENCY_REPAIR=true only for an approved incident repair.";

export interface EmergencyRepairSession {
  wiseSessionId: string;
  wiseClassId?: string;
  tutorName: string;
  studentName?: string;
  subject?: string;
  title?: string;
  status?: string;
  sessionType?: string;
  location: string;
  startTime: Date;
  endTime: Date;
  startTimeBangkok: string;
  endTimeBangkok: string;
  durationMinutes: number;
}

export interface RoomConflict {
  physicalRoom: string;
  overlapStartBangkok: string;
  overlapEndBangkok: string;
  sessions: [EmergencyRepairSession, EmergencyRepairSession];
}

export interface InvalidPlainTvLocation {
  wiseSessionId: string;
  wiseClassId?: string;
  tutorName: string;
  studentName?: string;
  startTimeBangkok: string;
  wrongLocation: string;
  intendedLocation: string;
  includedInRepairPlan: boolean;
}

export interface EmergencyRepairProposal {
  wiseSessionId: string;
  wiseClassId?: string;
  tutorName: string;
  studentName?: string;
  startTimeBangkok: string;
  endTimeBangkok: string;
  fromLocation: string;
  toLocation: string;
  reason: "move_conflicting_session" | "repair_plain_tv_location";
}

export interface ManualRepairRequired {
  reason: string;
  conflict: RoomConflict;
}

export interface EmergencyRepairPlan {
  date: string;
  approvedRooms: string[];
  conflicts: RoomConflict[];
  invalidPlainTvLocations: InvalidPlainTvLocation[];
  proposals: EmergencyRepairProposal[];
  remainingConflictsAfterPlan: RoomConflict[];
  manualRequired: ManualRepairRequired[];
  confirmationToken: string;
  requiredSessionIds: string[];
}

export interface ApplyGuardInput {
  date: string;
  proposals: EmergencyRepairProposal[];
  confirm?: string;
  sessionIds?: string[];
  env?: NodeJS.ProcessEnv;
}

const BANGKOK_TIME_ZONE = "Asia/Bangkok";
const BANGKOK_PARTS_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: BANGKOK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const ROOM_REPAIR_PRIORITY = [
  ROOM_RELAX_TV,
  "Tesla",
  "Dream. Plan. Do.",
];

function bangkokParts(value: Date): Map<string, string> {
  return new Map(BANGKOK_PARTS_FORMATTER.formatToParts(value).map((part) => [part.type, part.value]));
}

function bangkokWallClockTimestamp(value: Date): Date {
  const parts = bangkokParts(value);
  return new Date(Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour") ?? "0") % 24,
    Number(parts.get("minute") ?? "0"),
  ));
}

export function formatBangkokDate(value: Date): string {
  const parts = bangkokParts(value);
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function formatBangkokDateTime(value: Date): string {
  const parts = bangkokParts(value);
  const hour = String(Number(parts.get("hour") ?? "0") % 24).padStart(2, "0");
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")} ${hour}:${parts.get("minute")}`;
}

export function physicalRoomKey(location: string | null | undefined): string {
  return exactWiseRoomName(location).replace(/\s+\(TV\)$/i, "").trim().toLowerCase();
}

function physicalRoomLabel(location: string): string {
  return exactWiseRoomName(location).replace(/\s+\(TV\)$/i, "").trim();
}

function overlaps(left: Pick<EmergencyRepairSession, "startTime" | "endTime">, right: Pick<EmergencyRepairSession, "startTime" | "endTime">): boolean {
  return left.startTime < right.endTime && right.startTime < left.endTime;
}

function overlapStart(left: EmergencyRepairSession, right: EmergencyRepairSession): Date {
  return new Date(Math.max(left.startTime.getTime(), right.startTime.getTime()));
}

function overlapEnd(left: EmergencyRepairSession, right: EmergencyRepairSession): Date {
  return new Date(Math.min(left.endTime.getTime(), right.endTime.getTime()));
}

export function isWiseSessionBlockingForRepair(session: WiseSession): boolean {
  if (!isBlockingStatus(session.meetingStatus)) return false;
  const marker = `${session.meetingStatus ?? ""} ${session.title ?? ""}`.toUpperCase();
  return !marker.includes("CANCELLED") && !marker.includes("CANCELED");
}

export function normalizeWiseSessionForRepair(session: WiseSession): EmergencyRepairSession | null {
  if (!session.location?.trim()) return null;
  if (!isWiseSessionBlockingForRepair(session)) return null;

  const rawStartTime = new Date(session.scheduledStartTime);
  const rawEndTime = new Date(session.scheduledEndTime);
  if (Number.isNaN(rawStartTime.getTime()) || Number.isNaN(rawEndTime.getTime())) return null;

  // Match the app's production snapshot convention: Wise instants are first
  // converted to Bangkok wall-clock timestamps, then displayed as Bangkok time.
  const startTime = bangkokWallClockTimestamp(rawStartTime);
  const endTime = bangkokWallClockTimestamp(rawEndTime);

  const tutorName =
    session.teacherName ??
    getWiseUserName(session.userId) ??
    session.teacherId ??
    getWiseSessionTeacherUserId(session) ??
    "Unknown tutor";

  return {
    wiseSessionId: session._id,
    wiseClassId: getWiseSessionClassId(session),
    tutorName,
    studentName: getWiseSessionClassName(session),
    subject: getWiseSessionClassSubject(session),
    title: session.title,
    status: session.meetingStatus,
    sessionType: session.type,
    location: session.location.trim(),
    startTime,
    endTime,
    startTimeBangkok: formatBangkokDateTime(startTime),
    endTimeBangkok: formatBangkokDateTime(endTime),
    durationMinutes: Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 60_000)),
  };
}

export function sessionsForBangkokDate(
  wiseSessions: WiseSession[],
  date: string,
): EmergencyRepairSession[] {
  return wiseSessions
    .map(normalizeWiseSessionForRepair)
    .filter((session): session is EmergencyRepairSession => Boolean(session))
    .filter((session) => formatBangkokDate(session.startTime) === date);
}

function cloneSessionWithLocation(
  session: EmergencyRepairSession,
  location: string,
): EmergencyRepairSession {
  return { ...session, location };
}

export function detectRoomConflicts(sessions: EmergencyRepairSession[]): RoomConflict[] {
  const conflicts: RoomConflict[] = [];
  const sorted = [...sessions].sort((left, right) => (
    left.startTime.getTime() - right.startTime.getTime() ||
    left.wiseSessionId.localeCompare(right.wiseSessionId)
  ));

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const left = sorted[i];
      const right = sorted[j];
      if (right.startTime >= left.endTime) break;
      if (physicalRoomKey(left.location) !== physicalRoomKey(right.location)) continue;
      if (!overlaps(left, right)) continue;
      conflicts.push({
        physicalRoom: physicalRoomLabel(left.location),
        overlapStartBangkok: formatBangkokDateTime(overlapStart(left, right)),
        overlapEndBangkok: formatBangkokDateTime(overlapEnd(left, right)),
        sessions: [left, right],
      });
    }
  }

  return conflicts;
}

export function approvedEmergencyRepairRooms(
  wiseLocations: Iterable<string> | null | undefined = undefined,
): string[] {
  const wiseLocationSet = wiseLocations ? new Set([...wiseLocations].map((location) => location.trim())) : null;
  const rooms = DEFAULT_CLASSROOM_ROOMS
    .filter((room) => room.active && room.category !== "online_only")
    .map((room) => room.name)
    .filter((roomName) => !wiseLocationSet || wiseLocationSet.has(roomName));

  return [
    ...ROOM_REPAIR_PRIORITY.filter((roomName) => rooms.includes(roomName)),
    ...rooms.filter((roomName) => !ROOM_REPAIR_PRIORITY.includes(roomName)),
  ];
}

function isRoomFree(
  roomName: string,
  session: EmergencyRepairSession,
  sessions: EmergencyRepairSession[],
): boolean {
  const target = physicalRoomKey(roomName);
  return !sessions.some((candidate) => (
    candidate.wiseSessionId !== session.wiseSessionId &&
    physicalRoomKey(candidate.location) === target &&
    overlaps(session, candidate)
  ));
}

export function availableRoomsForSession(
  session: EmergencyRepairSession,
  sessions: EmergencyRepairSession[],
  approvedRooms: string[],
): string[] {
  return approvedRooms.filter((roomName) => isRoomFree(roomName, session, sessions));
}

function chooseConflictMover(conflict: RoomConflict): EmergencyRepairSession {
  const [left, right] = conflict.sessions;
  if (left.durationMinutes !== right.durationMinutes) {
    return left.durationMinutes < right.durationMinutes ? left : right;
  }

  const leftPlainTv = Boolean(tvRoomRepairLocation(left.location));
  const rightPlainTv = Boolean(tvRoomRepairLocation(right.location));
  if (leftPlainTv !== rightPlainTv) return leftPlainTv ? left : right;

  return left.wiseSessionId.localeCompare(right.wiseSessionId) <= 0 ? left : right;
}

function proposalFromSession(
  session: EmergencyRepairSession,
  toLocation: string,
  reason: EmergencyRepairProposal["reason"],
): EmergencyRepairProposal {
  return {
    wiseSessionId: session.wiseSessionId,
    wiseClassId: session.wiseClassId,
    tutorName: session.tutorName,
    studentName: session.studentName,
    startTimeBangkok: session.startTimeBangkok,
    endTimeBangkok: session.endTimeBangkok,
    fromLocation: session.location,
    toLocation,
    reason,
  };
}

function sameCurrentConflict(conflict: RoomConflict, sessions: EmergencyRepairSession[]): RoomConflict | null {
  const left = sessions.find((session) => session.wiseSessionId === conflict.sessions[0].wiseSessionId);
  const right = sessions.find((session) => session.wiseSessionId === conflict.sessions[1].wiseSessionId);
  if (!left || !right) return null;
  if (physicalRoomKey(left.location) !== physicalRoomKey(right.location) || !overlaps(left, right)) return null;
  return {
    physicalRoom: physicalRoomLabel(left.location),
    overlapStartBangkok: formatBangkokDateTime(overlapStart(left, right)),
    overlapEndBangkok: formatBangkokDateTime(overlapEnd(left, right)),
    sessions: [left, right],
  };
}

export function buildEmergencyRepairPlan(
  date: string,
  sessions: EmergencyRepairSession[],
  wiseLocations?: Iterable<string>,
): EmergencyRepairPlan {
  const approvedRooms = approvedEmergencyRepairRooms(wiseLocations);
  const originalConflicts = detectRoomConflicts(sessions);
  const working = new Map(sessions.map((session) => [session.wiseSessionId, session]));
  const proposals = new Map<string, EmergencyRepairProposal>();
  const manualRequired: ManualRepairRequired[] = [];

  const currentSessions = () => [...working.values()];

  for (const originalConflict of originalConflicts) {
    const conflict = sameCurrentConflict(originalConflict, currentSessions());
    if (!conflict) continue;

    const mover = chooseConflictMover(conflict);
    const freeRooms = availableRoomsForSession(mover, currentSessions(), approvedRooms)
      .filter((roomName) => physicalRoomKey(roomName) !== physicalRoomKey(mover.location));
    const targetRoom = freeRooms[0];
    if (!targetRoom) {
      manualRequired.push({ reason: "No approved room is free for the shorter conflicting session", conflict });
      continue;
    }

    proposals.set(
      mover.wiseSessionId,
      proposalFromSession(mover, targetRoom, "move_conflicting_session"),
    );
    working.set(mover.wiseSessionId, cloneSessionWithLocation(mover, targetRoom));

    for (const session of conflict.sessions) {
      if (session.wiseSessionId === mover.wiseSessionId || proposals.has(session.wiseSessionId)) continue;
      const intendedLocation = tvRoomRepairLocation(session.location);
      if (!intendedLocation) continue;
      const current = working.get(session.wiseSessionId) ?? session;
      if (!isRoomFree(intendedLocation, current, currentSessions())) continue;
      proposals.set(
        session.wiseSessionId,
        proposalFromSession(current, intendedLocation, "repair_plain_tv_location"),
      );
      working.set(session.wiseSessionId, cloneSessionWithLocation(current, intendedLocation));
    }
  }

  const proposalList = [...proposals.values()];
  const proposalIds = new Set(proposalList.map((proposal) => proposal.wiseSessionId));
  const invalidPlainTvLocations = sessions.flatMap((session): InvalidPlainTvLocation[] => {
    const intendedLocation = tvRoomRepairLocation(session.location);
    if (!intendedLocation) return [];
    return [{
      wiseSessionId: session.wiseSessionId,
      wiseClassId: session.wiseClassId,
      tutorName: session.tutorName,
      studentName: session.studentName,
      startTimeBangkok: session.startTimeBangkok,
      wrongLocation: session.location,
      intendedLocation,
      includedInRepairPlan: proposalIds.has(session.wiseSessionId),
    }];
  });
  const remainingConflictsAfterPlan = detectRoomConflicts(currentSessions());

  return {
    date,
    approvedRooms,
    conflicts: originalConflicts,
    invalidPlainTvLocations,
    proposals: proposalList,
    remainingConflictsAfterPlan,
    manualRequired,
    confirmationToken: `${date}:${proposalList.length}`,
    requiredSessionIds: proposalList.map((proposal) => proposal.wiseSessionId).sort(),
  };
}

export function assertEmergencyRepairApplyAllowed(input: ApplyGuardInput): void {
  const env = input.env ?? process.env;
  if (env.ENABLE_WISE_EMERGENCY_REPAIR !== "true") {
    throw new Error(WISE_EMERGENCY_REPAIR_DISABLED_MESSAGE);
  }

  if (input.proposals.length === 0) {
    throw new Error("Emergency repair apply refused: no proposed changes.");
  }

  const expectedConfirm = `${input.date}:${input.proposals.length}`;
  if (input.confirm !== expectedConfirm) {
    throw new Error(`Emergency repair apply refused: expected --confirm ${expectedConfirm}.`);
  }

  const expectedSessionIds = input.proposals.map((proposal) => proposal.wiseSessionId).sort();
  const actualSessionIds = [...(input.sessionIds ?? [])].sort();
  if (
    actualSessionIds.length !== expectedSessionIds.length ||
    actualSessionIds.some((sessionId, index) => sessionId !== expectedSessionIds[index])
  ) {
    throw new Error(`Emergency repair apply refused: expected --session-ids ${expectedSessionIds.join(",")}.`);
  }

  const missingClassId = input.proposals.find((proposal) => !proposal.wiseClassId);
  if (missingClassId) {
    throw new Error(`Emergency repair apply refused: session ${missingClassId.wiseSessionId} is missing a Wise class id.`);
  }
}
