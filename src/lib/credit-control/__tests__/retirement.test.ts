import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { auth } from "@/lib/auth";
import { creditControlActive, CREDIT_CONTROL_RETIRED } from "../mode";
import { requireCreditControlSession, creditControlErrorResponse } from "../api";
import { effectiveCronJob, getCronJobDefinition } from "@/lib/data-health/cron-registry";
afterEach(() => vi.unstubAllEnvs());
describe("Credit Control retirement", () => {
  it("defaults to retired and only explicitly restores active mode", () => {
    vi.stubEnv("CREDIT_CONTROL_MODE", undefined); expect(creditControlActive()).toBe(false);
    vi.stubEnv("CREDIT_CONTROL_MODE", "typo"); expect(creditControlActive()).toBe(false);
    vi.stubEnv("CREDIT_CONTROL_MODE", "active"); expect(creditControlActive()).toBe(true);
  });
  it("authenticates before reporting retirement", async () => {
    vi.stubEnv("CREDIT_CONTROL_MODE", "retired"); vi.mocked(auth).mockResolvedValue(null as never);
    await expect(requireCreditControlSession()).rejects.toThrow("Unauthorized");
    vi.mocked(auth).mockResolvedValue({ user: { email: "staff@example.com", name: "Staff" } } as never);
    await expect(requireCreditControlSession()).rejects.toThrow(CREDIT_CONTROL_RETIRED);
    const response = creditControlErrorResponse("test", new Error(CREDIT_CONTROL_RETIRED), "error");
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: CREDIT_CONTROL_RETIRED });
  });
  it("restores APIs and cadence without changing recorded access or digest preferences", async () => {
    vi.stubEnv("CREDIT_CONTROL_MODE", "active");
    vi.mocked(auth).mockResolvedValue({ user: { email: "staff@example.com", name: "Staff" } } as never);
    expect(await requireCreditControlSession()).toEqual({ email: "staff@example.com", name: "Staff" });
    const job = getCronJobDefinition("credit_control")!;
    expect(effectiveCronJob(job).cadenceMinutes).toBe(30);
    vi.stubEnv("CREDIT_CONTROL_MODE", "retired");
    expect(effectiveCronJob(job)).toMatchObject({ label: "Shared Student Data", cadenceMinutes: 1440, requiresSuccessfulRun: true });
    expect(effectiveCronJob(getCronJobDefinition("line_credit_digest")!).paused).toBe(true);
    expect(effectiveCronJob(getCronJobDefinition("progress_tests")!).cadenceMinutes).toBe(1440);
  });
});
