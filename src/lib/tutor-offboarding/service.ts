import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/lib/db";
import { buildOffboardingDashboard } from "./data";
import { listDecisions } from "./decisions";
import { isMissingSchemaError } from "./errors";
import { listGrants } from "./grants";
import { loadFeedTimestamps, loadOffboardingSignals } from "./signals";
import type { OffboardingDashboard, OffboardingPersonRow, OffboardingSignals, TutorOffboardingViewer } from "./types";

/** Cached per snapshot: the sync's revalidateTag("snapshot") clears it. Freshness, decisions and grants are read uncached. */
export async function getCachedOffboardingSignals(): Promise<OffboardingSignals | null> {
  "use cache";
  cacheTag("snapshot");
  cacheLife("hours");
  return loadOffboardingSignals(getDb(), new Date());
}

export async function loadTutorOffboardingDashboard(viewer: TutorOffboardingViewer): Promise<OffboardingDashboard> {
  const db = getDb();
  try {
    const [signals, feeds, decisions, grants] = await Promise.all([
      getCachedOffboardingSignals(),
      loadFeedTimestamps(db),
      listDecisions(db),
      viewer.isOwner ? listGrants(db) : Promise.resolve(null),
    ]);
    if (!signals) return { available: false, reason: "no_snapshot", viewer };
    return { available: true, ...buildOffboardingDashboard({ signals, feeds, decisions, grants, viewer, now: new Date() }) };
  } catch (error) {
    if (isMissingSchemaError(error)) return { available: false, reason: "not_set_up", viewer };
    throw error;
  }
}

/** The row the page shows for a person (review list, excluded or staff); null when they are on none of them. */
export async function findPersonRow(viewer: TutorOffboardingViewer, canonicalKey: string): Promise<OffboardingPersonRow | null> {
  const dashboard = await loadTutorOffboardingDashboard({ ...viewer, isOwner: false });
  if (!dashboard.available) return null;
  return [...dashboard.inbox, ...dashboard.excluded, ...dashboard.staff].find((row) => row.signals.canonicalKey === canonicalKey) ?? null;
}
