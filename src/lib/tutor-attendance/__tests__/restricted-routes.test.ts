vi.mock("server-only", () => ({}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/data-health/cron-audit", () => ({
  withCronInvocationAudit: vi.fn(),
}));
import { auth } from "@/lib/auth";
import { POST as wise } from "@/app/api/internal/sync-wise/route";
import { POST as credit } from "@/app/api/internal/sync-credit-control/route";
import { POST as sales } from "@/app/api/internal/sync-sales-dashboard/route";
import { POST as rooms } from "@/app/api/internal/sync-room-utilization/route";
import { POST as assistant } from "@/app/api/search/assistant/route";

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-only-secret");
  vi.mocked(auth).mockResolvedValue({
    user: {
      email: "attendance-only@example.test",
      role: "teacher",
      allowedPages: ["/tutor-attendance"],
    },
  } as never);
});
afterEach(() => vi.unstubAllEnvs());
describe("attendance-only sessions cannot enter public admin fallback routes", () => {
  it.each([
    ["sync-wise", wise],
    ["sync-credit-control", credit],
    ["sync-sales-dashboard", sales],
    ["sync-room-utilization", rooms],
  ] as const)(
    "rejects %s before running an administrative sync",
    async (name, handler) => {
      const response = await handler(
        new NextRequest(`https://example.test/api/internal/${name}`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(name === "sync-wise" ? 403 : 401);
    },
  );
  it("rejects the public scheduler assistant before accepting its input", async () => {
    const response = await assistant(
      new NextRequest("https://example.test/api/search/assistant", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(403);
  });
});
