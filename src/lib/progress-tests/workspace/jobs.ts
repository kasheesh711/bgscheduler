import { randomUUID } from "node:crypto";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { scopeForEmail, type Scope } from "./access";
import { getAssessment, getPaper, ownedFiles, paperVersionForOwner } from "./data";
import { fileForScope, storeGenerated } from "./files";
import { renderPaper, renderReview, visualPdf, orderResponsePages } from "./documents";
import { generateReport, gradeWork, parsePaper, PROMPT_VERSION, PARSE_INSTRUCTIONS, GRADE_INSTRUCTIONS, REPORT_INSTRUCTIONS } from "./ai";
import { progressTestAiModel } from "../ai-summary";
import { assertOwner, emptyReport, WorkspaceError, workspaceEnabled, type FeedbackEvidence, type Review } from "./model";

import { runPublication } from "./publication";

type Job = typeof s.ptJobs.$inferSelect;
const MAX_ATTEMPTS = 3;
export function retryDelay(attempts: number) { return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1)); }
export async function claimJob(db: Database, now?: Date): Promise<Job | null> {
  return withDatabaseTransaction(db, async tx => {
    const dueAt = now ?? sql`clock_timestamp()`;
    // A process that outlives its lease cannot commit: completion also checks the token.
    const [job] = await tx.select().from(s.ptJobs).where(and(sql`(${s.ptJobs.kind} <> 'publish' or exists (select 1 from ${s.ptWorkspaceSettings} ws where ws.id = 'workspace' and ws.publishing_enabled = true and ws.verified_at is not null))`,or(
      and(eq(s.ptJobs.status, "queued"), lte(s.ptJobs.availableAt, dueAt)),
      and(eq(s.ptJobs.status, "running"), lte(s.ptJobs.leaseUntil, dueAt)),
    ))).orderBy(s.ptJobs.availableAt).limit(1).for("update", { skipLocked: true });
    if (!job) return null;
    if (job.status === "running") await tx.update(s.ptJobAttempts).set({status:"interrupted",finishedAt:dueAt,error:"Worker lease expired; retry will use a new lease."}).where(and(eq(s.ptJobAttempts.jobId,job.id),eq(s.ptJobAttempts.attempt,job.attempts)));
    if (job.attempts >= MAX_ATTEMPTS) {
      await tx.update(s.ptJobs).set({ status: "failed", error: "Processing exhausted its retries. Review the files and retry, or complete the work manually.", finishedAt: dueAt }).where(eq(s.ptJobs.id, job.id));
      if(job.kind === "publish") {
        const message="Publication exhausted its retries. Check Wise and retry reconciliation from History.";
        const [pub]=await tx.update(s.ptPublications).set({status:"failed",error:message,updatedAt:dueAt}).where(eq(s.ptPublications.id,job.targetId)).returning();
        if(pub)await tx.update(s.ptAssessments).set({publicationStatus:"failed",publicationError:message}).where(and(eq(s.ptAssessments.currentReviewId,pub.reviewId),eq(s.ptAssessments.approvedReviewId,pub.reviewId)));
      }
      return null;
    }
    const [claimed] = await tx.update(s.ptJobs).set({ status: "running", attempts: job.attempts + 1, leaseToken: randomUUID(), leaseUntil: now ? new Date(now.getTime() + 300_000) : sql`clock_timestamp() + interval '5 minutes'` }).where(eq(s.ptJobs.id, job.id)).returning();
    await tx.insert(s.ptJobAttempts).values({jobId:job.id,attempt:claimed.attempts,input:job.input});
    return claimed;
  });
}

