import { afterEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/hiring-delivery/route";
import { deliveryAuthorization } from "../dispatch";
import { getDb } from "@/lib/db";
import { createOutboundEmailSender } from "@/lib/email/outbound";

vi.mock("@/lib/db", () => ({ getDb: vi.fn().mockReturnValue({}) }));
vi.mock("../worker", () => ({ deliverOutbox: vi.fn() }));
vi.mock("../service", () => ({
  settings: vi
    .fn()
    .mockResolvedValue({ config: { connectedEmail: "owner@example.com" } }),
  audit: vi.fn(),
}));
vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function request(body: string, authorized = false) {
  return new Request(
    "https://bgscheduler.vercel.app/api/internal/hiring-delivery",
    {
      method: "POST",
      body,
      headers: {
        Authorization: authorized ? deliveryAuthorization(body) : "invalid",
      },
    },
  );
}
it("rejects unauthenticated dispatch before reading the database", async () => {
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("VERCEL_ENV", "production");
  expect((await POST(request('{"mode":"all"}'))).status).toBe(401);
  expect(getDb).not.toHaveBeenCalled();
});
it("cannot send test mail from a preview even with a valid signature", async () => {
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("VERCEL_ENV", "preview");
  const body = JSON.stringify({
    mode: "test",
    channel: "email",
    id: "00000000-0000-4000-8000-000000000001",
  });
  expect((await POST(request(body, true))).status).toBe(503);
  expect(getDb).not.toHaveBeenCalled();
  expect(createOutboundEmailSender).not.toHaveBeenCalled();
});
it("sends a signed test only to the configured organizer with a stable key", async () => {
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
  const sendEmail = vi.fn().mockResolvedValue({ id: "receipt" });
  vi.mocked(createOutboundEmailSender).mockReturnValue({ sendEmail });
  const body = JSON.stringify({
    mode: "test",
    channel: "email",
    id: "00000000-0000-4000-8000-000000000001",
  });
  expect((await POST(request(body, true))).status).toBe(200);
  expect(sendEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "owner@example.com",
      idempotencyKey: "hiring-self-test:00000000-0000-4000-8000-000000000001",
    }),
  );
});
