import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const insertValues = vi.hoisted(() => vi.fn());
const onConflictDoNothing = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ insert: () => ({ values: (v: unknown) => { insertValues(v); return { onConflictDoNothing }; } }) }),
}));

import { POST } from "../route";

const rawSecret = Buffer.from("resend-webhook-test-secret-32byte").toString("base64");
const body = JSON.stringify({ type: "email.bounced", created_at: "2026-10-07T03:00:00.000Z", data: { email_id: "re-1", bounce: { type: "Permanent" } } });
function request(opts: { sig?: string; id?: string; ts?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const id = opts.id ?? "msg_1";
  const sig = opts.sig ?? "v1," + createHmac("sha256", Buffer.from(rawSecret, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("https://x/api/email/resend-webhook", {
    method: "POST", body, headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": sig, "content-type": "application/json" },
  });
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("POST /api/email/resend-webhook", () => {
  it("503s when the secret is not configured", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await POST(request() as never)).status).toBe(503);
  });
  it("401s on a bad signature and stores nothing", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${rawSecret}`);
    expect((await POST(request({ sig: "v1,AAAA" }) as never)).status).toBe(401);
    expect(insertValues).not.toHaveBeenCalled();
  });
  it("stores a verified event keyed by svix id and answers 200", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${rawSecret}`);
    const res = await POST(request() as never);
    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      svixId: "msg_1", providerMessageId: "re-1", eventType: "email.bounced", bounceType: "Permanent",
    }));
    expect(onConflictDoNothing).toHaveBeenCalled(); // duplicate svix-id is a no-op
  });
});
