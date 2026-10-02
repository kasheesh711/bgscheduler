import fs from "node:fs";
import path from "node:path";
import { NIGHTLY_FILE_MODE, ensureDir, nightlyHome } from "./paths";

/**
 * The nightly audit's hard limits, its owner config and its kill switches. The owner's config
 * (`~/.bgscheduler-nightly/config.json`) may only make a limit stricter; the one exception is `--soniox-usd=<n>`,
 * which may raise the night's Soniox cap up to SONIOX_USD_FLAG_MAX for one run (first nights, when the production
 * transcripts of already-approved posts are gone).
 */
export const NIGHTLY_CAPS = Object.freeze({
  maxTargets: 60,
  maxWiseReads: 200,
  /** At least this long between two Wise reads (≤ 0.2 req/s). */
  wisePacingMs: 5_000,
  maxOpusCalls: 80,
  perAuditUsd: 1.5,
  perReauditUsd: 1.5,
  perSynthesisUsd: 2,
  maxClaudeUsdNight: 25,
  maxClaudeUsdWeek: 120,
  maxSonioxUsdNight: 2,
  maxOpenRouterUsdNight: 3,
  maxCorrectionsPerNight: 6,
  maxCorrectionsPerWeek: 15,
  maxFlagsPerNight: 10,
  auditConcurrency: 2,
  /** Bangkok time on the morning after the audited day when every step stops. */
  deadlineBangkok: "06:50",
});

export type NightlyCaps = {
  -readonly [K in keyof typeof NIGHTLY_CAPS]: (typeof NIGHTLY_CAPS)[K] extends string ? string : number;
};

/** The most `--soniox-usd=<n>` may raise the Soniox cap to, for one run. */
export const SONIOX_USD_FLAG_MAX = 5;

/** Limits where a larger value is the stricter one; every other number is stricter when smaller. */
const LARGER_IS_STRICTER = new Set<keyof NightlyCaps>(["wisePacingMs"]);

/** The kill switches: either file stops every step (absolute paths, so a moved checkout cannot hide one). */
export function stopFiles(home?: string): string[] {
  return [
    path.join(nightlyHome(home), "STOP"),
    "/Users/kevinhsieh/Developer/Scheduling/.feedback-autowriter/STOP",
  ];
}

/** The first STOP file present, or null. */
export function stopFilePresent(files: readonly string[] = stopFiles()): string | null {
  return files.find((file) => fs.existsSync(file)) ?? null;
}

export function stopRequested(files: readonly string[] = stopFiles()): boolean {
  return stopFilePresent(files) !== null;
}

/**
 * Write the home STOP file (a cap was breached after the fact). Never removed by the nightly itself: the owner
 * deletes it once they have looked.
 */
export function writeStopFile(reason: string, home?: string, now: Date = new Date()): string {
  const file = path.join(nightlyHome(home), "STOP");
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${now.toISOString()} ${reason.slice(0, 500)}\n`, { encoding: "utf8", mode: NIGHTLY_FILE_MODE, flag: "a" });
  return file;
}

/** How long a Wise 429 parks every Wise read of the nightly. */
export const WISE_COOLDOWN_MS = 30 * 60 * 1000;

/** Where a Wise 429 parks Wise reads (`~/.bgscheduler-nightly/wise-cooldown-until`, an ISO instant). */
export function wiseCooldownFile(home?: string): string {
  return path.join(nightlyHome(home), "wise-cooldown-until");
}

/** The instant Wise reads may resume, when a cooldown is still running. */
export function activeWiseCooldown(now: Date = new Date(), home?: string): Date | null {
  let text: string;
  try {
    text = fs.readFileSync(wiseCooldownFile(home), "utf8").trim();
  } catch {
    return null;
  }
  const until = new Date(text);
  // An unreadable cooldown fails closed for its default length from the file's own time.
  if (Number.isNaN(until.getTime())) {
    const written = fs.statSync(wiseCooldownFile(home)).mtime;
    const fallback = new Date(written.getTime() + WISE_COOLDOWN_MS);
    return fallback > now ? fallback : null;
  }
  return until > now ? until : null;
}

export function writeWiseCooldown(now: Date = new Date(), home?: string, ms: number = WISE_COOLDOWN_MS): Date {
  const until = new Date(now.getTime() + ms);
  const file = wiseCooldownFile(home);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${until.toISOString()}\n`, { encoding: "utf8", mode: NIGHTLY_FILE_MODE });
  return until;
}

