import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { classCaptures as captures, classCaptureAssets as assets, classCaptureJobs as jobs, adminUsers, tutorContacts } from "@/lib/db/schema";
import { automaticCaptureEnabled } from "./automatic-model";
import { availability, CaptureError, normalizeCaptureEmail, type CaptureScope } from "./model";
import { captureForScope, type StoredCapture } from "./store";
import { assertCaptureSessionCurrent, loadPriorFeedback, pilotEmails } from "./sessions";
import { transcribeCapture, removeProviderCopies } from "./processing";
import { CaptureSpeechError, createCaptureSpeechClient } from "./providers";
import { finalizeAsset, readMediaBytes } from "./files";
import { AnalysisError, readWorksheet, synthesizeFeedback } from "./synthesis";

type Job = typeof jobs.$inferSelect;
export const automaticActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("consent") }).strict(),
  z.object({ action: z.literal("stage"), assetIds: z.array(z.uuid()).min(1).max(100) }).strict(),
  z.object({ action: z.literal("recording"), active: z.boolean() }).strict(),
  z.object({ action: z.literal("forget"), assetId: z.uuid() }).strict(),
  z.object({ action: z.literal("retry"), assetId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal("accept"), revision: z.number().int(), version: z.number().int().nonnegative() }).strict(),
]);
const due = () => new Date(Date.now() + 10_000);

