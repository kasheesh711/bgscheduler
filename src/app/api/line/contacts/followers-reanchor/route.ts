import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runLineFollowersReanchor } from "@/lib/line/student-links";
import { runLineBacklogRecovery } from "@/lib/line/backlog-recovery";

// Combined followers re-anchor + backlog identity recovery.
// Raised from 60 → 300: runLineFollowersReanchor does ~1,962 sequential LINE API calls;
// runLineBacklogRecovery is in-memory matching (fast), but the combined route needs headroom.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  // Step 1: auth() → 401
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read optional ?dryRun=true query param.
  // When dryRun=true, runLineBacklogRecovery returns matches without writing to DB.
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";

  // Steps 2 & 3: No body needed — skip json + Zod parse
  // Step 4: business logic in try/catch → 500
  try {
    const reanchor = await runLineFollowersReanchor({ db: getDb() });
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
