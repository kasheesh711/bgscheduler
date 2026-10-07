import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getRosterSecretStatus } from "@/lib/igcse-roster/auth";
import { buildIgcseRoster } from "@/lib/igcse-roster/build";
import { loadIgcseRosterInput, NoActiveSnapshotError } from "@/lib/igcse-roster/load";

export const maxDuration = 60;

/**
 * IGCSE QB roster export. Read-only; Bearer ROSTER_EXPORT_SECRET (not the cron
 * secret, so the QB service never holds anything that can trigger syncs).
 */
export async function GET(request: NextRequest) {
  const status = getRosterSecretStatus(request.headers.get("authorization"));
  if (status === "missing-secret") {
    return NextResponse.json({ error: "Roster export not configured" }, { status: 503 });
  }
  if (status === "invalid") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { snapshotGeneratedAt, ...input } = await loadIgcseRosterInput(getDb());
    const roster = buildIgcseRoster(input);
    return NextResponse.json(
      { ...roster, snapshotGeneratedAt: snapshotGeneratedAt.toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof NoActiveSnapshotError) {
      return NextResponse.json({ error: "No active Wise snapshot" }, { status: 503 });
    }
    console.error("[igcse-roster] export failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Roster export failed" }, { status: 500 });
  }
}
