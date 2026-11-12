import { createHash } from "node:crypto";
import { del, get, list } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { subMonths } from "date-fns";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { requestResumeUploadToken } from "./dispatch";
import { HiringError, RESUME_TYPES, runtimeWritesAllowed, type ResumeExtension } from "./model";
import { audit, settings } from "./service";

export const RESUME_MAX_BYTES = 15 * 1024 * 1024;
export type ResumeFile = { bytes: Buffer; name: string };

/** True when the ZIP's central directory, which readers of the file use, lists this exact entry. */
function zipHolds(bytes: Buffer, entry: string) {
  const end = bytes.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (end < 0 || end + 22 > bytes.length) return false;
  let offset = bytes.readUInt32LE(end + 16);
  for (let left = bytes.readUInt16LE(end + 10); left > 0; left--) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
    const nameLength = bytes.readUInt16LE(offset + 28);
    if (bytes.toString("latin1", offset + 46, offset + 46 + nameLength) === entry) return true;
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return false;
}

/** The type comes from file bytes only. The old binary .doc is refused, as the text extractor refuses it. */
export function sniffResume(bytes: Buffer): { type: (typeof RESUME_TYPES)[ResumeExtension]; extension: ResumeExtension } | null {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return { type: RESUME_TYPES.pdf, extension: "pdf" };
  if (bytes.subarray(0, 4).toString("latin1") === "PK\x03\x04" && zipHolds(bytes, "word/document.xml"))
    return { type: RESUME_TYPES.docx, extension: "docx" };
  return null;
}

export const resumePath = (candidateId: string, sha256: string, extension: string) =>
  `hiring-resumes/${candidateId}/${sha256}.${extension}`;

/** Checks a stored record before any storage call: the exact pattern for this candidate, and a type that agrees with it. */
export function storedResume(candidateId: string, path: string | null, type: string | null) {
  const extension = /^hiring-resumes\/([0-9a-f-]{36})\/[0-9a-f]{64}\.(pdf|docx)$/.exec(path ?? "");
  if (!path || extension?.[1] !== candidateId) return null;
  const ext = extension[2] as ResumeExtension;
  if (RESUME_TYPES[ext] !== type) return null;
  return { path, extension: ext, type: RESUME_TYPES[ext] };
}

const GONE = "The original résumé file is gone from storage. The extracted text stays in this panel.";
/**
 * The stored original as a response. The admin route and the interviewer's link both use it, so the headers cannot differ.
 * The caller decides who may ask. It reads only the stored path.
 */
