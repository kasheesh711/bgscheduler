import { createHash } from "node:crypto";
import { and, desc, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays } from "@/lib/room-capacity/dates";
import { buildTeacherSchedule, type ScheduleSourceRow } from "./schedule-projection";
import { physicalRoom } from "./room-policy";
import { loadPrintRosters, type PrintRoster, type PrintRosterSource } from "./print-roster";

export const printDateSchema = z.iso.date();
export const printRunsSchema = z.array(z.uuid()).min(1).max(7).refine(ids => new Set(ids).size === ids.length);
export const printViewSchema = z.enum(["tutors", "rooms"]);
export type ClassroomPrintView = z.infer<typeof printViewSchema>;
export class ClassroomPrintConflictError extends Error {}
type PrintRow = ScheduleSourceRow & PrintRosterSource & { runId: string };
type PrintRoom = { id: string; name: string; capacity: number; active: boolean; sortOrder: number };

export function buildClassroomPrintDay(run: { id: string; assignmentDate: string; changeSummary: Record<string, unknown> }, rows: PrintRow[], catalog: PrintRoom[], rosters: ReadonlyMap<string, PrintRoster>) {
  const schedule = buildTeacherSchedule(rows, run.assignmentDate, run.changeSummary);
  const activeRooms = catalog.filter(room => room.active).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const tutors = schedule.tutors.map(tutor => ({
    canonicalKey: tutor.canonicalKey, tutorDisplayName: tutor.tutorDisplayName,
    usualRooms: tutor.usualRooms, unavailableRooms: tutor.unavailableRooms,
    blocks: tutor.blocks.map(block => {
      const roster = rosters.get(block.rowId)!;
      const room = activeRooms.find(room => physicalRoom(room.name) === physicalRoom(block.room));
      const notes = [...block.exceptionReasons, ...roster.warnings];
      if (room && roster.studentCount > room.capacity) notes.push(`Enrollment exceeds room capacity: ${roster.studentCount} students / ${room.capacity} places.`);
      if (block.status !== "remote" && !room) notes.push("Room is unassigned or unavailable. Check with the team.");
      return { rowId: block.rowId, tutorDisplayName: tutor.tutorDisplayName,
        startMinute: block.startMinute, endMinute: block.endMinute, startTime: block.startTime, endTime: block.endTime,
        room: block.room, publication: block.publication, status: block.status,
        roomChange: block.roomChange, outsideUsualRooms: block.outsideUsualRooms,
        students: roster.students, rosterStatus: roster.rosterStatus, sessionState: roster.sessionState, notes,
      };
    }),
  }));
  const blocks = tutors.flatMap(tutor => tutor.blocks).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.tutorDisplayName.localeCompare(b.tutorDisplayName) || a.rowId.localeCompare(b.rowId));
  const exceptions = blocks.filter(block => block.sessionState !== "current");
  const roomExceptions = blocks.filter(block => block.sessionState !== "current" || (block.status !== "remote"
    && (block.status !== "assigned" || !activeRooms.some(room => physicalRoom(room.name) === physicalRoom(block.room)))));
  const rooms = activeRooms.map(room => ({ id: room.id, name: room.name, capacity: room.capacity,
    blocks: blocks.filter(block => block.sessionState === "current" && block.status === "assigned" && physicalRoom(room.name) === physicalRoom(block.room)),
  }));
  const printedTutors = tutors.map(tutor => ({ ...tutor, blocks: tutor.blocks.filter(block => block.sessionState === "current") })).filter(tutor => tutor.blocks.length);
  const revision = createHash("sha256").update(JSON.stringify({ tutors: printedTutors, rooms, exceptions, roomExceptions })).digest("hex").slice(0, 8);
  const draft = blocks.some(block => !["ready", "remote"].includes(block.publication) || block.rosterStatus !== "verified" || block.notes.length > 0);
  return { runId: run.id, date: run.assignmentDate, revision, draft, tutors: printedTutors, rooms, exceptions, roomExceptions };
}

