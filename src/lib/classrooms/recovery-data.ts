import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { addBangkokDays, bangkokDateKey } from "@/lib/room-capacity/dates";
import { normalizeSessions, isBlockingStatus } from "@/lib/normalization/sessions";
import { getLocalMinuteOfDay } from "@/lib/normalization/timezone";
import { getWiseSessionClassName, getWiseSessionTeacherUserId, getWiseUserName, type WiseSession } from "@/lib/wise/types";
import { fetchWiseSessionDetail } from "@/lib/wise/fetchers";
import type { WiseClient } from "@/lib/wise/client";
import { physicalRoom } from "./room-policy";
import { listTutorRoomProfiles, toRoomPolicies } from "./room-profiles";
import { proposeRoomProfiles } from "./room-profile-planner";
import { preferenceFrozenSessionIds } from "./notification-state";
import type { AssignmentSession } from "./assignment-engine";
import type { WeekendFinding } from "./weekend-readiness";

/** Shared by operator previews and the monitor. No seeding, assignments, or notification writes. */
export async function loadClassroomRecoveryContext(db: Database, dates: string[], snapshotId?: string) {
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const [snapshot] = await tx.select().from(schema.snapshots)
      .where(snapshotId ? eq(schema.snapshots.id, snapshotId) : eq(schema.snapshots.active, true)).limit(1);
    if (!snapshot) throw new Error("No Wise snapshot available for classroom verification");
    const members = await tx.select({ groupId: schema.tutorIdentityGroupMembers.groupId,
      wiseTeacherId: schema.tutorIdentityGroupMembers.wiseTeacherId, wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
      name: schema.tutorIdentityGroups.displayName, canonicalKey: schema.tutorIdentityGroups.canonicalKey })
      .from(schema.tutorIdentityGroupMembers).innerJoin(schema.tutorIdentityGroups, eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id))
      .where(eq(schema.tutorIdentityGroupMembers.snapshotId, snapshot.id));
    const latestRuns = await tx.selectDistinctOn([schema.classroomAssignmentRuns.assignmentDate]).from(schema.classroomAssignmentRuns)
      .where(inArray(schema.classroomAssignmentRuns.assignmentDate, dates))
      .orderBy(schema.classroomAssignmentRuns.assignmentDate, desc(schema.classroomAssignmentRuns.createdAt));
    const previousRows = latestRuns.length ? await tx.select().from(schema.classroomAssignmentRows)
      .where(inArray(schema.classroomAssignmentRows.runId, latestRuns.map(run => run.id))) : [];
    const rooms = await tx.select().from(schema.classroomRooms).where(eq(schema.classroomRooms.active, true));
    const profiles = await listTutorRoomProfiles(tx);
    const latestHistory = tx.selectDistinctOn([schema.classroomAssignmentRuns.assignmentDate], { id: schema.classroomAssignmentRuns.id })
      .from(schema.classroomAssignmentRuns).where(and(gte(schema.classroomAssignmentRuns.assignmentDate, addBangkokDays(dates[0], -28)),
        lt(schema.classroomAssignmentRuns.assignmentDate, dates[0])))
      .orderBy(schema.classroomAssignmentRuns.assignmentDate, desc(schema.classroomAssignmentRuns.createdAt));
    const history = await tx.select({ canonicalKey: schema.classroomAssignmentRows.canonicalKey, room: schema.classroomAssignmentRows.assignedRoom,
      minutes: sql<number>`${schema.classroomAssignmentRows.endMinute} - ${schema.classroomAssignmentRows.startMinute}` })
      .from(schema.classroomAssignmentRows).where(and(inArray(schema.classroomAssignmentRows.runId, latestHistory), eq(schema.classroomAssignmentRows.status, "assigned")));
    const notified = await tx.select({ canonicalKey: schema.classroomScheduleEmailRecipients.canonicalKey, date: schema.classroomAssignmentRuns.assignmentDate })
      .from(schema.classroomScheduleEmailRecipients).innerJoin(schema.classroomAssignmentRuns, eq(schema.classroomScheduleEmailRecipients.assignmentRunId, schema.classroomAssignmentRuns.id))
      .where(and(inArray(schema.classroomAssignmentRuns.assignmentDate, dates), eq(schema.classroomScheduleEmailRecipients.status, "sent")));
    const expectedSessions = await tx.select({ wiseSessionId: schema.futureSessionBlocks.wiseSessionId, wiseClassId: schema.futureSessionBlocks.wiseClassId,
      date: sql<string>`${schema.futureSessionBlocks.startTime}::date::text` })
      .from(schema.futureSessionBlocks).where(and(eq(schema.futureSessionBlocks.snapshotId, snapshot.id), eq(schema.futureSessionBlocks.isBlocking, true),
        sql`${schema.futureSessionBlocks.startTime}::date IN (${sql.join(dates.map(date => sql`${date}::date`), sql`, `)})`));
    const identityIssues = await tx.select({ entityId: schema.dataIssues.entityId, message: schema.dataIssues.message })
      .from(schema.dataIssues).where(and(eq(schema.dataIssues.snapshotId, snapshot.id), eq(schema.dataIssues.type, "alias")));
    return { snapshot, members, latestRuns, previousRows, rooms, profiles, history, notified, expectedSessions, identityIssues };
  });
}
export type ClassroomRecoveryContext = Awaited<ReturnType<typeof loadClassroomRecoveryContext>>;

