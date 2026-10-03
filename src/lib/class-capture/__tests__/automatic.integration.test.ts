import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../sessions", () => ({ loadPriorFeedback: vi.fn(async () => []), assertCaptureSessionCurrent: vi.fn(), pilotEmails: () => ["synthetic@example.invalid"] }));
import { sql, eq } from "drizzle-orm";
import sharp from "sharp";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { classCaptureJobs as jobs, classCaptureAssets as assets, classCaptures as captures } from "@/lib/db/schema";
import { automaticAction, processAutomaticCapture, type AutomaticDeps } from "../automatic";
import { AnalysisError } from "../synthesis";
import { createCapture, createAsset, captureView, updateCapture, discardAsset, markDeleted } from "../store";
import type { CaptureSession } from "../model";
let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const scope = { email: "synthetic@example.invalid", keys: ["one"] };
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session: CaptureSession = { sessionId: "sample", classId: "class", studentId: "student", studentName: "Sample", teacherKey: "one", teacherName: "Tutor", title: "Maths", startTime: new Date().toISOString(), endTime: new Date().toISOString(), wiseUrl: "https://learn.begiftededucation.com/links" };
const fields = { topicsCovered: "Fractions.", demonstratedUnderstanding: "", difficulties: "", homeworkNextSteps: "" };
const synthesis = () => ({ fields: { ...fields }, evidence: { sources: [], questions: [] as string[] } });
let deps: AutomaticDeps;
const findings = { questions: ["1/2 + 1/2"], studentWork: ["1"], markings: [], uncertainties: [] };
let bytes: Buffer;
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).jpeg().toBuffer(); });
afterAll(async () => { vi.unstubAllEnvs(); if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  for (const flag of ["ENABLE_CLASS_CAPTURE", "CLASS_CAPTURE_AUTOMATIC_WORKFLOW", "CLASS_CAPTURE_PROCESSING_APPROVED", "CLASS_CAPTURE_RETENTION_ENABLED"]) vi.stubEnv(flag, "true");
  for (const key of ["SONIOX_API_KEY", "OPENROUTER_API_KEY", "BLOB_READ_WRITE_TOKEN"]) vi.stubEnv(key, "synthetic");
  await db.execute(sql`TRUNCATE class_captures CASCADE`);
  await createCapture(scope, { id, sessionId: session.sessionId, studentId: session.studentId, topic: "Fractions", consent: { participants: true, guardian: "confirmed", processing: true } }, session, db);
  deps = { db, authorize: async () => scope, prior: async () => [], bytes: async () => bytes, readPhoto: vi.fn(async () => findings), synthesize: vi.fn(async () => synthesis()) };
});
async function consent() { await automaticAction(scope, id, { action: "consent" }, db); }
async function audio() {
  const asset = await createAsset(scope, id, { id: crypto.randomUUID(), kind: "recording", mime: "audio/mp4", size: 20 }, db);
  await db.update(assets).set({ status: "transcribed", transcript: "We discussed fractions." }).where(eq(assets.id, asset.id)); return asset.id;
}
async function tick() {
  await db.update(jobs).set({ dueAt: new Date(0), settleUntil: new Date(0) }).where(eq(jobs.captureId, id));
  await processAutomaticCapture(id, deps);
}

