import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NIGHTLY_FILE_MODE, ensureDir } from "./paths";

/**
 * Single flight for the nightly audit: an O_EXCL lockfile holding the owner's pid, start time, host and command.
 * A lock is stale only when its pid is dead; a lock that cannot be read (no pid to check) is never taken over —
 * the operator deletes it after looking.
 */

export interface LockHolder {
  pid: number;
  startedAt: string;
  host: string;
  command: string;
}

export type LockResult =
  | { ok: true; holder: LockHolder; release: () => void; tookOverStale: LockHolder | null }
  | { ok: false; reason: "held" | "unreadable"; holder: LockHolder | null; file: string };

/** Whether a process with this pid exists (EPERM: it does, under another user). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(file: string): { holder: LockHolder | null; text: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { holder: null, text: null };
  }
  try {
    const value = JSON.parse(text) as Partial<LockHolder>;
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && typeof value.startedAt === "string") {
      return { holder: { pid: value.pid, startedAt: value.startedAt, host: String(value.host ?? ""), command: String(value.command ?? "") }, text };
    }
  } catch {
    // Unreadable: handled by the caller.
  }
  return { holder: null, text };
}

function tryCreate(file: string, holder: LockHolder): boolean {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "wx", NIGHTLY_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(holder)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

/**
 * Take the lock. A lock whose pid is dead is taken over (once, only if the file still holds that same text);
 * a live pid — this process's own included — or an unreadable lock refuses.
 */
export function acquireLock(file: string, input: { command: string; now?: Date; pid?: number; alive?: (pid: number) => boolean }): LockResult {
  ensureDir(path.dirname(file));
  const holder: LockHolder = {
    pid: input.pid ?? process.pid,
    startedAt: (input.now ?? new Date()).toISOString(),
    host: os.hostname(),
    command: input.command.slice(0, 200),
  };
  const alive = input.alive ?? pidAlive;
  const release = () => {
    const current = readHolder(file);
    if (current.holder && current.holder.pid === holder.pid && current.holder.startedAt === holder.startedAt) {
      fs.rmSync(file, { force: true });
    }
  };
  if (tryCreate(file, holder)) return { ok: true, holder, release, tookOverStale: null };
  const existing = readHolder(file);
  if (!existing.holder) {
    // Vanished between our create and read: one more try.
    if (existing.text === null && tryCreate(file, holder)) return { ok: true, holder, release, tookOverStale: null };
    return { ok: false, reason: "unreadable", holder: null, file };
  }
  if (alive(existing.holder.pid)) return { ok: false, reason: "held", holder: existing.holder, file };
  // Stale: the owner's pid is dead. Remove it only if nobody replaced it meanwhile, then try once more.
  const again = readHolder(file);
  if (again.text !== existing.text) return { ok: false, reason: "held", holder: again.holder, file };
  fs.rmSync(file, { force: true });
  if (tryCreate(file, holder)) return { ok: true, holder, release, tookOverStale: existing.holder };
  const winner = readHolder(file);
  return { ok: false, reason: winner.holder ? "held" : "unreadable", holder: winner.holder, file };
}

/** The current holder, for `status` (null: free or unreadable). */
export function lockHolder(file: string): LockHolder | null {
  return readHolder(file).holder;
}
