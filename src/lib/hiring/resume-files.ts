import { createHash } from "node:crypto";
import { del, list } from "@vercel/blob";
import { put } from "@vercel/blob/client";
import { subMonths } from "date-fns";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
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

/** For the import: a failed upload must not stop it. The text is already saved, and a later pass can store the file. */
export async function keepResume(candidateId: string, file: ResumeFile, db: Database) {
  try {
    await storeResume(candidateId, file, db);
    return true;
  } catch (error) {
    console.error("Hiring résumé file not stored", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

// Each file takes up to two storage calls of 5 seconds, so the time budget ends a slow run before the 60-second limit.
const RETENTION_BATCH = 50;
const RETENTION_BUDGET_MS = 45000;
/**
 * Deletes original files with no candidate activity for `months`, oldest first. Only the file goes: the extracted text
 * stays, and `resume_stored_at` stays as the mark that the panel reads.
 *
 * Activity is the latest of the stored time, the pre-screen reply, a confirmed booking's end, and the newest audit row
 * that is not from an automatic pass. `updated_at` is not used, because automatic passes write it. When no activity
 * value exists the comparison is null, and the file stays.
 */
export async function deleteExpiredResumes(db: Database, now: Date, months: number) {
  if (!runtimeWritesAllowed()) return 0;
  const c = s.hiringCandidates;
  const activity = sql`greatest(
    ${c.resumeStoredAt},
    ${c.preScreenRepliedAt},
    (select max(${s.hiringBookings.endTime}) from ${s.hiringBookings}
      where ${s.hiringBookings.candidateId} = ${c.id} and ${s.hiringBookings.status} = 'confirmed'),
    (select max(${s.hiringAudit.createdAt}) from ${s.hiringAudit}
      where ${s.hiringAudit.candidateId} = ${c.id}
        and ${s.hiringAudit.actor} not in ('subscription-assessment', 'hiring-worker', 'hiring-backfill'))
  )`;
  const rows = await db
    .select({ id: c.id, path: c.resumePath, type: c.resumeType })
    .from(c)
    .where(and(isNotNull(c.resumePath), sql`${activity} < ${subMonths(now, months).toISOString()}::timestamptz`))
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
      // A replaced file stays in storage under the same folder, and it must not outlive this one.
      const { blobs } = await list({ prefix: `hiring-resumes/${row.id}/`, abortSignal: AbortSignal.timeout(5000) });
      await del([...new Set([stored.path, ...blobs.map((blob) => blob.pathname)])], {
        abortSignal: AbortSignal.timeout(5000),
      });
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
  await audit(db, "resume-retention", "resume-retention", null, { deleted, failed });
  if (failed)
    throw new HiringError(503, `${failed} résumé file${failed === 1 ? "" : "s"} could not be deleted. The next run tries again.`);
  return deleted;
}

/** The cron and the Data Health Run button use the saved number of months. */
export async function runResumeRetention(db: Database = getDb(), now = new Date()) {
  const { config } = await settings(db);
  return deleteExpiredResumes(db, now, config.resumeRetentionMonths);
}
