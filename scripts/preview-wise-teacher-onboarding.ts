/** Read-only Wise GET + repeatable-read Postgres preview. No sync, writes or emails. */
import { loadEnvConfig } from "@next/env";
import { writeFile } from "node:fs/promises";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc, inArray } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { createWiseClient } from "../src/lib/wise/client";
import { fetchAllTeachers, fetchAllFutureSessions } from "../src/lib/wise/fetchers";
import { getWiseSessionTeacherUserId } from "../src/lib/wise/types";
import { normalizeSessions, isBlockingStatus } from "../src/lib/normalization/sessions";
import { bangkokDateKey, addBangkokDays } from "../src/lib/room-capacity/dates";
import { resolveOnboardingIdentities, planTutorContacts, scheduleRecipientEmail, type Contact, type Account, type AccountMapping } from "../src/lib/tutor-onboarding/planner";
import { liveRoomBlocksForDate } from "../src/lib/classrooms/data";
import { previewClassroomRecovery } from "../src/lib/classrooms/recovery-preview";
import { isOnsiteSessionType } from "../src/lib/classrooms/session-mode";
async function main() {
  loadEnvConfig(process.cwd(), true);
  process.env.TZ = "UTC";
  const output = process.argv.find(a => a.startsWith("--output="))?.slice(9) ?? "/private/tmp/wise-onboarding-preview.json";
  const dates = Array.from({ length: 7 }, (_, i) => addBangkokDays("2026-09-06", i));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const db = drizzle(client);
  const saved = await (async () => {
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const [snapshot] = await db.select().from(schema.snapshots).where(eq(schema.snapshots.active, true));
      if (!snapshot) throw new Error("No active snapshot");
      const members = await db.select({ wiseTeacherId: schema.tutorIdentityGroupMembers.wiseTeacherId, wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
        canonicalKey: schema.tutorIdentityGroups.canonicalKey, displayName: schema.tutorIdentityGroupMembers.wiseDisplayName,
        isOnlineVariant: schema.tutorIdentityGroupMembers.isOnlineVariant, groupId: schema.tutorIdentityGroups.id }).from(schema.tutorIdentityGroupMembers)
        .innerJoin(schema.tutorIdentityGroups, eq(schema.tutorIdentityGroups.id, schema.tutorIdentityGroupMembers.groupId))
        .where(eq(schema.tutorIdentityGroups.snapshotId, snapshot.id));
      const contacts: Contact[] = (await client.query(`select canonical_key as "canonicalKey", display_name as "displayName", onsite_email as "onsiteEmail", online_email as "onlineEmail", active, source_names as "sourceNames", coalesce(to_jsonb(t)->'wise_email_state', '{}'::jsonb) as "wiseEmailState" from tutor_contacts t`)).rows;
      const hasAccounts = (await client.query("select to_regclass('public.tutor_wise_accounts') is not null as present")).rows[0].present;
      const accounts: Account[] = hasAccounts ? await db.select().from(schema.tutorWiseAccounts) : [];
      const aliases = await db.select().from(schema.tutorAliases);
      const rooms = await db.select().from(schema.classroomRooms).where(eq(schema.classroomRooms.active, true));
      const runs = await db.select().from(schema.classroomAssignmentRuns).where(inArray(schema.classroomAssignmentRuns.assignmentDate, dates)).orderBy(desc(schema.classroomAssignmentRuns.createdAt));
      const latestRuns = dates.flatMap(date => runs.find(r => r.assignmentDate === date) ?? []);
      const rows = latestRuns.length ? await db.select().from(schema.classroomAssignmentRows).where(inArray(schema.classroomAssignmentRows.runId, latestRuns.map(r => r.id))) : [];
      await client.query("COMMIT");
      return { snapshot, members, contacts, accounts, aliases, rooms, latestRuns, rows };
    } finally { await client.end(); }
  })();
  const wise = createWiseClient();
  const institute = process.env.WISE_INSTITUTE_ID!;
  const teachers = await fetchAllTeachers(wise, institute);
  const live = await fetchAllFutureSessions(wise, institute);
  const mappings: AccountMapping[] = [...saved.accounts, ...saved.members.filter(m => !saved.accounts.some(a => a.wiseTeacherId === m.wiseTeacherId))];
  const identity = resolveOnboardingIdentities(teachers, saved.aliases, mappings);
  const plan = planTutorContacts(teachers, identity.groups, identity.blocked, saved.contacts, saved.accounts);
  const contactMap = new Map(plan.contacts.map(c => [c.canonicalKey, c]));
  const memberByUser = new Map(identity.groups.filter(g => !identity.blocked.has(g.canonicalKey)).flatMap(g => g.members.map(m => [m.wiseUserId, { ...m, groupId: saved.members.find(p => p.canonicalKey === g.canonicalKey)?.groupId ?? g.canonicalKey, canonicalKey: g.canonicalKey, name: g.displayName }] as const)));
  const days = dates.map(date => {
    const sessions = live.filter(s => isBlockingStatus(s.meetingStatus) && bangkokDateKey(new Date(s.scheduledStartTime)) === date);
    const normalized = sessions.flatMap(s => {
      const member = memberByUser.get(getWiseSessionTeacherUserId(s));
      if (!member) return [];
      return normalizeSessions([s], () => member.wiseTeacherId).map(block => ({ ...block, groupId: member.groupId, tutorDisplayName: member.name, currentWiseLocation: block.location }));
    });
    const ids = new Set(normalized.map(s => s.wiseSessionId));
    const external = liveRoomBlocksForDate(sessions, date).filter(b => !ids.has(b.wiseSessionId));
    const latest = saved.latestRuns.find(r => r.assignmentDate === date);
    const preview = previewClassroomRecovery({ assignmentDate: date, now: new Date(), liveSessions: normalized,
      previousRows: saved.rows.filter(r => r.runId === latest?.id), rooms: saved.rooms, externalRoomBlocks: external });
    const physical = (n: string) => n.trim().toLowerCase().replace(/\s+\(tv\)$/, "");
    const occupancy = [...preview.rows.flatMap(r => r.status !== "remote" ? [{ wiseSessionId: r.wiseSessionId, location: r.status === "no_room" ? r.currentWiseLocation ?? "" : r.assignedRoom, startMinute: r.startMinute, endMinute: r.endMinute }] : []), ...preview.externalRoomBlocks];
    const invalidPlacements = preview.rows.filter(r => r.status === "assigned" && (() => {
      const room = saved.rooms.find(room => room.name === r.assignedRoom);
      return !room || room.capacity < r.minCapacity || (r.needsTv && !room.hasTv) || (isOnsiteSessionType(r.sessionType) && room.category === "online_only")
        || (!!r.overrideRoom && r.overrideRoom !== r.assignedRoom)
        || occupancy.some(o => o.wiseSessionId !== r.wiseSessionId && physical(o.location) === physical(r.assignedRoom) && o.startMinute < r.endMinute && r.startMinute < o.endMinute);
    })()).map(r => r.wiseSessionId);
    const keys = [...new Set(sessions.flatMap(s => memberByUser.get(getWiseSessionTeacherUserId(s))?.canonicalKey ?? []))];
    return { date, live: sessions.length, planned: preview.rows.length, noRoom: preview.rows.filter(r => r.status === "no_room").map(r => ({ tutor: r.tutorDisplayName, sessionId: r.wiseSessionId, startMinute: r.startMinute, warnings: r.warnings })),
      invalidDetails: preview.rows.filter(r => invalidPlacements.includes(r.wiseSessionId)).map(r => ({ sessionId: r.wiseSessionId, tutor: r.tutorDisplayName, room: r.assignedRoom, override: r.overrideRoom, start: r.startMinute, end: r.endMinute, minCapacity: r.minCapacity, needsTv: r.needsTv, conflicts: occupancy.filter(o => o.wiseSessionId !== r.wiseSessionId && physical(o.location) === physical(r.assignedRoom) && o.startMinute < r.endMinute && r.startMinute < o.endMinute) })),
      unmatched: sessions.filter(s => !ids.has(s._id)).map(s => ({ sessionId: s._id, teacherUserId: getWiseSessionTeacherUserId(s) })), invalidPlacements,
      recipients: keys.map(key => ({ canonicalKey: key, ready: !!contactMap.get(key)?.active && !!scheduleRecipientEmail(contactMap.get(key)) })) };
  });
  const report = { generatedAt: new Date().toISOString(), applied: false, snapshotId: saved.snapshot.id, rosterAccounts: teachers.length, contactCounts: plan.counts,
    identityIssues: identity.issues, contactIssues: plan.issues, proposedContactChanges: plan.contacts.filter(c => {
      const old = saved.contacts.find(o => o.canonicalKey === c.canonicalKey);
      return !old || old.onsiteEmail !== c.onsiteEmail || old.onlineEmail !== c.onlineEmail;
    }).map(c => ({ canonicalKey: c.canonicalKey, created: !saved.contacts.some(o => o.canonicalKey === c.canonicalKey), active: c.active, emailAvailable: !!scheduleRecipientEmail(c) })), days };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, contacts: plan.counts, identityIssues: identity.issues.length, days: days.map(d => ({ date: d.date, live: d.live, planned: d.planned, noRoom: d.noRoom.length, unmatched: d.unmatched.length, invalid: d.invalidPlacements.length, blockedRecipients: d.recipients.filter(r => !r.ready).length })) }));
  if (days.some(d => d.invalidPlacements.length)) process.exitCode = 1;
}
main().catch(() => { console.error("Read-only onboarding preview failed; no production changes made."); process.exitCode = 1; });
