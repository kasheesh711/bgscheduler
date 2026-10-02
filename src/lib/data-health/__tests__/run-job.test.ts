vi.mock("server-only", () => ({}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/data-health/cron-audit", () => ({ withCronInvocationAudit: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/wise/client", () => ({ createWiseClient: vi.fn() }));
// Branches that predate this test (the autowriter and workspace-jobs ones are dynamic imports inside run-job).
vi.mock("@/lib/feedback-autowriter/dispatch", () => ({ runAutowriterJob: vi.fn(), runAutowriterReviewJob: vi.fn() }));
vi.mock("@/lib/feedback-autowriter/atom/collector", () => ({ collectAtomOnServer: vi.fn() }));
vi.mock("@/lib/post-class-feedback/nightly-reminders", () => ({ nightlyWorkerOutcome: vi.fn(), runNightlyReminders: vi.fn() }));
vi.mock("@/lib/progress-tests/workspace/jobs", () => ({ processJobs: vi.fn() }));
vi.mock("@/lib/room-booking/refresh", () => ({ runRoomRefresh: vi.fn() }));
vi.mock("@/lib/classrooms/weekend-check", () => ({ runWeekendClassroomCheck: vi.fn() }));
vi.mock("@/lib/sync/run-wise-sync", () => ({ runWiseSyncRequest: vi.fn() }));
vi.mock("@/lib/wise-activity/sync", () => ({
  syncWiseActivityEvents: vi.fn(),
  WiseActivitySyncAlreadyRunningError: class WiseActivitySyncAlreadyRunningError extends Error {},
}));
vi.mock("@/lib/sales-dashboard/data", () => ({ importActiveSalesDashboardProjectionSource: vi.fn(), importRefreshableSalesSources: vi.fn() }));
vi.mock("@/lib/competitor-intelligence/sync", () => ({ runCompetitorIntelligenceSync: vi.fn() }));
vi.mock("@/lib/credit-control/run-sync-request", () => ({ runCreditControlSyncRequest: vi.fn() }));
vi.mock("@/lib/post-class-feedback/sync", () => ({ runPostClassFeedbackSync: vi.fn() }));
vi.mock("@/lib/post-class-feedback/notifications", () => ({ processDuePostClassNotificationRetries: vi.fn(), sendPostClassAdminDigest: vi.fn() }));
vi.mock("@/lib/post-class-feedback/ai", () => ({ processPostClassAiReviews: vi.fn() }));
vi.mock("@/lib/post-class-feedback/auto-approval", () => ({ runPostClassDeductionHygiene: vi.fn() }));
vi.mock("@/lib/post-class-feedback/reminder-job", () => ({ runPostClassReminderJob: vi.fn() }));
vi.mock("@/lib/post-class-feedback/payout-accrual", () => ({ payoutJobResponse: vi.fn(), runPayoutAccrualPass: vi.fn(), runPayoutFinalizePass: vi.fn() }));
vi.mock("@/lib/leave-requests/sync", () => ({ syncLeaveRequests: vi.fn() }));
vi.mock("@/lib/classrooms/publish-worker", () => ({ runClassroomPublishRecovery: vi.fn() }));
vi.mock("@/lib/classrooms/daily-automation", () => ({ prepareNextDayClassrooms: vi.fn(), deliverNextDayClassroomSchedules: vi.fn() }));
vi.mock("@/lib/internal/cron-watchdog", () => ({ runCronWatchdog: vi.fn() }));
vi.mock("@/lib/room-capacity/utilization", () => ({ syncRoomUtilizationSessions: vi.fn() }));
vi.mock("@/lib/onsite-foot-traffic/sync", () => ({ runOnsiteFootTrafficSync: vi.fn() }));
// The nine new branches.
vi.mock("@/lib/tutor-sit-ins/worker", () => ({ processJobs: vi.fn(), queueDailyDigests: vi.fn(), runSitInWorker: vi.fn() }));
vi.mock("@/lib/unearned-revenue/sync", () => ({ runUnearnedRevenueSync: vi.fn() }));
vi.mock("@/lib/progress-tests/run-sync-request", () => ({ runProgressTestSyncRequest: vi.fn() }));
vi.mock("@/lib/progress-tests/admin-digest", () => ({ sendProgressTestAdminDigest: vi.fn() }));
vi.mock("@/lib/post-class-feedback/backfill-window", () => ({ findOldestUnreconciledBackfillWindow: vi.fn() }));
vi.mock("@/lib/post-class-feedback/backfill-job", () => ({ runPostClassBackfillJob: vi.fn() }));
vi.mock("@/lib/post-class-feedback/repository", () => ({
  PostClassFeedbackSyncAlreadyRunningError: class PostClassFeedbackSyncAlreadyRunningError extends Error {},
}));
vi.mock("@/lib/admissions/notifications", () => ({ runDailyNotifications: vi.fn(), runWeeklyDigest: vi.fn() }));
vi.mock("@/lib/line/credit-digest", () => ({ sendLineCreditDigest: vi.fn() }));
vi.mock("@/lib/line/backlog-recovery", () => ({ runLineBacklogRecovery: vi.fn() }));

import { runDailyNotifications, runWeeklyDigest, type AdmissionsNotificationRunResult } from "@/lib/admissions/notifications";
import { deliverNextDayClassroomSchedules, prepareNextDayClassrooms } from "@/lib/classrooms/daily-automation";
import { CLASSROOM_OPERATIONS_OWNER } from "@/lib/classrooms/operations-policy";
import { runClassroomPublishRecovery } from "@/lib/classrooms/publish-worker";
import { runWeekendClassroomCheck } from "@/lib/classrooms/weekend-check";
import { runCompetitorIntelligenceSync } from "@/lib/competitor-intelligence/sync";
import { runCreditControlSyncRequest } from "@/lib/credit-control/run-sync-request";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { CRON_JOBS, getCronJobDefinition, manuallyRunnableCronJobs, type CronJobDefinition } from "@/lib/data-health/cron-registry";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { getDb } from "@/lib/db";
import { collectAtomOnServer } from "@/lib/feedback-autowriter/atom/collector";
import { runAutowriterJob, runAutowriterReviewJob } from "@/lib/feedback-autowriter/dispatch";
import { runCronWatchdog } from "@/lib/internal/cron-watchdog";
import { syncLeaveRequests } from "@/lib/leave-requests/sync";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";
import { sendLineCreditDigest } from "@/lib/line/credit-digest";
import { runOnsiteFootTrafficSync } from "@/lib/onsite-foot-traffic/sync";
import { processPostClassAiReviews } from "@/lib/post-class-feedback/ai";
import { runPostClassDeductionHygiene } from "@/lib/post-class-feedback/auto-approval";
import { runPostClassBackfillJob } from "@/lib/post-class-feedback/backfill-job";
import { findOldestUnreconciledBackfillWindow } from "@/lib/post-class-feedback/backfill-window";
import { nightlyWorkerOutcome, runNightlyReminders } from "@/lib/post-class-feedback/nightly-reminders";
import { processDuePostClassNotificationRetries, sendPostClassAdminDigest } from "@/lib/post-class-feedback/notifications";
import { payoutJobResponse, runPayoutAccrualPass, runPayoutFinalizePass } from "@/lib/post-class-feedback/payout-accrual";
import { runPostClassReminderJob } from "@/lib/post-class-feedback/reminder-job";
import { PostClassFeedbackSyncAlreadyRunningError } from "@/lib/post-class-feedback/repository";
import { runPostClassFeedbackSync } from "@/lib/post-class-feedback/sync";
import { sendProgressTestAdminDigest } from "@/lib/progress-tests/admin-digest";
import { runProgressTestSyncRequest } from "@/lib/progress-tests/run-sync-request";
import { processJobs as processWorkspaceJobs } from "@/lib/progress-tests/workspace/jobs";
import { runRoomRefresh } from "@/lib/room-booking/refresh";
import { syncRoomUtilizationSessions } from "@/lib/room-capacity/utilization";
import { importActiveSalesDashboardProjectionSource, importRefreshableSalesSources } from "@/lib/sales-dashboard/data";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { processJobs as processSitInJobs, queueDailyDigests, runSitInWorker } from "@/lib/tutor-sit-ins/worker";
import { runUnearnedRevenueSync } from "@/lib/unearned-revenue/sync";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents } from "@/lib/wise-activity/sync";

