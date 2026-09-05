import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { promoteWithTutorContacts, loadAccountMappings } from "../sync";
import { resolveOnboardingIdentities } from "../planner";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";
import { getScheduleEmailPreview } from "@/lib/classrooms/schedule-email";
import { runFullSync } from "@/lib/sync/orchestrator";
import type { WiseTeacher } from "@/lib/wise/types";
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const teachers: WiseTeacher[] = [{ _id: "t-new", userId: { _id: "u-new", name: "New (New) Tutor", email: "new@example.com" } }];
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });
async function candidate(roster = teachers) {
  await handle.db.update(schema.syncRuns).set({ status: "success" }).where(eq(schema.syncRuns.status, "running"));
  const [snapshot] = await handle.db.insert(schema.snapshots).values({}).returning();
  const [run] = await handle.db.insert(schema.syncRuns).values({ status: "running", snapshotId: snapshot.id }).returning();
  const identities = resolveOnboardingIdentities(roster, [], await loadAccountMappings(db));
  return { snapshotId: snapshot.id, syncRunId: run.id, teachers: roster, groups: identities.groups, blocked: identities.blocked };
}
describe("atomic teacher onboarding", () => {
  it("imports once under concurrent promotions and gives scoped teacher access", async () => {
    const input = await candidate();
    await Promise.all([promoteWithTutorContacts(db, input), promoteWithTutorContacts(db, input)]);
    expect(await handle.db.select().from(schema.tutorContacts)).toHaveLength(1);
    expect(await handle.db.select().from(schema.tutorContactSyncEvents)).toHaveLength(2);
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual(["New"]);
    const again = await candidate();
    const result = await promoteWithTutorContacts(db, again);
    expect(result.counts).toEqual({ created: 0, updated: 0, blocked: 0 });
    expect(await handle.db.select().from(schema.tutorContactSyncEvents)).toHaveLength(2);
  });
  it("rolls contact changes and audit back when promotion fails", async () => {
    const first = await candidate();
    await promoteWithTutorContacts(db, first);
    const input = await candidate([{ ...teachers[0], userId: { _id: "u-new", name: "New (New) Tutor", email: "changed@example.com" } }]);
    await handle.db.execute(sql`create function reject_test_promotion() returns trigger language plpgsql as $$ begin raise exception 'test promotion failure'; end $$`);
    await handle.db.execute(sql`create trigger reject_test_promotion before update on snapshots for each row execute function reject_test_promotion()`);
    try {
      await expect(promoteWithTutorContacts(db, input)).rejects.toThrow();
    } finally {
      await handle.db.execute(sql`drop trigger reject_test_promotion on snapshots`);
      await handle.db.execute(sql`drop function reject_test_promotion()`);
    }
    expect((await handle.db.select().from(schema.snapshots).where(eq(schema.snapshots.active, true)))[0].id).toBe(first.snapshotId);
    expect((await handle.db.select().from(schema.tutorContacts))[0].onsiteEmail).toBe("new@example.com");
    expect(await handle.db.select().from(schema.tutorContactSyncEvents)).toHaveLength(2);
  });
  it("preserves a human edit that commits while import waits on the contact lock", async () => {
    await promoteWithTutorContacts(db, await candidate());
    const input = await candidate([{ ...teachers[0], userId: { _id: "u-new", name: "New (New) Tutor", email: "changed@example.com" } }]);
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE tutor_contacts SET onsite_email = 'manual@example.com', primary_email = 'override@example.com' WHERE canonical_key = 'New'");
      const waiting = promoteWithTutorContacts(db, input);
      await client.query("COMMIT");
      await waiting;
    } finally { client.release(); }
    const [c] = await handle.db.select().from(schema.tutorContacts);
    expect(c.onsiteEmail).toBe("manual@example.com");
    expect(c.primaryEmail).toBe("override@example.com");
    expect(c.wiseEmailState.onsiteEmail?.mode).toBe("manual");
  });
  it("revokes imported delivery/access on absence and restores it without deleting history", async () => {
    await promoteWithTutorContacts(db, await candidate());
    await promoteWithTutorContacts(db, await candidate([]));
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual([]);
    const events = (await handle.db.select().from(schema.tutorContactSyncEvents)).length;
    await promoteWithTutorContacts(db, await candidate());
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual(["New"]);
    expect((await handle.db.select().from(schema.tutorContactSyncEvents)).length).toBeGreaterThan(events);
  });
  it("does not promote a worker whose running claim was abandoned", async () => {
    const input = await candidate();
    await handle.db.update(schema.syncRuns).set({ status: "failed" }).where(eq(schema.syncRuns.id, input.syncRunId));
    await expect(promoteWithTutorContacts(db, input)).rejects.toThrow("running claim");
    expect(await handle.db.select().from(schema.tutorContacts)).toEqual([]);
  });
  it("records absent-roster sessions while preserving usable promoted work", async () => {
    const sessions = [{ _id: "kem-session", userId: "absent-kem", scheduledStartTime: "2026-09-09T11:45:00Z", scheduledEndTime: "2026-09-09T12:45:00Z", type: "SCHEDULED" }];
    const client = { get: async (path: string) => path.endsWith("/teachers") ? { data: { teachers } } : path.endsWith("/sessions") ? { data: { sessions, page_count: 1 } } : { data: { workingHours: { slots: [] }, leaves: [] } }, getStats: () => ({ requests: 0, byPath: {} }) };
    const result = await runFullSync(db, client as never, "institute", { now: new Date("2026-09-06T00:00:00Z") });
    expect(result.success).toBe(false);
    expect(result.promotedSnapshotId).toBeTruthy();
    expect(result.unmanagedTeacherSessionCount).toBe(1);
    expect(result.errorSummary).toContain("absent from the Wise roster");
    expect((await handle.db.select().from(schema.syncRuns))[0].status).toBe("failed");
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual(["New"]);
    expect((await handle.db.select().from(schema.dataIssues)).some(i => i.entityId === "kem-session")).toBe(true);
  });
  it("leaves contacts and account audit untouched before the activation date", async () => {
    const client = { get: async (path: string) => path.endsWith("/teachers") ? { data: { teachers } } : path.endsWith("/sessions") ? { data: { sessions: [], page_count: 1 } } : { data: { workingHours: { slots: [] }, leaves: [] } }, getStats: () => ({ requests: 0, byPath: {} }) };
    const result = await runFullSync(db, client as never, "institute", { now: new Date("2026-09-05T16:59:59Z") });
    expect(result.success).toBe(true);
    expect(await handle.db.select().from(schema.tutorContacts)).toEqual([]);
    expect(await handle.db.select().from(schema.tutorWiseAccounts)).toEqual([]);
    expect(await handle.db.select().from(schema.tutorContactSyncEvents)).toEqual([]);
  });
  it("rejects an empty roster without clearing contacts or promoting", async () => {
    const input = await candidate();
    await promoteWithTutorContacts(db, input);
    await handle.db.update(schema.syncRuns).set({ status: "success" });
    const client = { get: async () => ({ data: { teachers: [] } }), getStats: () => ({ requests: 0, byPath: {} }) };
    const result = await runFullSync(db, client as never, "institute", { now: new Date("2026-09-06T00:00:00Z") });
    expect(result.success).toBe(false);
    expect(result.promotedSnapshotId).toBeNull();
    expect((await handle.db.select().from(schema.snapshots).where(eq(schema.snapshots.active, true)))[0].id).toBe(input.snapshotId);
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual(["New"]);
  });
  it("does not grant a configured namesake access to a new imported identity", async () => {
    await handle.db.insert(schema.tutorContacts).values({ canonicalKey: "Other", displayName: "New", onsiteEmail: "other@example.com", sourceNames: ["New (New) Tutor"] });
    await promoteWithTutorContacts(db, await candidate());
    const [snapshot] = await handle.db.select().from(schema.snapshots).where(eq(schema.snapshots.active, true));
    const [group] = await handle.db.insert(schema.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: "New", displayName: "New", supportedModality: "onsite" }).returning();
    await handle.db.insert(schema.tutorIdentityGroupMembers).values({ snapshotId: snapshot.id, groupId: group.id, wiseTeacherId: "t-new", wiseUserId: "u-new", wiseDisplayName: "New (New) Tutor", isOnlineVariant: false });
    expect(await resolveTeacherCanonicalKeys("other@example.com", db)).toEqual(["Other"]);
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual(["New"]);
  });

  it("runs a new teacher from Wise sync through allocation and recipient preview without seeds or sends", async () => {
    const sessions = [{ _id: "session-new", userId: "u-new", scheduledStartTime: "2026-09-06T03:00:00Z", scheduledEndTime: "2026-09-06T04:00:00Z", type: "OFFLINE", meetingStatus: "SCHEDULED", studentCount: 1 }];
    const client = { get: async (path: string) => path.endsWith("/teachers") ? { data: { teachers } } : path.endsWith("/sessions") ? { data: { sessions, page_count: 1 } } : { data: { workingHours: { slots: [] }, leaves: [] } }, getStats: () => ({ requests: 0, byPath: {} }) };
    const result = await runFullSync(db, client as never, "institute", { now: new Date("2026-09-06T00:00:00Z") });
    expect(result.success).toBe(true);
    expect(result.contactSync).toMatchObject({ created: 1, updated: 0, blocked: 0 });
    const [block] = await handle.db.select().from(schema.futureSessionBlocks);
    const { assignClassrooms } = await import("@/lib/classrooms/assignment-engine");
    const { DEFAULT_CLASSROOM_ROOMS } = await import("@/lib/classrooms/rooms");
    const assigned = assignClassrooms([{ ...block, tutorDisplayName: "New", currentWiseLocation: null }], DEFAULT_CLASSROOM_ROOMS);
    expect(assigned.rows[0].status).toBe("assigned");
    const [run] = await handle.db.insert(schema.classroomAssignmentRuns).values({ assignmentDate: "2026-09-06", snapshotId: result.snapshotId!, status: "completed" }).returning();
    await handle.db.insert(schema.classroomAssignmentRows).values({ ...assigned.rows[0], runId: run.id, snapshotId: result.snapshotId!, publishStatus: "success" });
    const preview = await getScheduleEmailPreview(db, run.id);
    expect(preview.recipients[0]).toMatchObject({ email: "new@example.com", status: "ready" });
    expect(await resolveTeacherCanonicalKeys("new@example.com", db)).toEqual(["New"]);
    expect(await handle.db.select().from(schema.classroomScheduleEmailRuns)).toEqual([]);
  });
});
