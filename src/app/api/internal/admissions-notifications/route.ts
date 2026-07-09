// Admissions Case Management — notification cron route (design §7, §8).
//
// One cron path covers both cadences: the daily deadline-reminder scan runs
// on every invocation, and on Bangkok Sundays the same invocation also runs
// the weekly digest (digest dedupe keys keep same-day re-runs idempotent).
// Explicit `runType` (query param on GET, JSON body on POST) runs exactly one
// orchestrator, for manual triggers.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  runDailyNotifications,
  runWeeklyDigest,
  type AdmissionsNotificationRunResult,
} from "@/lib/admissions/notifications";
import { formatBangkokDateTime } from "@/lib/bangkok-time";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { rejectInvalidCronSecret } from "@/lib/internal/cron-auth";

export const maxDuration = 300;

const runTypeSchema = z.object({
  runType: z.enum(["daily", "weekly"]).optional(),
});

type RequestedRunType = z.infer<typeof runTypeSchema>["runType"];

/** True when `now` falls on a Sunday in the Asia/Bangkok calendar. */
function isBangkokSunday(now: Date): boolean {
  return formatBangkokDateTime(now, { weekday: "short" }, "en-US") === "Sun";
}

/**
 * Runs the requested notification pass(es) inside the cron invocation audit.
 *
 * 1. Explicit runType "daily" / "weekly" runs exactly that orchestrator.
 * 2. Default (no runType — the Vercel cron case) runs the daily deadline
 *    scan and, on Bangkok Sundays, also the weekly digest.
 * 3. Every pass skipped by the single-flight guard → 202 with skipped=true;
 *    otherwise 200. A top-level orchestrator crash → 500.
 */
async function executeRuns(
  request: NextRequest,
  runType: RequestedRunType,
): Promise<Response> {
  return withCronInvocationAudit(
    {
      jobKey: "admissions_notifications",
      triggerSource: "cron",
      requestMethod: request.method,
    },
    async () => {
      try {
        const now = new Date();
        const results: AdmissionsNotificationRunResult[] = [];
        if (runType !== "weekly") {
          results.push(await runDailyNotifications(now));
        }
        if (runType === "weekly" || (runType === undefined && isBangkokSunday(now))) {
          results.push(await runWeeklyDigest(now));
        }
        const skipped = results.every((result) => result.skipped);
        return NextResponse.json({ ok: true, skipped, results }, { status: skipped ? 202 : 200 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Admissions notification run failed";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    },
  );
}

/** Cron entry point: `runType` comes from the optional query param. */
export async function GET(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  const parsed = runTypeSchema.safeParse({
    runType: request.nextUrl.searchParams.get("runType") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid runType", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return executeRuns(request, parsed.data.runType);
}

/** Manual trigger: `runType` comes from an optional JSON body. */
export async function POST(request: NextRequest) {
  const rejected = rejectInvalidCronSecret(request);
  if (rejected) return rejected;

  const raw = await request.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const parsed = runTypeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid runType", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return executeRuns(request, parsed.data.runType);
}
