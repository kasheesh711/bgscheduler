import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addDays, bangkokDateKey } from "../quality";

/**
 * Where the nightly audit keeps its state, and the file primitives it writes with. Everything lives OUTSIDE any git
 * worktree (a plain `git worktree remove` deletes ignored folders): `~/.bgscheduler-nightly/` holds the owner's
 * config, the STOP file and the empty working directory of `claude -p`; the state root
 * (`$BGS_NIGHTLY_ROOT`, default `~/.bgscheduler-nightly/nightly`) holds the per-night folders, the cache, the audits
 * and the ledgers. Directories are 0700, files 0600. `~/.bgscheduler-nightly/backup/` is never touched.
 */

export const NIGHTLY_DIR_MODE = 0o700;
export const NIGHTLY_FILE_MODE = 0o600;
const NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** `~/.bgscheduler-nightly`: owner config, STOP, the empty `claude -p` working directory. */
export function nightlyHome(home: string = os.homedir()): string {
  return path.join(home, ".bgscheduler-nightly");
}

/** The state root: `$BGS_NIGHTLY_ROOT`, else `~/.bgscheduler-nightly/nightly`. */
export function nightlyRoot(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string {
  const override = env.BGS_NIGHTLY_ROOT?.trim();
  return override ? path.resolve(override) : path.join(nightlyHome(home), "nightly");
}

/**
 * The Bangkok day a run audits: the calendar date (Asia/Bangkok) of `now` minus 12 hours, so a run at 01:30 BKK on
 * the 4th audits the 3rd, and one at 23:00 BKK on the 3rd also audits the 3rd.
 */
export function nightLabel(now: Date): string {
  return bangkokDateKey(new Date(now.getTime() - 12 * 60 * 60 * 1000));
}

/** A real `YYYY-MM-DD` date. */
export function isNightLabel(value: string): boolean {
  if (!NIGHT_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The instant a night's run must stop: `HH:MM` Bangkok on the morning after the audited day. */
export function nightDeadline(night: string, deadlineBangkok: string): Date {
  if (!isNightLabel(night)) throw new Error(`Not a night label: ${night}`);
  if (!/^\d{2}:\d{2}$/u.test(deadlineBangkok)) throw new Error(`Not an HH:MM time: ${deadlineBangkok}`);
  return new Date(`${addDays(night, 1)}T${deadlineBangkok}:00+07:00`);
}

export interface NightlyPaths {
  root: string;
  nightDir: string;
  /** Step checkpoints of the night's run. */
  runJson: string;
  /** The night's chosen targets (local, real data). */
  targetsJson: string;
  /** Evidence bundles and prechecks of the night (local, real data, deleted after 7 days). */
  bundlesDir: string;
  /** Every `claude -p` call: argv, CLI version, usage, cost, outcome — never the prompt. */
  claudeCallsJsonl: string;
  reportMd: string;
  summaryMd: string;
  planMd: string;
  fixBriefJson: string;
  /** Raw evidence per class, cache-first (`cache/<sid>/`). */
  cacheDir: string;
  /** Audits per class and text hash (`audits/<sid>/…`). */
  auditsDir: string;
  /** Metadata-only audit ledger (ids, hashes, modes, verdicts, cost — no text). */
  ledgerJsonl: string;
  /** Metadata-only cost lines, one per night. */
  costsJsonl: string;
  /** Reserve-before-spend ledger, across nights. */
  spendJsonl: string;
  lockFile: string;
  /** Marker the orchestrator polls before starting collection. */
  collectReady: string;
  /** Signed correction proposals, one per class (`verify`; local, real data, deleted after 7 days). */
  proposalsDir: string;
  /** Each verified class's candidates and checks, and the cached paid calls behind them (local, real data). */
  verifyDir: string;
  /** Where to write the night's replay (`--out=`) so it is deleted with the night's other real data. */
  replayDir: string;
  /** One line per correction outcome (`correct`): ids, codes and statuses only. */
  correctionsJsonl: string;
}

export function nightlyPaths(root: string, night: string): NightlyPaths {
  if (!isNightLabel(night)) throw new Error(`Not a night label: ${night}`);
  const nightDir = path.join(root, night);
  return {
    root,
    nightDir,
    runJson: path.join(nightDir, "run.json"),
    targetsJson: path.join(nightDir, "targets.json"),
    bundlesDir: path.join(nightDir, "bundles"),
    claudeCallsJsonl: path.join(nightDir, "claude-calls.jsonl"),
    reportMd: path.join(nightDir, "report.md"),
    summaryMd: path.join(nightDir, "summary.md"),
    planMd: path.join(nightDir, "plan.md"),
    fixBriefJson: path.join(nightDir, "fix-brief.json"),
    cacheDir: path.join(root, "cache"),
    auditsDir: path.join(root, "audits"),
    ledgerJsonl: path.join(root, "ledger.jsonl"),
    costsJsonl: path.join(root, "costs.jsonl"),
    spendJsonl: path.join(root, "spend.jsonl"),
    lockFile: path.join(root, "nightly.lock"),
    collectReady: path.join(root, "COLLECT_READY"),
    proposalsDir: path.join(nightDir, "proposals"),
    verifyDir: path.join(nightDir, "verify"),
    replayDir: path.join(nightDir, "replay"),
    correctionsJsonl: path.join(nightDir, "corrections.jsonl"),
  };
}

/** `cache/<sid>/` for one class (24-hex Wise ids only, so a path can never escape the cache). */
export function sessionCacheDir(cacheDir: string, wiseSessionId: string): string {
  if (!/^[0-9a-f]{24}$/iu.test(wiseSessionId)) throw new Error("Not a Wise session id");
  return path.join(cacheDir, wiseSessionId);
}

/** Create a directory (and its parents) 0700; the directory itself is set to 0700 even when it already existed. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: NIGHTLY_DIR_MODE });
  fs.chmodSync(dir, NIGHTLY_DIR_MODE);
}

function tempPath(file: string): string {
  return `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/** Write a whole file atomically (temp file, fsync, rename), 0600; the parent directory is created 0700. */
export function writeTextAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const temp = tempPath(file);
  const descriptor = fs.openSync(temp, "wx", NIGHTLY_FILE_MODE);
  try {
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.chmodSync(file, NIGHTLY_FILE_MODE);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A JSON file, or null when it is missing or unreadable. */
export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Append one JSON line and fsync it, 0600. A file whose last line was torn by a crash gets a newline first, so the
 * new line never joins the torn one.
 */
export function appendJsonl(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const line = `${JSON.stringify(value)}\n`;
  const descriptor = fs.openSync(file, "a+", NIGHTLY_FILE_MODE);
  try {
    const { size } = fs.fstatSync(descriptor);
    let prefix = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(descriptor, last, 0, 1, size - 1);
      if (last.toString("utf8") !== "\n") prefix = "\n";
    }
    fs.writeSync(descriptor, prefix + line);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, NIGHTLY_FILE_MODE);
}

/**
 * Every complete JSON line of a file (missing file: none). A line that does not parse — the torn last line of a
 * write a crash interrupted — is skipped: it never finished, so what it described never started.
 */
export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Torn by a crash: skipped.
    }
  }
  return out;
}
