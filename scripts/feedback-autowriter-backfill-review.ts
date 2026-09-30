/**
 * Day-one backfill of the autowriter review tables (operating loop Phase 1, migration 0101).
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts           (dry run)
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/feedback-autowriter-backfill-review.ts --apply   (write)
 *
 * Reads our database only and NEVER writes to Wise (no Wise client is imported). For every settled posted class
 * without a first-shot record it reconstructs the first shot and accepts only a candidate whose rebuilt POST body
 * hashes to the row's `body_hash` (method and proof recorded); a class with no proven candidate gets an incident for
 * the owner. Every one-time re-post the row records becomes a post with its own `dedupe_key`, so a re-run (or two
 * overlapping runs) records it once: the 29 Sep nickname fixes (`metadata.nicknameFix`) as `policy` posts — a naming
 * rule made after the post, never a fix (owner decision D-01) — and the owner-approved corrections
 * (`metadata.corrections`) as `correction` posts, which are fixes. The verdicts the owner gave outside the dashboard
 * (`scripts/feedback-autowriter-owner-verdicts.json`, the 30 Sep interview) are shown by the dry run and recorded by
 * --apply through the dashboard's own path, pinned to each class's first shot. With --apply it also gives each posted
 * class its review row and derives its fix events, as the hourly job would.
 *
 * The dry run also previews the fix-event classification and the daily coverage of the gate window with the job's own
 * code over the same classes (every autowriter class in the 45-day look-back), so it says exactly what the job will
 * store and raise. Go/no-go before
 * --apply and before the review cron first runs: "API saves no post explains" must list no critical one (after
 * the autowriter's go-live); each info one must be a known pre-launch save. Deploy order does not change this:
 * the job explains the one-time re-posts from the row itself until the backfill records them.
 *
 * Output is metadata only: no feedback text, no student names, no correction reasons.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  applyOwnerVerdicts,
  applyReviewBackfillPlan,
  parseOwnerVerdicts,
  planOwnerVerdicts,
  planReviewBackfill,
  type CurrentVerdictFacts,
  type StoredVersion,
} from "@/lib/feedback-autowriter/backfill";
import { wiseApiActorId } from "@/lib/feedback-autowriter/config";
import { isMissingRelationError } from "@/lib/feedback-autowriter/db-errors";
import { readOneTimeCorrections } from "@/lib/feedback-autowriter/first-shot";
import { UNMATCHED_API_CRITICAL_FROM, ingestFixEvents, loadFixEventSources, planFixEvents } from "@/lib/feedback-autowriter/fix-events";
import { GATE_WINDOW_DAYS, addDays, bangkokDateKey, dailyGateDate, floorPercent, gateWindow } from "@/lib/feedback-autowriter/quality";
import { assignReviews, listUnrecordedPostedRows, previewDailyMetrics, refreshReviewCounts, tutorKeyFor } from "@/lib/feedback-autowriter/review-job";
import { SEVERITY_LABELS } from "@/lib/feedback-autowriter/verdicts";
import ownerVerdictsJson from "./feedback-autowriter-owner-verdicts.json";
import { loadPayoutScriptEnvironment } from "./lib/payout-script";

loadPayoutScriptEnvironment();

const APPLY = process.argv.includes("--apply");
const LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const PC = schema.postClassSessions;
const PCV = schema.postClassFeedbackVersions;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;

async function main() {
  const apiActorId = wiseApiActorId();
  if (!apiActorId) throw new Error("WISE_USER_ID is not set: our API saves cannot be told apart from anyone else's.");
  const ownerVerdicts = parseOwnerVerdicts(ownerVerdictsJson);
  const db = getDb();
  const settled = await db.select().from(S).where(inArray(S.state, ["verified", "rejected", "unknown_outcome", "verify_failed"]));
  const posted = settled.filter((row) => row.postStartedAt !== null).toSorted((a, b) => a.postStartedAt!.getTime() - b.postStartedAt!.getTime());
  const ids = posted.map((row) => row.wiseSessionId);
  // A dry run may precede migration 0101: without the review tables nothing is recorded yet.
  const tablesExist = await db.select({ id: P.id }).from(P).limit(1).then(() => true, (error: unknown) => {
    if (APPLY || !isMissingRelationError(error)) throw error;
    return false;
  });
  if (!tablesExist) console.log("(migration 0101 is not applied here: planning as if no review rows exist)");
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
        post.wiseSessionId === row.wiseSessionId && post.kind !== "first_shot" && post.dedupeKey ? [post.dedupeKey] : [])),
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
        const state = planned.some((entry) => entry.dedupeKey === correction.dedupeKey) ? `${correction.kind} row planned`
          : unproven.some((entry) => entry.dedupeKey === correction.dedupeKey) ? "TEXT NOT FOUND — not recorded" : "already recorded";
        return `${correction.kind === "policy" ? "nickname fix (policy)" : "correction (fix)"} at ${correction.at.toISOString()} → ${state}`;
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
  const byKind = (kind: "policy" | "correction") => plan.corrections.filter((entry) => entry.kind === kind).length;

  console.log(`\nPlan: ${plan.firstShots.length} first shots to record (${[...new Set(plan.firstShots.map((entry) => entry.method))].map((method) => `${method} ${plan.firstShots.filter((entry) => entry.method === method).length}`).join(", ") || "none"}), `
    + `${plan.corrections.length} one-time re-post rows (${byKind("policy")} nickname fixes as policy posts, ${byKind("correction")} owner-approved corrections), `
    + `${plan.unprovenCorrections.length} re-posts whose text was not found, ${plan.unverified.length} first shots unverified (incidents).`);
  console.log(`Fix events (${preview.classified.length} saves on ${sources.sessionIds.length} autowriter classes${preview.skippedInFlight.length > 0 ? `, ${preview.skippedInFlight.length} class(es) with a POST in flight skipped` : ""}): `
    + `${[...tally.entries()].toSorted().map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}; counted as fixes: ${preview.classified.filter((event) => event.countsAsFix).length}.`);
  console.log(`API saves no post explains: ${unmatched.length} (${critical.length} critical — after the autowriter went live at ${UNMATCHED_API_CRITICAL_FROM.toISOString()}; ${unmatched.length - critical.length} info — before it).`);
  for (const event of unmatched) {
    const session = sources.sessions.find((row) => row.wiseSessionId === event.wiseSessionId);
    console.log(`  ${event.eventAt.getTime() >= UNMATCHED_API_CRITICAL_FROM.getTime() ? "CRITICAL" : "info    "} ${event.wiseSessionId} at ${event.eventAt.toISOString()} (class ${session?.state ?? "unknown"})`);
  }
  console.log(critical.length === 0 ? "Go/no-go: GO — no critical unexplained API save." : "Go/no-go: NO-GO — explain every critical API save above before --apply and before the review cron runs.");

  // The daily coverage the job's first run would store (its own code; nothing is written).
  const metrics = (await previewDailyMetrics(db, { now, reviewTables: tablesExist, classifiedFixEvents: preview.classified }))
    .filter((row) => row.tutorKey === "*");
  const count = (value: number | undefined) => value ?? 0;
  console.log("\nCoverage per day (all tutors, Bangkok dates; posted / eligible):");
  for (const row of metrics) {
    const eligible = count(row.eligible);
    const postedCount = count(row.posted);
    console.log(`  ${row.metricDate}  ${`${postedCount}/${eligible}`.padStart(6)} ${(eligible > 0 ? floorPercent(postedCount / eligible) : "—").padStart(6)}`
      + ` | misses: held ${count(row.held)}, late ${count(row.late)}, expired ${count(row.expired)}, failed ${count(row.failed)}, unseen ${count(row.unseen)}`
      + ` | left out: tutor first ${count(row.excludedTutorFirst)}, data quality ${count(row.excludedDataQuality)}, tutor off ${count(row.excludedTutorOff)},`
      + ` not live ${count(row.excludedNotLive)}, scope ${count(row.excludedScope)} | in progress ${count(row.pending)}`);
  }
  const gateDates = gateWindow(dailyGateDate(now));
  const inWindow = metrics.filter((row) => row.metricDate >= gateDates.start && row.metricDate <= gateDates.end);
  const num = inWindow.reduce((sum, row) => sum + count(row.posted), 0);
  const den = inWindow.reduce((sum, row) => sum + count(row.eligible), 0);
  console.log(`Gate window ${gateDates.start} → ${gateDates.end}: coverage ${num}/${den}${den > 0 ? ` = ${floorPercent(num / den)}` : ""} (floor 70%).`);

  // The owner's verdicts given outside the dashboard, pinned to each class's first shot (recorded, or planned above).
  const firstShotSha = new Map<string, string>(plan.firstShots.map((entry) => [entry.wiseSessionId, entry.values.fieldsSha256]));
  const currentVerdicts = new Map<string, CurrentVerdictFacts>();
  if (tablesExist) {
    const decided = ownerVerdicts.verdicts.map((decision) => decision.wiseSessionId);
    for (const post of await db.select({ wiseSessionId: P.wiseSessionId, fieldsSha256: P.fieldsSha256 }).from(P)
      .where(and(inArray(P.wiseSessionId, decided), eq(P.kind, "first_shot")))) firstShotSha.set(post.wiseSessionId, post.fieldsSha256);
    for (const row of await db.select({
      wiseSessionId: R.wiseSessionId, reviewer: V.reviewer, verdict: V.verdict, severity: V.severity, criticalCategory: V.criticalCategory,
      note: V.note, fieldsSha256: V.fieldsSha256,
    }).from(R).innerJoin(V, eq(V.id, R.currentVerdictId)).where(inArray(R.wiseSessionId, decided))) currentVerdicts.set(row.wiseSessionId, row);
  }
  const verdictPlan = planOwnerVerdicts(ownerVerdicts, { firstShots: firstShotSha, currentVerdicts });
  console.log(`\nOwner verdicts (scripts/feedback-autowriter-owner-verdicts.json; decided ${ownerVerdicts.decidedAt.toISOString()}; reviewer "${ownerVerdicts.reviewer}"):`);
  for (const entry of verdictPlan) {
    const row = posted.find((candidate) => candidate.wiseSessionId === entry.wiseSessionId);
    const classDate = row?.scheduledEndAt ? bangkokDateKey(row.scheduledEndAt) : null;
    const saves = preview.classified.filter((event) => event.wiseSessionId === entry.wiseSessionId).map((event) => event.actorKind);
    console.log([
      `  ${entry.wiseSessionId}`,
      classDate ? `class ${classDate}` : "class date unknown",
      entry.verdict === "approve" ? "Approve" : `Needs fix · ${SEVERITY_LABELS[entry.severity!]}${entry.criticalCategory ? ` (${entry.criticalCategory})` : ""}`,
      entry.fieldsSha256 ? `pinned to first shot ${entry.fieldsSha256.slice(0, 12)}…` : "NO FIRST SHOT — not recordable",
      { planned: "verdict row planned", already_recorded: "already recorded", other_verdict: "NOT recorded: the class has another verdict", no_first_shot: "NOT recorded" }[entry.status],
      `saves in Wise: ${saves.join(", ") || "none mirrored"}`,
    ].join(" | "));
    if (entry.severity === "critical" && classDate && entry.status !== "no_first_shot") {
      console.log(`    → a critical verdict on ${classDate}: the gate is blocked_critical for every gate date through ${addDays(classDate, GATE_WINDOW_DAYS - 1)}; `
        + `the first gate date whose ${GATE_WINDOW_DAYS}-day window leaves it out is ${addDays(classDate, GATE_WINDOW_DAYS)}.`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply to write the plan.");
    return;
  }
  const applied = await applyReviewBackfillPlan(db, plan);
  const reviews = await assignReviews(db, { now });
  const verdicts = await applyOwnerVerdicts(db, ownerVerdicts);
  const ingested = await ingestFixEvents(db, { apiActorId, since: new Date(now.getTime() - LOOKBACK_MS) });
  const counts = await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
  console.log(`\nApplied: ${applied.firstShots} first shots, ${applied.corrections} one-time re-posts, ${applied.incidents} incidents; ${reviews} review rows; `
    + `owner verdicts ${verdicts.recorded.length} recorded / ${verdicts.alreadyRecorded.length} already recorded; `
    + `fix events ${ingested.inserted} new / ${ingested.updated} re-classified; ${counts} review counts updated.`);
  for (const skipped of verdicts.skipped) console.log(`  owner verdict NOT recorded for ${skipped.wiseSessionId}: ${skipped.reason}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : error);
  process.exit(1);
});
