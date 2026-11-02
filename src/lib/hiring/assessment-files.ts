import { createHash } from "node:crypto";
import { del, get } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { HiringError, type Subject } from "./model";
import { cleanResumeName, sniffResume } from "./resume-files";
import { audit } from "./service";

export const MAX_ASSESSMENT_BYTES = 25 * 1024 * 1024;
const PDF = "application/pdf";
type FileKind = (typeof s.hiringAssessmentFiles.$inferSelect)["kind"];
const LIBRARY: FileKind[] = ["question_paper", "mark_scheme"];
export const assessmentPath = (id: string) => `hiring-assessment/${id}.pdf`;
// Only a stored path of this exact shape reaches storage.
const isStoredPath = (path: string, id: string) => path === assessmentPath(id) && /^[0-9a-f-]{36}$/.test(id);

/** Step 1 of an upload: a row that names the one path this file may use. */
export async function createFileIntent(
  input: { kind: FileKind; subject: Subject | null; candidateId: string | null; name: string; size: number },
  actor: string,
  db: Database,
) {
  if (input.size <= 0 || input.size > MAX_ASSESSMENT_BYTES) throw new HiringError(400, "Choose a PDF smaller than 25 MB.");
  if (!input.subject || (!LIBRARY.includes(input.kind) && !input.candidateId))
    throw new HiringError(400, "This file needs a subject or a candidate.");
  const id = crypto.randomUUID();
  const [file] = await db
    .insert(s.hiringAssessmentFiles)
    .values({
      id,
      kind: input.kind,
      subject: input.subject,
      candidateId: LIBRARY.includes(input.kind) ? null : input.candidateId,
      name: cleanResumeName(input.name, "pdf"),
      path: assessmentPath(id),
      size: input.size,
      uploadedBy: actor,
    })
    .returning();
  return { id: file.id, pathname: file.path };
}

/** Step 2: a short-lived browser token for that one path. There is no callback, because the browser finishes with step 3. */
export function assessmentUploadHandler(request: Request, body: HandleUploadBody, db: Database) {
  return handleUpload({
    request,
    body,
    onBeforeGenerateToken: async (pathname, payload) => {
      if (!payload || !/^[0-9a-f-]{36}$/.test(payload)) throw new HiringError(400, "Invalid upload.");
      const [file] = await db.select().from(s.hiringAssessmentFiles).where(eq(s.hiringAssessmentFiles.id, payload));
      if (!file || file.path !== pathname || file.status !== "pending") throw new HiringError(409, "This upload is not waiting. Start again.");
      return {
        allowedContentTypes: [PDF],
        maximumSizeInBytes: file.size,
        addRandomSuffix: false,
        allowOverwrite: false,
        validUntil: Date.now() + 5 * 60_000,
      };
    },
  });
}

export async function readAssessmentBytes(file: { id: string; path: string }, abortSignal?: AbortSignal) {
  if (!isStoredPath(file.path, file.id)) throw new HiringError(409, "The stored file record is not valid.");
  const blob = await get(file.path, { access: "private", useCache: false, abortSignal });
  if (!blob || blob.statusCode !== 200) throw new HiringError(404, "The file is gone from storage.");
  if (blob.blob.size > MAX_ASSESSMENT_BYTES) {
    await blob.stream.cancel();
    throw new HiringError(400, "The file is larger than 25 MB.");
  }
  return Buffer.from(await new Response(blob.stream).arrayBuffer());
}

async function resultIdOf(db: Database, file: typeof s.hiringAssessmentFiles.$inferSelect) {
  if (file.kind !== "paper_scan" && file.kind !== "mock_rubric") return null;
  const table = file.kind === "paper_scan" ? s.hiringPaperResults : s.hiringMockResults;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.fileId, file.id));
  return row?.id ?? null;
}

/** One result per candidate and subject. A new scan replaces the old marks, and the marking route runs next. */
async function attachPaperScan(tx: Database, file: typeof s.hiringAssessmentFiles.$inferSelect, actor: string) {
  const p = s.hiringPaperResults;
  const [existing] = await tx.select().from(p).where(and(eq(p.candidateId, file.candidateId!), eq(p.subject, file.subject!))).for("update");
  // A tracker result is the only copy of that past record.
  if (existing?.source === "tracker") throw new HiringError(409, "This subject has a past result from the tracker, so it was not replaced.");
  if (existing?.marks) await audit(tx, actor, "paper-marks-replaced", file.candidateId, { subject: file.subject, ai: existing.aiMarks, final: existing.marks });
  const [booking] = await tx
    .select({ id: s.hiringBookings.id })
    .from(s.hiringBookings)
    .where(and(eq(s.hiringBookings.candidateId, file.candidateId!), eq(s.hiringBookings.kind, "paper"), ne(s.hiringBookings.status, "cancelled")))
    .orderBy(desc(s.hiringBookings.startTime))
    .limit(1);
  const fresh = {
    bookingId: booking?.id ?? null,
    source: "ai" as const,
    status: "uploaded" as const,
    fileId: file.id,
    aiMarks: null,
    marks: null,
    markSchemeUsed: null,
    history: null,
    model: null,
    promptVersion: null,
    costUsd: null,
    costKnown: true,
    error: null,
    checkedBy: null,
    checkedAt: null,
    changedBy: null,
    changedAt: null,
    updatedAt: new Date(),
  };
  await tx
    .insert(s.hiringPaperResults)
    .values({ candidateId: file.candidateId!, subject: file.subject!, ...fresh })
    .onConflictDoUpdate({ target: [s.hiringPaperResults.candidateId, s.hiringPaperResults.subject], set: fresh });
}

