import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
const mocks = vi.hoisted(() => ({ del: vi.fn(), reap: vi.fn(), job: vi.fn(), file: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: mocks.del }));
vi.mock("../sessions", () => ({ loadPriorFeedback: vi.fn(async () => []) }));
vi.mock("../providers", () => ({ createCaptureSpeechClient: () => ({ reapOrphans: mocks.reap, removeJob: mocks.job, removeFile: mocks.file }) }));
import { cleanupCapture, cleanupClassCaptures } from "../cleanup";
import { createCapture, createAsset, discardAsset, markDeleted } from "../store";
import { classCaptures, classCaptureAssets } from "@/lib/db/schema";
import type { CaptureSession } from "../model";

let h: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", assetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = { email: "synthetic@example.invalid", keys: ["tutor"] };
const consent = { participants: true as const, guardian: "confirmed" as const, processing: true as const };
const session: CaptureSession = { sessionId: "sample", classId: "sample-class", studentId: "sample-student", studentName: "Sample Learner", teacherKey: "tutor", teacherName: "Sample Tutor", title: "Onsite maths", startTime: new Date().toISOString(), endTime: new Date().toISOString(), wiseUrl: "https://learn.begiftededucation.com/links" };
beforeAll(async () => { h = await startTestDb(); db = h.db as unknown as Database; });
afterAll(async () => { vi.unstubAllEnvs(); if (h) await stopTestDb(h); });
beforeEach(async () => {
  vi.resetAllMocks(); mocks.del.mockResolvedValue(undefined); mocks.reap.mockResolvedValue(0); mocks.job.mockResolvedValue(undefined); mocks.file.mockResolvedValue(undefined);
  vi.stubEnv("CLASS_CAPTURE_RETENTION_ENABLED", "true"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic"); vi.stubEnv("SONIOX_API_KEY", "synthetic");
  await db.execute(sql`TRUNCATE class_captures CASCADE`);
});
async function fixture() {
  await createCapture(scope, { id, sessionId: session.sessionId, studentId: session.studentId, topic: "Fractions", consent }, session, db);
  await createAsset(scope, id, { id: assetId, kind: "recording", mime: "audio/webm", size: 8 }, db);
}
describe("capture retention with synthetic private storage", () => {
  it("keeps tombstones to catch late uploads, repeats deletion, then purges after the grace period", async () => {
    await fixture(); await markDeleted(scope, id, db);
    expect(await cleanupCapture(id, db)).toEqual({ purged: false });
    expect(mocks.del).toHaveBeenCalledWith(`class-capture/${id}/${assetId}`, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    await db.execute(sql`UPDATE class_captures SET expires_at = now() - interval '2 hours'`);
    expect(await cleanupCapture(id, db)).toEqual({ purged: true });
    expect(await db.select().from(classCaptures)).toHaveLength(0);
    expect(mocks.del).toHaveBeenCalledTimes(2);
  });
  it("preserves unknown provider outcomes until a complete applicable orphan reconciliation succeeds", async () => {
    await fixture();
    await db.execute(sql`UPDATE class_captures SET expires_at = now() - interval '2 hours'`);
    await db.execute(sql`UPDATE class_capture_assets SET provider_uncertain = true, processing_started_at = now() - interval '26 hours'`);
    vi.stubEnv("SONIOX_API_KEY", "");
    expect((await cleanupClassCaptures(db)).ok).toBe(false);
    expect(await db.select().from(classCaptures)).toHaveLength(1);
    vi.stubEnv("SONIOX_API_KEY", "synthetic"); mocks.reap.mockRejectedValueOnce(new Error("incomplete scan"));
    await db.execute(sql`UPDATE class_captures SET cleanup_attempted_at = null`);
    expect((await cleanupClassCaptures(db)).ok).toBe(false);
    expect((await db.select().from(classCaptureAssets))[0].providerUncertain).toBe(true);
    await db.execute(sql`UPDATE class_captures SET cleanup_attempted_at = null`);
    expect((await cleanupClassCaptures(db)).ok).toBe(true);
    expect(await db.select().from(classCaptures)).toHaveLength(0);
  });
  it("rotates beyond the first 25 tombstones instead of starving newer deletions", async () => {
    const values = Array.from({ length: 26 }, () => ({ id: randomUUID(), createdByEmail: scope.email, teacherKey: "tutor", session, consent, topic: "Synthetic", expiresAt: new Date(Date.now() + 86_400_000), deletedAt: new Date() }));
    await db.insert(classCaptures).values(values);
    expect(await cleanupClassCaptures(db)).toMatchObject({ cleaned: 25, deferred: 1 });
    expect(await cleanupClassCaptures(db)).toMatchObject({ cleaned: 1, deferred: 0 });
    expect((await db.select().from(classCaptures)).every(row => row.cleanupAttemptedAt)).toBe(true);
  });
  it("removes a discarded asset before expiry without deleting the active capture", async () => {
    await fixture(); await discardAsset(scope, id, assetId, db);
    expect((await cleanupClassCaptures(db)).ok).toBe(true);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(await db.select().from(classCaptures)).toHaveLength(1);
  });
  it("does not begin another external deletion after its deadline", async () => {
    await fixture(); await markDeleted(scope, id, db);
    await expect(cleanupCapture(id, db, Date.now() - 1)).rejects.toThrow("pending");
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
