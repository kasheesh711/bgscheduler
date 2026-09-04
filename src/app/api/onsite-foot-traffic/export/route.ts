import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { buildFootTrafficCsv } from "@/lib/onsite-foot-traffic/csv";
import { getFootTrafficDashboard, parseFootTrafficFilters } from "@/lib/onsite-foot-traffic/data";
import type { FootTrafficExportGrain } from "@/lib/onsite-foot-traffic/types";

const GRAINS = new Set<FootTrafficExportGrain>(["weekly", "monthly", "weekday", "room", "visits"]);

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const searchParams = new URL(request.url).searchParams;
    const grain = searchParams.get("grain") as FootTrafficExportGrain | null;
    if (!grain || !GRAINS.has(grain)) {
      return NextResponse.json({ error: "Invalid grain. Expected weekly, monthly, weekday, room, or visits." }, { status: 400 });
    }
    const payload = await getFootTrafficDashboard(getDb(), parseFootTrafficFilters(searchParams));
    const { csv, filename } = buildFootTrafficCsv(payload, grain);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export onsite foot traffic";
    const status = message.startsWith("Invalid") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
