import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
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
 * One read of the class's teacher submission by the Class Feedback collection, stored the way its `saveObservation`
 * stores it: one version row per submission and content (the time it was first seen stays its `observed_at`), and the
 * session's pointer at the current teacher version when its topics, performance or improvement hold text, at nothing
 * otherwise. `fields: null` is a read that finds no teacher submission. The class needs its `post_class_sessions` row
 * (`className` in `seedRow`).
 */
async function collect(wiseSessionId: string, observedAt: string, fields: Partial<typeof FIELDS> | null): Promise<void> {
  const [session] = await db.select({ id: PC.id }).from(PC).where(eq(PC.wiseSessionId, wiseSessionId));
  if (!session) throw new Error(`no post_class_sessions row for ${wiseSessionId}`);
  if (fields === null) {
    await db.update(PC).set({ latestFeedbackVersionId: null }).where(eq(PC.id, session.id));
    return;
  }
  const text = { topics: "", performance: "", improvement: "", homework: "", ...fields };
  const contentHash = JSON.stringify(text);
  const versionKey = `submission-1:${contentHash}`;
  await db.insert(PCV).values({
    sessionId: session.id, versionKey, wiseSubmissionId: "submission-1", contentHash, profile: "teacher", observedAt: new Date(observedAt), ...text,
  }).onConflictDoNothing({ target: [PCV.sessionId, PCV.versionKey] });
  const [version] = await db.select({ id: PCV.id }).from(PCV).where(and(eq(PCV.sessionId, session.id), eq(PCV.versionKey, versionKey)));
  const hasText = [text.topics, text.performance, text.improvement].some((value) => value.trim() !== "");
  await db.update(PC).set({ latestFeedbackVersionId: hasText ? version.id : null }).where(eq(PC.id, session.id));
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
  it("names a class from the autowriter's own Wise read until Class Feedback mirrors it; the mirror's name wins", async () => {
    const unmirrored = await seedRow(1, { endAt: "2026-09-30T03:00:00Z", metadata: { className: "Athen (Athen.Si) Simthumnimit" } });
    const mirrored = await seedRow(2, { endAt: "2026-09-30T04:00:00Z", metadata: { className: "Wise read" }, className: "Mirror name" });
    const nameless = await seedRow(3, { endAt: "2026-09-30T02:00:00Z" });

    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });
    const names = (rows: ReadonlyArray<{ wiseSessionId: string; className: string | null }>) =>
      Object.fromEntries(rows.map((row) => [row.wiseSessionId, row.className]));

    const expected = { [unmirrored]: "Athen (Athen.Si) Simthumnimit", [mirrored]: "Mirror name", [nameless]: null };
    expect(names(board.holds)).toEqual(expected);
    expect(names(board.recent)).toEqual(expected);
  });

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

  it("marks a held class as written while its teacher feedback in Wise holds text, and no other", async () => {
    const written = await seedRow(1, { endAt: "2026-09-29T03:00:00Z", className: "Class one" });
    const rewritten = await seedRow(2, { endAt: "2026-09-29T03:30:00Z", wiseTeacherUserId: EK_MAIN, className: "Class two" });
    const blankSave = await seedRow(3, { endAt: "2026-09-29T04:00:00Z", reason: "attendance_0pct", className: "Class three" });
    const billingFix = await seedRow(4, { endAt: "2026-09-29T05:00:00Z", reason: "billing_differs_from_current_submission", className: "Class four" });
    const whitespace = await seedRow(5, { endAt: "2026-09-29T07:00:00Z", className: "Class five" });
    const homeworkOnly = await seedRow(6, { endAt: "2026-09-29T08:00:00Z", className: "Class six" });
    const notCollected = await seedRow(7, { endAt: "2026-09-29T09:00:00Z" });
    // A class the tutor wrote before we could: never a hold, whatever is in Wise.
    const tutorFirst = await seedRow(8, { endAt: "2026-09-29T11:00:00Z", state: "skipped_human", reason: "human_submission", className: "Class eight" });

    // Wise's blank auto-submission, then the tutor's text.
    await collect(written, "2026-09-29T03:13:00Z", {});
    await collect(written, "2026-09-29T09:13:00Z", FIELDS);
    // Written, then written again: the text in Wise now.
    await collect(rewritten, "2026-09-29T03:43:00Z", {});
    await collect(rewritten, "2026-09-29T09:13:00Z", FIELDS);
    await collect(rewritten, "2026-09-29T09:43:00Z", { ...FIELDS, improvement: "Number sequences" });
    // The tutor submitted the form blank (the student was absent): a save, and nothing written.
    await collect(blankSave, "2026-09-29T04:13:00Z", {});
    await seedSave(blankSave, "tutor", "2026-09-29T10:00:00Z");
    await collect(blankSave, "2026-09-29T10:13:00Z", {});
    // Staff corrected the credits of a class held for its billing: a person's save, and the form is still blank.
    await collect(billingFix, "2026-09-29T05:13:00Z", {});
    await seedSave(billingFix, "other_staff", "2026-09-29T11:00:00Z");
    await seedSave(billingFix, "owner_web", "2026-09-29T11:30:00Z");
    await collect(billingFix, "2026-09-29T11:43:00Z", {});
    await collect(whitespace, "2026-09-29T12:13:00Z", { topics: "  \n", performance: "\t", improvement: " " });
    // Homework alone is not feedback on the class (the Class Feedback rule): it stays listed.
    await collect(homeworkOnly, "2026-09-29T12:13:00Z", { homework: "Page 12" });
    await seedSave(notCollected, "tutor", "2026-09-29T12:00:00Z");
    await collect(tutorFirst, "2026-09-29T11:13:00Z", FIELDS);

    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });

    expect(Object.fromEntries(board.holds.map((row) => [row.wiseSessionId, row.resolvedBy]))).toEqual({
      [written]: "tutor_wrote", [rewritten]: "tutor_wrote",
      [blankSave]: null, [billingFix]: null, [whitespace]: null, [homeworkOnly]: null, [notCollected]: null,
    });
    // The class stays a hold: the row is still `held`, and the window still counts it.
    expect(board.totals.held).toBe(7);
    expect(board.recent.find((row) => row.wiseSessionId === written)?.state).toBe("held");
    expect(board.holds.some((row) => row.wiseSessionId === tutorFirst)).toBe(false);
  });

  it("does not take text that was taken out again, or a submission that is gone, for a write-up", async () => {
    const erased = await seedRow(1, { endAt: "2026-09-29T03:00:00Z", className: "Class one" });
    const removed = await seedRow(2, { endAt: "2026-09-29T04:00:00Z", className: "Class two" });
    // Wise's blank auto-submission, the tutor's text (the wrong class), and the form cleared again.
    await collect(erased, "2026-09-29T03:13:00Z", {});
    await collect(erased, "2026-09-29T09:13:00Z", FIELDS);
    expect((await loadAutowriterDashboard(db, { windowDays: 7, now: NOW })).holds.find((row) => row.wiseSessionId === erased)?.resolvedBy).toBe("tutor_wrote");
    await collect(erased, "2026-09-29T09:43:00Z", {});
    await collect(removed, "2026-09-29T09:13:00Z", FIELDS);
    await collect(removed, "2026-09-29T09:43:00Z", null);

    // The cleared form is the blank version seen first: no new row, so the text is still the version observed last.
    const versions = await db.select({ topics: PCV.topics, wiseSessionId: PC.wiseSessionId }).from(PCV)
      .innerJoin(PC, eq(PC.id, PCV.sessionId)).orderBy(desc(PCV.observedAt));
    expect(versions.filter((row) => row.wiseSessionId === erased)).toHaveLength(2);
    expect(versions.find((row) => row.wiseSessionId === erased)?.topics).toBe(FIELDS.topics);

    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });
    expect(Object.fromEntries(board.holds.map((row) => [row.wiseSessionId, row.resolvedBy]))).toEqual({ [erased]: null, [removed]: null });
  });

  it("reads only a teacher's version through the pointer", async () => {
    const otherProfile = await seedRow(1, { endAt: "2026-09-29T03:00:00Z", className: "Class one" });
    // The collection never points at a version that is not the teacher's; if a pointer ever did, it proves nothing.
    // (A pointer to a version that is gone cannot exist: the column is a foreign key.)
    const [session] = await db.select({ id: PC.id }).from(PC).where(eq(PC.wiseSessionId, otherProfile));
    const [version] = await db.insert(PCV).values({
      sessionId: session.id, versionKey: "submission-2:student", contentHash: "student", profile: "student", observedAt: new Date("2026-09-29T09:13:00Z"), ...FIELDS,
    }).returning({ id: PCV.id });
    await db.update(PC).set({ latestFeedbackVersionId: version.id }).where(eq(PC.id, session.id));
    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });
    expect(board.holds).toMatchObject([{ wiseSessionId: otherProfile, resolvedBy: null }]);
  });

  it("keeps every hold that may still wait when there are more holds than the cap: only old ones are left out", async () => {
    // NOW is 30 Sep, 05:00 UTC. A class with no deadline keeps waiting; one whose deadline passed 10 hours ago is listed
    // for 14 hours more; one whose deadline passed 3 days ago is not listed any more; one is due in two days.
    const noDeadline = await seedRow(1, { endAt: "2026-09-10T03:00:00Z", deadlineAt: null });
    const passedLately = await seedRow(2, { endAt: "2026-09-27T03:00:00Z", deadlineAt: new Date("2026-09-29T19:00:00Z") });
    const passedLongAgo = await seedRow(3, { endAt: "2026-09-24T03:00:00Z", deadlineAt: new Date("2026-09-27T05:00:00Z") });
    const ahead = await seedRow(4, { endAt: "2026-09-30T03:00:00Z" });

    // A cap of three (500 in production): the one hold that no longer waits is the one left out, never the one
    // without a deadline (the latest deadlines alone would have kept the old hold and dropped it).
    const capped = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW, holdsLimit: 3 });
    expect(capped.holds.map((row) => row.wiseSessionId).toSorted()).toEqual([noDeadline, passedLately, ahead].toSorted());
    // Shown soonest deadline first, as always; a class without one last.
    expect(capped.holds.map((row) => row.wiseSessionId)).toEqual([passedLately, ahead, noDeadline]);
    const all = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });
    expect(all.holds.map((row) => row.wiseSessionId)).toEqual([passedLongAgo, passedLately, ahead, noDeadline]);
  });

  it("has no holds and no failed posts when there are none", async () => {
    await seedRow(1, { endAt: "2026-09-30T01:00:00Z", state: "verified", reason: "verified", arm: "sol", postStartedAt: new Date("2026-09-30T01:30:00Z") });
    const board = await loadAutowriterDashboard(db, { windowDays: 7, now: NOW });
    expect(board.holds).toEqual([]);
    expect(board.failedPosts).toEqual([]);
    expect(board.today).toMatchObject({ posted: 1, held: 0 });
  });
});
