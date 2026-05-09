export type CalendarViewTransitionKind = "week-forward" | "week-back" | "day";

export const WEEK_RAPID_NAVIGATION_MS = 300;

export interface RunCalendarViewTransitionOptions {
  kind: CalendarViewTransitionKind;
  skip?: boolean;
  documentRef?: Document;
  reducedMotion?: boolean;
}

export function getWeekTransitionKind(
  currentWeek: string,
  targetWeek: string,
): "week-forward" | "week-back" | null {
  if (targetWeek > currentWeek) {
    return "week-forward";
  }

  if (targetWeek < currentWeek) {
    return "week-back";
  }

  return null;
}

export function isRapidWeekNavigation(
  previousStartedAt: number | null,
  nowMs: number,
  thresholdMs = WEEK_RAPID_NAVIGATION_MS,
): boolean {
  if (previousStartedAt === null) {
    return false;
  }

  return nowMs - previousStartedAt < thresholdMs;
}

export async function runCalendarViewTransition(
  update: () => void | Promise<void>,
  options: RunCalendarViewTransitionOptions,
): Promise<void> {
  const doc = options.documentRef ?? getGlobalDocument();

  if (
    options.skip === true ||
    getReducedMotionPreference(options.reducedMotion) ||
    !doc ||
    typeof doc.startViewTransition !== "function"
  ) {
    await update();
    return;
  }

  const transition = doc.startViewTransition({ update, types: [options.kind] });

  try {
    await transition.finished;
  } catch {
    // The DOM update has already run; a skipped/interrupted transition should not
    // fail calendar navigation.
  }
}

function getGlobalDocument(): Document | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  return document;
}

function getReducedMotionPreference(reducedMotion?: boolean): boolean {
  if (reducedMotion !== undefined) {
    return reducedMotion;
  }

  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