export async function listPrintRuns(db: Database, date: string) {
  const start = printDateSchema.parse(date);
  const dates = Array.from({ length: 7 }, (_, i) => addBangkokDays(start, i));
  const runs = await db.selectDistinctOn([schema.classroomAssignmentRuns.assignmentDate], {
    id: schema.classroomAssignmentRuns.id, date: schema.classroomAssignmentRuns.assignmentDate,
  }).from(schema.classroomAssignmentRuns)
    .where(and(gte(schema.classroomAssignmentRuns.assignmentDate, start), lte(schema.classroomAssignmentRuns.assignmentDate, dates[6])))
    .orderBy(schema.classroomAssignmentRuns.assignmentDate, desc(schema.classroomAssignmentRuns.createdAt));
  return { runs, missingDates: dates.filter(date => !runs.some(run => run.date === date)) };
}

export async function loadClassroomPrintReport(db: Database, runIds: string[]) {
  const ids = printRunsSchema.parse(runIds);
  const runs = await db.select().from(schema.classroomAssignmentRuns).where(inArray(schema.classroomAssignmentRuns.id, ids))
    .orderBy(schema.classroomAssignmentRuns.assignmentDate);
  if (runs.length !== ids.length) throw new ClassroomPrintConflictError("One or more saved assignment runs could not be found.");
  if (new Set(runs.map(run => run.assignmentDate)).size !== runs.length) throw new ClassroomPrintConflictError("Select one saved run per day.");
  // Saved scheduling facts only. Student names come from exact live session membership.
  const rows = await db.select({
    id: schema.classroomAssignmentRows.id, runId: schema.classroomAssignmentRows.runId,
    canonicalKey: schema.classroomAssignmentRows.canonicalKey, tutorDisplayName: schema.classroomAssignmentRows.tutorDisplayName,
    startMinute: schema.classroomAssignmentRows.startMinute, endMinute: schema.classroomAssignmentRows.endMinute,
    assignedRoom: schema.classroomAssignmentRows.assignedRoom, status: schema.classroomAssignmentRows.status,
    publishStatus: schema.classroomAssignmentRows.publishStatus, sessionType: schema.classroomAssignmentRows.sessionType,
    wiseSessionId: schema.classroomAssignmentRows.wiseSessionId, wiseClassId: schema.classroomAssignmentRows.wiseClassId,
    wiseTeacherUserId: schema.classroomAssignmentRows.wiseTeacherUserId,
    startTime: schema.classroomAssignmentRows.startTime, endTime: schema.classroomAssignmentRows.endTime,
  }).from(schema.classroomAssignmentRows).where(inArray(schema.classroomAssignmentRows.runId, ids));
  const rooms = await db.select({ id: schema.classroomRooms.id, name: schema.classroomRooms.name, capacity: schema.classroomRooms.capacity,
    active: schema.classroomRooms.active, sortOrder: schema.classroomRooms.sortOrder }).from(schema.classroomRooms);
  const rosters = await loadPrintRosters(rows);
  // Detect in-place overrides/publishing during the multi-query read; a print must be coherent.
  const revisions = await db.select({ id: schema.classroomAssignmentRuns.id, updatedAt: schema.classroomAssignmentRuns.updatedAt })
    .from(schema.classroomAssignmentRuns).where(inArray(schema.classroomAssignmentRuns.id, ids));
  if (runs.some(run => revisions.find(other => other.id === run.id)?.updatedAt.getTime() !== run.updatedAt.getTime())) throw new ClassroomPrintConflictError("Assignments changed while loading. Refresh to print the latest saved version.");
  return {
    generatedAt: new Date().toISOString(),
    rosterCheckedAt: rosters.checkedAt, refreshFailed: rosters.refreshFailed,
    days: runs.map(run => buildClassroomPrintDay(run, rows.filter(row => row.runId === run.id), rooms, rosters.byRow)),
  };
}

export type ClassroomPrintReport = Awaited<ReturnType<typeof loadClassroomPrintReport>>;
