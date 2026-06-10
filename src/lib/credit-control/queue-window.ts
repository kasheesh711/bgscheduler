// ---------------------------------------------------------------------------
// Queue windowing — incremental slice rendering for the credit-control worklist
//
// The worklist can grow to the whole active roster while a search is live.
// Instead of mounting every row, the panel renders `windowSize` rows and grows
// the window when an IntersectionObserver sentinel at the bottom of the scroll
// container becomes visible. These helpers keep the window math pure and
// testable outside the component.
// ---------------------------------------------------------------------------

/** Rows mounted before the first "load more" sentinel intersection. */
export const QUEUE_WINDOW_INITIAL = 60;

/** Rows appended each time the sentinel becomes visible. */
export const QUEUE_WINDOW_STEP = 60;

/**
 * Next window size after the sentinel intersects. Grows by one step, clamped
 * to the total row count; never shrinks an already-grown window (so a poll
 * that briefly shortens the list cannot collapse the user's scroll position).
 */
export function getNextWindowSize(
  current: number,
  total: number,
  step: number = QUEUE_WINDOW_STEP,
): number {
  if (total <= current) return current;
  return Math.min(current + step, total);
}

/**
 * Window size needed so the row at `index` is mounted. Used by
 * `scrollToStudent` when the target row sits beyond the current window:
 * grow first, scroll on the next frame. Expands in whole steps so subsequent
 * sentinel growth stays aligned.
 */
export function getWindowSizeForIndex(
  index: number,
  current: number,
  step: number = QUEUE_WINDOW_STEP,
): number {
  if (index < current) return current;
  return Math.ceil((index + 1) / step) * step;
}
