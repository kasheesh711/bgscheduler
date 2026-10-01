import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { createCapture, captureView, updateCapture, createAsset, claimTranscription, markDeleted, discardAsset } from "../store";
import type { CaptureSession } from "../model";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const scope = { email: "synthetic-tutor@example.invalid", keys: ["tutor-one"] };
const session: CaptureSession = { sessionId: "synthetic-session", classId: "synthetic-class", studentId: "synthetic-student", studentName: "Sample Learner", teacherKey: "tutor-one", teacherName: "Sample Tutor", title: "Onsite Maths", startTime: new Date().toISOString(), endTime: new Date().toISOString(), wiseUrl: "https://learn.begiftededucation.com/links" };
const input = { id: "11111111-1111-4111-8111-111111111111", sessionId: session.sessionId, studentId: session.studentId, topic: "Fractions", consent: { participants: true as const, guardian: "confirmed" as const, processing: true as const } };
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await db.execute(sql`TRUNCATE class_captures CASCADE`); });

describe("private capture state", () => {
  it("deduplicates capture and upload creation and binds intent to exact metadata", async () => {
    await Promise.all([createCapture(scope, input, session, db), createCapture(scope, input, session, db)]);
    const view = await captureView(scope, input.id, db);
    expect(view.topic).toBe("Fractions");
    const asset = { id: "22222222-2222-4222-8222-222222222222", kind: "recording" as const, mime: "audio/webm" as const, size: 800 };
    const created = await Promise.all([createAsset(scope, input.id, asset, db), createAsset(scope, input.id, asset, db)]);
    expect(created[0].pathname).toBe(created[1].pathname);
    expect((await captureView(scope, input.id, db)).assets).toHaveLength(1);
    await expect(createAsset(scope, input.id, { ...asset, size: 900 }, db)).rejects.toThrow("different");
  });
  it("denies other tutors, other emails, revoked ownership and expired evidence", async () => {
    await createCapture(scope, input, session, db);
    await expect(captureView({ email: "other@example.invalid", keys: null }, input.id, db)).rejects.toThrow("not found");
    await expect(captureView({ ...scope, keys: ["other-tutor"] }, input.id, db)).rejects.toThrow("not found");
    await db.execute(sql`UPDATE class_captures SET expires_at = now() - interval '1 second'`);
    await expect(captureView(scope, input.id, db)).rejects.toThrow("expired");
  });
  it("uses optimistic edits and clears review when evidence changes", async () => {
    await createCapture(scope, input, session, db);
    await updateCapture(scope, input.id, { version: 0, topic: "Fractions", tutorNotes: "Observed written work" }, db);
    await expect(updateCapture(scope, input.id, { version: 0, topic: "Stale tab", tutorNotes: "" }, db)).rejects.toThrow("changed");
    expect((await captureView(scope, input.id, db)).reviewed).toBe(false);
  });
  it("claims paid processing only once and makes cancellation immediately unreadable", async () => {
    await createCapture(scope, input, session, db);
    const asset = await createAsset(scope, input.id, { id: "33333333-3333-4333-8333-333333333333", kind: "recording", mime: "audio/webm", size: 800 }, db);
    await db.execute(sql`UPDATE class_capture_assets SET status = 'ready'`);
    const claims = await Promise.all([claimTranscription(asset.id, db), claimTranscription(asset.id, db)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await markDeleted(scope, input.id, db);
    await expect(captureView(scope, input.id, db)).rejects.toThrow("deleted");
  });
  it("explicit regeneration clears the draft and discarded audio no longer blocks the workflow", async () => {
    await createCapture(scope, input, session, db);
    const fields = { topicsCovered: "Draft", demonstratedUnderstanding: "Review", difficulties: "Review", homeworkNextSteps: "Review" };
    await updateCapture(scope, input.id, { version: 0, topic: "Fractions", tutorNotes: "Tutor observation", fields }, db);
    await updateCapture(scope, input.id, { version: 1, topic: "Fractions", tutorNotes: "Tutor observation", resetDraft: true }, db);
    expect((await captureView(scope, input.id, db)).draft).toBeNull();
    const asset = await createAsset(scope, input.id, { id: "44444444-4444-4444-8444-444444444444", kind: "recording", mime: "audio/webm", size: 800 }, db);
    await discardAsset(scope, input.id, asset.id, db);
    expect((await captureView(scope, input.id, db)).assets).toHaveLength(0);
    expect(await claimTranscription(asset.id, db)).toBeNull();
  });
  it("allows replacing a removed debrief while retaining a lifetime upload budget", async () => {
    await createCapture(scope, input, session, db);
    const first = await createAsset(scope, input.id, { id: "55555555-5555-4555-8555-555555555555", kind: "debrief", mime: "audio/webm", size: 800 }, db);
    await expect(createAsset(scope, input.id, { id: "66666666-6666-4666-8666-666666666666", kind: "debrief", mime: "audio/webm", size: 800 }, db)).rejects.toThrow("limit");
    await discardAsset(scope, input.id, first.id, db);
    await createAsset(scope, input.id, { id: "66666666-6666-4666-8666-666666666666", kind: "debrief", mime: "audio/webm", size: 800 }, db);
    expect((await captureView(scope, input.id, db)).assets).toHaveLength(1);
  });
});
