import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { chooseOwner, type Scope } from "./access";
import type { Command } from "./commands";
import { assertOwner, assertRevision, cyclePosition, stageFor, validateMarks, WorkspaceError, type FeedbackEvidence, type Review } from "./model";
import { publicationReadiness, publishingSettings, preparePublication, publicationForScope } from "./publication";
import { launchConfig } from "./cutover";
export { launchConfig } from "./cutover";

export function ownerWhere(column: typeof s.ptSeries.ownerKey | typeof s.ptPapers.ownerKey | typeof s.ptFiles.ownerKey | typeof s.ptJobs.ownerKey, scope: Scope) {
  return scope.keys === null ? undefined : scope.keys.length ? inArray(column, scope.keys) : sql`false`;
}
export async function getAssessment(scope: Scope, id: string, db: Database = getDb(), lock = false) {
  const query = db.select({ assessment: s.ptAssessments, series: s.ptSeries }).from(s.ptAssessments)
    .innerJoin(s.ptSeries, eq(s.ptAssessments.seriesId, s.ptSeries.id))
    .where(and(eq(s.ptAssessments.id, id), and(ownerWhere(s.ptSeries.ownerKey, scope),eq(s.ptSeries.classType,"ONE_TO_ONE")))).limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new WorkspaceError(404, "Assessment not found.");
  return row;
}
export async function getPaper(scope: Scope, id: string, db: Database = getDb(), lock = false) {
  const query = db.select().from(s.ptPapers).where(and(eq(s.ptPapers.id, id), ownerWhere(s.ptPapers.ownerKey, scope))).limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new WorkspaceError(404, "Paper not found.");
  return row;
}
export async function ownedFiles(scope: Scope, ids: string[], owner: string, db: Database = getDb()) {
  if (new Set(ids).size !== ids.length) throw new WorkspaceError(400, "Each file can appear only once.");
  if (!ids.length) return [];
  assertOwner(scope.keys, owner);
  const rows = await db.select().from(s.ptFiles).where(and(inArray(s.ptFiles.id, ids), eq(s.ptFiles.ownerKey, owner), eq(s.ptFiles.status, "ready")));
  if (rows.length !== ids.length) throw new WorkspaceError(400, "Wait for every file to finish uploading, or select files belonging to this tutor.");
  return ids.map(id => rows.find(row => row.id === id)!);
}
export async function paperVersionForOwner(id: string, owner: string, db: Database = getDb()) {
  const [row] = await db.select({ version: s.ptPaperVersions }).from(s.ptPaperVersions)
    .innerJoin(s.ptPapers, eq(s.ptPapers.id, s.ptPaperVersions.paperId))
    .where(and(eq(s.ptPaperVersions.id, id), eq(s.ptPapers.ownerKey, owner))).limit(1);
  if (!row) throw new WorkspaceError(404, "Paper version not found.");
  return row.version;
}
export function assessmentView(row: Awaited<ReturnType<typeof getAssessment>>) {
  const { assessment: a, series } = row;
  const approved = !!a.approvedReviewId && a.approvedReviewId === a.currentReviewId;
  const stage = stageFor(series.count, a.cycle, a.preparation, !!a.currentSubmissionId, approved);
  const position = cyclePosition(series.count, a.cycle);
  const nextAction = stage === "approved" ? a.publicationStatus === "published" ? "View published results" : "View approved PDFs"
    : stage === "tutor_review" ? "Review results" : stage === "awaiting_submission" ? "Submit student work"
    : stage === "ready" ? "Administer in class " + a.cycle * 8 : position >= 6 ? "Prepare test and inform student" : "Prepare test";
  return { ...a, series, stage, position, nextAction, dueClass: a.cycle * 8, discussionClass: a.cycle * 8 - 1,
    overdue: series.count > a.cycle * 8 && !approved };
}
export async function workspaceOverview(scope: Scope, db: Database = getDb()) {
  const [config, rows, papers, jobs, tutors] = await Promise.all([
    launchConfig(db),
    db.select({ assessment: s.ptAssessments, series: s.ptSeries }).from(s.ptAssessments)
      .innerJoin(s.ptSeries, eq(s.ptAssessments.seriesId, s.ptSeries.id)).where(and(ownerWhere(s.ptSeries.ownerKey, scope),eq(s.ptSeries.classType,"ONE_TO_ONE"))).orderBy(s.ptSeries.studentName, s.ptAssessments.cycle),
    db.select().from(s.ptPapers).where(ownerWhere(s.ptPapers.ownerKey, scope)).orderBy(desc(s.ptPapers.createdAt)),
    db.select({ id: s.ptJobs.id, kind: s.ptJobs.kind, targetId: s.ptJobs.targetId, expectedRevision: s.ptJobs.expectedRevision, status: s.ptJobs.status, error: s.ptJobs.error,
      result: sql<Record<string, unknown> | null>`case when ${s.ptJobs.result} is null then null else jsonb_build_object('fileId', ${s.ptJobs.result}->'fileId', 'gradedFileId', ${s.ptJobs.result}->'gradedFileId', 'reportFileId', ${s.ptJobs.result}->'reportFileId') end`, createdAt: s.ptJobs.createdAt })
      .from(s.ptJobs).where(ownerWhere(s.ptJobs.ownerKey, scope)).orderBy(desc(s.ptJobs.createdAt)).limit(100),
    db.select({ key: s.tutorContacts.canonicalKey, name: s.tutorContacts.displayName }).from(s.tutorContacts)
      .where(and(eq(s.tutorContacts.active, true), scope.keys === null ? undefined : inArray(s.tutorContacts.canonicalKey, scope.keys))).orderBy(s.tutorContacts.displayName),
  ]);
  const unresolved = scope.keys === null && config ? await db.select({ id: s.progressTestAttendanceLedger.id, student: s.progressTestAttendanceLedger.studentName, course: s.progressTestAttendanceLedger.subject, date: s.progressTestAttendanceLedger.scheduledStartTime })
    .from(s.progressTestAttendanceLedger).where(and(isNull(s.progressTestAttendanceLedger.tutorCanonicalKey), sql`${s.progressTestAttendanceLedger.scheduledStartTime} >= ${config.activatedAt}`, eq(s.progressTestAttendanceLedger.countsTowardCycle, true))).limit(200) : [];
  const legacy = scope.keys === null ? await db.select({ id:s.progressTestCycleState.enrollmentKey,student:s.progressTestCycleState.studentName,course:s.progressTestCycleState.subject,tutor:s.progressTestCycleState.mostFrequentTutorDisplayName,ownerKey:s.progressTestCycleState.mostFrequentTutorCanonicalKey,status:s.progressTestCycleState.status,count:s.progressTestCycleState.currentCount,date:s.progressTestCycleState.updatedAt }).from(s.progressTestCycleState).orderBy(s.progressTestCycleState.studentName) : [];
  return { user: scope.user, activatedAt: config?.activatedAt ?? null, publication: publicationReadiness(await publishingSettings(db)),
    sourceIssues: scope.keys===null ? await db.select().from(s.ptSourceIssues).limit(200) : [],
    capabilities: { uploads: !!process.env.BLOB_READ_WRITE_TOKEN, ai: !!(process.env.OPENAI_PROGRESS_TEST_API_KEY || process.env.OPENAI_API_KEY) },
    assessments: rows.map(assessmentView), papers, jobs, tutors, unresolved, legacy };
}
export type Overview = Awaited<ReturnType<typeof workspaceOverview>>;

