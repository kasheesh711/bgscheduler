import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "@/lib/line/signature";

function signature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyLineSignature", () => {
  it("accepts the HMAC-SHA256 signature for the exact raw body", () => {
    const rawBody = JSON.stringify({ events: [{ webhookEventId: "event-1" }] });

    expect(verifyLineSignature({
      rawBody,
      channelSecret: "secret",
      signature: signature("secret", rawBody),
    })).toBe(true);
  });

  it("rejects bad signatures, missing secrets, and modified bodies", () => {
    const rawBody = JSON.stringify({ events: [] });

    expect(verifyLineSignature({
      rawBody,
      channelSecret: "secret",
      signature: signature("other-secret", rawBody),
    })).toBe(false);
    expect(verifyLineSignature({
      rawBody: `${rawBody} `,
      channelSecret: "secret",
      signature: signature("secret", rawBody),
    })).toBe(false);
    expect(verifyLineSignature({
      rawBody,
      channelSecret: undefined,
      signature: signature("secret", rawBody),
    })).toBe(false);
  });
});
