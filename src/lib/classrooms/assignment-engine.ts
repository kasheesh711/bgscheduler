import {
  type ClassroomRoomDefinition,
  getPreferredRoom,
  isGiftTutor,
  NO_ROOM_AVAILABLE,
  PREFERRED_ROOMS,
  ROOM_JOY,
  TV_REQUIRED_TUTORS,
  normalizeTutorName,
} from "./rooms";

export type AssignmentRowStatus = "assigned" | "needs_review" | "no_room";

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

function normalizeSessionType(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export function isOfflineSession(value: string | null | undefined): boolean {
  return normalizeSessionType(value) === "OFFLINE";
}

export function isOnlineSession(value: string | null | undefined): boolean {
  return normalizeSessionType(value) === "ONLINE";
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
): boolean {
  const intervals = occupancy.get(roomName) ?? [];
  return !intervals.some((interval) =>
    overlaps(session.startMinute, session.endMinute, interval.startMinute, interval.endMinute),
  );
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
  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    const priorityDiff = sessionPriority(a) - sessionPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    return normalizeTutorName(a.tutorDisplayName).localeCompare(normalizeTutorName(b.tutorDisplayName));
  });

  const rows: AssignmentResultRow[] = [];

  for (const session of sortedSessions) {
    const tutorNorm = normalizeTutorName(session.tutorDisplayName);
    const { minCapacity, warnings } = inferCapacity(session);
    const needsTv = TV_REQUIRED_TUTORS.has(tutorNorm);
    const preferredRoom = getPreferredRoom(session.tutorDisplayName) ?? null;
    const isGift = isGiftTutor(session.tutorDisplayName);
    const overrideRoom = normalizeTutorName(overrideBySessionId.get(session.wiseSessionId) ?? "") || null;
    const ruleTrace: string[] = [];

    const roomOk = (roomName: string): boolean =>
      roomPassesConstraints(roomByName.get(roomName), session, minCapacity, needsTv);
    const roomAvailable = (roomName: string): boolean =>
      isAvailable(occupancy, roomName, session);
    const pickRoom = (candidates: ClassroomRoomDefinition[]): string | null => {
      const picked = candidates.find((room) => roomOk(room.name) && roomAvailable(room.name));
      return picked?.name ?? null;
    };

    let assignedRoom = "";

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
      occupancy.get(assignedRoom)?.push({
        startMinute: session.startMinute,
        endMinute: session.endMinute,
        sessionId: session.wiseSessionId,
      });
    }

    lastByTutor.set(tutorNorm, { endMinute: session.endMinute, room: assignedRoom });

    const status: AssignmentRowStatus =
      assignedRoom === NO_ROOM_AVAILABLE
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
    },
  };
}
