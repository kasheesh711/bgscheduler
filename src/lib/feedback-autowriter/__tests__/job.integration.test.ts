import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { ScheduleEmailSendInput } from "@/lib/classrooms/schedule-email";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { AUTOWRITER_MODELS, type AutowriterModelConfig } from "../config";
import { cleanUpSonioxJobs, processSession, runSweep, type AutowriterDeps } from "../job";
import type { OpenRouterCallResult } from "../openrouter";
import { JUDGE_PROMPT_VERSION } from "../judge";
import { PROMPT_VERSION } from "../prompt";
import { ensureSessionRow, readControl, readSessionRow, retryHeldSession, updateControl } from "../store";
import type { PostResult, SubmitFeedbackEvent, WiseFeedbackOps } from "../submit";
import { SonioxError } from "../soniox";
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
const sol = (content: string): OpenRouterCallResult => ({
  ok: true, content, model: "openai/gpt-6.1-sol", provider: "Azure", generationId: "g", finishReason: "stop", usage, latencyMs: 5,
});
const luna = (content: string): OpenRouterCallResult => ({ ...sol(content), model: "openai/gpt-6-luna" });
/** A v4 judge verdict that passes the draft, and the model reply carrying it. Rows seeded with `{ faithful, unsupported }` hold stored v3 verdicts. */
const PASSING_VERDICT = { faithful: true, unsupported: [], misattributed: [], homeworkNotSet: [] };
const FAITHFUL_VERDICT = JSON.stringify(PASSING_VERDICT);

