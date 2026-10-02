import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJsonl,
  ensureDir,
  isNightLabel,
  nightDeadline,
  nightLabel,
  nightlyPaths,
  nightlyRoot,
  readJsonFile,
  readJsonl,
  sessionCacheDir,
  writeJsonAtomic,
} from "../paths";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-paths-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("night labels and deadlines", () => {
  it("audits the Bangkok day of now minus 12 hours", () => {
    // 01:30 BKK on 4 Oct → 3 Oct; 23:00 BKK on 3 Oct → 3 Oct; 11:59 BKK on 4 Oct → 3 Oct; 12:01 BKK on 4 Oct → 4 Oct.
    expect(nightLabel(new Date("2026-10-03T18:30:00Z"))).toBe("2026-10-03");
    expect(nightLabel(new Date("2026-10-03T16:00:00Z"))).toBe("2026-10-03");
    expect(nightLabel(new Date("2026-10-04T04:59:00Z"))).toBe("2026-10-03");
    expect(nightLabel(new Date("2026-10-04T05:01:00Z"))).toBe("2026-10-04");
  });

  it("stops at the deadline on the morning after the audited day, Bangkok time", () => {
    expect(nightDeadline("2026-10-02", "06:50").toISOString()).toBe("2026-10-02T23:50:00.000Z");
    expect(nightDeadline("2026-10-31", "06:50").toISOString()).toBe("2026-10-31T23:50:00.000Z");
    expect(() => nightDeadline("2026-13-01", "06:50")).toThrow();
    expect(() => nightDeadline("2026-10-02", "6:50")).toThrow();
  });

  it("accepts only real dates as night labels", () => {
    expect(isNightLabel("2026-10-02")).toBe(true);
    expect(isNightLabel("2026-02-30")).toBe(false);
    expect(isNightLabel("../etc")).toBe(false);
  });
});

describe("state root", () => {
  it("lives outside any worktree: $BGS_NIGHTLY_ROOT, else ~/.bgscheduler-nightly/nightly", () => {
    expect(nightlyRoot({}, "/Users/someone")).toBe("/Users/someone/.bgscheduler-nightly/nightly");
    expect(nightlyRoot({ BGS_NIGHTLY_ROOT: "/tmp/elsewhere" }, "/Users/someone")).toBe("/tmp/elsewhere");
    const paths = nightlyPaths("/state", "2026-10-02");
    expect(paths.nightDir).toBe("/state/2026-10-02");
    expect(paths.runJson).toBe("/state/2026-10-02/run.json");
    expect(paths.cacheDir).toBe("/state/cache");
    expect(paths.auditsDir).toBe("/state/audits");
    expect(paths.spendJsonl).toBe("/state/spend.jsonl");
    expect(paths.collectReady).toBe("/state/COLLECT_READY");
  });

  it("only builds cache paths from Wise object ids", () => {
    expect(sessionCacheDir("/state/cache", "6a0000000000000000000a01")).toBe("/state/cache/6a0000000000000000000a01");
    expect(() => sessionCacheDir("/state/cache", "../../x")).toThrow();
  });
});

describe("file primitives", () => {
  it("creates directories 0700 and writes JSON atomically 0600", () => {
    const file = path.join(dir, "a", "b", "run.json");
    writeJsonAtomic(file, { ok: true });
    expect(readJsonFile(file)).toEqual({ ok: true });
    expect(mode(file)).toBe(0o600);
    expect(mode(path.join(dir, "a", "b"))).toBe(0o700);
    writeJsonAtomic(file, { ok: false });
    expect(readJsonFile(file)).toEqual({ ok: false });
    expect(fs.readdirSync(path.join(dir, "a", "b"))).toEqual(["run.json"]);
    ensureDir(path.join(dir, "a"));
    expect(mode(path.join(dir, "a"))).toBe(0o700);
  });

  it("reads missing or broken JSON as null", () => {
    expect(readJsonFile(path.join(dir, "missing.json"))).toBeNull();
    fs.writeFileSync(path.join(dir, "bad.json"), "{");
    expect(readJsonFile(path.join(dir, "bad.json"))).toBeNull();
  });

  it("appends fsynced JSON lines 0600 and skips a line torn by a crash", () => {
    const file = path.join(dir, "ledger.jsonl");
    appendJsonl(file, { n: 1 });
    // A crash mid-write leaves a torn last line without a newline …
    fs.appendFileSync(file, "{\"n\":2,\"tor");
    // … the next append starts on a new line, so it is not swallowed.
    appendJsonl(file, { n: 3 });
    expect(readJsonl(file)).toEqual([{ n: 1 }, { n: 3 }]);
    expect(mode(file)).toBe(0o600);
    expect(readJsonl(path.join(dir, "none.jsonl"))).toEqual([]);
  });
});
