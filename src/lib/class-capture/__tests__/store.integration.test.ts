import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { createCapture, captureView, updateCapture, createAsset, claimTranscription, markDeleted, discardAsset, assetForScope } from "../store";
import type { CaptureSession } from "../model";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const scope = { email: "synthetic-tutor@example.invalid", keys: ["tutor-one"] };
const session: CaptureSession = { sessionId: "synthetic-session", classId: "synthetic-class", studentId: "synthetic-student", studentName: "Sample Learner", teacherKey: "tutor-one", teacherName: "Sample Tutor", title: "Onsite Maths", startTime: new Date().toISOString(), endTime: new Date().toISOString(), wiseUrl: "https://learn.begiftededucation.com/links" };
const input = { id: "11111111-1111-4111-8111-111111111111", sessionId: session.sessionId, studentId: session.studentId, topic: "Fractions", consent: { participants: true as const, guardian: "confirmed" as const, processing: true as const } };
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await db.execute(sql`TRUNCATE class_captures CASCADE`); });
afterEach(() => vi.useRealTimers());

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
  it("accepts more than four photos and more than twenty lifetime uploads without consuming audio quota", async () => {
    await createCapture(scope, input, session, db);
    for (let i = 0; i < 26; i++) {
      await createAsset(scope, input.id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: 8 * 1024 * 1024, worksheetPermission: true }, db);
    }
    expect((await captureView(scope, input.id, db)).assets).toHaveLength(26);
    await expect(createAsset(scope, input.id, { id: crypto.randomUUID(), kind: "recording", mime: "audio/mp4", size: 1024 }, db)).resolves.toMatchObject({ kind: "recording" });
    await expect(createAsset(scope, input.id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: 8 * 1024 * 1024 + 1, worksheetPermission: true }, db)).rejects.toThrow();
  });

  it("denies other tutors, other emails, revoked ownership and expired evidence", async () => {
    await createCapture(scope, input, session, db);
    await expect(captureView({ ...scope, email: "other@example.invalid" }, input.id, db)).rejects.toThrow("not found");
    await expect(captureView({ ...scope, keys: ["other-tutor"] }, input.id, db)).rejects.toThrow("not found");
    await db.execute(sql`UPDATE class_captures SET expires_at = now() - interval '1 second'`);
    await expect(captureView(scope, input.id, db)).rejects.toThrow("expired");
  });
  it("keeps old owner-created captures for another tutor private across every storage operation", async () => {
    const other = { ...scope, keys: ["other-tutor"] };
    const otherSession = { ...session, teacherKey: "other-tutor" };
    await createCapture(other, input, otherSession, db);
    const asset = await createAsset(other, input.id, { id: "22222222-2222-4222-8222-222222222222", kind: "recording", mime: "audio/webm", size: 8 }, db);
    await expect(captureView(scope, input.id, db)).rejects.toMatchObject({ status: 404 });
    await expect(assetForScope(scope, asset.id, db)).rejects.toMatchObject({ status: 404 });
    await expect(updateCapture(scope, input.id, { version: 0, topic: "Denied", tutorNotes: "Denied" }, db)).rejects.toMatchObject({ status: 404 });
    await expect(createAsset(scope, input.id, { id: "33333333-3333-4333-8333-333333333333", kind: "recording", mime: "audio/webm", size: 8 }, db)).rejects.toMatchObject({ status: 404 });
    await expect(discardAsset(scope, input.id, asset.id, db)).rejects.toMatchObject({ status: 404 });
    await expect(markDeleted(scope, input.id, db)).rejects.toMatchObject({ status: 404 });
    await expect(createCapture(scope, input, session, db)).rejects.toMatchObject({ status: 404 });
    // A different intent ID cannot deduplicate into the old admin-wide artifact.
    const ownId = "44444444-4444-4444-8444-444444444444";
    await expect(createCapture(scope, { ...input, id: ownId }, session, db)).resolves.toBe(ownId);
    expect((await captureView(other, input.id, db)).assets).toHaveLength(1);
  });

  it("preserves owned existing-ID recovery after midnight but denies new past/future captures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-01T16:59:59Z");
    const todaySession = { ...session, startTime: "2026-10-01T10:00:00Z", endTime: "2026-10-01T11:00:00Z" };
    await createCapture(scope, input, todaySession, db);
    vi.setSystemTime("2026-10-01T17:00:00Z");
    expect((await captureView(scope, input.id, db)).session.startTime).toBe(todaySession.startTime);
    await expect(createCapture(scope, input, todaySession, db)).resolves.toBe(input.id);
    await updateCapture(scope, input.id, { version: 0, topic: "After midnight", tutorNotes: "Reviewed written work" }, db);
    const asset = await createAsset(scope, input.id, { id: "22222222-2222-4222-8222-222222222222", kind: "recording", mime: "audio/webm", size: 8 }, db);
    await expect(assetForScope(scope, asset.id, db)).resolves.toMatchObject({ captureId: input.id });
    await expect(createCapture(scope, { ...input, id: "33333333-3333-4333-8333-333333333333", sessionId: "yesterday" }, { ...todaySession, sessionId: "yesterday" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(createCapture(scope, { ...input, id: "44444444-4444-4444-8444-444444444444", sessionId: "tomorrow" }, { ...todaySession, sessionId: "tomorrow", startTime: "2026-10-03T10:00:00Z" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(captureView({ ...scope, keys: ["other-tutor"] }, input.id, db)).rejects.toMatchObject({ status: 404 });
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
