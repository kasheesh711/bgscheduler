import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withCronInvocationAudit } from "@/lib/data-health/cron-audit";
import { runWiseSyncRequest } from "@/lib/sync/run-wise-sync";

export const maxDuration = 800; // Pro-plan headroom for full Wise syncs

export async function POST() {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronInvocationAudit(
    {
      jobKey: "wise_snapshot",
      triggerSource: "admin",
      actorEmail: session.user?.email ?? null,
      requestMethod: "POST",
    },
    () => runWiseSyncRequest(),
  );
}
