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
import type { WiseFeedbackOps } from "../submit";
import type { WiseFeedbackPostBody } from "../types";
import { answers, autoBlankSubmission, CLASS_ID, SESSION_ID, sessionDetail, STUDENT_ID, STUDENT_NAME } from "./fixtures";

vi.mock("server-only", () => ({}));
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const S = schema.feedbackAutowriterSessions;
const noShowDetail = (overrides: Record<string, unknown> = {}) => sessionDetail({
  participants: [
    { wiseUserId: KEVIN_ONLINE_WISE_USER_ID, name: "Kevin (Kev) Y. Hsieh Online", isTeacher: true, inMeetingDuration: 717 },
    { wiseUserId: STUDENT_ID, name: STUDENT_NAME, isTeacher: false, inMeetingDuration: 0, absolutePercentAttendance: 0 },
  ],
  ...overrides,
});

function fakeWise(initial: Record<string, unknown>, options: { creditsAfter?: Array<{ credit: number }> } = {}) {
  let current = initial;
  let posted = false;
  const posts: WiseFeedbackPostBody[] = [];
  const read = async () => ({ data: structuredClone(current) });
  const ops: WiseFeedbackOps = {
    getSessionDetail: vi.fn(read),
    getSessionDetailById: vi.fn(read),
    postFeedback: vi.fn(async (_classId: string, _sessionId: string, body: WiseFeedbackPostBody) => {
      posts.push(body);
      posted = true;
      current = { ...current, feedbackSubmissions: [autoBlankSubmission({
        answers: answers(body.answers.map((answer) => answer.answer) as [string, string, string, string]), metadata: null,
        sessionStatus: body.sessionStatus, creditsConsumed: body.creditsConsumed,
      })] };
      return { kind: "sent", status: 200 } as const;
    }),
    getSessionCreditEntries: vi.fn(async () => posted && options.creditsAfter ? options.creditsAfter : [{ credit: 1 }]),
    findFeedbackEvents: vi.fn(async () => []),
  };
  return { ops, posts };
}

async function heldNoShow() {
  const detail = parseAutowriterSessionDetail({ data: noShowDetail() });
  const noShow = detectNoShow(detail, "attendance_0pct");
  await db.insert(S).values({ wiseSessionId: SESSION_ID, wiseClassId: CLASS_ID, wiseTeacherUserId: KEVIN_ONLINE_WISE_USER_ID,
    state: "held", reason: "attendance_0pct", metadata: { alertKind: "held", noShow } });
}
const post = (ops: WiseFeedbackOps) => postNoShowNote(db, { wiseSessionId: SESSION_ID, actor: "owner@example.com", ops,
  loadMappings: async () => DEFAULT_FEEDBACK_FIELD_MAPPINGS });

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { await stopTestDb(handle); });
beforeEach(async () => { await db.execute(sql`TRUNCATE feedback_autowriter_sessions, feedback_autowriter_posts CASCADE`); });

describe("owner one-click no-show note", () => {
  it("posts the note with Wise's own billing, verifies it, and records it as an owner policy save", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail());
    expect(await post(wise.ops)).toEqual({ ok: true, state: "skipped_human" });
    expect(wise.posts).toHaveLength(1);
    expect(wise.posts[0]).toMatchObject({ sessionStatus: "COMPLETED", creditsConsumed: 1 });
    expect(wise.posts[0].answers.map((answer) => answer.answer).join(" ")).toContain("Tom did not join");
    const [row] = await db.select().from(S).where(eq(S.wiseSessionId, SESSION_ID));
    expect(row).toMatchObject({ state: "skipped_human", reason: "no_show_note_posted" });
    const [saved] = await db.select().from(schema.feedbackAutowriterPosts);
    expect(saved).toMatchObject({ kind: "policy", actorKind: "owner", actor: "owner@example.com", outcome: "verified", dedupeKey: `no-show:${SESSION_ID}` });
  });
  it("never overwrites anyone's text: a tutor who wrote meanwhile wins", async () => {
    await heldNoShow();
    const written = noShowDetail({ feedbackSubmissions: [autoBlankSubmission({ answers: answers(["Ratios", "Worked well", "Practise", ""]), metadata: null })] });
    const wise = fakeWise(written);
    expect(await post(wise.ops)).toMatchObject({ ok: false, status: 409 });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
    expect((await db.select().from(S))[0].state).toBe("held");
  });
  it("refuses when the fresh read no longer shows a no-show, or the class is not a held no-show", async () => {
    await heldNoShow();
    const joined = fakeWise(sessionDetail());
    expect(await post(joined.ops)).toEqual({ ok: false, status: 409, reason: "no_longer_a_no_show" });
    await db.update(S).set({ metadata: { alertKind: "held" } });
    expect(await post(fakeWise(noShowDetail()).ops)).toEqual({ ok: false, status: 409, reason: "not_a_held_no_show" });
  });
  it("waits for another POST in flight", async () => {
    await heldNoShow();
    await db.insert(S).values({ wiseSessionId: "6a00000000000000000000ff", state: "posting", postStartedAt: new Date() });
    const wise = fakeWise(noShowDetail());
    expect(await post(wise.ops)).toMatchObject({ ok: false, status: 409 });
    expect(wise.ops.postFeedback).not.toHaveBeenCalled();
  });
  it("ends verify_failed (alerted) when the credits moved after the POST", async () => {
    await heldNoShow();
    const wise = fakeWise(noShowDetail(), { creditsAfter: [{ credit: 2 }] });
    expect(await post(wise.ops)).toEqual({ ok: false, status: 502, reason: "verify_failed" });
    const [row] = await db.select().from(S).where(eq(S.wiseSessionId, SESSION_ID));
    expect(row.state).toBe("verify_failed");
    expect(row.metadata).toMatchObject({ alertKind: "verify_failed" });
  });
});