export function recoveryRoomPolicies(context: ClassroomRecoveryContext, live: WiseSession[], startDate: string) {
  const members = recoveryMembers(context);
  const upcoming = live.flatMap(session => {
    const member = members.get(getWiseSessionTeacherUserId(session) ?? "");
    const date = bangkokDateKey(new Date(session.scheduledStartTime));
    if (!member || !isBlockingStatus(session.meetingStatus) || date < startDate || date >= addBangkokDays(startDate, 28)) return [];
    return normalizeSessions([session], () => member.wiseTeacherId).map(block => ({ ...block, canonicalKey: member.canonicalKey, groupId: member.groupId, tutorDisplayName: member.name }));
  });
  const policies = toRoomPolicies(context.profiles.profiles);
  const proposed = proposeRoomProfiles({ sessions: upcoming, rooms: context.rooms, existing: [...policies.values()],
    history: context.history.flatMap(row => row.canonicalKey ? [{ ...row, canonicalKey: row.canonicalKey }] : []) });
  for (const profile of proposed) policies.set(profile.canonicalKey, { canonicalKey: profile.canonicalKey, revision: 1,
    rooms: profile.roomIds.map(id => context.rooms.find(room => room.id === id)!.name) });
  return { policies, proposed };
}

function recoveryMembers(context: ClassroomRecoveryContext) {
  const map = new Map<string, ClassroomRecoveryContext["members"][number] | null>();
  for (const member of context.members) for (const id of new Set([member.wiseTeacherId, member.wiseUserId].filter(Boolean) as string[])) {
    if (map.has(id) && map.get(id)?.canonicalKey !== member.canonicalKey) map.set(id, null);
    else if (!map.has(id)) map.set(id, member);
  }
  return map;
}

export async function prepareClassroomRecoveryDay(context: ClassroomRecoveryContext, live: WiseSession[], date: string,
  client: Pick<WiseClient, "get">, now: Date, deadlineAt = Infinity) {
  const day = live.filter(session => bangkokDateKey(new Date(session.scheduledStartTime)) === date && isBlockingStatus(session.meetingStatus));
  const members = recoveryMembers(context);
  const sessions: AssignmentSession[] = [];
  const findings: WeekendFinding[] = [];
  for (const session of day) {
    const member = members.get(getWiseSessionTeacherUserId(session) ?? "");
    if (!member || context.identityIssues.some(issue => issue.entityId && [member.wiseTeacherId, member.groupId, member.canonicalKey].includes(issue.entityId))) {
      findings.push({ date, kind: "unverified", wiseSessionId: session._id, tutor: getWiseUserName(session.userId) ?? session.teacherName ?? undefined,
        message: "Live Wise session has no unambiguous teacher identity in the snapshot; its room requirement cannot be verified." });
      continue;
    }
    if (bangkokDateKey(new Date(session.scheduledEndTime)) !== date) findings.push({ date, kind: "unverified", wiseSessionId: session._id,
      tutor: member.name, message: "This class spans Bangkok calendar dates and requires manual room verification." });
    const [block] = normalizeSessions([session], () => member.wiseTeacherId);
    sessions.push({ ...block, canonicalKey: member.canonicalKey, groupId: member.groupId, tutorDisplayName: member.name, currentWiseLocation: block.location });
  }
  const run = context.latestRuns.find(run => run.assignmentDate === date);
  const previousRows = context.previousRows.filter(row => row.runId === run?.id);
  const known = new Set(sessions.map(row => row.wiseSessionId));
  const confirmedInactiveSessionIds = new Set<string>();
  const expected = new Map([...context.expectedSessions.filter(row => row.date === date), ...previousRows].map(row => [row.wiseSessionId, row]));
  for (const row of expected.values()) {
    if (day.some(session => session._id === row.wiseSessionId)) continue;
    try {
      if (Date.now() >= deadlineAt) throw new Error("Verification time budget exhausted");
      const detail = live.find(session => session._id === row.wiseSessionId)
        ?? (row.wiseClassId ? await fetchWiseSessionDetail(client as WiseClient, row.wiseClassId, row.wiseSessionId,
          Number.isFinite(deadlineAt) ? { deadlineAt } : {}) : null);
      if (detail?._id === row.wiseSessionId && (!isBlockingStatus(detail.meetingStatus)
        || (Number.isFinite(Date.parse(detail.scheduledStartTime)) && bangkokDateKey(new Date(detail.scheduledStartTime)) !== date))) {
        confirmedInactiveSessionIds.add(row.wiseSessionId);
        continue;
      }
    } catch { /* Missing data is not cancellation evidence. Keep the reservation and report it. */ }
    findings.push({ date, kind: "unverified", wiseSessionId: row.wiseSessionId,
      message: "A previously scheduled class is absent from the live list and could not be verified as cancelled or moved; its reservation is retained." });
  }
  const liveRoomBlocks = day.filter(session => session.location && context.rooms.some(room => physicalRoom(room.name) === physicalRoom(session.location!)))
    .map(session => ({ wiseSessionId: session._id, className: getWiseSessionClassName(session) ?? null, location: session.location!,
      startMinute: getLocalMinuteOfDay(session.scheduledStartTime), endMinute: getLocalMinuteOfDay(session.scheduledEndTime) }));
  return { day, sessions, previousRows, findings, liveRoomBlocks, confirmedInactiveSessionIds,
    externalRoomBlocks: liveRoomBlocks.filter(block => !known.has(block.wiseSessionId)),
    frozenSessionIds: preferenceFrozenSessionIds(sessions, date, new Set(context.notified.filter(row => row.date === date).map(row => row.canonicalKey.toLowerCase())), now) };
}
