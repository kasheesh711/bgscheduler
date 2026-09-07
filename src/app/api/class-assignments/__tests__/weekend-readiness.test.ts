import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/classrooms/weekend-check", () => ({ loadWeekendCheck: vi.fn(), runWeekendClassroomCheck: vi.fn() }));
vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: vi.fn((_input, run) => run()) }));
import { auth } from "@/lib/auth";
import { loadWeekendCheck, runWeekendClassroomCheck } from "@/lib/classrooms/weekend-check";
import { GET } from "../weekend-readiness/route";
import { GET as cronGET } from "@/app/api/internal/class-assignments/weekend-check/route";
const request = (query = "") => new NextRequest(`http://localhost/api/class-assignments/weekend-readiness${query}`);
beforeEach(() => { vi.resetAllMocks(); vi.mocked(auth).mockResolvedValue({ user: { email: "kevhsh7@gmail.com" } } as never); process.env.CRON_SECRET = "test-secret"; });
describe("weekend report routes", () => {
  it("requires a session before reading reports", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET(request())).status).toBe(401);
    expect(loadWeekendCheck).not.toHaveBeenCalled();
  });
  it("validates report IDs and distinguishes missing reports from no check yet", async () => {
    expect((await GET(request("?checkId=invalid"))).status).toBe(400);
    vi.mocked(loadWeekendCheck).mockResolvedValue(null);
    expect((await GET(request(`?checkId=${crypto.randomUUID()}`))).status).toBe(404);
    const empty = await GET(request());
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toContain("no-store");
    expect((await empty.json()).check).toBeNull();
  });
  it("returns a visible error when the report cannot be loaded", async () => {
    vi.mocked(loadWeekendCheck).mockRejectedValue(new Error("db failure"));
    const result = await GET(request());
    expect(result.status).toBe(500);
    expect((await result.json()).error).toContain("has not been verified");
  });
  it("requires the cron secret and returns a failing status for delivery errors", async () => {
    expect((await cronGET(new NextRequest("http://localhost/api/internal/class-assignments/weekend-check"))).status).toBe(401);
    expect(runWeekendClassroomCheck).not.toHaveBeenCalled();
    vi.mocked(runWeekendClassroomCheck).mockResolvedValue({ ok: false, errorSummary: "Relay failed" } as never);
    expect((await cronGET(new NextRequest("http://localhost/api/internal/class-assignments/weekend-check", { headers: { authorization: "Bearer test-secret" } }))).status).toBe(500);
  });
});
