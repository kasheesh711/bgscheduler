import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { syncWiseActivityEvents, WiseActivitySyncAlreadyRunningError } from "@/lib/wise-activity/sync";

export const maxDuration = 800;

const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};

  try {
    const result = await syncWiseActivityEvents(
      getDb(),
      createWiseClient(),
      process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
      {
        triggerType: "manual",
        lookbackDays: numberOption(input.lookbackDays, 30, 1, 365),
        maxPages: numberOption(input.maxPages, 500, 1, 1_000),
      },
    );
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof WiseActivitySyncAlreadyRunningError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Wise activity sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
