import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseFootTrafficFilters, readFootTrafficDashboard } from "@/lib/onsite-foot-traffic/data";

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = request.headers.get("x-vercel-id") ?? undefined;
  console.info(JSON.stringify({
    level: "info",
    event: "onsite_foot_traffic_api_start",
    route: "/api/onsite-foot-traffic",
    requestId,
  }));
  const authStartedAt = performance.now();
  const session = await auth();
  const authMs = Math.round((performance.now() - authStartedAt) * 10) / 10;
  if (!session?.user?.email) {
    console.info(JSON.stringify({
      level: "info",
      event: "onsite_foot_traffic_api_done",
      route: "/api/onsite-foot-traffic",
      requestId,
      status: 401,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const filters = parseFootTrafficFilters(new URL(request.url).searchParams);
    const { payload, timings } = await readFootTrafficDashboard(getDb(), filters);
    const totalMs = Math.round((performance.now() - startedAt) * 10) / 10;
    console.info(JSON.stringify({
      level: "info",
      event: "onsite_foot_traffic_api_done",
      route: "/api/onsite-foot-traffic",
      requestId,
      status: 200,
      authMs,
      totalMs,
      responseBytes: Buffer.byteLength(JSON.stringify(payload)),
    }));
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
        "Server-Timing": [
          `auth;dur=${authMs}`,
          `metadata;dur=${timings.metadataMs}`,
          `database;dur=${timings.databaseMs}`,
          `aggregate;dur=${timings.aggregationMs}`,
          `total;dur=${totalMs}`,
        ].join(", "),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load onsite foot traffic";
    const status = message.startsWith("Invalid") ? 400 : 500;
    console.error(JSON.stringify({
      level: "error",
      event: "onsite_foot_traffic_api_failed",
      route: "/api/onsite-foot-traffic",
      requestId,
      status,
      error: message,
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
    return NextResponse.json({ error: message }, { status });
  }
}
