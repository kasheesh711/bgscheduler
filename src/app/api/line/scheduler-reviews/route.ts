import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLineSchedulerAnalytics, listLineSchedulerReviews } from "@/lib/line/data";

const statusSchema = z.enum([
  "pending_review",
  "approved_sent",
  "accepted_no_send",
  "rejected",
  "dismissed",
]);

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawStatus = request.nextUrl.searchParams.get("status");
  const parsedStatus = rawStatus ? statusSchema.safeParse(rawStatus) : null;
  if (parsedStatus && !parsedStatus.success) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const conversationId = request.nextUrl.searchParams.get("conversationId") ?? undefined;
  const includeAnalytics = request.nextUrl.searchParams.get("analytics") === "true";
  const db = getDb();
  const [reviews, analytics] = await Promise.all([
    listLineSchedulerReviews(db, {
      status: parsedStatus?.success ? parsedStatus.data : undefined,
      conversationId,
    }),
    includeAnalytics ? getLineSchedulerAnalytics(db) : Promise.resolve(null),
  ]);

  return NextResponse.json({ reviews, analytics });
}
