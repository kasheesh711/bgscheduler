import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import { postDeadlineFallback } from "../deadline-fallback";
import { runSweep } from "../job";
import { detectNoShow } from "../no-show";
import { postNoShowNote } from "../no-show-post";
import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";
import { parseAutowriterSessionDetail } from "../session";
import {
  heldRecoverySubmitStore, listFallbackRows, readControl, retryHeldSession, updateControl, type AutowriterSessionRow,
} from "../store";
import { fieldsHash, submitFeedbackGuarded, type PostResult, type SubmitFeedbackEvent, type WiseFeedbackOps } from "../submit";
import type { WiseFeedbackPostBody } from "../types";
import { answers, autoBlankSubmission, CLASS_ID, GOOD_FIELDS, SESSION_ID, sessionDetail, STUDENT_ID, STUDENT_NAME } from "./fixtures";
import { AUTOWRITER_TEACHER_ALLOWLIST } from "../roster";

vi.mock("server-only", () => ({}));
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const S = schema.feedbackAutowriterSessions;
const API_ACTOR = "69366668c05630afe5d8a2a4";
const HOUR = 3_600_000;

/** A class that ended an hour ago (well before its deadline): the student never joined, the tutor waited 12 min. */
const noShowDetail = (overrides: Record<string, unknown> = {}) => sessionDetail({
  scheduledStartTime: new Date(Date.now() - 2 * HOUR).toISOString(),
  scheduledEndTime: new Date(Date.now() - HOUR).toISOString(),
  participants: [
    { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 717 },
    { wiseUserId: STUDENT_ID, name: STUDENT_NAME, isTeacher: false, inMeetingDuration: 0, absolutePercentAttendance: 0 },
  ],
  ...overrides,
});