describe("automatic capture durable workflow", () => {
  it("requires consent and the separate workflow flag before processing", async () => {
    await audio(); await tick(); expect(deps.synthesize).not.toHaveBeenCalled();
    await expect(automaticAction(scope, id, { action: "stage", assetIds: [crypto.randomUUID()] }, db)).rejects.toThrow("Confirm");
    await consent(); vi.stubEnv("CLASS_CAPTURE_AUTOMATIC_WORKFLOW", "false"); await tick(); expect(deps.synthesize).not.toHaveBeenCalled();
  });
  it("creates one saved draft under duplicate requests and resumes without a second paid call", async () => {
    await consent(); await audio(); await db.update(jobs).set({ dueAt: new Date(0) });
    await Promise.all([processAutomaticCapture(id, deps), processAutomaticCapture(id, deps)]);
    await tick(); expect(deps.synthesize).toHaveBeenCalledTimes(1);
    expect((await captureView(scope, id, db)).draft).toEqual(fields);
  });
  it("waits for stopped recording and every staged upload, then settles for ten seconds", async () => {
    await consent(); await audio(); const missing = crypto.randomUUID();
    await automaticAction(scope, id, { action: "stage", assetIds: [missing] }, db); await tick();
    expect(deps.synthesize).not.toHaveBeenCalled();
    await automaticAction(scope, id, { action: "forget", assetId: missing }, db);
    await automaticAction(scope, id, { action: "recording", active: true }, db); await tick();
    expect(deps.synthesize).not.toHaveBeenCalled();
    await automaticAction(scope, id, { action: "recording", active: false }, db);
    await db.update(jobs).set({ dueAt: new Date(0) }); await processAutomaticCapture(id, deps);
    expect(deps.synthesize).not.toHaveBeenCalled(); await tick(); expect(deps.synthesize).toHaveBeenCalledTimes(1);
  });
  it("processes 24 photos in pairs and synthesizes all findings", async () => {
    await consent(); let active = 0, peak = 0;
    deps.readPhoto = vi.fn(async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 5)); active--; return findings; });
    for (let n = 0; n < 24; n++) await createAsset(scope, id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: bytes.length, worksheetPermission: true }, db);
    await db.update(assets).set({ status: "ready" });
    for (let n = 0; n < 13; n++) await tick();
    expect(peak).toBe(2); expect(deps.readPhoto).toHaveBeenCalledTimes(24);
    expect(deps.synthesize).toHaveBeenCalledWith(expect.objectContaining({ assets: expect.arrayContaining([expect.objectContaining({ photoFindings: findings })]) }));
    expect(vi.mocked(deps.synthesize!).mock.calls[0][0].assets).toHaveLength(24);
  });
  it("recovers a completed upload when the browser never received finalization", async () => {
    await consent();
    const asset = await createAsset(scope, id, { id: crypto.randomUUID(), kind: "recording", mime: "audio/mp4", size: 20 }, db);
    await db.update(assets).set({ createdAt: new Date(Date.now() - 40000) }).where(eq(assets.id, asset.id));
    deps.finalize = vi.fn(async () => { await db.update(assets).set({ status: "transcribed", transcript: "Fractions" }).where(eq(assets.id, asset.id)); });
    await tick(); await tick(); expect(deps.finalize).toHaveBeenCalledTimes(1); expect(deps.synthesize).toHaveBeenCalledTimes(1);
  });
  it("preserves edits made while drafting and exposes an explicit proposal", async () => {
    await consent(); await audio();
    deps.synthesize = vi.fn(async () => {
      const current = await captureView(scope, id, db);
      await updateCapture(scope, id, { version: current.version, topic: current.topic, tutorNotes: "", fields: { ...fields, topicsCovered: "My own edits" } }, db);
      return synthesis();
    });
    await tick(); const view = await captureView(scope, id, db);
    expect(view.draft?.topicsCovered).toBe("My own edits"); expect(view.automatic?.proposal?.fields).toEqual(fields);
    await automaticAction(scope, id, { action: "accept", version: view.version, revision: view.automatic!.revision }, db);
    expect((await captureView(scope, id, db)).draft).toEqual(fields);
  });
  it("discards stale results when more files arrive during drafting", async () => {
    await consent(); await audio();
    deps.synthesize = vi.fn(async () => { await audio(); return synthesis(); });
    await tick(); const view = await captureView(scope, id, db);
    expect(view.draft).toBeNull(); expect(view.automatic?.status).toBe("waiting");
    deps.synthesize = vi.fn(async () => synthesis()); await tick(); expect((await captureView(scope, id, db)).draft).toEqual(fields);
  });
  it("keeps the existing draft during new material processing and rejects a stale proposal", async () => {
    await consent(); const first = await audio(); await tick();
    const view = await captureView(scope, id, db); await updateCapture(scope, id, { version: view.version, topic: view.topic, tutorNotes: "", fields: { ...fields, topicsCovered: "Edited" } }, db);
    await discardAsset(scope, id, first, db); await audio(); expect((await captureView(scope, id, db)).draft?.topicsCovered).toBe("Edited"); await tick();
    const proposed = await captureView(scope, id, db); await audio();
    await expect(automaticAction(scope, id, { action: "accept", version: proposed.version, revision: proposed.automatic!.revision }, db)).rejects.toThrow("changed");
  });
  it("never repeats an uncertain paid writer request, even after adding material", async () => {
    await consent(); await audio(); deps.synthesize = vi.fn(async () => { throw new AnalysisError(true, false, "Unknown provider outcome"); });
    await tick(); await expect(automaticAction(scope, id, { action: "retry" }, db)).rejects.toThrow("outcome");
    await audio(); await tick(); expect(deps.synthesize).toHaveBeenCalledTimes(1);
  });
  it("recovers killed writer leases without replaying the request", async () => {
    await consent(); await audio(); await db.update(jobs).set({ status: "writing", draftUncertain: true, leaseUntil: new Date(0) }); await tick();
    expect(deps.synthesize).not.toHaveBeenCalled(); expect((await captureView(scope, id, db)).automatic?.status).toBe("attention");
  });
  it("retries known throttling automatically and holds uncertain photo results", async () => {
    await consent(); await audio(); let count = 0;
    deps.synthesize = vi.fn(async () => { if (!count++) throw new AnalysisError(false, true, "Rate limited"); return synthesis(); });
    await tick(); await tick(); expect(deps.synthesize).toHaveBeenCalledTimes(2);
    const photo = await createAsset(scope, id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: bytes.length, worksheetPermission: true }, db);
    await db.update(assets).set({ status: "ready", analysisAttemptedAt: new Date(), analysisUncertain: true }).where(eq(assets.id, photo.id));
    await tick(); expect(deps.readPhoto).not.toHaveBeenCalled();
    await expect(automaticAction(scope, id, { action: "retry", assetId: photo.id }, db)).rejects.toThrow("outcome");
    await tick(); expect((await captureView(scope, id, db)).automatic?.proposal?.evidence.questions).toHaveLength(1);
  });
  it("does not let an image retry clear an earlier uncertain writer outcome", async () => {
    await consent(); await audio(); deps.synthesize = vi.fn(async () => { throw new AnalysisError(true, false, "Unknown outcome"); }); await tick();
    const photo = await createAsset(scope, id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: bytes.length, worksheetPermission: true }, db);
    await db.update(assets).set({ status: "ready" }).where(eq(assets.id, photo.id));
    deps.readPhoto = vi.fn(async () => { throw new AnalysisError(false, true, "Rate limited"); }); await tick();
    const [job] = await db.select().from(jobs); expect(job.draftUncertain).toBe(true);
    deps.readPhoto = vi.fn(async () => findings); await tick(); await tick(); expect(deps.synthesize).toHaveBeenCalledTimes(1);
  });
  it("settles for ten seconds after the final material finishes processing", async () => {
    await consent(); const photo = await createAsset(scope, id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: bytes.length, worksheetPermission: true }, db);
    await db.update(assets).set({ status: "ready" }).where(eq(assets.id, photo.id)); await tick();
    await db.update(jobs).set({ dueAt: new Date(0) }); await processAutomaticCapture(id, deps);
    expect(deps.synthesize).not.toHaveBeenCalled(); await tick(); expect(deps.synthesize).toHaveBeenCalledTimes(1);
  });
  it("concurrent retries cannot reset an in-flight photo attempt", async () => {
    await consent(); const photo = await createAsset(scope, id, { id: crypto.randomUUID(), kind: "worksheet", mime: "image/jpeg", size: bytes.length, worksheetPermission: true }, db);
    await db.update(assets).set({ status: "ready", analysisAttemptedAt: new Date(), error: "Known invalid response", analysisUncertain: false }).where(eq(assets.id, photo.id));
    await Promise.allSettled([automaticAction(scope, id, { action: "retry", assetId: photo.id }, db), automaticAction(scope, id, { action: "retry", assetId: photo.id }, db)]);
    await tick(); await tick(); expect(deps.readPhoto).toHaveBeenCalledTimes(1);
  });
  it("does not start a paid writer after another worker takes its lease", async () => {
    await consent(); await audio();
    deps.authorize = async () => { await db.update(jobs).set({ leaseUntil: new Date(Date.now() + 300000) }); return scope; };
    await tick(); expect(deps.synthesize).not.toHaveBeenCalled();
  });
  it("cannot restore evidence or feedback after deletion during generation", async () => {
    await consent(); await audio(); deps.synthesize = vi.fn(async () => { await markDeleted(scope, id, db); return synthesis(); }); await tick();
    const [row] = await db.select({ draft: captures.draft }).from(captures).where(eq(captures.id, id));
    // The access API also refuses this capture, irrespective of background completion.
    await expect(captureView(scope, id, db)).rejects.toThrow("deleted");
    expect(row.draft).toBeNull();
  });
});
