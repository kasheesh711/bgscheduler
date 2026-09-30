import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import {
  acquireSweepLease,
  claimGeneration,
  ensureSessionRow,
  expireOverdueRows,
  haltAutowriter,
  listDueRows,
  listPendingAlerts,
  markAlertsSent,
  readControl,
  readSessionRow,
  recentAutowriterPosts,
  releaseGeneration,
  releaseShadowDraft,
  releaseSweepLease,
  retryHeldSession,
  requeueShadowDrafts,
  sessionSubmitStore,
  stuckPostInFlight,
  updateControl,
  updateLeasedTeacher,
} from "../store";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const SESSION = "6a0000000000000000000002";
const TEACHER = "696e2c4343579bbada2340ed";
const claimInput = {
  bodyHash: "b",
  fieldsSha256: "f",
  fields: { topics: "t", performance: "p", improvement: "i", homework: "" },
  billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse" as const, expectedConsumedDelta: 0 },
  arm: "glm" as const,
  teacherId: TEACHER,
  freshReadAt: new Date(),
};
const OTHER_SESSION = "6a0000000000000000000012";
const refused = { claimed: false, reason: "conditions" };

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions, feedback_autowriter_calls, wise_webhook_events`);
  await db.execute(sql`UPDATE feedback_autowriter_control SET mode = 'shadow', halted_at = NULL, halt_reason = NULL,
    disabled_tutors = '[]'::jsonb, lease_token = NULL, lease_until = NULL`);
  await ensureSessionRow(db, {
    wiseSessionId: SESSION,
    wiseClassId: "6a0000000000000000000001",
    wiseTeacherUserId: TEACHER,
    scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000),
    deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    trigger: "test",
  });
});

describe("feedback autowriter store (Postgres)", () => {
  it("migration seeds one control row in shadow mode", async () => {
    const control = await readControl(db);
    expect(control).toMatchObject({ id: "default", mode: "shadow", haltedAt: null, disabledTutors: [] });
  });

  it("gives the generation lease to exactly one of many concurrent workers", async () => {
    const tokens = await Promise.all(Array.from({ length: 12 }, () => claimGeneration(db, SESSION, 60_000)));
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect((await readSessionRow(db, SESSION))?.state).toBe("generating");
  });

  it("lets an expired generation lease be taken over, not a live one", async () => {
    const first = await claimGeneration(db, SESSION, 60_000);
    expect(first).not.toBeNull();
    expect(await claimGeneration(db, SESSION, 60_000)).toBeNull();
    await db.update(schema.feedbackAutowriterSessions).set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
    expect(await claimGeneration(db, SESSION, 60_000)).not.toBeNull();
  });

  it("claims the POST only while live, un-halted, tutor on and lease held — and only once", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual(refused); // shadow

    await updateControl(db, { mode: "live", haltedAt: new Date(), haltReason: "test" }, "t@x.com");
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual(refused); // halted

    await updateControl(db, { haltedAt: null, haltReason: null, disabledTutors: [TEACHER] }, "t@x.com");
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual(refused); // tutor off

    await updateControl(db, { disabledTutors: [] }, "t@x.com");
    expect(await sessionSubmitStore(db, SESSION, "00000000-0000-4000-8000-000000000000").claimPost(claimInput)).toEqual(refused); // not our lease
    // Wise now shows another teacher than the stored one.
    expect(await sessionSubmitStore(db, SESSION, token).claimPost({ ...claimInput, teacherId: "696f1eee43579bbadad472e5" })).toEqual(refused);

    const winners = await Promise.all(Array.from({ length: 6 }, () => sessionSubmitStore(db, SESSION, token).claimPost(claimInput)));
    expect(winners.filter((winner) => winner.claimed)).toHaveLength(1);
    const row = await readSessionRow(db, SESSION);
    expect(row).toMatchObject({ state: "posting", bodyHash: "b", arm: "glm" });
    expect(row?.postStartedAt).not.toBeNull();

    // `posting` can never be re-claimed for generation.
    await db.update(schema.feedbackAutowriterSessions).set({ leaseUntil: sql`now() - interval '1 hour'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
    expect(await claimGeneration(db, SESSION, 60_000)).toBeNull();
  });

  it("refuses the POST claim once the lease has expired", async () => {
    await updateControl(db, { mode: "live" }, "t@x.com");
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await db.update(schema.feedbackAutowriterSessions).set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual(refused);
  });

  it("allows only one POST in flight institution-wide, also under a race", async () => {
    await updateControl(db, { mode: "live" }, "t@x.com");
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER,
      scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000), deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000), trigger: "test",
    });
    const first = (await claimGeneration(db, SESSION, 60_000))!;
    const second = (await claimGeneration(db, OTHER_SESSION, 60_000))!;
    const results = await Promise.all([
      sessionSubmitStore(db, SESSION, first).claimPost(claimInput),
      sessionSubmitStore(db, OTHER_SESSION, second).claimPost(claimInput),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.find((result) => !result.claimed)).toEqual({ claimed: false, reason: "post_in_flight" });

    // Once the POST in flight has an outcome, the other session may claim.
    const winner = results[0].claimed ? SESSION : OTHER_SESSION;
    const loser = winner === SESSION ? OTHER_SESSION : SESSION;
    await sessionSubmitStore(db, winner, winner === SESSION ? first : second).finish("verified", {});
    expect(await sessionSubmitStore(db, loser, loser === SESSION ? first : second).claimPost(claimInput)).toEqual({ claimed: true });
    expect((await readSessionRow(db, loser))?.metadata).toMatchObject({ freshReadAt: claimInput.freshReadAt.toISOString() });
  });

  it("keeps the lock while a POST awaits its confirming event (it can still become a halt)", async () => {
    await updateControl(db, { mode: "live" }, "t@x.com");
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER,
      scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000), deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000), trigger: "test",
    });
    await db.update(schema.feedbackAutowriterSessions).set({ state: "awaiting_event", postStartedAt: sql`now() - interval '1 minute'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, OTHER_SESSION));
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual({ claimed: false, reason: "post_in_flight" });
    expect(await stuckPostInFlight(db, 6 * 60 * 1000)).toBe(false);
    await db.update(schema.feedbackAutowriterSessions).set({ postStartedAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, OTHER_SESSION));
    expect(await stuckPostInFlight(db, 6 * 60 * 1000)).toBe(true);
    await db.update(schema.feedbackAutowriterSessions).set({ state: "verified" })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, OTHER_SESSION));
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual({ claimed: true });
  });

  it("maps the unique-index race (23505, wrapped by drizzle) to post_in_flight", async () => {
    await updateControl(db, { mode: "live" }, "t@x.com");
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER,
      scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000), deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000), trigger: "test",
    });
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    // Another worker's claim, not committed yet: our NOT EXISTS cannot see it, the index can.
    const other = await handle.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("UPDATE feedback_autowriter_sessions SET state = 'posting', post_started_at = now() WHERE wise_session_id = $1", [OTHER_SESSION]);
      const claim = sessionSubmitStore(db, SESSION, token).claimPost(claimInput);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query("COMMIT");
      expect(await claim).toEqual({ claimed: false, reason: "post_in_flight" });
    } finally {
      other.release();
    }
    expect((await readSessionRow(db, SESSION))?.state).toBe("generating");
  });

  it("reports a halt as 'conditions', not 'post_in_flight', even while another POST is in flight", async () => {
    await updateControl(db, { mode: "live", haltedAt: new Date(), haltReason: "x" }, "t@x.com");
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER,
      scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000), deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000), trigger: "test",
    });
    await db.update(schema.feedbackAutowriterSessions).set({ state: "posting", postStartedAt: sql`now() - interval '10 minutes'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, OTHER_SESSION));
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    expect(await sessionSubmitStore(db, SESSION, token).claimPost(claimInput)).toEqual(refused);
    expect(await stuckPostInFlight(db, 6 * 60 * 1000)).toBe(true);
    expect(await stuckPostInFlight(db, 15 * 60 * 1000)).toBe(false);
  });

  it("follows the latest teacher while pending, never under a lease", async () => {
    const upsert = (teacher: string) => ensureSessionRow(db, {
      wiseSessionId: SESSION, wiseClassId: "6a0000000000000000000001", wiseTeacherUserId: teacher,
      scheduledEndAt: null, deadlineAt: null, trigger: "cron",
    });
    await upsert("696f1eee43579bbadad472e5");
    expect((await readSessionRow(db, SESSION))?.wiseTeacherUserId).toBe("696f1eee43579bbadad472e5");
    await claimGeneration(db, SESSION, 60_000);
    await upsert(TEACHER);
    expect((await readSessionRow(db, SESSION))?.wiseTeacherUserId).toBe("696f1eee43579bbadad472e5");
  });

  it("stores a shadow draft, or sends it back to pending when the mode switched to live meanwhile", async () => {
    const draft = { arm: "glm" as const, fields: claimInput.fields, fieldsSha256: "f", billing: claimInput.billing, metadata: { judge: { faithful: true } } };
    const shadowToken = (await claimGeneration(db, SESSION, 60_000))!;
    expect(await releaseShadowDraft(db, SESSION, shadowToken, draft)).toBe("would_submit");
    expect(await readSessionRow(db, SESSION)).toMatchObject({ state: "would_submit", reason: "shadow", leaseToken: null });

    await requeueShadowDrafts(db, new Date());
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await updateControl(db, { mode: "live" }, "t@x.com");
    expect(await releaseShadowDraft(db, SESSION, token, draft)).toBe("pending");
    expect(await readSessionRow(db, SESSION)).toMatchObject({ state: "pending", reason: "mode_switched_to_live", nextAttemptAt: null });
    expect(await releaseShadowDraft(db, SESSION, token, draft)).toBeNull(); // lease already released
  });

  it("only finishes rows that are posting, and keeps every halt reason until resumed", async () => {
    await updateControl(db, { mode: "live" }, "t@x.com");
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    const store = sessionSubmitStore(db, SESSION, token, { expected: { kind: "auto_blank" } });
    expect(await store.claimPost(claimInput)).toEqual({ claimed: true });
    await store.finish("unknown_outcome", { error: "timeout" });
    await store.halt("first");
    await store.halt("second");
    await store.halt("second");
    const row = await readSessionRow(db, SESSION);
    expect(row?.state).toBe("unknown_outcome");
    expect(row?.metadata).toMatchObject({ expected: { kind: "auto_blank" }, alertKind: "unknown_outcome" });
    await store.finish("verified", {});
    expect((await readSessionRow(db, SESSION))?.state).toBe("unknown_outcome");
    expect((await readControl(db)).haltReason).toBe("first | then: second");
    await haltAutowriter(db, "paused by k@x.com: look", "k@x.com");
    expect(await readControl(db)).toMatchObject({ haltReason: "first | then: second | then: paused by k@x.com: look", updatedBy: "k@x.com" });
  });

  it("lists pending and dead-worker generating rows as due, most urgent deadline first", async () => {
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER,
      scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000), deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000), trigger: "test",
    });
    await claimGeneration(db, SESSION, 60_000);
    expect((await listDueRows(db)).map((row) => row.wiseSessionId)).toEqual([OTHER_SESSION]); // live lease: not due
    await db.update(schema.feedbackAutowriterSessions).set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
    expect((await listDueRows(db)).map((row) => row.wiseSessionId)).toEqual([OTHER_SESSION, SESSION]);
  });

  it("expires overdue rows with an alert, but hands a switched-off tutor's class back silently", async () => {
    const OFF_TEACHER = "696f1eee43579bbadad472e5";
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: OFF_TEACHER,
      scheduledEndAt: new Date(Date.now() - 60 * 60 * 1000), deadlineAt: new Date(Date.now() + 10 * 60 * 1000), trigger: "test",
    });
    await db.update(schema.feedbackAutowriterSessions).set({ deadlineAt: sql`now() + interval '10 minutes'` })
      .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
    // A dead worker's row expires too; a live lease is left alone.
    const DEAD = "6a0000000000000000000013";
    const LIVE = "6a0000000000000000000014";
    for (const [id, leaseUntil] of [[DEAD, sql`now() - interval '1 minute'`], [LIVE, sql`now() + interval '5 minutes'`]] as const) {
      await ensureSessionRow(db, {
        wiseSessionId: id, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER,
        scheduledEndAt: null, deadlineAt: new Date(Date.now() + 10 * 60 * 1000), trigger: "test",
      });
      await db.update(schema.feedbackAutowriterSessions).set({ state: "generating", leaseToken: "00000000-0000-4000-8000-000000000009", leaseUntil })
        .where(eq(schema.feedbackAutowriterSessions.wiseSessionId, id));
    }
    const cutoff = new Date(Date.now() + 30 * 60 * 1000);
    expect(await expireOverdueRows(db, { cutoff, disabledTutors: [OFF_TEACHER] })).toEqual({ expired: 2, handedBack: 1 });
    expect(await readSessionRow(db, DEAD)).toMatchObject({ state: "expired", leaseToken: null });
    expect((await readSessionRow(db, LIVE))?.state).toBe("generating");
    expect(await readSessionRow(db, SESSION)).toMatchObject({ state: "expired", metadata: { alertKind: "expired" } });
    const handedBack = await readSessionRow(db, OTHER_SESSION);
    expect(handedBack).toMatchObject({ state: "skipped_scope", reason: "tutor_off_at_deadline" });
    expect(handedBack?.metadata).not.toHaveProperty("alertKind");
  });

  it("records a new teacher only for the lease holder", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    expect(await updateLeasedTeacher(db, SESSION, "00000000-0000-4000-8000-000000000000", "x")).toBe(false);
    expect(await updateLeasedTeacher(db, SESSION, token, "696f1eee43579bbadad472e5")).toBe(true);
    expect((await readSessionRow(db, SESSION))?.wiseTeacherUserId).toBe("696f1eee43579bbadad472e5");
  });

  it("releases a generation lease only for its holder", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    expect(await releaseGeneration(db, SESSION, "00000000-0000-4000-8000-000000000000", { state: "held" })).toBe(false);
    expect(await releaseGeneration(db, SESSION, token, { state: "pending", retryInMs: 600_000, countRetry: true })).toBe(true);
    const row = await readSessionRow(db, SESSION);
    expect(row).toMatchObject({ state: "pending", retryCount: 1, leaseToken: null });
    expect(await claimGeneration(db, SESSION, 60_000)).toBeNull(); // not due yet
  });

  it("holds the sweep lease exclusively until released", async () => {
    const lease = await acquireSweepLease(db, 60_000);
    expect(lease).not.toBeNull();
    expect(await acquireSweepLease(db, 60_000)).toBeNull();
    await releaseSweepLease(db, lease!);
    expect(await acquireSweepLease(db, 60_000)).not.toBeNull();
  });

  it("lists each alert kind once per session", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, token, { state: "held", reason: "judge", alertKind: "held" });
    const alerts = await listPendingAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ wiseSessionId: SESSION, kind: "held" });
    await markAlertsSent(db, alerts, "suppressed:shadow");
    expect(await listPendingAlerts(db)).toHaveLength(0);
    expect((await readSessionRow(db, SESSION))?.alertsSent).toEqual({ held: "suppressed:shadow" });
  });

  it("retries a held class on request, re-arming its alert, but never near the deadline or from other states", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, token, {
      state: "held", reason: "glm:unfaithful", alertKind: "held",
      metadata: {
        genericErrors: 3, transcribeErrors: 2, pipeline: { commitSha: "a" }, judge: { faithful: false },
        sonioxRetainUntil: "2026-10-01T00:00:00.000Z", triagedAt: "2026-09-29T15:00:00.000Z",
      },
    });
    await markAlertsSent(db, await listPendingAlerts(db));
    expect(await retryHeldSession(db, SESSION, { minDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000), actor: "k@x.com" })).toBe(false);
    expect(await retryHeldSession(db, SESSION, { minDeadline: new Date(), actor: "k@x.com" })).toBe(true);
    const row = await readSessionRow(db, SESSION);
    expect(row).toMatchObject({ state: "pending", reason: "retry_requested", nextAttemptAt: null, alertsSent: {} });
    expect(row?.metadata).toMatchObject({ retriedBy: "k@x.com", retriedFrom: "held" });
    // A clean slate: counters, the old draft's stamp and its review window are gone.
    for (const key of ["alertKind", "genericErrors", "transcribeErrors", "pipeline", "judge", "sonioxRetainUntil", "triagedAt"]) {
      expect(row?.metadata).not.toHaveProperty(key);
    }
    expect(await retryHeldSession(db, SESSION, { minDeadline: new Date(), actor: "k@x.com" })).toBe(false); // already pending
    // Held again → alerts again.
    const again = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, again, { state: "held", reason: "still unfaithful", alertKind: "held" });
    expect(await listPendingAlerts(db)).toHaveLength(1);
  });

  it("retries a class skipped as out of scope on request, but never one a person wrote", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, token, { state: "skipped_scope", reason: "student_count_3" });
    expect(await retryHeldSession(db, SESSION, { minDeadline: new Date(), actor: "k@x.com" })).toBe(true);
    expect(await readSessionRow(db, SESSION)).toMatchObject({ state: "pending", metadata: { retriedFrom: "skipped_scope" } });
    const again = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, again, { state: "skipped_human", reason: "human_submission" });
    expect(await retryHeldSession(db, SESSION, { minDeadline: new Date(), actor: "k@x.com" })).toBe(false);
  });

  it("re-queues shadow drafts still before their deadline when going live", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, token, {
      state: "would_submit", reason: "shadow",
      metadata: { sonioxRetainUntil: "2026-10-01T00:00:00.000Z", triagedAt: "2026-09-29T15:00:00.000Z", judge: { faithful: true } },
    });
    expect(await requeueShadowDrafts(db, new Date())).toBe(1);
    const row = await readSessionRow(db, SESSION);
    expect(row?.state).toBe("pending");
    // Back to work: a summary draft may transcribe again, so its review window restarts when it is done again.
    expect(row?.metadata).not.toHaveProperty("sonioxRetainUntil");
    expect(row?.metadata).not.toHaveProperty("triagedAt");
    expect(row?.metadata).toMatchObject({ judge: { faithful: true } });

    // A judged transcript draft is posted as it is: its window keeps running.
    const next = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, next, {
      state: "would_submit", reason: "shadow",
      metadata: { sonioxRetainUntil: "2026-10-01T00:00:00.000Z", draftEvidence: "transcript", judge: { faithful: true } },
    });
    expect(await requeueShadowDrafts(db, new Date())).toBe(1);
    expect((await readSessionRow(db, SESSION))?.metadata).toMatchObject({ sonioxRetainUntil: "2026-10-01T00:00:00.000Z" });
    await haltAutowriter(db, "noop");
  });

  it("compares new feedback with the tutor's own posts from both of their Wise accounts", async () => {
    const MAIN = "695369c028118f629edcb986";
    const posted = { state: "verified" as const, fields: claimInput.fields };
    await db.update(schema.feedbackAutowriterSessions).set(posted).where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
    await ensureSessionRow(db, {
      wiseSessionId: OTHER_SESSION, wiseClassId: "6a0000000000000000000001", wiseTeacherUserId: MAIN,
      scheduledEndAt: new Date(), deadlineAt: new Date(Date.now() + 86_400_000), trigger: "test",
    });
    await db.update(schema.feedbackAutowriterSessions).set(posted).where(eq(schema.feedbackAutowriterSessions.wiseSessionId, OTHER_SESSION));
    const since = new Date(Date.now() - 86_400_000);
    expect((await recentAutowriterPosts(db, [TEACHER, MAIN], since)).map((post) => post.key).sort()).toEqual([SESSION, OTHER_SESSION].sort());
    expect((await recentAutowriterPosts(db, [TEACHER], since)).map((post) => post.key)).toEqual([SESSION]);
    expect(await recentAutowriterPosts(db, [], since)).toEqual([]);
  });
});