/** Writer (Sol) + judge (GLM) replies for as many drafts as a test needs. */
function fakeModel() {
  const calls: string[] = [];
  const models: string[] = [];
  const callModel = vi.fn(async (request: { schemaName: string; model: string }) => {
    calls.push(request.schemaName);
    models.push(request.model);
    return request.schemaName === "post_class_feedback" ? sol(writerJson) : glm(FAITHFUL_VERDICT);
  });
  return { callModel, calls, models };
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
    expect(model.models).toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash"]);
    const row = await readSessionRow(db, SESSION_ID);
    // Arm `sol` passes the widened CHECK constraints (migration 0100) on both tables.
    expect(row).toMatchObject({ state: "verified", arm: "sol", wiseTeacherUserId: KEVIN });
    expect(row?.leaseToken).toBeNull();
    const calls = await db.select().from(schema.feedbackAutowriterCalls);
    expect(calls.map((call) => `${call.role}:${call.arm}:${call.requestedModel}`).toSorted())
      .toEqual(["judge:glm:z-ai/glm-5.3-flash", "writer:sol:openai/gpt-6.1-sol"]);
    // "Somchai (Tom.Ja) Jaidee" is called Tom, never by the first name.
    const posted = wise.posts[0].answers.map((answer) => answer.answer).join("\n");
    expect(posted).toContain("Tom found");
    expect(posted).not.toMatch(/Somchai/u);
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

  it("writes an online class taught from a tutor's main Wise account (Gift teaches online there)", async () => {
    const giftMain = { _id: "695369c028118f629edcb9cb", name: "Wanwisa (Gift) Montrikittiphant" };
    const detail = sessionDetail({ userId: giftMain, feedbackSubmissions: [autoBlankSubmission({ userId: giftMain })] });
    const wise = fakeWise({ details: [detail] });
    expect(await processSession(deps(wise.ops), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "webhook" }))
      .toMatchObject({ result: "verified" });
    expect(wise.posts).toHaveLength(1);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ wiseTeacherUserId: "695369c028118f629edcb9cb", state: "verified" });
  });

  it("writes a one-to-one class the tutor also joined from two other devices", async () => {
    const participants = [
      ...sessionDetail().participants,
      { name: "Kevin Hsieh", isTeacher: false, inMeetingDuration: 3248, absolutePercentAttendance: 97 },
      { name: "Kev", isTeacher: false, inMeetingDuration: 3151, absolutePercentAttendance: 94 },
    ];
    const wise = fakeWise({ details: [sessionDetail({ participants })] });
    expect(await processSession(deps(wise.ops), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "webhook" }))
      .toMatchObject({ result: "verified" });
    expect(wise.posts).toHaveLength(1);
  });

  it("writes for a student who joined by Zoom link as a guest for the whole class (owner rule)", async () => {
    const [teacher, student] = sessionDetail().participants;
    const participants = [
      { ...teacher, inMeetingDuration: 3461 },
      { ...student, inMeetingDuration: 0, absolutePercentAttendance: 0 },
      { name: "Tom Jaidee", isTeacher: false, inMeetingDuration: 3246, absolutePercentAttendance: 94 },
    ];
    const wise = fakeWise({ details: [sessionDetail({ participants })] });
    expect(await processSession(deps(wise.ops), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "webhook" }))
      .toMatchObject({ result: "verified" });
    expect(wise.posts).toHaveLength(1);
    expect(wise.posts[0].answers.map((answer) => answer.answer).join("\n")).toContain("Tom found");
    // Recorded with the POST claim: the guest, and the account whose credit was checked (reconciliation re-uses it).
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ studentJoinedAsGuest: "Tom Jaidee", studentWiseUserId: student.wiseUserId });
    // Billing and the credit check stay on the Wise account.
    expect(vi.mocked(wise.ops.getSessionCreditEntries).mock.calls[0][1]).toBe(student.wiseUserId);
  });

  it("waits while attendance settles when an account and a guest joined, instead of skipping for good", async () => {
    const [teacher, student] = sessionDetail().participants;
    const noNumbersYet = [
      teacher,
      { ...student, inMeetingDuration: undefined, absolutePercentAttendance: undefined },
      { name: "Tom Jaidee", isTeacher: false },
    ];
    const justEnded = new Date("2026-09-28T09:35:00.000Z");
    const wise = fakeWise({ details: [sessionDetail({ participants: noNumbersYet })] });
    expect(await processSession(deps(wise.ops, { now: () => justEnded }), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "webhook" }))
      .toMatchObject({ result: "retry", detail: "student_count_2_guest" });
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("pending");
  });

  it("skips an in-person class on a main account at once, before any model call", async () => {
    const kevinMain = { _id: "695369c028118f629edcb986", name: "Kevin (Kev) Y. Hsieh" };
    const model = fakeModel();
    const wise = fakeWise({ details: [sessionDetail({ type: "OFFLINE", userId: kevinMain, feedbackSubmissions: [autoBlankSubmission({ userId: kevinMain })] })] });
    expect(await processSession(deps(wise.ops, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "cron" }))
      .toMatchObject({ result: "skipped_scope", detail: "session_type_OFFLINE" });
    expect(model.calls).toEqual([]);
    expect(wise.posts).toHaveLength(0);
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
      return request.schemaName === "post_class_feedback" ? sol(writerJson) : glm(FAITHFUL_VERDICT);
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
      return request.schemaName === "post_class_feedback" ? sol(writerJson) : glm(FAITHFUL_VERDICT);
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

// ---------------------------------------------------------------------------
// Second pass: Soniox transcript
// ---------------------------------------------------------------------------

const THAI_SUMMARY = [{
  summaryTitle: "Meeting Summary",
  summaryOverview: "นักเรียนและครูทบทวนเรื่องเศษส่วน การบวกเศษส่วนที่มีตัวส่วนต่างกัน และการทำให้เป็นเศษส่วนอย่างต่ำ " +
    "นักเรียนตอบคำถามได้ถูกต้องเกือบทั้งหมด แต่ยังลืมทำให้เป็นอย่างต่ำในบางข้อ ครูให้ฝึกเพิ่มเติมเรื่องการหา ห.ร.ม. " +
    "และทบทวนโจทย์ปัญหาเกี่ยวกับการแบ่งพิซซ่า นักเรียนอธิบายวิธีคิดได้ชัดเจน",
  summaryDetails: [{ label: "เศษส่วน", summary: "ฝึกโจทย์หกข้อ แก้ไขข้อผิดพลาดสองข้อหลังจากครูให้ตรวจสอบ ห.ร.ม." }],
  meetingUUID: "uuid-th",
}];

const RECORDING = { rawRecordings: [{ url: "https://files.wiseapp.live/rec.mp4", partIndex: 1 }], rawTranscript: [{ url: "https://files.wiseapp.live/rec.vtt" }] };

const ZOOM_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:30.000
Kevin (Kev) Y. Hsieh Online: Today we look at fractions

2
00:00:31.000 --> 00:01:00.000
Somchai (Tom.Ja) Jaidee: I think the answer is three quarters
`;

/** Tutor (speaker 1) explains; the student (speaker 2) answers — a long enough lesson to write from. */
function lessonTokens() {
  const tokens: Array<{ text: string; start_ms: number; end_ms: number; speaker: string }> = [];
  for (let i = 0; i < 12; i += 1) {
    const at = i * 60_000;
    tokens.push({ text: " Today we add fractions with unlike denominators and simplify the answer to its lowest terms, step by step.", start_ms: at, end_ms: at + 25_000, speaker: "1" });
    tokens.push({ text: " I got three quarters because I found the common denominator first and then simplified.", start_ms: at + 31_000, end_ms: at + 55_000, speaker: "2" });
  }
  return tokens;
}

function fakeSoniox(options: {
  finishAfterPolls?: number;
  /** Status per poll, the last one repeating; overrides `finishAfterPolls`. */
  statuses?: Array<"processing" | "completed" | "throw">;
  error?: string;
  getThrows?: boolean;
  removeFails?: boolean;
  audioDurationMs?: number;
  tokens?: ReturnType<typeof lessonTokens>;
  listed?: Array<{ id: string; createdAt: Date | null; clientReferenceId: string | null; status: string }>;
} = {}) {
  const removed: string[] = [];
  const created: Array<{ audioUrl: string }> = [];
  const polled: string[] = [];
  const tokens = options.tokens ?? lessonTokens();
  const client = {
    create: vi.fn(async (input: { audioUrl: string }) => { created.push(input); return { id: `job-${created.length}` }; }),
    get: vi.fn(async (id: string) => {
      polled.push(id);
      if (options.getThrows) throw new SonioxError("HTTP 500: upstream", 500);
      if (options.error) return { status: "error" as const, audioDurationMs: null, errorMessage: options.error };
      const scripted = options.statuses ? options.statuses[Math.min(polled.length, options.statuses.length) - 1] : null;
      if (scripted === "throw") throw new SonioxError("HTTP 502: bad gateway", 502);
      const done = scripted ? scripted === "completed" : polled.length > (options.finishAfterPolls ?? 0);
      return done
        ? { status: "completed" as const, audioDurationMs: options.audioDurationMs ?? 3_600_000, errorMessage: null }
        : { status: "processing" as const, audioDurationMs: null, errorMessage: null };
    }),
    transcript: vi.fn(async () => ({ text: tokens.map((t) => t.text).join(""), tokens })),
    remove: vi.fn(async (id: string) => {
      if (options.removeFails) throw new SonioxError("HTTP 503: busy", 503);
      removed.push(id);
      return "deleted" as const;
    }),
    list: vi.fn(async () => options.listed ?? []),
  };
  return { client, removed, created, polled };
}

describe("second pass: Soniox transcript (Postgres + fakes)", () => {
  const transcriptDeps = (ops: WiseFeedbackOps, soniox: ReturnType<typeof fakeSoniox>["client"], overrides: Partial<AutowriterDeps> = {}) =>
    deps(ops, { transcriptsEnabled: true, soniox, fetchText: async () => ZOOM_VTT, ...overrides });

  it("hands a mostly-Thai summary to the transcript pass without calling a model", async () => {
    await seedRow();
    const wise = fakeWise({ details: [sessionDetail({ rawMeetingSummary: THAI_SUMMARY })] });
    const model = fakeModel();
    const outcome = await processSession(transcriptDeps(wise.ops, fakeSoniox().client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" });
    expect(outcome).toMatchObject({ result: "awaiting_recording", detail: "thai_summary" });
    expect(model.calls).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "awaiting_recording", evidence: "transcript" });
  });

  it("with the second pass off, still writes a Thai summary the old way", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow();
    const wise = fakeWise({ details: [sessionDetail({ rawMeetingSummary: THAI_SUMMARY })] });
    expect(await processSession(deps(wise.ops), { wiseSessionId: SESSION_ID, trigger: "cron" })).toMatchObject({ result: "would_submit" });
  });

  it("hands a class over when the summary draft is held, and when no summary came within 30 min", async () => {
    await seedRow();
    const models: string[] = [];
    const unfaithful = vi.fn(async (request: { schemaName: string; model: string }) => {
      models.push(request.model);
      if (request.schemaName !== "post_class_feedback") return glm(JSON.stringify({ ...PASSING_VERDICT, faithful: false, unsupported: ["scored 95%"] }));
      return request.model === "openai/gpt-6-luna" ? luna(writerJson) : sol(writerJson);
    });
    const held = await processSession(transcriptDeps(fakeWise().ops, fakeSoniox().client, { callModel: unfaithful as never }), { wiseSessionId: SESSION_ID, trigger: "cron" });
    expect(held).toMatchObject({ result: "awaiting_recording", detail: "summary_draft_held" });
    // Both summary drafts were tried (Sol, then the Luna fallback) before the handover.
    expect(models).toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash", "openai/gpt-6-luna", "z-ai/glm-5.3-flash"]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "awaiting_recording", evidence: "transcript" });

    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    await seedRow();
    const noSummary = fakeWise({ details: [sessionDetail({ rawMeetingSummary: [] })] });
    const at45 = new Date("2026-09-28T10:15:00.000Z");
    expect(await processSession(transcriptDeps(noSummary.ops, fakeSoniox().client, { now: () => at45 }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "awaiting_recording", detail: "no_usable_summary" });
  });

  it("waits while Wise has no recording yet", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const soniox = fakeSoniox();
    expect(await processSession(transcriptDeps(fakeWise().ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "awaiting_recording", detail: "recording_not_ready" });
    expect(soniox.created).toEqual([]);
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("awaiting_recording");
  });

  it("transcribes the recording, writes from it with Sol (GLM judge), posts, and deletes the Soniox job", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    const soniox = fakeSoniox();
    const models: string[] = [];
    const prompts: string[] = [];
    const callModel = vi.fn(async (request: { model: string; schemaName: string; messages: Array<{ content: string }> }) => {
      models.push(request.model);
      prompts.push(request.messages.map((message) => message.content).join("\n"));
      return request.schemaName === "post_class_feedback" ? sol(writerJson) : glm(FAITHFUL_VERDICT);
    });
    const outcome = await processSession(transcriptDeps(wise.ops, soniox.client, { callModel: callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" });
    expect(outcome).toMatchObject({ result: "verified" });
    expect(soniox.created).toEqual([expect.objectContaining({ audioUrl: "https://files.wiseapp.live/rec.mp4" })]);
    expect(soniox.removed).toEqual([]); // kept for review (triage), at most 72 h
    expect(models).toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash"]);
    expect(prompts[0]).toContain("Lesson transcript:");
    expect(prompts[0]).toContain("TUTOR: Today we add fractions");
    expect(prompts[0]).toContain("STUDENT: I got three quarters");
    expect(wise.posts).toHaveLength(1);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "verified", evidence: "transcript", arm: "sol", sonioxTranscriptionId: "job-1" });
    // Stamped with what produced it.
    expect(row?.metadata).toMatchObject({ pipeline: { promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION, arm: "sol", evidence: "transcript" } });
    expect(row?.metadata).toMatchObject({ transcript: { speakerMethod: "zoom_alignment", audioMinutes: 60 } });
    const calls = await db.select().from(schema.feedbackAutowriterCalls).where(eq(schema.feedbackAutowriterCalls.role, "transcriber"));
    expect(calls).toHaveLength(1);
    expect(Number(calls[0].costUsd)).toBeCloseTo(0.1);
  });

  it("falls back to Luna when the judge rejects Sol's transcript draft, instead of holding the class", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    const soniox = fakeSoniox();
    const models: string[] = [];
    let judged = 0;
    const callModel = vi.fn(async (request: { model: string; schemaName: string }) => {
      models.push(request.model);
      if (request.schemaName === "post_class_feedback") return request.model === "openai/gpt-6-luna" ? luna(writerJson) : sol(writerJson);
      judged += 1;
      return glm(JSON.stringify(judged === 1 ? { ...PASSING_VERDICT, faithful: false, unsupported: ["scored 95%"] } : PASSING_VERDICT));
    });
    expect(await processSession(transcriptDeps(wise.ops, soniox.client, { callModel: callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "verified" });
    expect(models).toEqual(["openai/gpt-6.1-sol", "z-ai/glm-5.3-flash", "openai/gpt-6-luna", "z-ai/glm-5.3-flash"]);
    expect(wise.posts).toHaveLength(1);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "verified", evidence: "transcript", arm: "luna", metadata: { pipeline: { arm: "luna", evidence: "transcript" } },
    });
    const writers = await db.select().from(schema.feedbackAutowriterCalls).where(eq(schema.feedbackAutowriterCalls.role, "writer"));
    expect(writers.map((call) => call.arm).toSorted()).toEqual(["luna", "sol"]);
  });

  it("leaves a slow transcription for the next run, which finishes it", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    const soniox = fakeSoniox({ finishAfterPolls: 100 });
    const first = await processSession(transcriptDeps(wise.ops, soniox.client, { deadlineMs: Date.now() + 600_000 }), { wiseSessionId: SESSION_ID, trigger: "webhook" });
    expect(first).toMatchObject({ result: "transcribing", detail: "job-1" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "transcribing", sonioxTranscriptionId: "job-1" });

    const done = fakeSoniox();
    await db.update(S).set({ nextAttemptAt: sql`now() - interval '1 second'` as never }).where(eq(S.wiseSessionId, SESSION_ID));
    const result = await runSweep(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, done.client));
    expect(result.processed).toEqual({ verified: 1 });
    expect(done.created).toEqual([]); // reused job-1, no second transcription
    expect(done.removed).toEqual([]); // kept for review
  });

  it("holds the class for a person after repeated Soniox errors", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript", metadata: { transcribeErrors: 2 } });
    const soniox = fakeSoniox({ error: "audio_url could not be fetched" });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "held" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "held", metadata: { alertKind: "held", transcribeErrors: 3 } });
    expect(soniox.removed).toEqual(["job-1"]);
  });

  it("reuses a judged transcript draft whose POST did not go out — no second transcription or model call", async () => {
    // A GLM draft the current prompt and judge wrote before the switch to Sol is still posted as it is.
    const written = { commitSha: "commit-that-wrote-it", promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION, arm: "glm", evidence: "transcript" };
    await seedRow({
      state: "awaiting_recording", evidence: "transcript", sonioxTranscriptionId: "job-5",
      arm: "glm", fields: GOOD_FIELDS,
      billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
      metadata: { draftEvidence: "transcript", judge: PASSING_VERDICT, pipeline: written },
    });
    const soniox = fakeSoniox();
    const model = fakeModel();
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "commit-that-posted-it");
    try {
      expect(await processSession(transcriptDeps(wise.ops, soniox.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
        .toMatchObject({ result: "verified" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(model.calls).toEqual([]);
    expect(soniox.created).toEqual([]);
    expect(soniox.client.get).not.toHaveBeenCalled();
    expect(soniox.removed).toEqual([]); // kept for review
    expect(wise.posts).toHaveLength(1);
    // Credited to the code that wrote and judged the text, not the deploy that happened to send it.
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ pipeline: written, postedFromCommit: "commit-that-posted-it" });
  });

  it("never reuses a transcript draft an older prompt or judge wrote: writes and judges it again from the kept job", async () => {
    // v4 (30 Sep): a v3 draft would skip the who-did-what and homework checks.
    const written = { commitSha: "commit-that-wrote-it", promptVersion: 3, judgeVersion: 3, arm: "glm", evidence: "transcript" };
    await seedRow({
      state: "awaiting_recording", evidence: "transcript", sonioxTranscriptionId: "job-5",
      arm: "glm", fields: GOOD_FIELDS,
      billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
      metadata: { draftEvidence: "transcript", judge: { faithful: true, unsupported: [] }, pipeline: written },
    });
    const soniox = fakeSoniox();
    const model = fakeModel();
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    expect(await processSession(transcriptDeps(wise.ops, soniox.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "verified" });
    expect(soniox.created).toEqual([]); // the kept job is read again, not transcribed again
    expect(soniox.polled).toEqual(["job-5"]);
    expect(model.calls).toEqual(["post_class_feedback", "feedback_faithfulness"]);
    expect(wise.posts).toHaveLength(1);
    // The older GLM draft is replaced by one Sol writes now.
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      arm: "sol",
      metadata: {
        judge: PASSING_VERDICT,
        pipeline: { promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION, arm: "sol", evidence: "transcript" },
      },
    });
  });

  it("never reuses a draft written from the summary", async () => {
    await seedRow({
      state: "awaiting_recording", evidence: "transcript", arm: "glm", fields: GOOD_FIELDS,
      metadata: { draftEvidence: "summary", judge: { faithful: true, unsupported: [] } },
    });
    const soniox = fakeSoniox();
    await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "cron" });
    expect(soniox.created).toHaveLength(1);
  });

  it("holds the class when it cannot tell tutor from student", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const even = lessonTokens().map((token, index) => ({ ...token, speaker: String((index % 3) + 1) }));
    const soniox = fakeSoniox({ tokens: even });
    // Zoom's transcript is published but names nobody: nothing to wait for.
    expect(await processSession(
      transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client, { fetchText: async () => "WEBVTT\n" }),
      { wiseSessionId: SESSION_ID, trigger: "webhook" },
    )).toMatchObject({ result: "held", detail: "speakers_unclear" });
    expect(soniox.removed).toEqual([]); // kept so the hold can be reviewed
  });

  it("the backstop only looks at a running job, and counts Soniox status errors", async () => {
    await seedRow({ state: "transcribing", evidence: "transcript", sonioxTranscriptionId: "job-7" });
    const slow = fakeSoniox({ finishAfterPolls: 5 });
    const result = await runSweep(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, slow.client));
    expect(result.processed).toEqual({ transcribing: 1 });
    expect(slow.client.get).toHaveBeenCalledTimes(1);

    await db.update(S).set({ nextAttemptAt: sql`now() - interval '1 second'` as never }).where(eq(S.wiseSessionId, SESSION_ID));
    const down = fakeSoniox({ getThrows: true });
    const failed = await runSweep(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, down.client));
    expect(failed.processed).toEqual({ infra: 1 });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "transcribing", sonioxTranscriptionId: "job-7", metadata: { transcribeErrors: 1 } });
  });

  it("alerts when a class is still waiting for its recording 3 h after class", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript", scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000) });
    const sweepDeps = transcriptDeps(fakeWise().ops, fakeSoniox().client);
    const result = await runSweep(sweepDeps);
    expect(result.alertsSent).toBe(1);
    expect(sweepDeps.emails[0].text).toContain("is still not ready 3 hours after class");
    expect((await readSessionRow(db, SESSION_ID))?.alertsSent).toHaveProperty("no_recording");
  });

  it("does not alert while a class only waits to read Wise again", async () => {
    // Since v4 a failed read also sends an older version's transcript draft back to wait for its (existing) recording.
    await seedRow({
      state: "awaiting_recording", evidence: "transcript", reason: "wise_read_failed",
      scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000),
    });
    const sweepDeps = transcriptDeps(fakeWise().ops, fakeSoniox().client);
    expect((await runSweep(sweepDeps)).alertsSent).toBe(0);
    expect((await readSessionRow(db, SESSION_ID))?.alertsSent).not.toHaveProperty("no_recording");
  });

  it("reaps old Soniox jobs nothing references, and leaves referenced ones", async () => {
    await seedRow({ state: "transcribing", evidence: "transcript", sonioxTranscriptionId: "job-live", nextAttemptAt: new Date(Date.now() + 3600_000) });
    const old = new Date(Date.now() - 3 * 3600_000);
    const soniox = fakeSoniox({ listed: [
      { id: "job-orphan", createdAt: old, clientReferenceId: "6a0000000000000000000abc", status: "completed" },
      { id: "job-live", createdAt: old, clientReferenceId: SESSION_ID, status: "completed" },
      { id: "job-fresh", createdAt: new Date(), clientReferenceId: "6a0000000000000000000abd", status: "processing" },
      { id: "job-other", createdAt: old, clientReferenceId: "someone-else", status: "completed" },
    ] });
    await runSweep(transcriptDeps(fakeWise().ops, soniox.client));
    expect(soniox.removed).toEqual(["job-orphan"]);
  });

  it("waits for Zoom's named transcript when the recording's comes first, then writes with confirmed labels", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const recordingOnly = sessionDetail({ rawRecordings: RECORDING.rawRecordings });
    const model = fakeModel();
    const first = fakeSoniox();
    expect(await processSession(transcriptDeps(fakeWise({ details: [recordingOnly] }).ops, first.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "transcribing", detail: "zoom_transcript_pending" });
    expect(model.calls).toEqual([]);
    expect(first.removed).toEqual([]);
    const waiting = await readSessionRow(db, SESSION_ID);
    expect(waiting).toMatchObject({ state: "transcribing", reason: "zoom_transcript_pending", sonioxTranscriptionId: "job-1" });
    expect(waiting?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(Date.now() + 4 * 60_000);

    // Zoom's transcript is out by the next look: the same job is re-fetched and the labels are confirmed.
    await db.update(S).set({ nextAttemptAt: sql`now() - interval '1 second'` as never }).where(eq(S.wiseSessionId, SESSION_ID));
    const second = fakeSoniox();
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, second.client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "verified" });
    expect(second.created).toEqual([]);
    expect(second.removed).toEqual([]); // kept for review
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ transcript: { speakerMethod: "zoom_alignment" } });
    const transcribed = await db.select().from(schema.feedbackAutowriterCalls).where(eq(schema.feedbackAutowriterCalls.role, "transcriber"));
    expect(transcribed).toHaveLength(1); // the transcription is paid for once
  });

  it("stops waiting for Zoom 20 minutes after the job was submitted and falls back to a clear talk share", async () => {
    await seedRow({
      state: "transcribing", evidence: "transcript", sonioxTranscriptionId: "job-7",
      metadata: { sonioxSubmittedJob: "job-7", sonioxSubmittedAt: new Date(Date.now() - 25 * 60_000).toISOString() },
    });
    // The tutor clearly does most of the talking.
    const tokens = lessonTokens().map((token) => token.speaker === "2" ? { ...token, text: " Three quarters." } : token);
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail({ rawRecordings: RECORDING.rawRecordings })] }).ops, fakeSoniox({ tokens }).client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "verified" });
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ transcript: { speakerMethod: "talk_share" } });
  });

  it("does not wait for Zoom when Wise gives no teacher name to match its cues", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const tokens = lessonTokens().map((token) => token.speaker === "2" ? { ...token, text: " Three quarters." } : token);
    const nameless = sessionDetail({ rawRecordings: RECORDING.rawRecordings, userId: { _id: KEVIN } });
    expect(await processSession(transcriptDeps(fakeWise({ details: [nameless] }).ops, fakeSoniox({ tokens }).client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "verified" });
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ transcript: { speakerMethod: "talk_share" } });
  });

  it("treats a Zoom transcript that cannot be read right now like one not published yet", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const failing = async () => { throw new Error("HTTP 503"); };
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fakeSoniox().client, { fetchText: failing }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "transcribing", detail: "zoom_transcript_pending" });
  });

  it("deletes a finished class's leftover Soniox job during the sweep once its review window is over", async () => {
    await seedRow({ state: "expired", sonioxTranscriptionId: "job-9", metadata: { sonioxRetainUntil: "2026-01-01T00:00:00.000Z" } });
    const soniox = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, soniox.client));
    expect(soniox.removed).toEqual(["job-9"]);
    expect((await readSessionRow(db, SESSION_ID))?.sonioxTranscriptionId).toBeNull();
  });

  it("holds a recording much shorter than the class, after one recheck, without sending it to Soniox", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const soniox = fakeSoniox();
    const short = { ...RECORDING, rawRecordings: [{ ...RECORDING.rawRecordings[0], duration: 1_200 }] }; // 20 of 60 min
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(short)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "awaiting_recording", detail: "recording_too_short" });
    const first = await readSessionRow(db, SESSION_ID);
    expect(first).toMatchObject({ state: "awaiting_recording", metadata: { recordingShortSeenAt: expect.any(String) } });
    expect(first?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(Date.now() + 25 * 60_000);

    // A repeated RecordingCompleted webhook seconds later cannot shorten the 30-min wait.
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(short)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "awaiting_recording", detail: "recording_too_short" });

    const firstSeen = new Date(Date.now() - 31 * 60_000).toISOString();
    await db.update(S).set({
      nextAttemptAt: sql`now() - interval '1 second'` as never,
      metadata: sql`${S.metadata} || ${JSON.stringify({ recordingShortSeenAt: firstSeen })}::jsonb` as never,
    }).where(eq(S.wiseSessionId, SESSION_ID));
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(short)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "held", detail: "recording_too_short" });
    expect(soniox.created).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "held", metadata: { alertKind: "held", recordingSeconds: 1_200 } });
  });

  it("holds when Soniox hears much less audio than the class, and deletes the job", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const soniox = fakeSoniox({ audioDurationMs: 20 * 60_000 });
    const model = fakeModel();
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "held", detail: "recording_too_short" });
    expect(model.calls).toEqual([]);
    expect(soniox.removed).toEqual([]); // kept so the hold can be reviewed
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ transcript: { audioMinutes: 20 } });
  });

  it("holds a recording in several parts rather than write up part of a lesson", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const soniox = fakeSoniox();
    const parts = { rawRecordings: [{ url: "https://files.wiseapp.live/a.mp4", partIndex: 1 }, { url: "https://files.wiseapp.live/b.mp4", partIndex: 2 }] };
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(parts)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "held", detail: "recording_multiple_parts" });
    expect(soniox.created).toEqual([]);
  });

  it("abandons a Soniox job still running an hour after it was submitted", async () => {
    await seedRow({
      state: "transcribing", evidence: "transcript", sonioxTranscriptionId: "job-7",
      metadata: { sonioxSubmittedJob: "job-7", sonioxSubmittedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
    });
    const stuck = fakeSoniox({ finishAfterPolls: 100 });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, stuck.client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "infra", detail: "soniox_timeout" });
    expect(stuck.removed).toEqual(["job-7"]);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "awaiting_recording", sonioxTranscriptionId: null, metadata: { transcribeErrors: 1 } });
    expect(row?.metadata).not.toHaveProperty("sonioxSubmittedAt"); // cleared with the job
  });

  it("never times a job against another job's submit time", async () => {
    // A stamp left from an earlier job must not kill the job this run creates …
    const stale = { sonioxSubmittedJob: "job-old", sonioxSubmittedAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    await seedRow({ state: "awaiting_recording", evidence: "transcript", metadata: stale });
    const fresh = fakeSoniox({ finishAfterPolls: 100 });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fresh.client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "transcribing", detail: "job-1" });
    expect(fresh.removed).toEqual([]);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ sonioxSubmittedJob: "job-1" });

    // … nor a stored job it does not belong to.
    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    await seedRow({ state: "transcribing", evidence: "transcript", sonioxTranscriptionId: "job-7", metadata: stale });
    const slow = fakeSoniox({ finishAfterPolls: 100 });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, slow.client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "transcribing", detail: "job-7" });
    expect(slow.removed).toEqual([]);
  });

  it("returns a row with a submitted job to transcribing when Wise cannot be read", async () => {
    await seedRow({ state: "transcribing", evidence: "transcript", sonioxTranscriptionId: "job-7" });
    expect(await processSession(transcriptDeps(fakeWise({ failReads: true }).ops, fakeSoniox().client), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "infra", detail: "wise_read_failed" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "transcribing", sonioxTranscriptionId: "job-7" });
  });

  it("returns a row with a judged transcript draft to pending, not to waiting for the recording, when Wise cannot be read", async () => {
    // Only a complete, passing verdict from the current prompt and judge is reused (v4, 30 Sep). Any other draft is
    // written again, so it waits for the recording like a class with no draft.
    const current = { promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION };
    const cases: Array<[string, Record<string, unknown>, "pending" | "awaiting_recording"]> = [
      ["current draft", { judge: PASSING_VERDICT, pipeline: current }, "pending"],
      ["v3 verdict, no stamp", { judge: { faithful: true, unsupported: [] } }, "awaiting_recording"],
      ["current stamp, incomplete verdict", { judge: { faithful: true, unsupported: [] }, pipeline: current }, "awaiting_recording"],
      ["current stamp, a problem listed", { judge: { ...PASSING_VERDICT, misattributed: ["x"] }, pipeline: current }, "awaiting_recording"],
      ["current prompt, previous judge", { judge: PASSING_VERDICT, pipeline: { ...current, judgeVersion: 3 } }, "awaiting_recording"],
      ["previous prompt, current judge", { judge: PASSING_VERDICT, pipeline: { ...current, promptVersion: 3 } }, "awaiting_recording"],
    ];
    for (const [label, draft, state] of cases) {
      await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
      await seedRow({ state: "pending", evidence: "transcript", arm: "glm", fields: GOOD_FIELDS, metadata: { draftEvidence: "transcript", ...draft } });
      expect(await processSession(transcriptDeps(fakeWise({ failReads: true }).ops, fakeSoniox().client), { wiseSessionId: SESSION_ID, trigger: "cron" }), label)
        .toMatchObject({ result: "infra", detail: "wise_read_failed" });
      expect((await readSessionRow(db, SESSION_ID))?.state, label).toBe(state);
    }
  });

  it("stamps a new job's submit time, and does not count a failed status check once Soniox has answered", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const flaky = fakeSoniox({ statuses: ["processing", "throw"] });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, flaky.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "transcribing", detail: "job-1" });
    expect(flaky.polled.length).toBeGreaterThan(1);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "transcribing", sonioxTranscriptionId: "job-1" });
    expect(row?.metadata).not.toHaveProperty("transcribeErrors");
    expect(row?.metadata).toMatchObject({ sonioxSubmittedJob: "job-1" });
    const submittedAt = new Date(String((row?.metadata as { sonioxSubmittedAt?: unknown }).sonioxSubmittedAt));
    expect(Math.abs(Date.now() - submittedAt.getTime())).toBeLessThan(60_000);
  });

  it("keeps the judged transcript draft when the pre-POST check says wait, and posts it next time without transcribing again", async () => {
    const justEnded = new Date("2026-09-28T09:35:00.000Z");
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const noStudentYet = sessionDetail({ ...RECORDING, participants: sessionDetail().participants.filter((participant) => participant.isTeacher) });
    // Read 1: the transcript pass; read 2: submit's student read; read 3: the fresh pre-POST read.
    const wise = fakeWise({ details: [sessionDetail(RECORDING), sessionDetail(RECORDING), noStudentYet] });
    const soniox = fakeSoniox();
    expect(await processSession(transcriptDeps(wise.ops, soniox.client, { now: () => justEnded }), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "retry", detail: "student_count_0" });
    expect(wise.posts).toHaveLength(0);
    // Waiting for Wise, not for the recording: `pending`, so no `no_recording` alert.
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "pending",
      evidence: "transcript",
      arm: "sol",
      fields: expect.objectContaining({ topics: GOOD_FIELDS.topics }),
      metadata: { draftEvidence: "transcript", judge: { faithful: true } },
    });
    // Not done yet: its transcript's review window has not started.
    expect((await readSessionRow(db, SESSION_ID))?.metadata).not.toHaveProperty("sonioxRetainUntil");

    await db.update(S).set({ nextAttemptAt: sql`now() - interval '1 second'` as never }).where(eq(S.wiseSessionId, SESSION_ID));
    const again = fakeSoniox();
    const model = fakeModel();
    const retry = fakeWise({ details: [sessionDetail(RECORDING)] });
    expect(await processSession(transcriptDeps(retry.ops, again.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "verified" });
    expect(again.created).toEqual([]);
    expect(model.calls).toEqual([]);
    expect(retry.posts).toHaveLength(1);
    // The window starts at the first sweep after the POST, not at the attempt that had to wait.
    await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    const retainUntil = new Date(String(((await readSessionRow(db, SESSION_ID))?.metadata as { sonioxRetainUntil?: unknown }).sonioxRetainUntil)).getTime();
    expect(retainUntil - Date.now()).toBeGreaterThan(71.9 * 3600_000);
  });

  it("never starts the review window of a class still being worked on", async () => {
    await seedRow({
      state: "transcribing", reason: "zoom_transcript_pending", evidence: "transcript", sonioxTranscriptionId: "job-3",
      nextAttemptAt: new Date(Date.now() + 3600_000),
    });
    const soniox = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, soniox.client));
    expect(soniox.removed).toEqual([]);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).not.toHaveProperty("sonioxRetainUntil");

    await db.update(S).set({ state: "held", reason: "speakers_unclear" }).where(eq(S.wiseSessionId, SESSION_ID));
    await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toHaveProperty("sonioxRetainUntil");
  });

  it("with the autowriter off, still starts and ends the window of a class left unfinished past its deadline", async () => {
    await updateControl(db, { mode: "off" }, "t@x.com");
    await seedRow({
      state: "transcribing", reason: "zoom_transcript_pending", evidence: "transcript", sonioxTranscriptionId: "job-4",
      deadlineAt: new Date(Date.now() - 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000),
    });
    await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toHaveProperty("sonioxRetainUntil");

    await db.update(S).set({ metadata: sql`${S.metadata} || jsonb_build_object('sonioxRetainUntil', now() - interval '1 minute')` as never })
      .where(eq(S.wiseSessionId, SESSION_ID));
    const over = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, over.client));
    expect(over.removed).toEqual(["job-4"]);
  });

  it("cleans up Soniox jobs on their own, as the job does when the autowriter is switched off", async () => {
    await seedRow({ state: "held", evidence: "transcript", sonioxTranscriptionId: "job-8", metadata: { sonioxRetainUntil: "2026-01-01T00:00:00.000Z" } });
    const soniox = fakeSoniox();
    await cleanUpSonioxJobs(transcriptDeps(fakeWise().ops, soniox.client), soniox.client as never);
    expect(soniox.removed).toEqual(["job-8"]);
  });

  it("works from the row as it is under the lease, not as first read", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    // Simulates another worker submitting a Soniox job between this worker's first read and its claim.
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION autowriter_test_race() RETURNS trigger AS $$
      BEGIN IF NEW.state = 'generating' AND OLD.state <> 'generating' THEN NEW.soniox_transcription_id := 'job-other'; END IF; RETURN NEW; END
      $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER autowriter_test_race BEFORE UPDATE ON feedback_autowriter_sessions
      FOR EACH ROW EXECUTE FUNCTION autowriter_test_race()`));
    try {
      const soniox = fakeSoniox();
      expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
        .toMatchObject({ result: "verified" });
      expect(soniox.created).toEqual([]);
      expect(soniox.polled[0]).toBe("job-other");
      expect(soniox.removed).toEqual([]); // kept for review
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS autowriter_test_race ON feedback_autowriter_sessions"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS autowriter_test_race()"));
    }
  });

  it("keeps a finished class's Soniox job for review, and the sweep deletes it once triaged or after 72 h", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fakeSoniox().client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "would_submit" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "would_submit", sonioxTranscriptionId: "job-1" });

    // The first sweep to see it done starts its 72 h window; neither the reaper nor the cleanup touch it.
    const early = fakeSoniox({ listed: [{ id: "job-1", createdAt: new Date(Date.now() - 5 * 3600_000), clientReferenceId: SESSION_ID, status: "completed" }] });
    await runSweep(transcriptDeps(fakeWise().ops, early.client));
    expect(early.removed).toEqual([]);
    const retainUntil = new Date(String(((await readSessionRow(db, SESSION_ID))?.metadata as { sonioxRetainUntil?: unknown }).sonioxRetainUntil)).getTime();
    expect(retainUntil - Date.now()).toBeGreaterThan(71.9 * 3600_000);
    expect(retainUntil - Date.now()).toBeLessThanOrEqual(72.1 * 3600_000);

    // Triaged: deleted at the next sweep, and the id is cleared.
    await db.update(S).set({ metadata: sql`${S.metadata} || '{"triagedAt":"2026-09-29T15:00:00.000Z"}'::jsonb` as never }).where(eq(S.wiseSessionId, SESSION_ID));
    const refusing = fakeSoniox({ removeFails: true });
    await runSweep(transcriptDeps(fakeWise().ops, refusing.client));
    expect((await readSessionRow(db, SESSION_ID))?.sonioxTranscriptionId).toBe("job-1"); // a refused delete is retried
    const working = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, working.client));
    expect(working.removed).toEqual(["job-1"]);
    expect((await readSessionRow(db, SESSION_ID))?.sonioxTranscriptionId).toBeNull();

    // A window that ran out without triage: deleted too.
    await db.update(S).set({
      sonioxTranscriptionId: "job-2",
      metadata: sql`(${S.metadata} - 'triagedAt') || '{"sonioxRetainUntil":"2026-01-01T00:00:00.000Z"}'::jsonb` as never,
    }).where(eq(S.wiseSessionId, SESSION_ID));
    const expired = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, expired.client));
    expect(expired.removed).toEqual(["job-2"]);
  });

  it("starts the 72 h review window however a class ended, and a later sweep never extends it", async () => {
    // An error cap ends the class without ever reaching the posting code: its transcript is still reviewable.
    await seedRow({ state: "held", reason: "error:boom", evidence: "transcript", sonioxTranscriptionId: "job-9" });
    const first = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, first.client));
    expect(first.removed).toEqual([]);
    const stamped = ((await readSessionRow(db, SESSION_ID))?.metadata as { sonioxRetainUntil?: string }).sonioxRetainUntil;
    expect(new Date(String(stamped)).getTime() - Date.now()).toBeGreaterThan(71.9 * 3600_000);

    // Later sweeps (which touch the row's other columns) leave the window where it was.
    await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    expect(((await readSessionRow(db, SESSION_ID))?.metadata as { sonioxRetainUntil?: string }).sonioxRetainUntil).toBe(stamped);

    await db.update(S).set({ metadata: sql`${S.metadata} || jsonb_build_object('sonioxRetainUntil', now() - interval '1 minute')` as never })
      .where(eq(S.wiseSessionId, SESSION_ID));
    const over = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, over.client));
    expect(over.removed).toEqual(["job-9"]);
    expect((await readSessionRow(db, SESSION_ID))?.sonioxTranscriptionId).toBeNull();
  });

  it("stamps CLI runs with the local checkout's commit", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow();
    // `vercel env pull` writes an empty VERCEL_GIT_COMMIT_SHA; it must not hide the local stamp.
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("AUTOWRITER_LOCAL_COMMIT", "local:abc+dirty");
    try {
      expect(await processSession(deps(fakeWise().ops), { wiseSessionId: SESSION_ID, trigger: "cron" })).toMatchObject({ result: "would_submit" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ pipeline: { commitSha: "local:abc+dirty" } });
  });

  it("stamps a shadow draft with the commit, prompt and judge versions that wrote it", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow();
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    try {
      expect(await processSession(deps(fakeWise().ops), { wiseSessionId: SESSION_ID, trigger: "cron" })).toMatchObject({ result: "would_submit" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({
      pipeline: { commitSha: "abc123", promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION, arm: "sol", evidence: "summary" },
    });
  });

  it("holds a class for a person after its third unexpected error instead of retrying to the deadline", async () => {
    await seedRow({ metadata: { genericErrors: 2 } });
    const wise = fakeWise();
    const exploding = vi.fn(async () => { throw new Error("The operation was aborted due to timeout"); });
    expect(await processSession(deps(wise.ops, { callModel: exploding as never }), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "cron" }))
      .toMatchObject({ result: "held", detail: "error:The operation was aborted due to timeout" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "held", metadata: { genericErrors: 3, alertKind: "held" } });

    // An owner retry starts the count again: one more error is retried, not held.
    expect(await retryHeldSession(db, SESSION_ID, { minDeadline: new Date(NOW.getTime()), actor: "k@x.com" })).toBe(true);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).not.toHaveProperty("genericErrors");
    expect(await processSession(deps(fakeWise().ops, { callModel: exploding as never }), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "cron" }))
      .toMatchObject({ result: "infra" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", metadata: { genericErrors: 1 } });
  });

  it("counts errors from the row read under the lease, so another worker's count is not lost", async () => {
    await seedRow();
    // Another worker's two errors land between this worker's first read and its claim.
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION autowriter_test_count() RETURNS trigger AS $$
      BEGIN IF NEW.state = 'generating' AND OLD.state <> 'generating' THEN NEW.metadata := NEW.metadata || '{"genericErrors":2}'::jsonb; END IF; RETURN NEW; END
      $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER autowriter_test_count BEFORE UPDATE ON feedback_autowriter_sessions
      FOR EACH ROW EXECUTE FUNCTION autowriter_test_count()`));
    try {
      const exploding = vi.fn(async () => { throw new Error("boom"); });
      expect(await processSession(deps(fakeWise().ops, { callModel: exploding as never }), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "cron" }))
        .toMatchObject({ result: "held", detail: "error:boom" });
      expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "held", metadata: { genericErrors: 3 } });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS autowriter_test_count ON feedback_autowriter_sessions"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS autowriter_test_count()"));
    }
  });

  it("reports an error after the row left generating as infra, never as a hold it did not write", async () => {
    await seedRow({ metadata: { genericErrors: 2 } });
    // The row moves on (as after a POST claim) before the error surfaces: neither release applies.
    const late = vi.fn(async () => {
      await db.update(S).set({ state: "verified", leaseToken: null }).where(eq(S.wiseSessionId, SESSION_ID));
      throw new Error("store write failed");
    });
    expect(await processSession(deps(fakeWise().ops, { callModel: late as never }), { wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, trigger: "cron" }))
      .toMatchObject({ result: "infra" });
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "verified", metadata: { genericErrors: 2 } });
    expect(row?.metadata).not.toHaveProperty("alertKind");
  });

  it("raises no no-recording alert for a tutor who is switched off", async () => {
    await updateControl(db, { disabledTutors: [KEVIN] }, "t@x.com");
    await seedRow({ state: "awaiting_recording", evidence: "transcript", scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000) });
    const result = await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    expect(result.alertsSent).toBe(0);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).not.toHaveProperty("alertKind");
  });

  it("raises no no-recording alert while a short recording waits for its recheck, or on an infra retry", async () => {
    const longAgo = { scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000) };
    await seedRow({ state: "awaiting_recording", evidence: "transcript", reason: "recording_too_short", ...longAgo });
    expect((await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client))).alertsSent).toBe(0);
    await db.update(S).set({ reason: "infra:OPENROUTER_API_KEY missing" }).where(eq(S.wiseSessionId, SESSION_ID));
    expect((await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client))).alertsSent).toBe(0);
    await db.update(S).set({ state: "transcribing", reason: "zoom_transcript_pending" }).where(eq(S.wiseSessionId, SESSION_ID));
    expect((await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client))).alertsSent).toBe(0);
    await db.update(S).set({ state: "awaiting_recording" }).where(eq(S.wiseSessionId, SESSION_ID));
    await db.update(S).set({ reason: "recording_not_ready" }).where(eq(S.wiseSessionId, SESSION_ID));
    expect((await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client))).alertsSent).toBe(1);
  });

  it("still alerts for a waiting class with no known teacher while another tutor is switched off", async () => {
    await updateControl(db, { disabledTutors: [GIFT] }, "t@x.com");
    await seedRow({
      state: "awaiting_recording", evidence: "transcript", wiseTeacherUserId: null,
      scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000),
    });
    const result = await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    expect(result.alertsSent).toBe(1);
  });

  it("does no work on a row taken away between the claim and the re-read", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    // Simulates an owner action (or the rollback SQL) landing right after this worker's claim.
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION autowriter_test_takeover() RETURNS trigger AS $$
      BEGIN UPDATE feedback_autowriter_sessions SET state = 'held', lease_token = NULL, lease_until = NULL WHERE id = NEW.id; RETURN NULL; END
      $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER autowriter_test_takeover AFTER UPDATE ON feedback_autowriter_sessions
      FOR EACH ROW WHEN (NEW.state = 'generating' AND OLD.state <> 'generating') EXECUTE FUNCTION autowriter_test_takeover()`));
    try {
      const soniox = fakeSoniox();
      const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
      expect(await processSession(transcriptDeps(wise.ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
        .toMatchObject({ result: "busy_or_not_due", detail: "lease_lost" });
      expect(soniox.created).toEqual([]);
      expect(wise.reads()).toBe(0);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS autowriter_test_takeover ON feedback_autowriter_sessions"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS autowriter_test_takeover()"));
    }
    expect((await readSessionRow(db, SESSION_ID))?.state).toBe("held");
  });
});

