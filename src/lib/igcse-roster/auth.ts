import { timingSafeEqual } from "node:crypto";

export type RosterSecretStatus = "valid" | "invalid" | "missing-secret";

/**
 * Constant-time Bearer check against ROSTER_EXPORT_SECRET. Same shape as the
 * CRON_SECRET check in `src/lib/internal/cron-auth.ts`: the length pre-check
 * avoids the RangeError `timingSafeEqual` throws on length-mismatched Buffers
 * and does not leak the secret length via timing.
 */
export function getRosterSecretStatus(authorizationHeader: string | null): RosterSecretStatus {
  const secret = process.env.ROSTER_EXPORT_SECRET;
  if (!secret) return "missing-secret";

  const received = Buffer.from(authorizationHeader ?? "");
  const known = Buffer.from(`Bearer ${secret}`);
  const valid = received.length === known.length && timingSafeEqual(received, known);
  return valid ? "valid" : "invalid";
}
