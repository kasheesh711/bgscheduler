import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export type CronSecretStatus = "valid" | "invalid" | "missing-secret";

export function getCronSecretStatus(request: NextRequest): CronSecretStatus {
  const authHeader = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) return "missing-secret";

  const received = Buffer.from(authHeader);
  const known = Buffer.from(`Bearer ${cronSecret}`);
  const valid = received.length === known.length && timingSafeEqual(received, known);

  return valid ? "valid" : "invalid";
}

export function rejectInvalidCronSecret(request: NextRequest): NextResponse | null {
  const status = getCronSecretStatus(request);
  if (status === "valid") return null;
  if (status === "missing-secret") {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
