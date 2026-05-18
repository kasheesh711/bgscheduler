import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRoomUtilization, parseUtilizationWeekdays } from "@/lib/room-capacity/utilization";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");

  try {
    const weekdays = parseUtilizationWeekdays(request.nextUrl.searchParams.get("weekdays"));
    const data = await getRoomUtilization(getDb(), { startDate, endDate, weekdays });
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load room utilization";
    const status = message.startsWith("Invalid date range")
      || message.startsWith("Invalid startDate")
      || message.startsWith("Invalid endDate")
      || message.startsWith("Invalid weekdays")
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
