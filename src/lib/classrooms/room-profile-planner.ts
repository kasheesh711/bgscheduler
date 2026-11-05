import type { AssignmentSession } from "./assignment-engine";
import { CORE_TEACHING_ROOM_RANK, DEFAULT_CLASSROOM_ROOMS, getPreferredRoom, getPriorityPreferredRoom, isGiftTutor, ROOM_JOY, TV_REQUIRED_TUTORS, type ClassroomRoomDefinition } from "./rooms";
import { physicalRoom, type TutorRoomPolicy } from "./room-policy";
import { isOnsiteSessionType } from "./session-mode";
import { bangkokDateKey } from "@/lib/room-capacity/dates";

// Same fill order as the engine, so new profiles take the right wing before spare TV rooms.
const rank = (room: { name: string }) => CORE_TEACHING_ROOM_RANK.get(room.name) ?? 1_000;

export interface ProfileRoom extends ClassroomRoomDefinition { id: string }
export interface RoomUse { canonicalKey: string; room: string; minutes: number }
export interface ProposedRoomProfile { canonicalKey: string; tutorDisplayName: string; roomIds: string[] }

/**
 * Only resolved snapshot identities become persistent profiles. By default existing profiles are never rebuilt.
 * `replan` also re-plans tutors that have a set, keeping their primary room; the result is a suggestion for review only.
 */
export function proposeRoomProfiles(input: {
  sessions: AssignmentSession[];
  rooms: ProfileRoom[];
  history: RoomUse[];
  existing: TutorRoomPolicy[];
  replan?: boolean;
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
    const current = existing.get(canonicalKey);
    if (current && !input.replan) continue;
    const tutorDisplayName = sessions[0].tutorDisplayName;
    const needsTv = TV_REQUIRED_TUTORS.has(tutorDisplayName);
    const gift = isGiftTutor(tutorDisplayName);
    // Joy is Gift's fixed room, so the engine gives it to others only as a last resort.
    const allowed = (room: ProfileRoom) => gift || room.name !== ROOM_JOY;
    const keptPrimary = current && standardRooms.find(room => room.name === current.rooms[0] && room.active && allowed(room) && (!needsTv || room.hasTv))?.name;
    const anchor = getPreferredRoom(tutorDisplayName) ?? keptPrimary;
    const compatible = (row: AssignmentSession, room: ProfileRoom) => room.capacity >= Math.max(1, row.studentCount ?? 1) && (!needsTv || room.hasTv);
    const duration = (row: AssignmentSession) => Math.max(0, row.endMinute - row.startMinute);
    const roomScores = standardRooms.filter(room => (room.active || room.name === anchor) && allowed(room)).map(room => {
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
      .sort((a, b) => Number(b.room.name === anchor) - Number(a.room.name === anchor) || b.usable - a.usable || a.contention - b.contention || b.history - a.history || a.room.capacity - b.room.capacity || rank(a.room) - rank(b.room) || a.room.sortOrder - b.room.sortOrder || a.room.name.localeCompare(b.room.name));
    const selected = roomScores.slice(0, gift ? 1 : 3).map(score => score.room);
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
