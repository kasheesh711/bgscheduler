import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { ScheduleEmailSender } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { applyOwnerVerdicts, applyReviewBackfillPlan, planReviewBackfill, type OwnerVerdicts } from "../backfill";
import { ingestFixEvents, loadFixEventSources, planFixEvents } from "../fix-events";
import { MAX_PUSH_ATTEMPTS, acknowledgeIncident, countUndeliveredCritical, drainIncidentOutbox, recordIncident } from "../incidents";
import { evaluateGate, gateWindow, metricDates } from "../quality";
import { loadAutowriterReview } from "../review-data";
import {
  activityMirrorStatus,
  assignReviews,
  loadGateFacts,
  previewDailyMetrics,
  raiseFixFlags,
  raiseVerificationFlags,
  recordDailyGate,
  refreshDailyMetrics,
  refreshReviewCounts,
  runReviewJob,
  snapshotFirstShots,
  type ReviewJobDeps,
} from "../review-job";
import { buildFeedbackPostBody } from "../session";
import { listSonioxCleanup } from "../store";
import { feedbackBodyHash, fieldsHash } from "../submit";
import { recordVerdict, type VerdictInput } from "../verdicts";

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
const CH = schema.feedbackAutowriterControlHistory;

// Roster account ids are the code roster's (the metrics join on them); everything else is synthetic.
const API = "69366668c05630afe5d8a2a4";
const MIMI = "696e2c4343579bbada2340f8";
const EK = "6976680baf7fbc5ac88c3ea9";
const ADMIN = "6a00000000000000000ad001";
const NOW = new Date("2026-09-30T03:00:00Z");
const DAY = "2026-09-29";
const OWNER = "owner@example.com";
const BILLING = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 };
const FIELDS: FeedbackFieldAnswers = {
  topics: "Rotation and symmetry in 11+ Non-Verbal Reasoning.",
  performance: "Alexander spotted reflections quickly.",
  improvement: "Colour sequences under time pressure.",
  homework: "",
};

const id24 = (n: number) => `6a${String(n).padStart(22, "0")}`;
const at = (iso: string) => new Date(iso);
const minutes = (date: Date, count: number) => new Date(date.getTime() + count * 60_000);

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
  teacher?: string;
  metadata?: Record<string, unknown>;
  sonioxTranscriptionId?: string;
} = {}) {
  const posted = options.posted ?? FIELDS;
  const stored = options.stored ?? posted;
  const order = options.order ?? ["improvement", "topics", "performance", "homework"];
  const endAt = options.endAt ?? at("2026-09-29T08:00:00Z");
  const postStartedAt = minutes(endAt, 40);
  await db.insert(S).values({
    wiseSessionId: id24(n),
    wiseClassId: id24(n + 500),
    wiseTeacherUserId: options.teacher ?? MIMI,
    scheduledEndAt: endAt,
    deadlineAt: calculateFeedbackDeadline(endAt),
    state: options.state ?? "verified",
    reason: options.state ?? "verified",
    arm: "glm",
    fields: stored,
    fieldsSha256: fieldsHash(stored),
    billing: BILLING,
    bodyHash: feedbackBodyHash(buildFeedbackPostBody({ fieldOrder: order }, posted, BILLING)),
    postStartedAt,
    sonioxTranscriptionId: options.sonioxTranscriptionId ?? null,
    verifiedEvent: { at: new Date(postStartedAt.getTime() + 90).toISOString(), actorId: API, autoSubmitted: false },
    metadata: {
      pipeline: { promptVersion: 7, arm: "glm" }, postedFromCommit: "abc1234", expected: { kind: "auto_blank", submissionId: "sub" },
      post: { postFinishedAt: new Date(postStartedAt.getTime() + 150).toISOString() },
      ...(options.metadata ?? {}),
    },
    createdAt: endAt,
    updatedAt: minutes(endAt, 41),
  });
  return { wiseSessionId: id24(n), postStartedAt, verifiedAt: new Date(postStartedAt.getTime() + 90) };
}

/** An autowriter row that was never posted. */
async function seedRow(n: number, options: { state: typeof S.$inferInsert["state"]; reason?: string | null; endAt: Date; teacher?: string; createdAt?: Date }) {
  await db.insert(S).values({
    wiseSessionId: id24(n), wiseClassId: id24(n + 500), wiseTeacherUserId: options.teacher ?? MIMI, scheduledEndAt: options.endAt,
    deadlineAt: calculateFeedbackDeadline(options.endAt), state: options.state, reason: options.reason ?? options.state,
    createdAt: options.createdAt ?? options.endAt,
  });
  return id24(n);
}

/** A roster class the autowriter never saw, proven online one-to-one by the past-session mirror. */
async function seedUnseen(n: number, options: { teacher?: string; endAt: Date }) {
  const teacher = options.teacher ?? MIMI;
  await db.insert(schema.postClassSessions).values({
    wiseSessionId: id24(n), wiseClassId: id24(n + 500), wiseTeacherUserId: teacher, scheduledStartAt: minutes(options.endAt, -60),
    scheduledEndAt: options.endAt, deadlineAt: calculateFeedbackDeadline(options.endAt), finalStatus: "ENDED",
  });
  await db.insert(schema.pastSessionBlocks).values({
    groupCanonicalKey: "Tutor", wiseTeacherId: teacher, wiseSessionId: id24(n), startTime: minutes(options.endAt, 360),
    endTime: minutes(options.endAt, 420), weekday: 2, startMinute: 1020, endMinute: 1080, wiseStatus: "FUTURE",
    sessionType: "SCHEDULED", classType: "ONE_TO_ONE", title: "Live Session - NVR",
  });
}

async function seedEvent(sessionId: string, when: Date, actor: { id: string | null; role: string | null }, autoSubmitted: boolean | null = null) {
  const eventId = `evt-${sessionId.slice(-4)}-${when.getTime()}`;
  await db.insert(schema.wiseActivityEvents).values({
    eventId,
    eventName: "SessionFeedbackSubmittedEvent",
    eventTimestamp: when,
    actorWiseUserId: actor.id,
    actorRole: actor.role,
    sessionId,
    payload: { session: { id: sessionId, ...(autoSubmitted === null ? {} : { autoSubmitted }) } },
  });
  return eventId;
}

/** A writer call whose row was written at `when`; `result` is what the pipeline recorded with it. */
async function seedWriterCall(sessionId: string, when: Date, ok: boolean, result?: Record<string, unknown>) {
  await db.insert(schema.feedbackAutowriterCalls).values({
    wiseSessionId: sessionId, role: "writer", arm: "glm", requestedModel: "writer-model", ok,
    error: ok ? null : "provider_timeout", promptVersion: 4, createdAt: when, ...(result ? { result } : {}),
  });
}

async function seedJudgeCall(sessionId: string, when: Date, faithful: boolean) {
  await db.insert(schema.feedbackAutowriterCalls).values({
    wiseSessionId: sessionId, role: "judge", arm: "glm", requestedModel: "judge-model", ok: true,
    result: { faithful, unsupported: [] }, promptVersion: 4, createdAt: when,
  });
}

/** Recorded changes of the control row (the trigger writes these in production). */
async function seedHistory(...changes: Array<[string, "off" | "shadow" | "live", string[]?]>) {
  for (const [changedAt, mode, disabled] of changes) {
    await db.insert(CH).values({ changedAt: at(changedAt), mode, disabledTutors: disabled ?? [], source: "change" });
  }
}

/** A successful first-page Wise activity sync that finished at `finishedAt`. */
async function seedMirror(finishedAt: Date) {
  await db.insert(schema.wiseActivitySyncRuns).values({
    status: "success", triggerType: "cron", startedAt: minutes(finishedAt, -1), finishedAt,
    metadata: { startPage: 1, eventName: null, stoppedReason: "known_events" },
  });
}

async function starRow(date: string) {
  return (await db.select().from(M).where(and(eq(M.metricDate, date), eq(M.tutorKey, "*"))))[0];
}

function channels(overrides: Partial<ReviewJobDeps["channels"]> = {}): ReviewJobDeps["channels"] {
  return { emailRecipients: [OWNER], lineTo: null, emailSender: { sendEmail: vi.fn(async () => ({ id: "m" })) }, ...overrides };
}

function deps(overrides: Partial<ReviewJobDeps> = {}): ReviewJobDeps {
  return { db, apiActorId: API, writesAllowedHere: true, triggerSource: "cron", now: () => NOW, channels: channels(), ...overrides };
}