async function adminVersion(email: string, db: Database) {
  const rows = await db.select().from(adminUsers).where(sql`lower(btrim(${adminUsers.email})) = ${email}`).limit(2);
  if (rows.length > 1 || rows.some(a => a.disabled || (a.allowedPages !== null && !a.allowedPages.includes("/class-capture")))) throw new CaptureError(403, "Class Capture access is no longer current.");
  return rows[0]?.accessVersion ?? null;
}
/** Background work rechecks current grants; it never manufactures a browser session. */
async function workerScope(capture: StoredCapture, job: Job, db: Database): Promise<CaptureScope> {
  const email = normalizeCaptureEmail(capture.createdByEmail);
  if (!email || !pilotEmails().includes(email) || await adminVersion(email, db) !== job.authorizedAdminVersion) throw new CaptureError(403, "Class Capture access changed. Reopen the class to confirm access.");
  const contacts = await db.select().from(tutorContacts).where(and(eq(tutorContacts.active, true), sql`(lower(btrim(${tutorContacts.onsiteEmail})) = ${email} or lower(btrim(${tutorContacts.onlineEmail})) = ${email})`)).limit(2);
  if (contacts.length !== 1 || contacts[0].canonicalKey !== capture.teacherKey) throw new CaptureError(403, "The tutor binding is no longer current.");
  const scope = { email, keys: [capture.teacherKey] };
  await captureForScope(scope, capture.id, db);
  await assertCaptureSessionCurrent(scope, capture.session);
  return scope;
}
export async function automaticAction(scope: CaptureScope, id: string, raw: unknown, db: Database = getDb()) {
  if (!automaticCaptureEnabled()) throw new CaptureError(503, "Automatic feedback is paused.");
  const input = automaticActionSchema.parse(raw);
  await captureForScope(scope, id, db);
  if (input.action === "consent") {
    const version = await adminVersion(scope.email, db);
    await db.insert(jobs).values({ captureId: id, authorizedAdminVersion: version, dueAt: due() }).onConflictDoNothing();
    return;
  }
  const [job] = await db.select().from(jobs).where(eq(jobs.captureId, id));
  if (!job) throw new CaptureError(409, "Confirm automatic audio and photo processing first.");
  if (input.action === "retry" && input.assetId) {
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.captureId, id), isNull(assets.discardedAt)));
    if (!asset) throw new CaptureError(404, "Material not found.");
    if (asset.providerUncertain || asset.analysisUncertain) throw new CaptureError(409, "This request may already have been processed. Its outcome needs review before another paid attempt.");
    if (asset.status !== "failed" && !(asset.kind === "worksheet" && asset.error)) throw new CaptureError(409, "This material is already processing or complete.");
    if (asset.providerFileId || asset.providerJobId) await removeProviderCopies(asset, createCaptureSpeechClient(process.env.SONIOX_API_KEY!), db);
    await db.update(assets).set({ status: asset.status === "failed" ? "ready" : asset.status, analysisAttemptedAt: null, error: null }).where(eq(assets.id, asset.id));
  }
  if (input.action === "retry" && !input.assetId && job.draftUncertain) throw new CaptureError(409, "The AI request outcome needs review before retrying.");
  await withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select id from class_captures where id = ${id} for update`);
    const current = await captureForScope(scope, id, tx);
    const [latest] = await tx.select().from(jobs).where(eq(jobs.captureId, id));
    if (!latest) throw new CaptureError(409, "Automatic processing is not initialized.");
    if (input.action === "accept") {
      if (!latest.proposal || latest.proposal.revision !== input.revision || latest.revision !== input.revision || current.version !== input.version) throw new CaptureError(409, "The draft changed. Refresh before applying this proposal.");
      await tx.update(captures).set({ draft: latest.proposal.fields, reviewed: false, version: sql`${captures.version} + 1` }).where(eq(captures.id, id));
      await tx.update(jobs).set({ evidence: latest.proposal.evidence, proposal: null }).where(eq(jobs.captureId, id));
      return;
    }
    if (input.action === "forget") {
      const [asset] = await tx.select().from(assets).where(and(eq(assets.id, input.assetId), eq(assets.captureId, id), isNull(assets.discardedAt)));
      if (asset) throw new CaptureError(409, "Remove the material before removing its upload from the queue.");
    }
    const expected = input.action === "stage" ? [...new Set([...latest.expectedUploads, ...input.assetIds])]
      : input.action === "forget" ? latest.expectedUploads.filter(a => a !== input.assetId) : latest.expectedUploads;
    const changed = input.action !== "stage" || expected.length !== latest.expectedUploads.length;
    if (!changed) return;
    await tx.update(jobs).set({ expectedUploads: expected, recording: input.action === "recording" ? input.active : latest.recording,
      revision: sql`${jobs.revision} + 1`, attempts: 0, settleUntil: due(), dueAt: due(), status: "waiting", error: null, updatedAt: new Date() }).where(eq(jobs.captureId, id));
    await tx.update(captures).set({ reviewed: false }).where(eq(captures.id, id));
  });
}

export type AutomaticDeps = {
  db?: Database;
  authorize?: (capture: StoredCapture, job: Job, db: Database) => Promise<CaptureScope>;
  transcribe?: typeof transcribeCapture;
  readPhoto?: typeof readWorksheet;
  bytes?: typeof readMediaBytes;
  finalize?: typeof finalizeAsset;
  synthesize?: typeof synthesizeFeedback;
  prior?: typeof loadPriorFeedback;
};
/** One bounded pass. All external calls finish before the 180-second lease can expire. */
export async function processAutomaticCapture(id: string, deps: AutomaticDeps = {}) {
  if (!automaticCaptureEnabled() || process.env.CLASS_CAPTURE_RETENTION_ENABLED !== "true") return;
  const db = deps.db ?? getDb();
  const lease = new Date(Date.now() + 180_000);
  const [job] = await db.update(jobs).set({ leaseUntil: lease }).where(and(eq(jobs.captureId, id), lte(jobs.dueAt, new Date()),
    sql`${jobs.status} in ('waiting','processing','writing')`, sql`(${jobs.leaseUntil} is null or ${jobs.leaseUntil} < now())`,
    sql`exists (select 1 from class_captures c where c.id = ${jobs.captureId} and c.deleted_at is null and c.expires_at > now())`)).returning();
  if (!job) return;
  const owned = () => and(eq(jobs.captureId, id), eq(jobs.leaseUntil, lease));
  try {
    if (!availability().drafting) throw new CaptureError(503, "Automatic feedback is unavailable until approved AI processing is configured.");
    const [capture] = await db.select().from(captures).where(eq(captures.id, id));
    const scope = await (deps.authorize ?? workerScope)(capture, job, db);
    const media = await db.select().from(assets).where(and(eq(assets.captureId, id), isNull(assets.discardedAt)));
    // If the phone sleeps after Blob finishes but before finalization responds, recover the saved intent.
    const abandonedUploads = media.filter(a => a.status === "pending" && a.createdAt.getTime() < Date.now() - 30_000).slice(0, 2);
    if (abandonedUploads.length) {
      await Promise.all(abandonedUploads.map(async asset => {
        try { await (deps.finalize ?? finalizeAsset)(scope, id, asset.id, db); }
        catch (error) { if (!(error instanceof CaptureError) || ![404, 409].includes(error.status)) throw error; }
      }));
    }
    const photos = media.filter(a => a.kind === "worksheet" && a.status === "ready" && !a.photoFindings && !a.error).slice(0, 2);
    const audio = media.find(a => a.kind !== "worksheet" && (a.status === "ready" || a.status === "transcribing"));
    if (photos.length || audio) {
      await db.update(jobs).set({ status: "processing", dueAt: new Date(Date.now() + 5000) }).where(owned());
      // Photo requests and one speech step run concurrently, bounded within one job lease.
      await Promise.all([
        ...photos.map(async photo => {
          if (photo.analysisAttemptedAt) {
            await db.update(assets).set({ analysisUncertain: true, error: "The photo analysis outcome needs review; it will not be repeated automatically." }).where(eq(assets.id, photo.id));
            return;
          }
          const bytes = await (deps.bytes ?? readMediaBytes)(photo);
          // Ready assets already passed full validation; their private upload paths cannot be overwritten.
          await captureForScope(scope, id, db);
          const [claimed] = await db.update(assets).set({ analysisAttemptedAt: new Date(), analysisUncertain: true }).where(and(eq(assets.id, photo.id), isNull(assets.discardedAt), isNull(assets.analysisAttemptedAt))).returning();
          if (!claimed) return;
          try {
            const findings = await (deps.readPhoto ?? readWorksheet)(bytes, photo.mime);
            await db.update(assets).set({ photoFindings: findings, analysisUncertain: false, error: null }).where(and(eq(assets.id, photo.id), isNull(assets.discardedAt), sql`exists (select 1 from class_captures c where c.id = ${id} and c.deleted_at is null and c.expires_at > now())`));
          } catch (error) {
            const retryable = error instanceof AnalysisError && error.retryable;
            await db.update(assets).set({ analysisAttemptedAt: retryable ? null : new Date(), analysisUncertain: !(error instanceof AnalysisError) || error.uncertain,
              error: retryable ? null : error instanceof CaptureError ? error.message : "The photo analysis outcome needs review." }).where(eq(assets.id, photo.id));
            if (retryable) throw error;
          }
        }),
        ...(audio ? [(deps.transcribe ?? transcribeCapture)(scope, id, audio.id, { db, speech: createCaptureSpeechClient(process.env.SONIOX_API_KEY!, fetch, { deadlineMs: Date.now() + 120_000 }) }).catch(async error => {
          // A stored speech failure is displayed per file. Poll/network failures with a known job can retry safely.
          const [current] = await db.select().from(assets).where(eq(assets.id, audio.id));
          if (current.status !== "failed") {
            if (current.providerJobId && error instanceof CaptureSpeechError && (error.status === null || error.status === 429 || error.status >= 500)) throw new CaptureError(503, "Transcription status is temporarily unavailable. It will retry using the saved job.");
            throw error;
          }
        })] : []),
      ]);
      return;
    }
    const outstanding = job.expectedUploads.filter(id => !media.some(a => a.id === id && a.status !== "pending"));
    if (job.recording || outstanding.length || media.some(a => a.status === "pending")) {
      await db.update(jobs).set({ status: "waiting", dueAt: new Date(Date.now() + 15_000) }).where(owned()); return;
    }
    const usable = media.filter(a => a.kind === "worksheet" ? !!a.photoFindings : a.status === "transcribed");
    if (!usable.length) {
      await db.update(jobs).set({ status: "attention", error: "No readable materials yet. Retry or remove a failed file, or add audio or photos." }).where(owned()); return;
    }
    if (job.settleUntil.getTime() > Date.now()) {
      await db.update(jobs).set({ status: "waiting", dueAt: job.settleUntil }).where(owned()); return;
    }
    if (job.draftUncertain) {
      await db.update(jobs).set({ status: "attention", error: "The draft request outcome needs review before another paid attempt." }).where(owned()); return;
    }
    if (job.completedRevision === job.revision) { await db.update(jobs).set({ status: "ready" }).where(owned()); return; }
    // A killed writer may already have incurred cost. Never replay it on lease expiry.
    if (job.status === "writing") {
      await db.update(jobs).set({ status: "attention", error: "The draft request outcome needs review before another paid attempt." }).where(owned()); return;
    }
    if (job.attempts >= 3) { await db.update(jobs).set({ status: "attention", error: "Processing could not complete after three attempts. Retry when ready." }).where(owned()); return; }
    await db.update(jobs).set({ status: "writing", draftUncertain: true, attempts: sql`${jobs.attempts} + 1` }).where(owned());
    let prior: Array<{ date: string; text: string }> = [];
    try { prior = await (deps.prior ?? loadPriorFeedback)(scope, capture.session); } catch { /* History is optional context. */ }
    const result = await (deps.synthesize ?? synthesizeFeedback)({ topic: capture.topic, tutorNotes: capture.tutorNotes, assets: usable, prior });
    if (usable.length < media.length) result.evidence.questions.push(`${media.length - usable.length} material(s) could not be read. This draft uses the successfully processed materials only.`);
    await withDatabaseTransaction(db, async tx => {
      await tx.execute(sql`select id from class_captures where id = ${id} for update`);
      const current = await captureForScope(scope, id, tx);
      const [fresh] = await tx.select().from(jobs).where(eq(jobs.captureId, id));
      if (!fresh || fresh.leaseUntil?.getTime() !== lease.getTime()) return;
      if (fresh.revision !== job.revision) { await tx.update(jobs).set({ status: "waiting", draftUncertain: false, dueAt: due() }).where(eq(jobs.captureId, id)); return; }
      if (!current.draft) {
        await tx.update(captures).set({ draft: result.fields, reviewed: false, version: sql`${captures.version} + 1` }).where(eq(captures.id, id));
        await tx.update(jobs).set({ evidence: result.evidence, proposal: null }).where(eq(jobs.captureId, id));
      } else {
        await tx.update(jobs).set({ proposal: { ...result, revision: job.revision } }).where(eq(jobs.captureId, id));
      }
      await tx.update(jobs).set({ status: "ready", draftUncertain: false, completedRevision: job.revision, error: null, expectedUploads: [], updatedAt: new Date() }).where(eq(jobs.captureId, id));
    });
  } catch (error) {
    const retryable = error instanceof AnalysisError ? error.retryable : error instanceof CaptureError && [429, 503].includes(error.status);
    if (error instanceof AnalysisError && !error.uncertain) await db.update(jobs).set({ draftUncertain: false }).where(owned());
    await db.update(jobs).set({ status: retryable && job.attempts < 3 ? "waiting" : "attention", error: error instanceof CaptureError ? error.message : "Processing could not finish. Your materials are saved.",
      attempts: sql`${jobs.attempts} + 1`, dueAt: new Date(Date.now() + 30_000) }).where(and(owned(), eq(jobs.revision, job.revision)));
  } finally {
    await db.update(jobs).set({ leaseUntil: null }).where(owned());
  }
}
export async function processAutomaticQueue() {
  if (!automaticCaptureEnabled()) return { enabled: false, processed: 0 };
  const db = getDb();
  const rows = await db.select({ id: jobs.captureId }).from(jobs).innerJoin(captures, eq(captures.id, jobs.captureId))
    .where(and(isNull(captures.deletedAt), gt(captures.expiresAt, new Date()), lte(jobs.dueAt, new Date()),
      sql`${jobs.status} in ('waiting','processing','writing')`, sql`(${jobs.leaseUntil} is null or ${jobs.leaseUntil} < now())`)).orderBy(jobs.dueAt).limit(10);
  // At most two captures at once; reserve the full pass budget before starting another pair.
  const deadline = Date.now() + 285_000;
  let processed = 0;
  for (let i = 0; i < rows.length && Date.now() < deadline - 180_000; i += 2) {
    await Promise.all(rows.slice(i, i + 2).map(row => processAutomaticCapture(row.id)));
    processed += Math.min(2, rows.length - i);
  }
  return { enabled: true, processed };
}

/** Best-effort foreground dispatch; the persisted queue and cron are the recovery path. */
export async function kickAutomaticCapture(id: string) {
  if (!automaticCaptureEnabled()) return;
  const until = Date.now() + 100_000;
  const db = getDb();
  while (Date.now() < until) {
    const [job] = await db.select().from(jobs).where(eq(jobs.captureId, id));
    if (!job || ["ready", "attention"].includes(job.status) || (job.leaseUntil && job.leaseUntil.getTime() > Date.now())) return;
    const wait = Math.max(0, job.dueAt.getTime() - Date.now());
    if (wait > 15_000) return;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    await processAutomaticCapture(id);
    if (job.recording) return;
  }
}
