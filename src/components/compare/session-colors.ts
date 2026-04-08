/**
 * Shared session block styling for calendar-grid and week-overview.
 *
 * All sessions use the same background opacity for visual consistency.
 * Online vs onsite is distinguished by border style:
 * - Onsite: solid left border
 * - Online: dashed left border
 */

const ONLINE_PATTERNS = ["http", "online", "learn.", "zoom", "meet.google", "virtual"];

export function isOnlineSession(location?: string): boolean {
  if (!location) return false;
  const lower = location.toLowerCase();
  return ONLINE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Background color for a session block.
 * Single consistent opacity (18%) for all non-conflict sessions.
 */
export function sessionBgColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "rgba(239, 68, 68, 0.18)";
  return `${tutorColor ?? "#888"}2e`;
}

/**
 * Text color for the primary label in a session block.
 */
export function sessionTextColor(
  tutorColor: string | undefined,
  isConflict: boolean,
): string {
  if (isConflict) return "#dc2626";
  return tutorColor ?? "#888";
}

/**
 * Border style string for the left border of a session block.
 * Onsite = solid, Online = dashed.
 */
export function sessionBorderStyle(
  tutorColor: string | undefined,
  isConflict: boolean,
  location?: string,
): string {
  const color = isConflict ? "#ef4444" : (tutorColor ?? "#888");
  const style = isOnlineSession(location) ? "dashed" : "solid";
  return `3px ${style} ${color}`;
}
