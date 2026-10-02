import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockHolder, pidAlive } from "../lock";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-lock-"));
  file = path.join(dir, "state", "nightly.lock");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("nightly lock", () => {
  it("is exclusive while its holder lives, and released only by its holder", () => {
    const first = acquireLock(file, { command: "collect" });
    expect(first.ok).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lockHolder(file)).toMatchObject({ pid: process.pid, command: "collect" });
    const second = acquireLock(file, { command: "audit" });
    expect(second).toMatchObject({ ok: false, reason: "held", holder: { pid: process.pid, command: "collect" } });
    if (!first.ok) throw new Error("unreachable");
    first.release();
    expect(fs.existsSync(file)).toBe(false);
    const third = acquireLock(file, { command: "audit" });
    expect(third.ok).toBe(true);
    // An old holder's release never removes someone else's lock.
    first.release();
    expect(lockHolder(file)).toMatchObject({ command: "audit" });
  });

  it("takes over a lock only when its pid is dead", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 424242, startedAt: "2026-10-02T18:00:00.000Z", host: "mac", command: "run" }));
    const alive = acquireLock(file, { command: "run", alive: () => true });
    expect(alive).toMatchObject({ ok: false, reason: "held", holder: { pid: 424242 } });
    const dead = acquireLock(file, { command: "run", alive: () => false });
    expect(dead).toMatchObject({ ok: true, tookOverStale: { pid: 424242, command: "run" } });
    expect(lockHolder(file)?.pid).toBe(process.pid);
  });

  it("never takes over a lock it cannot read", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(acquireLock(file, { command: "run", alive: () => false })).toMatchObject({ ok: false, reason: "unreadable", file });
  });

  it("tells a live pid from a dead one", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(99_999_999)).toBe(false);
    expect(pidAlive(0)).toBe(false);
  });
});
