import { del } from "@vercel/blob";
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { classCaptures as captures, classCaptureAssets as assets } from "@/lib/db/schema";
import { CAPTURE_RETENTION_MS, CaptureError } from "./model";
import { createCaptureSpeechClient } from "./providers";
import { removeProviderCopies } from "./processing";

const pending = () => new CaptureError(503, "Evidence cleanup is pending and will retry on the next sweep.");
const budgetLeft = (deadline: number) => { if (Date.now() >= deadline) throw pending(); };

/** Logical deletion is immediate. Physical deletion is retryable and never silently declared complete. */
export async function cleanupCapture(id: string, db: Database = getDb(), deadline = Date.now() + 10_000) {
  const [capture] = await db.select().from(captures).where(eq(captures.id, id));
  if (!capture) return { purged: true };
  const purgeAll = !!capture.deletedAt || capture.expiresAt.getTime() <= Date.now();
  budgetLeft(deadline);
  await db.update(captures).set({ cleanupAttemptedAt: new Date() }).where(eq(captures.id, id));
  const rows = await db.select().from(assets).where(eq(assets.captureId, id))
    .orderBy(sql`${assets.cleanupAttemptedAt} asc nulls first`, assets.createdAt);
  const speech = process.env.SONIOX_API_KEY ? createCaptureSpeechClient(process.env.SONIOX_API_KEY, fetch, { deadlineMs: deadline }) : null;
  let failed = false;
  for (const row of rows) {
    const removeMedia = purgeAll || !!row.discardedAt;
    if (!removeMedia && row.status !== "transcribed") continue;
    if (!removeMedia && !row.providerJobId && !row.providerFileId) continue;
    budgetLeft(deadline);
    await db.update(assets).set({ cleanupAttemptedAt: new Date() }).where(eq(assets.id, row.id));
    try {
      if (removeMedia) {
        if (!process.env.BLOB_READ_WRITE_TOKEN) throw pending();
        budgetLeft(deadline);
        await del(row.pathname, { abortSignal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))) });
        await db.update(assets).set({ transcript: null }).where(eq(assets.id, row.id));
      }
      if (row.providerJobId || row.providerFileId) {
        if (!speech) throw pending();
        await removeProviderCopies(row, speech, db);
      }
      // An upload/create may have succeeded without returning its ID. Only a
      // successful complete orphan scan can resolve that uncertainty later.
      if (removeMedia && row.providerUncertain) failed = true;
    } catch { failed = true; }
  }
  if (purgeAll) {
    await db.update(assets).set({ transcript: null }).where(eq(assets.captureId, id));
    await db.update(captures).set({ draft: null, tutorNotes: "", topic: "", reviewed: false }).where(eq(captures.id, id));
  }
  // Repeat blob deletion while upload tokens/in-flight writes may still finish.
  // Retain cancelled captures through their original expiry plus one hour.
  const purged = purgeAll && !failed && capture.expiresAt.getTime() + 60 * 60_000 < Date.now();
  if (purged) await db.delete(captures).where(eq(captures.id, id));
  if (failed) throw pending();
  return { purged };
}

/** Independent switch stays on after capture is paused. Bounded to 90s beside the existing cron. */
export async function cleanupClassCaptures(db?: Database) {
  if (process.env.CLASS_CAPTURE_RETENTION_ENABLED !== "true") return { enabled: false, ok: true, cleaned: 0, failed: 0, deferred: 0 };
  const database = db ?? getDb();
  const deadline = Date.now() + 90_000;
  let failed = 0;
  const cutoff = new Date(Date.now() - CAPTURE_RETENTION_MS);
  if (process.env.SONIOX_API_KEY) {
    try {
      const speech = createCaptureSpeechClient(process.env.SONIOX_API_KEY, fetch, { deadlineMs: deadline });
      await speech.reapOrphans(cutoff);
      // Allow the original request to finish before relying on the older-than-24h scan.
      await database.update(assets).set({ providerUncertain: false }).where(and(eq(assets.providerUncertain, true),
        lt(assets.processingStartedAt, new Date(cutoff.getTime() - 180_000))));
    } catch { failed += 1; }
  } else {
    const uncertain = await database.select({ id: assets.id }).from(assets).where(eq(assets.providerUncertain, true)).limit(1);
    if (uncertain.length) failed += 1;
  }
  // Cooldown avoids repeatedly visiting already-clean tombstones. Both capture
  // and asset ordering rotate failures, including large partial captures.
  const rows = await database.select({ id: captures.id }).from(captures).where(and(
    sql`(${captures.cleanupAttemptedAt} is null or ${captures.cleanupAttemptedAt} < now() - interval '15 minutes')`,
    or(isNotNull(captures.deletedAt), lt(captures.expiresAt, new Date()),
      sql`exists (select 1 from class_capture_assets a where a.capture_id = ${captures.id} and
        (a.discarded_at is not null or (a.status = 'transcribed' and (a.provider_job_id is not null or a.provider_file_id is not null))))`,
    ),
  )).orderBy(sql`${captures.cleanupAttemptedAt} asc nulls first`, captures.expiresAt).limit(26);
  let cleaned = 0;
  let attempted = 0;
  for (const row of rows.slice(0, 25)) {
    if (Date.now() >= deadline) break;
    attempted += 1;
    try { await cleanupCapture(row.id, database, deadline); cleaned += 1; } catch { failed += 1; }
  }
  const deferred = rows.length - attempted;
  return { enabled: true, ok: failed === 0 && deferred === 0, cleaned, failed, deferred };
}
