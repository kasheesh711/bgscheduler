import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadClassroomRecoveryContext } from "../recovery-data";

let handle: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => { handle = await startTestDb(); });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });
describe("read-only shared classroom preview context", () => {
  it("loads the pinned snapshot's complete weekend and identity warnings without seeding or creating plans", async () => {
    const [snapshot] = await handle.db.insert(schema.snapshots).values({ active: true }).returning();
    const [group] = await handle.db.insert(schema.tutorIdentityGroups).values({ snapshotId: snapshot.id, canonicalKey: "teacher", displayName: "Teacher" }).returning();
    await handle.db.insert(schema.tutorIdentityGroupMembers).values({ snapshotId: snapshot.id, groupId: group.id,
      wiseTeacherId: "wise-teacher", wiseUserId: "wise-user", wiseDisplayName: "Teacher" });
    await handle.db.insert(schema.dataIssues).values({ snapshotId: snapshot.id, type: "alias", entityId: "teacher", message: "Needs review" });
    for (const date of ["2026-09-11", "2026-09-12", "2026-09-13"]) {
      await handle.db.insert(schema.futureSessionBlocks).values({ snapshotId: snapshot.id, groupId: group.id, wiseTeacherId: "wise-teacher", wiseSessionId: date,
        startTime: new Date(`${date}T10:00:00`), endTime: new Date(`${date}T11:00:00`), weekday: 6, startMinute: 600, endMinute: 660, wiseStatus: "CONFIRMED", isBlocking: true });
    }
    const result = await loadClassroomRecoveryContext(handle.db as unknown as Database, ["2026-09-12", "2026-09-13"], snapshot.id);
    expect(result.expectedSessions.map(row => row.date).sort()).toEqual(["2026-09-12", "2026-09-13"]);
    expect(result.members[0].canonicalKey).toBe("teacher");
    expect(result.identityIssues[0].message).toBe("Needs review");
    expect(result.rooms).toEqual([]);
    expect(await handle.db.select().from(schema.classroomAssignmentRuns)).toEqual([]);
    expect(await handle.db.select().from(schema.classroomTutorRoomProfiles)).toEqual([]);
    const setting = await handle.db.execute(sql`SHOW transaction_read_only`);
    expect(setting.rows[0].transaction_read_only).toBe("off");
  });
});
