vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: vi.fn((_input: unknown, fn: () => unknown) => fn()) }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => { throw new Error("Unexpected database access"); }) }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/wise/client", async original => ({ ...await original<typeof import("@/lib/wise/client")>(), createWiseClient: vi.fn() }));

import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { prepareNextDayClassrooms, deliverNextDayClassroomSchedules } from "../daily-automation";
import { runClassroomMorningAutomation, ensureFreshWiseSyncForClassroomAutomation } from "../morning-automation";
import { runClassroomPublishRecovery } from "../publish-worker";
import { runWeekendClassroomCheck } from "../weekend-check";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { effectiveCronJob, CRON_JOBS } from "@/lib/data-health/cron-registry";
import { isWiseClassroomJob, wiseClassroomAutomationEnabled } from "../operations-policy";
import { isAlertableStatus } from "@/lib/internal/cron-watchdog";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { CLASSROOM_OPERATIONS_OWNER, WISE_CLASSROOM_JOBS } from "../operations-policy";
import { GET as syncCron } from "@/app/api/internal/sync-wise/route";
import { GET as morningCron } from "@/app/api/internal/class-assignments/morning/route";
import { GET as recoveryCron } from "@/app/api/internal/class-assignments/publish-recovery/route";
import { GET as emailCron } from "@/app/api/internal/class-assignments/admin-email/route";
import { GET as weekendCron } from "@/app/api/internal/class-assignments/weekend-check/route";

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", undefined); });
afterEach(() => vi.unstubAllEnvs());

describe("default Wise/classroom shutdown", () => {
  it("audits every authenticated cron pause and does no operational work", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    for (const handler of [syncCron, morningCron, recoveryCron, emailCron, weekendCron]) {
      const response = await handler(new NextRequest("https://example.test/api/internal/job", { headers: { authorization: "Bearer test-cron-secret" } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ skipped: true, paused: true, reason: "AUTOMATION_PAUSED" });
    }
    expect(withCronInvocationAudit).toHaveBeenCalledTimes(5);
    expect(getDb).not.toHaveBeenCalled();
    expect(createWiseClient).not.toHaveBeenCalled();
  });
  it("Data Health cannot restart paused classroom automation or accept another actor", async () => {
    for (const job of WISE_CLASSROOM_JOBS) {
      expect((await runDataHealthJob(job, "other@example.com")).status).toBe(403);
      if (job !== "wise_snapshot") {
        expect(await (await runDataHealthJob(job, CLASSROOM_OPERATIONS_OWNER)).json()).toMatchObject({ paused: true, skipped: true });
      }
    }
    expect(getDb).not.toHaveBeenCalled();
    expect(createWiseClient).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "false", "TRUE", "1"])("stays paused for %s", value => {
    expect(wiseClassroomAutomationEnabled(value)).toBe(false);
    expect(wiseClassroomAutomationEnabled("true")).toBe(true);
  });
  it("all automation service entry points stop before database or Wise access", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("Unexpected DB work"); } }) as never;
    for (const result of [
      await prepareNextDayClassrooms(), await deliverNextDayClassroomSchedules(),
      await runClassroomMorningAutomation(), await runClassroomPublishRecovery(db), await runWeekendClassroomCheck(),
    ]) expect(result).toMatchObject({ ok: true, skipped: true, paused: true });
    expect(await ensureFreshWiseSyncForClassroomAutomation(db)).toMatchObject({ mode: "paused" });
    expect(await (await runWiseSyncRequest()).json()).toMatchObject({ skipped: true, paused: true });
    expect(getDb).not.toHaveBeenCalled();
    expect(createWiseClient).not.toHaveBeenCalled();
  });
  it("marks precisely the five affected jobs paused without disabling other cron jobs", () => {
    const affected = CRON_JOBS.filter(job => isWiseClassroomJob(job.key));
    expect(affected).toHaveLength(5);
    for (const job of affected) expect(effectiveCronJob(job)).toMatchObject({ paused: true });
    expect(effectiveCronJob(CRON_JOBS.find(job => job.key === "room_booking")!).paused).not.toBe(true);
    expect(isAlertableStatus("paused")).toBe(false);
  });
});
