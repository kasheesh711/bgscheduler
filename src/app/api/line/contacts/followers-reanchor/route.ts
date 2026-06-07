import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runLineFollowersReanchor } from "@/lib/line/student-links";

export const maxDuration = 60;

export async function POST() {
  // Step 1: auth() → 401
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Steps 2 & 3: No body needed for this route — skip json + Zod parse

  // Step 4: business logic in try/catch → 500
  try {
    const result = await runLineFollowersReanchor({ db: getDb() });
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run followers re-anchor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
