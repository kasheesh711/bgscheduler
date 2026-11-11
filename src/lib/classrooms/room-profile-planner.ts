import type { AssignmentSession } from "./assignment-engine";
import { CORE_TEACHING_ROOM_RANK, DEFAULT_CLASSROOM_ROOMS, getPreferredRoom, getPriorityPreferredRoom, isGiftTutor, TV_REQUIRED_TUTORS, type ClassroomRoomDefinition } from "./rooms";
import { physicalRoom, type TutorRoomPolicy } from "./room-policy";
import { isOnsiteSessionType } from "./session-mode";
import { roomProximityScore } from "./floor-plan";
import { classroomTimestampToWiseIso } from "./timestamps";
import { bangkokDateKey } from "@/lib/room-capacity/dates";

// Same fill order as the engine, so new profiles take the right wing before spare TV rooms.
const rank = (room: { name: string }) => CORE_TEACHING_ROOM_RANK.get(room.name) ?? 1_000;

export interface ProfileRoom extends ClassroomRoomDefinition { id: string }
export interface RoomUse { canonicalKey: string; room: string; minutes: number }
export interface ProposedRoomProfile { canonicalKey: string; tutorDisplayName: string; roomIds: string[] }

/** Only resolved identities receive profiles; callers decide which existing profiles to preserve. */
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
    const date = bangkokDateKey(new Date(classroomTimestampToWiseIso(row.startTime)));
    byDate.set(date, [...(byDate.get(date) ?? []), row]);
  }
  const peersBySession = new Map(input.sessions.map(row => [row.wiseSessionId,
    (byDate.get(bangkokDateKey(new Date(classroomTimestampToWiseIso(row.startTime)))) ?? []).filter(other => other.canonicalKey?.toLowerCase() !== row.canonicalKey?.toLowerCase()
      && other.startMinute < row.endMinute && row.startMinute < other.endMinute),
  ]));
  const standardRooms = input.rooms.filter(room => room.category === "standard");
  const load = new Map<string, number>();
  for (const [key, rows] of tutors) {
    const primary = existing.get(key)?.rooms[0] ?? getPreferredRoom(rows[0].tutorDisplayName);
    if (primary) load.set(primary, (load.get(primary) ?? 0) + rows.reduce((sum, row) => sum + row.endMinute - row.startMinute, 0));
  }
  const sorted = [...tutors].sort(([a, aa], [b, bb]) => {
    const aTv = TV_REQUIRED_TUTORS.has(aa[0].tutorDisplayName), bTv = TV_REQUIRED_TUTORS.has(bb[0].tutorDisplayName);
    return Number(Boolean(getPreferredRoom(bb[0].tutorDisplayName))) - Number(Boolean(getPreferredRoom(aa[0].tutorDisplayName)))
      || Number(bTv) - Number(aTv)
      || bb.reduce((sum, row) => sum + row.endMinute - row.startMinute, 0) - aa.reduce((sum, row) => sum + row.endMinute - row.startMinute, 0)
      || a.localeCompare(b);
  });
  for (const [canonicalKey, sessions] of sorted) {
    if (existing.has(canonicalKey)) continue;
    const tutorDisplayName = sessions[0].tutorDisplayName;
    const anchor = getPreferredRoom(tutorDisplayName);
    const needsTv = TV_REQUIRED_TUTORS.has(tutorDisplayName);
    const compatible = (row: AssignmentSession, room: ProfileRoom) => room.capacity >= Math.max(1, row.studentCount ?? 1) && (!needsTv || room.hasTv);
    const duration = (row: AssignmentSession) => Math.max(0, row.endMinute - row.startMinute);
    const roomScores = standardRooms.filter(room => (room.active || room.name === anchor) && (room.name !== "Joy (TV)" || isGiftTutor(tutorDisplayName))).map(room => {
      let usable = 0, contention = 0;
      for (const row of sessions) {
        if (!room.active || !compatible(row, room)) continue;
        const peers = peersBySession.get(row.wiseSessionId) ?? [];
        const hardConflict = peers.some(other => physicalRoom(getPriorityPreferredRoom(other.tutorDisplayName) ?? (isGiftTutor(other.tutorDisplayName) ? getPreferredRoom(other.tutorDisplayName)! : "")) === physicalRoom(room.name));
        if (!hardConflict) usable += duration(row);
        contention += peers.filter(other => {
          const primary = existing.get(other.canonicalKey?.toLowerCase() ?? "")?.rooms[0] ?? getPreferredRoom(other.tutorDisplayName) ?? "";
          return physicalRoom(primary) === physicalRoom(room.name);
        }).reduce((sum, other) => sum + Math.min(row.endMinute, other.endMinute) - Math.max(row.startMinute, other.startMinute), 0);
      }
      const history = input.history.filter(use => use.canonicalKey.toLowerCase() === canonicalKey && physicalRoom(use.room) === physicalRoom(room.name)).reduce((sum, use) => sum + use.minutes, 0);
      return { room, usable, contention, history };
    }).filter(score => score.room.name === anchor || (score.usable > 0 && (!needsTv || score.room.hasTv)))
      .sort((a, b) => Number(b.room.name === anchor) - Number(a.room.name === anchor) || b.usable - a.usable || a.contention - b.contention || (load.get(a.room.name) ?? 0) - (load.get(b.room.name) ?? 0) || b.history - a.history || a.room.capacity - b.room.capacity || rank(a.room) - rank(b.room) || a.room.sortOrder - b.room.sortOrder || a.room.name.localeCompare(b.room.name));
    const primary = roomScores[0]?.room;
    if (!primary) continue;
    const reserve = isGiftTutor(tutorDisplayName) ? undefined : roomScores.filter(score => score.room.name !== primary.name && score.room.active)
      .sort((a, b) => b.usable - a.usable
        || roomProximityScore(primary.name, a.room.name) - roomProximityScore(primary.name, b.room.name)
        || a.contention - b.contention
        || (load.get(a.room.name) ?? 0) - (load.get(b.room.name) ?? 0) || a.room.sortOrder - b.room.sortOrder)[0]?.room;
    const selected = reserve ? [primary, reserve] : [primary];
    if (!anchor) load.set(primary.name, (load.get(primary.name) ?? 0) + sessions.reduce((sum, row) => sum + duration(row), 0));
    result.push({ canonicalKey, tutorDisplayName, roomIds: selected.map(room => room.id) });
    existing.set(canonicalKey, { canonicalKey, revision: 1, rooms: selected.map(room => room.name) });
  }
  return result;
}

export function existingPreferredRoom(tutorName: string): string | undefined {
  const name = getPreferredRoom(tutorName);
  return DEFAULT_CLASSROOM_ROOMS.find(room => room.name === name)?.name;
}
