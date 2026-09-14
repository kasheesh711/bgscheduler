/** Explicit native upload → replacement → removal verification using only labelled synthetic PDFs. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, desc, eq } from "drizzle-orm";
import { put } from "@vercel/blob";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as s from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import type { Command } from "../src/lib/progress-tests/workspace/commands";
import { scopeForEmail } from "../src/lib/progress-tests/workspace/access";
import { executeCommand, getAssessment } from "../src/lib/progress-tests/workspace/data";
import { finalizeUpload } from "../src/lib/progress-tests/workspace/files";
import { claimJob, runJob } from "../src/lib/progress-tests/workspace/jobs";
import { nativeWise, type WiseSection } from "../src/lib/progress-tests/workspace/wise-publication";

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL, envFile = process.env.PT_WISE_ENV_FILE;
  if (!databaseUrl || new URL(databaseUrl).hostname !== "localhost" || !new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Use a disposable localhost *_test database.");
  const courseId = "6990f14e2f5bc252039abf3b", studentId = "696e2a2043579bbada1ff78f", sectionId = "6aa6843f7239362dd4959a26";
  if (!process.argv.includes("--live-wise") || !envFile) throw new Error("Pass --live-wise and PT_WISE_ENV_FILE for the documented synthetic-validation course.");
  const validation = parseEnv(await readFile(".env.local", "utf8")), production = parseEnv(await readFile(envFile, "utf8"));
  assert(validation.BLOB_READ_WRITE_TOKEN && production.WISE_USER_ID && production.WISE_API_KEY);
  Object.assign(process.env, { WISE_USER_ID: production.WISE_USER_ID, WISE_API_KEY: production.WISE_API_KEY, WISE_NAMESPACE: production.WISE_NAMESPACE ?? "begifted-education", VERCEL: "", AWS_LAMBDA_FUNCTION_NAME: "", BLOB_READ_WRITE_TOKEN: validation.BLOB_READ_WRITE_TOKEN, DATABASE_URL: databaseUrl, PROGRESS_TEST_WORKSPACE_ENABLED: "true", OPENAI_API_KEY: "", OPENAI_PROGRESS_TEST_API_KEY: "" });
  const pool = new Pool({ connectionString: databaseUrl }), nativeDb = drizzle(pool, { schema: s }), db = nativeDb as unknown as Database;
  try {
    await migrate(nativeDb, { migrationsFolder: "drizzle" });
    const email = "preparation-verification@example.test", owner = "preparation-verification-20260914";
    await db.insert(s.tutorContacts).values({ canonicalKey: owner, displayName: "SYNTHETIC verification", onsiteEmail: email, active: true }).onConflictDoNothing();
    const scope = await scopeForEmail(email, db);
    await db.update(s.ptWorkspaceSettings).set({ publishingEnabled: true, verifiedAt: new Date() });
    const [series] = await db.insert(s.ptSeries).values({ ownerKey: owner, wiseClassId: courseId, wiseStudentId: studentId, classType: "ONE_TO_ONE", studentName: "SYNTHETIC VALIDATION", courseName: "Preparation publication verification", tutorName: "SYNTHETIC verification", count: 8, sessionIds: ["technical-validation-class"] }).onConflictDoUpdate({ target: [s.ptSeries.ownerKey, s.ptSeries.wiseClassId, s.ptSeries.wiseStudentId], set: { classType: "ONE_TO_ONE" } }).returning();
    const [assessment] = await db.insert(s.ptAssessments).values({ seriesId: series.id, cycle: 1 }).onConflictDoUpdate({ target: [s.ptAssessments.seriesId, s.ptAssessments.cycle], set: { updatedAt: new Date() } }).returning();
    const wise = nativeWise(async () => undefined);
    await wise.verifyCourse(courseId, studentId);
    const flatten = (sections: WiseSection[]): WiseSection[] => sections.flatMap(section => [section, ...flatten(section.children ?? [])]);
    const content = async () => {
      const section = flatten(await wise.timeline(courseId)).find(section => section._id === sectionId);
      assert(section?.enabled && section.name === "Progress Tests"); return section.entities;
    };
    const existingIds = (await content()).map(resource => resource._id);
    const act = async (action: Record<string, unknown>) => {
      const fresh = (await getAssessment(scope, assessment.id, db)).assessment;
      return executeCommand(scope, { ...action, id: assessment.id, expectedRevision: fresh.revision } as Command, db);
    };
    const run = async (jobId?: string) => {
      if (!jobId) return;
      const job = await claimJob(db, new Date(Date.now() + 120_000), jobId); assert(job);
      await runJob(job, db);
      const [done] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.id, jobId));
      assert.equal(done.status, "completed", done.error ?? "Processing incomplete");
    };
    const makePaper = async (label: string) => {
      const title = `SYNTHETIC preparation ${label} - no student results`;
      const [existing] = await db.select({ version: s.ptPaperVersions }).from(s.ptPaperVersions).innerJoin(s.ptPapers, eq(s.ptPapers.id, s.ptPaperVersions.paperId)).where(and(eq(s.ptPapers.ownerKey, owner), eq(s.ptPapers.title, title))).orderBy(desc(s.ptPaperVersions.revision));
      if (existing) return existing.version.id;
      const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([595.28, 841.89]);
      ["SYNTHETIC VALIDATION - NO STUDENT RESULTS", `BeGifted preparation ${label} verification`, "This temporary technical PDF validates upload and removal.", "It contains no student questions, marks or personal information."].forEach((line, index) => page.drawText(line, { x: 36, y: 790 - index * 35, size: index ? 12 : 15, font }));
      const bytes = Buffer.from(await pdf.save());
      const intent = await executeCommand(scope, { action: "upload-intent", purpose: "paper", assessmentId: assessment.id, name: `${title}.pdf`, mime: "application/pdf", size: bytes.length }, db);
      await put(intent.pathname!, bytes, { access: "private", contentType: "application/pdf", addRandomSuffix: false, allowOverwrite: false });
      await finalizeUpload(scope, intent.id!, db);
      const paper = await executeCommand(scope, { action: "create-paper", title }, db);
      const attached = await executeCommand(scope, { action: "attach-original", id: paper.id!, expectedRevision: 0, sourceFileId: intent.id!, keyFileId: null }, db);
      await executeCommand(scope, { action: "approve-paper", id: paper.id!, expectedRevision: attached.revision!, versionId: attached.versionId!, confirmed: true }, db);
      return attached.versionId!;
    };
    // A failed invocation can resume only the recorded operation, without a second blind attachment.
    const [latest] = await db.select().from(s.ptPreparationPublications).where(eq(s.ptPreparationPublications.assessmentId, assessment.id)).orderBy(desc(s.ptPreparationPublications.assessmentRevision));
    if (latest && !["published", "removed"].includes(latest.status)) {
      const [job] = await db.select().from(s.ptJobs).where(eq(s.ptJobs.targetId, latest.id)).orderBy(desc(s.ptJobs.createdAt)); assert(job);
      await run(job.status === "failed" ? (await executeCommand(scope, { action: "retry-job", id: job.id }, db)).jobId : job.id);
    }
    const firstVersion = await makePaper("upload"), secondVersion = await makePaper("replacement");
    for (const versionId of [firstVersion, secondVersion]) {
      const [existing] = await db.select().from(s.ptPreparationPublications).where(and(eq(s.ptPreparationPublications.assessmentId, assessment.id), eq(s.ptPreparationPublications.paperVersionId, versionId)));
      if (!existing) {
        await run((await act({ action: "prepare", paperVersionId: versionId, topics: "Synthetic technical verification only", studentInformed: true })).jobId);
        const [published] = await db.select().from(s.ptPreparationPublications).where(and(eq(s.ptPreparationPublications.assessmentId, assessment.id), eq(s.ptPreparationPublications.paperVersionId, versionId)));
        assert.equal(published.status, "published"); assert.equal(published.sectionId, sectionId);
        const remote = (await content()).find(resource => resource._id === published.resourceId); assert(remote);
        await wise.verifyFile(remote, published.sha256!);
        assert.equal((await act({ action: "prepare", paperVersionId: versionId, topics: "Synthetic technical verification only", studentInformed: true })).jobId, undefined);
        console.log(JSON.stringify({ step: versionId === firstVersion ? "upload-verified" : "replacement-verified", publicationId: published.id, resourceId: published.resourceId }));
      }
    }
    if ((await getAssessment(scope, assessment.id, db)).assessment.preparation.paperVersionId) await run((await act({ action: "remove-preparation-paper" })).jobId);
    const publications = await db.select().from(s.ptPreparationPublications).where(eq(s.ptPreparationPublications.assessmentId, assessment.id));
    assert.equal(publications.length, 3); assert(publications.every(publication => publication.status === "removed"));
    const remainingIds = (await content()).map(resource => resource._id), managedIds = publications.map(publication => publication.resourceId).filter(Boolean);
    assert(managedIds.every(id => !remainingIds.includes(id!)));
    assert(existingIds.filter(id => !managedIds.includes(id)).every(id => remainingIds.includes(id)));
    const final = await getAssessment(scope, assessment.id, db); assert.equal(final.series.count, 8); assert.equal(final.assessment.preparation.paperVersionId, null);
    const evidence = { verifiedAt: new Date(), courseId, studentId, sectionId, assessmentId: assessment.id, paidAiRequests: 0, existingResourcesPreserved: true, syntheticAttachmentsRemoved: true, publications: publications.map(({ id, operation, sha256, resourceId, wiseFileId, status, phase }) => ({ id, operation, sha256, resourceId, wiseFileId, status, phase })) };
    const out = "output/progress-tests-verification/preparation-release"; await mkdir(out, { recursive: true });
    await writeFile(`${out}/native-publication.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(evidence));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });
