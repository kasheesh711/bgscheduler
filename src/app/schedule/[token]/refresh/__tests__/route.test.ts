import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/student-schedule/links", () => ({ resolveStudentScheduleLink: vi.fn() }));
vi.mock("@/lib/student-schedule/data", () => ({ getStudentMonthlySchedule: vi.fn() }));
import { resolveStudentScheduleLink } from "@/lib/student-schedule/links";
import { getStudentMonthlySchedule } from "@/lib/student-schedule/data";
import { POST } from "../route";

beforeEach(() => vi.resetAllMocks());
describe("public schedule refresh", () => {
  it("revalidates the capability and ignores student/month overrides", async () => {
    vi.mocked(resolveStudentScheduleLink).mockResolvedValue({ studentKey: "authorized", monthKey: "2026-09" } as never);
    vi.mocked(getStudentMonthlySchedule).mockResolvedValue({ student: { studentKey: "authorized" }, sessions: [] } as never);
    const request = new Request("https://example.test/schedule/token/refresh?studentKey=other&month=2026-10", {
      method: "POST", body: JSON.stringify({ studentKey: "other", monthKey: "2026-10" }),
    });
    const response = await POST(request, { params: Promise.resolve({ token: "existing-token" }) });
    expect(resolveStudentScheduleLink).toHaveBeenCalledWith({}, "existing-token");
    expect(getStudentMonthlySchedule).toHaveBeenCalledWith({}, {
      studentKey: "authorized", monthKey: "2026-09", forceRefresh: true, signal: request.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ student: { studentKey: "authorized" } });
  });
  it.each(["invalid", "expired", "revoked"])("rejects a %s capability before loading any schedule", async token => {
    vi.mocked(resolveStudentScheduleLink).mockResolvedValue(null);
    const response = await POST(new Request("https://example.test", { method: "POST" }), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Schedule unavailable" });
    expect(getStudentMonthlySchedule).not.toHaveBeenCalled();
  });
});
