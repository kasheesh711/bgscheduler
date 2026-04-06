import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";

export const maxDuration = 300; // 5 minutes for Vercel

export async function POST(request: NextRequest) {
  // Validate cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";

  const result = await runFullSync(db, client, instituteId);

  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
  });
}
