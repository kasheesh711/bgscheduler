import { nightlyWorkerOutcome, runNightlyReminders } from "@/lib/post-class-feedback/nightly-reminders";
import { isClassroomOperationsOwner, isWiseClassroomJob, pausedWiseClassroomResult, wiseClassroomAutomationEnabled } from "@/lib/classrooms/operations-policy";
import { runClassroomPublishRecovery } from "@/lib/classrooms/publish-worker";
import { runRoomRefresh } from "@/lib/room-booking/refresh";
import { NextResponse } from "next/server";
import { runWeekendClassroomCheck } from "@/lib/classrooms/weekend-check";
import { getDb } from "@/lib/db";
import { prepareNextDayClassrooms, deliverNextDayClassroomSchedules } from "@/lib/classrooms/daily-automation";
import { runCompetitorIntelligenceSync } from "@/lib/competitor-intelligence/sync";
import { runCreditControlSyncRequest } from "@/lib/credit-control/run-sync-request";
import { syncLeaveRequests } from "@/lib/leave-requests/sync";
import { syncRoomUtilizationSessions } from "@/lib/room-capacity/utilization";
import { runOnsiteFootTrafficSync } from "@/lib/onsite-foot-traffic/sync";
import {
  importActiveSalesDashboardProjectionSource,
  importRefreshableSalesSources,
} from "@/lib/sales-dashboard/data";
import { runCronWatchdog } from "@/lib/internal/cron-watchdog";
import { runPostClassCollectionTickRequest } from "@/lib/post-class-feedback/collection-tick";
import { sendPostClassAdminDigest } from "@/lib/post-class-feedback/notifications";
import { payoutJobResponse, runPayoutAccrualPass, runPayoutFinalizePass } from "@/lib/post-class-feedback/payout-accrual";
import { runPostClassReminderJob } from "@/lib/post-class-feedback/reminder-job";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents, WiseActivitySyncAlreadyRunningError } from "@/lib/wise-activity/sync";
import { runDailyNotifications, runWeeklyDigest } from "@/lib/admissions/notifications";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";
import { sendLineCreditDigest } from "@/lib/line/credit-digest";
import { runPostClassBackfillJob } from "@/lib/post-class-feedback/backfill-job";
import { findOldestUnreconciledBackfillWindow } from "@/lib/post-class-feedback/backfill-window";
import { PostClassFeedbackSyncAlreadyRunningError } from "@/lib/post-class-feedback/repository";
import { sendProgressTestAdminDigest } from "@/lib/progress-tests/admin-digest";
import { runProgressTestSyncRequest } from "@/lib/progress-tests/run-sync-request";
import { sitInError, sitInJson } from "@/lib/tutor-sit-ins/http";
import { processJobs as processSitInJobs, queueDailyDigests, runSitInWorker } from "@/lib/tutor-sit-ins/worker";
import { runUnearnedRevenueSync } from "@/lib/unearned-revenue/sync";
import { withCronInvocationAudit } from "./cron-audit";
import { getCronJobDefinition, type CronJobKey } from "./cron-registry";

const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

/**
 * Runs one registry job in-process for the Data Health job runner.
 *
 * 1. Unknown key → 404; a job carrying `manualRunDisabledReason` → 409 with that reason.
 *    Both return before the audit wrapper, so neither writes a `cron_invocations` row.
 * 2. Wise/classroom jobs and the feedback autowriter are owner-only (403).
 * 3. Otherwise the job's branch runs inside `withCronInvocationAudit` as `triggerSource: "admin"`,
 *    mirroring its `/api/internal/*` cron route. The terminal `Unknown job` 404 inside the wrapper
 *    is a defensive default (audited as failed); run-job.test.ts keeps every runnable key off it.
 */
