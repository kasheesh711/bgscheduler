import type { AssignmentSession } from "./assignment-engine";
import { DEFAULT_CLASSROOM_ROOMS, getPreferredRoom, getPriorityPreferredRoom, isGiftTutor, TV_REQUIRED_TUTORS, type ClassroomRoomDefinition } from "./rooms";
import { physicalRoom, type TutorRoomPolicy } from "./room-policy";
import { isOnsiteSessionType } from "./session-mode";
import { bangkokDateKey } from "@/lib/room-capacity/dates";

export interface ProfileRoom extends ClassroomRoomDefinition { id: string }
export interface RoomUse { canonicalKey: string; room: string; minutes: number }
export interface ProposedRoomProfile { canonicalKey: string; tutorDisplayName: string; roomIds: string[] }

/** Only resolved snapshot identities become persistent profiles; existing profiles are never rebuilt. */
export function proposeRoomProfiles(input: {
  sessions: AssignmentSession[];
  rooms: ProfileRoom[];
  history: RoomUse[];
  existing: TutorRoomPolicy[];
}): ProposedRoomProfile[] {
  const existing = new Map(input.existing.map(profile => [profile.canonicalKey.toLowerCase(), profile]));
  const tutors = new Map<string, AssignmentSession[]>();
  for (const row of input.sessions) {
    if (!row.canonicalKey || !isOnsiteSessionType(row.sessionType)) continue;
    const key = row.canonicalKey.toLowerCase();
    tutors.set(key, [...(tutors.get(key) ?? []), row]);
  }
  const result: ProposedRoomProfile[] = [];
  const byDate = new Map<string, AssignmentSession[]>();
  for (const row of input.sessions) {
    if (!isOnsiteSessionType(row.sessionType)) continue;
    const date = bangkokDateKey(row.startTime);
    byDate.set(date, [...(byDate.get(date) ?? []), row]);
  }
  const peersBySession = new Map(input.sessions.map(row => [row.wiseSessionId,
    (byDate.get(bangkokDateKey(row.startTime)) ?? []).filter(other => other.canonicalKey?.toLowerCase() !== row.canonicalKey?.toLowerCase()
      && other.startMinute < row.endMinute && row.startMinute < other.endMinute),
  ]));
  const standardRooms = input.rooms.filter(room => room.category === "standard");
  const sorted = [...tutors].sort(([a, aa], [b, bb]) => {
    const aTv = TV_REQUIRED_TUTORS.has(aa[0].tutorDisplayName), bTv = TV_REQUIRED_TUTORS.has(bb[0].tutorDisplayName);
    return Number(bTv) - Number(aTv) || a.localeCompare(b);
  });
  for (const [canonicalKey, sessions] of sorted) {
    if (existing.has(canonicalKey)) continue;
    const tutorDisplayName = sessions[0].tutorDisplayName;
    const anchor = getPreferredRoom(tutorDisplayName);
    const needsTv = TV_REQUIRED_TUTORS.has(tutorDisplayName);
    const compatible = (row: AssignmentSession, room: ProfileRoom) => room.capacity >= Math.max(1, row.studentCount ?? 1) && (!needsTv || room.hasTv);
    const duration = (row: AssignmentSession) => Math.max(0, row.endMinute - row.startMinute);
    const roomScores = standardRooms.filter(room => room.active || room.name === anchor).map(room => {
      let usable = 0, contention = 0;
      for (const row of sessions) {
        if (!room.active || !compatible(row, room)) continue;
        const peers = peersBySession.get(row.wiseSessionId) ?? [];
        const hardConflict = peers.some(other => physicalRoom(getPriorityPreferredRoom(other.tutorDisplayName) ?? (isGiftTutor(other.tutorDisplayName) ? getPreferredRoom(other.tutorDisplayName)! : "")) === physicalRoom(room.name));
        if (!hardConflict) usable += duration(row);
        contention += peers.filter(other => {
          const usual = existing.get(other.canonicalKey?.toLowerCase() ?? "")?.rooms ?? [getPreferredRoom(other.tutorDisplayName) ?? ""];
          return usual.some(name => physicalRoom(name) === physicalRoom(room.name));
        }).reduce((sum, other) => sum + Math.min(row.endMinute, other.endMinute) - Math.max(row.startMinute, other.startMinute), 0);
      }
      const history = input.history.filter(use => use.canonicalKey.toLowerCase() === canonicalKey && physicalRoom(use.room) === physicalRoom(room.name)).reduce((sum, use) => sum + use.minutes, 0);
      return { room, usable, contention, history };
    }).filter(score => score.room.name === anchor || (score.usable > 0 && (!needsTv || score.room.hasTv)))
      .sort((a, b) => Number(b.room.name === anchor) - Number(a.room.name === anchor) || b.usable - a.usable || a.contention - b.contention || b.history - a.history || a.room.capacity - b.room.capacity || a.room.sortOrder - b.room.sortOrder || a.room.name.localeCompare(b.room.name));
    const selected = roomScores.slice(0, isGiftTutor(tutorDisplayName) ? 1 : 3).map(score => score.room);
    if (!selected.length) continue;
    result.push({ canonicalKey, tutorDisplayName, roomIds: selected.map(room => room.id) });
    existing.set(canonicalKey, { canonicalKey, revision: 1, rooms: selected.map(room => room.name) });
  }
  return result;
}

export function existingPreferredRoom(tutorName: string): string | undefined {
  const name = getPreferredRoom(tutorName);
  return DEFAULT_CLASSROOM_ROOMS.find(room => room.name === name)?.name;
}