async function execute(job: Job, scope: Scope, db: Database) {
  const input = job.input;
  const readVersion = async (id: unknown) => paperVersionForOwner(String(id), job.ownerKey, db);
  const readReview = async (id: unknown) => {
    const [review] = await db.select().from(s.ptReviews).where(and(eq(s.ptReviews.id, String(id)), eq(s.ptReviews.assessmentId, job.targetId))).limit(1);
    if (!review) throw new WorkspaceError(404, "Review not found.");
    return review;
  };
  const inputFiles: string[] = [];
  const visual = async (id: string) => {
    const file = await fileForScope(scope, id, db);
    if (file.ownerKey !== job.ownerKey || file.status !== "ready") throw new WorkspaceError(404, "Input file is unavailable.");
    const bytes = await visualPdf(file);
    inputFiles.push(id);
    if (file.mime !== "application/pdf") {
      const rendered = await storeGenerated(job.ownerKey, `${file.name}.visual.pdf`, bytes, db);
      inputFiles.push(rendered.id);
    }
    return { name: file.name, bytes };
  };
  const recordInputs = async () => {
    const prompt = ({"parse-paper":PARSE_INSTRUCTIONS,grade:GRADE_INSTRUCTIONS,report:REPORT_INSTRUCTIONS} as Record<string,string>)[job.kind] ?? null;
    await db.update(s.ptJobAttempts).set({input:{...job.input,visualInputFileIds:inputFiles,promptVersion:PROMPT_VERSION},model:prompt ? progressTestAiModel() : null,prompt})
      .where(and(eq(s.ptJobAttempts.jobId,job.id),eq(s.ptJobAttempts.attempt,job.attempts)));
    await db.update(s.ptJobs).set({ input: { ...job.input, visualInputFileIds: inputFiles, promptVersion: PROMPT_VERSION } })
      .where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!)));
  };
  if (job.kind === "parse-paper") {
    const files = [await visual(String(input.sourceFileId))];
    if (input.keyFileId) files.push(await visual(String(input.keyFileId)));
    await recordInputs();
    const result = await parsePaper(files);
    return { type: "paper" as const, result, inputFiles };
  }
  if (job.kind === "render-paper") {
    const version = await readVersion(input.versionId);
    const original = version.sourceFileId ? await visual(version.sourceFileId) : undefined;
    await recordInputs();
    const bytes = await renderPaper(version.paper, original?.bytes);
    const file = await storeGenerated(job.ownerKey, `${version.paper.title}.pdf`, bytes, db);
    return { type: "paper-pdf" as const, fileId: file.id, inputFiles };
  }
  const row = await getAssessment(scope, job.targetId, db);
  if (job.kind === "grade") {
    const paper = await readVersion(input.paperVersionId);
    if (!paper.approved) throw new WorkspaceError(409, "The rubric requires tutor approval.");
    const [submission] = await db.select().from(s.ptSubmissions).where(and(eq(s.ptSubmissions.id, String(input.submissionId)), eq(s.ptSubmissions.assessmentId, job.targetId))).limit(1);
    if (!submission) throw new WorkspaceError(404, "Submission not found.");
    await ownedFiles(scope, submission.data.fileIds, job.ownerKey, db);
    const files = [];
    for (const id of submission.data.fileIds) files.push({ id, ...await visual(id) });
    const ordered = await orderResponsePages(files, submission.data.pageOrder);
    const orderedFile = await storeGenerated(job.ownerKey, "Responses in reviewed page order.pdf", ordered, db);
    inputFiles.push(orderedFile.id);
    const references = [];
    if (paper.sourceFileId) references.push({ ...await visual(paper.sourceFileId), name: "Approved original question paper" });
    if (paper.keyFileId) references.push({ ...await visual(paper.keyFileId), name: "Tutor-approved rubric reference key" });
    await recordInputs();
    const result = await gradeWork(paper.paper, { name: "Student responses", bytes: ordered }, references);
    const review: Review = { marks: result.data.marks, report: emptyReport(), feedback: [], priorReviewIds: [], model: result.model, promptVersion: result.promptVersion, submissionId: submission.id, paperVersionId: paper.id };
    return { type: "review" as const, review, result, inputFiles };
  }
  if (job.kind === "report") {
    const review = await readReview(input.reviewId);
    const paper = await readVersion(review.data.paperVersionId);
    const feedback = input.feedback as FeedbackEvidence[];
    const prior = input.prior as { id: string; report: unknown }[];
    await recordInputs();
    const result = await generateReport(paper.paper, review.data, feedback, prior);
    const data: Review = { ...review.data, report: result.data, feedback, priorReviewIds: prior.map(p => p.id), model: result.model, promptVersion: result.promptVersion };
    return { type: "review" as const, review: data, result, inputFiles };
  }
  if (job.kind === "render-review") {
    const review = await readReview(input.reviewId);
    const paper = await readVersion(review.data.paperVersionId);
    const [submission] = await db.select().from(s.ptSubmissions).where(and(eq(s.ptSubmissions.id, review.data.submissionId), eq(s.ptSubmissions.assessmentId, job.targetId))).limit(1);
    if (!submission) throw new WorkspaceError(404, "Submission not found.");
    const sourceWork = [];
    for (const id of submission.data.fileIds) sourceWork.push({ id, bytes: (await visual(id)).bytes });
    const work = [await orderResponsePages(sourceWork, submission.data.pageOrder)];
    const originalPaper = paper.sourceFileId && paper.paper.questions.some(q => q.needsVisual) ? (await visual(paper.sourceFileId)).bytes : undefined;
    await recordInputs();
    const files = await renderReview(paper.paper, review.data, row.series.studentName, row.series.courseName, row.series.tutorName, row.assessment.cycle, work, originalPaper);
    const graded = await storeGenerated(job.ownerKey, `${row.series.studentName} - graded progress test.pdf`, files.graded, db);
    const report = await storeGenerated(job.ownerKey, `${row.series.studentName} - progress report.pdf`, files.report, db);
    return { type: "review-pdfs" as const, reviewId: review.id, gradedFileId: graded.id, reportFileId: report.id, inputFiles };
  }
  throw new WorkspaceError(400, "Unsupported processing job.");
}

