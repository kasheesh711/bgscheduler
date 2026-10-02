import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import type { FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import {
  AGENT_CORRECTION_ACTOR,
  CORRECTION_EVENT_WAIT_MS,
  CORRECTION_LOCK_BUDGET_MS,
  CORRECTION_READ_BACK_DELAY_MS,
  CORRECTION_READ_RETRY_INTERVAL_MS,
  CORRECTION_READ_RETRY_WINDOW_MS,
  CorrectionRefusedError,
  agentCorrectionDedupeKey,
  correctPostGuarded,
  type CorrectionPlan,
  type CorrectionStore,
} from "../correction";
import {
  CORRECTION_DAILY_CAP,
  CORRECTION_LOCK_LEASE_MS,
  CORRECTION_LOCK_SETTLE_MS,
  CORRECTION_STALE_AFTER_MS,
  correctionLockReason,
  isCorrectionLockReason,
  pgCorrectionStore,
  recoverStaleCorrections,
  releaseStaleCorrectionLock,
} from "../correction-store";
import { ingestFixEvents } from "../fix-events";
import { processSession, runSweep, type AutowriterDeps } from "../job";
import { assignReviews, raiseFixFlags, refreshReviewCounts, snapshotFirstShots } from "../review-job";
import { AUTOWRITER_TEACHER_ALLOWLIST, KEVIN_ONLINE_WISE_USER_ID } from "../roster";
import { buildFeedbackPostBody } from "../session";
import {
  acquireSweepLease,
  claimGeneration,
  ensureSessionRow,
  haltAutowriter,
  readControl,
  readSessionRow,
  releaseSweepLease,
  sessionSubmitStore,
  updateControl,
} from "../store";
import { feedbackBodyHash, fieldsHash, type WiseFeedbackOps } from "../submit";
import type { BillingPlan } from "../types";
import { AI_SUSPECT, API_ACTOR, BASE, CORRECTED, STANDARD_ORDER, clock, fakeWise, postedDetail, save } from "./correction-fixtures";
import { CLASS_ID, SESSION_ID, STUDENT_ID, SUBMISSION_ID } from "./fixtures";

// Synthetic ids and invented lesson text only. The roster teacher id is the code roster's (the claim checks it).
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const P = schema.feedbackAutowriterPosts;
const R = schema.feedbackAutowriterReviews;
const V = schema.feedbackAutowriterVerdicts;
const FL = schema.feedbackAutowriterFlags;
const FX = schema.feedbackAutowriterFixEvents;
const I = schema.feedbackAutowriterIncidents;
const C = schema.feedbackAutowriterControl;
const CH = schema.feedbackAutowriterControlHistory;

const TEACHER = KEVIN_ONLINE_WISE_USER_ID;
const OWNER = "owner@example.com";
const BILLING: BillingPlan = { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 };
const OTHER_TEXT: FeedbackFieldAnswers = { ...BASE, improvement: `${BASE.improvement} Keep a list of the slips made.` };
const noSleep = async () => {};

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

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof CorrectionRefusedError) return error.reason;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A class the autowriter posted and verified (its body_hash pins `BASE`), ended 2 h ago so its deadline is far. */
async function seedPosted(options: { wiseSessionId?: string; wiseClassId?: string } = {}) {
  const wiseSessionId = options.wiseSessionId ?? SESSION_ID;
  const wiseClassId = options.wiseClassId ?? CLASS_ID;
  const endAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const postStartedAt = new Date(endAt.getTime() + 40 * 60 * 1000);
  const verifiedAt = new Date(postStartedAt.getTime() + 90);
  await db.insert(S).values({
    wiseSessionId,
    wiseClassId,
    wiseTeacherUserId: TEACHER,
    scheduledEndAt: endAt,
    deadlineAt: calculateFeedbackDeadline(endAt),
    state: "verified",
    reason: "verified",
    arm: "sol",
    fields: BASE,
    fieldsSha256: fieldsHash(BASE),
    billing: BILLING as unknown as Record<string, unknown>,
    bodyHash: feedbackBodyHash(buildFeedbackPostBody({ fieldOrder: STANDARD_ORDER }, BASE, BILLING)),
    postStartedAt,
    verifiedEvent: { at: verifiedAt.toISOString(), actorId: API_ACTOR, actorRole: "OWNER", autoSubmitted: false },
    metadata: {
      expected: { kind: "auto_blank", submissionId: SUBMISSION_ID },
      post: { postFinishedAt: new Date(postStartedAt.getTime() + 150).toISOString() },
    },
  });
  return { wiseSessionId, wiseClassId, postStartedAt, verifiedAt };
}

type Seeded = Awaited<ReturnType<typeof seedPosted>>;

function planFor(seeded: Seeded, overrides: Partial<CorrectionPlan> = {}): CorrectionPlan {
  return {
    wiseSessionId: seeded.wiseSessionId,
    wiseClassId: seeded.wiseClassId,
    wiseTeacherUserId: TEACHER,
    base: { fields: BASE, fieldsSha256: fieldsHash(BASE), submissionId: SUBMISSION_ID, billing: BILLING, firstShotPostedAt: seeded.postStartedAt },
    fields: CORRECTED,
    fieldsSha256: fieldsHash(CORRECTED),
    reason: "performance_misstated: synthetic",
    rootCauseRef: "synthetic-root-cause-1",
    pipeline: { promptVersion: 9 },
    evidence: "transcript",
    arm: "sol",
    mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS,
    ...overrides,
  };
}

/** A posted class with its first shot recorded by the review job's own snapshot. */
async function postedWithFirstShot(options: { wiseSessionId?: string; wiseClassId?: string } = {}) {
  const seeded = await seedPosted(options);
  expect((await snapshotFirstShots(db)).unverified).toEqual([]);
  return seeded;
}

const store = (sleep: (ms: number) => Promise<void> = noSleep, now?: () => Date): CorrectionStore =>
  pgCorrectionStore(db, { actor: AGENT_CORRECTION_ACTOR, sleep, now });

const dbNow = async () => new Date((await db.execute(sql`select now() as now`)).rows[0].now as string | Date);

async function lockOrThrow(correctionStore: CorrectionStore, plan: CorrectionPlan) {
  const locked = await correctionStore.lock(plan);
  if (!locked.ok) throw new Error(`lock refused: ${locked.reason}`);
  return locked.lock;
}

/** Whether a sweep could take the lease now (taken and given straight back). */
async function leaseFree(): Promise<boolean> {
  const token = await acquireSweepLease(db, 1_000);
  if (token) await releaseSweepLease(db, token);
  return token !== null;
}

