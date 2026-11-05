import { createHash, createHmac } from "node:crypto";
import { addBangkokDays } from "@/lib/room-capacity/dates";

export const THEA_ACTOR_PREFIX = "thea-weekend:";
export function theaEnabled() {
  return process.env.THEA_WEEKEND_COMMANDS_ENABLED === "true"
    && /^C[a-f0-9]{32}$/i.test(process.env.THEA_LINE_GROUP_ID ?? "");
}
export function isTheaCommand(text: string) {
  return ["/จัดตะราง", "/จัดตาราง"].includes(text.trim());
}
export function theaLinkExpiry(saturday: string) {
  return new Date(`${addBangkokDays(saturday, 3)}T00:00:00+07:00`);
}
// A keyed, domain-separated capability can be retried without storing its plaintext.
export function theaToken(requestId: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Thea link signing is not configured.");
  return createHmac("sha256", secret).update(`thea-weekend-pdf:${requestId}`).digest("base64url");
}
export const hashTheaToken = (token: string) => createHash("sha256").update(token).digest("hex");
