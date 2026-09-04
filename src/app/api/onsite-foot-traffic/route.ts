import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getFootTrafficDashboard, parseFootTrafficFilters } from "@/lib/onsite-foot-traffic/data";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const filters = parseFootTrafficFilters(new URL(request.url).searchParams);
    const result = await getFootTrafficDashboard(getDb(), filters);
    const payload = {
      meta: result.meta,
      summary: result.summary,
      weekly: result.weekly,
      monthly: result.monthly,
      byWeekday: result.byWeekday,
      byRoom: result.byRoom,
      dataQuality: result.dataQuality,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load onsite foot traffic";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
