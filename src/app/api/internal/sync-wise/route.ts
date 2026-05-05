import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { runFullSync } from "@/lib/sync/orchestrator";
import { auth } from "@/lib/auth";

export const maxDuration = 300; // 5 minutes for Vercel

type CronSecretStatus = "valid" | "invalid" | "missing-secret";

function hasValidCronSecret(request: NextRequest): CronSecretStatus {
  // REL-07: constant-time CRON_SECRET comparison. The length-pre-check
  // avoids the RangeError that crypto.timingSafeEqual throws on
  // length-mismatched Buffers, and is itself O(1) — it does not leak
  // the secret length via timing.
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return "missing-secret";
  }

  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  const valid =
    received.length === known.length && timingSafeEqual(received, known);

  return valid ? "valid" : "invalid";
}

async function runSync() {
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

/** Shared sync handler for both GET (Vercel cron) and POST (manual admin/curl) */
async function handleSync(
  request: NextRequest,
  options: { allowSessionAuth: boolean },
) {
  const cronSecretStatus = hasValidCronSecret(request);

  if (cronSecretStatus === "valid") {
    return runSync();
  }

  if (options.allowSessionAuth) {
    const session = await auth();

    if (session) {
      return runSync();
    }
  }

  if (cronSecretStatus === "missing-secret") {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Vercel cron triggers via GET */
export async function GET(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: false });
}

/** Manual trigger via Auth.js session or curl -X POST (backward compatible) */
export async function POST(request: NextRequest) {
  return handleSync(request, { allowSessionAuth: true });
}
