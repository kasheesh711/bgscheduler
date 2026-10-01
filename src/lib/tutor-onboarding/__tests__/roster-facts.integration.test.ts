import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { runFullSync } from "@/lib/sync/orchestrator";
import type { WiseTeacher } from "@/lib/wise/types";
import { persistRosterFacts } from "../roster-facts";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
});

async function seedAccounts() {
  await handle.db.insert(schema.tutorWiseAccounts).values([
    { wiseTeacherId: "t1", wiseUserId: "u1", canonicalKey: "Aria", displayName: "Aria (Aria)", isOnlineVariant: false,
      email: "aria@example.com", status: "active", lastSnapshotId: SNAPSHOT_ID },
    { wiseTeacherId: "t9", wiseUserId: "u9", canonicalKey: "Gone", displayName: "Gone (Gone)", isOnlineVariant: false,
      email: null, status: "absent", lastSnapshotId: SNAPSHOT_ID, wiseRelation: "TEACHER", wiseCourseCount: 3 },
  ]);
}

async function account(wiseTeacherId: string) {
  const [row] = await handle.db.select().from(schema.tutorWiseAccounts).where(eq(schema.tutorWiseAccounts.wiseTeacherId, wiseTeacherId));
  return row;
}

describe("persistRosterFacts", () => {
  it("writes roster details onto the account rows and counts only rows that changed", async () => {
    await seedAccounts();
    const facts = [{ wiseTeacherId: "t1", relation: "TEACHER", joinedOn: new Date("2026-01-20T00:00:00.000Z"), courseCount: 0, activated: false }];
    expect(await persistRosterFacts(db, facts)).toBe(1);
    expect(await account("t1")).toMatchObject({
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-01-20T00:00:00.000Z"), wiseCourseCount: 0, wiseActivated: false,
    });
    // The same facts again change nothing, so nothing is rewritten.
    expect(await persistRosterFacts(db, facts)).toBe(0);
  });

  it("leaves absent accounts as they were and ignores ids it does not know", async () => {
    await seedAccounts();
    expect(await persistRosterFacts(db, [{ wiseTeacherId: "nope", relation: "ADMIN", joinedOn: null, courseCount: 1, activated: true }])).toBe(0);
    expect(await account("t9")).toMatchObject({ wiseRelation: "TEACHER", wiseCourseCount: 3, status: "absent" });
  });

  it("turns a known value back into unknown when Wise stops sending it, and skips an empty roster", async () => {
    await seedAccounts();
    expect(await persistRosterFacts(db, [])).toBe(0);
    await persistRosterFacts(db, [{ wiseTeacherId: "t1", relation: "TEACHER", joinedOn: null, courseCount: 2, activated: true }]);
    expect(await persistRosterFacts(db, [{ wiseTeacherId: "t1", relation: null, joinedOn: null, courseCount: null, activated: null }])).toBe(1);
    expect(await account("t1")).toMatchObject({ wiseRelation: null, wiseJoinedOn: null, wiseCourseCount: null, wiseActivated: null });
  });
});

describe("snapshot sync", () => {
  it("persists roster details after promotion and records the result in the run metadata", async () => {
    const teachers: WiseTeacher[] = [{
      _id: "t-new",
      userId: { _id: "u-new", name: "New (New) Tutor", email: "new@example.com", activated: true },
      relation: "TEACHER",
      joinedOn: "2026-08-20T00:00:00.000Z",
      classes: [{ _id: "c1", name: "Maths" }],
    }];
    const client = {
      get: async (path: string) => path.endsWith("/teachers") ? { data: { teachers } }
        : path.endsWith("/sessions") ? { data: { sessions: [], page_count: 1 } }
        : { data: { workingHours: { slots: [] }, leaves: [] } },
      getStats: () => ({ requests: 0, byPath: {} }),
    };
    const result = await runFullSync(db, client as never, "institute", { now: new Date("2026-09-06T00:00:00Z") });
    expect(result.promotedSnapshotId).toBeTruthy();
    expect(await account("t-new")).toMatchObject({
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-08-20T00:00:00.000Z"), wiseCourseCount: 1, wiseActivated: true,
    });
    const [run] = await handle.db.select().from(schema.syncRuns);
    expect(run.metadata).toMatchObject({ rosterFacts: { updated: 1 } });
  });
});
