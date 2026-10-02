import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../sessions", () => ({ loadPriorFeedback: vi.fn(async () => []) }));
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { createCapture, createAsset, captureView, markDeleted } from "../store";
import { transcribeCapture, draftCapture } from "../processing";
import type { CaptureScope, CaptureSession } from "../model";
let h: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const scope = { email: "synthetic@example.invalid", keys: ["one"] };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session: CaptureSession = { sessionId: "sample", classId: "sample-class", studentId: "sample-student", studentName: "Sample Learner", teacherKey: "one", teacherName: "Sample Tutor", title: "Onsite maths", startTime: new Date().toISOString(), endTime: new Date().toISOString(), wiseUrl: "https://learn.begiftededucation.com/links" };
beforeAll(async () => { h = await startTestDb(); db = h.db as unknown as Database; });
afterAll(async () => { vi.unstubAllEnvs(); if (h) await stopTestDb(h); });
beforeEach(async () => {
  vi.stubEnv("ENABLE_CLASS_CAPTURE", "true"); vi.stubEnv("CLASS_CAPTURE_PROCESSING_APPROVED", "true");
  vi.stubEnv("SONIOX_API_KEY", "synthetic"); vi.stubEnv("OPENROUTER_API_KEY", "synthetic"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic");
  await db.execute(sql`TRUNCATE class_captures CASCADE`);
  await createCapture(scope, { id, sessionId: session.sessionId, studentId: session.studentId, topic: "Fractions", consent: { participants: true, guardian: "confirmed", processing: true } }, session, db);
  await createAsset(scope, id, { id: assetId, kind: "recording", mime: "audio/webm", size: 8 }, db);
  await db.execute(sql`UPDATE class_capture_assets SET status = 'ready'`);
});
const client = () => ({ upload: vi.fn(async () => "file"), create: vi.fn(async () => "job"), get: vi.fn(async () => ({ status: "completed" as const })), transcript: vi.fn(async () => "Synthetic classroom speech."), removeFile: vi.fn(async () => {}), removeJob: vi.fn(async () => {}), reapOrphans: vi.fn(async () => 0) });
describe("durable evidence processing", () => {
  it.each([
    { actor: { ...scope, keys: null }, status: 403 },
    { actor: { ...scope, keys: [] }, status: 403 },
    { actor: { ...scope, keys: ["one", "two"] }, status: 403 },
    { actor: { ...scope, keys: ["other-tutor"] }, status: 404 },
    { actor: { ...scope, email: "other@example.invalid" }, status: 404 },
  ])("denies unscoped or differently owned evidence before private bytes, prior context or paid providers: $actor", async ({ actor, status }) => {
    const speech = client(), readBytes = vi.fn(), prior = vi.fn(), generate = vi.fn();
    await expect(transcribeCapture(actor as CaptureScope, id, assetId, { db, speech, readBytes })).rejects.toMatchObject({ status });
    await expect(draftCapture(actor as CaptureScope, id, { db, prior, generate })).rejects.toMatchObject({ status });
    expect(readBytes).not.toHaveBeenCalled();
    expect(speech.upload).not.toHaveBeenCalled();
    expect(speech.create).not.toHaveBeenCalled();
    expect(prior).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("concurrent clicks start one paid job, then resume by stored job ID and remove provider copies", async () => {
    const speech = client();
    const deps = { db, speech, readBytes: async () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]) };
    await Promise.all([transcribeCapture(scope, id, assetId, deps), transcribeCapture(scope, id, assetId, deps)]);
    await transcribeCapture(scope, id, assetId, deps);
    const view = await captureView(scope, id, db);
    expect(view.assets[0].transcript).toBe("Synthetic classroom speech.");
    expect(speech.upload).toHaveBeenCalledTimes(1);
    expect(speech.create).toHaveBeenCalledTimes(1);
    expect(speech.removeJob).toHaveBeenCalled();
    expect(speech.removeFile).toHaveBeenCalled();
  });
  it("does not retry an unknown provider outcome or access a cancelled capture", async () => {
    const speech = client(); speech.create.mockRejectedValue(new Error("unknown network outcome"));
    const deps = { db, speech, readBytes: async () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]) };
    await expect(transcribeCapture(scope, id, assetId, deps)).rejects.toThrow("uncertain");
    await expect(transcribeCapture(scope, id, assetId, deps)).rejects.toThrow();
    expect(speech.create).toHaveBeenCalledTimes(1);
    await markDeleted(scope, id, db);
    await expect(transcribeCapture(scope, id, assetId, deps)).rejects.toThrow("deleted");
  });
  it("does not generate from pending media or publish a draft when cancelled during generation", async () => {
    await expect(draftCapture(scope, id, { db, prior: async () => [], generate: vi.fn() })).rejects.toThrow("Transcribe");
    await db.execute(sql`UPDATE class_capture_assets SET status='transcribed', transcript='Synthetic speech'`);
    const generate = vi.fn(async () => {
      await markDeleted(scope, id, db);
      return { topicsCovered: "Fractions", demonstratedUnderstanding: "Tutor review required", difficulties: "Not observed", homeworkNextSteps: "Tutor review required" };
    });
    await expect(draftCapture(scope, id, { db, prior: async () => [], generate })).rejects.toThrow("changed");
    const rows = await db.execute(sql`SELECT draft FROM class_captures WHERE id = ${id}`);
    expect(rows.rows[0].draft).toBeNull();
  });
});
