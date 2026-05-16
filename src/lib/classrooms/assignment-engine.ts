import {
  type ClassroomRoomDefinition,
  getPreferredRoom,
  isGiftTutor,
  isKevinPriorityTutor,
  NO_ROOM_AVAILABLE,
  PREFERRED_ROOMS,
  ROOM_JOY,
  ROOM_THINK_OUTSIDE_THE_BOX,
  TV_REQUIRED_TUTORS,
  exactWiseRoomName,
  normalizeTutorName,
} from "./rooms";
import {
  isOnlineSessionType,
  isOnsiteSessionType,
} from "./session-mode";

export const REMOTE_NO_ROOM_NEEDED = "REMOTE_NO_ROOM_NEEDED";
export const ONLINE_CENTER_CONNECTION_GAP_MINUTES = 60;

export type AssignmentRowStatus = "assigned" | "needs_review" | "no_room" | "remote";

export interface AssignmentSession {
  groupId: string;
  tutorDisplayName: string;
  wiseTeacherId: string;
  wiseTeacherUserId?: string | null;
  wiseSessionId: string;
  wiseClassId?: string | null;
  startTime: Date;
  endTime: Date;
  weekday: number;
  startMinute: number;
  endMinute: number;
  wiseStatus: string;
  sessionType?: string | null;
  currentWiseLocation?: string | null;
  studentName?: string | null;
  studentCount?: number | null;
  subject?: string | null;
  classType?: string | null;
  title?: string | null;
}

export interface AssignmentResultRow extends AssignmentSession {
  minCapacity: number;
  needsTv: boolean;
  preferredRoom: string | null;
  overrideRoom: string | null;
  assignedRoom: string;
  status: AssignmentRowStatus;
  warnings: string[];
  ruleTrace: string[];
}

export interface AssignmentCounts {
  totalSessions: number;
  assignedCount: number;
  needsReviewCount: number;
  noRoomCount: number;
  remoteCount: number;
}

export interface AssignmentResult {
  rows: AssignmentResultRow[];
  counts: AssignmentCounts;
}

interface OccupancyInterval {
  startMinute: number;
  endMinute: number;
  sessionId: string;
}

interface AssignmentSessionFacts {
  minCapacity: number;
  capacityWarnings: string[];
  needsTv: boolean;
  preferredRoom: string | null;
  isGift: boolean;
  isKevinPriority: boolean;
  overrideRoom: string | null;
  requiresCenterRoom: boolean;
}

export function isOfflineSession(value: string | null | undefined): boolean {
  return isOnsiteSessionType(value);
}

export function isOnlineSession(value: string | null | undefined): boolean {
  return isOnlineSessionType(value);
}

function hasReliableOneToOneCapacity(session: AssignmentSession): boolean {
  const classType = String(session.classType ?? "").toUpperCase();
  const title = String(session.title ?? "").toUpperCase();
  const student = String(session.studentName ?? "").trim();

  if (classType.includes("ONE") || classType.includes("1:1") || classType.includes("PERSONAL")) {
    return true;
  }
  if (/\b1\s*[:/-]\s*1\b/.test(title) || /\bONE\s*TO\s*ONE\b/.test(title)) {
    return true;
  }

  return Boolean(student) && !classType.includes("GROUP");
}

function inferCapacity(session: AssignmentSession): { minCapacity: number; warnings: string[] } {
  const count = Number(session.studentCount);
  if (Number.isFinite(count) && count > 0) {
    return { minCapacity: count, warnings: [] };
  }

  if (hasReliableOneToOneCapacity(session)) {
    return { minCapacity: 1, warnings: [] };
  }

  return { minCapacity: 1, warnings: ["needs_review_missing_capacity"] };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isAvailable(
  occupancy: Map<string, OccupancyInterval[]>,
  roomName: string,
  session: AssignmentSession,
  ignoreSessionId?: string,
): boolean {
  const intervals = occupancy.get(roomName) ?? [];
  return !intervals.some((interval) =>
    interval.sessionId !== ignoreSessionId &&
    overlaps(session.startMinute, session.endMinute, interval.startMinute, interval.endMinute),
  );
}

function addRoomInterval(
  occupancy: Map<string, OccupancyInterval[]>,
  roomName: string,
  session: AssignmentSession,
): void {
  occupancy.get(roomName)?.push({
    startMinute: session.startMinute,
    endMinute: session.endMinute,
    sessionId: session.wiseSessionId,
  });
}

function sortByCapacityThenOrder(
  a: ClassroomRoomDefinition,
  b: ClassroomRoomDefinition,
): number {
  if (a.capacity !== b.capacity) return a.capacity - b.capacity;
  return a.sortOrder - b.sortOrder;
}

function roomPassesConstraints(
  room: ClassroomRoomDefinition | undefined,
  session: AssignmentSession,
  minCapacity: number,
  needsTv: boolean,
): boolean {
  if (!room?.active) return false;
  if (room.capacity < minCapacity) return false;
  if (needsTv && !room.hasTv) return false;
  if (room.category === "online_only" && isOfflineSession(session.sessionType)) return false;
  return true;
}

function sessionPriority(session: AssignmentSession): number {
  if (isGiftTutor(session.tutorDisplayName)) return 0;
  if (getPreferredRoom(session.tutorDisplayName)) return 1;
  if (TV_REQUIRED_TUTORS.has(normalizeTutorName(session.tutorDisplayName))) return 2;
  return 3;
}

function tutorKey(session: AssignmentSession): string {
  return session.groupId || normalizeTutorName(session.tutorDisplayName);
}

function sortedTutorSessions(sessions: AssignmentSession[]): AssignmentSession[] {
  return [...sessions].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    if (a.endMinute !== b.endMinute) return a.endMinute - b.endMinute;
    return a.wiseSessionId.localeCompare(b.wiseSessionId);
  });
}