export async function runJob(job: Job, db: Database = getDb()) {
  try {
    if(job.kind==="publish") {
      const result=await runPublication(job,db);
      await db.update(s.ptJobs).set({status:"completed",result,error:null,finishedAt:new Date(),leaseUntil:null}).where(and(eq(s.ptJobs.id,job.id),eq(s.ptJobs.leaseToken,job.leaseToken!),eq(s.ptJobs.status,"running")));
      await db.update(s.ptJobAttempts).set({status:"completed",result,finishedAt:new Date()}).where(and(eq(s.ptJobAttempts.jobId,job.id),eq(s.ptJobAttempts.attempt,job.attempts)));
      return;
    }
    let scope = await scopeForEmail(job.createdBy, db);
    assertOwner(scope.keys, job.ownerKey);
    const paperJob = job.kind === "parse-paper" || job.kind === "render-paper";
    const before = paperJob ? (await getPaper(scope, job.targetId, db)).revision : (await getAssessment(scope, job.targetId, db)).assessment.revision;
    if (before !== job.expectedRevision) throw new WorkspaceError(409, "A newer edit superseded this job. Start processing the current version.");
    const result = await execute(job, scope, db);
    await db.update(s.ptJobAttempts).set({result,finishedAt:new Date(),status:"completed"}).where(and(eq(s.ptJobAttempts.jobId,job.id),eq(s.ptJobAttempts.attempt,job.attempts)));
    scope = await scopeForEmail(job.createdBy, db);
    assertOwner(scope.keys, job.ownerKey);
    await withDatabaseTransaction(db, async tx => {
      const [claimed] = await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running"))).for("update");
      if (!claimed) return;
      const current = paperJob ? (await getPaper(scope, job.targetId, tx, true)).revision : (await getAssessment(scope, job.targetId, tx, true)).assessment.revision;
      if (current !== job.expectedRevision) {
        await tx.update(s.ptJobAttempts).set({status:"superseded"}).where(and(eq(s.ptJobAttempts.jobId,job.id),eq(s.ptJobAttempts.attempt,job.attempts)));
        await tx.update(s.ptJobs).set({ status: "superseded", result, error: "A newer edit was saved while this job ran. It has been preserved without replacing your work.", finishedAt: new Date() }).where(eq(s.ptJobs.id, job.id));
        return;
      }
      if (result.type === "paper") {
        await tx.insert(s.ptPaperVersions).values({ paperId: job.targetId, revision: current + 1, sourceFileId: String(job.input.sourceFileId), keyFileId: job.input.keyFileId ? String(job.input.keyFileId) : null,
          paper: result.result.data, model: result.result.model, createdBy: job.createdBy, approved: false });
        await tx.update(s.ptPapers).set({ revision: current + 1, title: result.result.data.title }).where(eq(s.ptPapers.id, job.targetId));
      }
      if (result.type === "review") {
        const [review] = await tx.insert(s.ptReviews).values({ assessmentId: job.targetId, data: result.review, createdBy: job.createdBy }).returning();
        await tx.update(s.ptAssessments).set({ currentReviewId: review.id, revision: current + 1, publicationStatus: "not_ready", publicationError: null, updatedAt: new Date() }).where(eq(s.ptAssessments.id, job.targetId));
      }
      if (result.type === "review-pdfs") {
        await tx.insert(s.ptArtifacts).values([{ reviewId: result.reviewId, kind: "graded", fileId: result.gradedFileId }, { reviewId: result.reviewId, kind: "report", fileId: result.reportFileId }]).onConflictDoNothing();
      }
      await tx.update(s.ptJobs).set({ status: "completed", result, error: null, finishedAt: new Date(), leaseUntil: null }).where(eq(s.ptJobs.id, job.id));
    });
  } catch (error) {
    const terminal = error instanceof WorkspaceError && error.status < 500;
    const message = error instanceof WorkspaceError ? error.message : "Processing failed. Your sources and previous work are safe; retry or complete the work manually.";
    await db.update(s.ptJobAttempts).set({status:"failed",error:message,finishedAt:new Date()}).where(and(eq(s.ptJobAttempts.jobId,job.id),eq(s.ptJobAttempts.attempt,job.attempts)));
    await db.update(s.ptJobs).set({ status: terminal ? error instanceof WorkspaceError && error.status === 409 ? "superseded" : "failed" : job.attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      error: message, availableAt: new Date(Date.now() + retryDelay(job.attempts)), leaseUntil: null, finishedAt: terminal || job.attempts >= MAX_ATTEMPTS ? new Date() : null })
      .where(and(eq(s.ptJobs.id, job.id), eq(s.ptJobs.leaseToken, job.leaseToken!), eq(s.ptJobs.status, "running")));
  }
}
export async function processJobs(db: Database = getDb(), maxJobs = 1) {
  if (!workspaceEnabled()) return { processed: 0, paused: true };
  let processed = 0;
  const started = Date.now();
  while (processed < maxJobs && Date.now() - started < 210_000) {
    const job = await claimJob(db);
    if (!job) break;
    await runJob(job, db);
    processed++;
  }
  return { processed, paused: false };
}
