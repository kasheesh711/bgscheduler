import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { syncRoomUtilizationSessions } from "@/lib/room-capacity/utilization";

export const maxDuration = 800;

type CronSecretStatus = "valid" | "invalid" | "missing-secret";

function hasValidCronSecret(request: NextRequest): CronSecretStatus {
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) return "missing-secret";

  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  const valid =
    received.length === known.length && timingSafeEqual(received, known);

  return valid ? "valid" : "invalid";
}

export async function POST(request: NextRequest) {
  const cronSecretStatus = hasValidCronSecret(request);
  if (cronSecretStatus !== "valid") {
    const session = await auth();
    if (!session) {
      if (cronSecretStatus === "missing-secret") {
        return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
      }
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await syncRoomUtilizationSessions(getDb());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync room utilization";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
