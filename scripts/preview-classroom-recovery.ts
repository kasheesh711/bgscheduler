/** Usage: npx tsx --tsconfig scripts/tsconfig.json scripts/preview-classroom-recovery.ts --date=2026-09-06 --days=7 --output=/private/tmp/classroom-recovery
 * Reads Postgres in a READ ONLY transaction and Wise using GET requests. Never creates a run,
 * publishes a room, seeds configuration, or sends mail. Output excludes student/contact details.
 */
import { loadEnvConfig } from "@next/env";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq, inArray } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { createWiseClient } from "../src/lib/wise/client";
import { fetchAllFutureSessions, fetchWiseSessionDetail } from "../src/lib/wise/fetchers";
import { getWiseSessionTeacherUserId, getWiseUserName } from "../src/lib/wise/types";
import { normalizeSessions, isBlockingStatus } from "../src/lib/normalization/sessions";
import { getLocalMinuteOfDay } from "../src/lib/normalization/timezone";
import { addBangkokDays, bangkokDateKey } from "../src/lib/room-capacity/dates";
import { liveRoomBlocksForDate } from "../src/lib/classrooms/data";
import { previewClassroomRecovery } from "../src/lib/classrooms/recovery-preview";
import type { AssignmentSession } from "../src/lib/classrooms/assignment-engine";
import { isOnsiteSessionType } from "../src/lib/classrooms/session-mode";

