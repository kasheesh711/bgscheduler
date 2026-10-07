import fs from "node:fs";
import path from "node:path";
import { addDays, bangkokDateKey } from "../quality";
import { isNightLabel, nightlyHome } from "./paths";

/**
 * Local evidence is kept 7 days (owner decision), then deleted: the per-class cache (`cache/<sid>/`), cached audits
 * (`audits/<sid>/`, they quote posts and evidence) and each old night's real-data files (bundles, targets, report,
 * plan). Metadata stays: run.json, summary.md, claude-calls.jsonl, fix-brief.json (sanitised), and the root
 * ledgers. Only paths inside the state root are touched, never `~/.bgscheduler-nightly/` itself or its `backup/`.
 */

export const RETENTION_DAYS = 7;
/** A night folder's real-data files and folders. */
const NIGHT_REAL_DATA = ["bundles", "targets.json", "report.md", "plan.md", "flags.json"];

export interface PruneResult {
  cacheDirs: string[];
  auditDirs: string[];
  nightFiles: string[];
}

/** The newest modification time of a directory's files (the directory's own when empty). */
function newestMtimeMs(dir: string): number {
  let newest = fs.statSync(dir).mtimeMs;
  for (const name of fs.readdirSync(dir)) {
    const stat = fs.statSync(path.join(dir, name));
    newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

export function pruneNightly(root: string, input: { now: Date; days?: number; dryRun?: boolean; home?: string }): PruneResult {
  const resolved = path.resolve(root);
  const home = path.resolve(nightlyHome(input.home));
  if (resolved === home || resolved === path.dirname(home) || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to prune ${resolved}: not a nightly state root`);
  }
  const days = input.days ?? RETENTION_DAYS;
  const cutoffMs = input.now.getTime() - days * 24 * 60 * 60 * 1000;
  const oldestKeptNight = addDays(bangkokDateKey(input.now), -days);
  const result: PruneResult = { cacheDirs: [], auditDirs: [], nightFiles: [] };
  const remove = (target: string, list: string[]) => {
    list.push(target);
    if (!input.dryRun) fs.rmSync(target, { recursive: true, force: true });
  };
  for (const [folder, list] of [["cache", result.cacheDirs], ["audits", result.auditDirs]] as const) {
    const dir = path.join(resolved, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{24}$/iu.test(name)) continue;
      const target = path.join(dir, name);
      if (fs.statSync(target).isDirectory() && newestMtimeMs(target) < cutoffMs) remove(target, list);
    }
  }
  // A night's real data goes once the night is more than `days` days before today (Bangkok).
  if (fs.existsSync(resolved)) {
    for (const name of fs.readdirSync(resolved)) {
      if (!isNightLabel(name) || name >= oldestKeptNight) continue;
      for (const entry of NIGHT_REAL_DATA) {
        const target = path.join(resolved, name, entry);
        if (fs.existsSync(target)) remove(target, result.nightFiles);
      }
    }
  }
  return result;
}