function isConnectedGap(gapMinutes: number): boolean {
  return gapMinutes < ONLINE_CENTER_CONNECTION_GAP_MINUTES;
}

function onlineSessionRequiresCenterRoom(
  session: AssignmentSession,
  tutorSessions: AssignmentSession[],
): boolean {
  if (!isOnlineSession(session.sessionType)) return true;

  const sorted = sortedTutorSessions(tutorSessions);
  const index = sorted.findIndex((candidate) => candidate.wiseSessionId === session.wiseSessionId);
  if (index === -1) return false;

  let cursorStart = session.startMinute;
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = sorted[i];
    const gap = cursorStart - previous.endMinute;
    if (!isConnectedGap(gap)) break;
    if (isOfflineSession(previous.sessionType)) return true;
    cursorStart = previous.startMinute;
  }

  let cursorEnd = session.endMinute;
  for (let i = index + 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    const gap = next.startMinute - cursorEnd;
    if (!isConnectedGap(gap)) break;
    if (isOfflineSession(next.sessionType)) return true;
    cursorEnd = next.endMinute;
  }

  return false;
}

function buildCenterRoomRequirementMap(sessions: AssignmentSession[]): Map<string, boolean> {
  const byTutor = new Map<string, AssignmentSession[]>();
  for (const session of sessions) {
    const key = tutorKey(session);
    byTutor.set(key, [...(byTutor.get(key) ?? []), session]);
  }

  const requirements = new Map<string, boolean>();
  for (const tutorSessions of byTutor.values()) {
    for (const session of tutorSessions) {
      requirements.set(
        session.wiseSessionId,
        !isOnlineSession(session.sessionType) || onlineSessionRequiresCenterRoom(session, tutorSessions),
      );
    }
  }
  return requirements;
}

function buildSessionFacts(
  session: AssignmentSession,
  centerRoomRequiredBySessionId: Map<string, boolean>,
  overrideBySessionId: Map<string, string | null | undefined>,
): AssignmentSessionFacts {
  const tutorNorm = normalizeTutorName(session.tutorDisplayName);
  const { minCapacity, warnings } = inferCapacity(session);
  const overrideRoom = exactWiseRoomName(overrideBySessionId.get(session.wiseSessionId) ?? "") || null;

  return {
    minCapacity,
    capacityWarnings: warnings,
    needsTv: TV_REQUIRED_TUTORS.has(tutorNorm),
    preferredRoom: getPreferredRoom(session.tutorDisplayName) ?? null,
    isGift: isGiftTutor(session.tutorDisplayName),
    isKevinPriority: isKevinPriorityTutor(session.tutorDisplayName),
    overrideRoom,
    requiresCenterRoom: Boolean(overrideRoom) || centerRoomRequiredBySessionId.get(session.wiseSessionId) !== false,
  };
}