export function ownerConfigFile(home?: string): string {
  return path.join(nightlyHome(home), "config.json");
}

export type OwnerConfig = { ok: true; caps: Partial<NightlyCaps>; notes: string[] } | { ok: false; reason: string };

/**
 * The owner's config: `{ "caps": { "maxTargets": 40, … } }` (keys may also sit at the top level). Missing file: no
 * changes. A file that does not parse is a config error (fail closed, never ignored); unknown keys and values of the
 * wrong type are noted and ignored.
 */
export function loadOwnerConfig(file: string = ownerConfigFile()): OwnerConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, caps: {}, notes: [] };
    return { ok: false, reason: `owner config unreadable: ${(error as Error).message.slice(0, 120)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "owner config is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "owner config must be a JSON object" };
  const record = parsed as Record<string, unknown>;
  const source = record.caps && typeof record.caps === "object" && !Array.isArray(record.caps)
    ? record.caps as Record<string, unknown> : record;
  const caps: Partial<NightlyCaps> = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === "caps") continue;
    if (!(key in NIGHTLY_CAPS)) {
      notes.push(`unknown key ignored: ${key}`);
      continue;
    }
    const name = key as keyof NightlyCaps;
    if (name === "deadlineBangkok") {
      if (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value)) caps.deadlineBangkok = value;
      else notes.push("deadlineBangkok ignored: not HH:MM");
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      notes.push(`${name} ignored: not a non-negative number`);
      continue;
    }
    (caps as Record<string, number>)[name] = value;
  }
  return { ok: true, caps, notes };
}

/**
 * The limits for one run: the defaults, made stricter (never looser) by the owner's config, then `--soniox-usd`
 * (0 to SONIOX_USD_FLAG_MAX) for the Soniox cap alone.
 */
export function effectiveCaps(input: { config?: Partial<NightlyCaps>; sonioxUsdFlag?: number | null } = {}): {
  caps: NightlyCaps;
  notes: string[];
} {
  const caps = { ...NIGHTLY_CAPS } as NightlyCaps;
  const notes: string[] = [];
  for (const [key, value] of Object.entries(input.config ?? {})) {
    const name = key as keyof NightlyCaps;
    if (value === undefined || !(name in NIGHTLY_CAPS)) continue;
    if (name === "deadlineBangkok") {
      if (typeof value === "string" && value < caps.deadlineBangkok) caps.deadlineBangkok = value;
      else if (value !== caps.deadlineBangkok) notes.push("deadlineBangkok: config may only make it earlier");
      continue;
    }
    const current = caps[name] as number;
    const next = value as number;
    const stricter = LARGER_IS_STRICTER.has(name) ? next >= current : next <= current;
    if (stricter) (caps as Record<string, number | string>)[name] = next;
    else notes.push(`${name}: config may only make it stricter (kept ${current})`);
  }
  if (caps.auditConcurrency < 1) caps.auditConcurrency = 1;
  if (input.sonioxUsdFlag !== undefined && input.sonioxUsdFlag !== null) {
    if (!Number.isFinite(input.sonioxUsdFlag) || input.sonioxUsdFlag < 0 || input.sonioxUsdFlag > SONIOX_USD_FLAG_MAX) {
      throw new Error(`--soniox-usd must be a number from 0 to ${SONIOX_USD_FLAG_MAX}`);
    }
    caps.maxSonioxUsdNight = input.sonioxUsdFlag;
    notes.push(`maxSonioxUsdNight set to ${input.sonioxUsdFlag} for this run (--soniox-usd)`);
  }
  return { caps, notes };
}