function fakeWise(initial: Record<string, unknown>, options: {
  postResult?: PostResult;
  creditsAfter?: Array<{ credit: number }>;
  events?: (postedAt: Date) => SubmitFeedbackEvent[];
} = {}) {
  let current = initial;
  let postedAt: Date | null = null;
  const posts: WiseFeedbackPostBody[] = [];
  const read = async () => ({ data: structuredClone(current) });
  const ops: WiseFeedbackOps = {
    getSessionDetail: vi.fn(read),
    getSessionDetailById: vi.fn(read),
    postFeedback: vi.fn(async (_classId: string, _sessionId: string, body: WiseFeedbackPostBody) => {
      posts.push(body);
      postedAt = new Date();
      if ((options.postResult?.kind ?? "sent") === "sent") {
        current = { ...current, feedbackSubmissions: [autoBlankSubmission({
          answers: answers(body.answers.map((answer) => answer.answer) as [string, string, string, string]), metadata: null,
          sessionStatus: body.sessionStatus, creditsConsumed: body.creditsConsumed,
        })] };
      }
      return options.postResult ?? { kind: "sent", status: 200 } as const;
    }),
    getSessionCreditEntries: vi.fn(async () => postedAt && options.creditsAfter ? options.creditsAfter : [{ credit: 1 }]),
    findFeedbackEvents: vi.fn(async () => postedAt
      ? (options.events?.(postedAt) ?? [{ at: new Date(postedAt.getTime() + 500), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" }])
      : []),
  };
  return { ops, posts };
}

async function heldNoShow() {
  const detail = parseAutowriterSessionDetail({ data: noShowDetail() });
  const noShow = detectNoShow(detail, "attendance_0pct");
  expect(noShow).not.toBeNull();
  await db.insert(S).values({ wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
    state: "held", reason: "attendance_0pct", deadlineAt: new Date(Date.now() + 30 * HOUR), metadata: { alertKind: "held", noShow } });
}
const post = (ops: WiseFeedbackOps) => postNoShowNote(db, {
  wiseSessionId: SESSION_ID, actor: "owner@example.com", apiActorId: API_ACTOR, ops,
  loadMappings: async () => DEFAULT_FEEDBACK_FIELD_MAPPINGS, remainingMs: () => 280_000, sleep: async () => {}, eventWaitMs: 0,
});
const row = async () => (await db.select().from(S).where(eq(S.wiseSessionId, SESSION_ID)))[0];

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { await stopTestDb(handle); });
beforeEach(async () => {
  await db.execute(sql`TRUNCATE feedback_autowriter_sessions, feedback_autowriter_posts CASCADE`);
  await db.execute(sql`UPDATE feedback_autowriter_control SET mode = 'live', halted_at = NULL, halt_reason = NULL,
    disabled_tutors = '[]'::jsonb, lease_token = NULL, lease_until = NULL`);
});

describe("owner one-click no-show note, through the guarded POST", () => {
  it("posts the note with Wise's own billing and verifies it like any autowriter post", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail());
    expect(await post(wise.ops)).toEqual({ ok: true, outcome: "verified" });
    expect(wise.posts).toHaveLength(1);
    expect(wise.posts[0]).toMatchObject({ sessionStatus: "COMPLETED", creditsConsumed: 1 });
    expect(wise.posts[0].answers.map((answer) => answer.answer).join(" ")).toContain("Tom did not join");
    const saved = await row();
    expect(saved).toMatchObject({ state: "verified", arm: null });
    expect(saved.metadata).toMatchObject({ expected: { kind: "auto_blank" }, studentWiseUserId: STUDENT_ID, noShowPost: { actor: "owner@example.com" } });
    expect(saved.metadata).not.toHaveProperty("alertKind");
  });

  it("never overwrites anyone's text: a tutor who wrote first wins", async () => {
    await heldNoShow();
    const written = noShowDetail({ feedbackSubmissions: [autoBlankSubmission({ answers: answers(["Ratios", "Worked well", "Practise", ""]), metadata: null })] });
    const wise = fakeWise(written);
    expect(await post(wise.ops)).toMatchObject({ ok: false, status: 409 });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    expect((await row()).state).toBe("held");
  });

  it("halts when someone else saved during the POST window, before the single-POST lock opens", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail(), { events: (at) => [
      { at: new Date(at.getTime() - 1_000), autoSubmitted: null, actorId: KEVIN_ONLINE_WISE_USER_ID, actorRole: "TEACHER" },
      { at: new Date(at.getTime() + 500), autoSubmitted: null, actorId: API_ACTOR, actorRole: "OWNER" },
    ] });
    expect(await post(wise.ops)).toEqual({ ok: false, status: 502, reason: "verify_failed" });
    expect((await row()).state).toBe("verify_failed");
    expect((await readControl(db)).haltedAt).not.toBeNull();
  });

  it("leaves the class held, with its alert, when Wise rate limits and nothing was sent", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail(), { postResult: { kind: "rate_limited", status: 429 } });
    expect(await post(wise.ops)).toEqual({ ok: false, status: 502, reason: "wise_rate_limited_not_sent" });
    const saved = await row();
    expect(saved).toMatchObject({ state: "held", reason: "attendance_0pct" });
    expect(saved.metadata).toMatchObject({ alertKind: "held", noShow: { version: 1 } });
    expect((await readControl(db)).haltedAt).toBeNull();
  });

  it("does not claim a class re-held for another reason meanwhile", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail());
    const read = wise.ops.getSessionDetail;
    let reads = 0;
    wise.ops.getSessionDetail = vi.fn(async (classId: string, sessionId: string) => {
      // The route's own read, then the guarded path's credit-baseline read: re-held in between.
      if (++reads === 2) await db.update(S).set({ reason: "billing:auto_credits_missing" });
      return read(classId, sessionId);
    });
    expect(await post(wise.ops)).toMatchObject({ ok: false, status: 409 });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
  });

  it("halts on an unknown outcome", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail(), { postResult: { kind: "unknown", error: "socket hang up" } });
    expect(await post(wise.ops)).toEqual({ ok: false, status: 502, reason: "unknown_outcome" });
    expect((await readControl(db)).haltedAt).not.toBeNull();
  });

  it("refuses while halted, with the tutor switched off, or with another POST in flight", async () => {
    await heldNoShow();
    await updateControl(db, { haltedAt: new Date(), haltReason: "test" }, "t@x.com");
    expect(await post(fakeWise(noShowDetail()).ops)).toMatchObject({ ok: false, status: 409, reason: "autowriter_not_live_halted_or_tutor_off" });
    await updateControl(db, { haltedAt: null, haltReason: null, disabledTutors: [KEVIN_ONLINE_WISE_USER_ID] }, "t@x.com");
    expect(await post(fakeWise(noShowDetail()).ops)).toMatchObject({ ok: false, status: 409 });
    await updateControl(db, { disabledTutors: [] }, "t@x.com");
    await db.insert(S).values({ wiseSessionId: "6a00000000000000000000ff", state: "posting", postStartedAt: new Date() });
    const wise = fakeWise(noShowDetail());
    expect(await post(wise.ops)).toMatchObject({ ok: false, status: 409, reason: "post_in_flight" });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    expect((await row()).state).toBe("held");
  });

  it("refuses when the fresh read no longer shows the same no-show, or the class is not a held no-show", async () => {
    await heldNoShow();
    expect(await post(fakeWise(noShowDetail({ participants: [
      { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 1500 },
      { wiseUserId: STUDENT_ID, name: STUDENT_NAME, isTeacher: false, inMeetingDuration: 0, absolutePercentAttendance: 0 },
    ] })).ops)).toEqual({ ok: false, status: 409, reason: "no_longer_a_no_show" });
    await db.update(S).set({ metadata: { alertKind: "held", noShow: null } });
    expect(await post(fakeWise(noShowDetail()).ops)).toEqual({ ok: false, status: 409, reason: "not_a_held_no_show" });
  });
});

