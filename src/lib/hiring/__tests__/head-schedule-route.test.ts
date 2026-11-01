import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/lib/auth";
import { configSchema, HiringError } from "../model";
import { headWeek } from "../head-schedule";
import { GET } from "@/app/api/hiring/route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("next/server", async (actual) => ({
  ...(await actual<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("../worker", () => ({ deliverBookingMessages: vi.fn() }));
vi.mock("../google", () => ({ googleConnectionStatus: vi.fn() }));
vi.mock("../head-schedule", () => ({ headWeek: vi.fn() }));
vi.mock("../service", () => ({
  settings: vi.fn(async () => ({ config: configSchema.parse({}) })),
  dashboard: vi.fn(),
  candidateById: vi.fn(),
  reviewCandidate: vi.fn(),
  saveSettings: vi.fn(),
}));

const get = (query: string) => GET(new Request(`https://app.example.com/api/hiring?${query}`));
const admin = (extra = {}) =>
  vi.mocked(auth).mockResolvedValue({ user: { email: "Staff@Example.com", role: "admin", ...extra } } as never);

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(headWeek).mockReset();
});

describe("GET /api/hiring?head=", () => {
  it("needs Hiring access", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await get("head=Peat")).status).toBe(401);
    admin({ role: "user" });
    expect((await get("head=Peat")).status).toBe(403);
    admin({ allowedPages: ["/search"] });
    expect((await get("head=Peat")).status).toBe(403);
    expect(headWeek).not.toHaveBeenCalled();
  });

  it("returns the head's week with no-store", async () => {
    admin({ allowedPages: ["/hiring"] });
    vi.mocked(headWeek).mockResolvedValue({ key: "Peat", weekStart: "2026-11-02" } as never);
    const response = await get("head=Peat&weekStart=2026-11-02");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ key: "Peat", weekStart: "2026-11-02" });
    expect(vi.mocked(headWeek).mock.calls[0].slice(2)).toEqual(["Peat", "2026-11-02"]);
  });

  it("defaults to the current Bangkok week", async () => {
    admin();
    vi.mocked(headWeek).mockResolvedValue({} as never);
    await get("head=Peat");
    expect(vi.mocked(headWeek).mock.calls[0][3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("answers 400 for a bad date, and passes on 404 and 400 from the schedule", async () => {
    admin();
    expect((await get("head=Peat&weekStart=tomorrow")).status).toBe(400);
    expect((await get("weekStart=2026-11-02&head=")).status).toBe(400);
    vi.mocked(headWeek).mockRejectedValueOnce(new HiringError(404, "Head not found."));
    expect((await get("head=Nobody")).status).toBe(404);
    vi.mocked(headWeek).mockRejectedValueOnce(new HiringError(400, "Choose this week or a later week."));
    expect((await get("head=Peat&weekStart=2020-01-06")).status).toBe(400);
  });
});
