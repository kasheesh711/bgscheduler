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
    const unfaithful = vi.fn(async (request: { schemaName: string }) => request.schemaName === "post_class_feedback"
      ? glm(writerJson)
      : glm(JSON.stringify({ faithful: false, unsupported: ["scored 95%"] })));
    const held = await processSession(transcriptDeps(fakeWise().ops, fakeSoniox().client, { callModel: unfaithful as never }), { wiseSessionId: SESSION_ID, trigger: "cron" });
    expect(held).toMatchObject({ result: "awaiting_recording", detail: "summary_draft_held" });
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

  it("transcribes the recording, writes from it on GLM only, posts, and deletes the Soniox job", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    const soniox = fakeSoniox();
    const models: string[] = [];
    const prompts: string[] = [];
    const callModel = vi.fn(async (request: { model: string; schemaName: string; messages: Array<{ content: string }> }) => {
      models.push(request.model);
      prompts.push(request.messages.map((message) => message.content).join("\n"));
      return request.schemaName === "post_class_feedback" ? glm(writerJson) : glm(JSON.stringify({ faithful: true, unsupported: [] }));
    });
    const outcome = await processSession(transcriptDeps(wise.ops, soniox.client, { callModel: callModel as never }), { wiseSessionId: SESSION_ID, trigger: "webhook" });
    expect(outcome).toMatchObject({ result: "verified" });
    expect(soniox.created).toEqual([expect.objectContaining({ audioUrl: "https://files.wiseapp.live/rec.mp4" })]);
    expect(soniox.removed).toEqual(["job-1"]);
    expect(models).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"]);
    expect(prompts[0]).toContain("Lesson transcript:");
    expect(prompts[0]).toContain("TUTOR: Today we add fractions");
    expect(prompts[0]).toContain("STUDENT: I got three quarters");
    expect(wise.posts).toHaveLength(1);
    const row = await readSessionRow(db, SESSION_ID);
    expect(row).toMatchObject({ state: "verified", evidence: "transcript", sonioxTranscriptionId: null });
    expect(row?.metadata).toMatchObject({ transcript: { speakerMethod: "zoom_alignment", audioMinutes: 60 } });
    const calls = await db.select().from(schema.feedbackAutowriterCalls).where(eq(schema.feedbackAutowriterCalls.role, "transcriber"));
    expect(calls).toHaveLength(1);
    expect(Number(calls[0].costUsd)).toBeCloseTo(0.1);
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
    expect(done.removed).toEqual(["job-1"]);
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
    await seedRow({
      state: "awaiting_recording", evidence: "transcript", sonioxTranscriptionId: "job-5",
      arm: "glm", fields: GOOD_FIELDS,
      billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
      metadata: { draftEvidence: "transcript", judge: { faithful: true, unsupported: [] } },
    });
    const soniox = fakeSoniox();
    const model = fakeModel();
    const wise = fakeWise({ details: [sessionDetail(RECORDING)] });
    expect(await processSession(transcriptDeps(wise.ops, soniox.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "verified" });
    expect(model.calls).toEqual([]);
    expect(soniox.created).toEqual([]);
    expect(soniox.client.get).not.toHaveBeenCalled();
    expect(soniox.removed).toEqual(["job-5"]);
    expect(wise.posts).toHaveLength(1);
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

  it("keeps the job id when Soniox refuses the delete, so the sweep can retry it", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const soniox = fakeSoniox({ removeFails: true });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, soniox.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "verified" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "verified", sonioxTranscriptionId: "job-1" });
  });

  it("holds the class when it cannot tell tutor from student", async () => {
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const even = lessonTokens().map((token, index) => ({ ...token, speaker: String((index % 3) + 1) }));
    const soniox = fakeSoniox({ tokens: even });
    expect(await processSession(
      transcriptDeps(fakeWise({ details: [sessionDetail({ rawRecordings: RECORDING.rawRecordings })] }).ops, soniox.client, { fetchText: async () => "WEBVTT\n" }),
      { wiseSessionId: SESSION_ID, trigger: "webhook" },
    )).toMatchObject({ result: "held", detail: "speakers_unclear" });
    expect(soniox.removed).toEqual(["job-1"]);
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

  it("deletes a finished class's leftover Soniox job during the sweep", async () => {
    await seedRow({ state: "expired", sonioxTranscriptionId: "job-9" });
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
    expect(first).toMatchObject({ state: "awaiting_recording", metadata: { recordingShortSeen: true } });
    expect(first?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(Date.now() + 25 * 60_000);

    await db.update(S).set({ nextAttemptAt: sql`now() - interval '1 second'` as never }).where(eq(S.wiseSessionId, SESSION_ID));
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
    expect(soniox.removed).toEqual(["job-1"]);
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
      arm: "glm",
      fields: expect.objectContaining({ topics: GOOD_FIELDS.topics }),
      metadata: { draftEvidence: "transcript", judge: { faithful: true } },
    });

    await db.update(S).set({ nextAttemptAt: sql`now() - interval '1 second'` as never }).where(eq(S.wiseSessionId, SESSION_ID));
    const again = fakeSoniox();
    const model = fakeModel();
    const retry = fakeWise({ details: [sessionDetail(RECORDING)] });
    expect(await processSession(transcriptDeps(retry.ops, again.client, { callModel: model.callModel as never }), { wiseSessionId: SESSION_ID, trigger: "cron" }))
      .toMatchObject({ result: "verified" });
    expect(again.created).toEqual([]);
    expect(model.calls).toEqual([]);
    expect(retry.posts).toHaveLength(1);
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
      expect(soniox.removed).toEqual(["job-other"]);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS autowriter_test_race ON feedback_autowriter_sessions"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS autowriter_test_race()"));
    }
  });

  it("deletes a shadow draft's Soniox job; the sweep retries a delete that failed", async () => {
    await updateControl(db, { mode: "shadow" }, "t@x.com");
    await seedRow({ state: "awaiting_recording", evidence: "transcript" });
    const refusing = fakeSoniox({ removeFails: true });
    expect(await processSession(transcriptDeps(fakeWise({ details: [sessionDetail(RECORDING)] }).ops, refusing.client), { wiseSessionId: SESSION_ID, trigger: "webhook" }))
      .toMatchObject({ result: "would_submit" });
    expect(await readSessionRow(db, SESSION_ID)).toMatchObject({ state: "would_submit", sonioxTranscriptionId: "job-1" });
    const working = fakeSoniox();
    await runSweep(transcriptDeps(fakeWise().ops, working.client));
    expect(working.removed).toEqual(["job-1"]);
    expect((await readSessionRow(db, SESSION_ID))?.sonioxTranscriptionId).toBeNull();
  });

  it("raises no no-recording alert for a tutor who is switched off", async () => {
    await updateControl(db, { disabledTutors: [KEVIN] }, "t@x.com");
    await seedRow({ state: "awaiting_recording", evidence: "transcript", scheduledEndAt: new Date(NOW.getTime() - 4 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000) });
    const result = await runSweep(transcriptDeps(fakeWise().ops, fakeSoniox().client));
    expect(result.alertsSent).toBe(0);
    expect((await readSessionRow(db, SESSION_ID))?.metadata).not.toHaveProperty("alertKind");
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
