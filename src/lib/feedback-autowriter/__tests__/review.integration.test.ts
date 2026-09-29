import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { ingestFixEvents } from "../fix-events";
import { MAX_PUSH_ATTEMPTS, drainIncidentOutbox, recordIncident } from "../incidents";
import {
  assignReviews,
  raiseFixFlags,
  recordDailyGate,
  refreshDailyMetrics,
  refreshReviewCounts,
  runReviewJob,
  snapshotFirstShots,
  type ReviewJobDeps,
} from "../review-job";
import { buildFeedbackPostBody } from "../session";
import { feedbackBodyHash, fieldsHash } from "../submit";
import { recordVerdict } from "../verdicts";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const FX = schema.feedbackAutowriterFixEvents;
const I = schema.feedbackAutowriterIncidents;
const G = schema.feedbackAutowriterGateEvaluations;
const M = schema.feedbackAutowriterDailyMetrics;
const RUNS = schema.feedbackAutowriterReviewRuns;

const API = "69366668c05630afe5d8a2a4";
const MIMI = "696e2c4343579bbada2340f8";
const NOW = new Date("2026-09-30T03:00:00Z");
const DAY = "2026-09-29";
const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 };
const FIELDS: FeedbackFieldAnswers = {
  topics: "Rotation and symmetry in 11+ Non-Verbal Reasoning.",
  performance: "Pasorn spotted reflections quickly.",
  improvement: "Colour sequences under time pressure.",
  homework: "",
};

const id24 = (n: number) => `6a${String(n).padStart(22, "0")}`;

async function expectSqlState(work: Promise<unknown>, code: string) {
  let caught: unknown = null;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  const candidate = caught as { code?: unknown; cause?: { code?: unknown } } | null;
  expect(candidate?.code ?? candidate?.cause?.code).toBe(code);
}

/** A settled posted row whose body_hash pins `posted` in the given form order. */
async function seedPosted(n: number, options: {
  posted?: FeedbackFieldAnswers;
  stored?: FeedbackFieldAnswers;
  state?: typeof S.$inferInsert["state"];
  order?: Array<keyof FeedbackFieldAnswers>;
  endAt?: Date;
  metadata?: Record<string, unknown>;
} = {}) {
  const posted = options.posted ?? FIELDS;
  const stored = options.stored ?? posted;
  const order = options.order ?? ["improvement", "topics", "performance", "homework"];
  const endAt = options.endAt ?? new Date("2026-09-29T08:00:00Z");
  const postStartedAt = new Date(endAt.getTime() + 40 * 60_000);
  await db.insert(S).values({
    wiseSessionId: id24(n),
    wiseClassId: id24(n + 500),
    wiseTeacherUserId: MIMI,
    scheduledEndAt: endAt,
    deadlineAt: new Date(endAt.getTime() + 36 * 60 * 60_000),
    state: options.state ?? "verified",
    reason: options.state ?? "verified",
    arm: "glm",
    fields: stored,
    fieldsSha256: fieldsHash(stored),
    billing: BILLING,
    bodyHash: feedbackBodyHash(buildFeedbackPostBody({ fieldOrder: order }, posted, BILLING)),
    postStartedAt,
    verifiedEvent: { at: new Date(postStartedAt.getTime() + 90).toISOString(), actorId: API, autoSubmitted: false },
    metadata: { pipeline: { promptVersion: 7, arm: "glm" }, postedFromCommit: "abc1234", expected: { kind: "auto_blank", submissionId: "sub" }, ...(options.metadata ?? {}) },
  });
  return { wiseSessionId: id24(n), postStartedAt, verifiedAt: new Date(postStartedAt.getTime() + 90) };
}

async function seedEvent(sessionId: string, at: Date, actor: { id: string | null; role: string | null }, autoSubmitted: boolean | null = null) {
  const eventId = `evt-${sessionId.slice(-4)}-${at.getTime()}`;
  await db.insert(schema.wiseActivityEvents).values({
    eventId,
    eventName: "SessionFeedbackSubmittedEvent",
    eventTimestamp: at,
    actorWiseUserId: actor.id,
    actorRole: actor.role,
    sessionId,
    payload: { session: { id: sessionId, ...(autoSubmitted === null ? {} : { autoSubmitted }) } },
  });
  return eventId;
}

