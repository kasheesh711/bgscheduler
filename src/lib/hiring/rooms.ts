import { and, desc, inArray } from "drizzle-orm";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { localDate, overlap } from "./model";

/** Kevin, 25 Nov 2026: a weekend paper test sits in one of these rooms, in this order. "HR room" is not a class room. */
export const HIRING_ROOMS = ["I learned (online)", "Hope (online)", "HR room"];

export const isWeekendDate = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

type Range = { start: Date; end: Date };
export type RoomClass = Range & { room: string };
export type RoomTest = Range & { id: string };

/** Classes in the hiring rooms on these Bangkok dates, from the latest class-assignment run of each date. */
export async function classesInHiringRooms(db: Database, dates: string[]): Promise<RoomClass[]> {
  if (!dates.length) return [];
  const runs = await db
    .select({ id: s.classroomAssignmentRuns.id, date: s.classroomAssignmentRuns.assignmentDate })
    .from(s.classroomAssignmentRuns)
    .where(inArray(s.classroomAssignmentRuns.assignmentDate, [...new Set(dates)]))
    .orderBy(desc(s.classroomAssignmentRuns.createdAt));
  const latest = [...new Map(runs.reverse().map((r) => [r.date, r.id])).values()];
  if (!latest.length) return [];
  const rows = await db
    .select({ room: s.classroomAssignmentRows.assignedRoom, start: s.classroomAssignmentRows.startTime, end: s.classroomAssignmentRows.endTime, status: s.classroomAssignmentRows.status })
    .from(s.classroomAssignmentRows)
    .where(and(inArray(s.classroomAssignmentRows.runId, latest), inArray(s.classroomAssignmentRows.assignedRoom, HIRING_ROOMS)));
  return rows.filter((r) => r.status === "assigned" || r.status === "needs_review");
}

/**
 * Classes come first: a test gets the first room in HIRING_ROOMS that no class and no earlier test holds.
 * Earlier start wins, then id. Recomputed on every read, so a class added later moves the test or flags it.
 */
export function assignHiringRooms(tests: RoomTest[], classes: RoomClass[]) {
  const given = new Map<string, string | null>();
  const held: RoomClass[] = [...classes];
  for (const test of [...tests].sort((a, b) => a.start.getTime() - b.start.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const room = HIRING_ROOMS.find((name) => !held.some((h) => h.room === name && overlap(test, h))) ?? null;
    given.set(test.id, room);
    if (room) held.push({ ...test, room });
  }
  return given;
}

/** A new weekend test fits when it gets a room and no booked test loses the room it had. */
export function weekendTestFits(range: Range, booked: RoomTest[], classes: RoomClass[]) {
  const before = assignHiringRooms(booked, classes);
  // "~" sorts after every uuid, so a new test never takes a room from a booked test with the same start.
  const after = assignHiringRooms([...booked, { id: "~new", ...range }], classes);
  return !!after.get("~new") && [...before].every(([id, room]) => !room || !!after.get(id));
}

/** Rooms for every confirmed weekend paper booking, keyed by booking id. */
export async function weekendTestRooms(db: Database, bookings: { id: string; kind: string; status: string; startTime: Date; endTime: Date }[]) {
  const tests = bookings
    .filter((b) => b.kind === "paper" && b.status === "confirmed" && isWeekendDate(localDate(b.startTime)))
    .map((b) => ({ id: b.id, start: b.startTime, end: b.endTime }));
  if (!tests.length) return new Map<string, string | null>();
  return assignHiringRooms(tests, await classesInHiringRooms(db, tests.map((t) => localDate(t.start))));
}
