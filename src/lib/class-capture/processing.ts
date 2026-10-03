import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { classCaptureAssets as assets, classCaptures as captures } from "@/lib/db/schema";
import { CaptureError, availability, type DraftFields, type CaptureSession } from "./model";
import { assetForScope, captureForScope, claimTranscription, type StoredAsset } from "./store";
import { readMediaBytes, validateMedia } from "./files";
import { createCaptureSpeechClient } from "./providers";
import { generateCaptureDraft } from "./evidence";
import { loadPriorFeedback, type CaptureScope } from "./sessions";

import { transcriptSegments } from "./transcript-segments";

type Speech = ReturnType<typeof createCaptureSpeechClient>;
type SpeechDeps = { db?: Database; speech?: Speech; readBytes?: (asset: StoredAsset) => Promise<Buffer> };
export async function removeProviderCopies(asset: StoredAsset, speech: Speech, db: Database) {
  // Keep IDs until deletion is confirmed so a later sweep can retry provider failures.
  if (asset.providerJobId) {
    await speech.removeJob(asset.providerJobId);
    await db.update(assets).set({ providerJobId: null }).where(eq(assets.id, asset.id));
  }
  if (asset.providerFileId) {
    await speech.removeFile(asset.providerFileId);
    await db.update(assets).set({ providerFileId: null }).where(eq(assets.id, asset.id));
  }
}
export async function transcribeCapture(scope: CaptureScope, captureId: string, assetId: string, deps: SpeechDeps = {}) {
  const db = deps.db ?? getDb();
  await captureForScope(scope, captureId, db);
  const asset = await assetForScope(scope, assetId, db);
  if (asset.captureId !== captureId || asset.kind === "worksheet") throw new CaptureError(400, "Select audio from this class to transcribe.");
  if (asset.status === "transcribed") return;
  if (!availability().transcription) throw new CaptureError(503, "Transcription needs approved Soniox access and private storage. The private upload remains available until expiry.");
  const speech = deps.speech ?? createCaptureSpeechClient(process.env.SONIOX_API_KEY!);
  if (asset.status === "pending") throw new CaptureError(409, "Finish the private upload before transcribing.");
  if (asset.status === "failed") throw new CaptureError(409, asset.error || "The transcription needs review before retrying.");
  if (asset.status === "transcribing") {
    if (!asset.providerJobId) {
      if (asset.processingStartedAt && Date.now() - asset.processingStartedAt.getTime() > 180_000) throw new CaptureError(409, "The provider outcome is uncertain. Do not repeat this paid request; download the private upload before expiry and ask an administrator to check cleanup.");
      return;
    }
    const status = await speech.get(asset.providerJobId);
    if (status.status === "error") {
      await db.update(assets).set({ status: "failed", error: "The provider could not transcribe this recording. Download the private upload before expiry if needed." }).where(eq(assets.id, assetId));
      return;
    }
    if (status.status !== "completed") return;
    const durationLimit = asset.kind === "debrief" ? 180_000 : 2 * 60 * 60_000;
    const details = speech.transcriptDetails ? await speech.transcriptDetails(asset.providerJobId) : null;
    const transcript = status.audioDurationMs !== undefined && status.audioDurationMs > durationLimit ? "" : details?.text ?? await speech.transcript(asset.providerJobId);
    if (!transcript.trim() || transcript.length > 90000) {
      await db.update(assets).set({ status: "failed", error: "The recording exceeded the duration/review limit or returned no usable transcript. Remove it and use tutor notes." }).where(eq(assets.id, assetId));
      try { await removeProviderCopies(asset, speech, db); } catch { /* Retry durable deletion during retention. */ }
      throw new CaptureError(422, "No usable transcript was returned within the duration/review limit. Remove this audio and use tutor notes.");
    }
    // Cancellation or expiry while the provider was running must never resurrect content.
    await db.update(assets).set({ status: "transcribed", transcript, transcriptSegments: details ? transcriptSegments(details.tokens) : null, providerUncertain: false, error: null })
      .where(and(eq(assets.id, assetId), isNull(assets.discardedAt), eq(assets.status, "transcribing"), sql`exists (select 1 from class_captures c where c.id = ${assets.captureId} and c.deleted_at is null and c.expires_at > now())`));
    try { await removeProviderCopies(asset, speech, db); } catch { /* Durable IDs remain for the cleanup sweep. */ }
    return;
  }
  const claimed = await claimTranscription(assetId, db);
  if (!claimed) return;
  try {
    const bytes = await (deps.readBytes ?? readMediaBytes)(claimed);
    await validateMedia(bytes, claimed.mime);
    await captureForScope(scope, captureId, db);
    await assetForScope(scope, assetId, db);
    const reference = `bg-capture:${captureId}:${assetId}`;
    const fileId = await speech.upload(bytes, claimed.mime, reference);
    await db.update(assets).set({ providerFileId: fileId }).where(eq(assets.id, assetId));
    await captureForScope(scope, captureId, db);
    await assetForScope(scope, assetId, db);
    const jobId = await speech.create(fileId, reference);
    await db.update(assets).set({ providerJobId: jobId, providerUncertain: false }).where(eq(assets.id, assetId));
  } catch {
    await db.update(assets).set({ status: "failed", providerUncertain: true,
      error: "The provider outcome is uncertain. The private upload remains until expiry; this request will not be repeated automatically." }).where(eq(assets.id, assetId));
    throw new CaptureError(503, "The provider outcome is uncertain. Download the private upload before expiry if needed and ask an administrator to review cleanup.");
  }
}