function channels(overrides: Partial<ReviewJobDeps["channels"]> = {}): ReviewJobDeps["channels"] {
  return { emailRecipients: ["owner@example.com"], lineTo: null, emailSender: { sendEmail: vi.fn(async () => ({ id: "m" })) }, ...overrides };
}

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_review_runs, feedback_autowriter_gate_evaluations,
    feedback_autowriter_daily_metrics, feedback_autowriter_incidents, feedback_autowriter_fix_events,
    feedback_autowriter_flags, feedback_autowriter_reviews, feedback_autowriter_verdicts, feedback_autowriter_posts,
    feedback_autowriter_sessions, wise_activity_events, post_class_sessions, past_session_blocks RESTART IDENTITY CASCADE`);
});

describe("migration 0099 guards (SQLSTATE 55000)", () => {
  it("keeps a post's content immutable, a settled outcome final and every row undeletable", async () => {
    await seedPosted(1);
    await snapshotFirstShots(db);
    const [post] = await db.select().from(P);
    await expectSqlState(db.update(P).set({ fields: { ...FIELDS, topics: "rewritten" } }).where(eq(P.id, post.id)), "55000");
    await expectSqlState(db.update(P).set({ outcome: "verify_failed" }).where(eq(P.id, post.id)), "55000");
    await expectSqlState(db.delete(P).where(eq(P.id, post.id)), "55000");

    // An unsettled post (a later correction in flight) may still settle.
    const [inflight] = await db.insert(P).values({
      wiseSessionId: post.wiseSessionId, kind: "correction", fields: FIELDS, fieldsSha256: fieldsHash(FIELDS), billing: BILLING,
      actorKind: "owner", actor: "kevhsh7@gmail.com", reason: "test", outcome: "posting", provenance: "live",
    }).returning({ id: P.id });
    await db.update(P).set({ outcome: "verified", settledAt: new Date() }).where(eq(P.id, inflight.id));
    await expectSqlState(db.update(P).set({ outcome: "rejected" }).where(eq(P.id, inflight.id)), "55000");
    // Only one first shot per class.
    await expectSqlState(db.insert(P).values({ ...post, id: undefined }), "23505");
  });

  it("keeps verdicts append-only, review inclusion set once, and gate evaluations append-only", async () => {
    const seeded = await seedPosted(2);
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW, draw: () => 0.25 });
    const [firstShot] = await db.select().from(P);
    await recordVerdict(db, {
      wiseSessionId: seeded.wiseSessionId, fieldsSha256: firstShot.fieldsSha256, verdict: "approve", severity: null,
      criticalCategory: null, note: null, reviewer: "kevhsh7@gmail.com", source: "dashboard",
    });
    const [verdict] = await db.select().from(V);
    await expectSqlState(db.update(V).set({ note: "changed my mind" }).where(eq(V.id, verdict.id)), "55000");
    await expectSqlState(db.delete(V).where(eq(V.id, verdict.id)), "55000");

    await expectSqlState(db.update(R).set({ inclusionReason: "not_sampled" }).where(eq(R.wiseSessionId, seeded.wiseSessionId)), "55000");
    await expectSqlState(db.update(R).set({ sampleDraw: 0.9 }).where(eq(R.wiseSessionId, seeded.wiseSessionId)), "55000");
    await expectSqlState(db.delete(R).where(eq(R.wiseSessionId, seeded.wiseSessionId)), "55000");
    // The current view itself stays updatable.
    await db.update(R).set({ measuredFixCount: 3 }).where(eq(R.wiseSessionId, seeded.wiseSessionId));

    await refreshDailyMetrics(db, { dates: [DAY], now: NOW, liveNow: true });
    await recordDailyGate(db, DAY);
    const [evaluation] = await db.select().from(G);
    await expectSqlState(db.update(G).set({ status: "pass" }).where(eq(G.id, evaluation.id)), "55000");
    await expectSqlState(db.delete(G).where(eq(G.id, evaluation.id)), "55000");
  });

  it("rejects verdicts whose severity and category disagree (CHECK 23514)", async () => {
    const seeded = await seedPosted(3);
    await snapshotFirstShots(db);
    const [post] = await db.select().from(P);
    const base = { wiseSessionId: seeded.wiseSessionId, postId: post.id, fieldsSha256: post.fieldsSha256, reviewer: "k", source: "dashboard" as const };
    await expectSqlState(db.insert(V).values({ ...base, verdict: "approve", severity: "cosmetic" }), "23514");
    await expectSqlState(db.insert(V).values({ ...base, verdict: "needs_fix", severity: "critical" }), "23514");
    await expectSqlState(db.insert(V).values({ ...base, verdict: "approve", criticalCategory: "wrong_person" }), "23514");
  });
});

describe("first-shot snapshots", () => {
  it("records only first shots proven against body_hash, in the form order that proves them", async () => {
    const proven = await seedPosted(10, { order: ["performance", "improvement", "topics", "homework"] });
    const edited = await seedPosted(11, { stored: { ...FIELDS, performance: "Tann spotted reflections quickly." } });
    await seedPosted(12, { state: "awaiting_event" });

    const first = await snapshotFirstShots(db);
    expect(first).toEqual({ recorded: 1, unverified: [edited.wiseSessionId] });
    const [post] = await db.select().from(P);
    expect(post).toMatchObject({
      wiseSessionId: proven.wiseSessionId, kind: "first_shot", provenance: "snapshot", outcome: "verified", fields: FIELDS,
      fieldsSha256: fieldsHash(FIELDS), pipeline: { promptVersion: 7, arm: "glm", postedFromCommit: "abc1234" },
      reconstruction: { method: "unchanged", fieldOrder: ["performance", "improvement", "topics", "homework"] },
    });
    const incidents = await db.select().from(I);
    expect(incidents).toMatchObject([{ kind: "first_shot_unverified", severity: "info", pushStatus: "not_required", wiseSessionId: edited.wiseSessionId }]);

    expect(await snapshotFirstShots(db)).toEqual({ recorded: 0, unverified: [edited.wiseSessionId] });
    expect(await db.select().from(I)).toHaveLength(1);
  });
});

describe("fix events", () => {
  it("are derived idempotently and re-classified when a correction later explains an API save", async () => {
    const seeded = await seedPosted(20);
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    const later = (minutes: number) => new Date(seeded.postStartedAt.getTime() + minutes * 60_000);
    await seedEvent(seeded.wiseSessionId, new Date(seeded.postStartedAt.getTime() - 30 * 60_000), { id: null, role: null }, true);
    await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
    await seedEvent(seeded.wiseSessionId, later(1), { id: "696e29c543579bbada1f6283", role: "STUDENT" });
    await seedEvent(seeded.wiseSessionId, later(60), { id: MIMI, role: "TEACHER" });
    const apiEvent = await seedEvent(seeded.wiseSessionId, later(120), { id: API, role: "OWNER" });

    const since = new Date("2026-09-01T00:00:00Z");
    const first = await ingestFixEvents(db, { apiActorId: API, since });
    expect(first).toMatchObject({ sessions: 1, inserted: 5, updated: 0 });
    const kinds = async () => (await db.select().from(FX).orderBy(FX.eventAt)).map((row) => [row.actorKind, row.countsAsFix]);
    expect(await kinds()).toEqual([
      ["auto", false], ["autowriter_first", false], ["student", false], ["tutor", true], ["api_actor_unmatched", true],
    ]);
    expect(await ingestFixEvents(db, { apiActorId: API, since })).toMatchObject({ inserted: 0, updated: 0 });

    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 2, incidents: 1 });
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 0, incidents: 0 });
    const [review] = await db.select().from(R);
    expect(review.flagSources).toEqual(["api_unmatched", "measured_fix"]);
    expect(review.flaggedAt).not.toBeNull();
    expect(await db.select().from(I).where(eq(I.kind, "api_actor_unmatched"))).toMatchObject([{ severity: "critical", pushStatus: "pending" }]);

    // The API save turns out to be a recorded correction (e.g. the day-one backfill ran late).
    await db.insert(P).values({
      wiseSessionId: seeded.wiseSessionId, kind: "correction", fields: FIELDS, fieldsSha256: fieldsHash(FIELDS), billing: BILLING,
      actorKind: "script", actor: "script:test", reason: "test", postFinishedAt: new Date(later(120).getTime() + 4_000),
      outcome: "verified", provenance: "backfill",
    });
    expect(await ingestFixEvents(db, { apiActorId: API, since })).toMatchObject({ inserted: 0, updated: 1 });
    const [reclassified] = await db.select().from(FX).where(eq(FX.wiseEventId, apiEvent));
    expect(reclassified).toMatchObject({ actorKind: "autowriter_correction", countsAsFix: true });

    await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
    expect((await db.select().from(R))[0]).toMatchObject({ measuredFixCount: 2, correctionsVerified: 1 });
  });
});

describe("review inclusion", () => {
  it("gives every verified first shot one review row, drawn once, at 100% for new tutors", async () => {
    await seedPosted(30);
    await seedPosted(31, { state: "verify_failed" });
    await snapshotFirstShots(db);
    const draws = [0.8123];
    expect(await assignReviews(db, { now: NOW, draw: () => draws.shift() ?? 0 })).toBe(1);
    expect(await assignReviews(db, { now: NOW, draw: () => 0.1 })).toBe(0);
    expect(await db.select().from(R)).toMatchObject([{
      tutorKey: "Mimi", bangkokDate: DAY, inclusionReason: "new_tutor", inclusionProbability: "1.000", sampleDraw: 0.8123,
    }]);
  });
});

describe("daily metrics and the gate", () => {
  it("counts coverage (including a proven unseen class) and writes one daily gate row per date", async () => {
    await seedPosted(40);
    await seedPosted(41, { state: "held" });
    await db.insert(S).values({ wiseSessionId: id24(42), wiseTeacherUserId: MIMI, scheduledEndAt: new Date("2026-09-29T09:00:00Z"), state: "skipped_human", reason: "human_submission" });
    await db.insert(S).values({ wiseSessionId: id24(43), wiseTeacherUserId: MIMI, scheduledEndAt: new Date("2026-09-29T10:00:00Z"), state: "skipped_scope", reason: "session_type_OFFLINE" });
    // A roster class the autowriter never saw, proven online one-to-one by the past-session mirror.
    await db.insert(schema.postClassSessions).values({
      wiseSessionId: id24(44), wiseClassId: id24(544), wiseTeacherUserId: MIMI, scheduledStartAt: new Date("2026-09-29T10:00:00Z"),
      scheduledEndAt: new Date("2026-09-29T11:00:00Z"), deadlineAt: new Date("2026-09-30T16:59:59Z"), finalStatus: "ENDED",
    });
    await db.insert(schema.pastSessionBlocks).values({
      groupCanonicalKey: "Mimi", wiseTeacherId: MIMI, wiseSessionId: id24(44), startTime: new Date("2026-09-29T17:00:00Z"),
      endTime: new Date("2026-09-29T18:00:00Z"), weekday: 2, startMinute: 1020, endMinute: 1080, wiseStatus: "FUTURE",
      sessionType: "SCHEDULED", classType: "ONE_TO_ONE", title: "Live Session - NVR",
    });
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });

    expect(await refreshDailyMetrics(db, { dates: [DAY], now: NOW, liveNow: false })).toBe(6);
    const [all] = await db.select().from(M).where(and(eq(M.metricDate, DAY), eq(M.tutorKey, "*")));
    expect(all).toMatchObject({ liveMode: true, posted: 1, held: 1, unseen: 1, excludedTutorFirst: 1, eligible: 3, required: 1, reviewed: 0 });
    // The sweep never shortlists a switched-off tutor's classes: an unseen one is theirs, not a miss.
    await refreshDailyMetrics(db, { dates: [DAY], now: NOW, liveNow: false, disabledTutors: [MIMI] });
    expect((await db.select().from(M).where(and(eq(M.metricDate, DAY), eq(M.tutorKey, "*"))))[0])
      .toMatchObject({ liveMode: true, unseen: 0, excludedTutorOff: 1, eligible: 2 });
    await refreshDailyMetrics(db, { dates: [DAY], now: NOW, liveNow: false });

    const gate = await recordDailyGate(db, DAY);
    expect(gate).toEqual({ date: DAY, status: "insufficient_data" });
    expect(await recordDailyGate(db, DAY)).toBeNull();
    const rows = await db.select().from(G);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ evalKind: "daily", windowStart: "2026-09-16", windowEnd: DAY, coverageNum: 1, coverageDen: 3 });
    await expectSqlState(db.insert(G).values({ ...rows[0], id: undefined }), "23505");
  });
});

describe("incident outbox", () => {
  it("retries a failed push, never re-sends a channel that succeeded, and gives up after the cap", async () => {
    await recordIncident(db, { dedupeKey: "critical_verdict:x", kind: "critical_verdict", severity: "critical", summary: "Critical verdict" });
    expect(await recordIncident(db, { dedupeKey: "critical_verdict:x", kind: "critical_verdict", severity: "critical", summary: "again" })).toBe(false);
    await recordIncident(db, { dedupeKey: "info:y", kind: "first_shot_unverified", severity: "info", summary: "info only" });

    const email = vi.fn<ScheduleEmailSender["sendEmail"]>().mockRejectedValueOnce(new Error("relay down")).mockResolvedValue({ id: "m" });
    const line = vi.fn().mockRejectedValueOnce(new Error("LINE 500")).mockResolvedValue({});
    const push = { emailRecipients: ["owner@example.com"], lineTo: "U123", emailSender: { sendEmail: email }, pushLine: line };

    const t0 = new Date("2026-09-30T03:00:00Z");
    expect(await drainIncidentOutbox(db, push, t0)).toMatchObject({ attempted: 1, sent: 0, stillPending: 1 });
    // Not due again until the retry time.
    expect(await drainIncidentOutbox(db, push, new Date(t0.getTime() + 60_000))).toMatchObject({ attempted: 0 });
    const t1 = new Date(t0.getTime() + 31 * 60_000);
    expect(await drainIncidentOutbox(db, push, t1)).toMatchObject({ attempted: 1, sent: 1 });
    const [critical] = await db.select().from(I).where(eq(I.kind, "critical_verdict"));
    expect(critical).toMatchObject({ pushStatus: "sent", pushAttempts: 2, lastPushError: null });
    expect(critical.pushedChannels.toSorted()).toEqual(["email", "line"]);
    expect(email).toHaveBeenCalledTimes(2);
    expect(line).toHaveBeenCalledTimes(2);
    expect(line).toHaveBeenLastCalledWith(expect.objectContaining({ to: "U123", retryKey: critical.id }));

    await recordIncident(db, { dedupeKey: "api_actor_unmatched:z", kind: "api_actor_unmatched", severity: "critical", summary: "Unmatched" });
    const broken = { emailRecipients: ["owner@example.com"], lineTo: null, emailSender: { sendEmail: vi.fn(async () => { throw new Error("down"); }) } };
    let at = t1.getTime();
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
      at += 31 * 60_000;
      await drainIncidentOutbox(db, broken, new Date(at));
    }
    expect((await db.select().from(I).where(eq(I.kind, "api_actor_unmatched")))[0]).toMatchObject({ pushStatus: "failed", pushAttempts: MAX_PUSH_ATTEMPTS });

    await recordIncident(db, { dedupeKey: "critical_flag:w", kind: "critical_flag", severity: "critical", summary: "No channel" });
    expect(await drainIncidentOutbox(db, { emailRecipients: [], lineTo: null }, new Date(at))).toMatchObject({ attempted: 0, stillPending: 1 });
  });
});

describe("recordVerdict", () => {
  async function reviewed(n: number) {
    const seeded = await seedPosted(n);
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    const [post] = await db.select().from(P).where(eq(P.wiseSessionId, seeded.wiseSessionId));
    return { ...seeded, fieldsSha256: post.fieldsSha256 };
  }

  it("appends the verdict, makes it current, resolves open flags, marks the class triaged and queues a critical incident", async () => {
    const { wiseSessionId, fieldsSha256 } = await reviewed(50);
    await db.insert(FL).values({ wiseSessionId, source: "measured_fix", createdBy: "system", idempotencyKey: "flag-1" });
    const first = await recordVerdict(db, {
      wiseSessionId, fieldsSha256, verdict: "needs_fix", severity: "cosmetic", criticalCategory: null, note: "nickname",
      reviewer: "kevhsh7@gmail.com", source: "dashboard",
    });
    expect(first).toMatchObject({ supersedesId: null, resolvedFlags: 1, criticalIncident: false });
    const second = await recordVerdict(db, {
      wiseSessionId, fieldsSha256, verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person", note: null,
      reviewer: "kevhsh7@gmail.com", source: "dashboard",
    });
    expect(second).toMatchObject({ supersedesId: first.verdictId, resolvedFlags: 0, criticalIncident: true });
    const [row] = await db.select().from(R);
    expect(row.currentVerdictId).toBe(second.verdictId);
    expect(row.reviewedAt).not.toBeNull();
    expect(await db.select().from(V)).toHaveLength(2);
    expect((await db.select().from(FL))[0].resolvedByVerdictId).toBe(first.verdictId);
    expect(await db.select().from(I)).toMatchObject([{ kind: "critical_verdict", severity: "critical", pushStatus: "pending" }]);
    const [session] = await db.select().from(S).where(eq(S.wiseSessionId, wiseSessionId));
    expect(typeof (session.metadata as { triagedAt?: unknown }).triagedAt).toBe("string");
  });

  it("refuses a stale pin and an unknown class, writing nothing", async () => {
    const { wiseSessionId } = await reviewed(51);
    await expect(recordVerdict(db, {
      wiseSessionId, fieldsSha256: "f".repeat(64), verdict: "approve", severity: null, criticalCategory: null, note: null, reviewer: "k", source: "dashboard",
    })).rejects.toMatchObject({ status: 409 });
    await expect(recordVerdict(db, {
      wiseSessionId: id24(999), fieldsSha256: "f".repeat(64), verdict: "approve", severity: null, criticalCategory: null, note: null, reviewer: "k", source: "dashboard",
    })).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(V)).toHaveLength(0);
  });

  it("writes the verdict and the current view in one transaction", async () => {
    const { wiseSessionId, fieldsSha256 } = await reviewed(52);
    await db.execute(sql`CREATE FUNCTION test_fail_review_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'review update failed'; END; $$`);
    await db.execute(sql`CREATE TRIGGER test_fail_review_update BEFORE UPDATE ON feedback_autowriter_reviews
      FOR EACH ROW EXECUTE FUNCTION test_fail_review_update()`);
    try {
      await expect(recordVerdict(db, {
        wiseSessionId, fieldsSha256, verdict: "needs_fix", severity: "critical", criticalCategory: "invented_content", note: null,
        reviewer: "kevhsh7@gmail.com", source: "dashboard",
      })).rejects.toBeTruthy();
    } finally {
      await db.execute(sql`DROP TRIGGER test_fail_review_update ON feedback_autowriter_reviews`);
      await db.execute(sql`DROP FUNCTION test_fail_review_update()`);
    }
    expect(await db.select().from(V)).toHaveLength(0);
    expect(await db.select().from(I)).toHaveLength(0);
    expect((await db.select().from(R))[0].currentVerdictId).toBeNull();
  });
});

describe("runReviewJob", () => {
  const deps = (overrides: Partial<ReviewJobDeps> = {}): ReviewJobDeps => ({
    db, apiActorId: API, writesAllowedHere: true, triggerSource: "cron", liveNow: true, now: () => NOW, channels: channels(), ...overrides,
  });

  it("is single-flight, takes over an abandoned run, and records the whole pass", async () => {
    await db.insert(RUNS).values({ triggerSource: "cron" });
    expect(await runReviewJob(deps())).toMatchObject({ ok: true, skipped: true });

    await db.update(RUNS).set({ startedAt: new Date(Date.now() - 20 * 60_000) });
    const seeded = await seedPosted(60);
    await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
    const result = await runReviewJob(deps());
    expect(result).toMatchObject({
      ok: true, firstShots: { recorded: 1, unverified: 0 }, fixEvents: { inserted: 1 }, reviewsCreated: 1,
      dailyGate: { date: DAY, status: "insufficient_data" },
    });
    const runs = await db.select().from(RUNS).orderBy(RUNS.startedAt);
    expect(runs.map((run) => run.status)).toEqual(["failed", "succeeded"]);
    expect(runs[1].counts).toMatchObject({ reviewsCreated: 1 });
    expect(await runReviewJob(deps({ writesAllowedHere: false }))).toMatchObject({ ok: true, skipped: true });
  });

  it("reports a critical incident it could not push as not ok", async () => {
    await recordIncident(db, { dedupeKey: "critical_verdict:q", kind: "critical_verdict", severity: "critical", summary: "Critical" });
    const result = await runReviewJob(deps({ channels: { emailRecipients: [], lineTo: null } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Critical incident push not delivered");
  });
});