/** A verdict pinned to the class as the page shows it now. */
async function verdictFor(wiseSessionId: string, input: Partial<VerdictInput> & Pick<VerdictInput, "verdict">): Promise<VerdictInput> {
  const [review] = await db.select().from(R).where(eq(R.wiseSessionId, wiseSessionId));
  const [post] = review ? await db.select().from(P).where(eq(P.id, review.firstPostId)) : [];
  const open = await db.select({ id: FL.id }).from(FL).where(and(eq(FL.wiseSessionId, wiseSessionId), sql`${FL.resolvedByVerdictId} is null`));
  return {
    wiseSessionId,
    fieldsSha256: post?.fieldsSha256 ?? "f".repeat(64),
    currentVerdictId: review?.currentVerdictId ?? null,
    seenFlagIds: open.map((flag) => flag.id),
    severity: null,
    criticalCategory: null,
    note: null,
    reviewer: OWNER,
    source: "dashboard",
    ...input,
  };
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
    feedback_autowriter_sessions, feedback_autowriter_control_history, feedback_autowriter_roster_accounts,
    feedback_autowriter_calls, wise_activity_sync_runs, wise_activity_events, post_class_sessions, past_session_blocks
    RESTART IDENTITY CASCADE`);
});

describe("migration 0101 guards (SQLSTATE 55000)", () => {
  it("keeps a post's content immutable, a settled outcome final and every row undeletable", async () => {
    await seedPosted(1);
    await snapshotFirstShots(db);
    const [post] = await db.select().from(P);
    await expectSqlState(db.update(P).set({ fields: { ...FIELDS, topics: "rewritten" } }).where(eq(P.id, post.id)), "55000");
    await expectSqlState(db.update(P).set({ outcome: "verify_failed" }).where(eq(P.id, post.id)), "55000");
    await expectSqlState(db.update(P).set({ dedupeKey: "later" }).where(eq(P.id, post.id)), "55000");
    await expectSqlState(db.delete(P).where(eq(P.id, post.id)), "55000");

    // An unsettled post (a later correction in flight) may still settle.
    const [inflight] = await db.insert(P).values({
      wiseSessionId: post.wiseSessionId, kind: "correction", fields: FIELDS, fieldsSha256: fieldsHash(FIELDS), billing: BILLING,
      actorKind: "owner", actor: OWNER, reason: "test", outcome: "posting", provenance: "live", dedupeKey: "fix:1",
    }).returning({ id: P.id });
    await db.update(P).set({ outcome: "verified", settledAt: new Date() }).where(eq(P.id, inflight.id));
    await expectSqlState(db.update(P).set({ outcome: "rejected" }).where(eq(P.id, inflight.id)), "55000");
    // Only one first shot per class, and one post per dedupe key.
    await expectSqlState(db.insert(P).values({ ...post, id: undefined }), "23505");
    await expectSqlState(db.insert(P).values({
      wiseSessionId: post.wiseSessionId, kind: "correction", fields: FIELDS, fieldsSha256: fieldsHash(FIELDS), billing: BILLING,
      actorKind: "script", actor: "script:test", reason: "again", outcome: "verified", provenance: "backfill", dedupeKey: "fix:1",
    }), "23505");
  });

  it("keeps verdicts append-only, review inclusion set once, and gate evaluations append-only", async () => {
    const seeded = await seedPosted(2);
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW, draw: () => 0.25 });
    await recordVerdict(db, await verdictFor(seeded.wiseSessionId, { verdict: "approve" }));
    const [verdict] = await db.select().from(V);
    await expectSqlState(db.update(V).set({ note: "changed my mind" }).where(eq(V.id, verdict.id)), "55000");
    await expectSqlState(db.delete(V).where(eq(V.id, verdict.id)), "55000");

    await expectSqlState(db.update(R).set({ inclusionReason: "not_sampled" }).where(eq(R.wiseSessionId, seeded.wiseSessionId)), "55000");
    await expectSqlState(db.update(R).set({ sampleDraw: 0.9 }).where(eq(R.wiseSessionId, seeded.wiseSessionId)), "55000");
    await expectSqlState(db.delete(R).where(eq(R.wiseSessionId, seeded.wiseSessionId)), "55000");
    // The current view itself stays updatable.
    await db.update(R).set({ measuredFixCount: 3 }).where(eq(R.wiseSessionId, seeded.wiseSessionId));

    await refreshDailyMetrics(db, { dates: [DAY], now: NOW });
    await recordDailyGate(db, DAY);
    const [evaluation] = await db.select().from(G);
    await expectSqlState(db.update(G).set({ status: "pass" }).where(eq(G.id, evaluation.id)), "55000");
    await expectSqlState(db.delete(G).where(eq(G.id, evaluation.id)), "55000");
  });

  it("rejects verdicts whose severity, category or downgrade disagree (CHECK 23514)", async () => {
    const seeded = await seedPosted(3);
    await snapshotFirstShots(db);
    const [post] = await db.select().from(P);
    const base = { wiseSessionId: seeded.wiseSessionId, postId: post.id, fieldsSha256: post.fieldsSha256, reviewer: "k", source: "dashboard" as const };
    await expectSqlState(db.insert(V).values({ ...base, verdict: "approve", severity: "cosmetic" }), "23514");
    await expectSqlState(db.insert(V).values({ ...base, verdict: "needs_fix", severity: "critical" }), "23514");
    await expectSqlState(db.insert(V).values({ ...base, verdict: "approve", criticalCategory: "wrong_person" }), "23514");
    // A downgrade is always milder than what it replaces, and always has a note.
    await expectSqlState(db.insert(V).values({ ...base, verdict: "approve", downgradedFrom: "critical" }), "23514");
    await expectSqlState(db.insert(V).values({ ...base, verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person", note: "n", downgradedFrom: "critical" }), "23514");
    await expectSqlState(db.insert(V).values({ ...base, verdict: "needs_fix", severity: "factual", note: "n", downgradedFrom: "factual" }), "23514");
    await db.insert(V).values({ ...base, verdict: "needs_fix", severity: "cosmetic", note: "n", downgradedFrom: "factual" });
  });

  it("logs every change of the mode or the tutor switches, append-only — but no lease or halt write", async () => {
    const C = schema.feedbackAutowriterControl;
    await db.update(C).set({ leaseUntil: new Date(), haltedAt: new Date(), haltReason: "test" }).where(eq(C.id, "default"));
    expect(await db.select().from(CH)).toHaveLength(0);
    await db.update(C).set({ mode: "live", updatedBy: OWNER }).where(eq(C.id, "default"));
    await db.update(C).set({ disabledTutors: [MIMI] }).where(eq(C.id, "default"));
    const rows = await db.select().from(CH).orderBy(CH.changedAt);
    expect(rows.map((row) => [row.mode, row.disabledTutors, row.source])).toEqual([["live", [], "change"], ["live", [MIMI], "change"]]);
    await expectSqlState(db.update(CH).set({ mode: "off" }).where(eq(CH.id, rows[0].id)), "55000");
    await expectSqlState(db.delete(CH).where(eq(CH.id, rows[0].id)), "55000");
    await db.update(C).set({ mode: "shadow", disabledTutors: [], haltedAt: null, haltReason: null, leaseUntil: null }).where(eq(C.id, "default"));
  });
});

describe("first-shot snapshots", () => {
  it("records only first shots proven against body_hash, in the form order that proves them", async () => {
    const proven = await seedPosted(10, { order: ["performance", "improvement", "topics", "homework"] });
    const edited = await seedPosted(11, { stored: { ...FIELDS, performance: "Alex spotted reflections quickly." } });
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
    const later = (count: number) => minutes(seeded.postStartedAt, count);
    await seedEvent(seeded.wiseSessionId, later(-30), { id: null, role: null }, true);
    await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
    await seedEvent(seeded.wiseSessionId, later(1), { id: "6a00000000000000000057d1", role: "STUDENT" });
    await seedEvent(seeded.wiseSessionId, later(60), { id: MIMI, role: "TEACHER" });
    const apiEvent = await seedEvent(seeded.wiseSessionId, later(120), { id: API, role: "OWNER" });

    const since = at("2026-09-01T00:00:00Z");
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
    expect((await db.select().from(R))[0]).toMatchObject({
      measuredFixCount: 2, measuredFixesByActor: { tutor: 1, autowriter_correction: 1 }, correctionsVerified: 1,
    });
  });

  it("reports an API write on a class the autowriter never posted (critical after go-live, info before), never our own POST in flight", async () => {
    const held = await seedRow(70, { state: "held", reason: "glm:unfaithful", endAt: at("2026-09-29T09:00:00Z") });
    const skipped = await seedRow(71, { state: "skipped_human", reason: "human_submission", endAt: at("2026-09-29T04:00:00Z") });
    const inFlight = await seedPosted(72, { state: "posting" });
    await seedEvent(held, at("2026-09-29T10:00:00Z"), { id: API, role: "OWNER" });
    // The prototype's save, before the autowriter went live.
    await seedEvent(skipped, at("2026-09-29T05:06:37Z"), { id: API, role: "OWNER" });
    await seedEvent(inFlight.wiseSessionId, inFlight.verifiedAt, { id: API, role: "OWNER" });

    const since = at("2026-09-01T00:00:00Z");
    expect(await ingestFixEvents(db, { apiActorId: API, since })).toMatchObject({ inserted: 2, skippedInFlight: 1 });
    expect((await db.select().from(FX).orderBy(FX.eventAt)).map((row) => [row.wiseSessionId, row.actorKind, row.countsAsFix])).toEqual([
      [skipped, "api_actor_unmatched", false],
      [held, "api_actor_unmatched", false],
    ]);
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 0, incidents: 2 });
    const incidents = await db.select().from(I).orderBy(I.createdAt);
    expect(incidents.map((row) => [row.wiseSessionId, row.severity, row.pushStatus]).toSorted()).toEqual([
      [held, "critical", "pending"],
      [skipped, "info", "not_required"],
    ].toSorted());
    // The unexplained write blocks expansion until the owner has looked into it and acknowledged it.
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).unexplainedApiWrites).toBe(1);
    const critical = incidents.find((row) => row.severity === "critical")!;
    await acknowledgeIncident(db, { incidentId: critical.id, actor: OWNER });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).unexplainedApiWrites).toBe(0);
  });

  it("explains an owner-approved correction recorded in metadata.corrections, before and after the backfill records it", async () => {
    const corrected = { ...FIELDS, improvement: "Colour sequences.", homework: "" };
    const correctionAt = at("2026-09-29T18:07:12.757Z");
    const withEntry = await seedPosted(73, {
      stored: corrected,
      metadata: {
        corrections: [{
          fields: ["improvement"], reason: "synthetic: the summary invented a task", fromSha256: fieldsHash(FIELDS),
          toSha256: fieldsHash(corrected), at: correctionAt.toISOString(), by: "owner@example.com (one-time correction, owner-approved)",
        }],
      },
    });
    // The same re-post with nothing recorded on the row: nobody explains it.
    const bare = await seedPosted(74, { stored: corrected });
    for (const seeded of [withEntry, bare]) {
      await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
      await seedEvent(seeded.wiseSessionId, new Date(correctionAt.getTime() - 4_250), { id: API, role: "OWNER" });
    }

    // Before the backfill: the job cannot prove either first shot (the text changed), yet explains the listed re-post.
    const result = await runReviewJob(deps());
    expect(result.firstShots).toEqual({ recorded: 0, unverified: 2 });
    const kindsOf = async (wiseSessionId: string) => (await db.select().from(FX).where(eq(FX.wiseSessionId, wiseSessionId)).orderBy(FX.eventAt))
      .map((row) => [row.actorKind, row.postId === null]);
    expect(await kindsOf(withEntry.wiseSessionId)).toEqual([["autowriter_first", true], ["autowriter_correction", true]]);
    expect(await kindsOf(bare.wiseSessionId)).toEqual([["autowriter_first", true], ["api_actor_unmatched", true]]);
    const unmatched = await db.select().from(I).where(eq(I.kind, "api_actor_unmatched"));
    expect(unmatched.map((row) => [row.wiseSessionId, row.severity])).toEqual([[bare.wiseSessionId, "critical"]]);

    // The backfill records the first shot (Class Feedback's first version) and the correction row, keyed once.
    const [row] = await db.select().from(S).where(eq(S.wiseSessionId, withEntry.wiseSessionId));
    const plan = planReviewBackfill([{
      row,
      pcFirstVersion: { id: "v1", observedAt: at("2026-09-29T09:30:00Z"), fields: FIELDS },
      hasFirstShot: false,
      recordedDedupeKeys: new Set(),
    }]);
    expect(plan.corrections.map((entry) => entry.dedupeKey)).toEqual([`correction:${withEntry.wiseSessionId}:${correctionAt.toISOString()}`]);
    expect(await applyReviewBackfillPlan(db, plan)).toMatchObject({ firstShots: 1, corrections: 1 });
    expect(await ingestFixEvents(db, { apiActorId: API, since: at("2026-09-01T00:00:00Z") })).toMatchObject({ updated: 2 });
    expect(await kindsOf(withEntry.wiseSessionId)).toEqual([["autowriter_first", false], ["autowriter_correction", false]]);
    await assignReviews(db, { now: NOW });
    await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
    expect((await db.select().from(R).where(eq(R.wiseSessionId, withEntry.wiseSessionId)))[0])
      .toMatchObject({ measuredFixCount: 1, correctionsVerified: 1 });
  });
});

describe("review inclusion and first shots that landed without verifying", () => {
  it("gives every first shot whose text may be in Wise a review row and a critical flag the owner must answer", async () => {
    await seedPosted(30);
    const creditsChanged = await seedPosted(31, { state: "verify_failed", metadata: { post: { problems: ["session_credit_entries_2"] } } });
    const unknown = await seedPosted(32, { state: "unknown_outcome", metadata: { post: { problems: [] } } });
    await seedPosted(33, { state: "rejected", metadata: { post: { httpStatus: 400, stillAutoBlank: true } } });
    await seedPosted(34, { state: "rejected", metadata: { post: { httpStatus: 400, stillAutoBlank: false } } });
    await snapshotFirstShots(db);
    const draws = [0.8123, 0.1, 0.2, 0.3];
    expect(await assignReviews(db, { now: NOW, draw: () => draws.shift() ?? 0 })).toBe(4);
    expect(await assignReviews(db, { now: NOW, draw: () => 0.1 })).toBe(0);
    expect((await db.select().from(R).orderBy(R.wiseSessionId)).map((row) => row.wiseSessionId)).toEqual([id24(30), id24(31), id24(32), id24(34)]);
    expect((await db.select().from(R).where(eq(R.wiseSessionId, id24(30))))[0]).toMatchObject({
      tutorKey: "Mimi", bangkokDate: DAY, inclusionReason: "new_tutor", inclusionProbability: "1.000", sampleDraw: 0.8123,
    });
    const [creditPost] = await db.select().from(P).where(eq(P.wiseSessionId, creditsChanged.wiseSessionId));
    expect(creditPost.verification).toMatchObject({ problems: ["session_credit_entries_2"] });

    expect(await raiseVerificationFlags(db)).toEqual({ flags: 3, incidents: 3 });
    expect(await raiseVerificationFlags(db)).toEqual({ flags: 0, incidents: 0 });
    const flags = await db.select().from(FL).orderBy(FL.wiseSessionId);
    expect(flags.map((flag) => [flag.wiseSessionId, flag.source, flag.suggestedSeverity, flag.suggestedCategory])).toEqual([
      [id24(31), "system", "critical", "billing_status"],
      [id24(32), "system", "critical", null],
      [id24(34), "system", "critical", null],
    ]);
    expect((await db.select().from(I).where(eq(I.wiseSessionId, creditsChanged.wiseSessionId)))[0]).toMatchObject({ kind: "credit_entries_changed", severity: "critical" });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).unresolvedCriticalFlags).toBe(3);

    // The owner can record the critical verdict the rules require (the class used to be unreachable: 404).
    const critical = await recordVerdict(db, await verdictFor(creditsChanged.wiseSessionId, {
      verdict: "needs_fix", severity: "critical", criticalCategory: "billing_status", note: "second credit entry",
    }));
    expect(critical).toMatchObject({ resolvedFlags: 1, criticalIncident: true, downgradedFrom: null });
    // Answering a critical flag with a non-critical verdict is an explicit, noted downgrade.
    await expect(recordVerdict(db, await verdictFor(unknown.wiseSessionId, { verdict: "approve" }))).rejects.toMatchObject({ status: 409 });
    await expect(recordVerdict(db, await verdictFor(unknown.wiseSessionId, { verdict: "approve", confirmDowngrade: true })))
      .rejects.toMatchObject({ status: 400 });
    const downgraded = await recordVerdict(db, await verdictFor(unknown.wiseSessionId, {
      verdict: "approve", confirmDowngrade: true, note: "checked in Wise: the text landed as posted",
    }));
    expect(downgraded).toMatchObject({ downgradedFrom: "critical", resolvedFlags: 1 });
  });

  it("pages a landed-but-unverified first shot it cannot prove, and blocks the gate until it is recorded", async () => {
    const lost = await seedPosted(35, { state: "verify_failed", stored: { ...FIELDS, topics: "not what was posted" } });
    expect(await snapshotFirstShots(db)).toEqual({ recorded: 0, unverified: [lost.wiseSessionId] });
    expect((await db.select().from(I))[0]).toMatchObject({ kind: "first_shot_unverified", severity: "critical", pushStatus: "pending" });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).unrecordedPosts).toBe(1);
    // A POST still settling has no review row yet either: the gate cannot pass over it.
    await seedPosted(36, { state: "awaiting_event" });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).unrecordedPosts).toBe(2);
  });
});

describe("measured fixes up to the owner's Approve", () => {
  it("counts and flags a person's save before the Approve, not an admin's save after it — until a later verdict replaces it", async () => {
    const seeded = await seedPosted(80);
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
    await seedEvent(seeded.wiseSessionId, minutes(seeded.postStartedAt, 60), { id: MIMI, role: "TEACHER" });
    const since = at("2026-09-01T00:00:00Z");
    await ingestFixEvents(db, { apiActorId: API, since });
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 1, incidents: 0 });
    await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
    expect((await db.select().from(R))[0]).toMatchObject({ measuredFixCount: 1, measuredFixesByActor: { tutor: 1 } });

    const approve = await recordVerdict(db, await verdictFor(seeded.wiseSessionId, { verdict: "approve" }));
    // Days later an admin re-saves the class (status or credits).
    await seedEvent(seeded.wiseSessionId, new Date(Date.now() + 60 * 60_000), { id: ADMIN, role: "ADMIN" });
    await ingestFixEvents(db, { apiActorId: API, since });
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 0, incidents: 0 });
    await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
    expect((await db.select().from(R))[0]).toMatchObject({ measuredFixCount: 1, measuredFixesByActor: { tutor: 1 } });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).pendingFlaggedReviews).toBe(0);

    // A later Needs fix replaces the Approve: every save after our first post counts again.
    await recordVerdict(db, await verdictFor(seeded.wiseSessionId, { verdict: "needs_fix", severity: "factual", note: "wrong topic" }));
    expect(approve.verdictId).toBeTruthy();
    await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
    expect((await db.select().from(R))[0]).toMatchObject({ measuredFixCount: 2, measuredFixesByActor: { tutor: 1, other_staff: 1 } });
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 1, incidents: 0 });
  });
});

describe("recordVerdict", () => {
  async function reviewed(n: number, options: Parameters<typeof seedPosted>[1] = {}) {
    const seeded = await seedPosted(n, options);
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    return seeded;
  }

  it("appends the verdict, makes it current, resolves the flags shown, ends triage and queues a critical incident", async () => {
    const { wiseSessionId } = await reviewed(50);
    await db.insert(FL).values({ wiseSessionId, source: "measured_fix", createdBy: "system", idempotencyKey: "flag-1" });
    const first = await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "cosmetic", note: "nickname" }));
    expect(first).toMatchObject({ supersedesId: null, resolvedFlags: 1, criticalIncident: false });
    const triaged = async () => typeof ((await db.select().from(S).where(eq(S.wiseSessionId, wiseSessionId)))[0].metadata as { triagedAt?: unknown }).triagedAt;
    expect(await triaged()).toBe("string");
    const second = await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person" }));
    expect(second).toMatchObject({ supersedesId: first.verdictId, resolvedFlags: 0, criticalIncident: true });
    const [row] = await db.select().from(R);
    expect(row.currentVerdictId).toBe(second.verdictId);
    expect(row.reviewedAt).not.toBeNull();
    expect(await db.select().from(V)).toHaveLength(2);
    expect((await db.select().from(FL))[0].resolvedByVerdictId).toBe(first.verdictId);
    expect(await db.select().from(I)).toMatchObject([{ kind: "critical_verdict", severity: "critical", pushStatus: "pending" }]);
    // The critical verdict re-opened triage: the transcript stays for the root-cause work (72 h window).
    expect(await triaged()).toBe("undefined");
  });

  it("refuses a stale page — a flag raised or a verdict recorded since it loaded — and resolves only the flags shown", async () => {
    const { wiseSessionId } = await reviewed(51);
    await db.insert(FL).values({ wiseSessionId, source: "measured_fix", createdBy: "system", idempotencyKey: "flag-seen" });
    const shown = await verdictFor(wiseSessionId, { verdict: "approve" });
    // A tutor's edit is mirrored and flagged after the owner opened the class.
    await db.insert(FL).values({ wiseSessionId, source: "measured_fix", createdBy: "system", idempotencyKey: "flag-new" });
    await expect(recordVerdict(db, shown)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(V)).toHaveLength(0);
    expect((await db.select().from(FL)).every((flag) => flag.resolvedByVerdictId === null)).toBe(true);

    const fresh = await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "approve" }));
    expect(fresh.resolvedFlags).toBe(2);
    // A second tab still showing "no verdict" is stale too.
    await expect(recordVerdict(db, { ...shown, seenFlagIds: [] })).rejects.toMatchObject({ status: 409 });
    await expect(recordVerdict(db, { ...(await verdictFor(wiseSessionId, { verdict: "approve" })), fieldsSha256: "f".repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(recordVerdict(db, await verdictFor(id24(999), { verdict: "approve" }))).rejects.toMatchObject({ status: 404 });
  });

  it("ends the transcript's review window only for an accurate verdict, without touching updated_at", async () => {
    const factual = await reviewed(52, { sonioxTranscriptionId: "job-52" });
    const cosmetic = await reviewed(53, { sonioxTranscriptionId: "job-53" });
    const approved = await reviewed(54, { sonioxTranscriptionId: "job-54" });
    const before = await db.select({ id: S.wiseSessionId, updatedAt: S.updatedAt }).from(S);
    await recordVerdict(db, await verdictFor(factual.wiseSessionId, { verdict: "needs_fix", severity: "factual", note: "invented a task" }));
    await recordVerdict(db, await verdictFor(cosmetic.wiseSessionId, { verdict: "needs_fix", severity: "cosmetic", note: "comma" }));
    await recordVerdict(db, await verdictFor(approved.wiseSessionId, { verdict: "approve" }));
    const triaged = (await db.select().from(S)).filter((row) => "triagedAt" in (row.metadata as object)).map((row) => row.wiseSessionId);
    expect(triaged.toSorted()).toEqual([cosmetic.wiseSessionId, approved.wiseSessionId].toSorted());
    expect((await listSonioxCleanup(db)).map((job) => job.sonioxTranscriptionId).toSorted()).toEqual(["job-53", "job-54"]);
    const after = await db.select({ id: S.wiseSessionId, updatedAt: S.updatedAt }).from(S);
    expect(after.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(before.toSorted((a, b) => a.id.localeCompare(b.id)));

    // A major verdict replacing the Approve re-opens triage: the transcript stays for the 72 h window.
    await recordVerdict(db, await verdictFor(approved.wiseSessionId, { verdict: "needs_fix", severity: "factual", note: "found a wrong fact" }));
    expect((await listSonioxCleanup(db)).map((job) => job.sonioxTranscriptionId)).toEqual(["job-53"]);
  });

  it("lets the owner downgrade a critical verdict only explicitly, with a note, and records it", async () => {
    const { wiseSessionId } = await reviewed(55);
    await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person" }));
    await expect(recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "approve" }))).rejects.toMatchObject({ status: 409 });
    await expect(recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "approve", confirmDowngrade: true }))).rejects.toMatchObject({ status: 400 });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).criticalVerdicts).toBe(1);
    // Critical to critical (another category) is no downgrade.
    await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "critical", criticalCategory: "invented_content" }));
    const downgrade = await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "approve", confirmDowngrade: true, note: "misclick: right student" }));
    expect(downgrade.downgradedFrom).toBe("critical");
    expect((await db.select().from(V).where(eq(V.id, downgrade.verdictId)))[0]).toMatchObject({ downgradedFrom: "critical", note: "misclick: right student" });
  });

  it("never lets an Approve after a fix quietly turn a major first shot into an accurate one", async () => {
    const { wiseSessionId } = await reviewed(57);
    await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "factual", note: "invented a task" }));
    // The post was fixed in Wise and flagged; the owner answers the flag by re-affirming the judgement…
    await db.insert(FL).values({ wiseSessionId, source: "measured_fix", createdBy: "system", idempotencyKey: "fix-after-major" });
    expect(await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "factual", note: "fixed now" })))
      .toMatchObject({ downgradedFrom: null, resolvedFlags: 1 });
    // …because Approve (or cosmetic) would re-judge the first shot as accurate: only as a confirmed, noted downgrade.
    await expect(recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "approve" }))).rejects.toMatchObject({ status: 409 });
    await expect(recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "needs_fix", severity: "cosmetic" }))).rejects.toMatchObject({ status: 409 });
    expect((await loadGateFacts(db, { start: "2026-09-16", end: DAY })).accurate).toBe(0);
    const downgrade = await recordVerdict(db, await verdictFor(wiseSessionId, { verdict: "approve", confirmDowngrade: true, note: "re-read: the task was set" }));
    expect(downgrade.downgradedFrom).toBe("factual");
  });

  it("writes the verdict and the current view in one transaction", async () => {
    const { wiseSessionId } = await reviewed(56);
    await db.execute(sql`CREATE FUNCTION test_fail_review_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'review update failed'; END; $$`);
    await db.execute(sql`CREATE TRIGGER test_fail_review_update BEFORE UPDATE ON feedback_autowriter_reviews
      FOR EACH ROW EXECUTE FUNCTION test_fail_review_update()`);
    try {
      await expect(recordVerdict(db, await verdictFor(wiseSessionId, {
        verdict: "needs_fix", severity: "critical", criticalCategory: "invented_content",
      }))).rejects.toBeTruthy();
    } finally {
      await db.execute(sql`DROP TRIGGER test_fail_review_update ON feedback_autowriter_reviews`);
      await db.execute(sql`DROP FUNCTION test_fail_review_update()`);
    }
    expect(await db.select().from(V)).toHaveLength(0);
    expect(await db.select().from(I)).toHaveLength(0);
    expect((await db.select().from(R))[0].currentVerdictId).toBeNull();
  });
});

describe("daily metrics", () => {
  it("counts coverage (a proven unseen class, holds as misses) and writes one daily gate row per date", async () => {
    await seedPosted(40);
    await seedPosted(41, { state: "held" });
    await db.update(S).set({ reason: "glm:unfaithful" }).where(eq(S.wiseSessionId, id24(41)));
    const tutorFirst = await seedRow(42, { state: "skipped_human", reason: "human_submission", endAt: at("2026-09-29T09:00:00Z") });
    await seedEvent(tutorFirst, at("2026-09-29T09:20:00Z"), { id: MIMI, role: "TEACHER" });
    await seedRow(43, { state: "skipped_scope", reason: "session_type_OFFLINE", endAt: at("2026-09-29T10:00:00Z") });
    await seedUnseen(44, { endAt: at("2026-09-29T11:00:00Z") });
    // D-03 (owner, 30 Sep): a hold for the class's own data (no student) is left out; the unfaithful one is a miss.
    await seedRow(45, { state: "held", reason: "student_count_0", endAt: at("2026-09-29T12:00:00Z") });
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    await ingestFixEvents(db, { apiActorId: API, since: at("2026-09-01T00:00:00Z") });

    expect(await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW })).toBe(15 * 6);
    expect(await starRow(DAY)).toMatchObject({
      liveMode: true, posted: 1, held: 1, excludedDataQuality: 1, unseen: 1, excludedTutorFirst: 1, eligible: 3, required: 1, reviewed: 0,
    });
    // Every date of the window has its row, a day without classes included.
    expect(await starRow("2026-09-20")).toMatchObject({ posted: 0, eligible: 0 });

    const gate = await recordDailyGate(db, DAY);
    expect(gate).toEqual({ date: DAY, status: "insufficient_data" });
    expect(await recordDailyGate(db, DAY)).toBeNull();
    const rows = await db.select().from(G);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ evalKind: "daily", windowStart: "2026-09-16", windowEnd: DAY, coverageNum: 1, coverageDen: 3, requiredPending: 1, unrecordedPosts: 0 });
    await expectSqlState(db.insert(G).values({ ...rows[0], id: undefined }), "23505");
  });

  it("leaves out only the holds for a class's own data and a switched-off tutor's hand-back (D-03); every other hold is a miss", async () => {
    // Ek is switched off at 16:35 UTC on the 28th, five minutes after the window of his class of the 26th closed
    // (Mimi, whose holds follow, stays on).
    await seedHistory(["2026-09-20T00:00:00Z", "live"], ["2026-09-28T16:35:00Z", "live", [EK]]);
    const endAt = at("2026-09-29T12:00:00Z");
    let n = 130;
    for (const reason of [
      "recording_too_short", "recording_multiple_parts", "speakers_unclear", "transcript_too_short", "student_count_0",
      "attendance_20pct", "student_not_wise_user", "student_id_missing",
    ]) await seedRow(n++, { state: "held", reason, endAt });
    for (const reason of [
      "glm:unfaithful:homework not in the lesson", "glm:markdown:improvement; luna:output_not_json", "feedback_form_question_unmapped",
      "billing:insufficient_student_credits", "error:fetch failed",
      // Transcript first: neither of its own holds is about the class's data.
      "thai_summary_no_transcript", "missing_student_or_tutor",
    ]) await seedRow(n++, { state: "held", reason, endAt });
    // Transcript first: waiting for the recording, or back on the summary after a fallback (whatever its cause), is
    // still in the works while the posting window is open — on neither side.
    await seedRow(n++, { state: "awaiting_recording", reason: "transcript_first", endAt });
    await seedRow(n++, { state: "pending", reason: "summary_fallback:speakers_unclear", endAt });
    // Both handed back by the sweep because Ek was switched off when it ran. The class of the 27th was workable, then
    // switched off before its window closed (23:29:59 Bangkok on the 29th): the owner's switch, not our miss. For the
    // class of the 26th Ek was still on when its window closed (23:29:59 on the 28th): ours to post, a miss.
    await seedRow(n++, { state: "skipped_scope", reason: "tutor_off_at_deadline", endAt: at("2026-09-27T12:00:00Z"), teacher: EK });
    await seedRow(n++, { state: "skipped_scope", reason: "tutor_off_at_deadline", endAt: at("2026-09-26T12:00:00Z"), teacher: EK });
    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    expect(await starRow(DAY)).toMatchObject({
      posted: 0, excludedDataQuality: 8, held: 7, pending: 2, excludedTutorOff: 0, excludedScope: 0, eligible: 7,
    });
    expect(await starRow("2026-09-27")).toMatchObject({ excludedTutorOff: 1, expired: 0, excludedScope: 0, eligible: 0 });
    expect(await starRow("2026-09-26")).toMatchObject({ excludedTutorOff: 0, expired: 1, excludedScope: 0, eligible: 1 });
  });

  it("previews in the dry run exactly the rows the job stores", async () => {
    await seedPosted(150);
    await seedRow(151, { state: "held", reason: "speakers_unclear", endAt: at("2026-09-29T10:00:00Z") });
    await seedRow(152, { state: "held", reason: "glm:unfaithful", endAt: at("2026-09-29T10:30:00Z") });
    const tutorFirst = await seedRow(153, { state: "skipped_human", reason: "human_submission", endAt: at("2026-09-29T11:00:00Z") });
    await seedEvent(tutorFirst, at("2026-09-29T11:20:00Z"), { id: MIMI, role: "TEACHER" });
    await seedUnseen(154, { endAt: at("2026-09-29T11:30:00Z") });
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    const since = at("2026-09-01T00:00:00Z");
    const classified = planFixEvents(await loadFixEventSources(db, { since }), API).classified;
    const preview = await previewDailyMetrics(db, { now: NOW, reviewTables: true, classifiedFixEvents: classified });
    await ingestFixEvents(db, { apiActorId: API, since });
    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    const keys = Object.keys(preview[0]) as Array<keyof (typeof preview)[number]>;
    const shape = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map((row) => JSON.stringify(keys.map((key) => row[key]))).toSorted();
    expect(shape(preview)).toEqual(shape(await db.select().from(M)));
    expect(preview.find((row) => row.metricDate === DAY && row.tutorKey === "*")).toMatchObject({
      posted: 1, held: 1, excludedDataQuality: 1, excludedTutorFirst: 1, unseen: 1, eligible: 3,
    });
  });

  it("still counts a class of day D that expired at 23:38 on D+2 in the run at 00:27 on D+3", async () => {
    const endAt = at("2026-09-29T12:00:00Z");
    const expiring = await seedRow(46, { state: "pending", reason: "attendance_unknown", endAt });
    // Never expired by the sweep (e.g. the autowriter is off): still pending once its window closed.
    await seedRow(47, { state: "awaiting_recording", reason: "recording_pending", endAt });
    const lastRunOfD2 = at("2026-10-01T16:27:00Z");
    await runReviewJob(deps({ now: () => lastRunOfD2 }));
    expect(await starRow(DAY)).toMatchObject({ pending: 2, expired: 0, eligible: 0 });

    await db.update(S).set({ state: "expired", reason: "deadline_passed_or_too_close" }).where(eq(S.wiseSessionId, expiring));
    const firstRunOfD3 = at("2026-10-01T17:27:00Z");
    await runReviewJob(deps({ now: () => firstRunOfD3 }));
    expect(await starRow(DAY)).toMatchObject({ pending: 0, expired: 2, eligible: 2, posted: 0 });
  });

  it("judges each class by the tutor switches and the roster during its own window, not by today's", async () => {
    await seedHistory(["2026-09-20T00:00:00Z", "live"], ["2026-09-28T00:00:00Z", "live", [MIMI]]);
    // Mimi's account was on the roster from the 20th (her earliest autowriter row).
    await seedRow(90, { state: "skipped_scope", reason: "class_type_GROUP", endAt: at("2026-09-20T05:00:00Z"), createdAt: at("2026-09-20T05:00:00Z") });
    // Window closed before she was switched off: a miss. Window entirely while she was off: hers.
    await seedUnseen(91, { endAt: at("2026-09-25T10:00:00Z") });
    await seedUnseen(92, { endAt: at("2026-09-28T10:00:00Z") });
    // Ek's account has no autowriter row: first seen by this run. A class whose window closed before then (ended on the
    // 27th: deadline the 29th) is not ours; one whose window is still open is.
    await seedUnseen(93, { teacher: EK, endAt: at("2026-09-27T02:00:00Z") });
    await seedUnseen(94, { teacher: EK, endAt: at("2026-09-29T23:00:00Z") });

    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    expect(await starRow("2026-09-25")).toMatchObject({ unseen: 1, excludedTutorOff: 0, eligible: 1 });
    expect(await starRow("2026-09-28")).toMatchObject({ unseen: 0, excludedTutorOff: 1, eligible: 0 });
    expect(await starRow("2026-09-27")).toMatchObject({ unseen: 0, excludedTutorOff: 0, eligible: 0 });
    expect(await starRow("2026-09-30")).toMatchObject({ unseen: 1, eligible: 1 });
    const roster = await db.select().from(schema.feedbackAutowriterRosterAccounts).where(eq(schema.feedbackAutowriterRosterAccounts.wiseTeacherUserId, EK));
    expect(roster[0]).toMatchObject({ tutorKey: "Ek", firstSeenAt: NOW, lastSeenAt: NOW });
  });

  it("leaves out classes the autowriter could not write because the mode was off, without a sticky live day", async () => {
    await seedHistory(["2026-09-20T00:00:00Z", "live"], ["2026-09-29T02:00:00Z", "off"]);
    await seedRow(95, { state: "skipped_scope", reason: "class_type_GROUP", endAt: at("2026-09-20T05:00:00Z"), createdAt: at("2026-09-20T05:00:00Z") });
    // Ended while live (live for an hour of its window): a miss. Ended after the switch-off: excluded.
    await seedUnseen(96, { endAt: at("2026-09-29T01:00:00Z") });
    await seedUnseen(97, { endAt: at("2026-09-29T10:00:00Z") });
    await seedRow(98, { state: "held", reason: "glm:unfaithful", endAt: at("2026-09-29T11:00:00Z") });
    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    expect(await starRow(DAY)).toMatchObject({ liveMode: true, unseen: 1, excludedNotLive: 2, held: 0, eligible: 1 });
  });

  it("counts a skipped class as the tutor's only when their save is recorded before our first writer call", async () => {
    const endAt = at("2026-09-29T12:00:00Z");
    const late = await seedRow(100, { state: "skipped_human", reason: "submission_changed_to_human", endAt });
    const first = await seedRow(101, { state: "skipped_human", reason: "human_submission", endAt });
    const waiting = await seedRow(102, { state: "skipped_human", reason: "human_submission", endAt });
    const outage = await seedRow(103, { state: "skipped_human", reason: "human_submission", endAt });
    const unmirrored = await seedRow(104, { state: "skipped_human", reason: "human_submission", endAt });
    // A judged draft was ready at 12:45; the tutor saved at 13:30: our miss.
    await seedWriterCall(late, at("2026-09-29T12:44:00Z"), true);
    await seedEvent(late, at("2026-09-29T13:30:00Z"), { id: MIMI, role: "TEACHER" });
    // The tutor saved at 13:00, before we started writing at 13:40: theirs.
    await seedWriterCall(first, at("2026-09-29T13:40:00Z"), true);
    await seedEvent(first, at("2026-09-29T13:00:00Z"), { id: MIMI, role: "TEACHER" });
    // Still waiting for the evidence when the tutor saved: theirs.
    await seedEvent(waiting, at("2026-09-29T12:30:00Z"), { id: MIMI, role: "TEACHER" });
    // A writer outage (failed calls) and the tutor wrote hours later: our miss, not a smaller denominator.
    await seedWriterCall(outage, at("2026-09-29T12:40:00Z"), false);
    await seedEvent(outage, at("2026-09-29T20:00:00Z"), { id: MIMI, role: "TEACHER" });
    // No save mirrored yet: not proven — a miss until the event arrives.
    await seedJudgeCall(unmirrored, at("2026-09-29T12:45:00Z"), true);
    await ingestFixEvents(db, { apiActorId: API, since: at("2026-09-01T00:00:00Z") });
    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    expect(await starRow(DAY)).toMatchObject({ late: 3, excludedTutorFirst: 2, eligible: 3 });
  });

  it("dates our first writer call by when its request was sent, not by when a rate-limited attempt's row was written", async () => {
    const endAt = at("2026-09-29T12:00:00Z");
    const duringWaits = await seedRow(105, { state: "skipped_human", reason: "submission_changed_to_human", endAt });
    const beforeUs = await seedRow(106, { state: "skipped_human", reason: "human_submission", endAt });
    const unmarked = await seedRow(107, { state: "skipped_human", reason: "human_submission", endAt });
    // We sent the writer's request at 12:40:00 and were rate limited; its rows were written when the call ended, after
    // the waits (12:40:45). The tutor saved at 12:40:20, while we waited: we had started, so it is our miss.
    const limited = { error: "rate limited upstream", evidence: "summary" };
    await seedWriterCall(duringWaits, at("2026-09-29T12:40:45Z"), false, { ...limited, attemptAt: "2026-09-29T12:40:00.000Z", retryAfterMs: 20_000, waitedMs: 20_000 });
    await seedWriterCall(duringWaits, at("2026-09-29T12:40:45Z"), false, { ...limited, rateLimitRetry: 1, attemptAt: "2026-09-29T12:40:21.000Z", waitedMs: 10_000 });
    await seedWriterCall(duringWaits, at("2026-09-29T12:40:45Z"), true, { validation: "ok", evidence: "summary", rateLimitRetry: 2 });
    await seedEvent(duringWaits, at("2026-09-29T12:40:20Z"), { id: MIMI, role: "TEACHER" });
    // The same rows, the tutor's save a minute before our request went out: theirs.
    await seedWriterCall(beforeUs, at("2026-09-29T12:40:45Z"), false, { ...limited, attemptAt: "2026-09-29T12:40:00.000Z", waitedMs: 4_000 });
    await seedWriterCall(beforeUs, at("2026-09-29T12:40:45Z"), true, { validation: "ok", evidence: "summary", rateLimitRetry: 1 });
    await seedEvent(beforeUs, at("2026-09-29T12:39:00Z"), { id: MIMI, role: "TEACHER" });
    // A call that was never rate limited carries no such time: dated by its row, as before.
    await seedWriterCall(unmarked, at("2026-09-29T12:40:45Z"), true, { validation: "ok", evidence: "summary" });
    await seedEvent(unmarked, at("2026-09-29T12:40:20Z"), { id: MIMI, role: "TEACHER" });
    await ingestFixEvents(db, { apiActorId: API, since: at("2026-09-01T00:00:00Z") });
    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    expect(await starRow(DAY)).toMatchObject({ late: 1, excludedTutorFirst: 2, eligible: 1 });
  });

  it("never lets an attemptAt that is no time fail the day's metrics: that call is dated by its row", async () => {
    const endAt = at("2026-09-29T12:00:00Z");
    const limited = { error: "rate limited upstream", evidence: "summary" };
    // The same class each time: one rate-limited writer call whose row was written at 12:40:45, and the tutor's save
    // at 12:40:20. Its `attemptAt` cannot be read as a time — wrong form, a day or an hour that does not exist, or no
    // text at all — so the call is dated by its row, and the save came before it: the tutor's.
    const unreadable = [
      "not a time", "", "2026-13-45T99:99:99.000Z", "2026-02-30T12:40:00.000Z", "2027-02-29T12:40:00.000Z", "2026-09-29T24:00:00.000Z",
      "2026-09-29 12:40:00", "2026-09-29T12:40:00.000+07:00", 1_790_685_600_000, null, true, { at: "2026-09-29T12:40:00.000Z" }, ["2026-09-29T12:40:00.000Z"],
    ];
    for (const [index, attemptAt] of unreadable.entries()) {
      const session = await seedRow(200 + index, { state: "skipped_human", reason: "human_submission", endAt });
      await seedWriterCall(session, at("2026-09-29T12:40:45Z"), false, { ...limited, attemptAt });
      await seedEvent(session, at("2026-09-29T12:40:20Z"), { id: MIMI, role: "TEACHER" });
    }
    // A time that can be read still counts: sent at 12:40:00, so the save at 12:40:20 came after we had started.
    const readable = await seedRow(250, { state: "skipped_human", reason: "submission_changed_to_human", endAt });
    await seedWriterCall(readable, at("2026-09-29T12:40:45Z"), false, { ...limited, attemptAt: "2026-09-29T12:40:00.000Z" });
    await seedEvent(readable, at("2026-09-29T12:40:20Z"), { id: MIMI, role: "TEACHER" });
    await ingestFixEvents(db, { apiActorId: API, since: at("2026-09-01T00:00:00Z") });
    await refreshDailyMetrics(db, { dates: metricDates(NOW), now: NOW });
    expect(await starRow(DAY)).toMatchObject({ late: 1, excludedTutorFirst: unreadable.length, eligible: 1 });
  });
});

describe("the daily gate", () => {
  const TABULATION = at("2026-09-29T15:27:00Z"); // 22:27 Bangkok on the 29th

  async function postedAndReviewed() {
    await seedPosted(110);
    await seedHistory(["2026-09-20T00:00:00Z", "live"]);
  }

  it("is not recorded after an earlier step failed; a later clean run of the day records it", async () => {
    await postedAndReviewed();
    await seedMirror(minutes(TABULATION, -10));
    const failed = await runReviewJob(deps({ apiActorId: null, now: () => TABULATION }));
    expect(failed).toMatchObject({ ok: false, dailyGate: null, dailyGateSkipped: "step_errors: fix_events" });
    expect(failed.error).toContain("WISE_USER_ID");
    expect(await db.select().from(FX)).toHaveLength(0);
    expect(await db.select().from(G)).toHaveLength(0);

    // A metrics failure (a transient error) holds the row back as well.
    await db.execute(sql`CREATE FUNCTION test_fail_metrics() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'metrics write failed'; END; $$`);
    await db.execute(sql`CREATE TRIGGER test_fail_metrics BEFORE INSERT ON feedback_autowriter_daily_metrics
      FOR EACH ROW EXECUTE FUNCTION test_fail_metrics()`);
    try {
      const metricsFailed = await runReviewJob(deps({ now: () => minutes(TABULATION, 60) }));
      expect(metricsFailed).toMatchObject({ ok: false, dailyGateSkipped: "step_errors: metrics" });
    } finally {
      await db.execute(sql`DROP TRIGGER test_fail_metrics ON feedback_autowriter_daily_metrics`);
      await db.execute(sql`DROP FUNCTION test_fail_metrics()`);
    }
    expect(await db.select().from(G)).toHaveLength(0);

    await seedMirror(minutes(TABULATION, 110));
    const clean = await runReviewJob(deps({ now: () => minutes(TABULATION, 120) }));
    expect(clean).toMatchObject({ ok: true, dailyGate: { date: DAY, status: "insufficient_data" } });
    expect(await db.select().from(G)).toMatchObject([{ bangkokDate: DAY, requiredPending: 1, unrecordedPosts: 0, coverageNum: 1, coverageDen: 1 }]);
  });

  it("is not recorded from a Wise activity sync that stopped at its page cap", async () => {
    await postedAndReviewed();
    await db.insert(schema.wiseActivitySyncRuns).values({
      status: "success", triggerType: "cron", startedAt: minutes(TABULATION, -11), finishedAt: minutes(TABULATION, -10),
      metadata: { startPage: 1, eventName: null, stoppedReason: "max_pages" },
    });
    expect(await activityMirrorStatus(db, TABULATION)).toMatchObject({ fresh: false });
    const capped = await runReviewJob(deps({ now: () => TABULATION }));
    expect(capped.dailyGateSkipped).toMatch(/^activity_mirror_incomplete/u);
    expect(await db.select().from(G)).toHaveLength(0);
  });

  it("is not recorded from a stale Wise activity mirror", async () => {
    await postedAndReviewed();
    await seedMirror(minutes(TABULATION, -120));
    const stale = await runReviewJob(deps({ now: () => TABULATION }));
    expect(stale.ok).toBe(true);
    expect(stale.dailyGateSkipped).toMatch(/^activity_mirror_stale/u);
    expect(await db.select().from(G)).toHaveLength(0);
    await seedMirror(minutes(TABULATION, 50));
    expect(await runReviewJob(deps({ now: () => minutes(TABULATION, 60) }))).toMatchObject({ ok: true, dailyGate: { date: DAY } });
  });

  it("stores the lower bound unrounded, so 87/99 never reads as the 80% it missed", async () => {
    await db.execute(sql`INSERT INTO feedback_autowriter_posts (id, wise_session_id, kind, fields, fields_sha256, billing, actor_kind, actor, outcome, provenance)
      SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '6a' || lpad(g::text, 22, '0'), 'first_shot', '{}'::jsonb, 'h', '{}'::jsonb,
        'autowriter', 'system', 'verified', 'backfill' FROM generate_series(1, 99) g`);
    await db.execute(sql`INSERT INTO feedback_autowriter_verdicts (id, wise_session_id, post_id, fields_sha256, verdict, severity, reviewer, source)
      SELECT ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '6a' || lpad(g::text, 22, '0'),
        ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'h',
        CASE WHEN g <= 87 THEN 'approve' ELSE 'needs_fix' END, CASE WHEN g <= 87 THEN NULL ELSE 'factual' END, 'owner', 'dashboard'
      FROM generate_series(1, 99) g`);
    await db.execute(sql`INSERT INTO feedback_autowriter_reviews (wise_session_id, first_post_id, tutor_key, bangkok_date, inclusion_reason,
        inclusion_probability, sample_draw, sampling_policy, current_verdict_id)
      SELECT '6a' || lpad(g::text, 22, '0'), ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Mimi', ${DAY}::date, 'new_tutor', 1, 0.5, 'v1',
        ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 99) g`);
    await recordDailyGate(db, DAY);
    const [row] = await db.select().from(G);
    expect(row.status).toBe("head_start");
    expect(row.wilsonLower).toBeLessThan(0.8);
    expect(row.reasons).toContain("accuracy lower bound 79.9% < 80% (87/99)");
    const [column] = (await db.execute(sql`SELECT data_type FROM information_schema.columns
      WHERE table_name = 'feedback_autowriter_gate_evaluations' AND column_name = 'wilson_lower'`)).rows as Array<{ data_type: string }>;
    expect(column.data_type).toBe("double precision");
  });
});

describe("incident outbox", () => {
  it("retries a failed push, never re-sends a target that has it, and gives up after the cap", async () => {
    await recordIncident(db, { dedupeKey: "critical_verdict:x", kind: "critical_verdict", severity: "critical", summary: "Critical verdict" });
    expect(await recordIncident(db, { dedupeKey: "critical_verdict:x", kind: "critical_verdict", severity: "critical", summary: "again" })).toBe(false);
    await recordIncident(db, { dedupeKey: "info:y", kind: "first_shot_unverified", severity: "info", summary: "info only" });

    const email = vi.fn<ScheduleEmailSender["sendEmail"]>().mockRejectedValueOnce(new Error("relay down")).mockResolvedValue({ id: "m" });
    const line = vi.fn().mockRejectedValueOnce(new Error("LINE 500")).mockResolvedValue({});
    const push = { emailRecipients: [OWNER], lineTo: "U123", emailSender: { sendEmail: email }, pushLine: line };

    const t0 = at("2026-09-30T03:00:00Z");
    expect(await drainIncidentOutbox(db, push, t0)).toMatchObject({ attempted: 1, sent: 0, stillPending: 1 });
    // Not due again until the retry time.
    expect(await drainIncidentOutbox(db, push, minutes(t0, 1))).toMatchObject({ attempted: 0 });
    const t1 = minutes(t0, 31);
    expect(await drainIncidentOutbox(db, push, t1)).toMatchObject({ attempted: 1, sent: 1 });
    const [critical] = await db.select().from(I).where(eq(I.kind, "critical_verdict"));
    expect(critical).toMatchObject({ pushStatus: "sent", pushAttempts: 2, lastPushError: null });
    expect(critical.pushedChannels.toSorted()).toEqual([`email:${OWNER}`, "line:U123"]);
    expect(email).toHaveBeenCalledTimes(2);
    expect(line).toHaveBeenCalledTimes(2);
    expect(line).toHaveBeenLastCalledWith(expect.objectContaining({ to: "U123", retryKey: critical.id, signal: expect.any(AbortSignal) }));

    await recordIncident(db, { dedupeKey: "api_actor_unmatched:z", kind: "api_actor_unmatched", severity: "critical", summary: "Unmatched" });
    const broken = { emailRecipients: [OWNER], lineTo: null, emailSender: { sendEmail: vi.fn(async () => { throw new Error("down"); }) } };
    let when = t1.getTime();
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
      when += 31 * 60_000;
      await drainIncidentOutbox(db, broken, new Date(when));
    }
    expect((await db.select().from(I).where(eq(I.kind, "api_actor_unmatched")))[0]).toMatchObject({ pushStatus: "failed", pushAttempts: MAX_PUSH_ATTEMPTS });

    await recordIncident(db, { dedupeKey: "critical_flag:w", kind: "critical_flag", severity: "critical", summary: "No channel" });
    expect(await drainIncidentOutbox(db, { emailRecipients: [], lineTo: null }, new Date(when))).toMatchObject({ attempted: 0, stillPending: 1 });
  });

  it("never re-sends to a recipient that already has the alert when another recipient fails", async () => {
    await recordIncident(db, { dedupeKey: "critical_verdict:two", kind: "critical_verdict", severity: "critical", summary: "Critical" });
    const sendEmail = vi.fn<ScheduleEmailSender["sendEmail"]>(async (input) => {
      if (input.to === "second@example.com" && sendEmail.mock.calls.length <= 2) throw new Error("recipient quota");
      return { id: "m" };
    });
    const push = { emailRecipients: ["First@Example.com", "second@example.com"], lineTo: null, emailSender: { sendEmail } };
    expect(await drainIncidentOutbox(db, push, NOW)).toMatchObject({ attempted: 1, stillPending: 1 });
    expect(await drainIncidentOutbox(db, push, minutes(NOW, 31))).toMatchObject({ attempted: 1, sent: 1 });
    expect(sendEmail.mock.calls.map(([input]) => input.to)).toEqual(["first@example.com", "second@example.com", "second@example.com"]);
    expect((await db.select().from(I))[0].pushedChannels.toSorted()).toEqual(["email:first@example.com", "email:second@example.com"]);
  });

  it("does not start a push the function's time budget cannot finish, and bounds the LINE push", async () => {
    await recordIncident(db, { dedupeKey: "critical_verdict:late", kind: "critical_verdict", severity: "critical", summary: "Critical" });
    const sendEmail = vi.fn(async () => ({ id: "m" }));
    const pushLine = vi.fn(async () => ({}));
    const push = { emailRecipients: [OWNER], lineTo: "U1", emailSender: { sendEmail }, pushLine };
    expect(await drainIncidentOutbox(db, push, NOW, { deadlineMs: Date.now() + 5_000 })).toMatchObject({ attempted: 0, deferred: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await db.select().from(I))[0]).toMatchObject({ pushStatus: "pending", pushAttempts: 0 });
    expect(await drainIncidentOutbox(db, push, NOW, { deadlineMs: Date.now() + 10 * 60_000 })).toMatchObject({ attempted: 1, sent: 1 });
    const [lineCall] = pushLine.mock.calls[0] as unknown as [{ signal?: AbortSignal }];
    expect(lineCall.signal).toBeInstanceOf(AbortSignal);
  });

  it("counts a due critical incident nobody tried yet as undelivered (a run's batch or budget ran out)", async () => {
    await recordIncident(db, { dedupeKey: "critical_flag:untried", kind: "critical_flag", severity: "critical", summary: "Untried" });
    expect(await countUndeliveredCritical(db, NOW)).toBe(1);
    await db.update(I).set({ nextPushAt: minutes(NOW, 30) });
    expect(await countUndeliveredCritical(db, NOW)).toBe(0);
  });

  it("keeps the review job red while a critical incident is undelivered, until the owner acknowledges it", async () => {
    await recordIncident(db, { dedupeKey: "critical_verdict:q", kind: "critical_verdict", severity: "critical", summary: "Critical" });
    const broken = channels({ emailSender: { sendEmail: vi.fn(async () => { throw new Error("down"); }) } });
    let when = NOW.getTime();
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt += 1) {
      when += 61 * 60_000;
      await runReviewJob(deps({ now: () => new Date(when), channels: broken }));
    }
    expect((await db.select().from(I))[0]).toMatchObject({ pushStatus: "failed" });
    // The push gave up; the next run must still say so (it used to go green here).
    const after = await runReviewJob(deps({ now: () => new Date(when + 61 * 60_000), channels: broken }));
    expect(after.ok).toBe(false);
    expect(after.undeliveredCritical).toBe(1);
    expect(after.error).toContain("Critical incident push not delivered");

    const [incident] = await db.select().from(I);
    expect(await acknowledgeIncident(db, { incidentId: incident.id, actor: OWNER })).toMatchObject({ id: incident.id, acknowledgedBy: OWNER });
    expect(await acknowledgeIncident(db, { incidentId: "33333333-3333-4333-8333-333333333333", actor: OWNER })).toBeNull();
    const cleared = await runReviewJob(deps({ now: () => new Date(when + 122 * 60_000), channels: broken }));
    expect(cleared).toMatchObject({ ok: true, undeliveredCritical: 0 });
  });
});

describe("runReviewJob", () => {
  it("is single-flight, takes over an abandoned run, and records the whole pass", async () => {
    await db.insert(RUNS).values({ triggerSource: "cron" });
    expect(await runReviewJob(deps())).toMatchObject({ ok: true, skipped: true });

    await db.update(RUNS).set({ startedAt: new Date(Date.now() - 20 * 60_000) });
    const seeded = await seedPosted(60);
    await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
    await seedMirror(minutes(NOW, -5));
    const result = await runReviewJob(deps());
    expect(result).toMatchObject({
      ok: true, firstShots: { recorded: 1, unverified: 0 }, fixEvents: { inserted: 1 }, reviewsCreated: 1,
      dailyGate: { date: DAY, status: "insufficient_data" }, metricRows: 15 * 6,
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

describe("day-one backfill", () => {
  const RENAMED = { ...FIELDS, performance: "Alex spotted reflections quickly." };

  async function renamedRow(n: number) {
    const seeded = await seedPosted(n, {
      stored: RENAMED,
      metadata: { nicknameFix: { from: "Alexander", to: "Alex", at: "2026-09-29T13:26:11.505Z", by: "owner@example.com (one-time fix)" } },
    });
    await seedEvent(seeded.wiseSessionId, seeded.verifiedAt, { id: API, role: "OWNER" });
    await seedEvent(seeded.wiseSessionId, at("2026-09-29T13:26:07.299Z"), { id: API, role: "OWNER" });
    const [row] = await db.select().from(S).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    return row;
  }

  it("records each re-post once, even when the plan is applied twice or by two runs at once", async () => {
    const row = await renamedRow(120);
    const plan = planReviewBackfill([{ row, pcFirstVersion: null, hasFirstShot: false, recordedDedupeKeys: new Set() }]);
    expect(plan.firstShots[0]?.method).toBe("reverse_rename");
    expect(plan.corrections).toHaveLength(1);
    await Promise.all([applyReviewBackfillPlan(db, plan), applyReviewBackfillPlan(db, plan)]);
    expect(await applyReviewBackfillPlan(db, plan)).toEqual({ firstShots: 0, corrections: 0, incidents: 0 });
    const posts = await db.select().from(P).where(eq(P.wiseSessionId, row.wiseSessionId));
    expect(posts.map((post) => [post.kind, post.dedupeKey]).toSorted()).toEqual([
      ["policy", `nickname-fix:${row.wiseSessionId}`], ["first_shot", null],
    ].toSorted());
  });

  it("never counts the nickname re-post as a fix (D-01): not in the fix count, the fix rounds or the corrections", async () => {
    const row = await renamedRow(122);
    await applyReviewBackfillPlan(db, planReviewBackfill([{ row, pcFirstVersion: null, hasFirstShot: false, recordedDedupeKeys: new Set() }]));
    await assignReviews(db, { now: NOW });
    const since = at("2026-09-01T00:00:00Z");
    await ingestFixEvents(db, { apiActorId: API, since });
    expect((await db.select().from(FX).orderBy(FX.eventAt)).map((event) => [event.actorKind, event.countsAsFix, event.postId !== null]))
      .toEqual([["autowriter_first", false, true], ["autowriter_policy", false, true]]);
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 0, incidents: 0 });
    await refreshReviewCounts(db, { sinceDate: "2026-09-01" });
    expect((await db.select().from(R))[0]).toMatchObject({ measuredFixCount: 0, measuredFixesByActor: {}, correctionsVerified: 0 });
  });

  it("previews exactly what the job stores — also when run again after --apply", async () => {
    const row = await renamedRow(121);
    const plan = planReviewBackfill([{ row, pcFirstVersion: null, hasFirstShot: false, recordedDedupeKeys: new Set() }]);
    const since = at("2026-09-01T00:00:00Z");
    const preview = async () => planFixEvents(await loadFixEventSources(db, { since }), API).classified
      .map((event) => [event.wiseEventId, event.actorKind, event.countsAsFix]).toSorted();
    const before = await preview();
    expect(before.map(([, kind]) => kind).toSorted()).toEqual(["autowriter_first", "autowriter_policy"]);
    await applyReviewBackfillPlan(db, plan);
    await ingestFixEvents(db, { apiActorId: API, since });
    const stored = (await db.select().from(FX)).map((event) => [event.wiseEventId, event.actorKind, event.countsAsFix]).toSorted();
    // The same classification before --apply, after it, and in the table: never "unmatched" for a recorded class.
    expect(stored).toEqual(before);
    expect(await preview()).toEqual(before);
  });
});

describe("owner verdicts from the 30 Sep interview", () => {
  // Synthetic ids and words; the committed file (scripts/feedback-autowriter-owner-verdicts.json) names the real classes.
  const REVIEWER = "owner@example.com (owner interview 2026-09-30)";
  const decisions = (): OwnerVerdicts => ({
    decidedAt: at("2026-09-30T02:30:00Z"),
    reviewer: REVIEWER,
    verdicts: [
      { wiseSessionId: id24(140), verdict: "needs_fix", severity: "critical", criticalCategory: "wrong_person", note: "synthetic: another student's work — owner, 30 Sep interview" },
      { wiseSessionId: id24(141), verdict: "needs_fix", severity: "factual", criticalCategory: null, note: "synthetic: false homework claim — owner, 30 Sep interview" },
    ],
  });

  /** Two classes of 29 Sep (20:00 and 21:00 Bangkok), posted and recorded by the backfill, with their review rows. */
  async function backfilled() {
    await seedPosted(140, { endAt: at("2026-09-29T13:00:00Z") });
    await seedPosted(141, { endAt: at("2026-09-29T14:00:00Z") });
    const rows = await db.select().from(S);
    await applyReviewBackfillPlan(db, planReviewBackfill(rows.map((row) => ({ row, pcFirstVersion: null, hasFirstShot: false, recordedDedupeKeys: new Set<string>() }))));
    await assignReviews(db, { now: NOW });
  }

  it("records each decision once, as the owner, pinned to the first shot — also applied twice or by two runs at once", async () => {
    await backfilled();
    // A flag the owner had seen by the interview is answered by the decision.
    await db.insert(FL).values({ wiseSessionId: id24(141), source: "measured_fix", createdBy: "system", idempotencyKey: "seen-flag", createdAt: at("2026-09-29T20:00:00Z") });
    const runs = await Promise.all([applyOwnerVerdicts(db, decisions()), applyOwnerVerdicts(db, decisions())]);
    expect(runs.flatMap((run) => run.recorded).toSorted()).toEqual([id24(140), id24(141)]);
    expect(runs.flatMap((run) => run.alreadyRecorded).toSorted()).toEqual([id24(140), id24(141)]);
    expect(runs.flatMap((run) => run.skipped)).toEqual([]);
    expect(await applyOwnerVerdicts(db, decisions())).toEqual({ recorded: [], alreadyRecorded: [id24(140), id24(141)], skipped: [] });

    const verdicts = await db.select().from(V).orderBy(V.wiseSessionId);
    const firstShots = new Map((await db.select().from(P).where(eq(P.kind, "first_shot"))).map((post) => [post.wiseSessionId, post]));
    expect(verdicts.map((row) => [row.wiseSessionId, row.verdict, row.severity, row.criticalCategory, row.reviewer, row.source, row.postId, row.fieldsSha256]))
      .toEqual([
        [id24(140), "needs_fix", "critical", "wrong_person", REVIEWER, "backfill", firstShots.get(id24(140))!.id, firstShots.get(id24(140))!.fieldsSha256],
        [id24(141), "needs_fix", "factual", null, REVIEWER, "backfill", firstShots.get(id24(141))!.id, firstShots.get(id24(141))!.fieldsSha256],
      ]);
    expect(verdicts.map((row) => row.note)).toEqual(decisions().verdicts.map((entry) => entry.note));
    const reviews = await db.select().from(R).orderBy(R.wiseSessionId);
    expect(reviews.map((row) => row.currentVerdictId)).toEqual(verdicts.map((row) => row.id));
    expect((await db.select().from(FL))[0].resolvedByVerdictId).toBe(verdicts[1].id);
    expect(await db.select().from(I).where(eq(I.kind, "critical_verdict"))).toMatchObject([{ wiseSessionId: id24(140), severity: "critical" }]);
  });

  it("leaves a class to the dashboard when it has another verdict, or a flag raised after the decision", async () => {
    await backfilled();
    await recordVerdict(db, await verdictFor(id24(140), { verdict: "approve" }));
    await db.insert(FL).values({ wiseSessionId: id24(141), source: "measured_fix", createdBy: "system", idempotencyKey: "news", createdAt: at("2026-09-30T07:00:00Z") });
    const result = await applyOwnerVerdicts(db, decisions());
    expect(result.recorded).toEqual([]);
    expect(result.skipped.map((entry) => entry.wiseSessionId)).toEqual([id24(140), id24(141)]);
    expect(result.skipped[0].reason).toContain("already has a verdict by owner@example.com");
    expect(result.skipped[1].reason).toContain("flag raised after the decision");
    expect(await db.select().from(V)).toHaveLength(1);
  });

  it("blocks expansion with the 29 Sep critical until the 13 Oct gate: every window holding 29 Sep is blocked_critical", async () => {
    await backfilled();
    await applyOwnerVerdicts(db, decisions());
    const gateOn = async (date: string) => evaluateGate(await loadGateFacts(db, gateWindow(date)));
    expect(await gateOn("2026-09-29")).toMatchObject({ status: "blocked_critical" });
    const last = await gateOn("2026-10-12");
    expect(gateWindow("2026-10-12")).toEqual({ start: "2026-09-29", end: "2026-10-12" });
    expect(last.status).toBe("blocked_critical");
    expect(last.reasons).toContain("1 critical verdict(s) in the window");
    const clear = await gateOn("2026-10-13");
    expect(clear.status).not.toBe("blocked_critical");
    expect(clear.reasons.join(" ")).not.toContain("critical");
    // The nightly rows say the same.
    expect(await recordDailyGate(db, "2026-10-12")).toEqual({ date: "2026-10-12", status: "blocked_critical" });
    expect((await recordDailyGate(db, "2026-10-13"))?.status).not.toBe("blocked_critical");
  });
});

describe("loadAutowriterReview", () => {
  it("shows every flagged and unreviewed class whatever the limit, with exact totals and the job's own gate", async () => {
    await seedPosted(130, { endAt: at("2026-08-10T08:00:00Z") });
    await seedPosted(131, { endAt: at("2026-09-28T08:00:00Z") });
    await seedPosted(132, { endAt: at("2026-09-29T08:00:00Z") });
    await snapshotFirstShots(db);
    await assignReviews(db, { now: NOW });
    await recordVerdict(db, await verdictFor(id24(130), { verdict: "approve" }));
    await recordVerdict(db, await verdictFor(id24(131), { verdict: "approve" }));
    // A flag on the old, reviewed class keeps it in the queue.
    await db.insert(FL).values({ wiseSessionId: id24(130), source: "measured_fix", createdBy: "system", idempotencyKey: "old-flag" });

    const review = await loadAutowriterReview(db, { now: NOW, queueLimit: 1 });
    if (!review.available) throw new Error("review unavailable");
    expect(review.queue.map((item) => item.wiseSessionId).toSorted()).toEqual([id24(130), id24(132)]);
    expect(review.queueTotals).toEqual({ needsReview: 1, flagged: 1, all: 3, shown: 2 });
    const facts = await loadGateFacts(db, { start: review.window.start, end: review.window.end });
    expect(review.gate).toMatchObject(facts);
  });

  it("says the review tables are missing as a typed payload, and lets any other error through", async () => {
    await db.execute(sql`ALTER TABLE feedback_autowriter_reviews RENAME TO feedback_autowriter_reviews_hidden`);
    try {
      expect(await loadAutowriterReview(db, { now: NOW })).toEqual({ available: false, reason: "review_tables_missing" });
    } finally {
      await db.execute(sql`ALTER TABLE feedback_autowriter_reviews_hidden RENAME TO feedback_autowriter_reviews`);
    }
    // A different failure (here an undefined column, 42703) is not "missing tables" and must not look like it.
    await db.execute(sql`ALTER TABLE feedback_autowriter_reviews RENAME COLUMN tutor_key TO tutor_key_hidden`);
    try {
      await expect(loadAutowriterReview(db, { now: NOW })).rejects.toBeTruthy();
    } finally {
      await db.execute(sql`ALTER TABLE feedback_autowriter_reviews RENAME COLUMN tutor_key_hidden TO tutor_key`);
    }
  });
});
