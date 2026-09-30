import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { calculateFeedbackDeadline } from "@/lib/post-class-feedback/policy";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import { loadAutowriterDashboard } from "../dashboard";
import { listPendingAlerts, markAlertsSent } from "../store";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;

const S = schema.feedbackAutowriterSessions;
const FX = schema.feedbackAutowriterFixEvents;
const PC = schema.postClassSessions;
const PCV = schema.postClassFeedbackVersions;

// Roster account ids are the code roster's (the tutor names and keys come from it); everything else is synthetic.
const MIMI = "696e2c4343579bbada2340f8";
const EK_MAIN = "695369c028118f629edcba05";
const NOW = new Date("2026-09-30T05:00:00Z");
const id24 = (n: number) => `6a${String(n).padStart(22, "0")}`;
const FIELDS = { topics: "Rotation patterns", performance: "Tom spotted symmetry fast.", improvement: "Colour sequences", homework: "" };

type SessionInsert = typeof S.$inferInsert;

async function seedRow(n: number, options: Partial<SessionInsert> & { endAt: string; className?: string }): Promise<string> {
  const { endAt, className, ...row } = options;
  const scheduledEndAt = new Date(endAt);
  const deadlineAt = calculateFeedbackDeadline(scheduledEndAt);
  await db.insert(S).values({
    wiseSessionId: id24(n), wiseClassId: id24(n + 500), wiseTeacherUserId: MIMI, scheduledEndAt, deadlineAt,
    state: "held", reason: "sol:unfaithful:a claim", createdAt: scheduledEndAt, ...row,
  });
  if (className) {
    await db.insert(schema.postClassSessions).values({
      wiseSessionId: id24(n), wiseClassId: id24(n + 500), wiseTeacherUserId: row.wiseTeacherUserId ?? MIMI, className,
      scheduledStartAt: new Date(scheduledEndAt.getTime() - 60 * 60_000), scheduledEndAt, deadlineAt, finalStatus: "ENDED",
    });
  }
  return id24(n);
}

/** A feedback save in Wise as the review job stores it (`feedback_autowriter_fix_events`). */
async function seedSave(wiseSessionId: string, actorKind: typeof FX.$inferInsert["actorKind"], at: string): Promise<void> {
  await db.insert(FX).values({
    wiseEventId: `event-${wiseSessionId}-${actorKind}-${at}`, wiseSessionId, eventAt: new Date(at), actorKind, countsAsFix: false,
    classifierVersion: 1,
  });
}

/**
 * A version of the class's feedback as the Class Feedback collection observed it in Wise
 * (`post_class_feedback_versions`); the class needs its `post_class_sessions` row (`className` in `seedRow`).
 */
async function seedFeedback(wiseSessionId: string, observedAt: string, fields: Partial<typeof FIELDS> = {}, profile = "teacher"): Promise<void> {
  const [session] = await db.select({ id: PC.id }).from(PC).where(eq(PC.wiseSessionId, wiseSessionId));
  if (!session) throw new Error(`no post_class_sessions row for ${wiseSessionId}`);
  const text = { topics: "", performance: "", improvement: "", homework: "", ...fields };
  await db.insert(PCV).values({
    sessionId: session.id, versionKey: `${profile}-${observedAt}`, contentHash: `hash-${profile}-${observedAt}`, profile,
    observedAt: new Date(observedAt), ...text,
  });
}

beforeAll(async () => {
  handle = await startTestDb();
  db = handle.db as unknown as Database;
}, 120_000);

