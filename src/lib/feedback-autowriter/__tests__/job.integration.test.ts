import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { ScheduleEmailSendInput } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { processSession, runSweep, type AutowriterDeps } from "../job";
import type { OpenRouterCallResult } from "../openrouter";
import { ensureSessionRow, readControl, readSessionRow, updateControl } from "../store";
import type { PostResult, SubmitFeedbackEvent, WiseFeedbackOps } from "../submit";
import type { WiseFeedbackPostBody } from "../types";
import { CLASS_ID, GOOD_FIELDS, NOW, SESSION_ID, answers, autoBlankSubmission, sessionDetail } from "./fixtures";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const API_ACTOR = "69366668c05630afe5d8a2a4";
const KEVIN = "696e2c4343579bbada2340ed";
const GIFT = "696f1eee43579bbadad472e5";
const S = schema.feedbackAutowriterSessions;

const usage = { promptTokens: 1000, completionTokens: 2000, reasoningTokens: 1700, cachedTokens: 0, costUsd: 0.002 };
const writerJson = JSON.stringify({
  topics: GOOD_FIELDS.topics,
  performance: GOOD_FIELDS.performance.replaceAll("Somchai", "[STUDENT_1]"),
  improvement: GOOD_FIELDS.improvement.replaceAll("Somchai", "[STUDENT_1]"),
  homework: "",
  studentAttended: true,
  lessonHappened: true,
});
const glm = (content: string): OpenRouterCallResult => ({
  ok: true, content, model: "z-ai/glm-5.3-flash", provider: "Together", generationId: "g", finishReason: "stop", usage, latencyMs: 5,
});

/** Writer + judge replies for as many drafts as a test needs. */
function fakeModel() {
  const calls: string[] = [];
  const callModel = vi.fn(async (request: { schemaName: string }) => {
    calls.push(request.schemaName);
    return request.schemaName === "post_class_feedback" ? glm(writerJson) : glm(JSON.stringify({ faithful: true, unsupported: [] }));
  });
  return { callModel, calls };
}

type Detail = ReturnType<typeof sessionDetail>;

