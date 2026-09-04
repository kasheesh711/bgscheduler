import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createFootTrafficReportSnapshot, normalizeFootTrafficFilters } from "@/lib/onsite-foot-traffic/data";
import type { FootTrafficFilters } from "@/lib/onsite-foot-traffic/types";

export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Partial<FootTrafficFilters> & { filters?: Partial<FootTrafficFilters> };
    const rawFilters = body.filters ?? body;
    const snapshot = await createFootTrafficReportSnapshot({
      db: getDb(),
      filters: normalizeFootTrafficFilters(rawFilters),
      createdByEmail: email,
    });
    const base = `/api/onsite-foot-traffic/reports/${snapshot.id}`;
    return NextResponse.json({
      reportId: snapshot.id,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      htmlUrl: `${base}/html`,
      pdfUrl: `${base}/pdf`,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create foot-traffic report";
    const status = error instanceof SyntaxError || message.startsWith("Invalid") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