/** One rubric per candidate and subject, on the same rules as a scan. */
async function attachMockRubric(tx: Database, file: typeof s.hiringAssessmentFiles.$inferSelect, actor: string) {
  const m = s.hiringMockResults;
  const [existing] = await tx.select().from(m).where(and(eq(m.candidateId, file.candidateId!), eq(m.subject, file.subject!))).for("update");
  if (existing?.source === "tracker") throw new HiringError(409, "This subject has a past result from the tracker, so it was not replaced.");
  if (existing?.rubric) await audit(tx, actor, "mock-rubric-replaced", file.candidateId, { subject: file.subject, ai: existing.aiRubric, final: existing.rubric });
  const [booking] = await tx
    .select({ id: s.hiringBookings.id })
    .from(s.hiringBookings)
    .where(and(eq(s.hiringBookings.candidateId, file.candidateId!), eq(s.hiringBookings.kind, "mock"), ne(s.hiringBookings.status, "cancelled")))
    .orderBy(desc(s.hiringBookings.startTime))
    .limit(1);
  const fresh = {
    bookingId: booking?.id ?? null,
    source: "ai" as const,
    status: "uploaded" as const,
    fileId: file.id,
    aiRubric: null,
    rubric: null,
    history: null,
    model: null,
    promptVersion: null,
    costUsd: null,
    costKnown: true,
    error: null,
    checkedBy: null,
    checkedAt: null,
    changedBy: null,
    changedAt: null,
    updatedAt: new Date(),
  };
  await tx
    .insert(m)
    .values({ candidateId: file.candidateId!, subject: file.subject!, ...fresh })
    .onConflictDoUpdate({ target: [m.candidateId, m.subject], set: fresh });
}

/**
 * Step 3: checks the stored bytes. The type comes from the bytes, never from the browser. A library file then replaces
 * the one in use for its subject and kind. The caller links a candidate's file to their result.
 */
export async function finishFile(id: string, actor: string, db: Database) {
  const [file] = await db.select().from(s.hiringAssessmentFiles).where(eq(s.hiringAssessmentFiles.id, id));
  if (!file) throw new HiringError(404, "File not found.");
  if (file.status === "ready") return { ...file, resultId: await resultIdOf(db, file) };
  const bytes = await readAssessmentBytes(file);
  const refusal =
    bytes.length !== file.size ? "The uploaded size differs from the file chosen." : sniffResume(bytes)?.type !== PDF ? "Only a PDF can be used here." : null;
  if (refusal) {
    // A refused file must not stay in storage with no way to reach it.
    await del(file.path, { abortSignal: AbortSignal.timeout(5000) });
    await db.delete(s.hiringAssessmentFiles).where(eq(s.hiringAssessmentFiles.id, id));
    throw new HiringError(400, refusal);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return withDatabaseTransaction(db, async (tx) => {
    // Two tabs replacing one file take turns, so the second replaces the first and nobody sees a database error.
    if (LIBRARY.includes(file.kind)) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-library'))`);
    if (LIBRARY.includes(file.kind))
      await tx
        .update(s.hiringAssessmentFiles)
        .set({ active: false })
        .where(and(eq(s.hiringAssessmentFiles.kind, file.kind), eq(s.hiringAssessmentFiles.subject, file.subject!), eq(s.hiringAssessmentFiles.active, true)));
    const [ready] = await tx
      .update(s.hiringAssessmentFiles)
      .set({ status: "ready", sha256, active: LIBRARY.includes(file.kind) })
      .where(eq(s.hiringAssessmentFiles.id, id))
      .returning();
    if (file.kind === "paper_scan") await attachPaperScan(tx, ready, actor);
    if (file.kind === "mock_rubric") await attachMockRubric(tx, ready, actor);
    await audit(tx, actor, "assessment-file", file.candidateId, { id, kind: file.kind, subject: file.subject, name: file.name });
    return { ...ready, resultId: await resultIdOf(tx, ready) };
  });
}