// ---------------------------------------------------------------------------
// Transcript first (30 Sep): every class waits for the recording; the summary is only the fallback
// ---------------------------------------------------------------------------

describe("transcript first (Postgres + fakes)", () => {
  const CLASS_END = new Date("2026-09-28T09:30:00.000Z");
  const after = (minutes: number) => new Date(CLASS_END.getTime() + minutes * 60_000);
  const cron = { wiseSessionId: SESSION_ID, trigger: "cron" as const };
  const webhook = { wiseSessionId: SESSION_ID, trigger: "webhook" as const };
  const firstDeps = (ops: WiseFeedbackOps, soniox: ReturnType<typeof fakeSoniox>["client"], overrides: Partial<AutowriterDeps> = {}) =>
    deps(ops, { transcriptsEnabled: true, soniox, transcriptFirst: true, fetchText: async () => ZOOM_VTT, ...overrides });
  const HANDED_OVER = { handover: "transcript_first", summaryAtHandover: { characters: 420, thaiShare: 0 } };
  /** A class transcript first handed over, waiting for its recording. */
  const handedOver = (overrides: Partial<typeof S.$inferInsert> = {}) =>
    seedRow({ state: "awaiting_recording", evidence: "transcript", reason: "transcript_first", metadata: HANDED_OVER, ...overrides });
  /** A class that already fell back to the summary. */
  const FELL_BACK = { ...HANDED_OVER, summaryFallback: { cause: "no_recording", at: "2026-09-28T12:31:00.000Z" } };
  const dueInMs = async () => ((await readSessionRow(db, SESSION_ID))?.nextAttemptAt?.getTime() ?? Number.NaN) - Date.now();
  /** A reply served exactly as the requested model is pinned in `AUTOWRITER_MODELS` (the writer may change model). */
  const routed = (request: { model: string }, content: string): OpenRouterCallResult => {
    const config = (Object.values(AUTOWRITER_MODELS) as AutowriterModelConfig[]).find((entry) => entry.model === request.model);
    const base = glm(content);
    return base.ok ? { ...base, model: config?.expectModel ?? request.model, provider: config?.expectProvider ?? base.provider } : base;
  };
  const unfaithfulModel = () => vi.fn(async (request: { model: string; schemaName: string }) => request.schemaName === "post_class_feedback"
    ? routed(request, writerJson)
    : routed(request, JSON.stringify({ faithful: false, unsupported: ["scored 95%"], misattributed: [], homeworkNotSet: [] })));
  const promptRecorder = () => {
    const prompts: string[] = [];
    const callModel = vi.fn(async (request: { model: string; schemaName: string; messages: Array<{ content: string }> }) => {
      prompts.push(request.messages.map((message) => message.content).join("\n"));
      return routed(request, request.schemaName === "post_class_feedback" ? writerJson : FAITHFUL_VERDICT);
    });
    return { prompts, callModel };
  };

  it("hands a class that passes every gate to the transcript before the summary is used: no model call, no Soniox job yet", async () => {
    await seedRow();
    const model = fakeModel();
    const soniox = fakeSoniox();
    expect(await processSession(firstDeps(fakeWise().ops, soniox.client, { callModel: model.callModel as never, now: () => after(45) }), cron))
      .toMatchObject({ result: "awaiting_recording", detail: "transcript_first" });
    expect(model.calls).toEqual([]);
    expect(soniox.created).toEqual([]);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({
      state: "awaiting_recording", evidence: "transcript", reason: "transcript_first",
      metadata: { handover: "transcript_first", summaryAtHandover: { characters: expect.any(Number), thaiShare: 0 } },
    });
    expect((row?.metadata as { summaryAtHandover: { characters: number } }).summaryAtHandover.characters).toBeGreaterThan(200);
    // No recording yet: looked at again after the usual 30 minutes (Wise's RecordingCompletedEvent usually comes first).
    expect(await dueInMs()).toBeGreaterThan(28 * 60_000);
    expect(await dueInMs()).toBeLessThan(31 * 60_000);
  });

  it("runs every gate first: a class the tutor wrote, out of scope, with form or billing drift, or still settling is never handed over", async () => {
    const teacherOnly = sessionDetail().participants.filter((participant) => participant.isTeacher);
    const cases: Array<[string, Detail, string, string]> = [
      ["tutor wrote it", sessionDetail({ feedbackSubmissions: [autoBlankSubmission({ metadata: null, answers: answers(["Fractions", "Did well", "Practise", ""]) })] }), "skipped_human", "human_submission"],
      ["in person", sessionDetail({ type: "OFFLINE" }), "skipped_scope", "session_type_OFFLINE"],
      ["form switched off", sessionDetail({ feedbackForm: { _id: "form1", profile: "teacher", enabled: false, questions: [] } }), "held", "feedback_form_missing_or_disabled"],
      ["billing drift", sessionDetail({ feedbackSubmissions: [autoBlankSubmission({ creditsConsumed: 3 })] }), "held", "billing:auto_credits_3_vs_scheduled_1"],
      ["no student yet", sessionDetail({ participants: teacherOnly }), "pending", "student_count_0"],
    ];
    for (const [label, detail, state, reason] of cases) {
      await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
      await seedRow();
      const soniox = fakeSoniox();
      const model = fakeModel();
      await processSession(firstDeps(fakeWise({ details: [detail] }).ops, soniox.client, { callModel: model.callModel as never, now: () => after(45) }), cron);
      const row = await readSessionRow(db, SESSION_ID);
      expect(row, label).toMatchObject({ state, reason, evidence: "summary" });
      expect(row?.metadata, label).not.toHaveProperty("handover");
      expect(soniox.created, label).toEqual([]);
      expect(model.calls, label).toEqual([]);
    }
  });

  it("never waits for the summary: a webhook hands over at once, even before Wise has one", async () => {
    await seedRow();
    const wise = fakeWise({ details: [sessionDetail({ rawMeetingSummary: [] })] });
    // Any wait would be for the summary: fail fast instead of looping on a fake clock.
    const sleep = vi.fn(async () => { throw new Error("waited for the summary"); });
    expect(await processSession(firstDeps(wise.ops, fakeSoniox().client, { sleep, now: () => after(2) }), { ...webhook, waitForReadyMs: 180_000 }))
      .toMatchObject({ result: "awaiting_recording", detail: "transcript_first" });
    expect(sleep).not.toHaveBeenCalled();
    expect(wise.reads()).toBe(1);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).toMatchObject({ summaryAtHandover: { characters: 0, thaiShare: null } });
  });

  it("is due at once when Wise already has the recording, and never looks again after the fallback time", async () => {
    await seedRow();
    await processSession(firstDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fakeSoniox().client, { now: () => after(45) }), cron);
    expect(await dueInMs()).toBeLessThan(2_000);

    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    await seedRow();
    // 2 h 50 min after class and no recording yet: looked at again in 10 minutes, at the fallback time — not in 30.
    await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { now: () => after(170) }), cron);
    expect(await dueInMs()).toBeGreaterThan(8 * 60_000);
    expect(await dueInMs()).toBeLessThan(11 * 60_000);
  });

  it("writes the class from its transcript once the recording arrives, and posts it", async () => {
    await seedRow();
    expect(await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { now: () => after(1) }), webhook))
      .toMatchObject({ result: "awaiting_recording", detail: "transcript_first" });
    // Wise's RecordingCompletedEvent: a webhook skips the recheck wait.
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    const soniox = fakeSoniox();
    const { prompts, callModel } = promptRecorder();
    expect(await processSession(firstDeps(wise.ops, soniox.client, { callModel: callModel as never, now: () => after(40) }), webhook))
      .toMatchObject({ result: "verified" });
    expect(soniox.created).toHaveLength(1);
    expect(prompts[0]).toContain("Lesson transcript:");
    expect(prompts[0]).not.toContain("Lesson summary:");
    expect(wise.posts).toHaveLength(1);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({
      state: "verified", evidence: "transcript",
      metadata: { handover: "transcript_first", draftEvidence: "transcript", pipeline: { evidence: "transcript" } },
    });
    expect(row?.metadata).not.toHaveProperty("summaryFallback");
  });

  it("falls back to the summary with no recording 3 h after class, then writes and posts from it without handing over again", async () => {
    await handedOver();
    const soniox = fakeSoniox();
    expect(await processSession(firstDeps(fakeWise().ops, soniox.client, { now: () => after(181) }), cron))
      .toMatchObject({ result: "summary_fallback", detail: "no_recording" });
    expect(soniox.created).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "pending", evidence: "summary", reason: "summary_fallback:no_recording", nextAttemptAt: null,
      metadata: { handover: "transcript_first", summaryFallback: { cause: "no_recording", at: after(181).toISOString() } },
    });

    // The next run writes from the summary although transcript first is still on: no loop back to the transcript.
    const wise = fakeWise();
    const { prompts, callModel } = promptRecorder();
    expect(await processSession(firstDeps(wise.ops, fakeSoniox().client, { callModel: callModel as never, now: () => after(190) }), cron))
      .toMatchObject({ result: "verified" });
    expect(prompts[0]).toContain("Lesson summary:");
    expect(wise.posts).toHaveLength(1);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "verified", evidence: "summary",
      metadata: { draftEvidence: "summary", pipeline: { evidence: "summary" }, summaryFallback: { cause: "no_recording" } },
    });
  });

  it("keeps waiting for the recording until the fallback time; a class handed over for another reason keeps the 30-minute recheck", async () => {
    await handedOver();
    expect(await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { now: () => after(170) }), cron))
      .toMatchObject({ result: "awaiting_recording", detail: "recording_not_ready" });
    expect(await dueInMs()).toBeGreaterThan(8 * 60_000);
    expect(await dueInMs()).toBeLessThan(11 * 60_000);

    await db.update(S).set({ metadata: { handover: "thai_summary" }, nextAttemptAt: null }).where(eq(S.wiseSessionId, SESSION_ID));
    expect(await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { now: () => after(181) }), cron))
      .toMatchObject({ result: "awaiting_recording", detail: "recording_not_ready" });
    expect(await dueInMs()).toBeGreaterThan(28 * 60_000);
  });

  it("falls back on a recording in several parts, without sending any of it to Soniox", async () => {
    await handedOver();
    const soniox = fakeSoniox();
    const parts = { rawRecordings: [{ url: "https://files.wiseapp.live/a.mp4", partIndex: 1 }, { url: "https://files.wiseapp.live/b.mp4", partIndex: 2 }] };
    expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail(parts)] }).ops, soniox.client), webhook))
      .toMatchObject({ result: "summary_fallback", detail: "recording_multiple_parts" });
    expect(soniox.created).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "pending", evidence: "summary", metadata: { summaryFallback: { cause: "recording_multiple_parts" } },
    });
  });

  it("falls back when it cannot tell tutor from student, keeping the transcript's job for review", async () => {
    await handedOver();
    const even = lessonTokens().map((token, index) => ({ ...token, speaker: String((index % 3) + 1) }));
    const soniox = fakeSoniox({ tokens: even });
    const model = fakeModel();
    expect(await processSession(
      firstDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client, { callModel: model.callModel as never, fetchText: async () => "WEBVTT\n" }),
      webhook,
    )).toMatchObject({ result: "summary_fallback", detail: "speakers_unclear" });
    expect(model.calls).toEqual([]);
    expect(soniox.removed).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "pending", evidence: "summary", sonioxTranscriptionId: "job-1",
      metadata: { transcript: { speakerMethod: "unclear" }, summaryFallback: { cause: "speakers_unclear" } },
    });
  });

  it("falls back after the third Soniox failure", async () => {
    await handedOver({ metadata: { ...HANDED_OVER, transcribeErrors: 2 } });
    const soniox = fakeSoniox({ error: "audio_url could not be fetched" });
    expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client), cron))
      .toMatchObject({ result: "summary_fallback", detail: "soniox_failed" });
    expect(soniox.removed).toEqual(["job-1"]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "pending", evidence: "summary", sonioxTranscriptionId: null,
      metadata: {
        transcribeErrors: 3, sonioxFailure: "soniox_error:audio_url could not be fetched",
        summaryFallback: { cause: "soniox_failed" },
      },
    });
  });

  it("falls back when the transcript pass is switched off while the class waits; any other handed-over class is still held", async () => {
    // With a judged transcript draft kept for the POST slot: dropped with its verdict and stamp, the summary writes its own.
    await handedOver({
      state: "pending", sonioxTranscriptionId: "job-5", arm: "glm", fields: GOOD_FIELDS, fieldsSha256: "sha",
      metadata: { ...HANDED_OVER, draftEvidence: "transcript", judge: PASSING_VERDICT, pipeline: { promptVersion: PROMPT_VERSION, judgeVersion: JUDGE_PROMPT_VERSION } },
    });
    expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fakeSoniox().client, { transcriptsEnabled: false }), cron))
      .toMatchObject({ result: "summary_fallback", detail: "transcript_pass_off" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({
      state: "pending", evidence: "summary", arm: null, fields: null, fieldsSha256: null, sonioxTranscriptionId: "job-5",
      metadata: { judge: null, draftEvidence: null, pipeline: null, summaryFallback: { cause: "transcript_pass_off" } },
    });

    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    await handedOver({ reason: "thai_summary", metadata: { handover: "thai_summary" } });
    expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fakeSoniox().client, { transcriptsEnabled: false }), cron))
      .toMatchObject({ result: "held", detail: "transcript_pass_unavailable" });
  });

  it("still holds what the transcript shows: a recording or transcript too short for the class, a draft the judge rejects", async () => {
    const cases: Array<[string, Parameters<typeof fakeSoniox>[0], Partial<AutowriterDeps>, RegExp]> = [
      ["recording too short", { audioDurationMs: 20 * 60_000 }, {}, /^recording_too_short$/u],
      ["transcript too short", { tokens: lessonTokens().slice(0, 4) }, {}, /^transcript_too_short$/u],
      // Whatever writes transcripts (and any fallback writer) had its draft rejected.
      ["judge rejects the draft", {}, { callModel: unfaithfulModel() as never }, new RegExp(`^${AUTOWRITER_MODELS.writer.arm}:unfaithful:scored 95%`, "u")],
    ];
    for (const [label, sonioxOptions, overrides, reason] of cases) {
      await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
      await handedOver();
      expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, fakeSoniox(sonioxOptions).client, overrides), webhook), label)
        .toMatchObject({ result: "held", detail: expect.stringMatching(reason) });
      const row = await readSessionRow(db, SESSION_ID);
      expect(row, label).toMatchObject({ state: "held", metadata: { alertKind: "held" } });
      expect(row?.metadata, label).not.toHaveProperty("summaryFallback");
    }
  });

  it("never goes back to the transcript after a fallback: a Thai summary or a held summary draft is held, a missing summary retries and alerts", async () => {
    await seedRow({ metadata: FELL_BACK });
    const model = fakeModel();
    expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail({ rawMeetingSummary: THAI_SUMMARY })] }).ops, fakeSoniox().client,
      { callModel: model.callModel as never, now: () => after(190) }), cron))
      .toMatchObject({ result: "held", detail: "thai_summary_no_transcript" });
    expect(model.calls).toEqual([]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "held", evidence: "summary", metadata: { alertKind: "held" } });

    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    await seedRow({ metadata: FELL_BACK });
    const held = await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { callModel: unfaithfulModel() as never, now: () => after(190) }), cron);
    expect(held).toMatchObject({ result: "held" });
    expect(held.detail).toContain("unfaithful");
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "held", evidence: "summary" });

    await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
    await seedRow({ metadata: FELL_BACK });
    expect(await processSession(firstDeps(fakeWise({ details: [sessionDetail({ rawMeetingSummary: [] })] }).ops, fakeSoniox().client, { now: () => after(240) }), cron))
      .toMatchObject({ result: "retry", detail: "no_ai_summary" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", evidence: "summary", metadata: { alertKind: "no_summary" } });
  });

  it("raises no no-recording alert for a transcript-first class waiting for its recording (it falls back instead), but does for one stuck transcribing", async () => {
    const longAgo = { scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000) };
    await handedOver(longAgo);
    const result = await runSweep(firstDeps(fakeWise().ops, fakeSoniox().client));
    expect(result.alertsSent).toBe(0);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).not.toHaveProperty("alertKind");

    // A transcription still running 3 h after class has no time-based fallback: a person hears about it.
    await db.update(S).set({ state: "transcribing", reason: "transcription_in_progress", sonioxTranscriptionId: "job-2" })
      .where(eq(S.wiseSessionId, SESSION_ID));
    expect((await runSweep(firstDeps(fakeWise().ops, fakeSoniox().client))).alertsSent).toBe(1);
    expect((await readSessionRow(db, SESSION_ID))?.alertsSent).toHaveProperty("no_recording");
  });

  it("treats a fallback's Soniox job as done: kept for review, then deleted, while the class itself still waits on the summary", async () => {
    await seedRow({
      state: "pending", reason: "no_ai_summary", sonioxTranscriptionId: "job-3", nextAttemptAt: new Date(Date.now() + 3600_000),
      metadata: { ...FELL_BACK, summaryFallback: { cause: "speakers_unclear", at: "2026-09-28T11:00:00.000Z" } },
    });
    const first = fakeSoniox();
    await runSweep(firstDeps(fakeWise().ops, first.client));
    expect(first.removed).toEqual([]);
    const retainUntil = new Date(String(((await readSessionRow(db, SESSION_ID))?.metadata as { sonioxRetainUntil?: unknown }).sonioxRetainUntil)).getTime();
    expect(retainUntil - Date.now()).toBeGreaterThan(71.9 * 3600_000);

    await db.update(S).set({ metadata: sql`${S.metadata} || jsonb_build_object('sonioxRetainUntil', now() - interval '1 minute')` as never })
      .where(eq(S.wiseSessionId, SESSION_ID));
    const later = fakeSoniox();
    await runSweep(firstDeps(fakeWise().ops, later.client));
    expect(later.removed).toEqual(["job-3"]);
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "pending", sonioxTranscriptionId: null });
  });

  it("an owner retry clears the fallback, so the class may go to the transcript again", async () => {
    await seedRow({
      state: "held", reason: "thai_summary_no_transcript",
      metadata: { ...FELL_BACK, sonioxFailure: "soniox_error:x", alertKind: "held" },
    });
    expect(await retryHeldSession(db, SESSION_ID, { minDeadline: NOW, actor: "k@x.com" })).toBe(true);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "pending", evidence: "summary" });
    for (const key of ["handover", "summaryAtHandover", "summaryFallback", "sonioxFailure", "alertKind"]) {
      expect(row?.metadata).not.toHaveProperty(key);
    }
    expect(await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { now: () => after(45) }), cron))
      .toMatchObject({ result: "awaiting_recording", detail: "transcript_first" });
  });

  it("acts only together with the second pass", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    for (const overrides of [{ transcriptsEnabled: false }, { soniox: null }] as Array<Partial<AutowriterDeps>>) {
      await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions`);
      await seedRow();
      expect(await processSession(firstDeps(fakeWise().ops, fakeSoniox().client, { now: () => after(45), ...overrides }), cron), JSON.stringify(overrides))
        .toMatchObject({ result: "would_submit" });
      expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "would_submit", evidence: "summary" });
    }
  });
});
