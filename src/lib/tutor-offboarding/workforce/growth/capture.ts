import type { Database } from "@/lib/db";
import type { WorkforceSession } from "../types";
import { normalizeGrowthBookingMetadata } from "./source";
import { storeGrowthBookingMetadata } from "./store";
import { workforceSubjectMappings } from "@/lib/db/schema";
import { resolveAcademicSubject } from "../subject-mappings";

/** Called by successful local evidence imports, never by a dashboard request. */
export async function captureGrowthBookingMetadata(
  db: Database, sessions: WorkforceSession[], observedAt: string,
): Promise<{ classified: number; unknown: number }> {
  const mappings = (await db.select().from(workforceSubjectMappings)).map(m => ({ ...m, reviewedAt: m.reviewedAt?.toISOString() ?? null }));
  const rows = sessions.map(session => normalizeGrowthBookingMetadata(session, session.observedAt ?? observedAt,
    resolveAcademicSubject({classId:session.wiseClassId, sourceValue:session.classTitle}, mappings).completeness === "complete"));
  await storeGrowthBookingMetadata(db, rows);
  return { classified: rows.filter(r => r.classification !== "unknown").length, unknown: rows.filter(r => r.classification === "unknown").length };
}