export async function feedbackContext(series: typeof s.ptSeries.$inferSelect, cycle: number, db: Database = getDb()): Promise<FeedbackEvidence[]> {
  const sessionIds = series.sessionIds.slice((cycle - 1) * 8, cycle * 8);
  if (series.classType !== "ONE_TO_ONE" || !sessionIds.length) return [];
  // Require instructor AND participant AND feedback-author identity. Missing
  // authorship is a context limitation, never permission to use another tutor's notes.
  const rows = await db.select({ feedback: s.postClassFeedbackVersions, session: s.postClassSessions }).from(s.postClassSessions)
    .innerJoin(s.postClassSessionParticipants, eq(s.postClassSessionParticipants.sessionId, s.postClassSessions.id))
    .innerJoin(s.postClassFeedbackVersions, eq(s.postClassFeedbackVersions.id, s.postClassSessions.latestFeedbackVersionId))
    .where(and(inArray(s.postClassSessions.wiseSessionId, sessionIds), eq(s.postClassSessions.wiseClassId, series.wiseClassId),
      eq(s.postClassSessions.canonicalTutorKey, series.ownerKey), eq(s.postClassSessionParticipants.wiseStudentId, series.wiseStudentId),
      eq(s.postClassFeedbackVersions.profile, "teacher"), eq(s.postClassFeedbackVersions.actorWiseUserId, s.postClassSessions.wiseTeacherUserId),
      eq(s.postClassSessions.sourceStatus, "ready"), isNull(s.postClassSessions.wiseDeletedAt),
      // The mirrored feedback contract is session-level. Do not expose other
      // group students' performance as this student's personal report context.
      sql`(select count(*) from ${s.postClassSessionParticipants} p where p.session_id = ${s.postClassSessions.id}) = 1`))
    .orderBy(s.postClassSessions.scheduledStartAt);
  return rows.map(({ feedback: f, session }) => ({ id: f.id, sessionId: session.wiseSessionId, date: session.scheduledStartAt.toISOString(),
    text: `Topics: ${f.topics}\nPerformance: ${f.performance}\nImprovement: ${f.improvement}\nHomework: ${f.homework}` }));
}
export async function assessmentDetail(scope: Scope, id: string, db: Database = getDb()) {
  const row = await getAssessment(scope, id, db);
  const { assessment: a, series } = row;
  const [submissions, reviews, sessions, feedback, versions] = await Promise.all([
    db.select().from(s.ptSubmissions).where(eq(s.ptSubmissions.assessmentId, id)).orderBy(desc(s.ptSubmissions.createdAt)),
    db.select().from(s.ptReviews).where(eq(s.ptReviews.assessmentId, id)).orderBy(desc(s.ptReviews.createdAt)),
    series.sessionIds.length ? db.select({ id: s.progressTestAttendanceLedger.wiseSessionId, date: s.progressTestAttendanceLedger.scheduledStartTime })
      .from(s.progressTestAttendanceLedger).where(and(inArray(s.progressTestAttendanceLedger.wiseSessionId, series.sessionIds), eq(s.progressTestAttendanceLedger.wiseStudentId, series.wiseStudentId), eq(s.progressTestAttendanceLedger.tutorCanonicalKey, series.ownerKey))).orderBy(s.progressTestAttendanceLedger.scheduledStartTime) : [],
    feedbackContext(series, a.cycle, db),
    db.select({ version: s.ptPaperVersions, title: s.ptPapers.title }).from(s.ptPaperVersions).innerJoin(s.ptPapers, eq(s.ptPapers.id, s.ptPaperVersions.paperId))
      .where(and(eq(s.ptPapers.ownerKey, series.ownerKey), eq(s.ptPaperVersions.approved, true))).orderBy(desc(s.ptPaperVersions.createdAt)),
  ]);
  const artifacts = reviews.length ? await db.select().from(s.ptArtifacts).where(inArray(s.ptArtifacts.reviewId, reviews.map(r => r.id))) : [];
  const publications = reviews.length ? await db.select().from(s.ptPublications).where(inArray(s.ptPublications.reviewId, reviews.map(r => r.id))) : [];
  const publicationFiles = publications.length ? await db.select().from(s.ptPublicationFiles).where(inArray(s.ptPublicationFiles.publicationId,publications.map(p=>p.id))) : [];
  return { ...assessmentView(row), publicationFiles, submissions, reviews, sessions: sessions.map(x => ({ ...x, ordinal: series.sessionIds.indexOf(x.id) + 1 })), feedback, versions, artifacts, publications };
}
export type AssessmentDetail = Awaited<ReturnType<typeof assessmentDetail>>;
export async function paperDetail(scope: Scope, id: string, db: Database = getDb()) {
  const paper = await getPaper(scope, id, db);
  const versions = await db.select().from(s.ptPaperVersions).where(eq(s.ptPaperVersions.paperId, id)).orderBy(desc(s.ptPaperVersions.revision));
  return { ...paper, versions };
}
export type PaperDetail = Awaited<ReturnType<typeof paperDetail>>;

