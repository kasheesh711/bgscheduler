import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays } from "@/lib/room-capacity/dates";
import { existingPreferredRoom, proposeRoomProfiles, type ProfileRoom } from "./room-profile-planner";
import { type TutorRoomPolicy } from "./room-policy";
import { isGiftTutor, TV_REQUIRED_TUTORS } from "./rooms";

export type RoomProfile = typeof schema.classroomTutorRoomProfiles.$inferSelect;
const roomIds = (profile: RoomProfile) => [profile.primaryRoomId, profile.secondaryRoomId, profile.thirdRoomId].filter((id): id is string => Boolean(id));

export async function listTutorRoomProfiles(db: Database) {
  // Read paths must never seed the room catalog or create policies.
  const [profiles, rooms] = await Promise.all([
    db.select().from(schema.classroomTutorRoomProfiles).orderBy(schema.classroomTutorRoomProfiles.canonicalKey),
    db.select().from(schema.classroomRooms).orderBy(schema.classroomRooms.sortOrder),
  ]);
  const byId = new Map(rooms.map(room => [room.id, room]));
  return { rooms, profiles: profiles.map(profile => ({ ...profile, roomIds: roomIds(profile),
    rooms: roomIds(profile).map(id => byId.get(id)!),
    preferredRoom: existingPreferredRoom(profile.tutorDisplayName) ?? null,
  })) };
}

export function toRoomPolicies(profiles: Awaited<ReturnType<typeof listTutorRoomProfiles>>["profiles"]): Map<string, TutorRoomPolicy> {
  return new Map(profiles.map(profile => [profile.canonicalKey.toLowerCase(), {
    canonicalKey: profile.canonicalKey, revision: profile.revision,
    rooms: profile.rooms.map(room => room.name),
    unavailableRooms: profile.rooms.filter(room => !room.active || room.category !== "standard").map(room => room.name),
  }]));
}

function localDate(date: string) { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d); }

export async function ensureTutorRoomProfiles(db: Database, snapshotId: string, date: string, rooms: ProfileRoom[]) {
  const current = await listTutorRoomProfiles(db);
  const policies = toRoomPolicies(current.profiles);
  const futureEnd = addBangkokDays(date, 28), historyStart = addBangkokDays(date, -28);
  const sessions = await db.select({
    canonicalKey: schema.tutorIdentityGroups.canonicalKey, tutorDisplayName: schema.tutorIdentityGroups.displayName,
    groupId: schema.futureSessionBlocks.groupId, wiseSessionId: schema.futureSessionBlocks.wiseSessionId,
    wiseTeacherId: schema.futureSessionBlocks.wiseTeacherId, wiseStatus: schema.futureSessionBlocks.wiseStatus,
    startTime: schema.futureSessionBlocks.startTime, endTime: schema.futureSessionBlocks.endTime,
    startMinute: schema.futureSessionBlocks.startMinute, endMinute: schema.futureSessionBlocks.endMinute,
    weekday: schema.futureSessionBlocks.weekday, sessionType: schema.futureSessionBlocks.sessionType, studentCount: schema.futureSessionBlocks.studentCount,
  }).from(schema.futureSessionBlocks).innerJoin(schema.tutorIdentityGroups, eq(schema.futureSessionBlocks.groupId, schema.tutorIdentityGroups.id))
    .where(and(eq(schema.futureSessionBlocks.snapshotId, snapshotId), eq(schema.futureSessionBlocks.isBlocking, true),
      gte(schema.futureSessionBlocks.startTime, localDate(date)), lt(schema.futureSessionBlocks.startTime, localDate(futureEnd))));
  if (!sessions.some(row => !policies.has(row.canonicalKey.toLowerCase()))) return policies;
  const latest = db.selectDistinctOn([schema.classroomAssignmentRuns.assignmentDate], { id: schema.classroomAssignmentRuns.id })
    .from(schema.classroomAssignmentRuns).where(and(gte(schema.classroomAssignmentRuns.assignmentDate, historyStart), lt(schema.classroomAssignmentRuns.assignmentDate, date)))
    .orderBy(schema.classroomAssignmentRuns.assignmentDate, desc(schema.classroomAssignmentRuns.createdAt));
  const history = await db.select({ canonicalKey: schema.tutorIdentityGroups.canonicalKey,
    room: schema.classroomAssignmentRows.assignedRoom,
    minutes: sql<number>`${schema.classroomAssignmentRows.endMinute} - ${schema.classroomAssignmentRows.startMinute}`,
  }).from(schema.classroomAssignmentRows).innerJoin(schema.tutorIdentityGroups, eq(schema.classroomAssignmentRows.groupId, schema.tutorIdentityGroups.id))
    .where(and(inArray(schema.classroomAssignmentRows.runId, latest), eq(schema.classroomAssignmentRows.status, "assigned")));
  const proposed = proposeRoomProfiles({ sessions, rooms, history, existing: [...policies.values()] });
  if (proposed.length) await db.insert(schema.classroomTutorRoomProfiles).values(proposed.map(profile => ({
    canonicalKey: profile.canonicalKey, tutorDisplayName: profile.tutorDisplayName,
    primaryRoomId: profile.roomIds[0], secondaryRoomId: profile.roomIds[1] ?? null, thirdRoomId: profile.roomIds[2] ?? null,
    provenance: { snapshotId, historyStart, futureEnd, initializedForDate: date, preservedPreferredRoom: existingPreferredRoom(profile.tutorDisplayName) ?? null },
    updatedBy: "automatic",
  }))).onConflictDoNothing();
  return toRoomPolicies((await listTutorRoomProfiles(db)).profiles);
}

export class RoomProfileError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function updateTutorRoomProfile(db: Database, input: { canonicalKey: string; roomIds: string[]; revision: number; actor: string }) {
  const key = input.canonicalKey.toLowerCase();
  const { profiles, rooms } = await listTutorRoomProfiles(db);
  const profile = profiles.find(row => row.canonicalKey === key);
  if (!profile) throw new RoomProfileError("Teacher room profile not found", 404);
  const selected = input.roomIds.map(id => rooms.find(room => room.id === id));
  if (selected.length < 1 || selected.length > 3 || new Set(input.roomIds).size !== selected.length || selected.some(room => !room?.active || room.category !== "standard")) throw new RoomProfileError("Choose one to three distinct active teaching rooms", 400);
  if (TV_REQUIRED_TUTORS.has(profile.tutorDisplayName) && selected.some(room => !room?.hasTv)) throw new RoomProfileError("This teacher requires TV rooms", 400);
  const anchor = existingPreferredRoom(profile.tutorDisplayName);
  if (anchor && selected[0]?.name !== anchor) throw new RoomProfileError(`Keep the existing preferred room, ${anchor}, first`, 400);
  if (isGiftTutor(profile.tutorDisplayName) && selected.length !== 1) throw new RoomProfileError("Gift retains the fixed Joy room", 400);
  const [updated] = await db.update(schema.classroomTutorRoomProfiles).set({
    primaryRoomId: input.roomIds[0], secondaryRoomId: input.roomIds[1] ?? null, thirdRoomId: input.roomIds[2] ?? null,
    revision: profile.revision + 1, source: "admin", updatedBy: input.actor, updatedAt: new Date(),
    provenance: { ...profile.provenance, previousRoomIds: profile.roomIds, previousRevision: profile.revision },
  }).where(and(eq(schema.classroomTutorRoomProfiles.canonicalKey, key), eq(schema.classroomTutorRoomProfiles.revision, input.revision))).returning();
  if (!updated) throw new RoomProfileError("The profile changed. Reload before saving.", 409);
  return updated;
}