async function insertPostingSession(n: number, postStartedAt = new Date()) {
  await db.insert(S).values({
    wiseSessionId: id24(n), wiseClassId: id24(n + 500), wiseTeacherUserId: TEACHER, state: "posting", reason: "posting",
    deadlineAt: new Date(Date.now() + 86_400_000), postStartedAt,
  });
}

async function insertInFlightCorrection(n: number, outcome: "posting" | "awaiting_event", postStartedAt = new Date()) {
  await db.insert(P).values({
    wiseSessionId: id24(n), kind: "correction", fields: BASE, fieldsSha256: fieldsHash(BASE), billing: BILLING as unknown as Record<string, unknown>,
    actorKind: "agent", actor: AGENT_CORRECTION_ACTOR, reason: "synthetic", outcome, provenance: "live",
    postStartedAt, dedupeKey: agentCorrectionDedupeKey(id24(n)),
  });
}

/** The run that holds the lock is gone (or asleep): its lease ran out. */
async function leaseRunOut() {
  await db.update(C).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(C.id, "default"));
}

/** Agent corrections of other classes, posted `hoursAgo` (settled with `outcome`). */
async function insertAgentCorrections(count: number, options: { outcome?: "verified" | "not_sent" | "verify_failed"; hoursAgo?: number; from?: number } = {}) {
  const at = new Date(Date.now() - (options.hoursAgo ?? 1) * 3_600_000);
  for (let index = 0; index < count; index += 1) {
    const sid = id24((options.from ?? 200) + index);
    await db.insert(P).values({
      wiseSessionId: sid, kind: "correction", fields: BASE, fieldsSha256: fieldsHash(BASE), billing: BILLING as unknown as Record<string, unknown>,
      actorKind: "agent", actor: AGENT_CORRECTION_ACTOR, reason: "synthetic", outcome: options.outcome ?? "verified", provenance: "live",
      postStartedAt: at, recordedAt: at, settledAt: at, dedupeKey: agentCorrectionDedupeKey(sid),
    });
  }
}

async function seedActivity(sessionId: string, at: Date, actorId: string, actorRole = "OWNER") {
  await db.insert(schema.wiseActivityEvents).values({
    eventId: `evt-${sessionId.slice(-4)}-${at.getTime()}`,
    eventName: "SessionFeedbackSubmittedEvent",
    eventTimestamp: at,
    actorWiseUserId: actorId,
    actorRole,
    sessionId,
    payload: { session: { id: sessionId } },
  });
}

function sweepDeps(): AutowriterDeps {
  return {
    db,
    // Never reached: the sweep and the webhook path stop before any Wise call.
    ops: {} as unknown as WiseFeedbackOps,
    apiKey: null,
    apiActorId: API_ACTOR,
    writesAllowedHere: true,
    deadlineMs: Date.now() + 60_000,
  };
}

/**
 * A start inside this hour's correction window (minute 11 UTC) for the executor's clock — up to 49 min off the
 * database's, which the store's clock (real time) is checked against. Deadlines are a day or more away either side.
 */
