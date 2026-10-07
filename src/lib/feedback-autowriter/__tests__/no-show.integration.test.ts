import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "@/lib/post-class-feedback/wise";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { detectNoShow } from "../no-show";
import { postNoShowNote } from "../no-show-post";
import { KEVIN_ONLINE_WISE_USER_ID } from "../roster";
import { parseAutowriterSessionDetail } from "../session";
import { readControl, updateControl } from "../store";
import type { PostResult, SubmitFeedbackEvent, WiseFeedbackOps } from "../submit";
import type { WiseFeedbackPostBody } from "../types";
import { answers, autoBlankSubmission, CLASS_ID, SESSION_ID, sessionDetail, STUDENT_ID, STUDENT_NAME } from "./fixtures";

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
