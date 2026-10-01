import type { Database } from "@/lib/db";
import type { WorkforceSession } from "../types";
import { normalizeGrowthBookingMetadata } from "./source";
import { storeGrowthBookingMetadata } from "./store";

/** Called by successful local evidence imports, never by a dashboard request. */
export async function captureGrowthBookingMetadata(
  db: Database, sessions: WorkforceSession[], observedAt: string,
): Promise<{ classified: number; unknown: number }> {
  const rows = sessions.map(session => normalizeGrowthBookingMetadata(session, session.observedAt ?? observedAt));
  await storeGrowthBookingMetadata(db, rows);
  return { classified: rows.filter(r => r.classification !== "unknown").length, unknown: rows.filter(r => r.classification === "unknown").length };
}
