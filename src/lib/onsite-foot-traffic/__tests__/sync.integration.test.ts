import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { desc, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { WiseClient } from "@/lib/wise/client";
import type { WiseSession } from "@/lib/wise/types";

import {
  createFootTrafficReportSnapshot,
  getFootTrafficDashboard,
  getFootTrafficReportSnapshot,
} from "../data";
import { runOnsiteFootTrafficSync } from "../sync";

let handle: Awaited<ReturnType<typeof startTestDb>>;
const originalEnv = {
  user: process.env.WISE_USER_ID,
  key: process.env.WISE_API_KEY,
  secret: process.env.FOOT_TRAFFIC_PSEUDONYM_SECRET,
};

beforeAll(async () => {
  handle = await startTestDb();
  process.env.WISE_USER_ID = "test-user";
  process.env.WISE_API_KEY = "test-key";
  process.env.FOOT_TRAFFIC_PSEUDONYM_SECRET = "integration-secret-that-does-not-change";
}, 60_000);

afterAll(async () => {
  if (originalEnv.user === undefined) delete process.env.WISE_USER_ID; else process.env.WISE_USER_ID = originalEnv.user;
  if (originalEnv.key === undefined) delete process.env.WISE_API_KEY; else process.env.WISE_API_KEY = originalEnv.key;
  if (originalEnv.secret === undefined) delete process.env.FOOT_TRAFFIC_PSEUDONYM_SECRET; else process.env.FOOT_TRAFFIC_PSEUDONYM_SECRET = originalEnv.secret;
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await handle.db.delete(schema.onsiteFootTrafficReportSnapshots);
  await handle.db.delete(schema.onsiteFootTrafficVisits);
  await handle.db.delete(schema.onsiteFootTrafficSessions);
  await handle.db.delete(schema.onsiteFootTrafficSyncRuns);
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

function pastSession(status = "ENDED"): WiseSession {
  return {
    _id: "wise-session-1",
    scheduledStartTime: "2026-08-03T03:00:00.000Z",
    scheduledEndTime: "2026-08-03T04:00:00.000Z",
    meetingStatus: status,
    type: "OFFLINE",
    location: "Focus",
    teacherName: "Tutor One",
    classId: { _id: "raw-class-id", name: "Private Student Name", subject: "Math" },
    participants: [{ wiseUserId: "raw-student-id", name: "Student Name", credits: 1, isTeacher: false }],
  } as unknown as WiseSession;
}

function fakeClient(rows: WiseSession[] | Error): WiseClient {
  return {
    get: vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return { data: { sessions: rows, page_count: 1 } };
    }),
  } as unknown as WiseClient;
}

const runInput = {
  mode: "backfill" as const,
  startDate: "2026-08-01",
  endDate: "2026-08-07",
  triggerType: "manual" as const,
  actorEmail: "analyst@example.com",
  now: new Date("2026-09-04T00:30:00.000Z"),
};

describe("onsite foot-traffic sync against real Postgres", () => {
  it("advances Wise's exclusive source end without gaps between fetch chunks", async () => {
    const client = fakeClient([]);
    await runOnsiteFootTrafficSync(appDb(), {
      mode: "backfill",
      startDate: "2026-03-01",
      endDate: "2026-09-03",
      triggerType: "manual",
      actorEmail: "analyst@example.com",
      now: runInput.now,
      client,
    });

    expect(client.get).toHaveBeenCalledTimes(3);
    expect(client.get).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({
      startDate: "2026-03-01",
      endDate: "2026-05-25",
    }));
    expect(client.get).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({
      startDate: "2026-05-25",
      endDate: "2026-08-18",
    }));
    expect(client.get).toHaveBeenNthCalledWith(3, expect.any(String), expect.objectContaining({
      startDate: "2026-08-18",
      endDate: "2026-09-04",
    }));
  });

  it("does not mistake a partial manual window for the required initial backfill", async () => {
    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession()]) });

    const result = await runOnsiteFootTrafficSync(appDb(), {
      triggerType: "cron",
      now: runInput.now,
      client: fakeClient([pastSession()]),
    });

    expect(result.mode).toBe("backfill");
    expect(result.startDate).toBe("2026-03-01");
    expect(result.endDate).toBe("2026-09-03");
  });

  it("is idempotent, stores no student PII and transactionally removes a late cancellation", async () => {
    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession()]) });
    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession()]) });
    expect(await handle.db.select().from(schema.onsiteFootTrafficSessions)).toHaveLength(1);
    expect(await handle.db.select().from(schema.onsiteFootTrafficVisits)).toHaveLength(1);
    const stored = JSON.stringify({
      sessions: await handle.db.select().from(schema.onsiteFootTrafficSessions),
      visits: await handle.db.select().from(schema.onsiteFootTrafficVisits),
    });
    expect(stored).not.toContain("raw-student-id");
    expect(stored).not.toContain("Student Name");
    expect(stored).not.toContain("raw-class-id");

    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession("CANCELLED")]) });
    const [session] = await handle.db.select().from(schema.onsiteFootTrafficSessions);
    expect(session.exclusionReason).toBe("cancelled");
    expect(session.isCountedOnsite).toBe(false);
    expect(await handle.db.select().from(schema.onsiteFootTrafficVisits)).toHaveLength(0);
  });

  it("preserves prior rows on a failed fetch and enforces the single-flight guard", async () => {
    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession()]) });
    await expect(runOnsiteFootTrafficSync(appDb(), {
      ...runInput,
      client: fakeClient(new Error("Wise unavailable")),
    })).rejects.toThrow("Wise unavailable");
    expect(await handle.db.select().from(schema.onsiteFootTrafficVisits)).toHaveLength(1);
    const [latest] = await handle.db.select().from(schema.onsiteFootTrafficSyncRuns)
      .where(eq(schema.onsiteFootTrafficSyncRuns.status, "failed"))
      .orderBy(desc(schema.onsiteFootTrafficSyncRuns.startedAt));
    expect(latest.status).toBe("failed");

    await handle.db.insert(schema.onsiteFootTrafficSyncRuns).values({
      status: "running",
      mode: "rolling",
      requestedStartDate: "2026-08-01",
      requestedEndDate: "2026-08-07",
      startedAt: new Date("2026-09-04T00:25:00.000Z"),
    });
    const skipped = await runOnsiteFootTrafficSync(appDb(), {
      ...runInput,
      mode: "rolling",
      client: fakeClient([pastSession()]),
    });
    expect(skipped.skipped).toBe(true);
  });

  it("keeps HTML/PDF inputs consistent by reading an immutable aggregate snapshot", async () => {
    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession()]) });
    const filters = { startDate: "2026-08-01", endDate: "2026-08-07" };
    const snapshot = await createFootTrafficReportSnapshot({
      db: appDb(), filters, createdByEmail: "analyst@example.com", now: runInput.now,
    });
    expect(snapshot.payload.summary.studentVisits).toBe(1);

    await runOnsiteFootTrafficSync(appDb(), { ...runInput, client: fakeClient([pastSession("CANCELLED")]) });
    expect((await getFootTrafficDashboard(appDb(), filters, runInput.now)).summary.studentVisits).toBe(0);
    expect((await getFootTrafficReportSnapshot(appDb(), snapshot.id, runInput.now))?.payload.summary.studentVisits).toBe(1);
  });
});
