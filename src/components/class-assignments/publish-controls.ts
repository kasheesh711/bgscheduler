/** A paused recovery worker needs an explicit owner retry once Wise's cooldown expires. */
export function canRetryPausedPublish(progress: { status: string; nextAttemptAt?: string | null }, now: number): boolean {
  return progress.status === "pending" && Date.parse(progress.nextAttemptAt ?? "") <= now;
}
