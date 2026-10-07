import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { classCaptures as captures, classCaptureAssets as assets } from "@/lib/db/schema";
import { CAPTURE_RETENTION_MS, CaptureError, MAX_AUDIO_BYTES, assertCaptureScope, assertCaptureSessionToday, assetInputSchema, createCaptureSchema, patchCaptureSchema, type CaptureAsset, type CaptureScope, type CaptureSession, type CaptureView } from "./model";
import type { z } from "zod";

export type StoredCapture = typeof captures.$inferSelect;
export type StoredAsset = typeof assets.$inferSelect;

export async function captureForScope(scope: CaptureScope, id: string, db: Database = getDb(), deleting = false): Promise<StoredCapture> {
  assertCaptureScope(scope);
  const [row] = await db.select().from(captures).where(and(eq(captures.id, id), eq(captures.createdByEmail, scope.email), eq(captures.teacherKey, scope.keys[0]))).limit(1);
  if (!row || row.createdByEmail !== scope.email || row.teacherKey !== scope.keys[0] || row.session.teacherKey !== scope.keys[0]) throw new CaptureError(404, "Capture not found.");
  if (!deleting && row.deletedAt) throw new CaptureError(410, "This capture was deleted.");
  if (!deleting && row.expiresAt.getTime() <= Date.now()) throw new CaptureError(410, "This capture expired after 24 hours.");
  return row;
}
export function projectAsset(row: StoredAsset): CaptureAsset {
  return { id: row.id, kind: row.kind, mime: row.mime, size: row.size, pathname: row.pathname, status: row.status, transcript: row.transcript, error: row.error };
}
export async function captureView(scope: CaptureScope, id: string, db: Database = getDb()): Promise<CaptureView> {
  const row = await captureForScope(scope, id, db);
  const media = await db.select().from(assets).where(and(eq(assets.captureId, id), isNull(assets.discardedAt))).orderBy(assets.createdAt, assets.id);
  return { id, session: row.session, topic: row.topic, tutorNotes: row.tutorNotes, consent: row.consent,
    assets: media.map(projectAsset), draft: row.draft, reviewed: row.reviewed, expiresAt: row.expiresAt.toISOString(), version: row.version };
}
export async function createCapture(scope: CaptureScope, raw: z.infer<typeof createCaptureSchema>, session: CaptureSession, db: Database = getDb()) {
  assertCaptureScope(scope, session.teacherKey);
  const input = createCaptureSchema.parse(raw);
  if (input.sessionId !== session.sessionId || input.studentId !== session.studentId) throw new CaptureError(403, "This class is not assigned to you.");
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`capture:${scope.email}`}))`);
    const [existing] = await tx.select().from(captures).where(eq(captures.id, input.id));
    if (existing) {
      await captureForScope(scope, existing.id, tx);
      if (existing.session.sessionId !== input.sessionId || existing.session.studentId !== input.studentId) throw new CaptureError(409, "This identifier belongs to a different class.");
      return existing.id;
    }
    const recent = await tx.select().from(captures).where(and(eq(captures.createdByEmail, scope.email), gt(captures.createdAt, new Date(Date.now() - CAPTURE_RETENTION_MS))));
    // Bounds storage/spend even if a browser invents many new intent IDs.
    if (recent.length >= 10) throw new CaptureError(429, "You have reached the daily limit of 10 class captures.");
    const same = recent.find(r => r.createdByEmail === scope.email && r.teacherKey === scope.keys[0] && r.session.teacherKey === scope.keys[0] && !r.deletedAt && r.expiresAt.getTime() > Date.now() && r.session.sessionId === input.sessionId && r.session.studentId === input.studentId);
    if (same) return same.id;
    // Recheck after awaited lookup/locking: a request started before midnight
    // may recover an existing capture, but cannot insert yesterday's class.
    assertCaptureSessionToday(session);
    await tx.insert(captures).values({ id: input.id, createdByEmail: scope.email, teacherKey: session.teacherKey, session,
      topic: input.topic, consent: input.consent, expiresAt: new Date(Date.now() + CAPTURE_RETENTION_MS) });
    return input.id;
  });
}
export async function updateCapture(scope: CaptureScope, id: string, raw: z.infer<typeof patchCaptureSchema>, db: Database = getDb()) {
  assertCaptureScope(scope);
  const input = patchCaptureSchema.parse(raw);
  const current = await captureForScope(scope, id, db);
  const changedEvidence = current.topic !== input.topic || current.tutorNotes !== input.tutorNotes;
  const draft = input.resetDraft ? null : input.fields ?? (changedEvidence ? null : current.draft);
  if (input.reviewed && !draft) throw new CaptureError(400, "Review the feedback fields before marking them checked.");
  const [updated] = await db.update(captures).set({ topic: input.topic, tutorNotes: input.tutorNotes, draft,
    reviewed: input.reviewed === true && !!draft, version: sql`${captures.version} + 1` })
    .where(and(eq(captures.id, id), eq(captures.version, input.version), isNull(captures.deletedAt), gt(captures.expiresAt, new Date()),
      sql`(${captures.draftLeaseUntil} is null or ${captures.draftLeaseUntil} < now())`)).returning({ id: captures.id });
  if (!updated) throw new CaptureError(409, "This capture changed or is drafting. Reload before saving.");
}
export async function createAsset(scope: CaptureScope, captureId: string, raw: z.infer<typeof assetInputSchema>, db: Database = getDb()): Promise<CaptureAsset> {
  assertCaptureScope(scope);
  const input = assetInputSchema.parse(raw);
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select id from class_captures where id = ${captureId} for update`);
    const capture = await captureForScope(scope, captureId, tx);
    if (capture.draftLeaseUntil && capture.draftLeaseUntil.getTime() > Date.now()) throw new CaptureError(409, "Wait for the draft before adding evidence.");
    const [existing] = await tx.select().from(assets).where(eq(assets.id, input.id));
    if (existing) {
      if (existing.discardedAt) throw new CaptureError(409, "This evidence was removed. Select a new file to try again.");
      if (existing.captureId !== captureId || existing.kind !== input.kind || existing.mime !== input.mime || existing.size !== input.size) throw new CaptureError(409, "This upload identifier has different metadata.");
      return projectAsset(existing);
    }
    // Photos are intentionally uncapped by count; their individual size/pixel
    // limits and retention still apply. Audio keeps its lifetime spend bounds.
    if (input.kind !== "worksheet") {
      const audio = await tx.select().from(assets).where(and(eq(assets.captureId, captureId), ne(assets.kind, "worksheet")));
      if (audio.length >= 20 || audio.reduce((n, a) => n + a.size, input.size) > 2 * MAX_AUDIO_BYTES) throw new CaptureError(429, "This capture has reached its lifetime audio upload limit (20 files / 200 MB).");
      const same = audio.filter(a => !a.discardedAt && a.kind === input.kind);
      const maxCount = input.kind === "debrief" ? 1 : 8;
      if (same.length >= maxCount || (input.kind === "recording" && same.reduce((n, a) => n + a.size, input.size) > MAX_AUDIO_BYTES)) throw new CaptureError(400, "This capture has reached its audio evidence limit.");
    }
    const [row] = await tx.insert(assets).values({ ...input, captureId, pathname: `class-capture/${captureId}/${input.id}` }).returning();
    await tx.update(captures).set({ draft: null, reviewed: false, version: sql`${captures.version} + 1` }).where(eq(captures.id, captureId));
    return projectAsset(row);
  });
}
export async function assetForScope(scope: CaptureScope, id: string, db: Database = getDb()) {
  assertCaptureScope(scope);
  const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!row || row.discardedAt) throw new CaptureError(404, "Evidence not found.");
  await captureForScope(scope, row.captureId, db);
  return row;
}
export async function claimTranscription(id: string, db: Database = getDb()) {
  const [row] = await db.update(assets).set({ status: "transcribing", processingStartedAt: new Date(), providerUncertain: true, error: null })
    .where(and(eq(assets.id, id), isNull(assets.discardedAt), eq(assets.status, "ready"), sql`exists (select 1 from class_captures c where c.id = ${assets.captureId} and c.deleted_at is null and c.expires_at > now())`)).returning();
  return row ?? null;
}
export async function markDeleted(scope: CaptureScope, id: string, db: Database = getDb()) {
  await captureForScope(scope, id, db, true);
  await db.update(captures).set({ deletedAt: new Date(), draft: null, tutorNotes: "", topic: "", reviewed: false, version: sql`${captures.version} + 1` }).where(eq(captures.id, id));
  await db.update(assets).set({ transcript: null }).where(eq(assets.captureId, id));
}
export async function discardAsset(scope: CaptureScope, captureId: string, assetId: string, db: Database = getDb()) {
  await captureForScope(scope, captureId, db);
  const [asset] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.captureId, captureId)));
  if (!asset) throw new CaptureError(404, "Evidence not found in this class.");
  await withDatabaseTransaction(db, async tx => {
    await tx.update(assets).set({ discardedAt: new Date(), transcript: null }).where(eq(assets.id, assetId));
    await tx.update(captures).set({ draft: null, reviewed: false, cleanupAttemptedAt: null, version: sql`${captures.version} + 1` }).where(eq(captures.id, captureId));
  });
}
