import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCronJobDefinition, type CronJobKey } from "@/lib/data-health/cron-registry";
import { runDataHealthJob } from "@/lib/data-health/run-job";
import { getPostClassCapabilities } from "@/lib/post-class-feedback/access";

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

  if (job.key.startsWith("post_class_feedback")) {
    const capabilities = await getPostClassCapabilities(session.user.email);
    if (!capabilities.includes("access_manager")) {
      return NextResponse.json({ error: "Access manager capability required" }, { status: 403 });
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