async function main() {
  loadEnvConfig(process.cwd(), true);
  // normalizeSessions encodes Bangkok wall clock in Date; keep that encoding reproducible.
  process.env.TZ = "UTC";
  const args = new Map(process.argv.slice(2).map(arg => {
    const split = arg.indexOf("=");
    return [arg.slice(0, split), arg.slice(split + 1)];
  }));
  const startDate = args.get("--date") ?? bangkokDateKey(new Date());
  const dayCount = Number(args.get("--days") ?? 1);
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 7) throw new Error("--days must be between 1 and 7");
  const date = startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid --date");
  const dates = Array.from({ length: dayCount }, (_, i) => addBangkokDays(startDate, i));
  const outputPrefix = resolve(args.get("--output") ?? `/private/tmp/classroom-recovery-${startDate}`);
  if (!process.env.DATABASE_URL || !process.env.WISE_USER_ID || !process.env.WISE_API_KEY || !process.env.WISE_INSTITUTE_ID) throw new Error("Missing database or Wise configuration");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const db = drizzle(client);
  const snapshotData = await (async () => {
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [snapshot] = await db.select().from(schema.snapshots).where(eq(schema.snapshots.active, true)).limit(1);
      if (!snapshot) throw new Error("No active snapshot");
      const members = await db.select({ groupId: schema.tutorIdentityGroupMembers.groupId,
        wiseTeacherId: schema.tutorIdentityGroupMembers.wiseTeacherId, wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
        name: schema.tutorIdentityGroups.displayName }).from(schema.tutorIdentityGroupMembers)
        .innerJoin(schema.tutorIdentityGroups, eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id))
        .where(eq(schema.tutorIdentityGroupMembers.snapshotId, snapshot.id));
      const runs = await db.select().from(schema.classroomAssignmentRuns)
        .where(inArray(schema.classroomAssignmentRuns.assignmentDate, dates)).orderBy(desc(schema.classroomAssignmentRuns.createdAt));
      const latestRuns = dates.flatMap(date => runs.find(run => run.assignmentDate === date) ?? []);
      const previousRows = latestRuns.length ? await db.select().from(schema.classroomAssignmentRows)
        .where(inArray(schema.classroomAssignmentRows.runId, latestRuns.map(run => run.id))) : [];
      const rooms = await db.select().from(schema.classroomRooms).where(eq(schema.classroomRooms.active, true));
      await client.query("COMMIT");
      return { snapshot, members, latestRuns, previousRows, rooms };
    } finally { await client.end(); }
  })();
  const liveReadStartedAt = new Date().toISOString();
  const wise = createWiseClient();
  const live = await fetchAllFutureSessions(wise, process.env.WISE_INSTITUTE_ID);
  for (const date of dates) {
    const run = snapshotData.latestRuns.find(run => run.assignmentDate === date);
    const saved = { ...snapshotData, run, previousRows: snapshotData.previousRows.filter(row => row.runId === run?.id) };
    const output = dayCount === 1 ? outputPrefix : `${outputPrefix}-${date}`;
    const day = live.filter(session => bangkokDateKey(new Date(session.scheduledStartTime)) === date && isBlockingStatus(session.meetingStatus));
    const memberById = new Map(saved.members.flatMap(member => [member.wiseTeacherId, member.wiseUserId].filter(Boolean).map(id => [id!, member] as const)));
    const sessions: AssignmentSession[] = [];
    const unmatched: string[] = [];
    for (const session of day) {
      const member = memberById.get(getWiseSessionTeacherUserId(session) ?? "");
      if (!member) { unmatched.push(session._id); continue; }
      const [block] = normalizeSessions([session], () => member.wiseTeacherId);
      sessions.push({ ...block, groupId: member.groupId, tutorDisplayName: member.name, currentWiseLocation: block.location });
    }
    const known = new Set(sessions.map(row => row.wiseSessionId));
    const externalRoomBlocks = liveRoomBlocksForDate(day, date).filter(block => !known.has(block.wiseSessionId));
    const confirmedInactiveSessionIds = new Set<string>();
    const missingSessionChecks: Array<{ wiseSessionId: string; status: string; confirmedInactive: boolean }> = [];
    const cutoff = date === bangkokDateKey(new Date()) ? getLocalMinuteOfDay(new Date()) : -Infinity;
    for (const row of saved.previousRows.filter(row => !known.has(row.wiseSessionId) && row.startMinute > cutoff && row.wiseClassId)) {
      try {
        const detail = await fetchWiseSessionDetail(wise, row.wiseClassId!, row.wiseSessionId);
        const confirmedInactive = detail._id === row.wiseSessionId && !isBlockingStatus(detail.meetingStatus);
        if (confirmedInactive) confirmedInactiveSessionIds.add(row.wiseSessionId);
        missingSessionChecks.push({ wiseSessionId: row.wiseSessionId, status: detail.meetingStatus ?? "UNKNOWN", confirmedInactive });
      } catch {
        // Absence or a transport failure is not evidence that the old room has been vacated.
        missingSessionChecks.push({ wiseSessionId: row.wiseSessionId, status: "UNVERIFIED", confirmedInactive: false });
      }
    }
    const preview = previewClassroomRecovery({ assignmentDate: date, now: new Date(),
      liveSessions: sessions, previousRows: saved.previousRows, rooms: saved.rooms, externalRoomBlocks, confirmedInactiveSessionIds });
    const physical = (name: string) => name.trim().toLowerCase().replace(/\s+\(tv\)$/, "");
    const occupied = [...preview.rows.filter(row => ["assigned", "needs_review"].includes(row.status)).map(row => ({
      wiseSessionId: row.wiseSessionId, location: row.assignedRoom, startMinute: row.startMinute, endMinute: row.endMinute,
    })), ...preview.rows.flatMap(row => row.status === "no_room" && row.currentWiseLocation ? [{
      wiseSessionId: row.wiseSessionId, location: row.currentWiseLocation,
      startMinute: row.startMinute, endMinute: row.endMinute,
    }] : []), ...preview.externalRoomBlocks];
    const validationErrors: string[] = [];
    for (const row of preview.rows.filter(row => row.status === "assigned")) {
      const room = saved.rooms.find(room => room.name === row.assignedRoom);
      if (!room || room.capacity < row.minCapacity || (row.needsTv && !room.hasTv)
        || (isOnsiteSessionType(row.sessionType) && room.category === "online_only")) validationErrors.push(`${row.wiseSessionId}: room constraint violation`);
      for (const other of occupied) {
        if (other.wiseSessionId !== row.wiseSessionId && physical(other.location) === physical(row.assignedRoom)
          && other.startMinute < row.endMinute && row.startMinute < other.endMinute) validationErrors.push(`${row.wiseSessionId}: overlaps ${other.wiseSessionId}`);
      }
    }
    const time = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const safeRow = (row: AssignmentSession) => ({ wiseSessionId: row.wiseSessionId, tutor: row.tutorDisplayName,
      time: `${time(row.startMinute)}–${time(row.endMinute)}`, currentRoom: row.currentWiseLocation ?? null });
    const proposals = preview.rows.map(row => ({ ...safeRow(row), proposedRoom: row.assignedRoom,
      changed: physical(row.currentWiseLocation ?? "") !== physical(row.assignedRoom), status: row.status,
      publishEligible: row.status === "assigned" && isOnsiteSessionType(row.sessionType) && Boolean(row.wiseClassId),
      minCapacity: row.minCapacity, needsTv: row.needsTv, warnings: row.warnings }));
    const report = { assignmentDate: date, generatedAt: preview.generatedAt, liveReadStartedAt,
      snapshotId: saved.snapshot.id, snapshotCreatedAt: saved.snapshot.createdAt, previousRunId: saved.run?.id ?? null,
      applied: false, requiresFreshValidationBeforeApply: true,
      counts: { liveSessions: day.length, frozen: preview.frozen.length, planned: proposals.length,
        unassigned: proposals.filter(row => row.status === "no_room").length,
        needsReview: proposals.filter(row => row.status === "needs_review").length,
        proposedWiseMoves: proposals.filter(row => row.changed && row.publishEligible).length,
        unmatchedLiveSessions: unmatched.length }, validationErrors,
      frozen: preview.frozen.map(row => ({ ...safeRow(row), reason: row.freezeReason })), proposals,
      unmatchedLiveSessionIds: unmatched, missingSessionChecks,
      unmatchedLiveSessions: day.filter(session => unmatched.includes(session._id)).map(session => ({
        wiseSessionId: session._id, wiseTeacherUserId: getWiseSessionTeacherUserId(session) ?? null,
        tutorName: getWiseUserName(session.userId) ?? session.teacherName ?? null, sessionType: session.type ?? null,
        startTime: session.scheduledStartTime, location: session.location ?? null,
      })),
      roomPressure: [...new Set(preview.rows.filter(row => row.status === "no_room").map(row => row.startMinute))].map(minute => {
        const active = preview.rows.filter(row => row.status !== "remote" && row.startMinute <= minute && minute < row.endMinute);
        return { time: time(minute), centerClasses: active.length,
          onsiteClasses: active.filter(row => isOnsiteSessionType(row.sessionType)).length,
          onsiteRoomCount: saved.rooms.filter(room => room.category !== "online_only").length,
          assignedOnlineInStandardRooms: active.filter(row => !isOnsiteSessionType(row.sessionType)
            && saved.rooms.some(room => room.name === row.assignedRoom && room.category !== "online_only")).map(row => row.tutorDisplayName) };
      }) };
    await writeFile(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
    const attention = proposals.filter(row => (row.changed && row.status !== "remote") || row.status === "no_room" || row.status === "needs_review");
    const escape = (value: string | null) => (value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    const markdown = [`# Classroom recovery preview — ${date}`, "", `Generated ${preview.generatedAt}. Read-only; no assignments, Wise locations, or messages were changed.`, "",
      `${report.counts.frozen} classes frozen; ${report.counts.planned} upcoming classes planned; ${report.counts.proposedWiseMoves} proposed Wise room changes; ${report.counts.unassigned} without rooms; ${report.counts.needsReview} need review.`, "",
      `Validation errors: ${validationErrors.length}. Unmatched live sessions: ${unmatched.length}. Their known Wise rooms remain reserved.`, "",
      "Completed/in-progress classes and sessions absent from the live read are frozen. This preview expires as classes start or Wise changes; regenerate immediately before approval/application. Only the existing location-only publisher may apply eligible moves after live validation.", "",
      "| Tutor | Time | Current Wise room | Proposed room | Status |", "|---|---|---|---|---|",
      ...attention.map(row => `| ${escape(row.tutor)} | ${row.time} | ${escape(row.currentRoom)} | ${escape(row.proposedRoom)} | ${row.status}${row.publishEligible ? "" : " (not publishable)"} |`), "",
      ...validationErrors.map(error => `- ${error}`), ""].join("\n");
    await writeFile(`${output}.md`, markdown);
    console.log(JSON.stringify({ output, ...report.counts, validationErrors: validationErrors.length }));
    if (validationErrors.length || unmatched.length || report.counts.unassigned || report.counts.needsReview) process.exitCode = 2;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Preview failed"); process.exitCode = 1; });
