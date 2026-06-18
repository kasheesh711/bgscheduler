import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCronJobDefinition, type CronJobKey } from "@/lib/data-health/cron-registry";
import { runDataHealthJob } from "@/lib/data-health/run-job";

interface RunRouteContext {
  params: Promise<{ jobKey: string }>;
}

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
  if (!job.manualRunSupported) {
    return NextResponse.json(
      { error: "Manual run is not available for this job" },
      { status: 409 },
    );
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