type DraftInput = Parameters<typeof generateCaptureDraft>[0];
type DraftDeps = { db?: Database; generate?: (input: DraftInput) => Promise<DraftFields>; prior?: (scope: CaptureScope, session: CaptureSession) => Promise<Array<{ date: string; text: string }>> };
export async function draftCapture(scope: CaptureScope, id: string, deps: DraftDeps = {}) {
  const db = deps.db ?? getDb();
  const capture = await captureForScope(scope, id, db);
  if (capture.draft) return; // A duplicate click or lost response costs nothing again.
  const media = await db.select().from(assets).where(and(eq(assets.captureId, id), isNull(assets.discardedAt)));
  if (media.some(a => a.kind !== "worksheet" && a.status !== "transcribed")) throw new CaptureError(409, "Transcribe all selected audio before generating feedback.");
  if (!media.some(a => !!a.transcript) && !capture.tutorNotes.trim()) throw new CaptureError(400, "Add a transcript or tutor observations before drafting.");
  if (!availability().drafting) throw new CaptureError(503, "AI drafting needs approved OpenRouter access. You can still write and review the fields yourself.");
  const lease = new Date(Date.now() + 180_000);
  const [claimed] = await db.update(captures).set({ draftLeaseUntil: lease, draftAttempts: sql`${captures.draftAttempts} + 1` })
    .where(and(eq(captures.id, id), eq(captures.version, capture.version), isNull(captures.deletedAt), gt(captures.expiresAt, new Date()),
      sql`${captures.draftAttempts} < 3`, sql`(${captures.draftLeaseUntil} is null or ${captures.draftLeaseUntil} < now())`)).returning();
  if (!claimed) throw new CaptureError(409, "A draft is already running, this capture changed, or its three-attempt limit was reached. Reload to recover.");
  try {
    let prior: Array<{ date: string; text: string }> = [];
    // Prior feedback is optional context, never a fallback source of current-class evidence.
    try { prior = await (deps.prior ?? loadPriorFeedback)(scope, capture.session); } catch (error) {
      if (!(error instanceof CaptureError && (error.status === 503 || error.status === 404))) throw error;
    }
    const draft = await (deps.generate ?? generateCaptureDraft)({ topic: capture.topic, tutorNotes: capture.tutorNotes, assets: media, prior });
    const [saved] = await db.update(captures).set({ draft, reviewed: false, draftLeaseUntil: null, version: sql`${captures.version} + 1` })
      .where(and(eq(captures.id, id), eq(captures.version, capture.version), eq(captures.draftLeaseUntil, lease), isNull(captures.deletedAt), gt(captures.expiresAt, new Date()))).returning({ id: captures.id });
    if (!saved) throw new CaptureError(409, "This capture changed, expired or was deleted while drafting. Nothing was submitted.");
  } finally {
    await db.update(captures).set({ draftLeaseUntil: null }).where(and(eq(captures.id, id), eq(captures.draftLeaseUntil, lease)));
  }
}
