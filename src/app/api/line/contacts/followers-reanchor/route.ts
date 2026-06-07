import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runLineFollowersReanchor } from "@/lib/line/student-links";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";

// Combined followers re-anchor + backlog identity recovery.
// Raised from 60 → 300: runLineFollowersReanchor does ~1,962 sequential LINE API calls;
// runLineBacklogRecovery now self-fetches the full roster (batched, concurrency 10).
// On the LIVE combined route the roster is double-fetched (reanchor sequential + backlog batched);
// the dedicated C2 cron (Plan 05) calls runLineBacklogRecovery directly (single fetch) and is
// the clean production vehicle. The double-fetch is a known follow-up — do not attempt to fix here.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // Step 1: auth() → 401
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read optional ?dryRun=true query param.
  // When dryRun=true, reanchor writes are skipped entirely; runLineBacklogRecovery
  // self-fetches the roster and is read-only on dryRun.
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";

  // dryRun skips reanchor's writes — runLineBacklogRecovery self-fetches the roster and is read-only on dryRun
  // Steps 2 & 3: No body needed — skip json + Zod parse
  // Step 4: business logic in try/catch → 500
  try {
    const reanchor = dryRun ? null : await runLineFollowersReanchor({ db: getDb() });
    const backlog = await runLineBacklogRecovery({ db: getDb(), dryRun });
    return NextResponse.json({ reanchor, backlog });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to run followers re-anchor / backlog recovery";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
