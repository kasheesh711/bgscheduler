import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneNightly } from "../retention";

let dir: string;
let root: string;
const NOW = new Date("2026-10-12T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function touch(file: string, ageDays: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  const at = new Date(NOW.getTime() - ageDays * DAY);
  fs.utimesSync(file, at, at);
  fs.utimesSync(path.dirname(file), at, at);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-retention-"));
  root = path.join(dir, ".bgscheduler-nightly", "nightly");
  touch(path.join(root, "cache", "6a0000000000000000000a01", "detail.json"), 9);
  touch(path.join(root, "cache", "6a0000000000000000000a02", "detail.json"), 2);
  touch(path.join(root, "audits", "6a0000000000000000000a01", "x.a1.y.json"), 8);
  touch(path.join(root, "2026-10-02", "bundles", "6a0000000000000000000a01.json"), 9);
  touch(path.join(root, "2026-10-02", "report.md"), 9);
  touch(path.join(root, "2026-10-02", "targets.json"), 9);
  touch(path.join(root, "2026-10-02", "run.json"), 9);
  touch(path.join(root, "2026-10-02", "summary.md"), 9);
  touch(path.join(root, "2026-10-08", "report.md"), 3);
  touch(path.join(root, "ledger.jsonl"), 30);
  touch(path.join(dir, ".bgscheduler-nightly", "backup", "keep.txt"), 60);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pruneNightly", () => {
  it("deletes real data older than 7 days and keeps metadata, recent nights and the backup", () => {
    const dry = pruneNightly(root, { now: NOW, dryRun: true, home: dir });
    expect(dry.cacheDirs).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "cache", "6a0000000000000000000a01"))).toBe(true);

    const result = pruneNightly(root, { now: NOW, home: dir });
    expect(result.cacheDirs.map((item) => path.basename(item))).toEqual(["6a0000000000000000000a01"]);
    expect(result.auditDirs.map((item) => path.basename(item))).toEqual(["6a0000000000000000000a01"]);
    expect(result.nightFiles.map((item) => path.relative(root, item)).sort()).toEqual(["2026-10-02/bundles", "2026-10-02/report.md", "2026-10-02/targets.json"]);
    for (const kept of ["cache/6a0000000000000000000a02", "2026-10-02/run.json", "2026-10-02/summary.md", "2026-10-08/report.md", "ledger.jsonl"]) {
      expect(fs.existsSync(path.join(root, kept))).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, ".bgscheduler-nightly", "backup", "keep.txt"))).toBe(true);
  });

  it("deletes an old night's proposals, verification and replay, and keeps its corrections log", () => {
    touch(path.join(root, "2026-10-02", "proposals", "6a0000000000000000000a01.json"), 9);
    touch(path.join(root, "2026-10-02", "verify", "6a0000000000000000000a01.json"), 9);
    touch(path.join(root, "2026-10-02", "replay", "records.json"), 9);
    touch(path.join(root, "2026-10-02", "corrections.jsonl"), 9);
    const result = pruneNightly(root, { now: NOW, home: dir });
    expect(result.nightFiles.map((item) => path.relative(root, item))).toEqual(expect.arrayContaining([
      "2026-10-02/proposals", "2026-10-02/verify", "2026-10-02/replay",
    ]));
    expect(fs.existsSync(path.join(root, "2026-10-02", "proposals"))).toBe(false);
    expect(fs.existsSync(path.join(root, "2026-10-02", "corrections.jsonl"))).toBe(true);
  });

  it("refuses to prune the nightly home itself", () => {
    expect(() => pruneNightly(path.join(dir, ".bgscheduler-nightly"), { now: NOW, home: dir })).toThrow(/Refusing/u);
    expect(() => pruneNightly("/", { now: NOW, home: dir })).toThrow(/Refusing/u);
  });
});