/** Fake Wise: a detail per read (last one repeats), POSTs applied like the web-app edit. */
function fakeWise(options: {
  details?: Detail[];
  failReads?: boolean;
  postResult?: PostResult;
  events?: () => SubmitFeedbackEvent[];
} = {}) {
  const queue = [...(options.details ?? [sessionDetail()])];
  let current = queue[0];
  let posted = false;
  const posts: WiseFeedbackPostBody[] = [];
  let reads = 0;
  const read = async () => {
    reads += 1;
    if (options.failReads) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    if (!posted && queue.length > 0) current = queue.shift()!;
    return { data: structuredClone(current) };
  };
  const ops: WiseFeedbackOps = {
    getSessionDetail: vi.fn(read),
    getSessionDetailById: vi.fn(read),
    postFeedback: vi.fn(async (_classId: string, _sessionId: string, body: WiseFeedbackPostBody) => {
      posts.push(body);
      posted = true;
      current = {
        ...current,
        feedbackSubmissions: [autoBlankSubmission({
          answers: answers(body.answers.map((answer) => answer.answer) as [string, string, string, string]),
          metadata: null,
          sessionStatus: body.sessionStatus,
          creditsConsumed: body.creditsConsumed,
        })],
      };
      return options.postResult ?? ({ kind: "sent", status: 200 } as const);
    }),
    getSessionCreditEntries: vi.fn(async () => {
      if (options.failReads) throw new Error("credits down");
      return [{ credit: 1 }];
    }),
    findFeedbackEvents: vi.fn(async () => posted
      ? (options.events?.() ?? [{ at: new Date(Date.now() + 1_000), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" }])
      : []),
  };
  return { ops, posts, reads: () => reads };
}

function deps(ops: WiseFeedbackOps, overrides: Partial<AutowriterDeps> = {}): AutowriterDeps & { emails: ScheduleEmailSendInput[] } {
  const emails: ScheduleEmailSendInput[] = [];
  return {
    db,
    ops,
    apiKey: "test-key",
    apiActorId: API_ACTOR,
    writesAllowedHere: true,
    deadlineMs: Date.now() + 740_000,
    alertRecipients: ["ops@example.com"],
    alertSender: { sendEmail: async (input) => { emails.push(input); return { id: "e" }; } },
    now: () => NOW,
    sleep: async () => {},
    callModel: fakeModel().callModel as never,
    emails,
    ...overrides,
  };
}

async function seedRow(overrides: Partial<typeof S.$inferInsert> = {}) {
  await ensureSessionRow(db, {
    wiseSessionId: SESSION_ID,
    wiseClassId: CLASS_ID,
    wiseTeacherUserId: KEVIN,
    scheduledEndAt: new Date("2026-09-28T09:30:00.000Z"),
    deadlineAt: new Date("2026-09-30T16:59:59.999Z"),
    trigger: "test",
  });
  if (Object.keys(overrides).length > 0) await db.update(S).set(overrides).where(eq(S.wiseSessionId, SESSION_ID));
}

const postedRow = (overrides: Partial<typeof S.$inferInsert> = {}): Partial<typeof S.$inferInsert> => ({
  state: "posting",
  postStartedAt: new Date(NOW.getTime() - 7 * 60 * 1000),
  fields: GOOD_FIELDS,
  billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
  metadata: {
    expected: { kind: "auto_blank", submissionId: "6a0000000000000000000004", sessionStatus: "COMPLETED", creditsConsumed: 1 },
    freshReadAt: new Date(NOW.getTime() - 8 * 60 * 1000).toISOString(),
  },
  ...overrides,
});
const appliedDetail = () => sessionDetail({
  feedbackSubmissions: [autoBlankSubmission({
    metadata: null,
    answers: answers([GOOD_FIELDS.topics, GOOD_FIELDS.performance, GOOD_FIELDS.improvement, ""]),
  })],
});

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions, feedback_autowriter_calls, wise_webhook_events`);
  await db.execute(sql`UPDATE feedback_autowriter_control SET mode = 'live', halted_at = NULL, halt_reason = NULL,
    disabled_tutors = '[]'::jsonb, lease_token = NULL, lease_until = NULL`);
});

describe("processSession (Postgres + fake Wise and models)", () => {
  it("writes, judges, posts once and verifies a live session from a webhook", async () => {
    const wise = fakeWise();
    const model = fakeModel();
    const outcome = await processSession(deps(wise.ops, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" });
    expect(outcome).toMatchObject({ result: "verified" });
    expect(wise.posts).toHaveLength(1);
    expect(model.calls).toEqual(["post_class_feedback", "feedback_faithfulness"]);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "verified", arm: "glm", wiseTeacherUserId: KEVIN });
    expect(row?.leaseToken).toBeNull();
    expect(await db.select().from(schema.feedbackAutowriterCalls)).toHaveLength(2);
  });

  it("does nothing at all while halted: no Wise read, no model call, no row", async () => {
    await updateControl(db, { haltedAt: new Date(), haltReason: "test halt" }, "t@x.com");
    const wise = fakeWise();
    const model = fakeModel();
    expect(await processSession(deps(wise.ops, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "halted" });
    expect(wise.reads()).toBe(0);
    expect(model.calls).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toBeNull();
  });

  it("never touches state from a preview deployment", async () => {
    const wise = fakeWise();
    expect(await processSession(deps(wise.ops, { writesAllowedHere: false }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "preview" });
    expect(wise.reads()).toBe(0);
    expect(await readSessionRow(db, SESSION_ID)).toBeNull();
  });

  it("follows Wise to a new teacher: a switched-off tutor's class is not posted", async () => {
    await seedRow();
    await updateControl(db, { disabledTutors: [GIFT] }, "t@x.com");
    const moved = sessionDetail({ userId: { _id: GIFT, name: "Wanwisa (Gift) Montrikittiphant Online" } });
    const wise = fakeWise({ details: [moved] });
    expect(await processSession(deps(wise.ops), { wiseSessionId: SESSION_ID, trigger: "cron" })).toMatchObject({ result: "tutor_off" });
    expect(wise.posts).toHaveLength(0);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", wiseTeacherUserId: GIFT, reason: "tutor_off" });
  });

  it("maps a gate that fails on the pre-POST fresh read like any gate (a tutor wrote it → skipped_human)", async () => {
    await seedRow();
    const humanWrote = sessionDetail({ feedbackSubmissions: [autoBlankSubmission({ metadata: null, answers: answers(["Tutor wrote this", "", "", ""]) })] });
    // Read 1: processLeased; read 2: submit's student read; read 3: the fresh pre-POST read.
    const wise = fakeWise({ details: [sessionDetail(), sessionDetail(), humanWrote] });
    expect(await processSession(deps(wise.ops), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "skipped_human", detail: "human_submission" });
    expect(wise.posts).toHaveLength(0);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row?.state).toBe("skipped_human");
    expect(row?.metadata).not.toHaveProperty("alertKind");
  });

  it("treats 'no student yet' right after class as a retry, not a hold", async () => {
    const justEnded = new Date("2026-09-28T09:35:00.000Z");
    await seedRow();
    const noStudentYet = sessionDetail({ participants: sessionDetail().participants.filter((participant) => participant.isTeacher) });
    const wise = fakeWise({ details: [noStudentYet] });
    expect(await processSession(deps(wise.ops, { now: () => justEnded }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "retry", detail: "student_count_0" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", reason: "student_count_0" });
  });

  it("does not draft at all while another POST is stuck waiting for reconciliation", async () => {
    await seedRow();
    await ensureSessionRow(db, {
      wiseSessionId: "6a0000000000000000000099", wiseClassId: "6a0000000000000000000098", wiseTeacherUserId: KEVIN,
      scheduledEndAt: new Date("2026-09-28T09:30:00.000Z"), deadlineAt: new Date("2026-09-30T16:59:59.999Z"), trigger: "test",
    });
    await db.update(S).set({ state: "posting", postStartedAt: sql`now() - interval '10 minutes'` as never })
      .where(eq(S.wiseSessionId, "6a0000000000000000000099"));
    const wise = fakeWise();
    const model = fakeModel();
    expect(await processSession(deps(wise.ops, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "blocked_by_stuck_post" });
    expect(model.calls).toEqual([]);
    expect(wise.reads()).toBe(0);
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("pending");
  });

  it("sends a shadow draft back to pending when the owner switches to live while it is being written", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow();
    const wise = fakeWise();
    const callModel = vi.fn(async (request: { schemaName: string }) => {
      if (request.schemaName === "post_class_feedback") await updateControl(db, { mode: "live" }, "owner@x.com");
      return request.schemaName === "post_class_feedback" ? glm(writerJson) : glm(JSON.stringify({ faithful: true, unsupported: [] }));
    });
    expect(await processSession(deps(wise.ops, { callModel: callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "retry", detail: "mode_switched_to_live" });
    expect(wise.posts).toHaveLength(0);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", reason: "mode_switched_to_live" });
  });

  it("waits for another session's POST in flight, then leaves the session for the next sweep", async () => {
    await seedRow();
    await ensureSessionRow(db, {
      wiseSessionId: "6a0000000000000000000099", wiseClassId: "6a0000000000000000000098", wiseTeacherUserId: KEVIN,
      scheduledEndAt: new Date("2026-09-28T09:30:00.000Z"), deadlineAt: new Date("2026-09-30T16:59:59.999Z"), trigger: "test",
    });
    await db.update(S).set({ state: "posting", postStartedAt: sql`now()` }).where(eq(S.wiseSessionId, "6a0000000000000000000099"));
    const wise = fakeWise();
    const sleeps: number[] = [];
    expect(await processSession(deps(wise.ops, { sleep: async (ms) => { sleeps.push(ms); } }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "not_claimed", detail: "post_in_flight" });
    expect(wise.posts).toHaveLength(0);
    expect(sleeps.filter((ms) => ms === 10_000)).toHaveLength(7);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", reason: "post_in_flight" });
  });
});

describe("runSweep (Postgres + fake Wise and models)", () => {
  it("recovers a session whose worker died mid-generation", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow({ state: "generating", leaseToken: "00000000-0000-4000-8000-000000000001", leaseUntil: sql`now() - interval '1 minute'` as never });
    const wise = fakeWise();
    const result = await runSweep(deps(wise.ops));
    expect(result.processed).toEqual({ would_submit: 1 });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "would_submit", reason: "shadow" });
  });

  it("does not draft while halted, but still expires and alerts", async () => {
    await seedRow({ deadlineAt: new Date(NOW.getTime() + 10 * 60 * 1000) });
    await ensureSessionRow(db, {
      wiseSessionId: "6a0000000000000000000077", wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN,
      scheduledEndAt: new Date("2026-09-28T09:30:00.000Z"), deadlineAt: new Date("2026-09-30T16:59:59.999Z"), trigger: "test",
    });
    await updateControl(db, { haltedAt: new Date(), haltReason: "manual pause" }, "t@x.com");
    const wise = fakeWise();
    const model = fakeModel();
    const sweepDeps = deps(wise.ops, { callModel: model.callModel as never });
    const result = await runSweep(sweepDeps);
    expect(model.calls).toEqual([]);
    expect(result).toMatchObject({ ok: false, halted: true, expired: 1, alertsSent: 1, processed: {} });
    expect(sweepDeps.emails).toHaveLength(1);
    expect(sweepDeps.emails[0].text).toContain("HALTED");
    expect((await readSessionRow(db, "6a0000000000000000000077"))?.state).toBe("pending");
  });

  it("records draft alerts in shadow mode without emailing them", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow();
    const lowAttendance = sessionDetail({
      participants: sessionDetail().participants.map((participant) =>
        participant.isTeacher ? participant : { ...participant, absolutePercentAttendance: 20 }),
    });
    const wise = fakeWise({ details: [lowAttendance] });
    const sweepDeps = deps(wise.ops);
    const result = await runSweep(sweepDeps);
    expect(result).toMatchObject({ ok: true, processed: { held: 1 }, alertsSent: 0, alertsSuppressed: 1 });
    expect(sweepDeps.emails).toEqual([]);
    expect((await readSessionRow(db, SESSION_ID))?.alertsSent).toEqual({ held: "suppressed:shadow" });
  });

  it("reports a POST it cannot reconcile yet as an infrastructure error, and halts after 2 h", async () => {
    const posted = {
      state: "posting" as const,
      fields: GOOD_FIELDS,
      billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
      metadata: { expected: { kind: "auto_blank", submissionId: "6a0000000000000000000004", sessionStatus: "COMPLETED", creditsConsumed: 1 } },
    };
    await seedRow({ ...posted, postStartedAt: new Date(NOW.getTime() - 7 * 60 * 1000) });
    const down = fakeWise({ failReads: true });
    const first = await runSweep(deps(down.ops));
    expect(first).toMatchObject({ ok: false, reconciled: { read_failed: 1 } });
    expect(first.infraErrors[0]).toContain("Wise read failed while reconciling a posting row");
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("posting");

    await db.update(S).set({ postStartedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) }).where(eq(S.wiseSessionId, SESSION_ID));
    const second = await runSweep(deps(down.ops));
    expect(second.reconciled).toEqual({ verify_failed: 1 });
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("verify_failed");
    expect((await readControl(db)).haltReason).toContain("session_unreadable_2h_after_post");
  });

  it("stops processing the moment a halt lands mid-sweep", async () => {
    await seedRow();
    await ensureSessionRow(db, {
      wiseSessionId: "6a0000000000000000000077", wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN,
      scheduledEndAt: new Date("2026-09-28T09:30:00.000Z"), deadlineAt: new Date("2026-09-30T17:30:00.000Z"), trigger: "test",
    });
    const wise = fakeWise();
    const calls: string[] = [];
    // Another worker halts while the first session is being written.
    const callModel = vi.fn(async (request: { schemaName: string }) => {
      calls.push(request.schemaName);
      if (calls.length === 1) await updateControl(db, { haltedAt: new Date(), haltReason: "other worker" }, "system");
      return request.schemaName === "post_class_feedback" ? glm(writerJson) : glm(JSON.stringify({ faithful: true, unsupported: [] }));
    });
    const result = await runSweep(deps(wise.ops, { callModel: callModel as never }));
    expect(result.processed).toEqual({ not_claimed: 1 });
    expect(calls).toHaveLength(2); // one draft (writer + judge), the second session never started
    expect(wise.posts).toHaveLength(0);
    expect((await readSessionRow(db, "6a0000000000000000000077"))?.state).toBe("pending");
  });

  it("halts on a save inside the POST window found while awaiting our event — halt written first", async () => {
    await seedRow(postedRow({ state: "awaiting_event" }));
    const wise = fakeWise({ details: [appliedDetail()] });
    wise.ops.findFeedbackEvents = vi.fn(async () => [
      { at: new Date(NOW.getTime() - 7 * 60 * 1000 + 1_000), autoSubmitted: null, actorId: "tutor", actorRole: "TEACHER" },
    ]);
    const result = await runSweep(deps(wise.ops));
    expect(result.reconciled).toEqual({ verify_failed: 1 });
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("verify_failed");
    expect((await readControl(db)).haltReason).toContain("foreign_submit_event_in_post_window");
  });

  it("marks a stale posting row whose text is not in Wise as unknown and halts", async () => {
    await seedRow(postedRow());
    const wise = fakeWise(); // still Wise's blank auto-submission
    const result = await runSweep(deps(wise.ops));
    expect(result.reconciled).toEqual({ unknown_outcome: 1 });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "unknown_outcome" });
    expect((await readControl(db)).haltReason).toContain("not found as sent");
  });

  it("still reconciles in mode off", async () => {
    await updateControl(db, { mode: "off" }, "t@x.com");
    await seedRow(postedRow({ state: "awaiting_event" }));
    const wise = fakeWise({ details: [appliedDetail()] });
    wise.ops.findFeedbackEvents = vi.fn(async () => [
      { at: new Date(NOW.getTime() - 7 * 60 * 1000 + 2_000), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" },
    ]);
    const result = await runSweep(deps(wise.ops));
    expect(result).toMatchObject({ mode: "off", reconciled: { verified: 1 }, processed: {} });
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("verified");
  });

  it("verifies a stale posting row from Wise without posting again", async () => {
    await seedRow(postedRow());
    const wise = fakeWise({ details: [appliedDetail()] });
    wise.ops.findFeedbackEvents = vi.fn(async () => [
      { at: new Date(NOW.getTime() - 7 * 60 * 1000 + 2_000), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" },
    ]);
    const result = await runSweep(deps(wise.ops));
    expect(result.reconciled).toEqual({ verified: 1 });
    expect(wise.posts).toHaveLength(0);
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("verified");
  });
});
