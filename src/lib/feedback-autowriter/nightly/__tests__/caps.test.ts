import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NIGHTLY_CAPS,
  activeWiseCooldown,
  effectiveCaps,
  loadOwnerConfig,
  stopFilePresent,
  stopFiles,
  stopRequested,
  writeStopFile,
  writeWiseCooldown,
} from "../caps";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-caps-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("caps", () => {
  it("has the approved defaults", () => {
    expect(NIGHTLY_CAPS).toMatchObject({
      maxTargets: 60, maxWiseReads: 200, wisePacingMs: 5_000, maxOpusCalls: 80, perAuditUsd: 3, perReauditUsd: 3,
      perSynthesisUsd: 4, maxClaudeUsdNight: 60, maxClaudeUsdWeek: 300, maxSonioxUsdNight: 2, maxOpenRouterUsdNight: 3,
      maxCorrectionsPerNight: 6, maxCorrectionsPerWeek: 15, maxFlagsPerNight: 10, auditConcurrency: 2, deadlineBangkok: "06:50",
    });
    expect(Object.isFrozen(NIGHTLY_CAPS)).toBe(true);
  });

  it("lets the owner's config only make a limit stricter", () => {
    const { caps, notes } = effectiveCaps({
      config: { maxTargets: 30, maxClaudeUsdNight: 100, wisePacingMs: 2_000, deadlineBangkok: "06:30", auditConcurrency: 0 },
    });
    expect(caps.maxTargets).toBe(30);
    expect(caps.maxClaudeUsdNight).toBe(60);
    // Pacing is stricter when longer.
    expect(caps.wisePacingMs).toBe(5_000);
    expect(caps.deadlineBangkok).toBe("06:30");
    expect(caps.auditConcurrency).toBe(1);
    expect(notes.join("\n")).toMatch(/maxClaudeUsdNight/u);
    expect(notes.join("\n")).toMatch(/wisePacingMs/u);
    expect(effectiveCaps({ config: { wisePacingMs: 9_000, deadlineBangkok: "07:30" } }).caps).toMatchObject({
      wisePacingMs: 9_000, deadlineBangkok: "06:50",
    });
  });

  it("lets --soniox-usd raise the Soniox cap up to 5 for one run, and nothing above", () => {
    expect(effectiveCaps({ sonioxUsdFlag: 4 }).caps.maxSonioxUsdNight).toBe(4);
    expect(effectiveCaps({ config: { maxSonioxUsdNight: 1 }, sonioxUsdFlag: 5 }).caps.maxSonioxUsdNight).toBe(5);
    expect(() => effectiveCaps({ sonioxUsdFlag: 5.01 })).toThrow(/0 to 5/u);
    expect(() => effectiveCaps({ sonioxUsdFlag: -1 })).toThrow();
    expect(effectiveCaps().caps.maxSonioxUsdNight).toBe(2);
  });
});

describe("owner config", () => {
  it("reads caps under `caps` or at the top level; a missing file changes nothing", () => {
    const file = path.join(home, "config.json");
    expect(loadOwnerConfig(file)).toEqual({ ok: true, caps: {}, notes: [], runnerSha: null });
    fs.writeFileSync(file, JSON.stringify({ caps: { maxTargets: 10, deadlineBangkok: "05:00", bogus: 1, maxWiseReads: "x" } }));
    const config = loadOwnerConfig(file);
    expect(config).toEqual({
      ok: true,
      caps: { maxTargets: 10, deadlineBangkok: "05:00" },
      notes: ["unknown key ignored: bogus", "maxWiseReads ignored: not a non-negative number"],
      runnerSha: null,
    });
    fs.writeFileSync(file, JSON.stringify({ maxOpusCalls: 5 }));
    expect(loadOwnerConfig(file)).toMatchObject({ ok: true, caps: { maxOpusCalls: 5 } });
  });

  it("reads the pinned runner commit, and refuses one that is not a commit", () => {
    const file = path.join(home, "config.json");
    fs.writeFileSync(file, JSON.stringify({ runnerSha: "ABC123DEF", caps: { maxTargets: 5 } }));
    expect(loadOwnerConfig(file)).toMatchObject({ ok: true, runnerSha: "abc123def", caps: { maxTargets: 5 }, notes: [] });
    fs.writeFileSync(file, JSON.stringify({ runnerSha: "main" }));
    expect(loadOwnerConfig(file)).toEqual({ ok: false, reason: "runnerSha must be a 7-40 character hex commit" });
  });

  it("fails closed on a config that does not parse", () => {
    const file = path.join(home, "config.json");
    fs.writeFileSync(file, "{ not json");
    expect(loadOwnerConfig(file)).toEqual({ ok: false, reason: "owner config is not valid JSON" });
    fs.writeFileSync(file, "[1]");
    expect(loadOwnerConfig(file).ok).toBe(false);
  });
});

describe("kill switches", () => {
  it("watches the home STOP file and the main checkout's STOP file by absolute path", () => {
    expect(stopFiles(home)).toEqual([
      path.join(home, ".bgscheduler-nightly", "STOP"),
      "/Users/kevinhsieh/Developer/Scheduling/.feedback-autowriter/STOP",
    ]);
    const files = [path.join(home, "STOP-a"), path.join(home, "STOP-b")];
    expect(stopRequested(files)).toBe(false);
    fs.writeFileSync(files[1], "");
    expect(stopFilePresent(files)).toBe(files[1]);
    expect(stopRequested(files)).toBe(true);
  });

  it("writes the home STOP file on a breach (0600) and keeps earlier reasons", () => {
    const file = writeStopFile("claude_usd_night breached", home, new Date("2026-10-03T00:00:00Z"));
    writeStopFile("again", home, new Date("2026-10-03T00:01:00Z"));
    expect(file).toBe(path.join(home, ".bgscheduler-nightly", "STOP"));
    expect(fs.readFileSync(file, "utf8")).toBe("2026-10-03T00:00:00.000Z claude_usd_night breached\n2026-10-03T00:01:00.000Z again\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("parks Wise reads for 30 minutes after a 429", () => {
    const now = new Date("2026-10-02T20:00:00Z");
    expect(activeWiseCooldown(now, home)).toBeNull();
    const until = writeWiseCooldown(now, home);
    expect(until.toISOString()).toBe("2026-10-02T20:30:00.000Z");
    expect(activeWiseCooldown(new Date("2026-10-02T20:29:59Z"), home)?.toISOString()).toBe("2026-10-02T20:30:00.000Z");
    expect(activeWiseCooldown(new Date("2026-10-02T20:30:01Z"), home)).toBeNull();
  });
});