describe("owner-requested held feedback recovery", () => {
  async function recovery(creditsBefore = 1) {
    const detail = sessionDetail({ scheduledStartTime: new Date(Date.now() - 100 * HOUR).toISOString(),
      scheduledEndTime: new Date(Date.now() - 99 * HOUR).toISOString() });
    await db.insert(S).values({ wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
      state: "held", reason: "thai_summary_no_transcript", deadlineAt: new Date(Date.now() - HOUR) });
    const wise = fakeWise(detail);
    wise.ops.getSessionCreditEntries = vi.fn(async () => [{ credit: creditsBefore }]);
    const held = { reason: "thai_summary_no_transcript", fieldsSha256: fieldsHash(GOOD_FIELDS),
      authorizationRef: "synthetic direct owner request", expiresAt: new Date(Date.now() + HOUR) };
    const store = heldRecoverySubmitStore(db, SESSION_ID, { expected: { kind: "auto_blank" }, draftEvidence: "transcript" }, held);
    const outcome = await submitFeedbackGuarded({ ops: wise.ops, store,
      plan: { sessionId: SESSION_ID, classId: CLASS_ID, arm: "sol", fields: GOOD_FIELDS,
        billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse", expectedConsumedDelta: 0 },
        expected: { kind: "auto_blank", submissionId: "6a0000000000000000000004", sessionStatus: "COMPLETED", creditsConsumed: 1 },
        mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS },
      gateInput: { now: new Date(), allowlist: AUTOWRITER_TEACHER_ALLOWLIST, requireSummary: false, deadlineRecoverySessionId: SESSION_ID },
      apiActorId: API_ACTOR, remainingMs: () => 280_000, sleep: async () => {}, eventWaitMs: 0 });
    return { wise, outcome, store, held };
  }
  it("writes and verifies a pinned draft after the automatic deadline, with unchanged billing", async () => {
    const { wise, outcome } = await recovery();
    expect(outcome.status).toBe("verified");
    expect(wise.posts).toHaveLength(1);
    expect(wise.posts[0]).toMatchObject({ sessionStatus: "COMPLETED", creditsConsumed: 1 });
    expect((await row()).metadata).toMatchObject({ ownerRecovery: { authorizationRef: "synthetic direct owner request" } });
    expect((await row()).evidence).toBe("transcript");
  });
  it("refuses a missing charge before the claim or any Wise POST", async () => {
    const { wise, outcome } = await recovery(0);
    expect(outcome).toEqual({ status: "aborted_precheck", reason: "credit_baseline:session_credit_0" });
    expect(wise.posts).toEqual([]);
    expect((await row()).state).toBe("held");
  });
  it("refuses a different field hash or an expired authorization at the held claim", async () => {
    const { store, held } = await recovery(0);
    const claim = { bodyHash: "test", fieldsSha256: fieldsHash(GOOD_FIELDS), fields: GOOD_FIELDS,
      billing: { sessionStatus: "COMPLETED", creditsConsumed: 1, source: "auto_blank_reuse" as const, expectedConsumedDelta: 0 },
      arm: "sol" as const, teacherId: KEVIN_ONLINE_WISE_USER_ID, freshReadAt: new Date() };
    expect(await store.claimPost({ ...claim, fieldsSha256: "changed" })).toEqual({ claimed: false, reason: "conditions" });
    const expired = heldRecoverySubmitStore(db, SESSION_ID, {}, { ...held, expiresAt: new Date(Date.now() - 1) });
    expect(await expired.claimPost(claim)).toEqual({ claimed: false, reason: "conditions" });
    expect((await row()).state).toBe("held");
  });
});

