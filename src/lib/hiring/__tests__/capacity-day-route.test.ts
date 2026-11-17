import { expect, it, vi } from "vitest";
import { auth } from "@/lib/auth";
import { configSchema } from "../model";
import { cachedHiringCapacity } from "../capacity-cache";
import { GET } from "@/app/api/hiring/route";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("next/server", async (actual) => ({ ...(await actual<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("../worker", () => ({ deliverBookingMessages: vi.fn() }));
vi.mock("../google", () => ({ googleConnectionStatus: vi.fn() }));
vi.mock("../capacity-cache", () => ({ cachedHiringCapacity: vi.fn(async () => ({})) }));
vi.mock("../service", () => ({ settings: vi.fn(async () => ({ config: configSchema.parse({}) })) }));

it("passes the Bangkok day to the cached capacity read, so the cache turns over at Bangkok midnight", async () => {
  vi.mocked(auth).mockResolvedValue({ user: { email: "s@example.com", role: "admin", allowedPages: ["/hiring"] } } as never);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T17:30:00Z")); // 00:30 on 18 Nov in Bangkok
  try {
    await GET(new Request("https://app.example.com/api/hiring?capacity=1"));
  } finally {
    vi.useRealTimers();
  }
  expect(vi.mocked(cachedHiringCapacity).mock.calls[0][1]).toBe("2026-11-18");
});
