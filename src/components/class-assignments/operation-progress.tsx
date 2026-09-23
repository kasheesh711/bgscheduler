export type OperationStepStatus = "pending" | "active" | "done";

export interface OperationStep {
  label: string;
  status: OperationStepStatus;
}

/** Mirrors the workspace's original inline duration formatter exactly. */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Always rounds up so a near-zero remaining time never reads "about 0s left". */
export function formatEtaLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `about ${totalSeconds}s left`;
  const minutes = Math.max(1, Math.ceil(totalSeconds / 60));
  return `about ${minutes}m left`;
}

/**
 * vercel.json's publish-recovery cron fires at UTC minutes 1,6,11,...,56 of
 * every hour ("1-56/5 * * * *"). A paused/deferred publish job is only ever
 * actually resumed on one of these ticks, so the paused label below reports
 * the first tick at or after the job's nextAttemptAt rather than
 * nextAttemptAt itself.
 */
const PUBLISH_RECOVERY_CRON_MINUTES = [1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56];

export function nextPublishRecoveryTick(after: Date): Date {
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  while (
    !PUBLISH_RECOVERY_CRON_MINUTES.includes(candidate.getUTCMinutes()) ||
    candidate.getTime() < after.getTime()
  ) {
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return candidate;
}

const BANGKOK_HH_MM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bangkok",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Honest about WHEN work resumes: a deferred/cooldown job is only actually
 * retried on the next publish-recovery cron tick, not at nextAttemptAt itself.
 */
export function formatPausedLabel(reasonText: string, pausedUntilIso: string, now: Date): string {
  const pausedUntil = new Date(pausedUntilIso);
  const basis = pausedUntil.getTime() > now.getTime() ? pausedUntil : now;
  const tick = nextPublishRecoveryTick(basis);
  return `${reasonText} — resumes automatically at about ${BANGKOK_HH_MM.format(tick)} (safe to close)`;
}

export interface OperationProgressProps {
  steps: OperationStep[];
  elapsedMs: number | null;
  etaMs?: number | null;
  /** ISO instant the operation is deferred until; only treated as "paused" when it is still in the future. */
  pausedUntil?: string | null;
  pausedReason?: string | null;
  now?: Date;
  /** False while an in-progress step would be lost (not just delayed) if the tab were closed right now. */
  safeToClose?: boolean;
}

/** Live step / elapsed / ETA / paused indicator shared by the sync-then-run flow and the publish dialog. */
export function OperationProgress({
  steps,
  elapsedMs,
  etaMs = null,
  pausedUntil = null,
  pausedReason = null,
  now = new Date(),
  safeToClose,
}: OperationProgressProps) {
  const pausedUntilDate = pausedUntil ? new Date(pausedUntil) : null;
  const isPaused = Boolean(pausedUntilDate && pausedReason && pausedUntilDate.getTime() > now.getTime());
  const terminal = steps.length > 0 && steps.every(step => step.status === "done");

  return (
    <div className="space-y-2 text-sm">
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {steps.map(step => (
          <li
            key={step.label}
            className={
              step.status === "done"
                ? "text-available"
                : step.status === "active"
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
            }
          >
            {step.label}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Elapsed {formatElapsed(elapsedMs)}</span>
        {!terminal && isPaused && pausedUntilDate && pausedReason && (
          <span>{formatPausedLabel(pausedReason, pausedUntilDate.toISOString(), now)}</span>
        )}
        {!terminal && !isPaused && etaMs !== null && etaMs !== undefined && (
          <span>{formatEtaLabel(etaMs)}</span>
        )}
      </div>
      {!terminal && safeToClose === false && (
        <div className="text-xs text-muted-foreground">Keep this page open until this finishes.</div>
      )}
    </div>
  );
}
