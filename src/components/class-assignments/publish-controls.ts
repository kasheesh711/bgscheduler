export type PublishJobStatus = "pending" | "running" | "succeeded" | "partial" | "failed";

/** A paused recovery worker needs an explicit owner retry once Wise's cooldown expires. */
export function canRetryPausedPublish(progress: { status: string; nextAttemptAt?: string | null }, now: number): boolean {
  return progress.status === "pending" && Date.parse(progress.nextAttemptAt ?? "") <= now;
}

export function isPublishJobTerminal(status: PublishJobStatus): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

/**
 * Reproduces the publish dialog's own "Publish to Wise"/"Retry publish"
 * button disable expression, minus the permission term (the dialog is
 * already unreachable for a non-canPublishAndRun viewer via its `open` prop).
 */
export function isPublishActionDisabled(input: {
  hasEligibleRows: boolean;
  publishing: boolean;
  progress: { status: PublishJobStatus; nextAttemptAt?: string | null } | null;
  automationPaused: boolean;
  now: number;
}): boolean {
  return (
    input.publishing ||
    !input.hasEligibleRows ||
    Boolean(
      input.progress &&
      !isPublishJobTerminal(input.progress.status) &&
      !(input.automationPaused && canRetryPausedPublish(input.progress, input.now)),
    )
  );
}