afterAll(async () => {
  if (handle) await stopTestDb(handle);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE feedback_autowriter_sessions, feedback_autowriter_calls, feedback_autowriter_fix_events,
    post_class_sessions, wise_webhook_events RESTART IDENTITY CASCADE`);
});

describe("loadAutowriterDashboard", () => {
  it("lists every held class whatever its age, with its alert time as the sweep wrote it, the failed posts and today's classes", async () => {
    // Held today, with a judged draft kept on the row; its alert digest was emailed.
    const emailed = await seedRow(1, {
      endAt: "2026-09-30T03:00:00Z", reason: "student_id_missing", fields: FIELDS, metadata: { alertKind: "held" }, className: "Somchai (Tom.Ja) Jaidee",
    });
    await markAlertsSent(db, await listPendingAlerts(db));
    // Held two months ago, in shadow mode (the digest was recorded, not emailed): far outside the 7-day window.
    const old = await seedRow(2, { endAt: "2026-07-30T03:00:00Z", wiseTeacherUserId: EK_MAIN, reason: "recording_too_short", metadata: { alertKind: "held" } });
    await markAlertsSent(db, await listPendingAlerts(db), "suppressed:shadow");
    // Held yesterday; no alert yet.
    const waiting = await seedRow(3, { endAt: "2026-09-29T03:00:00Z" });
    // Not holds: a failed post and a posted class of today, an in-person class, and a class no longer held.
    const failed = await seedRow(4, { endAt: "2026-09-30T02:00:00Z", state: "verify_failed", reason: "verify_failed", postStartedAt: new Date("2026-09-30T02:40:00Z") });
    await seedRow(5, { endAt: "2026-09-30T01:00:00Z", state: "verified", reason: "verified", arm: "sol", postStartedAt: new Date("2026-09-30T01:30:00Z") });
    await seedRow(6, { endAt: "2026-09-30T04:00:00Z", state: "skipped_scope", reason: "session_type_OFFLINE" });
    await seedRow(7, { endAt: "2026-07-29T03:00:00Z", state: "skipped_human", reason: "human_submission" });

    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });

    expect(board.holds.map((row) => row.wiseSessionId)).toEqual([old, waiting, emailed]);
    expect(board.holds[0]).toMatchObject({
      tutor: "Apivit (Ek) Sirithana", tutorKey: "Ek", className: null, classEndedAt: "2026-07-30T03:00:00.000Z",
      reason: "recording_too_short", alertSentAt: null, hasDraft: false,
    });
    expect(board.holds[1]).toMatchObject({ tutorKey: "Mimi", reason: "sol:unfaithful:a claim", alertSentAt: null, hasDraft: false, resolvedBy: null });
    const [stored] = await db.select({ alertsSent: S.alertsSent }).from(S).where(eq(S.wiseSessionId, emailed));
    expect(board.holds[2]).toMatchObject({
      tutor: "Thanit (Mimi) Montrikittiphant", tutorKey: "Mimi", className: "Somchai (Tom.Ja) Jaidee", reason: "student_id_missing", hasDraft: true,
      deadlineAt: calculateFeedbackDeadline(new Date("2026-09-30T03:00:00Z")).toISOString(),
    });
    // What Postgres wrote (`now()::text`) reads back as the instant it was written.
    const sentAt = board.holds[2].alertSentAt;
    expect(sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(Math.abs(new Date(sentAt!).getTime() - Date.now())).toBeLessThan(5 * 60_000);
    expect(stored.alertsSent.held).not.toBe(sentAt);
    // The draft's text never rides along with a hold.
    expect(JSON.stringify(board.holds)).not.toContain("Rotation patterns");

    expect(board.failedPosts).toMatchObject([{ wiseSessionId: failed, tutorKey: "Mimi", state: "verify_failed", classEndedAt: "2026-09-30T02:00:00.000Z" }]);
    expect(board.today).toEqual({ date: "2026-09-30", posted: 1, awaitingRecording: 0, held: 1, skippedHuman: 0, skippedScope: 0 });
    // The window's own totals still count only the window's rows.
    expect(board.totals).toMatchObject({ seen: 4, held: 2, failed: 1, posted: 1 });
    expect(board.recent.every((row) => row.tutorKey === "Mimi")).toBe(true);
    expect(board.system).toMatchObject({ promptVersion: expect.any(Number), writer: { model: expect.any(String) } });
  });

  it("marks a held class as written once it has a person's feedback text in Wise, and no other", async () => {
    const written = await seedRow(1, { endAt: "2026-09-29T03:00:00Z", className: "Class one" });
    const blankSave = await seedRow(2, { endAt: "2026-09-29T04:00:00Z", reason: "attendance_0pct", className: "Class two" });
    const billingFix = await seedRow(3, { endAt: "2026-09-29T05:00:00Z", reason: "billing_differs_from_current_submission", className: "Class three" });
    const erased = await seedRow(4, { endAt: "2026-09-29T06:00:00Z", className: "Class four" });
    const whitespace = await seedRow(5, { endAt: "2026-09-29T07:00:00Z", className: "Class five" });
    const studentForm = await seedRow(6, { endAt: "2026-09-29T08:00:00Z", className: "Class six" });
    const notCollected = await seedRow(7, { endAt: "2026-09-29T09:00:00Z" });
    const oneField = await seedRow(8, { endAt: "2026-09-29T10:00:00Z", wiseTeacherUserId: EK_MAIN, className: "Class eight" });
    // A class the tutor wrote before we could: never a hold, whatever is in Wise.
    const tutorFirst = await seedRow(9, { endAt: "2026-09-29T11:00:00Z", state: "skipped_human", reason: "human_submission", className: "Class nine" });

    // Wise's blank auto-submission, then the tutor's text: the latest version counts.
    await seedFeedback(written, "2026-09-29T03:00:30Z");
    await seedFeedback(written, "2026-09-29T09:00:00Z", FIELDS);
    // The tutor submitted the form blank (the student was absent): a save, and nothing written.
    await seedFeedback(blankSave, "2026-09-29T04:00:30Z");
    await seedFeedback(blankSave, "2026-09-29T10:00:00Z");
    await seedSave(blankSave, "tutor", "2026-09-29T10:00:00Z");
    // Staff corrected the credits of a class held for its billing: a person's save, and the form is still blank.
    await seedFeedback(billingFix, "2026-09-29T05:00:30Z");
    await seedSave(billingFix, "other_staff", "2026-09-29T11:00:00Z");
    await seedSave(billingFix, "owner_web", "2026-09-29T11:30:00Z");
    // Text that was taken out again: the class is as unwritten as before.
    await seedFeedback(erased, "2026-09-29T12:00:00Z", FIELDS);
    await seedFeedback(erased, "2026-09-29T13:00:00Z");
    await seedFeedback(whitespace, "2026-09-29T12:00:00Z", { topics: "  \n", performance: "\t", improvement: " ", homework: "" });
    // A student's own form is not the teacher's feedback.
    await seedFeedback(studentForm, "2026-09-29T12:00:00Z", FIELDS, "student");
    await seedSave(notCollected, "tutor", "2026-09-29T12:00:00Z");
    // One field is a write-up too.
    await seedFeedback(oneField, "2026-09-29T12:00:00Z", { homework: "Page 12" });
    await seedFeedback(tutorFirst, "2026-09-29T11:05:00Z", FIELDS);

    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });

    expect(Object.fromEntries(board.holds.map((row) => [row.wiseSessionId, row.resolvedBy]))).toEqual({
      [written]: "tutor_wrote", [oneField]: "tutor_wrote",
      [blankSave]: null, [billingFix]: null, [erased]: null, [whitespace]: null, [studentForm]: null, [notCollected]: null,
    });
    // The class stays a hold: the row is still `held`, and the window still counts it.
    expect(board.totals.held).toBe(8);
    expect(board.recent.find((row) => row.wiseSessionId === written)?.state).toBe("held");
    expect(board.holds.some((row) => row.wiseSessionId === tutorFirst)).toBe(false);
  });

  it("takes the latest version by when it was observed, whatever the order the rows were written in", async () => {
    const held = await seedRow(1, { endAt: "2026-09-29T03:00:00Z", className: "Class one" });
    // Written last, observed first: the blank version is the older one.
    await seedFeedback(held, "2026-09-29T09:00:00Z", FIELDS);
    await seedFeedback(held, "2026-09-29T03:00:30Z");
    expect((await loadAutowriterDashboard(db, { windowDays: 7, now: NOW })).holds).toMatchObject([{ wiseSessionId: held, resolvedBy: "tutor_wrote" }]);
  });

  it("has no holds and no failed posts when there are none", async () => {
    await seedRow(1, { endAt: "2026-09-30T01:00:00Z", state: "verified", reason: "verified", arm: "sol", postStartedAt: new Date("2026-09-30T01:30:00Z") });
    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });
    expect(board.holds).toEqual([]);
    expect(board.failedPosts).toEqual([]);
    expect(board.today).toMatchObject({ posted: 1, held: 0 });
  });
});
