import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { JUDGE_PROMPT_VERSION } from "../judge";
import { PROMPT_VERSION } from "../prompt";
import {
  acquireSweepLease,
  claimGeneration,
  ensureSessionRow,
  expireOverdueRows,
  flagNoRecording,
  haltAutowriter,
  listDueRows,
  listPendingAlerts,
  listSonioxCleanup,
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
  stampClassName,
  stampSonioxRetention,
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
  it("keeps Wise's class name from the first read that has one, never replacing it", async () => {
    const metadataOf = async (id: string) => (await readSessionRow(db, id))?.metadata;
    expect(await metadataOf(SESSION)).toEqual({});
    await stampClassName(db, SESSION, "Athen (Athen.Si) Simthumnimit");
    await stampClassName(db, SESSION, "Someone else");
    expect(await metadataOf(SESSION)).toEqual({ className: "Athen (Athen.Si) Simthumnimit" });

    const input = {
      wiseSessionId: OTHER_SESSION, wiseClassId: null, wiseTeacherUserId: TEACHER, scheduledEndAt: null, deadlineAt: null, trigger: "webhook",
    };
    await ensureSessionRow(db, { ...input, className: "First name" });
    await ensureSessionRow(db, { ...input, className: "Second name" });
    await ensureSessionRow(db, { ...input, className: null });
    expect(await metadataOf(OTHER_SESSION)).toEqual({ className: "First name" });
  });

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

  it("lists a row whose last attempt failed (`infra:…`) after every row that has not, so a stuck class never leads the sweep", async () => {
    const S = schema.feedbackAutowriterSessions;
    const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);
    // In deadline order: a judge that keeps failing, a writer that was rate limited, then three rows that have not failed.
    const rows: Array<[string, Date, string | null]> = [
      ["6a0000000000000000000021", hours(1), "infra:judge:high:timeout"],
      ["6a0000000000000000000022", hours(2), "infra:sol:openai/gpt-6.1-sol is temporarily rate-limited upstream."],
      ["6a0000000000000000000023", hours(3), null],
      ["6a0000000000000000000024", hours(4), "transcript_first"],
      // Not an `infra:` failure: Wise was not ready, or an error of another kind.
      ["6a0000000000000000000025", hours(5), "wise_read_failed"],
    ];
    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    for (const [wiseSessionId, deadlineAt, reason] of rows) {
      await ensureSessionRow(db, { wiseSessionId, wiseClassId: "6a0000000000000000000011", wiseTeacherUserId: TEACHER, scheduledEndAt: null, deadlineAt, trigger: "test" });
      await db.update(S).set({ reason }).where(eq(S.wiseSessionId, wiseSessionId));
    }
    // The rows that have not failed, most urgent first; then the failed ones, most urgent first.
    expect((await listDueRows(db)).map((row) => row.wiseSessionId.slice(-2))).toEqual(["23", "24", "25", "21", "22"]);
    // Once its failure is behind it (any other reason), a row is back in deadline order.
    await db.update(S).set({ reason: "post_in_flight" }).where(eq(S.wiseSessionId, "6a0000000000000000000021"));
    expect((await listDueRows(db)).map((row) => row.wiseSessionId.slice(-2))).toEqual(["21", "23", "24", "25", "22"]);
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

  it("lists a judge_failing alert only while the class still retries with its judge failing, and sends it again for a new run of failures", async () => {
    const S = schema.feedbackAutowriterSessions;
    const failing = (judgeErrors: number, alert: boolean) => ({
      state: "transcribing" as const, reason: "infra:judge:high:timeout", retryInMs: 0, countRetry: true,
      metadata: { judgeErrors }, ...(alert ? { alertKind: "judge_failing" as const, rearmAlert: true } : {}),
    });
    const kinds = async () => (await listPendingAlerts(db)).map((alert) => alert.kind);
    // The third failure in a row asks for the alert; it is sent once.
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, failing(3, true));
    expect(await listPendingAlerts(db)).toMatchObject([{ wiseSessionId: SESSION, kind: "judge_failing", state: "transcribing", reason: "infra:judge:high:timeout" }]);
    await markAlertsSent(db, await listPendingAlerts(db));
    expect(await kinds()).toEqual([]);
    // The fourth and fifth failures ask for nothing new.
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, failing(4, false));
    expect(await kinds()).toEqual([]);
    expect((await readSessionRow(db, SESSION))?.alertsSent).toHaveProperty("judge_failing");

    // The judge answers (the count starts again), then fails three more times: a new episode, alerted again.
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, { state: "pending", reason: "post_in_flight", retryInMs: 0, metadata: { judgeErrors: 0 } });
    expect(await kinds()).toEqual([]);
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, failing(2, false));
    expect(await kinds()).toEqual([]);
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, failing(3, true));
    expect(await kinds()).toEqual(["judge_failing"]);
    expect((await readSessionRow(db, SESSION))?.alertsSent).not.toHaveProperty("judge_failing");

    // Not sent yet, and the judge answers before the digest goes out: the alert is dropped.
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, { state: "pending", reason: "post_in_flight", retryInMs: 0, metadata: { judgeErrors: 0 } });
    expect(await kinds()).toEqual([]);
    // Nor once the class has settled, whatever its count says: a person wrote it, it was posted, it expired unseen.
    for (const state of ["skipped_human", "skipped_scope", "verified", "would_submit", "posting", "awaiting_event", "rejected"] as const) {
      await db.update(S).set({ state, metadata: { alertKind: "judge_failing", judgeErrors: 3 } }).where(eq(S.wiseSessionId, SESSION));
      expect(await kinds(), state).toEqual([]);
    }
    // Still in the works with the count at the mark: listed, in every state a class retries from.
    for (const state of ["pending", "awaiting_recording", "transcribing", "generating"] as const) {
      await db.update(S).set({ state, metadata: { alertKind: "judge_failing", judgeErrors: 3 } }).where(eq(S.wiseSessionId, SESSION));
      expect(await kinds(), state).toEqual(["judge_failing"]);
    }
    // A count that is missing or not a number counts as none; other kinds are listed as before.
    for (const metadata of [{ alertKind: "judge_failing" }, { alertKind: "judge_failing", judgeErrors: "3" }, { alertKind: "judge_failing", judgeErrors: 2 }]) {
      await db.update(S).set({ state: "transcribing", metadata }).where(eq(S.wiseSessionId, SESSION));
      expect(await kinds(), JSON.stringify(metadata)).toEqual([]);
    }
    await db.update(S).set({ state: "held", metadata: { alertKind: "held", judgeErrors: 3 } }).where(eq(S.wiseSessionId, SESSION));
    expect(await kinds()).toEqual(["held"]);
    // Another kind carries nothing about the judge.
    expect((await listPendingAlerts(db))[0]).not.toHaveProperty("judge");
  });

  it("lists a judge_failing alert at either mark: three failures of the judge itself, or six judge-stage runs of any kind together", async () => {
    const S = schema.feedbackAutowriterSessions;
    const listed = async (metadata: Record<string, unknown>) => {
      await db.update(S).set({ state: "transcribing", metadata: { alertKind: "judge_failing", ...metadata } }).where(eq(S.wiseSessionId, SESSION));
      return (await listPendingAlerts(db)).map((alert) => alert.kind);
    };
    // The runs in which the judge could not be asked (a rate limit, our function's time, our account): six alone.
    expect(await listed({ judgeUnreached: 3 })).toEqual([]);
    expect(await listed({ judgeUnreached: 5 })).toEqual([]);
    expect(await listed({ judgeUnreached: 6 })).toEqual(["judge_failing"]);
    // Both kinds together.
    expect(await listed({ judgeErrors: 2, judgeUnreached: 3 })).toEqual([]);
    expect(await listed({ judgeErrors: 2, judgeUnreached: 4 })).toEqual(["judge_failing"]);
    expect(await listed({ judgeErrors: 1, judgeUnreached: 5 })).toEqual(["judge_failing"]);
    // The judge's own failures: three, whatever else is counted.
    expect(await listed({ judgeErrors: 3, judgeUnreached: 0 })).toEqual(["judge_failing"]);
    expect(await listed({ judgeErrors: 3 })).toEqual(["judge_failing"]);
    // Both back at zero (the judge answered): dropped.
    expect(await listed({ judgeErrors: 0, judgeUnreached: 0 })).toEqual([]);
    // A count that is not a number counts as none, in either place, and never fails the query.
    expect(await listed({ judgeUnreached: "6" })).toEqual([]);
    expect(await listed({ judgeErrors: 2, judgeUnreached: "4" })).toEqual([]);
    expect(await listed({ judgeErrors: { n: 3 }, judgeUnreached: [6] })).toEqual([]);
    expect(await listed({ judgeErrors: null, judgeUnreached: 6 })).toEqual(["judge_failing"]);

    // What the digest needs to say why: both counts, what last kept the judge from being asked, and the episode.
    await listed({ judgeErrors: 2, judgeUnreached: 4, judgeUnreachedCause: "rate_limited", judgeFailingSince: "2026-09-30T05:10:00.000Z" });
    expect(await listPendingAlerts(db)).toMatchObject([{
      wiseSessionId: SESSION, kind: "judge_failing",
      judge: { errors: 2, unreached: 4, unreachedCause: "rate_limited", since: "2026-09-30T05:10:00.000Z" },
    }]);
    for (const cause of ["out_of_time", "account_or_connection"]) {
      await listed({ judgeUnreached: 6, judgeUnreachedCause: cause });
      expect((await listPendingAlerts(db))[0].judge).toEqual({ errors: 0, unreached: 6, unreachedCause: cause, since: null });
    }
    // A cause it does not know, or none: no cause (the digest then blames nobody in particular).
    await listed({ judgeErrors: 3, judgeUnreachedCause: "the moon" });
    expect((await listPendingAlerts(db))[0].judge).toEqual({ errors: 3, unreached: 0, unreachedCause: null, since: null });
  });

  it("re-arms an alert only when asked to, and only the kind it raises", async () => {
    const S = schema.feedbackAutowriterSessions;
    await db.update(S).set({ alertsSent: { held: "2026-09-30 01:00:00+00", judge_failing: "2026-09-30 02:00:00+00" } }).where(eq(S.wiseSessionId, SESSION));
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, { state: "pending", retryInMs: 0, alertKind: "judge_failing" });
    expect((await readSessionRow(db, SESSION))?.alertsSent).toEqual({ held: "2026-09-30 01:00:00+00", judge_failing: "2026-09-30 02:00:00+00" });
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, { state: "pending", retryInMs: 0, rearmAlert: true });
    expect((await readSessionRow(db, SESSION))?.alertsSent).toHaveProperty("judge_failing");
    await releaseGeneration(db, SESSION, (await claimGeneration(db, SESSION, 60_000))!, { state: "pending", retryInMs: 0, alertKind: "judge_failing", rearmAlert: true });
    expect((await readSessionRow(db, SESSION))?.alertsSent).toEqual({ held: "2026-09-30 01:00:00+00" });
  });

  it("retries a held class on request, re-arming its alert, but never near the deadline or from other states", async () => {
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, token, {
      state: "held", reason: "glm:unfaithful", alertKind: "held",
      metadata: {
        genericErrors: 3, transcribeErrors: 2, judgeErrors: 4, judgeUnreached: 2, judgeUnreachedCause: "rate_limited",
        judgeFailingSince: "2026-09-30T05:10:00.000Z", pipeline: { commitSha: "a" }, judge: { faithful: false },
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
    for (const key of [
      "alertKind", "genericErrors", "transcribeErrors", "judgeErrors", "judgeUnreached", "judgeUnreachedCause", "judgeFailingSince", "pipeline", "judge",
      "sonioxRetainUntil", "triagedAt",
    ]) {
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

    // A transcript draft of the current prompt and judge that both judge levels passed (v5) is posted as it is: its
    // window keeps running.
    const current = { promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION };
    const passing = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
    const both = { ...passing, levels: { medium: passing, high: passing } };
    const next = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, next, {
      state: "would_submit", reason: "shadow",
      metadata: { sonioxRetainUntil: "2026-10-01T00:00:00.000Z", draftEvidence: "transcript", judge: both, pipeline: current },
    });
    expect(await requeueShadowDrafts(db, new Date())).toBe(1);
    expect((await readSessionRow(db, SESSION))?.metadata).toMatchObject({ sonioxRetainUntil: "2026-10-01T00:00:00.000Z" });

    // An older version's transcript draft, one with no stamp at all (v4, 30 Sep), or one not passed by both judge
    // levels (v5, 30 Sep) is written and judged again: its window restarts like any other draft's.
    const flagged = { ...passing, faithful: false, unsupported: ["x"] };
    const rewritten: Array<[string, unknown, unknown]> = [
      ["a v3 stamp", both, { promptVersion: 3, judgeVersion: 3 }],
      ["the previous judge version", both, { ...current, judgeVersion: 4 }],
      ["the previous prompt version", both, { ...current, promptVersion: 4 }],
      ["no stamp", both, null],
      ["a v4 draft as the single judge stored it", passing, { promptVersion: 4, judgeVersion: 4 }],
      ["a current stamp on a single-level verdict", passing, current],
      ["medium did not pass", { ...passing, levels: { medium: flagged, high: passing } }, current],
      ["high did not pass", { ...passing, levels: { medium: passing, high: flagged } }, current],
      ["high is missing", { ...passing, levels: { medium: passing } }, current],
    ];
    for (const [label, judge, pipeline] of rewritten) {
      const older = (await claimGeneration(db, SESSION, 60_000))!;
      await releaseGeneration(db, SESSION, older, {
        state: "would_submit", reason: "shadow",
        metadata: { sonioxRetainUntil: "2026-10-01T00:00:00.000Z", draftEvidence: "transcript", judge, pipeline },
      });
      expect(await requeueShadowDrafts(db, new Date()), label).toBe(1);
      expect((await readSessionRow(db, SESSION))?.metadata, label).not.toHaveProperty("sonioxRetainUntil");
    }
    await haltAutowriter(db, "noop");
  });

  it("transcript first: keeps a fallback's review window when going live, and an owner retry clears the fallback", async () => {
    const fellBack = {
      handover: "transcript_first", summaryAtHandover: { characters: 0, thaiShare: null },
      summaryFallback: { cause: "speakers_unclear", at: "2026-09-29T12:00:00.000Z" }, sonioxFailure: "x",
    };
    const token = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, token, {
      state: "would_submit", reason: "shadow",
      metadata: { ...fellBack, sonioxRetainUntil: "2026-10-01T00:00:00.000Z", draftEvidence: "summary", judge: { faithful: true } },
    });
    // It never reads its transcript again, so going live does not restart the window.
    expect(await requeueShadowDrafts(db, new Date())).toBe(1);
    expect((await readSessionRow(db, SESSION))?.metadata).toMatchObject({ sonioxRetainUntil: "2026-10-01T00:00:00.000Z" });

    const again = (await claimGeneration(db, SESSION, 60_000))!;
    await releaseGeneration(db, SESSION, again, { state: "held", reason: "thai_summary_no_transcript", alertKind: "held" });
    expect(await retryHeldSession(db, SESSION, { minDeadline: new Date(), actor: "k@x.com" })).toBe(true);
    const row = await readSessionRow(db, SESSION);
    expect(row).toMatchObject({ state: "pending", evidence: "summary" });
    for (const key of ["handover", "summaryAtHandover", "summaryFallback", "sonioxFailure", "sonioxRetainUntil"]) {
      expect(row?.metadata).not.toHaveProperty(key);
    }
  });

  it("transcript first: a fallback is done with its Soniox job (never mid-POST or mid-work), and raises no no-recording alert", async () => {
    const S = schema.feedbackAutowriterSessions;
    const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const fellBack = { handover: "transcript_first", summaryFallback: { cause: "speakers_unclear", at: longAgo.toISOString() } };
    // Mid-POST or being worked on: not yet.
    for (const state of ["posting", "awaiting_event", "generating"] as const) {
      await db.update(S).set({ state, sonioxTranscriptionId: "job-9", scheduledEndAt: longAgo, metadata: fellBack }).where(eq(S.wiseSessionId, SESSION));
      expect(await stampSonioxRetention(db, 60_000), state).toBe(0);
    }
    // Still waiting on the summary (pending), with the transcript's job on the row.
    await db.update(S).set({ state: "pending", metadata: fellBack }).where(eq(S.wiseSessionId, SESSION));
    expect(await stampSonioxRetention(db, 60_000)).toBe(1);
    expect(await listSonioxCleanup(db)).toEqual([]);
    await db.update(S).set({ metadata: sql`${S.metadata} || jsonb_build_object('sonioxRetainUntil', now() - interval '1 minute')` as never })
      .where(eq(S.wiseSessionId, SESSION));
    expect(await listSonioxCleanup(db)).toEqual([{ wiseSessionId: SESSION, sonioxTranscriptionId: "job-9" }]);

    // A transcript-first class still waiting for its recording 3 h after class falls back instead of alerting;
    // one stuck transcribing, and a class handed over for another reason, still alert.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.update(S).set({ state: "awaiting_recording", reason: "recording_not_ready", metadata: { handover: "transcript_first" } })
      .where(eq(S.wiseSessionId, SESSION));
    expect(await flagNoRecording(db, threeHoursAgo)).toBe(0);
    await db.update(S).set({ state: "transcribing", reason: "transcription_in_progress" }).where(eq(S.wiseSessionId, SESSION));
    expect(await flagNoRecording(db, threeHoursAgo)).toBe(1);
    await db.update(S).set({ state: "awaiting_recording", reason: "recording_not_ready", metadata: { handover: "thai_summary" } })
      .where(eq(S.wiseSessionId, SESSION));
    expect(await flagNoRecording(db, threeHoursAgo)).toBe(1);
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


it("requeueing Mimi shadow drafts preserves the transcript window only for the active guide", async () => {
  const passing = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
  const judge = { ...passing, levels: { medium: passing, high: passing } };
  for (const [enabled, styleGuide, retained] of [
    ["true", { id: "mimi", version: 1 }, true],
    ["true", { id: "mimi", version: 0 }, false],
    ["true", null, false],
    ["false", { id: "mimi", version: 1 }, false],
  ] as const) {
    vi.stubEnv("FEEDBACK_AUTOWRITER_MIMI_STYLE_ENABLED", enabled);
    try {
      await db.update(schema.feedbackAutowriterSessions).set({
        state: "would_submit", wiseTeacherUserId: "695369c028118f629edcbaf3",
        metadata: { sonioxRetainUntil: "2026-10-01T00:00:00.000Z", draftEvidence: "transcript", judge,
          pipeline: { promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION, styleGuide } },
      }).where(eq(schema.feedbackAutowriterSessions.wiseSessionId, SESSION));
      expect(await requeueShadowDrafts(db, new Date())).toBe(1);
      expect(Object.hasOwn((await readSessionRow(db, SESSION))!.metadata, "sonioxRetainUntil")).toBe(retained);
    } finally { vi.unstubAllEnvs(); }
  }
});
