import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { wilsonLowerBound } from "../quality";
import { loadAutowriterTrends } from "../trends";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const CALLS = schema.feedbackAutowriterCalls;
const P = schema.feedbackAutowriterPosts;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;
const M = schema.feedbackAutowriterDailyMetrics;

// Roster account ids and tutor keys are the code roster's (the loader filters on them); everything else is synthetic.
const MIMI = "696e2c4343579bbada2340f8";
const MIMI_MAIN = "695369c028118f629edcbaf3";
const EK = "6976680baf7fbc5ac88c3ea9";
// 12:00 in Bangkok on 6 Oct: the 14-day range is 23 Sep – 6 Oct, read from 10 Sep.
const NOW = new Date("2026-10-06T05:00:00Z");
const id24 = (n: number) => `6a${String(n).padStart(22, "0")}`;

type SessionInsert = typeof S.$inferInsert;
type VerdictSeed = Pick<typeof V.$inferInsert, "verdict" | "severity" | "criticalCategory">;
const APPROVE: VerdictSeed = { verdict: "approve" };
const COSMETIC: VerdictSeed = { verdict: "needs_fix", severity: "cosmetic" };
const FACTUAL: VerdictSeed = { verdict: "needs_fix", severity: "factual" };
const CRITICAL: VerdictSeed = { verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person" };

/** An autowriter row for a class that ended at `endAt`, with one call per cost. */
async function seedClass(n: number, options: {
  endAt: string;
  teacher?: string;
  state?: SessionInsert["state"];
  reason?: string;
  arm?: SessionInsert["arm"];
  evidence?: SessionInsert["evidence"];
  /** Minutes from the class end to the POST claim. */
  postedAfter?: number;
  costs?: number[];
}): Promise<string> {
  const endAt = new Date(options.endAt);
  const state = options.state ?? "verified";
  await db.insert(S).values({
    wiseSessionId: id24(n),
    wiseClassId: id24(n + 500),
    wiseTeacherUserId: options.teacher ?? MIMI,
    scheduledEndAt: endAt,
    deadlineAt: calculateFeedbackDeadline(endAt),
    state,
    reason: options.reason ?? state,
    arm: options.arm ?? null,
    evidence: options.evidence ?? "summary",
    postStartedAt: options.postedAfter === undefined ? null : new Date(endAt.getTime() + options.postedAfter * 60_000),
    createdAt: endAt,
  });
  for (const [index, cost] of (options.costs ?? []).entries()) {
    await db.insert(CALLS).values({
      wiseSessionId: id24(n), role: index === 0 ? "writer" : "judge", arm: index === 0 ? "sol" : "glm", requestedModel: "model",
      ok: true, costUsd: cost.toFixed(8), promptVersion: 5,
      // A call is dated by its class, not by when it ran: this one ran a day after the class.
      createdAt: new Date(endAt.getTime() + 24 * 60 * 60_000),
    });
  }
  return id24(n);
}

/** The class's first-shot post and review row, with a current verdict when one is given. */
async function seedReview(wiseSessionId: string, options: {
  date: string;
  tutorKey: string;
  inclusionReason?: typeof R.$inferInsert["inclusionReason"];
  verdict?: VerdictSeed;
}) {
  const [post] = await db.insert(P).values({
    wiseSessionId, kind: "first_shot", fields: {}, fieldsSha256: "h", billing: {}, actorKind: "autowriter",
    actor: "system:feedback-autowriter", outcome: "verified", provenance: "snapshot",
  }).returning({ id: P.id });
  const [verdict] = options.verdict
    ? await db.insert(V).values({ wiseSessionId, postId: post.id, fieldsSha256: "h", reviewer: "owner@example.com", source: "dashboard", ...options.verdict })
      .returning({ id: V.id })
    : [];
  await db.insert(R).values({
    wiseSessionId, firstPostId: post.id, tutorKey: options.tutorKey, bangkokDate: options.date,
    inclusionReason: options.inclusionReason ?? "new_tutor", inclusionProbability: "1.000", sampleDraw: 0.5, samplingPolicy: "v1",
    currentVerdictId: verdict?.id ?? null,
  });
}

/** A stored metric row. Its review counts are left at 0 on purpose: the loader must never read accuracy from it. */
async function seedMetric(date: string, tutorKey: string, posted: number, eligible: number) {
  await db.insert(M).values({ metricDate: date, tutorKey, posted, eligible, policyVersion: 1 });
}

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_daily_metrics, feedback_autowriter_flags, feedback_autowriter_reviews,
    feedback_autowriter_verdicts, feedback_autowriter_posts, feedback_autowriter_sessions, feedback_autowriter_calls
    RESTART IDENTITY CASCADE`);
});

/**
 * 29 Sep: a summary post (Sol), a transcript post (Luna, on the tutor's main account), a class the judge held, and an
 *   in-person class that is nobody's business here. One post approved, the other judged critical.
 * 30 Sep: one transcript post still awaiting its event — a class that ended at 00:30 Bangkok time.
 * 1 Oct: no class at all.
 * 2 Oct: a class held for its recording, and one the tutor wrote first.
 * 10 and 15 Sep: classes before the 14-day range, inside its look-back; 9 Sep: a class before even that.
 */
async function seedFortnight() {
  const approved = await seedClass(1, { endAt: "2026-09-29T08:00:00Z", arm: "sol", postedAfter: 40, costs: [0.04, 0.002, 0.002] });
  const critical = await seedClass(2, { endAt: "2026-09-29T09:00:00Z", teacher: MIMI_MAIN, arm: "luna", evidence: "transcript", postedAfter: 60, costs: [0.05, 0.06] });
  await seedClass(3, { endAt: "2026-09-29T10:00:00Z", teacher: EK, state: "held", reason: "sol:unfaithful:a claim; luna:unfaithful:another", costs: [0.04, 0.05] });
  const inPerson = await seedClass(4, { endAt: "2026-09-29T11:00:00Z", state: "skipped_scope", reason: "session_type_OFFLINE" });
  const awaiting = await seedClass(5, {
    endAt: "2026-09-29T17:30:00Z", teacher: EK, state: "awaiting_event", arm: "sol", evidence: "transcript", postedAfter: 20, costs: [0.03],
  });
  await seedClass(6, { endAt: "2026-10-02T04:00:00Z", state: "held", reason: "recording_too_short", evidence: "transcript", costs: [0.06] });
  await seedClass(7, { endAt: "2026-10-02T05:00:00Z", state: "skipped_human", reason: "human_submission" });
  const midSeptember = await seedClass(8, { endAt: "2026-09-15T08:00:00Z", arm: "sol", postedAfter: 10, costs: [0.02] });
  // The last second of 9 Sep in Bangkok, and the first of 10 Sep.
  const before = await seedClass(9, { endAt: "2026-09-09T16:59:59Z", arm: "sol", postedAfter: 5, costs: [0.5] });
  const firstRead = await seedClass(10, { endAt: "2026-09-09T17:00:00Z", arm: "sol", postedAfter: 30, costs: [0.01] });

  await seedReview(approved, { date: "2026-09-29", tutorKey: "Mimi", verdict: APPROVE });
  await seedReview(critical, { date: "2026-09-29", tutorKey: "Mimi", verdict: CRITICAL });
  // A stray review row on an in-person class never counts.
  await seedReview(inPerson, { date: "2026-09-29", tutorKey: "Mimi", verdict: FACTUAL });
  await seedReview(awaiting, { date: "2026-09-30", tutorKey: "Ek" });
  await seedReview(midSeptember, { date: "2026-09-15", tutorKey: "Mimi", verdict: COSMETIC });
  await seedReview(before, { date: "2026-09-09", tutorKey: "Mimi", verdict: FACTUAL });
  await seedReview(firstRead, { date: "2026-09-10", tutorKey: "Mimi", verdict: APPROVE });

  await seedMetric("2026-09-29", "*", 2, 3);
  await seedMetric("2026-09-29", "Mimi", 2, 2);
  await seedMetric("2026-09-29", "Ek", 0, 1);
  await seedMetric("2026-09-30", "*", 1, 1);
  await seedMetric("2026-09-30", "Ek", 1, 1);
  await seedMetric("2026-10-01", "*", 0, 0);
  await seedMetric("2026-10-02", "*", 0, 0);
  await seedMetric("2026-09-15", "*", 1, 1);
  await seedMetric("2026-09-15", "Mimi", 1, 1);
  await seedMetric("2026-09-10", "*", 1, 1);
  await seedMetric("2026-09-10", "Mimi", 1, 1);
  await seedMetric("2026-09-09", "*", 5, 5);
  await seedMetric("2026-09-09", "Mimi", 5, 5);
}

describe("loadAutowriterTrends", () => {
  it("assembles the all-tutors series from the stored coverage, the reviews' current verdicts, the classes and their calls", async () => {
    await seedFortnight();
    const trends = await loadAutowriterTrends(db, { days: 14, tutorKey: "*", now: NOW });
    const day = (date: string) => trends.days.find((entry) => entry.date === date)!;

    expect(trends).toMatchObject({
      generatedAt: NOW.toISOString(), tutorKey: "*", range: { start: "2026-09-23", end: "2026-10-06", days: 14 }, since: "2026-09-10",
    });
    expect(trends.days).toHaveLength(14);

    // Accuracy is recomputed from the reviews (the stored rows say 0 reviewed); coverage is the stored pair.
    expect(day("2026-09-29")).toEqual({
      date: "2026-09-29",
      reviewed: 2, accurate: 1, critical: 1, accuracy: 1 / 2, accuracy7d: 1 / 2, wilson14d: wilsonLowerBound(1, 2),
      posted: 2, eligible: 3, coverage: 2 / 3, coverage7d: 2 / 3,
      minutesToPost: 50, minutesToPost7d: 50, costUsd: 0.244, costPerClass: 0.122, costPerClass7d: 0.122,
      fromSummary: 1, fromTranscript: 1, transcriptShare7d: 1 / 2, writers: { sol: 1, luna: 1, glm: 0 },
    });
    // The class that ended at 00:30 Bangkok time belongs to 30 Sep; its review has no verdict yet.
    expect(day("2026-09-30")).toEqual({
      date: "2026-09-30",
      reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: 1 / 2, wilson14d: wilsonLowerBound(1, 2),
      posted: 1, eligible: 1, coverage: 1, coverage7d: 3 / 4,
      minutesToPost: 20, minutesToPost7d: 40, costUsd: 0.03, costPerClass: 0.03, costPerClass7d: 0.0913,
      fromSummary: 0, fromTranscript: 1, transcriptShare7d: 2 / 3, writers: { sol: 1, luna: 0, glm: 0 },
    });
    // The gap day: its own values are empty, the rolling ones carry on.
    expect(day("2026-10-01")).toEqual({
      date: "2026-10-01",
      reviewed: 0, accurate: 0, critical: 0, accuracy: null, accuracy7d: 1 / 2, wilson14d: wilsonLowerBound(1, 2),
      posted: 0, eligible: 0, coverage: null, coverage7d: 3 / 4,
      minutesToPost: null, minutesToPost7d: 40, costUsd: 0, costPerClass: null, costPerClass7d: 0.0913,
      fromSummary: 0, fromTranscript: 0, transcriptShare7d: 2 / 3, writers: { sol: 0, luna: 0, glm: 0 },
    });
    // A held class costs money but is not a posted class.
    expect(day("2026-10-02")).toMatchObject({ costUsd: 0.06, costPerClass: null, costPerClass7d: 0.1113, minutesToPost: null, fromTranscript: 0 });
    // The look-back (10 and 15 Sep) reaches the first dates' 14-day bound, and nothing before it does.
    expect(day("2026-09-23")).toMatchObject({ reviewed: 0, accuracy7d: null, wilson14d: wilsonLowerBound(2, 2), coverage7d: null, costPerClass7d: null });
    expect(day("2026-09-24")).toMatchObject({ wilson14d: wilsonLowerBound(1, 1) });

    expect(trends.totals).toEqual({
      reviewed: 2, accurate: 1, critical: 1, posted: 3, eligible: 4,
      medianMinutesToPost: 40, p90MinutesToPost: 60,
      costUsd: 0.334, costPerClass: 0.1113,
      fromSummary: 1, fromTranscript: 2, writers: { sol: 2, luna: 1, glm: 0 },
      holdsByCategory: { data_quality: 1, judge: 1, validation: 0, billing_or_form: 0, error: 0, other: 0 },
    });
  });

  it("reads one tutor's rows across both of their Wise accounts", async () => {
    await seedFortnight();
    const mimi = await loadAutowriterTrends(db, { days: 14, tutorKey: "Mimi", now: NOW });
    expect(mimi.tutorKey).toBe("Mimi");
    expect(mimi.days.find((entry) => entry.date === "2026-09-29")).toMatchObject({
      reviewed: 2, accurate: 1, critical: 1, posted: 2, eligible: 2, coverage: 1, minutesToPost: 50, costUsd: 0.154,
      fromSummary: 1, fromTranscript: 1, writers: { sol: 1, luna: 1, glm: 0 },
    });
    expect(mimi.days.find((entry) => entry.date === "2026-09-30")).toMatchObject({ posted: 0, eligible: 0, coverage: null, coverage7d: 1, costUsd: 0 });
    expect(mimi.totals).toMatchObject({
      reviewed: 2, posted: 2, eligible: 2, costUsd: 0.214, costPerClass: 0.107,
      holdsByCategory: { data_quality: 1, judge: 0, validation: 0, billing_or_form: 0, error: 0, other: 0 },
    });

    const ek = await loadAutowriterTrends(db, { days: 14, tutorKey: "Ek", now: NOW });
    expect(ek.since).toBe("2026-09-29");
    expect(ek.totals).toMatchObject({
      reviewed: 0, accurate: 0, critical: 0, posted: 1, eligible: 2, medianMinutesToPost: 20, costUsd: 0.12, costPerClass: 0.12,
      fromSummary: 0, fromTranscript: 1, holdsByCategory: { data_quality: 0, judge: 1, validation: 0, billing_or_form: 0, error: 0, other: 0 },
    });
  });

  it("widens the range to 30 and 90 days, and is empty for a tutor nobody knows", async () => {
    await seedFortnight();
    const month = await loadAutowriterTrends(db, { days: 30, tutorKey: "*", now: NOW });
    expect(month.range).toEqual({ start: "2026-09-07", end: "2026-10-06", days: 30 });
    expect(month.days).toHaveLength(30);
    // 9, 10 and 15 Sep are now days of the range.
    expect(month.since).toBe("2026-09-09");
    expect(month.totals).toMatchObject({ reviewed: 5, accurate: 3, critical: 1, posted: 10, eligible: 11, fromSummary: 4, fromTranscript: 2 });
    expect(month.days.find((entry) => entry.date === "2026-09-09")).toMatchObject({ reviewed: 1, accurate: 0, minutesToPost: 5, costUsd: 0.5 });

    const quarter = await loadAutowriterTrends(db, { days: 90, tutorKey: "*", now: NOW });
    expect(quarter.days).toHaveLength(90);
    expect(quarter.range.start).toBe("2026-07-09");
    expect(quarter.totals.reviewed).toBe(5);

    const nobody = await loadAutowriterTrends(db, { days: 14, tutorKey: "Nobody", now: NOW });
    expect(nobody).toMatchObject({ tutorKey: "Nobody", since: null });
    expect(nobody.totals).toMatchObject({ reviewed: 0, posted: 0, eligible: 0, costUsd: 0, medianMinutesToPost: null });
  });
});