type ManualRunKey = Exclude<(typeof CRON_JOBS)[number], { manualRunDisabledReason: string }>["key"];

/** One primary entry point per key Data Health can run; `satisfies` turns a missing branch into a type error. */
const DISPATCH_TARGETS = {
  feedback_atom: collectAtomOnServer,
  feedback_autowriter: runAutowriterJob,
  feedback_autowriter_review: runAutowriterReviewJob,
  post_class_feedback_nightly: runNightlyReminders,
  tutor_sit_ins: runSitInWorker,
  tutor_sit_ins_digest: processSitInJobs,
  progress_tests_processing: processWorkspaceJobs,
  classroom_publish_recovery: runClassroomPublishRecovery,
  room_booking: runRoomRefresh,
  classroom_weekend_check: runWeekendClassroomCheck,
  wise_snapshot: runWiseSyncRequest,
  wise_activity: syncWiseActivityEvents,
  sales_dashboard: importRefreshableSalesSources,
  unearned_revenue: runUnearnedRevenueSync,
  onsite_foot_traffic: runOnsiteFootTrafficSync,
  competitor_intelligence: runCompetitorIntelligenceSync,
  credit_control: runCreditControlSyncRequest,
  progress_tests: runProgressTestSyncRequest,
  progress_tests_digest: sendProgressTestAdminDigest,
  post_class_feedback: runPostClassFeedbackSync,
  post_class_feedback_backfill: runPostClassBackfillJob,
  post_class_feedback_digest: sendPostClassAdminDigest,
  post_class_feedback_day_after: runPostClassReminderJob,
  post_class_feedback_deadline: runPostClassReminderJob,
  post_class_feedback_payout_accrual: runPayoutAccrualPass,
  leave_requests: syncLeaveRequests,
  classroom_morning: prepareNextDayClassrooms,
  classroom_admin_email: deliverNextDayClassroomSchedules,
  admissions_notifications: runDailyNotifications,
  line_credit_digest: sendLineCreditDigest,
  cron_watchdog: runCronWatchdog,
  room_utilization: syncRoomUtilizationSessions,
  line_backlog_recovery: runLineBacklogRecovery,
} satisfies Record<ManualRunKey, unknown>;

