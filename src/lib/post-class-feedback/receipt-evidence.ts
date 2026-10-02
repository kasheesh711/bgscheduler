import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FeedbackReceiptEvidence } from "@/lib/db/schema";
const hash = (value: string) => createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
export function newReceiptChallenge(actor: string, binding: string, now = new Date()) {
  const code = randomBytes(8).toString("hex").toUpperCase();
  const evidence: FeedbackReceiptEvidence = { hash: hash(code), actor: actor.toLowerCase(), binding,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), attempts: 0 };
  return { code, evidence };
}
export function checkReceiptChallenge(evidence: FeedbackReceiptEvidence, code: string, actor: string, binding: string, now = new Date()): FeedbackReceiptEvidence {
  const result = { ...evidence, attempts: evidence.attempts + 1 };
  if (!evidence.receipt || !evidence.acceptedAt || evidence.actor !== actor.toLowerCase() || evidence.binding !== binding ||
    new Date(evidence.expiresAt).getTime() <= now.getTime() || evidence.attempts >= 5) return result;
  const actual = Buffer.from(hash(code)); const expected = Buffer.from(evidence.hash);
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) result.confirmedAt = now.toISOString();
  return result;
}