export async function resumeResponse(candidateId: string, db: Database = getDb()) {
  const c = s.hiringCandidates;
  const [row] = await db
    .select({ path: c.resumePath, name: c.resumeName, type: c.resumeType, storedAt: c.resumeStoredAt })
    .from(c)
    .where(eq(c.id, candidateId));
  if (!row) throw new HiringError(404, "Candidate not found.");
  if (!row.path)
    throw new HiringError(
      404,
      row.storedAt
        ? "The original résumé was deleted by the retention rule. The extracted text stays in this panel."
        : "No original résumé file is stored for this candidate.",
    );
  const stored = storedResume(candidateId, row.path, row.type);
  if (!stored) throw new HiringError(409, "The stored résumé record is not valid, so the file was not opened.");
  const blob = await get(stored.path, { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) throw new HiringError(404, GONE);
  const name = encodeURIComponent(cleanResumeName(row.name ?? "", stored.extension)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Response(blob.stream, {
    headers: {
      "Content-Type": stored.type,
      "Content-Length": String(blob.blob.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
      "Content-Disposition": `${stored.extension === "pdf" ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
    },
  });
}

/** A name safe for display and for a header: no controls, quotes or path parts, and the extension from the true type. */
export function cleanResumeName(name: string, extension: ResumeExtension) {
  const base = name
    .replace(/\p{C}|["'`]/gu, "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]*$/, "")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return `${[...base].slice(0, 120).join("") || "resume"}.${extension}`;
}

/**
 * Stores the original file. It does not change the revision or `updated_at`, so an upload cannot void a person's decision.
 * A file with the same sha that is already stored is not uploaded again.
 */
export async function storeResume(candidateId: string, file: ResumeFile, db: Database) {
  if (file.bytes.length > RESUME_MAX_BYTES) throw new Error("Resume exceeds the 15 MB import limit.");
  const kind = sniffResume(file.bytes);
  if (!kind) throw new Error("The resume is not a supported PDF or Word document.");
  const c = s.hiringCandidates;
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const [row] = await db
    .select({ resumePath: c.resumePath, resumeSha256: c.resumeSha256 })
    .from(c)
    .where(eq(c.id, candidateId));
  if (!row) throw new Error("Candidate not found.");
  if (row.resumePath && row.resumeSha256 === sha256) return;
  const pathname = resumePath(candidateId, sha256, kind.extension);
  const token = await requestResumeUploadToken({ candidateId, sha256, extension: kind.extension });
  await put(pathname, file.bytes, {
    access: "private",
    token,
    contentType: kind.type,
    abortSignal: AbortSignal.timeout(120000),
  });
  await db
    .update(c)
    .set({
      resumePath: pathname,
      resumeName: cleanResumeName(file.name, kind.extension),
      resumeType: kind.type,
      resumeSha256: sha256,
      resumeSize: file.bytes.length,
      resumeStoredAt: new Date(),
    })
    .where(eq(c.id, candidateId));
}

/** For the worker's import: a failed upload must not stop it. The text is already saved, and a later pass can store the file. The backfill calls `storeResume` itself and records the failure. */
export async function keepResume(candidateId: string, file: ResumeFile, db: Database) {
  try {
    await storeResume(candidateId, file, db);
    return true;
  } catch (error) {
    console.error("Hiring résumé file not stored", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

/**
 * Stored files that no candidate row points to, counted by the nightly job because the Mac holds no Blob key. Nothing is
 * deleted. Null when the folder is larger than five pages, so the count is unknown rather than wrong.
 */
export async function countOrphanResumes(db: Database) {
  const known = new Set(
    (await db.select({ path: s.hiringCandidates.resumePath }).from(s.hiringCandidates).where(isNotNull(s.hiringCandidates.resumePath)))
      .map((r) => r.path),
  );
  let orphans = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await list({ prefix: "hiring-resumes/", cursor, limit: 1000, abortSignal: AbortSignal.timeout(4000) });
    orphans += result.blobs.filter((blob) => !known.has(blob.pathname)).length;
    if (!result.hasMore) return orphans;
    cursor = result.cursor;
  }
  return null;
}

const f = s.hiringAssessmentFiles;
const candidateActivity = sql`greatest(
  ${s.hiringCandidates.resumeStoredAt},
  ${s.hiringCandidates.preScreenRepliedAt},
  (select max(${s.hiringBookings.endTime}) from ${s.hiringBookings}
    where ${s.hiringBookings.candidateId} = ${s.hiringCandidates.id} and ${s.hiringBookings.status} = 'confirmed'),
  (select max(${s.hiringAudit.createdAt}) from ${s.hiringAudit}
    where ${s.hiringAudit.candidateId} = ${s.hiringCandidates.id}
      and ${s.hiringAudit.actor} not in ('subscription-assessment', 'hiring-worker', 'hiring-backfill'))
)`;
// Each file takes up to two storage calls of 5 seconds, so the time budget ends a slow run before the 60-second limit.
const RETENTION_BATCH = 50;
const RETENTION_BUDGET_MS = 45000;
/**
 * Deletes original files with no candidate activity for `months`, oldest first. Only the file goes: the extracted text
 * stays, and `resume_stored_at` stays as the mark that the panel reads.
 *
 * Activity is the latest of the stored time, the pre-screen reply, a confirmed booking's end, and the newest audit row
 * that is not from an automatic pass. `updated_at` is not used, because automatic passes write it. When no activity
 * value exists the comparison is null, and the file stays. Activity is read again just before each delete, because the
 * batch can be up to a minute old, and a file uploaded after the cutoff belongs to a newer import, so it stays.
 */
export async function deleteExpiredResumes(
  db: Database,
  now: Date,
  months: number,
  // The cron passes the orphan count, so its audit row carries it. A failed count is recorded as null and never fails the run.
  countOrphans?: () => Promise<number | null>,
) {
  if (!runtimeWritesAllowed()) return 0;
  const c = s.hiringCandidates;
  const cutoff = subMonths(now, months);
  const expired = sql`${candidateActivity} < ${cutoff.toISOString()}::timestamptz`;
  const rows = await db
    .select({ id: c.id, path: c.resumePath, type: c.resumeType })
    .from(c)
    .where(and(isNotNull(c.resumePath), expired))
    .orderBy(asc(c.resumeStoredAt))
    .limit(RETENTION_BATCH);
  const stopAt = Date.now() + RETENTION_BUDGET_MS;
  let deleted = 0,
    failed = 0;
  for (const row of rows) {
    if (Date.now() >= stopAt) break;
    const stored = storedResume(row.id, row.path, row.type);
    if (!stored) {
      failed++;
      continue;
    }
    try {
      const [still] = await db
        .select({ id: c.id })
        .from(c)
        .where(and(eq(c.id, row.id), eq(c.resumePath, stored.path), expired));
      if (!still) continue;
      // A replaced file stays in storage under the same folder, and it must not outlive this one.
      const { blobs } = await list({ prefix: `hiring-resumes/${row.id}/`, abortSignal: AbortSignal.timeout(5000) });
      if (blobs.some((blob) => blob.pathname === stored.path && blob.uploadedAt >= cutoff)) continue;
      const old = blobs.filter((blob) => blob.uploadedAt < cutoff).map((blob) => blob.pathname);
      if (old.length) await del(old, { abortSignal: AbortSignal.timeout(5000) });
      const cleared = await db
        .update(c)
        .set({ resumePath: null, resumeName: null, resumeType: null, resumeSha256: null, resumeSize: null })
        .where(and(eq(c.id, row.id), eq(c.resumePath, stored.path)))
        .returning({ id: c.id });
      deleted += cleared.length;
    } catch (error) {
      failed++;
      console.error("Hiring résumé retention failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  const orphans = countOrphans ? await countOrphans().catch(() => null) : undefined;
  await audit(db, "resume-retention", "resume-retention", null, { deleted, failed, ...(countOrphans ? { orphans } : {}) });
  if (failed)
    throw new HiringError(503, `${failed} résumé file${failed === 1 ? "" : "s"} could not be deleted. The next run tries again.`);
  return deleted;
}

/**
 * Scanned papers and mock rubrics follow the résumé rule: no activity for `months`, oldest first. The marks stay, and a
 * result's file link clears by itself when its row goes.
 */
export async function deleteExpiredAssessmentFiles(db: Database, now: Date, months: number) {
  if (!runtimeWritesAllowed()) return 0;
  const cutoff = subMonths(now, months);
  const rows = await db
    .select({ id: f.id, path: f.path })
    .from(f)
    .innerJoin(s.hiringCandidates, eq(f.candidateId, s.hiringCandidates.id))
    .where(and(lt(f.createdAt, cutoff), sql`${candidateActivity} < ${cutoff.toISOString()}::timestamptz`))
    .orderBy(asc(f.createdAt))
    .limit(RETENTION_BATCH);
  if (!rows.length) return 0;
  await del(rows.map((row) => row.path), { abortSignal: AbortSignal.timeout(5000) });
  await db.delete(f).where(inArray(f.id, rows.map((row) => row.id)));
  await audit(db, "resume-retention", "assessment-file-retention", null, { deleted: rows.length });
  return rows.length;
}

/** The cron and the Data Health Run button use the saved number of months. */
export async function runResumeRetention(db: Database = getDb(), now = new Date()) {
  const { config } = await settings(db);
  // A storage problem with these files must not stop the résumé run.
  let filesFailed = false;
  await deleteExpiredAssessmentFiles(db, now, config.resumeRetentionMonths).catch((error) => {
    filesFailed = true;
    console.error("Hiring file retention failed", error instanceof Error ? error.name : "UnknownError");
  });
  const deleted = await deleteExpiredResumes(db, now, config.resumeRetentionMonths, () => countOrphanResumes(db));
  if (filesFailed) throw new HiringError(503, "Some paper or mock files could not be deleted. The next run tries again.");
  return deleted;
}
