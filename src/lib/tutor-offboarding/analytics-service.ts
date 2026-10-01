import "server-only";
import { eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/lib/db";
import { snapshots } from "@/lib/db/schema";
import { sqlStateOf } from "@/lib/db/sql-state";
import { loadAnalyticsEvidence } from "./analytics-db";
import { buildTutorOffboardingAnalytics } from "./analytics";
import { listDecisions } from "./decisions";
import { isMissingSchemaError } from "./errors";
import { loadFeedTimestamps } from "./signals";
import { loadTerminationSnapshot } from "./termination-sync";
import type { TutorOffboardingAnalytics } from "./analytics-types";
import type { TerminationSnapshot } from "./termination-source";

/** Serializable cache key binds the compiled history to the roster and attendance feed versions. */
export async function getCachedAnalyticsEvidence(
  snapshotId: string,
  historyWatermarks: string,
) {
  "use cache";
  cacheTag("snapshot");
  cacheLife("minutes");
  void historyWatermarks;
  return loadAnalyticsEvidence(getDb(), snapshotId, new Date());
}
/** Read-only report: permission stays at the API boundary, mutable evidence/decisions/freshness stay uncached. */
export async function loadTutorOffboardingAnalytics(): Promise<TutorOffboardingAnalytics> {
  const db = getDb();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const [snapshot] = await db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(eq(snapshots.active, true))
        .limit(1);
      if (!snapshot) return { available: false, reason: "no_snapshot" };
      const [feeds, decisions, terminationSnapshot] = await Promise.all([
        loadFeedTimestamps(db),
        listDecisions(db),
        loadTerminationSnapshot(db).catch(
          (error: unknown): TerminationSnapshot => {
            if (
              isMissingSchemaError(error) ||
              (typeof error === "object" &&
                error !== null &&
                (error as { digest?: unknown }).digest ===
                  "HANGING_PROMISE_REJECTION")
            )
              throw error;
            return {
              rows: [],
              checkedAt: null,
              lastError: error instanceof Error ? error.name : "UnknownError",
            };
          },
        ),
      ]);
      if (!feeds.tutorSnapshot)
        return { available: false, reason: "no_snapshot" };
      const evidence = await getCachedAnalyticsEvidence(
        snapshot.id,
        JSON.stringify([feeds.progressTests, feeds.postClass]),
      );
      const [current] = await db
        .select({ id: snapshots.id, at: snapshots.createdAt })
        .from(snapshots)
        .where(eq(snapshots.active, true))
        .limit(1);
      if (!current) return { available: false, reason: "no_snapshot" };
      if (
        !evidence ||
        evidence.signals.snapshotId !== current.id ||
        evidence.signals.snapshotCreatedAt !== feeds.tutorSnapshot ||
        current.at.toISOString() !== feeds.tutorSnapshot
      )
        continue;
      return buildTutorOffboardingAnalytics({
        evidence,
        feeds,
        decisions,
        terminationSnapshot,
        now: new Date(),
      });
    }
    return { available: false, reason: "load_failed" };
  } catch (error) {
    if (isMissingSchemaError(error))
      return { available: false, reason: "not_set_up" };
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { digest?: unknown }).digest === "HANGING_PROMISE_REJECTION"
    )
      throw error;
    console.error("[tutor-offboarding:analytics]", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      sqlState: sqlStateOf(error),
    });
    return { available: false, reason: "load_failed" };
  }
}
