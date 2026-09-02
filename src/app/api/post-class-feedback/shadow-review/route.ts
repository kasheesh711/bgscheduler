import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePostClassCapability } from "@/lib/post-class-feedback/access";
import { postClassFeedbackErrorResponse } from "@/lib/post-class-feedback/api";
import { PostClassConflictError, PostClassValidationError } from "@/lib/post-class-feedback/errors";
import { selectFreshPostClassShadowSync } from "@/lib/post-class-feedback/shadow-review";
import { markPostClassShadowReviewed } from "@/lib/post-class-feedback/settings";

const BodySchema = z.object({ expectedVersion: z.number().int().positive() });

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
    const recentSyncs = await db.select({
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
      .limit(20);
    const successfulSync = selectFreshPostClassShadowSync(
      recentSyncs,
      settings.policyVersion,
      settings.formMappingVersion,
      mappingUpdatedAt,
    );
    if (!successfulSync) {
      throw new PostClassValidationError(
        "Run and inspect a successful, non-empty shadow sync using the current Wise form mapping before confirming review.",
      );
    }
    const updated = await markPostClassShadowReviewed(
      actor.email,
      db,
      input.expectedVersion,
      successfulSync.id,
    );
    return NextResponse.json({ ok: true, settings: updated, evidenceSyncRunId: successfulSync.id });
  } catch (error) {
    return postClassFeedbackErrorResponse(
      "POST /api/post-class-feedback/shadow-review",
      error,
      "Could not confirm the shadow review.",
    );
  }
}