// Widened view: on the as-const tuple only one member declares manualRunDisabledReason (TS2339).
const REGISTRY: readonly CronJobDefinition[] = CRON_JOBS;
const MANUAL_KEYS = REGISTRY.filter((job) => job.manualRunDisabledReason === undefined).map((job) => job.key).sort();
const EXCLUDED_KEYS = REGISTRY.filter((job) => job.manualRunDisabledReason !== undefined).map((job) => job.key);
const OWNER = CLASSROOM_OPERATIONS_OWNER;
const SENTINEL_DB = { sentinel: "db" };
const BACKFILL_WINDOW = { startDate: "2026-09-01", endDate: "2026-09-04" };
const BANGKOK_THURSDAY = new Date("2026-07-09T01:12:00.000Z");
const BANGKOK_SUNDAY = new Date("2026-07-12T01:12:00.000Z");
// Distinct values per pass, so a swapped response key fails the equality checks.
const PC_SYNC = { runId: "pc-run-1" };
const PC_AI = { processed: 1, failed: 0, skipped: 2 };
const PC_RETRIES = { considered: 3, sent: 3, failed: 0, cancelled: 0, deferred: 0 };
const PC_HYGIENE = { reopened: 0, reopenFailed: 0, waived: 1, waiveFailed: 0 };
const PC_BODY = { ok: true, result: PC_SYNC, ai: PC_AI, retries: PC_RETRIES, hygiene: PC_HYGIENE };

function admissionsResult(runType: "daily" | "weekly", skipped = false): AdmissionsNotificationRunResult {
  return { skipped, runId: skipped ? null : `run-${runType}`, runType, sentCount: 0, skippedCount: 0, errorSummary: null };
}