export async function runDataHealthJob(jobKey: CronJobKey, actorEmail: string | null) {
  const job = getCronJobDefinition(jobKey);
  if (!job) {
    return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  }

  if (job.manualRunDisabledReason !== undefined) {
    return NextResponse.json({ error: job.manualRunDisabledReason }, { status: 409 });
  }

  if ((isWiseClassroomJob(jobKey) || jobKey === "feedback_autowriter") && !isClassroomOperationsOwner(actorEmail)) {
    return NextResponse.json({ error: "Only Kevin can run this job." }, { status: 403 });
  }

  return withCronInvocationAudit(
    {
      jobKey,
      triggerSource: "admin",
      actorEmail,
      requestMethod: "POST",
    },
    async () => {
      if (isWiseClassroomJob(jobKey) && jobKey !== "wise_snapshot" && !wiseClassroomAutomationEnabled()) {
        return NextResponse.json(pausedWiseClassroomResult());
      }
      if (jobKey === "feedback_autowriter") {
        try {
          const { runAutowriterJob } = await import("@/lib/feedback-autowriter/dispatch");
          const result = await runAutowriterJob();
          return NextResponse.json(result, { status: result.ok ? 200 : 503 });
        } catch { return NextResponse.json({ ok: false, error: "Feedback autowriter sweep could not complete." }, { status: 503 }); }
      }
      if (jobKey === "post_class_feedback_nightly") {
        try {
          const result = nightlyWorkerOutcome(await runNightlyReminders());
          return NextResponse.json(result, { status: result.ok ? 200 : 503 });
        } catch { return NextResponse.json({ ok: false, error: "Nightly reminder processing failed." }, { status: 503 }); }
      }
      if (jobKey === "progress_tests_processing") {
        const { processJobs } = await import("@/lib/progress-tests/workspace/jobs");
        return NextResponse.json(await processJobs());
      }
      if (jobKey === "room_booking") {
        try { const result = await runRoomRefresh(getDb()); return NextResponse.json(result, { status: result.ok ? 200 : 500 }); }
        catch { return NextResponse.json({ ok: false, errorSummary: "Room refresh failed" }, { status: 500 }); }
      }
      if (jobKey === "classroom_weekend_check") {
        try {
          const result = await runWeekendClassroomCheck();
          return NextResponse.json(result, { status: result.ok ? 200 : 500 });
        } catch (error) {
          return NextResponse.json({ ok: false, errorSummary: error instanceof Error ? error.message : "Weekend check failed" }, { status: 500 });
        }
      }
      if (jobKey === "wise_snapshot") {
        return runWiseSyncRequest({ manualOwner: actorEmail ?? undefined });
      }

      if (jobKey === "wise_activity") {
        try {
          const result = await syncWiseActivityEvents(
            getDb(),
            createWiseClient(),
            process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
            { triggerType: "manual" },
          );
          return NextResponse.json({ ok: true, result });
        } catch (error) {
          if (error instanceof WiseActivitySyncAlreadyRunningError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
          }
          const message = error instanceof Error ? error.message : "Wise activity sync failed";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "sales_dashboard") {
        try {
          const results = await importRefreshableSalesSources({
            triggerType: "manual",
            actorEmail: actorEmail ?? "data-health@begifted.local",
          });
          const projectionResult = await importActiveSalesDashboardProjectionSource({
            triggerType: "manual",
            actorEmail: actorEmail ?? "data-health@begifted.local",
          });
          return NextResponse.json({ ok: true, results, projectionResult });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sales dashboard sync failed";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "competitor_intelligence") {
        try {
          const result = await runCompetitorIntelligenceSync({
            triggerType: "manual",
            actorEmail: actorEmail ?? "data-health@begifted.local",
          });
          return NextResponse.json({ ok: result.status === "success", result }, {
            status: result.status === "success" ? 200 : 500,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Competitor intelligence sync failed";
          return NextResponse.json(
            { error: message },
            { status: message.includes("already running") ? 409 : 500 },
          );
        }
      }

      if (jobKey === "credit_control") {
        return runCreditControlSyncRequest();
      }

      if (jobKey === "post_class_feedback") {
        // The cron's own tick and HTTP mapping, attributed to the actor.
        return runPostClassCollectionTickRequest({ triggerType: "manual", actorEmail });
      }

      if (jobKey === "post_class_feedback_digest") {
        const result = await sendPostClassAdminDigest();
        return NextResponse.json({ ok: true, result });
      }

      if (jobKey === "post_class_feedback_day_after" || jobKey === "post_class_feedback_deadline") {
        const result = await runPostClassReminderJob(
          jobKey === "post_class_feedback_day_after" ? "day_after" : "deadline",
          { triggerType: "manual", actorEmail },
        );
        if (!result.ready) {
          return NextResponse.json({
            ok: false,
            error: "Post-class reminder checkpoint still has unreconciled Wise sessions.",
            result,
          }, { status: 503 });
        }
        return NextResponse.json({ ok: true, result });
      }

      if (jobKey === "post_class_feedback_payout_accrual") {
        try {
          const accrual = await runPayoutAccrualPass();
          const finalize = await runPayoutFinalizePass();
          const result = payoutJobResponse(accrual, finalize);
          return NextResponse.json(result, { status: result.ok ? 200 : 503 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Post-class payout accrual failed";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "leave_requests") {
        try {
          const result = await syncLeaveRequests(getDb(), {
            triggerType: "manual",
            actorEmail,
          });
          return NextResponse.json({ ok: true, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Leave request sync failed";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "classroom_publish_recovery") {
        const result = await runClassroomPublishRecovery(getDb());
        return NextResponse.json(result, { status: result.ok ? 200 : 500 });
      }

      if (jobKey === "classroom_morning") {
        try {
          const result = await prepareNextDayClassrooms();
          return NextResponse.json(result, { status: result.ok ? 200 : 500 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Next-day classroom preparation failed";
          return NextResponse.json({ ok: false, error: message }, { status: 500 });
        }
      }

      if (jobKey === "classroom_admin_email") {
        try {
          const result = await deliverNextDayClassroomSchedules();
          const status = result.ok ? 200 : 500;
          return NextResponse.json(result, { status });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Admin classroom schedule email failed";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "cron_watchdog") {
        try {
          const result = await runCronWatchdog(getDb());
          return NextResponse.json({ ok: true, ...result });
        } catch (error) {
          console.error("Cron watchdog sweep failed", error);
          const message = error instanceof Error ? error.message : "Cron watchdog sweep failed";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "room_utilization") {
        try {
          const result = await syncRoomUtilizationSessions(getDb());
          return NextResponse.json({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to sync room utilization";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "onsite_foot_traffic") {
        try {
          const result = await runOnsiteFootTrafficSync(getDb(), {
            triggerType: "manual",
            actorEmail,
          });
          return NextResponse.json(result, { status: result.skipped ? 202 : 200 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to sync onsite foot traffic";
          return NextResponse.json({ error: message }, { status: 500 });
        }
      }

      if (jobKey === "tutor_sit_ins") {
        try {
          const result = await runSitInWorker();
          return sitInJson(result, result.ok ? 200 : 500);
        } catch (error) {
          return sitInError(error);
        }
      }

      if (jobKey === "tutor_sit_ins_digest") {
        try {
          await queueDailyDigests();
          const result = await processSitInJobs(getDb(), {
            limit: 50,
            deadlineAt: Date.now() + 270_000,
          });
          return sitInJson(result, result.failed ? 500 : 200);
        } catch (error) {
          return sitInError(error);
        }
      }

      if (jobKey === "unearned_revenue") {
        const result = await runUnearnedRevenueSync({ triggerType: "manual", actorEmail });
        return NextResponse.json(result, { status: result.ok ? result.skipped ? 202 : 200 : 502 });
      }

      if (jobKey === "progress_tests") {
        return runProgressTestSyncRequest({ triggerType: "manual", actorEmail });
      }

      if (jobKey === "progress_tests_digest") {
        const result = await sendProgressTestAdminDigest();
        return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
      }

      if (jobKey === "post_class_feedback_backfill") {
        try {
          const window = await findOldestUnreconciledBackfillWindow();
          if (!window) {
            return NextResponse.json({ ok: true, skipped: "nothing-unreconciled" });
          }
          // Same single 50-detail batch as the cron. A chosen date range is one batch from the
          // Post-Class Feedback settings Backfill dialog, or a multi-batch CRON_SECRET re-drain.
          const result = await runPostClassBackfillJob({
            startDate: window.startDate,
            endDate: window.endDate,
            actorEmail,
            detailCap: 50,
            maxBatches: 1,
          });
          return NextResponse.json({ ok: true, window, result });
        } catch (error) {
          if (error instanceof PostClassFeedbackSyncAlreadyRunningError) {
            return NextResponse.json({ error: error.message }, { status: 409 });
          }
          return NextResponse.json({ error: "Post-class feedback backfill failed" }, { status: 500 });
        }
      }

      if (jobKey === "admissions_notifications") {
        const now = new Date();
        const results = [await runDailyNotifications(now)];
        // Same cadence as the cron: the weekly digest joins the daily scan on Bangkok Sundays.
        if (formatBangkokDateTime(now, { weekday: "short" }, "en-US") === "Sun") {
          results.push(await runWeeklyDigest(now));
        }
        const skipped = results.every((result) => result.skipped);
        return NextResponse.json({ ok: true, skipped, results }, { status: skipped ? 202 : 200 });
      }

      if (jobKey === "line_credit_digest") {
        const result = await sendLineCreditDigest();
        return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
      }

      if (jobKey === "line_backlog_recovery") {
        const result = await runLineBacklogRecovery({ db: getDb(), dryRun: false });
        return NextResponse.json({ ok: true, result });
      }

      return NextResponse.json({ error: "Unknown job" }, { status: 404 });
    },
  );
}