export async function enqueue(db: Database, scope: Scope, kind: string, targetId: string, expectedRevision: number, ownerKey: string, input: Record<string, unknown>) {
  const [job] = await db.insert(s.ptJobs).values({ ownerKey, kind, targetId, expectedRevision, input, createdBy: scope.user.email }).onConflictDoNothing().returning();
  if (!job) throw new WorkspaceError(409, "This operation is already processing. Check its status before retrying.");
  return { jobId: job.id };
}

export async function executeCommand(scope: Scope, command: Command, db: Database = getDb()): Promise<{ id?: string; revision?: number; pathname?: string; versionId?: string; jobId?: string; publicationId?: string }> {
  return withDatabaseTransaction(db, async tx => {
    const c = command;
    if (c.action === "activate") {
      if (scope.keys !== null) throw new WorkspaceError(403, "Administrator access is required.");
      const [existingLaunch]=await tx.select().from(s.ptWorkspaceConfig).where(eq(s.ptWorkspaceConfig.id,"launch"));
      if(existingLaunch)return {};
      const settings=await publishingSettings(tx);
      const ready=publicationReadiness(settings);
      if(!ready.configured || !(process.env.OPENAI_PROGRESS_TEST_API_KEY || process.env.OPENAI_API_KEY))throw new WorkspaceError(409,ready.reason);
      const [snapshot]=await tx.select().from(s.snapshots).where(eq(s.snapshots.active,true)).limit(1);
      if(!snapshot)throw new WorkspaceError(409,"Synchronize verified tutor identities before activation.");
      await tx.insert(s.ptWorkspaceConfig).values({id:"launch",activatedAt:new Date(),activatedBy:scope.user.email}).onConflictDoNothing();
      await tx.update(s.ptWorkspaceSettings).set({publishingEnabled:true,revision:settings.revision+1,updatedBy:scope.user.email,updatedAt:new Date()}).where(eq(s.ptWorkspaceSettings.id,"workspace"));
      return {};
    }
    if(c.action === "publishing") {
      if(scope.keys!==null)throw new WorkspaceError(403,"Administrator access is required.");
      const [settings]=await tx.select().from(s.ptWorkspaceSettings).where(eq(s.ptWorkspaceSettings.id,"workspace")).for("update");
      assertRevision(settings.revision,c.expectedRevision);
      if(c.enabled && !publicationReadiness(settings).configured)throw new WorkspaceError(409,publicationReadiness(settings).reason);
      await tx.update(s.ptWorkspaceSettings).set({publishingEnabled:c.enabled,revision:settings.revision+1,updatedBy:scope.user.email,updatedAt:new Date()}).where(eq(s.ptWorkspaceSettings.id,"workspace"));
      return {revision:settings.revision+1};
    }
    if (c.action === "upload-intent") {
      const ownerKey = await chooseOwner(scope, c.ownerKey, tx);
      if (c.purpose !== "work" && c.mime.startsWith("image/")) throw new WorkspaceError(400, "Papers and marking keys must be PDF or DOCX.");
      if (c.purpose === "work" && c.mime.includes("wordprocessingml")) throw new WorkspaceError(400, "Student work must be PDF, JPG or PNG.");
      const id = randomUUID();
      const pathname = `progress-tests/${id}/source`;
      await tx.insert(s.ptFiles).values({ id, ownerKey, name: c.name.replace(/[\r\n\x00-\x1f]/g, ""), mime: c.mime, size: c.size, pathname, purpose: c.purpose });
      return { id, pathname };
    }
    if (c.action === "create-paper") {
      const ownerKey = await chooseOwner(scope, c.ownerKey, tx);
      const [paper] = await tx.insert(s.ptPapers).values({ ownerKey, title: c.title }).returning();
      return { id: paper.id };
    }
    if (c.action === "retry-job") {
      const [job] = await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.id, c.id), ownerWhere(s.ptJobs.ownerKey, scope))).for("update");
      if (!job) throw new WorkspaceError(404, "Job not found.");
      if (job.status !== "failed") throw new WorkspaceError(409, "Only failed jobs can be retried.");
      if(job.kind==="publish")await publicationForScope(scope,job.targetId,tx);
      return enqueue(tx, scope, job.kind, job.targetId, job.expectedRevision, job.ownerKey, job.input);
    }
    if (["save-paper", "process-paper", "preview-paper"].includes(c.action)) {
      // Discriminants are repeated below to keep their input types precise.
      if (c.action !== "save-paper" && c.action !== "process-paper" && c.action !== "preview-paper") throw new WorkspaceError(400, "Unknown paper action.");
      const paper = await getPaper(scope, c.id, tx, true);
      assertRevision(paper.revision, c.expectedRevision);
      if (c.action === "preview-paper") {
        const [version] = await tx.select().from(s.ptPaperVersions).where(and(eq(s.ptPaperVersions.paperId, c.id), eq(s.ptPaperVersions.revision, paper.revision)));
        if (!version) throw new WorkspaceError(400, "Save the paper before previewing it.");
        return enqueue(tx, scope, "render-paper", c.id, paper.revision, paper.ownerKey, { versionId: version.id });
      }
      const files = await ownedFiles(scope, [c.sourceFileId, c.keyFileId].filter((v): v is string => !!v), paper.ownerKey, tx);
      if (files.some(f => f.mime.startsWith("image/") || f.purpose === "work")) throw new WorkspaceError(400, "Select a paper or marking-key PDF/DOCX.");
      if (c.action === "process-paper") return enqueue(tx, scope, "parse-paper", c.id, paper.revision, paper.ownerKey, { sourceFileId: c.sourceFileId, keyFileId: c.keyFileId });
      if (c.approved && (c.paper.warnings.length || c.paper.questions.some(q => !q.rubric.trim()))) throw new WorkspaceError(400, "Review every warning and supply a marking rubric for each question before marking this paper ready.");
      if (c.approved) {
        const [previous] = await tx.select().from(s.ptPaperVersions).where(and(eq(s.ptPaperVersions.paperId,paper.id),eq(s.ptPaperVersions.revision,paper.revision)));
        const [preview] = await tx.select({ id: s.ptJobs.id }).from(s.ptJobs).where(and(eq(s.ptJobs.targetId,paper.id),eq(s.ptJobs.expectedRevision,paper.revision),eq(s.ptJobs.kind,"render-paper"),eq(s.ptJobs.status,"completed"))).limit(1);
        if (!previous || !preview || !isDeepStrictEqual(previous.paper,c.paper) || previous.sourceFileId !== c.sourceFileId || previous.keyFileId !== c.keyFileId) throw new WorkspaceError(409, "Save your draft and preview the formatted PDF before marking that exact version ready.");
      }
      if (c.paper.questions.some(q => q.needsVisual) && !c.sourceFileId) throw new WorkspaceError(400, "Keep the original paper attached to preserve its illustrations.");
      const revision = paper.revision + 1;
      const [version] = await tx.insert(s.ptPaperVersions).values({ paperId: paper.id, revision, sourceFileId: c.sourceFileId, keyFileId: c.keyFileId, paper: c.paper, approved: c.approved, createdBy: scope.user.email }).returning();
      await tx.update(s.ptPapers).set({ revision, title: c.paper.title }).where(eq(s.ptPapers.id, paper.id));
      return { id: paper.id, revision, versionId: version.id };
    }
    if (c.action === "save-paper" || c.action === "process-paper" || c.action === "preview-paper") throw new WorkspaceError(400, "Unknown action.");
    const { assessment: a, series } = await getAssessment(scope, c.id, tx, true);
    assertRevision(a.revision, c.expectedRevision);
    const update = async (patch: Partial<typeof s.ptAssessments.$inferInsert>) => {
      await tx.update(s.ptAssessments).set({ ...patch, revision: a.revision + 1, updatedAt: new Date() }).where(eq(s.ptAssessments.id, a.id));
      return { id: a.id, revision: a.revision + 1 };
    };
    if (c.action === "prepare") {
      if (a.currentSubmissionId) throw new WorkspaceError(409, "A submitted assessment keeps its approved paper. Create a new submission to correct student work.");
      const paper = await paperVersionForOwner(c.paperVersionId, series.ownerKey, tx);
      if (!paper.approved) throw new WorkspaceError(400, "Review the paper and rubric in your library first.");
      return update({ preparation: { paperVersionId: paper.id, topics: c.topics, studentInformed: c.studentInformed } });
    }
    if (!a.preparation.paperVersionId) throw new WorkspaceError(400, "Select a reviewed paper first.");
    const paper = await paperVersionForOwner(a.preparation.paperVersionId, series.ownerKey, tx);
    if (c.action === "submit") {
      if (!a.preparation.studentInformed || !a.preparation.topics.trim()) throw new WorkspaceError(400, "Complete the preparation checklist first.");
      const ordinal = series.sessionIds.indexOf(c.sessionId) + 1;
      if (ordinal <= (a.cycle - 1) * 8) throw new WorkspaceError(400, "Select a completed class in this tutor's assessment cycle or a later class.");
      const files = await ownedFiles(scope, c.fileIds, series.ownerKey, tx);
      if (files.some(f => f.purpose !== "work" || f.mime.includes("wordprocessingml"))) throw new WorkspaceError(400, "Use student-work PDFs, JPGs or PNGs.");
      if (files.reduce((n, f) => n + f.size, 0) > 45 * 1024 * 1024) throw new WorkspaceError(400, "Use at most 45 MB of student work per submission.");
      const naturalOrder = files.flatMap(f => Array.from({ length: f.pageCount ?? 0 }, (_, i) => ({ fileId: f.id, page: i + 1 })));
      const pageOrder = c.pageOrder ?? naturalOrder;
      const pageKey = (p: { fileId: string; page: number }) => `${p.fileId}:${p.page}`;
      if (!naturalOrder.length || naturalOrder.length > 100 || pageOrder.length !== naturalOrder.length || new Set(pageOrder.map(pageKey)).size !== pageOrder.length || pageOrder.some(p => !naturalOrder.some(n => pageKey(n) === pageKey(p)))) throw new WorkspaceError(400, "Include every uploaded page exactly once, with at most 100 pages in total.");
      const [submission] = await tx.insert(s.ptSubmissions).values({ assessmentId: a.id, createdBy: scope.user.email, data: { fileIds: c.fileIds, pageOrder, sessionId: c.sessionId, submittedAt: new Date().toISOString() } }).returning();
      return update({ currentSubmissionId: submission.id, currentReviewId: null, publicationStatus: "not_ready", publicationError: null });
    }
    if(c.action === "publish") {
      const [pub] = c.publicationId ? await tx.select().from(s.ptPublications).where(eq(s.ptPublications.id,c.publicationId)) : a.approvedReviewId ? await tx.select().from(s.ptPublications).where(eq(s.ptPublications.reviewId,a.approvedReviewId)) : [];
      if(!pub)throw new WorkspaceError(409,"Approve the reviewed results first.");
      const verified=await publicationForScope(scope,pub.id,tx);
      if(verified.assessment.id!==a.id)throw new WorkspaceError(404,"Publication not found.");
      if(pub.status==="published")return {publicationId:pub.id};
      await tx.update(s.ptPublications).set({status:"queued",error:null}).where(eq(s.ptPublications.id,pub.id));
      return enqueue(tx,scope,"publish",pub.id,0,series.ownerKey,{assessmentId:a.id,reviewId:pub.reviewId});
    }
    const [submission] = a.currentSubmissionId ? await tx.select().from(s.ptSubmissions).where(and(eq(s.ptSubmissions.id, a.currentSubmissionId), eq(s.ptSubmissions.assessmentId, a.id))) : [];
    if (!submission) throw new WorkspaceError(400, "Submit the student's completed work first.");
    if (!series.sessionIds.includes(submission.data.sessionId)) throw new WorkspaceError(409, "Attendance or instructor ownership changed. Review the administered class and submit a corrected version.");
    const [current] = a.currentReviewId ? await tx.select().from(s.ptReviews).where(and(eq(s.ptReviews.id, a.currentReviewId), eq(s.ptReviews.assessmentId, a.id))) : [];
    if (c.action === "grade") return enqueue(tx, scope, "grade", a.id, a.revision, series.ownerKey, { submissionId: submission.id, paperVersionId: paper.id });
    if (c.action === "save-review") {
      validateMarks(paper.paper, c.marks);
      const lines = (values: string[]) => values.map(v => v.trim()).filter(Boolean);
      const report = { ...c.report, strengths: lines(c.report.strengths), focusAreas: lines(c.report.focusAreas), nextSteps: lines(c.report.nextSteps) };
      const data: Review = { ...(current?.data ?? { feedback: await feedbackContext(series,a.cycle,tx), priorReviewIds: [], model: null, promptVersion: "manual-v1", submissionId: submission.id, paperVersionId: paper.id }), marks: c.marks, report };
      const [review] = await tx.insert(s.ptReviews).values({ assessmentId: a.id, data, createdBy: scope.user.email }).returning();
      return update({ currentReviewId: review.id, publicationStatus: "not_ready", publicationError: null });
    }
    if (!current) throw new WorkspaceError(400, "Review and save the question marks first.");
    if (c.action === "report") {
      validateMarks(paper.paper, current.data.marks, true);
      const feedback = await feedbackContext(series, a.cycle, tx);
      const prior = await tx.select({ review: s.ptReviews }).from(s.ptReviews).innerJoin(s.ptAssessments, eq(s.ptReviews.assessmentId, s.ptAssessments.id))
        .where(and(eq(s.ptAssessments.seriesId, series.id), sql`${s.ptAssessments.cycle} < ${a.cycle}`, eq(s.ptReviews.id, s.ptAssessments.approvedReviewId), eq(s.ptReviews.approved, true)))
        .orderBy(desc(s.ptAssessments.cycle)).limit(4);
      return enqueue(tx, scope, "report", a.id, a.revision, series.ownerKey, { reviewId: current.id, feedback, prior: prior.map(r => ({ id: r.review.id, report: r.review.data.report })) });
    }
    if (c.action === "preview-review") return enqueue(tx, scope, "render-review", a.id, a.revision, series.ownerKey, { reviewId: current.id });
    if (c.action === "approve") {
      if(current.approved)throw new WorkspaceError(409,"These results are already approved. Save a new review for corrections.");
      validateMarks(paper.paper, current.data.marks, true);
      if (!current.data.report.summary.trim() || !current.data.report.nextSteps.some(step => step.trim())) throw new WorkspaceError(400, "Complete the report summary and next steps before approval.");
      if (!current.data.feedback.length && !current.data.report.contextLimitations.trim()) throw new WorkspaceError(400, "Record the limitation that verified class feedback is unavailable.");
      const artifacts = await tx.select().from(s.ptArtifacts).where(eq(s.ptArtifacts.reviewId, current.id));
      if (!artifacts.some(x => x.kind === "graded") || !artifacts.some(x => x.kind === "report")) throw new WorkspaceError(409, "Generate and preview both PDFs for this saved version before approving.");
      const [approved] = await tx.insert(s.ptReviews).values({ assessmentId: a.id, data: current.data, approved: true, createdBy: scope.user.email }).returning();
      await tx.insert(s.ptArtifacts).values(artifacts.map(x => ({ reviewId: approved.id, kind: x.kind, fileId: x.fileId })));
      const queued=await preparePublication(tx,scope,a,series,approved.id,artifacts);
      return {...await update({currentReviewId:approved.id,approvedReviewId:approved.id,publicationStatus:"queued",publicationError:null}),...queued};
    }
    throw new WorkspaceError(400, "Unknown action.");
  });
}
