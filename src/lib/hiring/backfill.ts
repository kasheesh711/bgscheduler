import { type Database } from "@/lib/db";
import { applyBackfill, assertAutomationOff, backfillStatus, type BackfillPage } from "./sources";

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

/** What the page script returns for one card. `applicationId` is the id the page showed when it read, not the one planned. */
export type BackfillRead = BackfillPage & { applicationId: string };

/** An error the pass must not absorb as one unreadable card, such as a lost sign-in. */
export class BackfillFatal extends Error {}

export const MAX_READ_FAILURES = 5;

/**
 * The decision for one SEEK card. It opens the page (`read`) only for a candidate that still needs it, waits `pause`
 * between candidates it reads, and says "stop" at the stop time, at the limit, or when asked.
 *
 * A read that throws, or that returns another application than the one expected (the list moved), writes nothing,
 * is counted in `readFailed` and the pass goes on. Five failures in a row end the pass, because that means a lost
 * sign-in or changed page. A paused-automation error and any write error are never absorbed.
 */
export function createBackfillStep(options: {
  db: Database;
  until: number;
  limit: number | null;
  pause: number;
  shouldStop: () => boolean;
  maxFailures?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { db, until, limit, pause, shouldStop, maxFailures = MAX_READ_FAILURES, now = Date.now, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = options;
  const counts = {
    read: 0,
    done: 0,
    notOurs: 0,
    answersFilled: 0,
    answersReplaced: 0,
    filesStored: 0,
    fileFailed: 0,
    fileUnusable: 0,
    readFailed: 0,
  };
  let attempts = 0;
  let streak = 0;
  const run = async (applicationId: string, read: () => Promise<BackfillRead>): Promise<"read" | "skipped" | "failed" | "stop"> => {
    if (shouldStop()) return "stop";
    const status = await backfillStatus(db, applicationId);
    if (status.state !== "todo") {
      counts[status.state]++;
      return "skipped";
    }
    if (attempts) await sleep(pause);
    if (shouldStop() || now() >= until || (limit !== null && attempts >= limit)) return "stop";
    await assertAutomationOff(db);
    attempts++;
    let page: BackfillRead;
    try {
      page = await read();
      if (page.applicationId !== applicationId) throw new Error("The SEEK list moved while the pass read it.");
    } catch (error) {
      if (error instanceof BackfillFatal) throw error;
      counts.readFailed++;
      if (++streak >= maxFailures)
        throw new BackfillFatal(`${maxFailures} candidates in a row could not be read. SEEK may be signed out or its page may have changed.`);
      return "failed";
    }
    streak = 0;
    const outcome = await applyBackfill(db, applicationId, page);
    if (!outcome) return "skipped";
    counts.read++;
    if (outcome.answer === "filled") counts.answersFilled++;
    if (outcome.answer === "replaced") counts.answersReplaced++;
    if (outcome.file === "stored") counts.filesStored++;
    if (outcome.file === "failed") counts.fileFailed++;
    if (outcome.file === "unusable") counts.fileUnusable++;
    return "read";
  };
  return { run, counts };
}
