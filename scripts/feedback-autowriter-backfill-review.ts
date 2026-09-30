/**
 * Day-one backfill of the autowriter review tables (operating loop Phase 1, migration 0100).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts           (dry run)
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts --apply   (write)
 *
 * Reads our database only and NEVER writes to Wise (no Wise client is imported). For every settled posted class
 * without a first-shot record it reconstructs the first shot and accepts only a candidate whose rebuilt POST body
 * hashes to the row's `body_hash` (method and proof recorded); a class with no proven candidate gets an incident for
 * the owner. Every one-time re-post the row records — the 29 Sep nickname fixes (`metadata.nicknameFix`) and the
 * owner-approved corrections (`metadata.corrections`) — becomes a correction post with its own `dedupe_key`, so a
 * re-run (or two overlapping runs) records it once. No verdicts are written — those are the owner's. With --apply it
 * then gives each posted class its review row and derives its fix events, as the hourly job would.
 *
 * The dry run also previews the fix-event classification with the job's own code over the same classes (every
 * autowriter class in the 45-day look-back), so it says exactly what the job will store and raise. Go/no-go before
 * --apply and before the review cron first runs: "API saves no post explains" must list no critical one (after
 * the autowriter's go-live); each info one must be a known pre-launch save. Deploy order does not change this:
 * the job explains the one-time re-posts from the row itself until the backfill records them.
 *
 * Output is metadata only: no feedback text, no student names, no correction reasons.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { applyReviewBackfillPlan, planReviewBackfill, type StoredVersion } from "@/lib/feedback-autowriter/backfill";
import { wiseApiActorId } from "@/lib/feedback-autowriter/config";
import { isMissingRelationError } from "@/lib/feedback-autowriter/db-errors";
import { readOneTimeCorrections } from "@/lib/feedback-autowriter/first-shot";
import { UNMATCHED_API_CRITICAL_FROM, ingestFixEvents, loadFixEventSources, planFixEvents } from "@/lib/feedback-autowriter/fix-events";
import { assignReviews, listUnrecordedPostedRows, refreshReviewCounts, tutorKeyFor } from "@/lib/feedback-autowriter/review-job";
import { loadPayoutScriptEnvironment } from "./lib/payout-script";

loadPayoutScriptEnvironment();

const APPLY = process.argv.includes("--apply");
const LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const PC = schema.postClassSessions;
const PCV = schema.postClassFeedbackVersions;

async function main() {
  const apiActorId = wiseApiActorId();
  if (!apiActorId) throw new Error("WISE_USER_ID is not set: our API saves cannot be told apart from anyone else's.");
  const db = getDb();
  const settled = await db.select().from(S).where(inArray(S.state, ["verified", "rejected", "unknown_outcome", "verify_failed"]));
  const posted = settled.filter((row) => row.postStartedAt !== null).toSorted((a, b) => a.postStartedAt!.getTime() - b.postStartedAt!.getTime());
  const ids = posted.map((row) => row.wiseSessionId);
  // A dry run may precede migration 0100: without the review tables nothing is recorded yet.
  const tablesExist = await db.select({ id: P.id }).from(P).limit(1).then(() => true, (error: unknown) => {
    if (APPLY || !isMissingRelationError(error)) throw error;
    return false;
  });
  if (!tablesExist) console.log("(migration 0100 is not applied here: planning as if no review rows exist)");
  const unrecorded = new Set(tablesExist ? (await listUnrecordedPostedRows(db)).map((row) => row.wiseSessionId) : ids);
  const existingPosts = tablesExist && ids.length > 0
    ? await db.select({ wiseSessionId: P.wiseSessionId, kind: P.kind, dedupeKey: P.dedupeKey }).from(P).where(inArray(P.wiseSessionId, ids))
    : [];
  const versions = ids.length > 0 ? await db.select({
    wiseSessionId: PC.wiseSessionId, id: PCV.id, observedAt: PCV.observedAt,
    topics: PCV.topics, performance: PCV.performance, improvement: PCV.improvement, homework: PCV.homework,
  }).from(PCV).innerJoin(PC, eq(PC.id, PCV.sessionId))
    .where(and(inArray(PC.wiseSessionId, ids), eq(PCV.profile, "teacher"), eq(PCV.substantive, true)))
    .orderBy(asc(PCV.observedAt)) : [];

  const plan = planReviewBackfill(posted.map((row) => {
    const stored: StoredVersion[] = versions.filter((version) => version.wiseSessionId === row.wiseSessionId).map((version) => ({
      id: version.id,
      observedAt: version.observedAt,
      fields: { topics: version.topics, performance: version.performance, improvement: version.improvement, homework: version.homework },
    }));
    return {
      row,
      pcFirstVersion: stored[0] ?? null,
      pcVersions: stored,
      hasFirstShot: !unrecorded.has(row.wiseSessionId),
      recordedDedupeKeys: new Set(existingPosts.flatMap((post) =>
        post.wiseSessionId === row.wiseSessionId && post.kind === "correction" && post.dedupeKey ? [post.dedupeKey] : [])),
    };
  }));

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${posted.length} posted classes (settled), ${plan.alreadyRecorded.length} already have a first-shot record`);
  for (const row of posted) {
    const shot = plan.firstShots.find((entry) => entry.wiseSessionId === row.wiseSessionId);
    const missing = plan.unverified.find((entry) => entry.wiseSessionId === row.wiseSessionId);
    const oneTime = readOneTimeCorrections(row.wiseSessionId, row.metadata);
    const planned = plan.corrections.filter((entry) => entry.wiseSessionId === row.wiseSessionId);
    const unproven = plan.unprovenCorrections.filter((entry) => entry.wiseSessionId === row.wiseSessionId);
    console.log([
      `  ${row.wiseSessionId}`,
      tutorKeyFor(row.wiseTeacherUserId).padEnd(6),
      row.state,
      shot ? `first shot PROVEN (${shot.method}, form order ${shot.fieldOrder.join(">")})`
        : missing ? `first shot NOT proven (${missing.reason}; ${missing.candidates} candidates)` : "first shot already recorded",
      oneTime.length === 0 ? "no one-time re-post" : oneTime.map((correction) => {
        const state = planned.some((entry) => entry.dedupeKey === correction.dedupeKey) ? "correction row planned"
          : unproven.some((entry) => entry.dedupeKey === correction.dedupeKey) ? "TEXT NOT FOUND — not recorded" : "already recorded";
        return `${correction.source === "nicknameFix" ? "nickname fix" : "correction"} at ${correction.at.toISOString()} → ${state}`;
      }).join("; "),
    ].join(" | "));
  }

  // What the job's fix-event classification says for every autowriter class (the same code, the same scope).
  const now = new Date();
  const sources = await loadFixEventSources(db, { since: new Date(now.getTime() - LOOKBACK_MS), postsTable: tablesExist });
  const preview = planFixEvents(sources, apiActorId);
  const tally = new Map<string, number>();
  for (const event of preview.classified) tally.set(event.actorKind, (tally.get(event.actorKind) ?? 0) + 1);
  const unmatched = preview.classified.filter((event) => event.actorKind === "api_actor_unmatched");
  const critical = unmatched.filter((event) => event.eventAt.getTime() >= UNMATCHED_API_CRITICAL_FROM.getTime());
  const byKind = (kind: "nicknameFix" | "corrections") => plan.corrections.filter((entry) => entry.source === kind).length;

  console.log(`\nPlan: ${plan.firstShots.length} first shots to record (${[...new Set(plan.firstShots.map((entry) => entry.method))].map((method) => `${method} ${plan.firstShots.filter((entry) => entry.method === method).length}`).join(", ") || "none"}), `
    + `${plan.corrections.length} one-time correction rows (${byKind("nicknameFix")} nickname fixes, ${byKind("corrections")} owner-approved corrections), `
    + `${plan.unprovenCorrections.length} re-posts whose text was not found, ${plan.unverified.length} first shots unverified (incidents).`);
  console.log(`Fix events (${preview.classified.length} saves on ${sources.sessionIds.length} autowriter classes${preview.skippedInFlight.length > 0 ? `, ${preview.skippedInFlight.length} class(es) with a POST in flight skipped` : ""}): `
    + `${[...tally.entries()].toSorted().map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}; counted as fixes: ${preview.classified.filter((event) => event.countsAsFix).length}.`);
  console.log(`API saves no post explains: ${unmatched.length} (${critical.length} critical — after the autowriter went live at ${UNMATCHED_API_CRITICAL_FROM.toISOString()}; ${unmatched.length - critical.length} info — before it).`);
  for (const event of unmatched) {
    const session = sources.sessions.find((row) => row.wiseSessionId === event.wiseSessionId);
    console.log(`  ${event.eventAt.getTime() >= UNMATCHED_API_CRITICAL_FROM.getTime() ? "CRITICAL" : "info    "} ${event.wiseSessionId} at ${event.eventAt.toISOString()} (class ${session?.state ?? "unknown"})`);
  }
  console.log(critical.length === 0 ? "Go/no-go: GO — no critical unexplained API save." : "Go/no-go: NO-GO — explain every critical API save above before --apply and before the review cron runs.");
  console.log("No verdicts are written (interview decision D-01).");

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply to write the plan.");
    return;
  }
  const applied = await applyReviewBackfillPlan(db, plan);
  const reviews = await assignReviews(db, { now });
  const ingested = await ingestFixEvents(db, { apiActorId, since: new Date(now.getTime() - LOOKBACK_MS) });
  const counts = await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
  console.log(`\nApplied: ${applied.firstShots} first shots, ${applied.corrections} corrections, ${applied.incidents} incidents; ${reviews} review rows; `
    + `fix events ${ingested.inserted} new / ${ingested.updated} re-classified; ${counts} review counts updated.`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : error);
  process.exit(1);
});
