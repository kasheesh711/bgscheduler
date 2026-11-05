import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/line/data", () => ({
  recordLineWebhookPayload: vi.fn(),
}));

vi.mock("@/lib/line/client", () => ({
  replyLineMessage: vi.fn(),
}));

import { replyLineMessage } from "@/lib/line/client";
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
      groupCommands: [],
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
        groupCommands: 0,
      },
    });
    expect(recordLineWebhookPayload).toHaveBeenCalledWith(expect.anything(), { events: [{ webhookEventId: "event-1" }] });
    expect(scheduled).toEqual(["line-msg-1", "line-msg-2"]);
  });

  it("keeps tutor bot events out of room booking and parent ingestion", async () => {
    const payload = { events: [{ type: "message", webhookEventId: "event-1",
      source: { type: "user", userId: "admin" },
      message: { id: "msg-1", type: "text", text: "/room" } }] };
    const rawBody = JSON.stringify(payload);
    vi.mocked(recordLineWebhookPayload).mockResolvedValue({ createdMessageIds: [],
      duplicateEvents: 0, ignoredEvents: 1, retractedMessages: 0, groupCommands: [] });
    const processing = vi.fn(), room = vi.fn();
    const result = await handleLineWebhookPost({ db: {} as never, rawBody,
      signature: signature("tutor-secret", rawBody), channelSecret: "tutor-secret",
      progressOnly: true, scheduleProcessing: processing, scheduleRoomCommand: room });
    expect(result.status).toBe(200);
    expect(recordLineWebhookPayload).toHaveBeenCalledWith(expect.anything(), payload, true);
    expect(processing).not.toHaveBeenCalled();
    expect(room).not.toHaveBeenCalled();
    const rejected = await handleLineWebhookPost({ db: {} as never, rawBody,
      signature: signature("parent-secret", rawBody), channelSecret: "tutor-secret",
      progressOnly: true, scheduleProcessing: processing });
    expect(rejected.status).toBe(401);
    expect(recordLineWebhookPayload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["user", false], ["group", false], ["room", false],
    ["user", true], ["group", true], ["room", true],
  ] as const)("replies to form commands in %s chats (tutor bot: %s) without forwarding them", async (sourceType, tutorBot) => {
    const source = { type: sourceType, userId: "tutor-1", groupId: "group-1", roomId: "room-1" };
    const unrelated = { type: "message", source, message: { type: "text", text: "/progress" } };
    const rawBody = JSON.stringify({ events: [
      { type: "message", source, replyToken: "leave-token", message: { type: "text", text: " /LEAVE " } },
      { type: "message", source, replyToken: "request-token", message: { type: "text", text: "/request" } },
      unrelated,
    ] });
    await handleLineWebhookPost({ db: {} as never, rawBody,
      signature: signature("secret", rawBody), channelSecret: "secret",
      progressOnly: tutorBot, scheduleProcessing: vi.fn() });

    expect(replyLineMessage).toHaveBeenCalledTimes(2);
    expect(replyLineMessage).toHaveBeenNthCalledWith(1, {
      replyToken: "leave-token", tutorBot,
      text: "Leave form\n- for taking leave (please inform 7 days in advance)\nhttps://docs.google.com/forms/d/e/1FAIpQLSd-tzTC1XrOq4MtvVjlueOrbZ-6vLJgKambL812dfItiGTJPw/formResponse",
    });
    expect(replyLineMessage).toHaveBeenNthCalledWith(2, {
      replyToken: "request-token", tutorBot,
      text: "- Request form (Changing availability and other issues)\nhttps://docs.google.com/forms/d/e/1FAIpQLSe8GzpXwjc-PPldy_nIat2kTQA8XQw6cGnKGALxn_vWEV_NAA/viewform",
    });
    const expectedArgs = [expect.anything(), { events: [unrelated] }, ...(tutorBot ? [true] : [])];
    expect(recordLineWebhookPayload).toHaveBeenCalledWith(...expectedArgs);
  });

  it("leaves partial commands, non-text events and missing reply tokens on the existing path", async () => {
    const payload = { events: [
      { type: "message", replyToken: "token", message: { type: "text", text: "/leave tomorrow" } },
      { type: "message", replyToken: "token", message: { type: "text", text: "/requests" } },
      { type: "postback", replyToken: "token", message: { type: "text", text: "/leave" } },
      { type: "message", message: { type: "text", text: "/request" } },
    ] };
    const rawBody = JSON.stringify(payload);
    await handleLineWebhookPost({ db: {} as never, rawBody,
      signature: signature("secret", rawBody), channelSecret: "secret", scheduleProcessing: vi.fn() });
    expect(replyLineMessage).not.toHaveBeenCalled();
    expect(recordLineWebhookPayload).toHaveBeenCalledWith(expect.anything(), payload);
  });

  it("rejects bad signatures before touching persistence", async () => {
    const result = await handleLineWebhookPost({
      db: {} as never,
      rawBody: JSON.stringify({ events: [{ type: "message", replyToken: "token", message: { type: "text", text: "/leave" } }] }),
      signature: "bad",
      channelSecret: "secret",
      scheduleProcessing: vi.fn(),
    });

    expect(result.status).toBe(401);
    expect(replyLineMessage).not.toHaveBeenCalled();
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
  it("calls the weekend handler only after a valid tutor-channel signature", async () => {
    const payload = { events: [{ type: "message", webhookEventId: "weekend-event", message: { type: "text", text: "/จัดตาราง" } }] };
    const rawBody = JSON.stringify(payload), handler = vi.fn().mockResolvedValue(true);
    const base = { db: {} as never, rawBody, channelSecret: "secret", progressOnly: true,
      scheduleProcessing: vi.fn(), handleWeekendCommand: handler };
    expect((await handleLineWebhookPost({ ...base, signature: "invalid" })).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    await handleLineWebhookPost({ ...base, signature: signature("secret", rawBody) });
    expect(handler).toHaveBeenCalledWith(payload.events[0]);
    expect(recordLineWebhookPayload).toHaveBeenLastCalledWith(expect.anything(), { events: [] }, true);
  });

});
