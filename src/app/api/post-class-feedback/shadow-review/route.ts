import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { PostClassConflictError, PostClassValidationError } from "@/lib/post-class-feedback/errors";
import {
  countOpenBlockingGlobalSourceIssues,
  loadPostClassRecentSessionReadiness,
} from "@/lib/post-class-feedback/repository";
import { classifyPostClassShadowReviewEvidence } from "@/lib/post-class-feedback/shadow-review";
import { markPostClassShadowReviewed } from "@/lib/post-class-feedback/settings";

/** Mirrors the collector's `ROLLING_WINDOW_DAYS`; see the comment at its use. */
const RECENT_READINESS_DAYS = 4;

const BodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  /**
   * Exact count of unresolved sessions the operator was shown. Must equal what
   * the server computes now, so a stale tab cannot wave through a number that
   * has grown since it rendered.
   */
  acknowledgeSessionIssues: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePostClassCapability("access_manager");
    const input = BodySchema.parse(await request.json());
    const db = getDb();
    const [settings] = await db.select().from(schema.postClassSettings).limit(1);
    if (!settings || settings.enforcementMode !== "shadow") {
      throw new PostClassValidationError("Shadow results can only be confirmed while enforcement is in shadow mode.");
    }
    if (settings.version !== input.expectedVersion) throw new PostClassConflictError();
    const mappings = await db.select({ updatedAt: schema.postClassFieldMappings.updatedAt })
      .from(schema.postClassFieldMappings)
      .where(and(
        eq(schema.postClassFieldMappings.mappingVersion, settings.formMappingVersion),
        eq(schema.postClassFieldMappings.active, true),
      ));
    const mappingUpdatedAt = mappings.reduce(
      (latest, row) => row.updatedAt > latest ? row.updatedAt : latest,
      new Date(0),
    );
    if (mappings.length === 0) {
      throw new PostClassValidationError("Configure the current Wise form mapping before confirming review.");
    }
    // Matches the collector's own rolling span, so the gate judges exactly the
    // period the live system is designed to keep reconciled.
    const recentSince = new Date(Date.now() - RECENT_READINESS_DAYS * 24 * 60 * 60 * 1000);
    const [recentSyncs, openBlockingGlobalIssues, recentReadiness] = await Promise.all([
      db.select({
        id: schema.postClassSyncRuns.id,
        finishedAt: schema.postClassSyncRuns.finishedAt,
        detailFetchedCount: schema.postClassSyncRuns.detailFetchedCount,
        sessionCount: schema.postClassSyncRuns.sessionCount,
        assessedCount: schema.postClassSyncRuns.assessedCount,
        metadata: schema.postClassSyncRuns.metadata,
      })
        .from(schema.postClassSyncRuns)
        .where(eq(schema.postClassSyncRuns.status, "success"))
        .orderBy(desc(schema.postClassSyncRuns.finishedAt))
        .limit(20),
      countOpenBlockingGlobalSourceIssues(db),
      loadPostClassRecentSessionReadiness(db, { since: recentSince }),
    ]);
    const verdict = classifyPostClassShadowReviewEvidence(recentSyncs, {
      policyVersion: settings.policyVersion,
      mappingVersion: settings.formMappingVersion,
      mappingUpdatedAt,
      openBlockingGlobalIssues,
      recentReadiness,
      acknowledgements: {
        sessionIssues: input.acknowledgeSessionIssues,
        reason: input.reason,
      },
    });
    if (!verdict.ready || !verdict.evidence) {
      // Name the conditions that actually failed. The single undifferentiated
      // sentence this replaced could not distinguish "no sync has run" from
      // "the mapping moved" from "too many sessions are unresolved".
      const reasons = verdict.blockedBy.map((condition) => condition.detail).join(" ");
      const needsAcknowledgement = verdict.blockedBy.some((condition) =>
        condition.acknowledgeCount !== undefined);
      throw new PostClassValidationError(
        needsAcknowledgement
          ? `${reasons} Acknowledge the exact count (${verdict.acknowledgeableTotal})`
            + " with a reason to confirm anyway."
          : reasons,
      );
    }
    const updated = await markPostClassShadowReviewed(
      actor.email,
      db,
      input.expectedVersion,
      verdict.evidence.id,
      {
        acknowledgedSessionIssues: input.acknowledgeSessionIssues ?? null,
        reason: input.reason?.trim() || null,
        conditions: verdict.conditions.map((condition) => ({
          key: condition.key,
          passed: condition.passed,
        })),
      },
    );
    return NextResponse.json({
      ok: true,
      settings: updated,
      evidenceSyncRunId: verdict.evidence.id,
      conditions: verdict.conditions,
    });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/shadow-review",
      error,
      "Could not confirm the shadow review.",
    );
  }
}
