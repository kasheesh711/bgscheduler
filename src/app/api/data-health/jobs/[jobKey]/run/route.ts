import { requireClassroomOperationsOwner, classroomOperationsAccessError } from "@/lib/classrooms/operations-access";
import { isWiseClassroomJob } from "@/lib/classrooms/operations-policy";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCronJobDefinition, type CronJobKey } from "@/lib/data-health/cron-registry";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { getPostClassCapabilities } from "@/lib/post-class-feedback/access";
import { getUnearnedRevenueCapabilities } from "@/lib/unearned-revenue/access";

interface RunRouteContext {
  params: Promise<{ jobKey: string }>;
}

export const maxDuration = 800;

export async function POST(request: NextRequest, context: RunRouteContext) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobKey } = await context.params;
  const job = getCronJobDefinition(jobKey);
  if (!job) {
    return NextResponse.json({ error: "Unknown job" }, { status: 404 });
  }

  // Refused before the confirmation prompt: confirming a job that can never run here would mislead.
  if (job.manualRunDisabledReason !== undefined) {
    return NextResponse.json({ error: job.manualRunDisabledReason }, { status: 409 });
  }

  if (isWiseClassroomJob(job.key) || job.key === "feedback_autowriter") {
    try { await requireClassroomOperationsOwner(); }
    catch (error) { return classroomOperationsAccessError(error); }
  }

  if (job.key.startsWith("post_class_feedback")) {
    const capabilities = await getPostClassCapabilities(session.user.email);
    if (!capabilities.includes("access_manager")) {
      return NextResponse.json({ error: "Access manager capability required" }, { status: 403 });
    }
  }

  // Same grant the feature's own import retry requires (POST /api/unearned-revenue/sync).
  if (job.key === "unearned_revenue") {
    const capabilities = await getUnearnedRevenueCapabilities(session.user.email);
    if (!capabilities.includes("access_manager")) {
      return NextResponse.json({ error: "Unearned Revenue access manager capability required" }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({})) as { confirmed?: boolean };
  if (job.dangerous && body.confirmed !== true) {
    return NextResponse.json(
      {
        error: "Confirmation required",
        confirmationLabel: job.confirmationLabel,
      },
      { status: 409 },
    );
  }

  return runDataHealthJob(job.key as CronJobKey, session.user.email);
}
