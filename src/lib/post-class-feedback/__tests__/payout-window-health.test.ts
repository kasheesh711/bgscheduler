/**
 * Staleness classification for payout windows the finalize pass never closed.
 *
 * The threshold under test is "past its month end", not "past its window
 * end": anchor month M ends on M-25 and finalize has the rest of M to publish
 * it on its own, so only an un-finalized M seen from M+1 onward is a signal.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getCronJobDefinition } from "@/lib/data-health/cron-registry";
import type { Database } from "@/lib/db";
import {
  classifyPayoutWindowStaleness,
  loadPayoutWindowStaleness,
  PAYOUT_ACCRUAL_JOB_KEY,
} from "@/lib/post-class-feedback/payout-window-health";

const MAY = { anchorMonth: "2026-05", windowEnd: "2026-05-25" };

describe("classifyPayoutWindowStaleness", () => {
  it("flags a run still short of published once its anchor month has passed", () => {
    const result = classifyPayoutWindowStaleness({
      today: "2026-06-02",
      pendingRun: { ...MAY, status: "partial" },
      lastEnded: { ...MAY, exists: true },
    });

    expect(result.stale).toBe(true);
    expect(result).toMatchObject({ anchorMonth: "2026-05", runStatus: "partial" });
    expect(result.detail).toContain("2026-05");
  });

  it("stays quiet inside the anchor month, where finalize still has time", () => {
    const result = classifyPayoutWindowStaleness({
      today: "2026-05-28",
      pendingRun: { ...MAY, status: "partial" },
      lastEnded: { ...MAY, exists: true },
    });

    expect(result.stale).toBe(false);
    expect(result.detail).toContain("still has this month");
  });

  it("flags a just-ended window that no run row was ever created for", () => {
    const result = classifyPayoutWindowStaleness({
      today: "2026-06-02",
      pendingRun: null,
      lastEnded: { ...MAY, exists: false },
    });

    expect(result.stale).toBe(true);
    expect(result).toMatchObject({ anchorMonth: "2026-05", runStatus: null });
    expect(result.detail).toContain("no payout run at all");
  });

  it("stays quiet when the window that just ended has not outlived its month", () => {
    const result = classifyPayoutWindowStaleness({
      today: "2026-05-27",
      pendingRun: null,
      lastEnded: { ...MAY, exists: false },
    });

    expect(result.stale).toBe(false);
  });

  it("stays quiet once the window is published (no pending run, row exists)", () => {
    const result = classifyPayoutWindowStaleness({
      today: "2026-07-04",
      pendingRun: null,
      lastEnded: { anchorMonth: "2026-06", windowEnd: "2026-06-25", exists: true },
    });

    expect(result.stale).toBe(false);
    expect(result.detail).toContain("finalized");
  });

  it("reports the oldest debt when several windows are behind", () => {
    const result = classifyPayoutWindowStaleness({
      today: "2026-07-04",
      pendingRun: { anchorMonth: "2026-04", windowEnd: "2026-04-25", status: "draft" },
      lastEnded: { anchorMonth: "2026-06", windowEnd: "2026-06-25", exists: true },
    });

    expect(result).toMatchObject({ stale: true, anchorMonth: "2026-04", runStatus: "draft" });
  });
});

describe("loadPayoutWindowStaleness", () => {
  /**
   * Re-armed for unattended charging: the hourly accrual pass finalizes
   * windows again, so the staleness monitor must be live. This tripwire
   * flips back if the registry entry ever loses its schedule.
   */
  it("confirms the accrual cron is armed hourly", () => {
    expect(getCronJobDefinition(PAYOUT_ACCRUAL_JOB_KEY)?.schedule).toBe("33 * * * *");
  });

  it("queries for stale windows now that the cron is armed", async () => {
    const db = {
      select: () => {
        throw new Error("loader reached the database");
      },
    } as unknown as Database;

    await expect(loadPayoutWindowStaleness(db, new Date("2026-10-02T03:00:00.000Z")))
      .rejects.toThrow("loader reached the database");
  });
});
