import { createHash, timingSafeEqual } from "node:crypto";

/** Wise webhook deliveries larger than this are refused (they are small JSON). */
export const WISE_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/** Deliveries that can mean "a lesson just finished and may have a summary". */
export const AUTOWRITER_TRIGGER_EVENTS: ReadonlySet<string> = new Set([
  "MeetingEndedEvent",
  "AttendanceComputedEvent",
  "RecordingCompletedEvent",
]);

type WebhookEnvironment = Record<string, string | undefined>;

/** With the backstop cron, a disabled receiver acknowledges (200) and does nothing. */
export function wiseWebhooksEnabled(env: WebhookEnvironment = process.env): boolean {
  return env.WISE_WEBHOOKS_ENABLED === "true";
}

/**
 * Wise documents "an authorisation key in the header" without naming the
 * header. `WISE_WEBHOOK_AUTH_HEADER` pins it; unset → null (any header).
 */
export function wiseWebhookAuthHeader(env: WebhookEnvironment = process.env): string | null {
  return env.WISE_WEBHOOK_AUTH_HEADER?.trim().toLowerCase() || null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time comparison of the shared key, bare or after one auth scheme word (`Bearer …`, `Basic …`). */
export function verifyWiseWebhookAuth(headerValue: string | null, secret: string | null | undefined): boolean {
  const expected = secret?.trim();
  const received = headerValue?.trim();
  if (!expected || !received) return false;
  return safeEqual(received, expected) || safeEqual(received.replace(/^[A-Za-z]+\s+/u, ""), expected);
}

/**
 * The name of the header that carried the shared key, or null. With a pinned
 * name only that header counts; without one every header value is compared in
 * constant time — the random key is what authenticates, not the header name —
 * so the first real delivery works and reveals the name to pin.
 */
export function findWiseWebhookAuthHeader(
  headers: Iterable<[string, string]>,
  secret: string | null | undefined,
  pinned: string | null,
): string | null {
  for (const [name, value] of headers) {
    const header = name.toLowerCase();
    if (pinned && header !== pinned) continue;
    if (verifyWiseWebhookAuth(value, secret)) return header;
  }
  return null;
}

const OBJECT_ID = /^[0-9a-f]{24}$/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function pickString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Best-effort event name + session id. Wise's samples nest differently per
 * event (`payload.sessionId`, `payload.session._id`, `payload.payload.object`),
 * and the body is only a hint — the session is always re-read from Wise.
 */
export function parseWiseWebhookBody(raw: string): {
  eventName: string | null;
  sessionId: string | null;
  json: Record<string, unknown>;
} | null {
  let json: Record<string, unknown> | null;
  try {
    json = asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!json) return null;
  const payload = asRecord(json.payload);
  const eventName = pickString(json, ["eventName", "event", "type", "name", "event_name"])
    ?? pickString(payload, ["eventName", "event", "type"]);
  const session = asRecord(payload?.session);
  const innerPayload = asRecord(payload?.payload);
  const candidates = [
    pickString(payload, ["sessionId", "session_id"]),
    pickString(session, ["_id", "id"]),
    pickString(json, ["sessionId", "session_id"]),
    pickString(innerPayload, ["sessionId", "session_id"]),
  ];
  const sessionId = candidates.find((value): value is string => Boolean(value && OBJECT_ID.test(value))) ?? null;
  return { eventName, sessionId, json };
}

/** Wise retries resend the same body; its hash is the delivery's identity. */
export function wiseWebhookDedupeKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
