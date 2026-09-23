// Only needed to import manual-wise-sync.ts below for the staleness-constant
// cross-check -- publish-queue.ts itself has no "server-only" dependency
// (deliberately: it is reachable from every consumer of classrooms/data.ts).
vi.mock("server-only", () => ({}));
import { describe, expect, it, vi } from "vitest";
import { publishSyncDeferral, PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS } from "../publish-queue";

describe("publishSyncDeferral", () => {
  it("does not defer when no tutor Wise sync is running", () => {
    expect(publishSyncDeferral(false, new Date("2026-09-23T03:00:00.000Z"))).toBeNull();
  });

  it("defers about 2 minutes with a human-readable reason while a sync is running", () => {
    const now = new Date("2026-09-23T03:00:00.000Z");
    expect(publishSyncDeferral(true, now)).toEqual({
      nextAttemptAt: new Date("2026-09-23T03:02:00.000Z"),
      lastError: "Waiting for the Wise sync to finish",
    });
  });
});

describe("PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS", () => {
  it("matches the staleness window manual-wise-sync.ts and run-wise-sync.ts use for abandoned running rows", async () => {
    const { RUNNING_SYNC_STALE_MS } = await import("@/lib/sync/manual-wise-sync");
    expect(PUBLISH_QUEUE_RUNNING_SYNC_STALE_MS).toBe(RUNNING_SYNC_STALE_MS);
  });
});