export function assignClassrooms(
  sessions: AssignmentSession[],
  rooms: ClassroomRoomDefinition[],
  overrideBySessionId: Map<string, string | null | undefined> = new Map(),
): AssignmentResult {
  const activeRooms = rooms.filter((room) => room.active).sort(sortByCapacityThenOrder);
  const roomByName = new Map(activeRooms.map((room) => [room.name, room]));
  const occupancy = new Map<string, OccupancyInterval[]>();
  for (const room of activeRooms) occupancy.set(room.name, []);

  const lastByTutor = new Map<string, { endMinute: number; room: string }>();
  const centerRoomRequiredBySessionId = buildCenterRoomRequirementMap(sessions);
  const factsBySessionId = new Map(
    sessions.map((session) => [
      session.wiseSessionId,
      buildSessionFacts(session, centerRoomRequiredBySessionId, overrideBySessionId),
    ]),
  );
  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    const priorityDiff = sessionPriority(a) - sessionPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return normalizeTutorName(a.tutorDisplayName).localeCompare(normalizeTutorName(b.tutorDisplayName));
  });

  const protectedClaims = new Map<string, OccupancyInterval[]>();
  for (const room of activeRooms) protectedClaims.set(room.name, []);

  const validOverrideBySessionId = new Set<string>();
  for (const session of sortedSessions) {
    const facts = factsBySessionId.get(session.wiseSessionId);
    if (!facts?.overrideRoom) continue;
    if (!roomByName.has(facts.overrideRoom)) continue;
    if (!roomPassesConstraints(roomByName.get(facts.overrideRoom), session, facts.minCapacity, facts.needsTv)) continue;
    if (!isAvailable(protectedClaims, facts.overrideRoom, session, session.wiseSessionId)) continue;

    addRoomInterval(protectedClaims, facts.overrideRoom, session);
    validOverrideBySessionId.add(session.wiseSessionId);
  }

  const kevinPriorityClaimBySessionId = new Set<string>();
  for (const session of sortedSessions) {
    const facts = factsBySessionId.get(session.wiseSessionId);
    if (!facts?.isKevinPriority) continue;
    if (validOverrideBySessionId.has(session.wiseSessionId)) continue;
    if (!facts.requiresCenterRoom) continue;
    if (
      !roomPassesConstraints(
        roomByName.get(ROOM_THINK_OUTSIDE_THE_BOX),
        session,
        facts.minCapacity,
        facts.needsTv,
      )
    ) {
      continue;
    }
    if (!isAvailable(protectedClaims, ROOM_THINK_OUTSIDE_THE_BOX, session, session.wiseSessionId)) continue;

    addRoomInterval(protectedClaims, ROOM_THINK_OUTSIDE_THE_BOX, session);
    kevinPriorityClaimBySessionId.add(session.wiseSessionId);
  }

  const rows: AssignmentResultRow[] = [];

  for (const session of sortedSessions) {
    const tutorNorm = normalizeTutorName(session.tutorDisplayName);
    const facts = factsBySessionId.get(session.wiseSessionId)!;
    const minCapacity = facts.minCapacity;
    const warnings = [...facts.capacityWarnings];
    const needsTv = facts.needsTv;
    const preferredRoom = facts.preferredRoom;
    const isGift = facts.isGift;
    const overrideRoom = facts.overrideRoom;
    const ruleTrace: string[] = [];
    const requiresCenterRoom = facts.requiresCenterRoom;

    const roomOk = (roomName: string): boolean =>
      roomPassesConstraints(roomByName.get(roomName), session, minCapacity, needsTv);
    const roomAvailable = (roomName: string): boolean =>
      isAvailable(occupancy, roomName, session, session.wiseSessionId) &&
      isAvailable(protectedClaims, roomName, session, session.wiseSessionId);
    const pickRoom = (candidates: ClassroomRoomDefinition[]): string | null => {
      const picked = candidates.find((room) => roomOk(room.name) && roomAvailable(room.name));
      return picked?.name ?? null;
    };

    let assignedRoom = "";

    if (!requiresCenterRoom && isOnlineSession(session.sessionType)) {
      assignedRoom = REMOTE_NO_ROOM_NEEDED;
      ruleTrace.push("remote online class: no center room needed");
    }

    if (overrideRoom) {
      if (!roomByName.has(overrideRoom)) {
        warnings.push("invalid_override_room");
        ruleTrace.push(`override rejected: ${overrideRoom} is not an active room`);
      } else if (!roomOk(overrideRoom)) {
        warnings.push("invalid_override_room");
        ruleTrace.push(`override rejected: ${overrideRoom} does not meet capacity/TV/type constraints`);
      } else if (!roomAvailable(overrideRoom)) {
        warnings.push("override_room_unavailable");
        ruleTrace.push(`override rejected: ${overrideRoom} overlaps another session`);
      } else {
        assignedRoom = overrideRoom;
        ruleTrace.push(`assigned by override: ${overrideRoom}`);
      }
    }

    if (
      !assignedRoom &&
      kevinPriorityClaimBySessionId.has(session.wiseSessionId) &&
      roomOk(ROOM_THINK_OUTSIDE_THE_BOX) &&
      roomAvailable(ROOM_THINK_OUTSIDE_THE_BOX)
    ) {
      assignedRoom = ROOM_THINK_OUTSIDE_THE_BOX;
      ruleTrace.push(`assigned Kevin priority room: ${ROOM_THINK_OUTSIDE_THE_BOX}`);
    }

    if (!assignedRoom && isOnlineSession(session.sessionType)) {
      const last = lastByTutor.get(tutorNorm);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && gap < ONLINE_CENTER_CONNECTION_GAP_MINUTES && roomOk(last.room) && roomAvailable(last.room)) {
          assignedRoom = last.room;
          ruleTrace.push(`assigned by online continuity: ${last.room}`);
        }
      }
    }

    if (!assignedRoom && isGift) {
      assignedRoom = ROOM_JOY;
      ruleTrace.push(`assigned Gift fixed room: ${ROOM_JOY}`);
    }

    if (!assignedRoom) {
      const last = lastByTutor.get(tutorNorm);
      if (last) {
        const gap = session.startMinute - last.endMinute;
        if (gap >= 0 && gap <= 15 && roomOk(last.room) && roomAvailable(last.room)) {
          if (!(last.room === ROOM_JOY && !isGift)) {
            assignedRoom = last.room;
            ruleTrace.push(`assigned by continuity: ${last.room}`);
          }
        }
      }
    }

    if (!assignedRoom && preferredRoom && roomOk(preferredRoom) && roomAvailable(preferredRoom)) {
      if (!(preferredRoom === ROOM_JOY && !isGift)) {
        assignedRoom = preferredRoom;
        ruleTrace.push(`assigned preferred room: ${preferredRoom}`);
      }
    }

    if (!assignedRoom && isOnlineSession(session.sessionType)) {
      const picked = pickRoom(activeRooms.filter((room) => room.category === "online_only"));
      if (picked) {
        assignedRoom = picked;
        ruleTrace.push(`assigned online-only room: ${picked}`);
      }
    }

    if (!assignedRoom) {
      const picked = pickRoom(
        activeRooms.filter(
          (room) =>
            room.category === "standard" &&
            room.name !== ROOM_JOY &&
            !PREFERRED_ROOMS.has(room.name),
        ),
      );
      if (picked) {
        assignedRoom = picked;
        ruleTrace.push(`assigned standard non-preferred room: ${picked}`);
      }
    }

    if (!assignedRoom) {
      const picked = pickRoom(
        activeRooms.filter((room) => room.category === "standard" && room.name !== ROOM_JOY),
      );
      if (picked) {
        assignedRoom = picked;
        ruleTrace.push(`assigned standard room: ${picked}`);
      }
    }

    if (!assignedRoom && !isGift && roomOk(ROOM_JOY) && roomAvailable(ROOM_JOY)) {
      assignedRoom = ROOM_JOY;
      ruleTrace.push(`assigned Joy as fallback: ${ROOM_JOY}`);
    }

    if (!assignedRoom) {
      const picked = pickRoom(activeRooms.filter((room) => room.category === "overflow_only"));
      if (picked) {
        assignedRoom = picked;
        ruleTrace.push(`assigned overflow room: ${picked}`);
      }
    }

    if (!assignedRoom || (assignedRoom === ROOM_JOY && isGift && (!roomOk(ROOM_JOY) || !roomAvailable(ROOM_JOY)))) {
      assignedRoom = NO_ROOM_AVAILABLE;
      warnings.push("no_room_available");
      ruleTrace.push("no room available");
    }

    if (assignedRoom !== NO_ROOM_AVAILABLE && roomByName.has(assignedRoom)) {
      addRoomInterval(occupancy, assignedRoom, session);
    }

    if (assignedRoom !== NO_ROOM_AVAILABLE && assignedRoom !== REMOTE_NO_ROOM_NEEDED) {
      lastByTutor.set(tutorNorm, { endMinute: session.endMinute, room: assignedRoom });
    }

    const status: AssignmentRowStatus =
      assignedRoom === REMOTE_NO_ROOM_NEEDED
        ? "remote"
        : assignedRoom === NO_ROOM_AVAILABLE
        ? "no_room"
        : warnings.includes("needs_review_missing_capacity")
          ? "needs_review"
          : "assigned";

    rows.push({
      ...session,
      minCapacity,
      needsTv,
      preferredRoom,
      overrideRoom,
      assignedRoom,
      status,
      warnings,
      ruleTrace,
    });
  }

  rows.sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    return normalizeTutorName(a.tutorDisplayName).localeCompare(normalizeTutorName(b.tutorDisplayName));
  });

  return {
    rows,
    counts: {
      totalSessions: rows.length,
      assignedCount: rows.filter((row) => row.status === "assigned").length,
      needsReviewCount: rows.filter((row) => row.status === "needs_review").length,
      noRoomCount: rows.filter((row) => row.status === "no_room").length,
      remoteCount: rows.filter((row) => row.status === "remote").length,
    },
  };
}