/** Gives every entry point an outcome its branch maps below 400. */
function applyDefaults(): void {
  vi.mocked(withCronInvocationAudit).mockImplementation(async (_input, handler) => handler());
  vi.mocked(getDb).mockReturnValue(SENTINEL_DB as never);
  vi.mocked(createWiseClient).mockReturnValue({} as never);
  // A Response body can be read only once, so every call gets a fresh Response.
  vi.mocked(runWiseSyncRequest).mockImplementation(async () => NextResponse.json({ ok: true }) as never);
  vi.mocked(runCreditControlSyncRequest).mockImplementation(async () => NextResponse.json({ ok: true }) as never);
  vi.mocked(runProgressTestSyncRequest).mockImplementation(async () => NextResponse.json({ ok: true }) as never);
  vi.mocked(collectAtomOnServer).mockResolvedValue({ ok: true } as never);
  vi.mocked(runAutowriterJob).mockResolvedValue({ ok: true } as never);
  vi.mocked(runAutowriterReviewJob).mockResolvedValue({ ok: true } as never);
  vi.mocked(runNightlyReminders).mockResolvedValue({} as never);
  vi.mocked(nightlyWorkerOutcome).mockReturnValue({ ok: true } as never);
  vi.mocked(processWorkspaceJobs).mockResolvedValue({} as never);
  vi.mocked(runRoomRefresh).mockResolvedValue({ ok: true } as never);
  vi.mocked(runWeekendClassroomCheck).mockResolvedValue({ ok: true } as never);
  vi.mocked(runClassroomPublishRecovery).mockResolvedValue({ ok: true } as never);
  vi.mocked(prepareNextDayClassrooms).mockResolvedValue({ ok: true } as never);
  vi.mocked(deliverNextDayClassroomSchedules).mockResolvedValue({ ok: true } as never);
  vi.mocked(syncWiseActivityEvents).mockResolvedValue({} as never);
  vi.mocked(importRefreshableSalesSources).mockResolvedValue([] as never);
  vi.mocked(importActiveSalesDashboardProjectionSource).mockResolvedValue(null as never);
  vi.mocked(runCompetitorIntelligenceSync).mockResolvedValue({ status: "success" } as never);
  vi.mocked(runPostClassFeedbackSync).mockResolvedValue(PC_SYNC as never);
  vi.mocked(processDuePostClassNotificationRetries).mockResolvedValue(PC_RETRIES);
  vi.mocked(processPostClassAiReviews).mockResolvedValue(PC_AI);
  vi.mocked(runPostClassDeductionHygiene).mockResolvedValue(PC_HYGIENE);
  vi.mocked(sendPostClassAdminDigest).mockResolvedValue({} as never);
  vi.mocked(runPostClassReminderJob).mockResolvedValue({ ready: true } as never);
  vi.mocked(runPayoutAccrualPass).mockResolvedValue({} as never);
  vi.mocked(runPayoutFinalizePass).mockResolvedValue({} as never);
  vi.mocked(payoutJobResponse).mockReturnValue({ ok: true } as never);
  vi.mocked(syncLeaveRequests).mockResolvedValue({} as never);
  vi.mocked(runCronWatchdog).mockResolvedValue({} as never);
  vi.mocked(syncRoomUtilizationSessions).mockResolvedValue({} as never);
  vi.mocked(runOnsiteFootTrafficSync).mockResolvedValue({ skipped: false } as never);
  vi.mocked(runSitInWorker).mockResolvedValue({ ok: true } as never);
  vi.mocked(queueDailyDigests).mockResolvedValue(undefined);
  vi.mocked(processSitInJobs).mockResolvedValue({ sent: 0, failed: 0 });
  vi.mocked(runUnearnedRevenueSync).mockResolvedValue({ ok: true, skipped: false } as never);
  vi.mocked(sendProgressTestAdminDigest).mockResolvedValue({ status: "sent" } as never);
  vi.mocked(findOldestUnreconciledBackfillWindow).mockResolvedValue(BACKFILL_WINDOW);
  vi.mocked(runPostClassBackfillJob).mockResolvedValue({ batches: 1 } as never);
  vi.mocked(runDailyNotifications).mockResolvedValue(admissionsResult("daily"));
  vi.mocked(runWeeklyDigest).mockResolvedValue(admissionsResult("weekly"));
  vi.mocked(sendLineCreditDigest).mockResolvedValue({ status: "sent" } as never);
  vi.mocked(runLineBacklogRecovery).mockResolvedValue({ inserted: 0 } as never);
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) also drops unconsumed *Once queues.
  vi.resetAllMocks();
  applyDefaults();
  vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("runDataHealthJob", () => {
  it("covers exactly the registry keys Data Health can run", () => {
    expect(Object.keys(DISPATCH_TARGETS).sort()).toEqual(MANUAL_KEYS);
  });

  it.each([
    ["every feature on", "true", "active"],
    ["every feature off", undefined, undefined],
  ])("offers only Run buttons it can dispatch with %s", (_mode, flag, creditControlMode) => {
    vi.stubEnv("WISE_CLASSROOM_AUTOMATION_ENABLED", flag);
    vi.stubEnv("FEEDBACK_AUTOWRITER_ENABLED", flag);
    vi.stubEnv("FEEDBACK_ATOM_COLLECTOR_ENABLED", flag);
    vi.stubEnv("TUTOR_SIT_INS_ENABLED", flag);
    vi.stubEnv("CREDIT_CONTROL_MODE", creditControlMode);

    const offered = manuallyRunnableCronJobs().map((job) => job.key);

    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((key) => !(key in DISPATCH_TARGETS))).toEqual([]);
    expect(offered).not.toContain("student_promotions_july_1");
  });

  it.each(MANUAL_KEYS)("dispatches %s", async (key) => {
    const response = await runDataHealthJob(key, OWNER);
    const target = (DISPATCH_TARGETS as Record<string, unknown>)[key];

    expect(response.status).toBeLessThan(400);
    expect(await response.json()).not.toEqual({ error: "Unknown job" });
    expect(target).toBeDefined();
    expect(target).toHaveBeenCalled();
    expect(withCronInvocationAudit).toHaveBeenCalledTimes(1);
    expect(withCronInvocationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ jobKey: key, triggerSource: "admin", actorEmail: OWNER }),
      expect.any(Function),
    );
  });

  it.each(EXCLUDED_KEYS)("refuses %s before the audit wrapper", async (key) => {
    const response = await runDataHealthJob(key, OWNER);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: getCronJobDefinition(key)!.manualRunDisabledReason });
    expect(withCronInvocationAudit).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["post_class_feedback_day_after", "day_after"],
    ["post_class_feedback_deadline", "deadline"],
  ] as const)("runs %s at its own reminder checkpoint", async (key, checkpoint) => {
    await runDataHealthJob(key, OWNER);

    expect(runPostClassReminderJob).toHaveBeenCalledTimes(1);
    expect(runPostClassReminderJob).toHaveBeenCalledWith(checkpoint, { triggerType: "manual", actorEmail: OWNER });
  });

  it("runs the sit-in worker with its cron route's status mapping", async () => {
    vi.mocked(runSitInWorker).mockResolvedValueOnce({ ok: false } as never);

    const response = await runDataHealthJob("tutor_sit_ins", OWNER);

    expect(runSitInWorker).toHaveBeenCalledWith();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("queues sit-in digests before delivering them, as the digest cron does", async () => {
    vi.mocked(processSitInJobs).mockResolvedValueOnce({ sent: 0, failed: 1 });

    const before = Date.now();
    const response = await runDataHealthJob("tutor_sit_ins_digest", OWNER);
    const after = Date.now();

    expect(queueDailyDigests).toHaveBeenCalledWith();
    expect(processSitInJobs).toHaveBeenCalledWith(SENTINEL_DB, { limit: 50, deadlineAt: expect.any(Number) });
    expect(vi.mocked(queueDailyDigests).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(processSitInJobs).mock.invocationCallOrder[0]);
    const deadlineAt = vi.mocked(processSitInJobs).mock.calls[0][1]?.deadlineAt ?? 0;
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 270_000);
    expect(deadlineAt).toBeLessThanOrEqual(after + 270_000);
    expect(response.status).toBe(500);
  });

  it("maps the unearned revenue sync like its cron route, attributed to the actor", async () => {
    vi.mocked(runUnearnedRevenueSync)
      .mockResolvedValueOnce({ ok: true, skipped: false } as never)
      .mockResolvedValueOnce({ ok: true, skipped: true } as never)
      .mockResolvedValueOnce({ ok: false, skipped: false } as never);

    expect((await runDataHealthJob("unearned_revenue", OWNER)).status).toBe(200);
    expect((await runDataHealthJob("unearned_revenue", OWNER)).status).toBe(202);
    expect((await runDataHealthJob("unearned_revenue", OWNER)).status).toBe(502);
    expect(runUnearnedRevenueSync).toHaveBeenCalledTimes(3);
    expect(runUnearnedRevenueSync).toHaveBeenCalledWith({ triggerType: "manual", actorEmail: OWNER });
  });

  it("returns the progress-test sync response verbatim for a manual run by the actor", async () => {
    const upstream = NextResponse.json({ skipped: true, reason: "already_running" }, { status: 202 });
    vi.mocked(runProgressTestSyncRequest).mockResolvedValueOnce(upstream as never);

    const response = await runDataHealthJob("progress_tests", OWNER);

    expect(runProgressTestSyncRequest).toHaveBeenCalledWith({ triggerType: "manual", actorEmail: OWNER });
    expect(response).toBe(upstream);
  });

  it("maps the progress-test admin digest status like its cron route", async () => {
    vi.mocked(sendProgressTestAdminDigest)
      .mockResolvedValueOnce({ status: "failed" } as never)
      .mockResolvedValueOnce({ status: "skipped" } as never);

    expect((await runDataHealthJob("progress_tests_digest", OWNER)).status).toBe(500);
    expect((await runDataHealthJob("progress_tests_digest", OWNER)).status).toBe(200);
    expect(sendProgressTestAdminDigest).toHaveBeenCalledWith();
  });

  it("maps the LINE credit digest status like its cron route", async () => {
    vi.mocked(sendLineCreditDigest)
      .mockResolvedValueOnce({ status: "failed" } as never)
      .mockResolvedValueOnce({ status: "skipped" } as never);

    expect((await runDataHealthJob("line_credit_digest", OWNER)).status).toBe(500);
    expect((await runDataHealthJob("line_credit_digest", OWNER)).status).toBe(200);
    expect(sendLineCreditDigest).toHaveBeenCalledWith();
  });

  it("backfills the oldest unreconciled window with the cron's single 50-detail batch", async () => {
    const response = await runDataHealthJob("post_class_feedback_backfill", OWNER);

    expect(findOldestUnreconciledBackfillWindow).toHaveBeenCalledWith();
    expect(runPostClassBackfillJob).toHaveBeenCalledWith({ ...BACKFILL_WINDOW, actorEmail: OWNER, detailCap: 50, maxBatches: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, window: BACKFILL_WINDOW, result: { batches: 1 } });
  });

  it("skips the backfill when no window is unreconciled", async () => {
    vi.mocked(findOldestUnreconciledBackfillWindow).mockResolvedValueOnce(null);

    const response = await runDataHealthJob("post_class_feedback_backfill", OWNER);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, skipped: "nothing-unreconciled" });
    expect(runPostClassBackfillJob).not.toHaveBeenCalled();
  });

  it("maps backfill failures like its cron route without echoing driver detail", async () => {
    vi.mocked(runPostClassBackfillJob)
      .mockRejectedValueOnce(new PostClassFeedbackSyncAlreadyRunningError("Post-class feedback sync is already running."))
      .mockRejectedValueOnce(new Error("sensitive driver detail"));

    const busy = await runDataHealthJob("post_class_feedback_backfill", OWNER);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "Post-class feedback sync is already running." });

    const failed = await runDataHealthJob("post_class_feedback_backfill", OWNER);
    const body = await failed.json();
    expect(failed.status).toBe(500);
    expect(body).toEqual({ error: "Post-class feedback backfill failed" });
    expect(JSON.stringify(body)).not.toContain("sensitive driver detail");
  });

  it("runs the cron's AI-review, retry and hygiene passes only after the actor's manual post-class sync resolves", async () => {
    let finishSync!: (result: unknown) => void;
    vi.mocked(runPostClassFeedbackSync).mockReturnValueOnce(new Promise<unknown>((resolve) => { finishSync = resolve; }) as never);
    const passes = [processPostClassAiReviews, processDuePostClassNotificationRetries, runPostClassDeductionHygiene];

    const pending = runDataHealthJob("post_class_feedback", OWNER);
    // Give an eagerly started pass the chance to run while the sync is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const pass of passes) expect(pass).not.toHaveBeenCalled();

    finishSync(PC_SYNC);
    const response = await pending;

    expect(runPostClassFeedbackSync).toHaveBeenCalledWith({ triggerType: "manual", actorEmail: OWNER });
    for (const pass of passes) {
      expect(pass).toHaveBeenCalledTimes(1);
      expect(pass).toHaveBeenCalledWith();
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PC_BODY);
  });

  it.each([
    ["ai", () => vi.mocked(processPostClassAiReviews).mockRejectedValueOnce(new Error("ai down"))],
    ["retries", () => vi.mocked(processDuePostClassNotificationRetries).mockRejectedValueOnce(new Error("retries down"))],
    ["hygiene", () => vi.mocked(runPostClassDeductionHygiene).mockRejectedValueOnce(new Error("hygiene down"))],
  ] as const)("reports a rejected %s pass as { failed: true } in a 200, as the cron does", async (key, reject) => {
    reject();

    const response = await runDataHealthJob("post_class_feedback", OWNER);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...PC_BODY, [key]: { failed: true } });
  });

  it("maps post-class sync failures like its cron route, without driver detail or post-sync passes", async () => {
    vi.mocked(runPostClassFeedbackSync)
      .mockRejectedValueOnce(new PostClassFeedbackSyncAlreadyRunningError("Post-class feedback sync is already running."))
      .mockRejectedValueOnce(new Error("sensitive driver detail"))
      // Says "already running" but is not the typed error, so it must still be a 500.
      .mockRejectedValueOnce(new Error("advisory lock already running"));

    const busy = await runDataHealthJob("post_class_feedback", OWNER);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "Post-class feedback sync is already running." });

    for (const thrown of ["sensitive driver detail", "advisory lock already running"]) {
      const failed = await runDataHealthJob("post_class_feedback", OWNER);
      const body = await failed.json();
      expect(failed.status).toBe(500);
      expect(body).toEqual({ error: "Post-class feedback sync failed" });
      expect(JSON.stringify(body)).not.toContain(thrown);
    }

    expect(runPostClassFeedbackSync).toHaveBeenCalledTimes(3);
    expect(processPostClassAiReviews).not.toHaveBeenCalled();
    expect(processDuePostClassNotificationRetries).not.toHaveBeenCalled();
    expect(runPostClassDeductionHygiene).not.toHaveBeenCalled();
  });

  it("returns a sync deferred by a live payout lease as a 409 with the lease message, as the cron does", async () => {
    const lease = "Post-class feedback sync is deferred while a payout operation holds a live lease.";
    vi.mocked(runPostClassFeedbackSync).mockRejectedValueOnce(new PostClassFeedbackSyncAlreadyRunningError(lease));

    const response = await runDataHealthJob("post_class_feedback", OWNER);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: lease });
    expect(runPostClassDeductionHygiene).not.toHaveBeenCalled();
  });

  it("runs only the daily admissions scan on a Bangkok weekday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BANGKOK_THURSDAY);

    const response = await runDataHealthJob("admissions_notifications", OWNER);

    expect(runDailyNotifications).toHaveBeenCalledWith(BANGKOK_THURSDAY);
    expect(runWeeklyDigest).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, skipped: false, results: [admissionsResult("daily")] });
  });

  it("adds the weekly admissions digest on a Bangkok Sunday, as the cron does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BANGKOK_SUNDAY);

    const response = await runDataHealthJob("admissions_notifications", OWNER);
    const body = await response.json();

    expect(runDailyNotifications).toHaveBeenCalledWith(BANGKOK_SUNDAY);
    expect(runWeeklyDigest).toHaveBeenCalledWith(BANGKOK_SUNDAY);
    expect(vi.mocked(runWeeklyDigest).mock.calls[0][0]).toBe(vi.mocked(runDailyNotifications).mock.calls[0][0]);
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(2);
  });

  it("reports 202 when every admissions pass was skipped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BANGKOK_SUNDAY);
    vi.mocked(runDailyNotifications).mockResolvedValueOnce(admissionsResult("daily", true));
    vi.mocked(runWeeklyDigest).mockResolvedValueOnce(admissionsResult("weekly", true));

    const response = await runDataHealthJob("admissions_notifications", OWNER);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, skipped: true });
  });

  it("runs the LINE backlog recovery live, as its manual route does", async () => {
    const response = await runDataHealthJob("line_backlog_recovery", OWNER);

    expect(runLineBacklogRecovery).toHaveBeenCalledWith({ db: SENTINEL_DB, dryRun: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { inserted: 0 } });
  });
});
