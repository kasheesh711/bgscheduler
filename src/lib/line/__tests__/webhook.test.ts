import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/line/data", () => ({
  recordLineWebhookPayload: vi.fn(),
}));

import { recordLineWebhookPayload } from "@/lib/line/data";
import { handleLineWebhookPost } from "@/lib/line/webhook";

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("handleLineWebhookPost", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(recordLineWebhookPayload).mockResolvedValue({
      createdMessageIds: ["line-msg-1", "line-msg-2"],
      duplicateEvents: 1,
      ignoredEvents: 2,
      retractedMessages: 1,
    });
  });

  it("verifies the raw body before parsing and schedules only newly-created messages", async () => {
    const rawBody = JSON.stringify({ events: [{ webhookEventId: "event-1" }] });
    const scheduled: string[] = [];

    const result = await handleLineWebhookPost({
      db: {} as never,
      rawBody,
      signature: signature("secret", rawBody),
      channelSecret: "secret",
      scheduleProcessing: (lineMessageId) => scheduled.push(lineMessageId),
    });

    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        createdMessageIds: ["line-msg-1", "line-msg-2"],
        duplicateEvents: 1,
        ignoredEvents: 2,
        retractedMessages: 1,
      },
    });
    expect(recordLineWebhookPayload).toHaveBeenCalledWith(expect.anything(), { events: [{ webhookEventId: "event-1" }] });
    expect(scheduled).toEqual(["line-msg-1", "line-msg-2"]);
  });

  it("rejects bad signatures before touching persistence", async () => {
    const result = await handleLineWebhookPost({
      db: {} as never,
      rawBody: JSON.stringify({ events: [] }),
      signature: "bad",
      channelSecret: "secret",
      scheduleProcessing: vi.fn(),
    });

    expect(result.status).toBe(401);
    expect(recordLineWebhookPayload).not.toHaveBeenCalled();
  });

  it("returns a bad request for invalid JSON after signature verification", async () => {
    const rawBody = "{";

    const result = await handleLineWebhookPost({
      db: {} as never,
      rawBody,
      signature: signature("secret", rawBody),
      channelSecret: "secret",
      scheduleProcessing: vi.fn(),
    });

    expect(result.status).toBe(400);
    expect(recordLineWebhookPayload).not.toHaveBeenCalled();
  });
});
