import { randomUUID } from "node:crypto";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

/** A deliberate approval is backed by an actionable assessment, not merely a ready session. */
export async function seedPayoutAssessment(db: Database, sessionId: string, patch: Partial<typeof schema.postClassAssessments.$inferInsert> = {}) {
  await db.insert(schema.postClassAssessments).values({
    sessionId, assessmentKey: `${sessionId}:${randomUUID()}`, policyVersion: 1, mappingVersion: 1,
    sourceStatus: "ready", contentStatus: "missing", timingStatus: "late", enforcementMode: "live",
    objectiveViolation: true, rawOnTime: false, adjustedCompliant: false, sourceReady: true,
    details: { policyApplies: true }, assessedAt: new Date("2000-01-01T00:00:00Z"), ...patch,
  });
}
