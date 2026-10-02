import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockHolder, pidAlive, processStartedAt } from "../lock";

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
    const now = new Date("2026-10-02T19:00:00Z");
    const alive = acquireLock(file, { command: "run", now, alive: () => true, startedAt: () => null });
    expect(alive).toMatchObject({ ok: false, reason: "held", holder: { pid: 424242 } });
    const dead = acquireLock(file, { command: "run", now, alive: () => false });
    expect(dead).toMatchObject({ ok: true, tookOverStale: { pid: 424242, command: "run" } });
    expect(lockHolder(file)?.pid).toBe(process.pid);
  });

  it("also takes over a lock whose pid was reused by a newer process, or that is older than 6 hours", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = (startedAt: string) => fs.writeFileSync(file, JSON.stringify({ pid: 424242, startedAt, host: "mac", command: "run" }));
    const now = new Date("2026-10-03T01:00:00Z");
    write("2026-10-03T00:00:00.000Z");
    // The same process, started before it took the lock: held.
    expect(acquireLock(file, { command: "run", now, alive: () => true, startedAt: () => new Date("2026-10-02T23:59:59Z") })).toMatchObject({ ok: false, reason: "held" });
    // The pid now belongs to a process started after the lock was taken: stale.
    expect(acquireLock(file, { command: "run", now, alive: () => true, startedAt: () => new Date("2026-10-03T00:30:00Z") })).toMatchObject({ ok: true, tookOverStale: { pid: 424242 } });
    write("2026-10-02T18:00:00.000Z");
    // Seven hours old: stale even when the pid is alive and its start time unknown.
    expect(acquireLock(file, { command: "run", now, alive: () => true, startedAt: () => null })).toMatchObject({ ok: true, tookOverStale: { pid: 424242 } });
  });

  it("reads a process's start time", () => {
    const started = processStartedAt(process.pid);
    expect(started).toBeInstanceOf(Date);
    expect(started!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(processStartedAt(99_999_999)).toBeNull();
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