function windowStart(): Date {
  const start = new Date();
  start.setUTCMinutes(11, 0, 0);
  return start;
}

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_incidents, feedback_autowriter_fix_events, feedback_autowriter_flags,
    feedback_autowriter_reviews, feedback_autowriter_verdicts, feedback_autowriter_posts, feedback_autowriter_sessions,
    feedback_autowriter_control_history, feedback_autowriter_roster_accounts, feedback_autowriter_calls,
    wise_activity_events, wise_webhook_events RESTART IDENTITY CASCADE`);
  await db.execute(sql`UPDATE feedback_autowriter_control SET mode = 'live', halted_at = NULL, halt_reason = NULL,
    disabled_tutors = '[]'::jsonb, lease_token = NULL, lease_until = NULL`);
});

describe("the correction lock", () => {
  it("leases the sweep for longer than the longest run, with five minutes to spare", () => {
    const longestRun = CORRECTION_LOCK_BUDGET_MS + CORRECTION_READ_BACK_DELAY_MS + CORRECTION_READ_RETRY_WINDOW_MS +
      CORRECTION_READ_RETRY_INTERVAL_MS + CORRECTION_EVENT_WAIT_MS + 60_000;
    expect(CORRECTION_LOCK_LEASE_MS).toBeGreaterThanOrEqual(longestRun + 5 * 60_000);
  });

  it("stops the real POST claim, the sweep and the webhook path while held; release restores them", async () => {
    const seeded = await postedWithFirstShot();
    // Another class waiting for its first POST: a worker holding its generation lease.
    const other = id24(90);
    await ensureSessionRow(db, {
      wiseSessionId: other, wiseClassId: id24(590), wiseTeacherUserId: TEACHER,
      scheduledEndAt: new Date(Date.now() - 3_600_000), deadlineAt: new Date(Date.now() + 86_400_000), trigger: "test",
    });
    const token = (await claimGeneration(db, other, 300_000))!;
    const claim = {
      bodyHash: "b", fieldsSha256: fieldsHash(BASE), fields: BASE, billing: BILLING, arm: "sol" as const, teacherId: TEACHER, freshReadAt: new Date(),
    };
    const history = await db.select().from(CH);
    const sleep = vi.fn(noSleep);

    const lock = await lockOrThrow(store(sleep), planFor(seeded));
    expect(sleep).toHaveBeenCalledWith(CORRECTION_LOCK_SETTLE_MS);
    const control = await readControl(db);
    expect(control.haltedAt).not.toBeNull();
    expect(control.haltReason).toBe(correctionLockReason(control.leaseToken!, seeded.wiseSessionId));
    expect(isCorrectionLockReason(control.haltReason)).toBe(true);
    expect(control.updatedBy).toBe(AGENT_CORRECTION_ACTOR);

    expect(await sessionSubmitStore(db, other, token).claimPost(claim)).toEqual({ claimed: false, reason: "conditions" });
    expect(await acquireSweepLease(db, 60_000)).toBeNull();
    expect(await runSweep(sweepDeps())).toMatchObject({ ok: true, skipped: true, reason: "Another autowriter sweep holds the lease." });
    expect((await processSession(sweepDeps(), { wiseSessionId: id24(91), trigger: "webhook" })).result).toBe("halted");
    // A halt is no mode or tutor-switch change: coverage's control history gets no row.
    expect(await db.select().from(CH)).toEqual(history);

    expect(await lock.release()).toBe(true);
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
    expect(await leaseFree()).toBe(true);
    expect(await db.select().from(CH)).toEqual(history);
    expect(await sessionSubmitStore(db, other, token).claimPost(claim)).toEqual({ claimed: true });
  });

  it.each([[20_000], [-20_000]])("is refused when this machine's clock is %i ms off the database's — leaving nothing behind", async (ms) => {
    const plan = planFor(await postedWithFirstShot());
    expect(await store(noSleep, () => new Date(Date.now() + ms)).lock(plan)).toEqual({ ok: false, reason: "clock_skew" });
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
    expect(await leaseFree()).toBe(true);
  });

  it("is taken when this machine's clock is within the tolerance of the database's", async () => {
    const lock = await lockOrThrow(store(noSleep, () => new Date(Date.now() + 500)), planFor(await postedWithFirstShot()));
    expect(await lock.release()).toBe(true);
  });

  it("reads the database clock", async () => {
    const before = await dbNow();
    const at = await store().databaseNow();
    expect(at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(at.getTime()).toBeLessThanOrEqual((await dbNow()).getTime());
  });

  it("is refused while halted, not live, a sweep holds the lease, or any POST is unsettled — leaving nothing behind", async () => {
    const plan = planFor(await postedWithFirstShot());

    await haltAutowriter(db, "synthetic anomaly");
    expect(await store().lock(plan)).toEqual({ ok: false, reason: "not_live_or_halted" });
    expect(await readControl(db)).toMatchObject({ haltReason: "synthetic anomaly" });
    expect(await leaseFree()).toBe(true);
    await updateControl(db, { haltedAt: null, haltReason: null }, OWNER);

    await updateControl(db, { mode: "shadow" }, OWNER);
    expect(await store().lock(plan)).toEqual({ ok: false, reason: "not_live_or_halted" });
    expect(await leaseFree()).toBe(true);
    await updateControl(db, { mode: "live" }, OWNER);

    const sweep = (await acquireSweepLease(db, 60_000))!;
    expect(await store().lock(plan)).toEqual({ ok: false, reason: "sweep_running" });
    expect(await readControl(db)).toMatchObject({ haltedAt: null });
    await releaseSweepLease(db, sweep);

    await insertPostingSession(92);
    expect(await store().lock(plan)).toEqual({ ok: false, reason: "post_in_flight" });
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
    expect(await leaseFree()).toBe(true);
    await db.update(S).set({ state: "verified" }).where(eq(S.wiseSessionId, id24(92)));

    await insertInFlightCorrection(93, "awaiting_event");
    expect(await store().lock(plan)).toEqual({ ok: false, reason: "post_in_flight" });
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
    expect(await leaseFree()).toBe(true);
  });

  const notHeld: Array<[string, () => Promise<unknown>]> = [
    ["its lease ran out", leaseRunOut],
    ["an owner pause on top", () => haltAutowriter(db, `paused by ${OWNER}: stop`, OWNER)],
    ["an owner resume", () => updateControl(db, { haltedAt: null, haltReason: null }, OWNER)],
    ["a switch out of live", () => updateControl(db, { mode: "shadow" }, OWNER)],
    ["the tutor switched off", () => updateControl(db, { disabledTutors: [TEACHER] }, OWNER)],
  ];
  it.each(notHeld)("is no longer held (the last check before the POST) after %s", async (_name, change) => {
    const lock = await lockOrThrow(store(), planFor(await postedWithFirstShot()));
    expect(await lock.isHeld()).toBe(true);
    await change();
    expect(await lock.isHeld()).toBe(false);
  });

  it("never lifts a halt folded into the lock reason (its text already in it) — nor does the stale-lock release", async () => {
    const lock = await lockOrThrow(store(), planFor(await postedWithFirstShot()));
    const reason = (await readControl(db)).haltReason;
    // haltAutowriter keeps a reason that already contains the new one: the halt is recorded, the text unchanged.
    await haltAutowriter(db, "auto-released", OWNER);
    expect((await readControl(db)).haltReason).toBe(reason);
    expect(await lock.release()).toBe(false);
    expect((await readControl(db)).haltedAt).not.toBeNull();
    expect(await leaseFree()).toBe(true);
    expect(await releaseStaleCorrectionLock(db)).toBe(false);
    expect((await readControl(db)).haltedAt).not.toBeNull();
  });

  it("never lifts a lock reason that carries \" | then: \", even its own", async () => {
    const seeded = await postedWithFirstShot();
    const lock = await lockOrThrow(store(), planFor(seeded, { wiseSessionId: `${seeded.wiseSessionId} | then: paused by ${OWNER}` }));
    expect((await readControl(db)).haltReason).toContain(" | then: ");
    expect(await lock.release()).toBe(false);
    expect((await readControl(db)).haltedAt).not.toBeNull();
  });

  it("never lifts an owner pause made while it is held — nor does the stale-lock release", async () => {
    const lock = await lockOrThrow(store(), planFor(await postedWithFirstShot()));
    await haltAutowriter(db, `paused by ${OWNER}: checking a class`, OWNER);
    expect(await lock.release()).toBe(false);
    const control = await readControl(db);
    expect(control.haltedAt).not.toBeNull();
    expect(control.haltReason).toMatch(/^correction-lock:.* \| then: paused by owner@example\.com: checking a class$/u);
    expect(isCorrectionLockReason(control.haltReason)).toBe(false);
    expect(await leaseFree()).toBe(true);
    expect(await releaseStaleCorrectionLock(db)).toBe(false);
    expect((await readControl(db)).haltedAt).not.toBeNull();
  });
});

describe("the posts-row claim (recordPostStart)", () => {
  it("records the correction before the POST: its shape on the database clock, the session row untouched", async () => {
    const seeded = await postedWithFirstShot();
    const plan = planFor(seeded);
    const correctionStore = store();
    await lockOrThrow(correctionStore, plan);
    const sessionBefore = await readSessionRow(db, seeded.wiseSessionId);
    const before = await dbNow();
    const freshReadAt = new Date();
    const started = await correctionStore.recordPostStart(plan, {
      bodyHash: "c".repeat(64), freshReadAt, studentWiseUserId: STUDENT_ID, baselineCredits: [1],
    });
    const after = await dbNow();

    const [row] = await db.select().from(P).where(eq(P.id, started.postId));
    expect(row).toMatchObject({
      wiseSessionId: seeded.wiseSessionId, wiseClassId: seeded.wiseClassId, wiseTeacherUserId: TEACHER, kind: "correction",
      correctionId: null, fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED), bodyHash: "c".repeat(64), billing: BILLING,
      arm: "sol", evidence: "transcript", pipeline: { promptVersion: 9, rootCauseRef: "synthetic-root-cause-1" },
      actorKind: "agent", actor: AGENT_CORRECTION_ACTOR, reason: plan.reason, postFinishedAt: null, outcome: "posting",
      provenance: "live", reconstruction: null, dedupeKey: agentCorrectionDedupeKey(seeded.wiseSessionId), settledAt: null,
      verification: {
        stage: "posting", baseFieldsSha256: fieldsHash(BASE), submissionId: SUBMISSION_ID, freshReadAt: freshReadAt.toISOString(),
        studentWiseUserId: STUDENT_ID, baselineCredits: [1],
      },
    });
    expect(row.postStartedAt).toEqual(started.postStartedAt);
    expect(row.postStartedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.postStartedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    // The first shot owns the session row's POST fields: state, post_started_at, body_hash, verified_event.
    expect(await readSessionRow(db, seeded.wiseSessionId)).toEqual(sessionBefore);

    await expectSqlState(db.update(P).set({ fields: BASE }).where(eq(P.id, started.postId)), "55000");
    await expectSqlState(db.update(P).set({ postStartedAt: new Date() }).where(eq(P.id, started.postId)), "55000");
    await expectSqlState(db.delete(P).where(eq(P.id, started.postId)), "55000");
  });

  it("stores exactly the four feedback fields, on the posts row and the session row, whatever else the plan carries", async () => {
    const seeded = await postedWithFirstShot();
    const extra = { ...CORRECTED, note: "extra" } as typeof CORRECTED;
    const plan = planFor(seeded, { fields: extra });
    const correctionStore = store();
    await lockOrThrow(correctionStore, plan);
    const { postId } = await correctionStore.recordPostStart(plan, { bodyHash: "h" });
    expect((await db.select().from(P).where(eq(P.id, postId)))[0].fields).toEqual(CORRECTED);
    await correctionStore.settle(postId, {
      outcome: "verified",
      verification: {},
      session: { fields: extra, fieldsSha256: fieldsHash(CORRECTED), fromSha256: fieldsHash(BASE), at: new Date(), reason: "synthetic" },
    });
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(CORRECTED);
  });

  it("allows one agent correction per class, ever: refused while one is in flight, the unique index after it settled", async () => {
    const seeded = await postedWithFirstShot();
    const plan = planFor(seeded);
    const first = store();
    const lock = await lockOrThrow(first, plan);
    const { postId } = await first.recordPostStart(plan, { bodyHash: "h" });
    expect(await refusal(first.recordPostStart(plan, { bodyHash: "h" }))).toBe("post_in_flight");

    await first.settle(postId, { outcome: "not_sent", verification: { httpStatus: 429, stillBase: true } });
    expect(await lock.release()).toBe(true);
    const second = store();
    const again = await lockOrThrow(second, plan);
    await expectSqlState(second.recordPostStart(plan, { bodyHash: "h" }), "23505");
    expect(await again.release()).toBe(true);
    expect(await db.select().from(P).where(eq(P.kind, "correction"))).toHaveLength(1);
  });

  const lost: Array<[string, () => Promise<void>, string]> = [
    ["an owner resume", () => updateControl(db, { haltedAt: null, haltReason: null }, OWNER), "lock:lost"],
    ["an owner pause on top", () => haltAutowriter(db, `paused by ${OWNER}: stop`, OWNER), "lock:lost"],
    ["a switch out of live", () => updateControl(db, { mode: "shadow" }, OWNER), "lock:lost"],
    ["the lease taken over", async () => {
      await db.update(C).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(C.id, "default"));
    }, "lock:lost"],
    ["the tutor switched off", () => updateControl(db, { disabledTutors: [TEACHER] }, OWNER), "control:tutor_disabled"],
    ["the session row moved", async () => {
      await db.update(S).set({ fieldsSha256: fieldsHash(OTHER_TEXT) }).where(eq(S.wiseSessionId, SESSION_ID));
    }, "row_changed"],
    ["an owner flag opened", async () => {
      await db.insert(FL).values({ wiseSessionId: SESSION_ID, source: "owner", note: "check", createdBy: OWNER, idempotencyKey: "owner:1" });
    }, "owner_flag_open"],
    ["a first POST claimed meanwhile", () => insertPostingSession(94), "post_in_flight"],
    ["the daily cap reached meanwhile", () => insertAgentCorrections(CORRECTION_DAILY_CAP), "daily_cap"],
  ];
  it.each(lost)("is refused after %s — no row, nothing to send", async (_name, change, reason) => {
    const plan = planFor(await postedWithFirstShot());
    const correctionStore = store();
    await lockOrThrow(correctionStore, plan);
    await change();
    expect(await refusal(correctionStore.recordPostStart(plan, { bodyHash: "h" }))).toBe(reason);
    expect(await db.select().from(P).where(and(eq(P.kind, "correction"), eq(P.wiseSessionId, plan.wiseSessionId)))).toEqual([]);
  });

  it("is refused without the lock", async () => {
    const plan = planFor(await postedWithFirstShot());
    expect(await refusal(store().recordPostStart(plan, { bodyHash: "h" }))).toBe("lock:not_held");
  });
});

describe("settle", () => {
  async function recorded() {
    const seeded = await postedWithFirstShot();
    const plan = planFor(seeded);
    const correctionStore = store();
    await lockOrThrow(correctionStore, plan);
    const { postId } = await correctionStore.recordPostStart(plan, { bodyHash: "h", studentWiseUserId: STUDENT_ID });
    const session = {
      fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED), fromSha256: fieldsHash(BASE), at: new Date("2026-10-02T19:12:00.000Z"),
      reason: plan.reason,
    };
    return { seeded, plan, correctionStore, postId, session };
  }

  it("verified: the post and the session's text in one transaction — never metadata.corrections", async () => {
    const { seeded, correctionStore, postId, session } = await recorded();
    const sessionBefore = (await readSessionRow(db, seeded.wiseSessionId))!;
    await correctionStore.settle(postId, { outcome: "verified", verification: { httpStatus: 200, event: { at: "2026-10-02T19:11:01.000Z" } }, session });

    const [post] = await db.select().from(P).where(eq(P.id, postId));
    expect(post.outcome).toBe("verified");
    expect(post.settledAt).not.toBeNull();
    // Merged: what the claim recorded stays beside the settle's evidence.
    expect(post.verification).toMatchObject({ stage: "posting", studentWiseUserId: STUDENT_ID, httpStatus: 200 });
    const row = (await readSessionRow(db, seeded.wiseSessionId))!;
    expect(row).toMatchObject({
      state: "verified", fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED),
      postStartedAt: sessionBefore.postStartedAt, bodyHash: sessionBefore.bodyHash, verifiedEvent: sessionBefore.verifiedEvent,
    });
    expect(row.metadata).toMatchObject({
      agentCorrection: {
        postId, at: "2026-10-02T19:12:00.000Z", fromSha256: fieldsHash(BASE), toSha256: fieldsHash(CORRECTED), reason: session.reason,
      },
    });
    expect(row.metadata).not.toHaveProperty("corrections");

    // Settled is final.
    await expect(correctionStore.settle(postId, { outcome: "verify_failed", verification: {} })).rejects.toMatchObject({ code: "post_not_unsettled" });
    await expectSqlState(db.update(P).set({ outcome: "rejected" }).where(eq(P.id, postId)), "55000");
  });

  it("rolls the whole transaction back when the session's text moved", async () => {
    const { seeded, correctionStore, postId, session } = await recorded();
    await db.update(S).set({ fieldsSha256: fieldsHash(OTHER_TEXT) }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    await expect(correctionStore.settle(postId, { outcome: "verified", verification: { settledBy: "test" }, session }))
      .rejects.toMatchObject({ code: "session_row_changed" });
    const [post] = await db.select().from(P).where(eq(P.id, postId));
    expect(post).toMatchObject({ outcome: "posting", settledAt: null });
    expect(post.verification).not.toHaveProperty("settledBy");
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(BASE);
  });

  it("awaiting_event stays unsettled (settled_at null) until it verifies", async () => {
    const { seeded, correctionStore, postId, session } = await recorded();
    await correctionStore.settle(postId, { outcome: "awaiting_event", verification: { event: null }, session });
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "awaiting_event", settledAt: null });
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(CORRECTED);
    await correctionStore.settle(postId, { outcome: "verified", verification: { event: { at: "2026-10-02T19:13:00.000Z" } } });
    const [post] = await db.select().from(P).where(eq(P.id, postId));
    expect(post.outcome).toBe("verified");
    expect(post.settledAt).not.toBeNull();
  });
});

describe("preconditions", () => {
  type Context = { seeded: Seeded; plan: CorrectionPlan };
  const cases: Array<[string, (context: Context) => Promise<CorrectionPlan | void>, string[]]> = [
    ["nothing (every precondition holds)", async () => {}, []],
    ["row_missing", async ({ plan }) => ({ ...plan, wiseSessionId: id24(70) }), ["row_missing", "no_first_shot"]],
    ["row_changed (state)", async ({ seeded }) => {
      await db.update(S).set({ state: "held" }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    }, ["row_changed"]],
    ["row_changed (text)", async ({ seeded }) => {
      await db.update(S).set({ fieldsSha256: fieldsHash(OTHER_TEXT) }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    }, ["row_changed"]],
    ["row_mismatch", async ({ plan }) => ({ ...plan, wiseClassId: id24(71) }), ["row_mismatch"]],
    ["deadline_near", async ({ seeded }) => {
      await db.update(S).set({ deadlineAt: new Date(Date.now() + 10 * 60_000) }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    }, ["deadline_near"]],
    ["deadline_unknown", async ({ seeded }) => {
      await db.update(S).set({ deadlineAt: null }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    }, ["deadline_unknown"]],
    ["already_corrected (a re-post the row records)", async ({ seeded }) => {
      await db.update(S).set({ metadata: { corrections: [] } }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
    }, ["already_corrected"]],
    ["already_corrected (a recorded correction by a script)", async ({ seeded }) => {
      await db.insert(P).values({
        wiseSessionId: seeded.wiseSessionId, kind: "correction", fields: BASE, fieldsSha256: fieldsHash(BASE),
        billing: BILLING as unknown as Record<string, unknown>, actorKind: "script", actor: "script:test", reason: "synthetic",
        outcome: "verified", provenance: "backfill", dedupeKey: "correction:synthetic",
      });
    }, ["already_corrected"]],
    ["already_corrected (a policy re-post's save)", async ({ seeded }) => {
      await db.insert(FX).values({
        wiseEventId: "evt-policy", wiseSessionId: seeded.wiseSessionId, eventAt: new Date(), actorKind: "autowriter_policy",
        countsAsFix: false, classifierVersion: 1,
      });
    }, ["already_corrected"]],
    ["no_first_shot (never recorded)", async () => {
      await db.execute(sql`TRUNCATE TABLE feedback_autowriter_posts CASCADE`);
    }, ["no_first_shot"]],
    ["base_not_first_shot", async ({ seeded, plan }) => {
      await db.update(S).set({ fields: OTHER_TEXT, fieldsSha256: fieldsHash(OTHER_TEXT) }).where(eq(S.wiseSessionId, seeded.wiseSessionId));
      return { ...plan, base: { ...plan.base, fields: OTHER_TEXT, fieldsSha256: fieldsHash(OTHER_TEXT) } };
    }, ["base_not_first_shot"]],
    ["first_shot_time_mismatch", async ({ seeded, plan }) => ({
      ...plan, base: { ...plan.base, firstShotPostedAt: new Date(seeded.postStartedAt.getTime() + 2 * 60_000) },
    }), ["first_shot_time_mismatch"]],
    ["base_billing_mismatch", async ({ plan }) => ({ ...plan, base: { ...plan.base, billing: { ...BILLING, creditsConsumed: 2 } } }),
      ["base_billing_mismatch"]],
    ["correction_in_flight", async () => insertInFlightCorrection(72, "posting"), ["correction_in_flight"]],
    ["control:not_live", async () => updateControl(db, { mode: "shadow" }, OWNER), ["control:not_live"]],
    ["control:halted", async () => haltAutowriter(db, "synthetic anomaly"), ["control:halted"]],
    ["control:tutor_disabled", async () => updateControl(db, { disabledTutors: [TEACHER] }, OWNER), ["control:tutor_disabled"]],
    ["human_save_since_post (a tutor)", async ({ seeded }) => {
      await db.insert(FX).values({
        wiseEventId: "evt-tutor", wiseSessionId: seeded.wiseSessionId, eventAt: new Date(), actorWiseUserId: TEACHER, actorRole: "TEACHER",
        actorKind: "tutor", countsAsFix: true, classifierVersion: 1,
      });
    }, ["human_save_since_post"]],
    ["human_save_since_post (an API save no post explains)", async ({ seeded }) => {
      await db.insert(FX).values({
        wiseEventId: "evt-api", wiseSessionId: seeded.wiseSessionId, eventAt: new Date(), actorWiseUserId: API_ACTOR,
        actorKind: "api_actor_unmatched", countsAsFix: true, classifierVersion: 1,
      });
    }, ["human_save_since_post"]],
    ["owner_flag_open", async ({ seeded }) => {
      await db.insert(FL).values({ wiseSessionId: seeded.wiseSessionId, source: "owner", note: "check", createdBy: OWNER, idempotencyKey: "owner:2" });
    }, ["owner_flag_open"]],
    ["app_post_stuck", async () => insertPostingSession(95, new Date(Date.now() - 10 * 60_000)), ["app_post_stuck"]],
    ["daily_cap (six agent corrections in 24 h, whatever their outcome)", async () => {
      await insertAgentCorrections(CORRECTION_DAILY_CAP - 1);
      await insertAgentCorrections(1, { outcome: "verify_failed", from: 300 });
    }, ["daily_cap"]],
    ["no daily cap: not_sent and older corrections do not count", async () => {
      await insertAgentCorrections(CORRECTION_DAILY_CAP - 1);
      await insertAgentCorrections(3, { outcome: "not_sent", from: 300 });
      await insertAgentCorrections(CORRECTION_DAILY_CAP, { hoursAgo: 25, from: 400 });
    }, []],
  ];
  it.each(cases)("%s", async (_name, arrange, expected) => {
    const seeded = await postedWithFirstShot();
    const plan = (await arrange({ seeded, plan: planFor(seeded) })) ?? planFor(seeded);
    expect((await store().preconditions(plan, new Date())).problems).toEqual(expected);
  });

  it("returns the first shot's POST start as its posts row records it", async () => {
    const seeded = await postedWithFirstShot();
    const [firstShot] = await db.select().from(P).where(eq(P.kind, "first_shot"));
    expect(firstShot.postStartedAt).toEqual(seeded.postStartedAt);
    // A plan a minute off (the verified event's own time) still reads the row's time.
    const plan = planFor(seeded, { base: { ...planFor(seeded).base, firstShotPostedAt: seeded.verifiedAt } });
    expect(await store().preconditions(plan, new Date())).toEqual({ problems: [], firstShotPostedAt: seeded.postStartedAt });
  });

  it("is not blocked by an owner verdict (approve or needs fix), a resolved owner flag, or other classes' flags", async () => {
    const seeded = await postedWithFirstShot();
    const [firstShot] = await db.select().from(P).where(eq(P.kind, "first_shot"));
    const [verdict] = await db.insert(V).values({
      wiseSessionId: seeded.wiseSessionId, postId: firstShot.id, fieldsSha256: firstShot.fieldsSha256, verdict: "needs_fix",
      severity: "factual", reviewer: OWNER, source: "dashboard",
    }).returning({ id: V.id });
    await db.insert(V).values({
      wiseSessionId: seeded.wiseSessionId, postId: firstShot.id, fieldsSha256: firstShot.fieldsSha256, verdict: "approve",
      reviewer: OWNER, source: "dashboard",
    });
    await db.insert(FL).values({
      wiseSessionId: seeded.wiseSessionId, source: "owner", note: "seen", createdBy: OWNER, idempotencyKey: "owner:3", resolvedByVerdictId: verdict.id,
    });
    await db.insert(FL).values({ wiseSessionId: id24(73), source: "owner", note: "another class", createdBy: OWNER, idempotencyKey: "owner:4" });
    await db.insert(FL).values({ wiseSessionId: seeded.wiseSessionId, source: "measured_fix", note: "system", createdBy: "system", idempotencyKey: "fix:1" });
    expect((await store().preconditions(planFor(seeded), new Date())).problems).toEqual([]);
  });

  it("accepts a first-shot time up to a minute after the recorded POST start (the verified event's own time)", async () => {
    const seeded = await postedWithFirstShot();
    const plan = planFor(seeded, { base: { ...planFor(seeded).base, firstShotPostedAt: seeded.verifiedAt } });
    expect((await store().preconditions(plan, new Date())).problems).toEqual([]);
  });
});

describe("end to end through the real store", () => {
  it("is a recorded correction: matched to its own post, counted, never an unexplained API write or an unproven first shot", async () => {
    const seeded = await postedWithFirstShot();
    expect(await assignReviews(db, { now: new Date(), draw: () => 0.1 })).toBe(1);
    const time = clock(windowStart());
    // Wise stamps our save on real time, which the database's clock agrees with; the executor's clock is minute 11.
    const wise = fakeWise(time, [], { eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER")], wiseNow: () => new Date() });
    const before = await dbNow();

    const outcome = await correctPostGuarded({
      ops: wise, store: store(), plan: planFor(seeded), apiActorId: API_ACTOR, allowlist: AUTOWRITER_TEACHER_ALLOWLIST,
      disabledTutors: [], aiSuspect: AI_SUSPECT, textProblems: () => [], now: time.now, sleep: time.sleep, eventWaitMs: 0,
    });
    expect(outcome).toMatchObject({ status: "verified" });
    expect(wise.postFeedback).toHaveBeenCalledTimes(1);
    const posts = await db.select().from(P).orderBy(P.recordedAt);
    expect(posts.map((post) => [post.kind, post.outcome, post.actorKind])).toEqual([
      ["first_shot", "verified", "autowriter"], ["correction", "verified", "agent"],
    ]);
    const [firstShot, correction] = posts;
    // Every time recorded for the POST window is the database's, never the executor's minute-11 clock.
    const after = await dbNow();
    const recorded = correction.verification as Record<string, string>;
    for (const key of ["eventsReadAt", "freshReadAt", "postStartedAt", "postFinishedAt"]) {
      const at = new Date(recorded[key]).getTime();
      expect(at, key).toBeGreaterThanOrEqual(before.getTime());
      expect(at, key).toBeLessThanOrEqual(after.getTime());
    }
    expect(new Date(recorded.postStartedAt)).toEqual(correction.postStartedAt);
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
    expect(await leaseFree()).toBe(true);
    const row = (await readSessionRow(db, seeded.wiseSessionId))!;
    expect(row).toMatchObject({ state: "verified", fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED) });
    expect(row.metadata).toMatchObject({ agentCorrection: { postId: correction.id, fromSha256: fieldsHash(BASE), toSha256: fieldsHash(CORRECTED) } });

    // Wise's activity mirror: the first shot's save, and the correction's save 2 s after its POST started.
    await seedActivity(seeded.wiseSessionId, seeded.verifiedAt, API_ACTOR);
    await seedActivity(seeded.wiseSessionId, new Date(correction.postStartedAt!.getTime() + 2_000), API_ACTOR);
    const since = new Date(Date.now() - 7 * 86_400_000);
    expect(await ingestFixEvents(db, { apiActorId: API_ACTOR, since })).toMatchObject({ inserted: 2, skippedInFlight: 0 });
    const fixes = await db.select().from(FX).orderBy(FX.eventAt);
    expect(fixes.map((fix) => [fix.actorKind, fix.countsAsFix, fix.postId])).toEqual([
      ["autowriter_first", false, firstShot.id],
      ["autowriter_correction", true, correction.id],
    ]);
    expect(await raiseFixFlags(db, { since })).toEqual({ flags: 0, incidents: 0 });
    await refreshReviewCounts(db, { sinceDate: "2026-01-01" });
    expect((await db.select().from(R))[0]).toMatchObject({ correctionsVerified: 1, measuredFixCount: 1 });
    expect(await snapshotFirstShots(db)).toEqual({ recorded: 0, unverified: [] });
    expect(await db.select().from(I)).toEqual([]);
  });

  it("keeps the lock while our event is unseen; recovery settles it by reads alone, then the lock is lifted", async () => {
    const seeded = await postedWithFirstShot();
    const time = clock(windowStart());
    const wise = fakeWise(time, [], {
      eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER")], eventsAfterPost: () => [], wiseNow: () => new Date(),
    });
    const outcome = await correctPostGuarded({
      ops: wise, store: store(), plan: planFor(seeded), apiActorId: API_ACTOR, allowlist: AUTOWRITER_TEACHER_ALLOWLIST,
      disabledTutors: [], aiSuspect: AI_SUSPECT, textProblems: () => [], now: time.now, sleep: time.sleep, eventWaitMs: 0,
    });
    expect(outcome).toMatchObject({ status: "awaiting_event_locked" });
    const [correction] = await db.select().from(P).where(eq(P.kind, "correction"));
    expect(correction).toMatchObject({ outcome: "awaiting_event", settledAt: null });
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(CORRECTED);
    // Every other POST stays stopped: the lock (lease and exact halt) is kept.
    expect(isCorrectionLockReason((await readControl(db)).haltReason)).toBe(true);
    expect(await acquireSweepLease(db, 60_000)).toBeNull();
    expect(await releaseStaleCorrectionLock(db)).toBe(false);
    await leaseRunOut();
    expect(await releaseStaleCorrectionLock(db)).toBe(false); // the correction is still unsettled

    const later = fakeWise(clock(), [], {
      detailOn: () => postedDetail({ text: CORRECTED }),
      eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER"), save(new Date(correction.postStartedAt!.getTime() + 1_000), API_ACTOR, "OWNER")],
    });
    expect(await recoverStaleCorrections(db, later, { apiActorId: API_ACTOR, olderThanMs: -60_000, mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS }))
      .toMatchObject([{ postId: correction.id, result: "verified" }]);
    expect(later.postFeedback).not.toHaveBeenCalled();
    expect(await releaseStaleCorrectionLock(db)).toBe(true);
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
  });

  it("never posts once the lease ran out between the claim and the POST (this machine slept): not_sent, released", async () => {
    const seeded = await postedWithFirstShot();
    const time = clock(windowStart());
    const wise = fakeWise(time, [], { eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER")], wiseNow: () => new Date() });
    const real = store();
    const sleeper: CorrectionStore = {
      ...real,
      async recordPostStart(plan, input) {
        const started = await real.recordPostStart(plan, input);
        await leaseRunOut();
        return started;
      },
    };
    const outcome = await correctPostGuarded({
      ops: wise, store: sleeper, plan: planFor(seeded), apiActorId: API_ACTOR, allowlist: AUTOWRITER_TEACHER_ALLOWLIST,
      disabledTutors: [], aiSuspect: AI_SUSPECT, textProblems: () => [], now: time.now, sleep: time.sleep, eventWaitMs: 0,
    });
    expect(outcome).toMatchObject({ status: "not_sent", reason: "lock_lost" });
    expect(wise.postFeedback).not.toHaveBeenCalled();
    expect((await db.select().from(P).where(eq(P.kind, "correction")))[0]).toMatchObject({ outcome: "not_sent" });
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(BASE);
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
  });

  it("a problem after the POST halts, settles and pages — the lock is never lifted", async () => {
    const seeded = await postedWithFirstShot();
    const time = clock(windowStart());
    const wise = fakeWise(time, [], {
      eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER")],
      creditsAfterPost: [{ credit: 1 }, { credit: 1 }],
      wiseNow: () => new Date(),
    });
    const outcome = await correctPostGuarded({
      ops: wise, store: store(), plan: planFor(seeded), apiActorId: API_ACTOR, allowlist: AUTOWRITER_TEACHER_ALLOWLIST,
      disabledTutors: [], aiSuspect: AI_SUSPECT, textProblems: () => [], now: time.now, sleep: time.sleep, eventWaitMs: 0,
    });
    expect(outcome).toMatchObject({ status: "safety", problems: ["credit_entries_changed:[1]->[1,1]"] });
    const control = await readControl(db);
    expect(control.haltReason).toMatch(/^correction-lock:.* \| then: agent correction on .* needs a person \(verify_failed\)/u);
    expect(await releaseStaleCorrectionLock(db)).toBe(false);
    expect((await db.select().from(P).where(eq(P.kind, "correction")))[0]).toMatchObject({ outcome: "verify_failed" });
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(BASE);
    expect(await db.select().from(I)).toMatchObject([{
      kind: "correction_failed", severity: "critical", pushStatus: "pending", dedupeKey: `correction_failed:${seeded.wiseSessionId}`,
    }]);
  });
});

describe("recovery of a correction a run left unsettled", () => {
  /** A run that died after its posts row (and maybe its POST): lock held, row `posting`. */
  async function interrupted() {
    const seeded = await postedWithFirstShot();
    const plan = planFor(seeded);
    const correctionStore = store();
    await lockOrThrow(correctionStore, plan);
    const started = await correctionStore.recordPostStart(plan, {
      bodyHash: "h", freshReadAt: new Date(Date.now() - 1_000), studentWiseUserId: STUDENT_ID, baselineCredits: [1],
    });
    return { seeded, ...started };
  }
  // The rows are milliseconds old: count everything as stale.
  const recover = (ops: Parameters<typeof recoverStaleCorrections>[1], now?: () => Date) =>
    recoverStaleCorrections(db, ops, { apiActorId: API_ACTOR, olderThanMs: -60_000, mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS, now });

  it("waits while the lock's lease is live, then verifies a correction that landed (reads only); then the lock is lifted", async () => {
    const { seeded, postId, postStartedAt } = await interrupted();
    const wise = fakeWise(clock(), [], {
      detailOn: () => postedDetail({ text: CORRECTED }),
      eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER"), save(new Date(postStartedAt.getTime() + 1_000), API_ACTOR, "OWNER")],
    });
    // The run that took the lock may still be alive while its lease lasts: nothing is read or written.
    expect(await recover(wise)).toEqual([{ postId, wiseSessionId: seeded.wiseSessionId, result: "lease_live", problems: [] }]);
    expect(wise.getSessionDetail).not.toHaveBeenCalled();
    expect(wise.findFeedbackEvents).not.toHaveBeenCalled();
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "posting" });
    expect(await releaseStaleCorrectionLock(db)).toBe(false);

    await leaseRunOut();
    expect(await recover(wise)).toEqual([{ postId, wiseSessionId: seeded.wiseSessionId, result: "verified", problems: [] }]);
    expect(wise.postFeedback).not.toHaveBeenCalled();
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "verified" });
    expect(await readSessionRow(db, seeded.wiseSessionId)).toMatchObject({ fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED) });
    expect(await releaseStaleCorrectionLock(db)).toBe(true);
    expect(await readControl(db)).toMatchObject({ haltedAt: null, haltReason: null });
  });

  it("counts a correction stale only once its lease is over plus five minutes", async () => {
    expect(CORRECTION_STALE_AFTER_MS).toBe(CORRECTION_LOCK_LEASE_MS + 5 * 60_000);
    const ops = fakeWise(clock(), []);
    const byDefault = () => recoverStaleCorrections(db, ops, { apiActorId: API_ACTOR, mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS });
    await insertInFlightCorrection(96, "posting", new Date(Date.now() - CORRECTION_LOCK_LEASE_MS - 60_000));
    expect(await byDefault()).toEqual([]);
    await insertInFlightCorrection(97, "posting", new Date(Date.now() - CORRECTION_STALE_AFTER_MS - 60_000));
    expect(await byDefault()).toMatchObject([{ wiseSessionId: id24(97), result: "safety", problems: ["row_incomplete_for_recovery"] }]);
  });

  it("settles not_sent when Wise still shows the base text, untouched", async () => {
    const { seeded, postId } = await interrupted();
    await leaseRunOut();
    const wise = fakeWise(clock(), [], { eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER")] });
    expect(await recover(wise)).toMatchObject([{ postId, result: "not_sent" }]);
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "not_sent" });
    expect((await readSessionRow(db, seeded.wiseSessionId))?.fields).toEqual(BASE);
    expect((await readControl(db)).haltedAt).not.toBeNull(); // the lock: lifted by releaseStaleCorrectionLock, not here
    expect(wise.postFeedback).not.toHaveBeenCalled();
  });

  it("halts, settles unknown_outcome and pages on anything else; leaves a failed read for the next run", async () => {
    const { postId } = await interrupted();
    await leaseRunOut();
    const down = fakeWise(clock(), [], { detailOn: () => new Error("down") });
    expect(await recover(down)).toMatchObject([{ postId, result: "read_failed" }]);
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "posting" });
    expect(await db.select().from(I)).toEqual([]);

    const other = fakeWise(clock(), [], { detailOn: () => postedDetail({ text: OTHER_TEXT }) });
    expect(await recover(other)).toMatchObject([{ postId, result: "safety" }]);
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "unknown_outcome" });
    expect((await readControl(db)).haltReason).toMatch(/ \| then: agent correction on .* could not be recovered/u);
    expect(await db.select().from(I).where(and(eq(I.kind, "correction_failed"), eq(I.severity, "critical")))).toHaveLength(1);
    expect(await releaseStaleCorrectionLock(db)).toBe(false);
    expect(other.postFeedback).not.toHaveBeenCalled();
  });

  it("checks only the events of an awaiting_event correction: a later edit, charge or save in Wise is no false alarm", async () => {
    const { seeded, postId, postStartedAt } = await interrupted();
    await leaseRunOut();
    const session = { fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED), fromSha256: fieldsHash(BASE), at: new Date(), reason: "synthetic" };
    await store().settle(postId, { outcome: "awaiting_event", verification: { event: null }, session });
    const later = new Date(postStartedAt.getTime() + 10 * 60_000);
    const wise = fakeWise(clock(), [], {
      // Since the correction a tutor edited the text and Wise charged again: on top of it, and never read here.
      detailOn: () => postedDetail({ text: OTHER_TEXT }),
      credits: [{ credit: 1 }, { credit: 1 }],
      eventsBefore: [
        save(seeded.verifiedAt, API_ACTOR, "OWNER"),
        save(new Date(postStartedAt.getTime() + 1_000), API_ACTOR, "OWNER"),
        save(later, TEACHER, "TEACHER"),
        save(new Date(later.getTime() + 60_000), API_ACTOR, "OWNER"),
      ],
    });
    expect(await recover(wise)).toEqual([{ postId, wiseSessionId: seeded.wiseSessionId, result: "verified", problems: [] }]);
    expect(wise.getSessionDetail).not.toHaveBeenCalled();
    expect(wise.getSessionCreditEntries).not.toHaveBeenCalled();
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "verified" });
    expect(await db.select().from(I)).toEqual([]);
  });

  it.each([
    ["after the POST window: on top of ours", 10 * 60_000, "verified", []],
    ["inside the POST window: a second save", 30_000, "safety", ["extra_api_save_in_post_window:1"]],
  ] as const)("counts an API save %s", async (_name, afterMs, result, problems) => {
    const { seeded, postId, postStartedAt } = await interrupted();
    await leaseRunOut();
    const wise = fakeWise(clock(), [], {
      detailOn: () => postedDetail({ text: CORRECTED }),
      eventsBefore: [
        save(seeded.verifiedAt, API_ACTOR, "OWNER"),
        save(new Date(postStartedAt.getTime() + 1_000), API_ACTOR, "OWNER"),
        save(new Date(postStartedAt.getTime() + afterMs), API_ACTOR, "OWNER"),
      ],
    });
    expect(await recover(wise)).toEqual([{ postId, wiseSessionId: seeded.wiseSessionId, result, problems }]);
  });

  it("gives an awaiting_event correction 2 h for its event, then halts", async () => {
    const { seeded, postId } = await interrupted();
    await leaseRunOut();
    const session = { fields: CORRECTED, fieldsSha256: fieldsHash(CORRECTED), fromSha256: fieldsHash(BASE), at: new Date(), reason: "synthetic" };
    await store().settle(postId, { outcome: "awaiting_event", verification: { event: null }, session });
    const landed = fakeWise(clock(), [], {
      detailOn: () => postedDetail({ text: CORRECTED }),
      eventsBefore: [save(seeded.verifiedAt, API_ACTOR, "OWNER")],
    });
    expect(await recover(landed)).toMatchObject([{ postId, result: "awaiting_event" }]);
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "awaiting_event" });
    expect(await recover(landed, () => new Date(Date.now() + 3 * 60 * 60 * 1000))).toMatchObject([{
      postId, result: "safety", problems: ["no_submit_event_after_2h"],
    }]);
    expect((await db.select().from(P).where(eq(P.id, postId)))[0]).toMatchObject({ outcome: "verify_failed" });
  });
});

describe("the lock reason", () => {
  it("is recognised exactly, never with anything appended", () => {
    const reason = correctionLockReason("0b6f1c39-8a7e-4c6b-9a43-5f0e1d2c3b4a", SESSION_ID);
    expect(isCorrectionLockReason(reason)).toBe(true);
    expect(isCorrectionLockReason(`${reason} | then: paused by ${OWNER}: x`)).toBe(false);
    expect(isCorrectionLockReason("paused by owner")).toBe(false);
    expect(isCorrectionLockReason(null)).toBe(false);
  });
});
