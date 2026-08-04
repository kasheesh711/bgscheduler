import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLineFollowerIds, pushLineTextMessage, replyLineMessage } from "@/lib/line/client";

describe("LINE client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("treats an accepted retry-key conflict as a successful push result", async () => {
    const retryKey = "00000000-0000-5000-8000-000000000001";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: "The retry key is already accepted",
      sentMessages: [{ id: "line-out-1" }],
    }), {
      status: 409,
      headers: {
        "x-line-accepted-request-id": "accepted-request-1",
      },
    }));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushLineTextMessage({
      to: "line-user-1",
      text: "Approved text",
      retryKey,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/push",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer line-token",
          "X-Line-Retry-Key": retryKey,
        }),
      }),
    );
    expect(result).toEqual({
      retryKey,
      sentMessageId: "line-out-1",
      response: {
        message: "The retry key is already accepted",
        sentMessages: [{ id: "line-out-1" }],
        retryAccepted: true,
        acceptedRequestId: "accepted-request-1",
      },
    });
  });
});

describe("fetchLineFollowerIds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fetches first page without cursor", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      userIds: ["Uaaa", "Ubbb"],
      next: "cur1",
    }), { status: 200 }));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLineFollowerIds();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/followers/ids?limit=300",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer line-token",
        }),
      }),
    );
    expect(result).toEqual({ userIds: ["Uaaa", "Ubbb"], next: "cur1" });
  });

  it("fetches next page with cursor", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      userIds: ["Uccc"],
    }), { status: 200 }));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLineFollowerIds("cur1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/followers/ids?limit=300&start=cur1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer line-token",
        }),
      }),
    );
    expect(result).toEqual({ userIds: ["Uccc"], next: undefined });
  });

  it("throws on non-ok response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: "Unauthorized",
    }), { status: 401 }));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLineFollowerIds()).rejects.toThrow("Unauthorized");
  });

  it("filters non-string values from userIds", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      userIds: ["Uaaa", 123, null, "Ubbb"],
    }), { status: 200 }));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLineFollowerIds();

    expect(result).toEqual({ userIds: ["Uaaa", "Ubbb"], next: undefined });
  });

  it("replies to a conversation with the reply token", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(
      JSON.stringify({ sentMessages: [{ id: "line-reply-1" }] }),
      { status: 200 },
    ));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    const result = await replyLineMessage({ replyToken: "tok-1", text: "Schedule link" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.line.me/v2/bot/message/reply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer line-token" }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toEqual({
      replyToken: "tok-1",
      messages: [{ type: "text", text: "Schedule link" }],
    });
    expect(result.sentMessageId).toBe("line-reply-1");
  });

  it("throws on a rejected reply so the caller can fall back to a push", async () => {
    // An expired reply token (valid one minute) is the expected failure, and the
    // group bot depends on seeing it to retry via push at the group ID.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: "Invalid reply token",
    }), { status: 400 }));
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    vi.stubGlobal("fetch", fetchMock);

    await expect(replyLineMessage({ replyToken: "stale", text: "hi" }))
      .rejects.toThrow("Invalid reply token");
  });
});
