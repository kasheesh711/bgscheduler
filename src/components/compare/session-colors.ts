/**
 * Shared session block color logic for calendar-grid and week-overview.
 *
 * Online sessions use a lighter shade, onsite sessions use a slightly
 * darker shade. Conflict sessions are always red.
 *
 * Heuristic for online detection: location contains "http", "online",
 * "learn.", "zoom", "meet.google", or is empty/undefined (unknown → lighter).
 */

const ONLINE_PATTERNS = ["http", "online", "learn.", "zoom", "meet.google", "virtual"];

function isOnlineSession(location?: string): boolean {
  if (!location) return false;
  const lower = location.toLowerCase();
  return ONLINE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Background color for a session block.
 * - Conflict: semi-transparent red
 * - Online: tutor color at 18% opacity (lighter)
 * - Onsite: tutor color at 28% opacity (slightly darker)
 */
export function sessionBgColor(
  tutorColor: string | undefined,
  isConflict: boolean,
  location?: string,
): string {
  if (isConflict) return "rgba(239, 68, 68, 0.18)";
  const color = tutorColor ?? "#888";
  if (isOnlineSession(location)) return `${color}2e`; // 18%
  return `${color}47`; // 28%
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
