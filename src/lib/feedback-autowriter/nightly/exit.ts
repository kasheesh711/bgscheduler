/**
 * Exit codes of `scripts/feedback-autowriter-nightly.ts`, and the error a step throws to stop the whole stage (never
 * a retry loop: the run writes a partial report and ends).
 */
export const EXIT = {
  /** Done, or nothing to do. */
  ok: 0,
  error: 1,
  /** Bad arguments or owner config. */
  usage: 2,
  /** A cap refused the next spend. */
  caps: 3,
  /** Claude usage limit, auth, or a model that is not Opus 5.5. */
  model: 4,
  /** Wise answered 429, or its cooldown is still running. */
  wiseThrottled: 5,
  /** A guard refused (dirty tree, wrong checkout, missing environment). */
  guardRefused: 6,
  /** A STOP file, the lock, or the deadline. */
  stopped: 7,
  /** Something that must never happen happened (a write path was reachable, a cap was breached). */
  safety: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Stops the current stage and the run. `reason` is a short code for the step's JSON line. */
export class NightlyStop extends Error {
  constructor(readonly reason: string, readonly exitCode: ExitCode) {
    super(reason);
    this.name = "NightlyStop";
  }
}

/** The exit code a stop reason maps to. */
export function exitCodeForStop(reason: string): ExitCode {
  if (reason.startsWith("cap:")) return EXIT.caps;
  if (reason === "wise_429" || reason === "wise_cooldown") return EXIT.wiseThrottled;
  if (reason === "usage_limited" || reason === "auth" || reason.startsWith("model_")) return EXIT.model;
  if (reason === "stop_file" || reason === "deadline" || reason === "locked") return EXIT.stopped;
  if (reason.startsWith("breach:")) return EXIT.safety;
  return EXIT.error;
}
