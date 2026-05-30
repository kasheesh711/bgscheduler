import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createWiseClient } from "@/lib/wise/client";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { getPayrollPayload } from "@/lib/payroll/data";
import { PayrollSyncAlreadyRunningError, runPayrollSync } from "@/lib/payroll/sync";

export const maxDuration = 800;

const DEFAULT_INSTITUTE_ID = "696e1f4d90102225641cc413";

function numberOption(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
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
  const month = typeof input.month === "string" ? input.month : todayBangkok().slice(0, 7);

  try {
    const result = await runPayrollSync(
      getDb(),
      createWiseClient(),
      process.env.WISE_INSTITUTE_ID ?? DEFAULT_INSTITUTE_ID,
      month,
      { maxEventPages: numberOption(input.maxEventPages, 1000, 1, 2000) },
    );
    const payload = await getPayrollPayload(getDb(), month);
    return NextResponse.json({ ok: true, result, payload });
  } catch (error) {
    if (error instanceof PayrollSyncAlreadyRunningError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Payroll sync failed";
    return NextResponse.json(
      { error: message },
      { status: message.startsWith("Invalid month") ? 400 : 500 },
    );
  }
}
