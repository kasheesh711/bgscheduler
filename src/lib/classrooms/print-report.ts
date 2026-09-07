import { createHash } from "node:crypto";
import { and, desc, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { addBangkokDays } from "@/lib/room-capacity/dates";
import { buildTeacherSchedule } from "./schedule-projection";

export const printDateSchema = z.iso.date();
export const printRunsSchema = z.array(z.uuid()).min(1).max(7).refine(ids => new Set(ids).size === ids.length);

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
  if (runs.length !== ids.length) throw new Error("One or more saved assignment runs could not be found.");
  if (new Set(runs.map(run => run.assignmentDate)).size !== runs.length) throw new Error("Select one saved run per day.");
  // Deliberately select no student, class or contact details for the noticeboard.
  const rows = await db.select({
    id: schema.classroomAssignmentRows.id, runId: schema.classroomAssignmentRows.runId,
    canonicalKey: schema.classroomAssignmentRows.canonicalKey, tutorDisplayName: schema.classroomAssignmentRows.tutorDisplayName,
    startMinute: schema.classroomAssignmentRows.startMinute, endMinute: schema.classroomAssignmentRows.endMinute,
    assignedRoom: schema.classroomAssignmentRows.assignedRoom, status: schema.classroomAssignmentRows.status,
    publishStatus: schema.classroomAssignmentRows.publishStatus, sessionType: schema.classroomAssignmentRows.sessionType,
  }).from(schema.classroomAssignmentRows).where(inArray(schema.classroomAssignmentRows.runId, ids));
  // Detect in-place overrides/publishing during the multi-query read; a print must be coherent.
  const revisions = await db.select({ id: schema.classroomAssignmentRuns.id, updatedAt: schema.classroomAssignmentRuns.updatedAt })
    .from(schema.classroomAssignmentRuns).where(inArray(schema.classroomAssignmentRuns.id, ids));
  if (runs.some(run => revisions.find(other => other.id === run.id)?.updatedAt.getTime() !== run.updatedAt.getTime())) throw new Error("Assignments changed while loading. Refresh to print the latest saved version.");
  return {
    generatedAt: new Date().toISOString(),
    days: runs.map(run => {
      const schedule = buildTeacherSchedule(rows.filter(row => row.runId === run.id), run.assignmentDate, run.changeSummary);
      const revision = createHash("sha256").update(JSON.stringify(schedule)).digest("hex").slice(0, 8);
      const draft = schedule.tutors.some(tutor => tutor.blocks.some(block => !["ready", "remote"].includes(block.publication)));
      return { runId: run.id, date: run.assignmentDate, revision, draft,
        tutors: schedule.tutors.map(tutor => ({ ...tutor, blocks: tutor.blocks.map(block => ({
          rowId: block.rowId, date: block.date, startMinute: block.startMinute, endMinute: block.endMinute,
          startTime: block.startTime, endTime: block.endTime, room: block.room,
          roomChange: block.roomChange, shortGapChange: block.shortGapChange,
          outsideUsualRooms: block.outsideUsualRooms, exceptionReasons: block.exceptionReasons,
          publication: block.publication, status: block.status, sessionType: block.sessionType,
        })) })) };
    }),
  };
}

export type ClassroomPrintReport = Awaited<ReturnType<typeof loadClassroomPrintReport>>;
