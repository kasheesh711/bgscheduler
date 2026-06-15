import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runClassroomMorningAutomation } from "@/lib/classrooms/morning-automation";
import { sendAdminClassroomScheduleEmail } from "@/lib/classrooms/admin-schedule-email";
import { runCompetitorIntelligenceSync } from "@/lib/competitor-intelligence/sync";
import { runCreditControlSyncRequest } from "@/lib/credit-control/run-sync-request";
import { syncLeaveRequests } from "@/lib/leave-requests/sync";
import { syncRoomUtilizationSessions } from "@/lib/room-capacity/utilization";
import {
  importActiveSalesDashboardProjectionSource,
  importRefreshableSalesSources,
} from "@/lib/sales-dashboard/data";
import { runCronWatchdog } from "@/lib/internal/cron-watchdog";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents, WiseActivitySyncAlreadyRunningError } from "@/lib/wise-activity/sync";
import { withCronInvocationAudit } from "./cron-audit";
import { getCronJobDefinition, type CronJobKey } from "./cron-registry";

const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

export async function runDataHealthJob(jobKey: CronJobKey, actorEmail: string | null) {
  const job = getCronJobDefinition(jobKey);
  if (!job) {
    return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  }

  return withCronInvocationAudit(
    {
      jobKey,
      triggerSource: "admin",
      actorEmail,
      requestMethod: "POST",
    },
    async () => {
      if (jobKey === "wise_snapshot") {
        return runWiseSyncRequest();
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

      if (jobKey === "classroom_morning") {
        try {
          const result = await runClassroomMorningAutomation();
          return NextResponse.json(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Classroom morning automation failed";
          return NextResponse.json({ ok: false, error: message }, { status: 500 });
        }
      }

      if (jobKey === "classroom_admin_email") {
        try {
          const result = await sendAdminClassroomScheduleEmail();
          const status = result.status === "failed" ? 500 : 200;
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

      return NextResponse.json({ error: "Unknown job" }, { status: 404 });
    },
  );
}
