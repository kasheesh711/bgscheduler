import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLineFollowerIds, pushLineTextMessage } from "@/lib/line/client";

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
});
