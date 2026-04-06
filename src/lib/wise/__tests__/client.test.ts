import { afterEach, describe, expect, it, vi } from "vitest";
import { WiseClient } from "../client";

describe("WiseClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends the live Wise auth headers to the correct base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 200, message: "Success", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const client = new WiseClient({
      userId: "user-123",
      apiKey: "api-key-456",
      namespace: "begifted-education",
      maxRetries: 0,
    });

    await client.get("/user/getUser");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.wiseapp.live/user/getUser",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("user-123:api-key-456").toString("base64")}`,
          "x-api-key": "api-key-456",
          "x-wise-namespace": "begifted-education",
          "user-agent": "VendorIntegrations/begifted-education",
        }),
      })
    );
  });
});
