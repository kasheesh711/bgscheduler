import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";

export const maxDuration = 300; // 5 minutes for Vercel

/** Shared sync handler for both GET (Vercel cron) and POST (manual curl) */
async function handleSync(request: NextRequest) {
  // REL-07: constant-time CRON_SECRET comparison. The length-pre-check
  // avoids the RangeError that crypto.timingSafeEqual throws on
  // length-mismatched Buffers, and is itself O(1) — it does not leak
  // the secret length via timing.
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  const valid =
    received.length === known.length && timingSafeEqual(received, known);

  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const client = createWiseClient();
  const instituteId = process.env.WISE_INSTITUTE_ID ?? "696e1f4d90102225641cc413";

  const result = await runFullSync(db, client, instituteId);

  if (result.success) {
    revalidateTag("snapshot", { expire: 0 });
  }

  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
  });
}

/** Vercel cron triggers via GET */
export async function GET(request: NextRequest) {
  return handleSync(request);
}

/** Manual trigger via curl -X POST (backward compatible) */
export async function POST(request: NextRequest) {
  return handleSync(request);
}
