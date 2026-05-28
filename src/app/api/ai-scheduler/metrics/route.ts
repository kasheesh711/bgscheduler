import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCorrectionTelemetry } from "@/lib/ai/correction-telemetry";
import { getAiSchedulerMetrics } from "@/lib/ai/scheduler-metrics";
import { getDb } from "@/lib/db";
import { getLineSchedulerAnalytics } from "@/lib/line/data";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const [scheduler, line, correction] = await Promise.all([
    getAiSchedulerMetrics(db),
    getLineSchedulerAnalytics(db),
    getCorrectionTelemetry(db),
  ]);

  return NextResponse.json({ scheduler, line, correction });
}
