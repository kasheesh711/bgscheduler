/** Explicit operator verification of the manual route; only labelled synthetic documents reach Wise. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import { put } from "@vercel/blob";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as s from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import type { Command } from "../src/lib/progress-tests/workspace/commands";
import { scopeForEmail } from "../src/lib/progress-tests/workspace/access";
import { executeCommand, getAssessment } from "../src/lib/progress-tests/workspace/data";
import { finalizeUpload, readBlobBytes } from "../src/lib/progress-tests/workspace/files";
import { claimJob, runJob } from "../src/lib/progress-tests/workspace/jobs";
import { fileHash } from "../src/lib/progress-tests/workspace/wise-publication";

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL, courseId = process.env.PT_VERIFICATION_COURSE_ID, studentId = process.env.PT_VERIFICATION_STUDENT_ID, envFile = process.env.PT_WISE_ENV_FILE;
  if (!databaseUrl || new URL(databaseUrl).hostname !== "localhost" || !new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Use a disposable localhost *_test database.");
  if (!process.argv.includes("--live-wise") || !envFile || courseId !== "6990f14e2f5bc252039abf3b" || studentId !== "696e2a2043579bbada1ff78f") throw new Error("Pass --live-wise, PT_WISE_ENV_FILE and the documented synthetic-validation course/student IDs.");
  const validation = parseEnv(await readFile(".env.local", "utf8")), production = parseEnv(await readFile(envFile, "utf8"));
  Object.assign(process.env, { WISE_USER_ID: production.WISE_USER_ID, WISE_API_KEY: production.WISE_API_KEY, WISE_NAMESPACE: production.WISE_NAMESPACE ?? "begifted-education", VERCEL: "", AWS_LAMBDA_FUNCTION_NAME: "", BLOB_READ_WRITE_TOKEN: validation.BLOB_READ_WRITE_TOKEN, DATABASE_URL: databaseUrl, PROGRESS_TEST_WORKSPACE_ENABLED: "true", OPENAI_API_KEY: "", OPENAI_PROGRESS_TEST_API_KEY: "" });
  const pool = new Pool({ connectionString: databaseUrl }), db = drizzle(pool, { schema: s }) as unknown as Database;
  try {
    const email = "original-publication-verification@example.test", owner = "original-publication-verification-20260914";
    await db.insert(s.tutorContacts).values({ canonicalKey: owner, displayName: "SYNTHETIC verification", onsiteEmail: email, active: true }).onConflictDoNothing();
    const scope = await scopeForEmail(email, db);
    await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: true, verifiedAt: new Date() });
    const [series] = await db.insert(s.ptSeries).values({ ownerKey: owner, wiseClassId: courseId, wiseStudentId: studentId, classType: "ONE_TO_ONE", studentName: "SYNTHETIC VALIDATION - no student results", courseName: "Original-paper technical verification", tutorName: "SYNTHETIC verification", count: 8, sessionIds: ["technical-validation-class"] }).onConflictDoUpdate({ target: [s.ptSeries.ownerKey, s.ptSeries.wiseClassId, s.ptSeries.wiseStudentId], set: { classType: "ONE_TO_ONE" } }).returning();
    let [assessment] = await db.insert(s.ptAssessments).values({ seriesId: series.id, cycle: 1 }).onConflictDoUpdate({ target: [s.ptAssessments.seriesId, s.ptAssessments.cycle], set: { updatedAt: new Date() } }).returning();
    const act = async (action: Record<string, unknown>) => {
      assessment = (await getAssessment(scope, assessment.id, db)).assessment;
      return executeCommand(scope, { ...action, id: assessment.id, expectedRevision: assessment.revision } as Command, db);
    };
    const runRequestedJob = async (id: string) => {
      const job = await claimJob(db, new Date(Date.now() + 120_000), id); assert(job); await runJob(job, db);
      const [done] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, id));
      assert.equal(done.status, "completed", done.error ?? "Processing incomplete");
    };
    const upload = async (purpose: "paper" | "work" | "marked", text: string[]) => {
      const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([595.28, 841.89]);
      ["SYNTHETIC VALIDATION - NO STUDENT RESULTS", "BeGifted original-paper release verification", ...text].forEach((line, i) => page.drawText(line, { x: 40, y: 790 - i * 35, size: i ? 12 : 16, font }));
      const bytes = Buffer.from(await pdf.save());
      const intent = await executeCommand(scope, { action: "upload-intent", purpose, assessmentId: assessment.id, name: `Synthetic ${purpose}.pdf`, mime: "application/pdf", size: bytes.length }, db);
      await put(intent.pathname!, bytes, { access: "private", contentType: "application/pdf", addRandomSuffix: false, allowOverwrite: false });
      await finalizeUpload(scope, intent.id!, db); return { id: intent.id!, hash: fileHash(bytes) };
    };
    if (!assessment.preparation.paperVersionId) {
      const original = await upload("paper", ["This technical paper is used only to validate file preservation.", "It contains no student assessment questions or results."]);
      const created = await executeCommand(scope, { action: "create-paper", title: "SYNTHETIC original-paper validation", assessmentId: assessment.id }, db);
      const version = await executeCommand(scope, { action: "attach-original", id: created.id!, expectedRevision: 0, sourceFileId: original.id, keyFileId: null }, db);
      await executeCommand(scope, { action: "approve-paper", id: created.id!, expectedRevision: version.revision!, versionId: version.versionId!, confirmed: true }, db);
      const preparation = await act({ action: "prepare", paperVersionId: version.versionId, topics: "Synthetic technical validation only", studentInformed: true });
      if (preparation.jobId) await runRequestedJob(preparation.jobId);
    }
    assessment = (await getAssessment(scope, assessment.id, db)).assessment;
    if (!assessment.currentSubmissionId) await act({ action: "submit", sessionId: "technical-validation-class", fileIds: [(await upload("work", ["Synthetic student-work placeholder; no real answers."])).id] });
    assessment = (await getAssessment(scope, assessment.id, db)).assessment;
    if (!assessment.currentReviewId) {
      const marked = await upload("marked", ["Tutor-marked technical placeholder only.", "Synthetic score: 4 / 5 (80%). This is not a student result.", "This exact PDF must be preserved in Wise publication."]);
      await act({ action: "save-marked-review", markedFileId: marked.id, earned: 4, possible: 5, report: { summary: "SYNTHETIC VALIDATION. No student results. Entered technical score: 4 / 5 (80%).", strengths: ["Byte preservation verified"], focusAreas: [], nextSteps: ["Verify both technical PDFs in Progress Tests Content."], contextLimitations: "No real student answers, marks or class feedback were used." } });
    }
    assessment = (await getAssessment(scope, assessment.id, db)).assessment;
    if (!assessment.approvedReviewId) {
      const [pending] = await db.select().from(s.ptJobs).where(and(eq(s.ptJobs.targetId, assessment.id), eq(s.ptJobs.kind, "render-review"), inArray(s.ptJobs.status, ["queued", "running"])));
      const preview = pending ? { jobId: pending.id } : await act({ action: "preview-review" }); await runRequestedJob(preview.jobId!);
      const approved = await act({ action: "approve", confirmed: true }); await runRequestedJob(approved.jobId!);
    } else {
      const result = await act({ action: "publish" }); if (result.jobId) await runRequestedJob(result.jobId);
    }
    assessment = (await getAssessment(scope, assessment.id, db)).assessment;
    assert.equal(assessment.publicationStatus, "published");
    const [review] = await db.select().from(s.ptReviews).where(eq(s.ptReviews.id, assessment.approvedReviewId!));
    const [publication] = await db.select().from(s.ptPublications).where(eq(s.ptPublications.reviewId, review.id));
    const files = await db.select().from(s.ptPublicationFiles).where(eq(s.ptPublicationFiles.publicationId, publication.id));
    assert.equal(files.length, 2); assert(files.every(file => file.status === "verified"));
    assert("markedSha256" in review.data); assert.equal(files.find(file => file.kind === "graded")!.sha256, review.data.markedSha256);
    const out = "output/progress-tests-verification/original-release"; await mkdir(out, { recursive: true });
    for (const file of files) {
      const [stored] = await db.select().from(s.ptFiles).where(eq(s.ptFiles.id, file.fileId));
      const bytes = await readBlobBytes(stored); assert.equal(fileHash(bytes), file.sha256);
      await writeFile(`${out}/${file.kind}.pdf`, bytes, { mode: 0o600 });
    }
    const evidence = { verifiedAt: new Date(), courseId, studentId, assessmentId: assessment.id, publicationId: publication.id, sectionId: publication.sectionId, paidAiRequests: 0, status: publication.status, files: files.map(file => ({ kind: file.kind, sha256: file.sha256, resourceId: file.resourceId, wiseFileId: file.wiseFileId, status: file.status })) };
    await writeFile(`${out}/native-publication.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });
