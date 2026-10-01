import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Every call runs the real implementation; a test makes only its next call reject (`mockRejectedValueOnce`).
vi.mock("../roster-facts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../roster-facts")>();
  return { ...actual, persistRosterFacts: vi.fn(actual.persistRosterFacts) };
});

import { eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
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

const SYNC_NOW = new Date("2026-09-06T00:00:00Z");

/** A Wise client whose one-teacher roster carries every live-roster field the sync persists. */
function rosterClient() {
  const teachers: WiseTeacher[] = [{
    _id: "t-new",
    userId: { _id: "u-new", name: "New (New) Tutor", email: "new@example.com", activated: true },
    relation: "TEACHER",
    joinedOn: "2026-08-20T00:00:00.000Z",
    classes: [{ _id: "c1", name: "Maths" }],
  }];
  return {
    get: async (path: string) => path.endsWith("/teachers") ? { data: { teachers } }
      : path.endsWith("/sessions") ? { data: { sessions: [], page_count: 1 } }
      : { data: { workingHours: { slots: [] }, leaves: [] } },
    getStats: () => ({ requests: 0, byPath: {} }),
  };
}

describe("snapshot sync", () => {
  it("persists roster details after promotion and records the result in the run metadata", async () => {
    const result = await runFullSync(db, rosterClient() as never, "institute", { now: SYNC_NOW });
    expect(result.promotedSnapshotId).toBeTruthy();
    expect(await account("t-new")).toMatchObject({
      wiseRelation: "TEACHER", wiseJoinedOn: new Date("2026-08-20T00:00:00.000Z"), wiseCourseCount: 1, wiseActivated: true,
    });
    const [run] = await handle.db.select().from(schema.syncRuns);
    expect(run.metadata).toMatchObject({ rosterFacts: { updated: 1 } });
  });

  // A failure of the roster step never blocks a sync, and what it leaves behind is the error's name and SQLSTATE only:
  // a database error's message is the query and its parameters (roster ids, dates, flags).
  it.each([
    {
      name: "a database error drizzle wrapped (SQLSTATE on its cause)",
      // drizzle 0.45's DrizzleQueryError does not set `name`, so it reads "Error".
      failure: () => new DrizzleQueryError(
        "update tutor_wise_accounts as account set wise_relation = fact.relation where account.wise_teacher_id = fact.wise_teacher_id",
        ["t-new", "TEACHER", "2026-08-20T00:00:00.000Z", 1, true],
        Object.assign(new Error('column "wise_relation" of relation "tutor_wise_accounts" does not exist'), { code: "42703" }),
      ),
      recorded: "Error (42703)",
      logged: { errorName: "Error", sqlState: "42703" },
    },
    {
      name: "an error with no SQLSTATE",
      failure: () => new TypeError("cannot read roster for new@example.com"),
      recorded: "TypeError (no SQLSTATE)",
      logged: { errorName: "TypeError", sqlState: null },
    },
    {
      name: "a rejection that is not an Error",
      failure: () => "cannot read roster for new@example.com",
      recorded: "UnknownError (no SQLSTATE)",
      logged: { errorName: "UnknownError", sqlState: null },
    },
  ])("still promotes when the roster step fails with $name, recording only its name and SQLSTATE", async ({ failure, recorded, logged }) => {
    vi.mocked(persistRosterFacts).mockRejectedValueOnce(failure());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await runFullSync(db, rosterClient() as never, "institute", { now: SYNC_NOW });
      expect(result.promotedSnapshotId).toBeTruthy();
      expect(result.success).toBe(true);
      const [run] = await handle.db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, result.syncRunId));
      expect(run.status).toBe("success");
      const rosterFacts = (run.metadata as { rosterFacts?: unknown }).rosterFacts;
      expect(rosterFacts).toEqual({ error: recorded });
      expect(consoleError).toHaveBeenCalledWith("[sync-orchestrator] roster facts capture failed", logged);
      // Nothing from the message, the query or its parameters is stored or logged.
      const leaked = JSON.stringify([consoleError.mock.calls, rosterFacts]);
      for (const text of ["Failed query", "does not exist", "tutor_wise_accounts", "t-new", "TEACHER", "new@example.com"]) {
        expect(leaked, text).not.toContain(text);
      }
      // The failed step wrote nothing, but the promotion and contact import before it stand.
      expect(await account("t-new")).toMatchObject({ wiseRelation: null, wiseCourseCount: null, status: "active" });
    } finally {
      consoleError.mockRestore();
    }
  });
});
