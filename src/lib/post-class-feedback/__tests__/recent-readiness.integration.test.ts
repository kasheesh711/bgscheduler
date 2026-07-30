/**
 * The activation gate's resolvability signal, against real Postgres.
 *
 * Measured from persisted state rather than from a sync run's counters, and
 * that choice is the point of this suite. A run sees at most 50 candidates, and
 * because the feedback-event and recheck lanes carry no lower date bound it can
 * legitimately observe nineteen months-old sessions and one current one — which
 * is exactly what production did. A rate over that population describes a
 * historical backlog that can never be enforced, not the period about to be.
 *
 * `npm run test:integration` (Docker), or point at a scratch database with
 * TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { loadPostClassRecentSessionReadiness } from "@/lib/post-class-feedback/repository";
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

const SINCE = new Date("2026-07-26T00:00:00.000Z");

async function seedSession(input: {
  wiseSessionId: string;
  endsAt: string;
  eligible: boolean;
  sourceStatus: "ready" | "unavailable" | "identity_review" | "form_drift";
}): Promise<void> {
  const at = new Date(input.endsAt);
  await handle.db.insert(schema.postClassSessions).values({
    wiseSessionId: input.wiseSessionId,
    wiseClassId: "class-1",
    className: "Math",
    canonicalTutorKey: "kevin",
    canonicalTutorName: "Kevin",
    scheduledStartAt: at,
    scheduledEndAt: at,
    deadlineAt: at,
    finalStatus: "ENDED",
    eligible: input.eligible,
    sourceStatus: input.sourceStatus,
  });
}

describe("loadPostClassRecentSessionReadiness", () => {
  it("ignores sessions ending before the window", async () => {
    // The production shape: months of unresolved backlog behind a clean period.
    await seedSession({
      wiseSessionId: "april", endsAt: "2026-04-10T09:00:00.000Z",
      eligible: true, sourceStatus: "unavailable",
    });
    await seedSession({
      wiseSessionId: "may", endsAt: "2026-05-10T09:00:00.000Z",
      eligible: true, sourceStatus: "unavailable",
    });
    await seedSession({
      wiseSessionId: "recent", endsAt: "2026-07-28T09:00:00.000Z",
      eligible: true, sourceStatus: "ready",
    });

    await expect(loadPostClassRecentSessionReadiness(appDb(), { since: SINCE }))
      .resolves.toEqual({ eligible: 1, ready: 1 });
  });

  it("excludes ineligible sessions from both sides", async () => {
    // A cancelled or non-billable class is correctly non-ready and must not
    // drag the rate down — it was never going to produce a deduction.
    await seedSession({
      wiseSessionId: "cancelled", endsAt: "2026-07-28T09:00:00.000Z",
      eligible: false, sourceStatus: "unavailable",
    });
    await seedSession({
      wiseSessionId: "billable", endsAt: "2026-07-28T09:00:00.000Z",
      eligible: true, sourceStatus: "ready",
    });

    await expect(loadPostClassRecentSessionReadiness(appDb(), { since: SINCE }))
      .resolves.toEqual({ eligible: 1, ready: 1 });
  });

  it("counts every non-ready source status against the rate", async () => {
    for (const [id, status] of [
      ["a", "unavailable"], ["b", "identity_review"], ["c", "form_drift"], ["d", "ready"],
    ] as const) {
      await seedSession({
        wiseSessionId: id, endsAt: "2026-07-28T09:00:00.000Z",
        eligible: true, sourceStatus: status,
      });
    }

    await expect(loadPostClassRecentSessionReadiness(appDb(), { since: SINCE }))
      .resolves.toEqual({ eligible: 4, ready: 1 });
  });

  it("reports zero rather than throwing when the window is empty", async () => {
    // Zero must reach the gate as a real number: it fails the sample-size
    // condition, which is the fail-closed path. Silently absent data would not.
    await expect(loadPostClassRecentSessionReadiness(appDb(), { since: SINCE }))
      .resolves.toEqual({ eligible: 0, ready: 0 });
  });

  it("cannot see a session whose detail fetch failed, which is why readability is measured separately", async () => {
    // A failed fetch never reaches saveObservation, so there is no row at all —
    // invisible to this query in both numerator and denominator. The gate's
    // readable_rate covers that gap from the run's own rolling-lane counters.
    await seedSession({
      wiseSessionId: "saved", endsAt: "2026-07-28T09:00:00.000Z",
      eligible: true, sourceStatus: "ready",
    });

    await expect(loadPostClassRecentSessionReadiness(appDb(), { since: SINCE }))
      .resolves.toEqual({ eligible: 1, ready: 1 });
  });
});
