import { describe, expect, it } from "vitest";
import { publishSyncDeferral } from "../publish-queue";

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
