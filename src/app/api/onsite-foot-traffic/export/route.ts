import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  buildFootTrafficAggregateCsv,
  buildFootTrafficVisitCsv,
} from "@/lib/onsite-foot-traffic/csv";
import {
  parseFootTrafficFilters,
  readFootTrafficDashboard,
  readFootTrafficVisitDetails,
} from "@/lib/onsite-foot-traffic/data";
import type { FootTrafficExportGrain } from "@/lib/onsite-foot-traffic/types";

const GRAINS = new Set<FootTrafficExportGrain>(["weekly", "monthly", "weekday", "room", "visits"]);

export async function GET(request: Request) {
  const startedAt = performance.now();
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const searchParams = new URL(request.url).searchParams;
    const grain = searchParams.get("grain") as FootTrafficExportGrain | null;
    if (!grain || !GRAINS.has(grain)) {
      return NextResponse.json({ error: "Invalid grain. Expected weekly, monthly, weekday, room, or visits." }, { status: 400 });
    }
    const db = getDb();
    const { payload, timings } = await readFootTrafficDashboard(db, parseFootTrafficFilters(searchParams));
    const visitRead = grain === "visits"
      ? await readFootTrafficVisitDetails(db, payload.meta)
      : null;
    const { csv, filename } = grain === "visits"
      ? buildFootTrafficVisitCsv(payload.meta, visitRead!.visits)
      : buildFootTrafficAggregateCsv(payload, grain);
    const totalMs = Math.round((performance.now() - startedAt) * 10) / 10;
    console.info(JSON.stringify({
      level: "info",
      event: "onsite_foot_traffic_export_done",
      route: "/api/onsite-foot-traffic/export",
      grain,
      status: 200,
      totalMs,
      rowCount: grain === "visits" ? visitRead!.visits.length : undefined,
    }));
    const serverTiming = [
      `metadata;dur=${timings.metadataMs}`,
      `database;dur=${timings.databaseMs}`,
      `aggregate;dur=${timings.aggregationMs}`,
      ...(visitRead ? [
        `visit-database;dur=${visitRead.timings.databaseMs}`,
        `visit-transform;dur=${visitRead.timings.transformMs}`,
      ] : []),
      `total;dur=${totalMs}`,
    ].join(", ");
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "Server-Timing": serverTiming,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export onsite foot traffic";
    const status = message.startsWith("Invalid") ? 400 : 500;
    console.error(JSON.stringify({
      level: "error",
      event: "onsite_foot_traffic_export_failed",
      route: "/api/onsite-foot-traffic/export",
      status,
      error: message,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
    return NextResponse.json({ error: message }, { status });
  }
}
