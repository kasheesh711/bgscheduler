import { createHmac, timingSafeEqual } from "node:crypto";

export const RESEND_WEBHOOK_MAX_BODY_BYTES = 256_000;
/** Svix replay window. */
const TOLERANCE_SECONDS = 300;
const PROBLEM_TYPES: ReadonlySet<string> = new Set([
  "email.bounced", "email.complained", "email.delivery_delayed", "email.failed",
]);

/**
 * Verifies a Svix-signed Resend webhook: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` keyed by the base64 part of the
 * `whsec_…` secret; `svix-signature` holds space-separated `v1,<base64>`
 * candidates. Constant-time compare; 5-minute timestamp window.
 */
export function verifyResendSignature(input: {
  secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; now?: Date;
}): boolean {
  const { secret, id, timestamp, signature, body } = input;
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  // Svix keys are 24-32 bytes; a malformed secret decodes short/empty and must fail closed.
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface ParsedResendEvent {
  type: string;
  messageId: string | null;
  occurredAt: Date | null;
  bounceType: string | null;
}

export function parseResendEvent(body: string): ParsedResendEvent | null {
  let json: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown; bounce?: { type?: unknown } } };
  try { json = JSON.parse(body); } catch { return null; }
  if (typeof json?.type !== "string" || !json.type) return null;
  const created = typeof json.created_at === "string" ? new Date(json.created_at) : null;
  return {
    type: json.type,
    messageId: typeof json.data?.email_id === "string" ? json.data.email_id : null,
    occurredAt: created && !Number.isNaN(created.getTime()) ? created : null,
    bounceType: typeof json.data?.bounce?.type === "string" ? json.data.bounce.type : null,
  };
}

export function isDeliveryProblem(type: string): boolean {
  return PROBLEM_TYPES.has(type);
}
