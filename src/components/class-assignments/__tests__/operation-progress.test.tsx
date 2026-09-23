import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatEtaLabel,
  formatPausedLabel,
  nextPublishRecoveryTick,
  OperationProgress,
} from "../operation-progress";

describe("formatElapsed", () => {
  it("formats minutes and seconds", () => {
    expect(formatElapsed(65_000)).toBe("1m 05s");
  });
  it("formats seconds only under a minute", () => {
    expect(formatElapsed(40_000)).toBe("40s");
  });
  it("shows a dash for missing elapsed time", () => {
    expect(formatElapsed(null)).toBe("-");
    expect(formatElapsed(undefined)).toBe("-");
  });
});

describe("formatEtaLabel", () => {
  it("returns an empty string for missing ETAs", () => {
    expect(formatEtaLabel(null)).toBe("");
    expect(formatEtaLabel(undefined)).toBe("");
  });
  it("formats minutes left", () => {
    expect(formatEtaLabel(90_000)).toBe("about 2m left");
  });
  it("formats seconds left", () => {
    expect(formatEtaLabel(45_000)).toBe("about 45s left");
  });
  it("rounds up to at least 1 second", () => {
    expect(formatEtaLabel(1)).toBe("about 1s left");
    expect(formatEtaLabel(0)).toBe("about 1s left");
  });
});

/** Reads vercel.json instead of hard-coding the publish-recovery schedule a second time. */
function publishRecoveryCronMinutes(): number[] {
  const vercelConfigPath = path.join(process.cwd(), "vercel.json");
  const vercelConfig = JSON.parse(readFileSync(vercelConfigPath, "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  const entry = vercelConfig.crons.find(cron => cron.path === "/api/internal/class-assignments/publish-recovery");
  if (!entry) throw new Error("publish-recovery cron entry missing from vercel.json");
  const minuteField = entry.schedule.split(" ")[0];
  const [range, stepText] = minuteField.split("/");
  const [startText, endText] = range.split("-");
  const start = Number(startText);
  const end = Number(endText);
  const step = Number(stepText);
  const minutes: number[] = [];
  for (let minute = start; minute <= end; minute += step) minutes.push(minute);
  return minutes;
}

describe("nextPublishRecoveryTick", () => {
  const recoveryMinutes = publishRecoveryCronMinutes();

  it("matches vercel.json's publish-recovery schedule", () => {
    expect(recoveryMinutes).toEqual([1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56]);
  });

  it("returns the same instant when already exactly on a tick", () => {
    const tick = new Date("2026-09-23T03:06:00.000Z");
    expect(nextPublishRecoveryTick(tick)).toEqual(tick);
  });

  it("rounds up to the next tick within the same hour", () => {
    expect(nextPublishRecoveryTick(new Date("2026-09-23T03:02:30.000Z")))
      .toEqual(new Date("2026-09-23T03:06:00.000Z"));
  });

  it("rolls into the next hour after minute 56", () => {
    expect(nextPublishRecoveryTick(new Date("2026-09-23T03:57:00.000Z")))
      .toEqual(new Date("2026-09-23T04:01:00.000Z"));
  });

  it.each(recoveryMinutes)("treats UTC minute %i as a valid tick", minute => {
    const at = new Date(Date.UTC(2026, 8, 23, 3, minute, 0, 0));
    expect(nextPublishRecoveryTick(at)).toEqual(at);
  });
});

describe("formatPausedLabel", () => {
  it("labels the next publish-recovery tick in Asia/Bangkok, worded as an estimate", () => {
    // nextAttemptAt 03:02 UTC -> next tick 03:06 UTC -> 10:06 Bangkok (UTC+7)
    const now = new Date("2026-09-23T03:00:00.000Z");
    const label = formatPausedLabel("Waiting for the Wise sync to finish", "2026-09-23T03:02:00.000Z", now);
    expect(label).toBe("Waiting for the Wise sync to finish — resumes automatically at about 10:06 (safe to close)");
  });

  it("bases the tick on now when nextAttemptAt has already passed", () => {
    // now is 03:07:30 -> next tick 03:11 UTC -> 10:11 Bangkok
    const now = new Date("2026-09-23T03:07:30.000Z");
    const label = formatPausedLabel("Waiting for Wise cooldown", "2026-09-23T03:00:00.000Z", now);
    expect(label).toBe("Waiting for Wise cooldown — resumes automatically at about 10:11 (safe to close)");
  });
});

describe("OperationProgress", () => {
  it("renders step labels, elapsed time, and a paused sentence instead of an ETA", () => {
    const now = new Date("2026-09-23T03:00:00.000Z");
    const markup = renderToStaticMarkup(
      <OperationProgress
        steps={[
          { label: "Checking data", status: "done" },
          { label: "Syncing from Wise", status: "active" },
          { label: "Assigning rooms", status: "pending" },
          { label: "Done", status: "pending" },
        ]}
        elapsedMs={65_000}
        etaMs={90_000}
        pausedUntil="2026-09-23T03:02:00.000Z"
        pausedReason="Waiting for the Wise sync to finish"
        now={now}
      />,
    );

    expect(markup).toContain("Checking data");
    expect(markup).toContain("Syncing from Wise");
    expect(markup).toContain("Assigning rooms");
    expect(markup).toContain("Elapsed 1m 05s");
    expect(markup).toContain("resumes automatically at about 10:06 (safe to close)");
    expect(markup).not.toContain("2m left");
  });

  it("shows an ETA instead when nothing is paused", () => {
    const markup = renderToStaticMarkup(
      <OperationProgress
        steps={[{ label: "Updating rooms", status: "active" }]}
        elapsedMs={40_000}
        etaMs={90_000}
      />,
    );

    expect(markup).toContain("Elapsed 40s");
    expect(markup).toContain("about 2m left");
  });

  it("warns to keep the page open when the current step is not safe to close", () => {
    const markup = renderToStaticMarkup(
      <OperationProgress
        steps={[{ label: "Assigning rooms", status: "active" }]}
        elapsedMs={5_000}
        safeToClose={false}
      />,
    );

    expect(markup).toContain("Keep this page open until this finishes.");
  });

  it("does not warn when the current step is safe to close", () => {
    const markup = renderToStaticMarkup(
      <OperationProgress
        steps={[{ label: "Syncing from Wise", status: "active" }]}
        elapsedMs={5_000}
        safeToClose
      />,
    );

    expect(markup).not.toContain("Keep this page open");
  });

  it("omits the ETA once every step is done", () => {
    const markup = renderToStaticMarkup(
      <OperationProgress
        steps={[{ label: "Done", status: "done" }]}
        elapsedMs={12_000}
        etaMs={5_000}
      />,
    );

    expect(markup).toContain("Elapsed 12s");
    expect(markup).not.toContain("left");
  });
});
