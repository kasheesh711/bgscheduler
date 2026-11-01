import { list } from "@vercel/blob";
import { isNotNull } from "drizzle-orm";
import { type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import type { ResumeFile } from "./resume-files";
import { applyBackfill, assertAutomationOff, backfillTodo } from "./sources";

export const BACKFILL_USAGE =
  "Usage: npm run hiring:backfill -- --seek [--limit N] | --tracker-report | --tracker-import\n" +
  "--seek also needs HIRING_BACKFILL_UNTIL, an ISO time at which the pass stops. No pass sends a message or changes a stage.";

export type BackfillArgs = { mode: "seek" | "tracker-report" | "tracker-import"; limit: number | null; until: number | null };

/** One mode flag. An unknown, repeated or missing flag throws the usage text. */
export function parseBackfillArgs(argv: string[], env: Record<string, string | undefined>, now = Date.now()): BackfillArgs {
  const modes = { "--seek": "seek", "--tracker-report": "tracker-report", "--tracker-import": "tracker-import" } as const;
  let mode: BackfillArgs["mode"] | null = null;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg in modes && !mode) mode = modes[arg as keyof typeof modes];
    else if (arg === "--limit" && limit === null && /^[1-9]\d*$/.test(argv[i + 1] ?? "")) limit = Number(argv[++i]);
    else throw new Error(BACKFILL_USAGE);
  }
  if (!mode || (limit !== null && mode !== "seek")) throw new Error(BACKFILL_USAGE);
  if (mode !== "seek") return { mode, limit: null, until: null };
  const until = env.HIRING_BACKFILL_UNTIL ? Date.parse(env.HIRING_BACKFILL_UNTIL) : NaN;
  if (!Number.isFinite(until)) throw new Error("Set HIRING_BACKFILL_UNTIL to an ISO stop time for the SEEK pass.");
  if (until <= now) throw new Error("HIRING_BACKFILL_UNTIL has already passed.");
  return { mode, limit, until };
}

export type BackfillRead = () => Promise<{ workRightsAnswer: string | null; file: ResumeFile | null }>;

/**
 * The decision for one SEEK card. It opens the page (`read`) only for a candidate that still needs it, waits `pause`
 * between candidates it reads, and says "stop" at the stop time, at the limit, or when asked. Paused automation throws.
 */
export function createBackfillStep(options: {
  db: Database;
  until: number;
  limit: number | null;
  pause: number;
  shouldStop: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { db, until, limit, pause, shouldStop, now = Date.now, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = options;
  let reads = 0;
  return async (applicationId: string, read: BackfillRead): Promise<"read" | "skipped" | "stop"> => {
    if (!(await backfillTodo(db, applicationId))) return "skipped";
    if (reads) await sleep(pause);
    if (shouldStop() || now() >= until || (limit !== null && reads >= limit)) return "stop";
    await assertAutomationOff(db);
    reads++;
    await applyBackfill(db, applicationId, await read());
    return "read";
  };
}

/** Stored files that no candidate row points to. Only counted: nothing is deleted. */
export async function countOrphanResumes(db: Database) {
  const known = new Set(
    (await db.select({ path: s.hiringCandidates.resumePath }).from(s.hiringCandidates).where(isNotNull(s.hiringCandidates.resumePath)))
      .map((r) => r.path),
  );
  let orphans = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: "hiring-resumes/", cursor, limit: 1000, abortSignal: AbortSignal.timeout(20000) });
    orphans += page.blobs.filter((blob) => !known.has(blob.pathname)).length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return orphans;
}
