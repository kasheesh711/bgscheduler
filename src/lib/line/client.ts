import { randomUUID } from "crypto";

const LINE_API_BASE = "https://api.line.me";

export interface LineProfile {
  userId: string;
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  raw: Record<string, unknown>;
}

export interface LinePushResult {
  retryKey: string;
  sentMessageId: string | null;
  response: Record<string, unknown>;
}

export function lineSchedulerEnabled(): boolean {
  return process.env.ENABLE_LINE_SCHEDULER !== "false" &&
    Boolean(process.env.LINE_CHANNEL_SECRET?.trim()) &&
    Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim());
}

export function lineChannelSecret(): string | undefined {
  return process.env.LINE_CHANNEL_SECRET?.trim();
}

function lineAccessToken(): string {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  return token;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function fetchLineProfile(userId: string): Promise<LineProfile | null> {
  const response = await fetch(`${LINE_API_BASE}/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${lineAccessToken()}`,
    },
  });

  if (response.status === 404) return null;
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(typeof payload.message === "string" ? payload.message : `LINE profile returned HTTP ${response.status}`);
  }

  return {
    userId,
    displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
    pictureUrl: typeof payload.pictureUrl === "string" ? payload.pictureUrl : undefined,
    statusMessage: typeof payload.statusMessage === "string" ? payload.statusMessage : undefined,
    raw: payload,
  };
}

export interface LineFollowersPage {
  userIds: string[];
  next: string | undefined;
}

export async function fetchLineFollowerIds(startCursor?: string): Promise<LineFollowersPage> {
  const url = new URL(`${LINE_API_BASE}/v2/bot/followers/ids`);
  url.searchParams.set("limit", "300");
  if (startCursor) url.searchParams.set("start", startCursor);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${lineAccessToken()}` },
  });

  // Note: no 404 case for followers/ids (unlike fetchLineProfile)
  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new Error(typeof payload.message === "string" ? payload.message : `LINE followers/ids returned HTTP ${response.status}`);
  }

  const userIds = Array.isArray(payload.userIds)
    ? payload.userIds.filter((id): id is string => typeof id === "string")
    : [];
  const next = typeof payload.next === "string" ? payload.next : undefined;
  return { userIds, next };
}

/**
 * Fetch LINE profiles for a list of userIds with bounded concurrency.
 * Skips 404s (follower has no profile or blocked the OA).
 * Returns a Map keyed by userId for O(1) lookup.
 */
export async function fetchLineProfilesBatched(
  userIds: string[],
  concurrencyLimit = 5,
): Promise<Map<string, LineProfile>> {
  const result = new Map<string, LineProfile>();
  for (let i = 0; i < userIds.length; i += concurrencyLimit) {
    const chunk = userIds.slice(i, i + concurrencyLimit);
    const profiles = await Promise.all(chunk.map((id) => fetchLineProfile(id)));
    for (let j = 0; j < chunk.length; j += 1) {
      const profile = profiles[j];
      if (profile !== null) result.set(chunk[j]!, profile);
      // null → fetchLineProfile returned 404 → skip entry in result Map
    }
  }
  return result;
}

export async function pushLineTextMessage(input: {
  to: string;
  text: string;
  retryKey?: string;
}): Promise<LinePushResult> {
  const retryKey = input.retryKey ?? randomUUID();
  const response = await fetch(`${LINE_API_BASE}/v2/bot/message/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lineAccessToken()}`,
      "Content-Type": "application/json",
      "X-Line-Retry-Key": retryKey,
    },
    body: JSON.stringify({
      to: input.to,
      messages: [{ type: "text", text: input.text }],
    }),
  });

  const payload = asRecord(await response.json().catch(() => ({})));
  if (!response.ok && response.status !== 409) {
    throw new Error(typeof payload.message === "string" ? payload.message : `LINE push returned HTTP ${response.status}`);
  }

  const responsePayload: Record<string, unknown> = { ...payload };
  if (response.status === 409) {
    responsePayload.retryAccepted = true;
    const acceptedRequestId = response.headers.get("x-line-accepted-request-id");
    if (acceptedRequestId) responsePayload.acceptedRequestId = acceptedRequestId;
  }
  const sentMessages = Array.isArray(payload.sentMessages) ? payload.sentMessages : [];
  const first = asRecord(sentMessages[0]);
  return {
    retryKey,
    sentMessageId: typeof first.id === "string" ? first.id : null,
    response: responsePayload,
  };
}
