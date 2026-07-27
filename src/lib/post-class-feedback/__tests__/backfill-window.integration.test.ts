/**
 * REC-03 — the backfill picks its own window.
 *
 * The rolling collector only covers the last four days, so history is drained
 * by a separate job. Choosing its dates by hand does not converge; each run
 * starts from the oldest session that is still not `ready` instead.
 *
 * Runs against real Postgres — `npm run test:integration` (Docker), or point at
 * a scratch database with TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { findOldestUnreconciledBackfillWindow } from "@/lib/post-class-feedback/backfill-window";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

let handle: Awaited<ReturnType<typeof startTestDb>>;

beforeAll(async () => {
  handle = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await truncateAll(handle.db);
});

function appDb(): Database {
  return handle.db as unknown as Database;
}

type SourceStatus = "ready" | "form_drift" | "identity_review" | "unavailable";

async function seed(rows: Array<{
  id: string;
  endsAt: string;
  eligible?: boolean;
  sourceStatus?: SourceStatus;
}>): Promise<void> {
  await handle.db.insert(schema.postClassSessions).values(rows.map((row) => {
    const at = new Date(row.endsAt);
    return {
      wiseSessionId: row.id,
      wiseClassId: "class-1",
      scheduledStartAt: at,
      scheduledEndAt: at,
      deadlineAt: at,
      finalStatus: "ENDED",
      eligible: row.eligible ?? true,
      sourceStatus: row.sourceStatus ?? "unavailable",
    };
  }));
}

const NOW = new Date("2026-07-27T03:00:00.000Z"); // 2026-07-27 10:00 Bangkok

describe("REC-03 backfill window selection", () => {
  it("returns null when every eligible session is reconciled", async () => {
    await seed([
      { id: "a", endsAt: "2026-06-10T03:00:00.000Z", sourceStatus: "ready" },
      { id: "b", endsAt: "2026-06-11T03:00:00.000Z", sourceStatus: "ready" },
    ]);

    expect(await findOldestUnreconciledBackfillWindow(appDb(), { now: NOW })).toBeNull();
  });

  it("starts at the oldest session that is not ready", async () => {
    await seed([
      { id: "reconciled", endsAt: "2026-06-01T03:00:00.000Z", sourceStatus: "ready" },
      { id: "oldest-gap", endsAt: "2026-06-10T03:00:00.000Z", sourceStatus: "unavailable" },
      { id: "later-gap", endsAt: "2026-06-20T03:00:00.000Z", sourceStatus: "identity_review" },
    ]);

    expect(await findOldestUnreconciledBackfillWindow(appDb(), { now: NOW })).toEqual({
      startDate: "2026-06-10",
      endDate: "2026-06-13",
    });
  });

  it("buckets by the Bangkok calendar date, not the UTC one", async () => {
    // 17:30Z on 25 June is 00:30 on 26 June in Bangkok. Using the UTC date
    // here would aim the backfill at a window that does not contain the
    // session it was chosen for.
    await seed([{ id: "late-night", endsAt: "2026-06-25T17:30:00.000Z" }]);

    const window = await findOldestUnreconciledBackfillWindow(appDb(), { now: NOW });
    expect(window?.startDate).toBe("2026-06-26");
  });

  it("never proposes a window running past today", async () => {
    await seed([{ id: "yesterday", endsAt: "2026-07-26T03:00:00.000Z" }]);

    expect(await findOldestUnreconciledBackfillWindow(appDb(), { now: NOW })).toEqual({
      startDate: "2026-07-26",
      endDate: "2026-07-27",
    });
  });

  it("ignores ineligible sessions", async () => {
    await seed([
      { id: "ineligible-old", endsAt: "2026-05-01T03:00:00.000Z", eligible: false },
      { id: "eligible-newer", endsAt: "2026-06-15T03:00:00.000Z" },
    ]);

    const window = await findOldestUnreconciledBackfillWindow(appDb(), { now: NOW });
    expect(window?.startDate).toBe("2026-06-15");
  });

  it("honours a custom window length", async () => {
    await seed([{ id: "gap", endsAt: "2026-06-10T03:00:00.000Z" }]);

    expect(await findOldestUnreconciledBackfillWindow(appDb(), { now: NOW, windowDays: 7 }))
      .toEqual({ startDate: "2026-06-10", endDate: "2026-06-16" });
  });
});