describe("48-hour fallback note on a held class nobody wrote", () => {
  /** A held class that ended `hoursAgo` hours ago (its row carries its real end and deadline), and its Wise detail. */
  async function heldClass(reason: string, hoursAgo: number, participants?: unknown[]) {
    const end = new Date(Date.now() - hoursAgo * HOUR);
    await db.insert(S).values({ wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
      state: "held", reason, scheduledEndAt: end, deadlineAt: calculateFeedbackDeadline(end),
      metadata: { alertKind: "held" }, alertsSent: { held: end.toISOString() } });
    return sessionDetail({ title: "Live Session - Chemistry", scheduledStartTime: new Date(end.getTime() - HOUR).toISOString(),
      scheduledEndTime: end.toISOString(), ...(participants ? { participants } : {}) });
  }
  const fallback = (ops: WiseFeedbackOps, listed: AutowriterSessionRow) => postDeadlineFallback(db, {
    row: listed, ops, apiActorId: API_ACTOR, mappings: DEFAULT_FEEDBACK_FIELD_MAPPINGS, now: new Date(),
    remainingMs: () => 280_000, sleep: async () => {}, eventWaitMs: 0,
  });
  const listedRow = async () => {
    const [listed] = await listFallbackRows(db);
    expect(listed?.wiseSessionId).toBe(SESSION_ID);
    return listed;
  };

  it("lists a held class only from 42 h after its end, and only while the deadline margin is ahead", async () => {
    await heldClass("thai_summary_no_transcript", 41);
    expect(await listFallbackRows(db)).toEqual([]);
    const end = new Date(Date.now() - 43 * HOUR);
    await db.update(S).set({ scheduledEndAt: end, deadlineAt: calculateFeedbackDeadline(end) });
    await listedRow();
    await db.update(S).set({ deadlineAt: new Date(Date.now() + 10 * 60_000) });
    expect(await listFallbackRows(db)).toEqual([]);
  });

  it("posts the fact-only note with Wise's own billing, and verifies it like any autowriter post", async () => {
    const wise = fakeWise(await heldClass("luna:unfaithful:wrong person", 43));
    expect(await fallback(wise.ops, await listedRow())).toEqual({ result: "posted", reason: "fact_only" });
    expect(wise.posts).toHaveLength(1);
    expect(wise.posts[0]).toMatchObject({ sessionStatus: "COMPLETED", creditsConsumed: 1 });
    expect(wise.posts[0].answers[0].answer).toMatch(/^1\. Chemistry: the 60-minute online class scheduled for /u);
    const saved = await row();
    expect(saved).toMatchObject({ state: "verified", arm: null });
    expect(saved.metadata).toMatchObject({ expected: { kind: "auto_blank" }, studentWiseUserId: STUDENT_ID, deadlineFallback: { kind: "fact_only" } });
    expect(await listFallbackRows(db)).toEqual([]);
  });

  it("posts the standard no-show note when the student never joined", async () => {
    const wise = fakeWise(await heldClass("attendance_0pct", 43, noShowDetail().participants));
    expect(await fallback(wise.ops, await listedRow())).toEqual({ result: "posted", reason: "no_show" });
    expect(wise.posts[0].answers.map((answer) => answer.answer).join(" ")).toContain("Tom did not join");
    expect((await row()).state).toBe("verified");
  });

  it("never changes billing: a hold it cannot post stops with one alert, and is not tried again", async () => {
    const detail = await heldClass("thai_summary_no_transcript", 43);
    const wise = fakeWise({ ...detail, feedbackSubmissions: [autoBlankSubmission({ creditsConsumed: null })] });
    expect(await fallback(wise.ops, await listedRow())).toEqual({ result: "stopped", reason: "billing:auto_credits_missing" });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    const saved = await row();
    expect(saved).toMatchObject({ state: "held", reason: "thai_summary_no_transcript" });
    expect(saved.metadata).toMatchObject({ alertKind: "fallback_failed", deadlineFallbackStopped: { reason: "billing:auto_credits_missing" } });
    expect(await listFallbackRows(db)).toEqual([]);
  });

  it("leaves a class the tutor wrote alone, with no alert", async () => {
    const detail = await heldClass("thai_summary_no_transcript", 43);
    const wise = fakeWise({ ...detail, feedbackSubmissions: [autoBlankSubmission({ answers: answers(["Ratios", "Worked well", "Practise", ""]), metadata: null })] });
    expect(await fallback(wise.ops, await listedRow())).toEqual({ result: "stopped", reason: "human_submission" });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    expect((await row()).metadata).toMatchObject({ alertKind: "held", deadlineFallbackStopped: { reason: "human_submission" } });
  });

  it("waits for the next sweep while the autowriter is halted", async () => {
    const wise = fakeWise(await heldClass("thai_summary_no_transcript", 43));
    await updateControl(db, { haltedAt: new Date(), haltReason: "test" }, "t@x.com");
    expect(await fallback(wise.ops, await listedRow())).toEqual({ result: "retry", reason: "conditions" });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    expect((await row()).state).toBe("held");
    await listedRow();
  });

  it("refuses at the claim outside the window, and tries a class that has not failed yet first", async () => {
    const wise = fakeWise(await heldClass("thai_summary_no_transcript", 41));
    const [early] = await db.select().from(S).where(eq(S.wiseSessionId, SESSION_ID));
    expect(await fallback(wise.ops, early)).toEqual({ result: "retry", reason: "conditions" });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    const end = new Date(Date.now() - 43 * HOUR);
    await db.update(S).set({ scheduledEndAt: end, deadlineAt: calculateFeedbackDeadline(end) });
    await db.insert(S).values({ wiseSessionId: "6a00000000000000000000aa", wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
      state: "held", reason: "summary_only_held", scheduledEndAt: end, deadlineAt: calculateFeedbackDeadline(end) });
    expect((await listFallbackRows(db)).map((listed) => listed.wiseSessionId)).toEqual(["6a00000000000000000000aa", SESSION_ID]);
  });

  it("keeps trying in its last hour, and alerts so a person can still write it", async () => {
    const detail = await heldClass("thai_summary_no_transcript", 47);
    await db.update(S).set({ deadlineAt: new Date(Date.now() + HOUR) });
    const wise = fakeWise({ ...detail, feedbackSubmissions: [] });
    expect(await fallback(wise.ops, await listedRow())).toEqual({ result: "retry", reason: "submission_none" });
    expect((await row()).metadata).toMatchObject({ alertKind: "fallback_failed", deadlineFallbackRetry: { reason: "submission_none" } });
    await listedRow();
  });

  it("is tried again after an owner Retry re-holds the class", async () => {
    const detail = await heldClass("thai_summary_no_transcript", 43);
    const wise = fakeWise({ ...detail, feedbackSubmissions: [autoBlankSubmission({ creditsConsumed: null })] });
    expect(await fallback(wise.ops, await listedRow())).toMatchObject({ result: "stopped" });
    await db.update(S).set({ alertsSent: { held: "x", fallback_failed: "y" } });
    expect(await retryHeldSession(db, SESSION_ID, { minDeadline: new Date(), actor: "owner@example.com" })).toBe(true);
    await db.update(S).set({ state: "held", reason: "summary_only_held" });
    await listedRow();
    expect((await row()).alertsSent).toEqual({});
  });

  it("is posted by the sweep", async () => {
    const wise = fakeWise(await heldClass("summary_only_held", 43));
    const result = await runSweep({ db, ops: wise.ops, apiKey: "test-key", apiActorId: API_ACTOR, writesAllowedHere: true,
      deadlineMs: Date.now() + 740_000, sleep: async () => {}, alertRecipients: [] });
    expect(result.fallback).toEqual({ posted: 1 });
    expect(wise.posts).toHaveLength(1);
    expect((await row()).state).toBe("verified");
  });
});
