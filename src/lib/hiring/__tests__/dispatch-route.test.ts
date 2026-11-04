import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/internal/hiring-delivery/route";
import { deliveryAuthorization } from "../dispatch";
import { deliverOutbox } from "../worker";
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
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn((_input, run) => run()),
}));
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

it("delivers booking rows only on the cron, behind the shared secret", async () => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  const cron = (authorization?: string) =>
    GET(
      new NextRequest("https://bgscheduler.vercel.app/api/internal/hiring-delivery", {
        headers: authorization ? { authorization } : {},
      }),
    );
  expect((await cron()).status).toBe(401);
  expect((await cron("Bearer wrong")).status).toBe(401);
  expect(deliverOutbox).not.toHaveBeenCalled();
  vi.mocked(deliverOutbox).mockResolvedValue(3);
  const response = await cron("Bearer cron-secret");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: 3 });
  expect(deliverOutbox).toHaveBeenCalledWith(expect.anything(), { connectedEmail: "owner@example.com" }, 20, true);
});

it("delivers only the named pre-screen form in send-one mode", async () => {
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "false");
  vi.mocked(deliverOutbox).mockResolvedValue(1);
  const key = "00000000-0000-4000-8000-000000000001:pre-screen";
  const response = await POST(request(JSON.stringify({ mode: "one", key }), true));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sent: 1 });
  expect(deliverOutbox).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1, false, key);
  // Any other row kind, such as an onsite invitation, is refused before the database.
  vi.mocked(getDb).mockClear();
  const other = JSON.stringify({ mode: "one", key: "00000000-0000-4000-8000-000000000001:visit-invite" });
  expect((await POST(request(other, true))).status).toBe(400);
  expect(deliverOutbox).toHaveBeenCalledTimes(1);
});
