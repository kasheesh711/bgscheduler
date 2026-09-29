/**
 * Day-one backfill of the autowriter review tables (operating loop Phase 1, migration 0099).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts           (dry run)
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts --apply   (write)
 *
 * Reads our database only and NEVER writes to Wise (no Wise client is imported). For every settled posted class
 * without a first-shot record it reconstructs the first shot and accepts only a candidate whose rebuilt POST body
 * hashes to the row's `body_hash` (method and proof recorded); a class with no proven candidate gets an info
 * incident (`first_shot_unverified`) for the owner. The one-time nickname re-posts of 29 Sep are recorded as
 * correction posts (`script:nickname-fix (kevhsh7@gmail.com)`). No verdicts are written — those are the owner's.
 * With --apply it then gives each posted class its review row and derives its fix events, as the hourly job
 * would. Apply it after migration 0099 and before the review cron first runs, so the nickname re-posts are
 * matched to their correction rows instead of being reported as unmatched API writes.
 *
 * Output is metadata only: no feedback text, no student names.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { planReviewBackfill, readNicknameFix, NICKNAME_FIX_ACTOR } from "@/lib/feedback-autowriter/backfill";
import { wiseApiActorId } from "@/lib/feedback-autowriter/config";
import { classifySessionFixEvents } from "@/lib/feedback-autowriter/fix-events";
import { recordIncident } from "@/lib/feedback-autowriter/incidents";
import { assignReviews, listUnrecordedPostedRows, refreshReviewCounts, tutorKeyFor } from "@/lib/feedback-autowriter/review-job";
import { ingestFixEvents } from "@/lib/feedback-autowriter/fix-events";
import { toFeedbackEventEvidence } from "@/lib/post-class-feedback/events";
import { loadPayoutScriptEnvironment } from "./lib/payout-script";

loadPayoutScriptEnvironment();

const APPLY = process.argv.includes("--apply");
const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const PC = schema.postClassSessions;
const PCV = schema.postClassFeedbackVersions;
const E = schema.wiseActivityEvents;

function isMissingRelation(error: unknown): boolean {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === "42P01" || candidate?.cause?.code === "42P01";
}

async function main() {
  const db = getDb();
  const settled = await db.select().from(S).where(inArray(S.state, ["verified", "rejected", "unknown_outcome", "verify_failed"]));
  const posted = settled.filter((row) => row.postStartedAt !== null).toSorted((a, b) => a.postStartedAt!.getTime() - b.postStartedAt!.getTime());
  const ids = posted.map((row) => row.wiseSessionId);
  // A dry run may precede migration 0099: without the review tables nothing is recorded yet.
  const tablesExist = await db.select({ id: P.id }).from(P).limit(1).then(() => true, (error: unknown) => {
    if (APPLY || !isMissingRelation(error)) throw error;
    return false;
  });
  if (!tablesExist) console.log("(migration 0099 is not applied here: planning as if no review rows exist)");
  const unrecorded = new Set(tablesExist ? (await listUnrecordedPostedRows(db)).map((row) => row.wiseSessionId) : ids);
  const existingPosts = tablesExist && ids.length > 0
    ? await db.select({ wiseSessionId: P.wiseSessionId, kind: P.kind, actor: P.actor }).from(P).where(inArray(P.wiseSessionId, ids))
    : [];
  const versions = ids.length > 0 ? await db.select({
    wiseSessionId: PC.wiseSessionId, id: PCV.id, observedAt: PCV.observedAt, substantive: PCV.substantive,
    topics: PCV.topics, performance: PCV.performance, improvement: PCV.improvement, homework: PCV.homework,
  }).from(PCV).innerJoin(PC, eq(PC.id, PCV.sessionId))
    .where(and(inArray(PC.wiseSessionId, ids), eq(PCV.profile, "teacher"), eq(PCV.substantive, true)))
    .orderBy(asc(PCV.observedAt)) : [];

  const plan = planReviewBackfill(posted.map((row) => {
    const first = versions.find((version) => version.wiseSessionId === row.wiseSessionId);
    return {
      row,
      pcFirstVersion: first ? {
        id: first.id,
        observedAt: first.observedAt,
        fields: { topics: first.topics, performance: first.performance, improvement: first.improvement, homework: first.homework },
      } : null,
      hasFirstShot: !unrecorded.has(row.wiseSessionId),
      hasNicknameCorrection: existingPosts.some((post) => post.wiseSessionId === row.wiseSessionId && post.kind === "correction" && post.actor === NICKNAME_FIX_ACTOR),
    };
  }));

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${posted.length} posted classes (settled), ${plan.alreadyRecorded.length} already have a first-shot record`);
  for (const row of posted) {
    const shot = plan.firstShots.find((entry) => entry.wiseSessionId === row.wiseSessionId);
    const missing = plan.unverified.find((entry) => entry.wiseSessionId === row.wiseSessionId);
    const correction = plan.corrections.some((entry) => entry.wiseSessionId === row.wiseSessionId);
    const fix = readNicknameFix(row.metadata);
    console.log([
      `  ${row.wiseSessionId}`,
      tutorKeyFor(row.wiseTeacherUserId).padEnd(6),
      row.state,
      shot ? `first shot PROVEN (${shot.method}, form order ${shot.fieldOrder.join(">")})`
        : missing ? `first shot NOT proven (${missing.reason}; ${missing.candidates} candidates)` : "first shot already recorded",
      fix ? `nickname fix at ${fix.at.toISOString()}${correction ? " → correction row planned" : " (correction already recorded)"}` : "no nickname fix",
    ].join(" | "));
  }

  // What the fix-event classification will say once these posts exist (Wise activity events already mirrored).
  const events = ids.length > 0 ? await db.select().from(E).where(and(eq(E.eventName, "SessionFeedbackSubmittedEvent"), inArray(E.sessionId, ids))) : [];
  const tally = new Map<string, number>();
  let fixes = 0;
  for (const row of posted) {
    const shot = plan.firstShots.find((entry) => entry.wiseSessionId === row.wiseSessionId)?.values;
    const corrections = plan.corrections.filter((entry) => entry.wiseSessionId === row.wiseSessionId).map((entry) => entry.values);
    const posts = [...(shot ? [shot] : []), ...corrections].map((values, index) => ({
      id: `${row.wiseSessionId}:${index}`,
      kind: values.kind,
      postStartedAt: values.postStartedAt ?? null,
      postFinishedAt: values.postFinishedAt ?? null,
      eventAt: (() => {
        const at = (values.verification as { event?: { at?: unknown } } | undefined)?.event?.at;
        return typeof at === "string" ? new Date(at) : null;
      })(),
    }));
    const sessionEvents = events.filter((event) => event.sessionId === row.wiseSessionId).map((event) => ({
      wiseEventId: event.eventId,
      activityRowId: event.id,
      wiseSessionId: row.wiseSessionId,
      eventAt: event.eventTimestamp,
      actorWiseUserId: event.actorWiseUserId,
      actorRole: event.actorRole,
      autoSubmitted: toFeedbackEventEvidence(row.wiseSessionId, {
        rowId: event.id, eventId: event.eventId, eventTimestamp: event.eventTimestamp, actorWiseUserId: event.actorWiseUserId,
        actorName: event.actorName, actorRole: event.actorRole, payload: event.payload,
      }).autoSubmitted ?? null,
    }));
    for (const event of classifySessionFixEvents(sessionEvents, { posts, apiActorId: wiseApiActorId() })) {
      tally.set(event.actorKind, (tally.get(event.actorKind) ?? 0) + 1);
      if (event.countsAsFix) fixes += 1;
    }
  }
  console.log(`\nPlan: ${plan.firstShots.length} first shots to record (${[...new Set(plan.firstShots.map((entry) => entry.method))].map((method) => `${method} ${plan.firstShots.filter((entry) => entry.method === method).length}`).join(", ") || "none"}), ${plan.corrections.length} nickname correction rows, ${plan.unverified.length} unverified (info incidents).`);
  console.log(`Fix events once recorded: ${[...tally.entries()].map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}; counted as fixes: ${fixes}.`);
  console.log("No verdicts are written (interview decision D-01).");

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply to write the plan.");
    return;
  }
  await withDatabaseTransaction(db, async (tx) => {
    for (const entry of plan.firstShots) await tx.insert(P).values(entry.values).onConflictDoNothing();
    for (const entry of plan.corrections) await tx.insert(P).values(entry.values);
    for (const entry of plan.unverified) {
      await recordIncident(tx, {
        dedupeKey: `first_shot_unverified:${entry.wiseSessionId}`,
        kind: "first_shot_unverified",
        severity: "info",
        wiseSessionId: entry.wiseSessionId,
        summary: "The day-one backfill could not prove this class's first shot against its body_hash: please confirm what was posted.",
        detail: { reason: entry.reason, candidates: entry.candidates },
      });
    }
  });
  const now = new Date();
  const reviews = await assignReviews(db, { now });
  const ingested = await ingestFixEvents(db, { apiActorId: wiseApiActorId(), since: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000) });
  const counts = await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
  console.log(`\nApplied: ${plan.firstShots.length} first shots, ${plan.corrections.length} corrections, ${plan.unverified.length} incidents; ${reviews} review rows; fix events ${ingested.inserted} new / ${ingested.updated} re-classified; ${counts} review counts updated.`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : error);
  process.exit(1);
});
