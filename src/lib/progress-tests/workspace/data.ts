import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { chooseOwner, type Scope } from "./access";
import type { Command } from "./commands";
import { assertOwner, assertRevision, cyclePosition, stageFor, validateMarks, WorkspaceError, type FeedbackEvidence, type ReviewData, isOriginalPaper, isUploadedReview, structuredPaper, reviewTotals, scoreTotals, cleanReport } from "./model";
import { publicationReadiness, publishingSettings, preparePublication, publicationForScope } from "./publication";
import { formatModel, formatEffort, FORMAT_PROMPT_VERSION, FORMAT_INSTRUCTIONS } from "./ai";
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
  const [approval] = await db.select().from(s.ptPaperApprovals).where(eq(s.ptPaperApprovals.versionId, id));
  const [rubric] = await db.select().from(s.ptRubricApprovals).where(eq(s.ptRubricApprovals.versionId, id));
  return { ...row.version, approved: row.version.approved || !!approval, rubricApproved: row.version.approved || !!rubric };
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
  const settings = await publishingSettings(db);
  return { formatting: { enabled: settings.formattingEnabled, revision: settings.revision }, user: scope.user, activatedAt: config?.activatedAt ?? null, publication: publicationReadiness(settings),
    sourceIssues: scope.keys===null ? await db.select().from(s.ptSourceIssues).limit(200) : [],
    capabilities: { formatting: settings.formattingEnabled, uploads: !!process.env.BLOB_READ_WRITE_TOKEN, ai: !!(process.env.OPENAI_PROGRESS_TEST_API_KEY || process.env.OPENAI_API_KEY) },
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
    db.select({ version: s.ptPaperVersions, title: s.ptPapers.title, rubricApproved: sql<boolean>`exists (select 1 from ${s.ptRubricApprovals} ra where ra.version_id = ${s.ptPaperVersions.id})` }).from(s.ptPaperVersions).innerJoin(s.ptPapers, eq(s.ptPapers.id, s.ptPaperVersions.paperId))
      .where(and(eq(s.ptPapers.ownerKey, series.ownerKey), sql`(${s.ptPaperVersions.approved} or exists (select 1 from ${s.ptPaperApprovals} pa where pa.version_id = ${s.ptPaperVersions.id}))`)).orderBy(desc(s.ptPaperVersions.createdAt)),
  ]);
  const artifacts = reviews.length ? await db.select().from(s.ptArtifacts).where(inArray(s.ptArtifacts.reviewId, reviews.map(r => r.id))) : [];
  const publications = reviews.length ? await db.select().from(s.ptPublications).where(inArray(s.ptPublications.reviewId, reviews.map(r => r.id))) : [];
  const publicationFiles = publications.length ? await db.select().from(s.ptPublicationFiles).where(inArray(s.ptPublicationFiles.publicationId,publications.map(p=>p.id))) : [];
  const paperArtifacts = versions.length ? await db.select().from(s.ptPaperArtifacts).where(inArray(s.ptPaperArtifacts.versionId, versions.map(v => v.version.id))) : [];
  const preparingPapers = await db.select().from(s.ptPapers).where(and(eq(s.ptPapers.assessmentId, id), eq(s.ptPapers.ownerKey, series.ownerKey))).orderBy(desc(s.ptPapers.createdAt));
  return { ...assessmentView(row), paperArtifacts, preparingPapers, publicationFiles, submissions, reviews, sessions: sessions.map(x => ({ ...x, ordinal: series.sessionIds.indexOf(x.id) + 1 })), feedback, versions: versions.map(v => ({ ...v, version: { ...v.version, approved: true, rubricApproved: v.version.approved || v.rubricApproved } })), artifacts, publications };
}
export type AssessmentDetail = Awaited<ReturnType<typeof assessmentDetail>>;
export async function paperDetail(scope: Scope, id: string, db: Database = getDb()) {
  const paper = await getPaper(scope, id, db);
  const versions = await db.select().from(s.ptPaperVersions).where(eq(s.ptPaperVersions.paperId, id)).orderBy(desc(s.ptPaperVersions.revision));
  const ids = versions.map(v => v.id);
  const artifacts = ids.length ? await db.select().from(s.ptPaperArtifacts).where(inArray(s.ptPaperArtifacts.versionId, ids)) : [];
  const approvals = ids.length ? await db.select().from(s.ptPaperApprovals).where(inArray(s.ptPaperApprovals.versionId, ids)) : [];
  const rubrics = ids.length ? await db.select().from(s.ptRubricApprovals).where(inArray(s.ptRubricApprovals.versionId, ids)) : [];
  const jobs = await db.select({ id: s.ptJobs.id, status: s.ptJobs.status, kind: s.ptJobs.kind, stage: s.ptJobs.stage, input: sql<{ sourceFileId?: string }>`jsonb_build_object('sourceFileId', ${s.ptJobs.input}->'sourceFileId')`, createdAt: s.ptJobs.createdAt, error: s.ptJobs.error }).from(s.ptJobs).where(and(eq(s.ptJobs.ownerKey, paper.ownerKey), or(eq(s.ptJobs.targetId, id), sql`${s.ptJobs.input}->>'paperId' = ${id}`))).orderBy(desc(s.ptJobs.createdAt)).limit(30);
  return { ...paper, versions: versions.map(v => ({ ...v, approved: v.approved || approvals.some(a => a.versionId === v.id), rubricApproved: v.approved || rubrics.some(a => a.versionId === v.id) })), artifacts, jobs };
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
    if(c.action === "publishing" || c.action === "formatting") {
      if(scope.keys!==null)throw new WorkspaceError(403,"Administrator access is required.");
      const [settings]=await tx.select().from(s.ptWorkspaceSettings).where(eq(s.ptWorkspaceSettings.id,"workspace")).for("update");
      assertRevision(settings.revision,c.expectedRevision);
      if(c.action === "publishing" && c.enabled && !publicationReadiness(settings).configured)throw new WorkspaceError(409,publicationReadiness(settings).reason);
      await tx.update(s.ptWorkspaceSettings).set({...(c.action === "publishing" ? {publishingEnabled:c.enabled} : {formattingEnabled:c.enabled}),revision:settings.revision+1,updatedBy:scope.user.email,updatedAt:new Date()}).where(eq(s.ptWorkspaceSettings.id,"workspace"));
      return {revision:settings.revision+1};
    }
    if (c.action === "upload-intent") {
      const contextOwner = c.assessmentId ? (await getAssessment(scope, c.assessmentId, tx)).series.ownerKey : c.ownerKey;
      if (c.assessmentId && c.ownerKey && c.ownerKey !== contextOwner) throw new WorkspaceError(404, "Tutor does not own this assessment.");
      const ownerKey = await chooseOwner(scope, contextOwner, tx);
      if (c.purpose === "marked" && (!c.assessmentId || c.mime !== "application/pdf")) throw new WorkspaceError(400, "Upload the marked test as a PDF for this assessment.");
      if (c.purpose !== "work" && c.mime.startsWith("image/")) throw new WorkspaceError(400, "Papers and marking keys must be PDF or DOCX.");
      if (c.purpose === "work" && c.mime.includes("wordprocessingml")) throw new WorkspaceError(400, "Student work must be PDF, JPG or PNG.");
      const id = randomUUID();
      const pathname = `progress-tests/${id}/source`;
      await tx.insert(s.ptFiles).values({ id, ownerKey, name: c.name.replace(/[\r\n\x00-\x1f]/g, ""), mime: c.mime, size: c.size, pathname, purpose: c.purpose, assessmentId: c.assessmentId });
      return { id, pathname };
    }
    if (c.action === "create-paper") {
      const contextOwner = c.assessmentId ? (await getAssessment(scope, c.assessmentId, tx)).series.ownerKey : c.ownerKey;
      if (c.assessmentId && c.ownerKey && c.ownerKey !== contextOwner) throw new WorkspaceError(404, "Tutor does not own this assessment.");
      const ownerKey = await chooseOwner(scope, contextOwner, tx);
      if (c.assessmentId) {
        // Serialize double-clicks against the assessment; ownership is never supplied by the browser.
        await getAssessment(scope, c.assessmentId, tx, true);
        const [existing] = await tx.select().from(s.ptPapers).where(and(eq(s.ptPapers.assessmentId, c.assessmentId), eq(s.ptPapers.ownerKey, ownerKey))).orderBy(desc(s.ptPapers.createdAt)).limit(1);
        if (existing) return { id: existing.id };
      }
      const [paper] = await tx.insert(s.ptPapers).values({ ownerKey, title: c.title, assessmentId: c.assessmentId }).returning();
      return { id: paper.id };
    }
    if (c.action === "retry-job") {
      const [job] = await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.id, c.id), ownerWhere(s.ptJobs.ownerKey, scope))).for("update");
      if (!job) throw new WorkspaceError(404, "Job not found.");
      if (job.status !== "failed") throw new WorkspaceError(409, "Only failed jobs can be retried.");
      if(job.kind==="publish")await publicationForScope(scope,job.targetId,tx);
      if (job.kind === "format-paper" && !(await publishingSettings(tx)).formattingEnabled) throw new WorkspaceError(409, "Formatting is paused. Your original paper remains available.");
      const queued = await enqueue(tx, scope, job.kind, job.targetId, job.expectedRevision, job.ownerKey, job.input);
      const checkpoint = { ...job.checkpoint };
      delete checkpoint.aiStartedAt;
      delete checkpoint.deferrals;
      await tx.update(s.ptJobs).set({ checkpoint, timings: job.timings }).where(eq(s.ptJobs.id, queued.jobId));
      return queued;
    }
    if (c.action === "save-paper" || c.action === "process-paper" || c.action === "preview-paper") throw new WorkspaceError(410, "Paper editing has retired. Use your uploaded paper or opt into BeGifted formatting.");
    if (c.action === "attach-original" || c.action === "format-paper" || c.action === "approve-paper" || c.action === "approve-rubric") {
      const paper = await getPaper(scope, c.id, tx, true);
      if (c.action === "attach-original" || c.action === "format-paper") {
        const files = await ownedFiles(scope, [c.sourceFileId, c.keyFileId].filter((v): v is string => !!v), paper.ownerKey, tx);
        if (files[0].purpose !== "paper" || (files[1] && files[1].purpose !== "key") || files.some(f => f.mime.startsWith("image/") || !f.sha256)) throw new WorkspaceError(400, "Upload and validate the paper and optional marking key as PDF or DOCX.");
        if (c.action === "format-paper") {
          if (!(await publishingSettings(tx)).formattingEnabled) throw new WorkspaceError(409, "Formatting is paused. Your original paper remains available.");
          const [active] = await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.targetId, c.id), eq(s.ptJobs.kind, "format-paper"), inArray(s.ptJobs.status, ["queued", "running"])));
          if (active && active.input.sourceFileId === c.sourceFileId && active.input.keyFileId === c.keyFileId) return { id: paper.id, revision: paper.revision, jobId: active.id };
          if (active) throw new WorkspaceError(409, "Another beta draft is processing. You can use or replace your original now, and format again when it finishes.");
        }
        assertRevision(paper.revision, c.expectedRevision);
        const [original] = await tx.select().from(s.ptPaperVersions).where(and(eq(s.ptPaperVersions.paperId, paper.id), sql`${s.ptPaperVersions.paper}->>'kind' = 'original'`)).orderBy(desc(s.ptPaperVersions.revision)).limit(1);
        if (c.action === "attach-original" && original?.sourceFileId === c.sourceFileId && original?.keyFileId === c.keyFileId) return { id: paper.id, revision: paper.revision, versionId: original.id };
        if (c.action === "format-paper" && (!original || original.sourceFileId !== c.sourceFileId || original.keyFileId !== c.keyFileId)) throw new WorkspaceError(409, "Save this upload as your original paper before starting beta formatting.");
        const revision = paper.revision + 1;
        const versionId = randomUUID();
        await tx.update(s.ptPapers).set({ revision }).where(eq(s.ptPapers.id, paper.id));
        if (c.action === "attach-original") {
          await tx.insert(s.ptPaperVersions).values({ id: versionId, paperId: paper.id, revision, sourceFileId: c.sourceFileId, keyFileId: c.keyFileId, paper: { kind: "original", title: paper.title }, createdBy: scope.user.email });
          if (files[0].mime === "application/pdf") {
            await tx.insert(s.ptPaperArtifacts).values({ versionId, kind: "paper", fileId: files[0].id, rendererVersion: "original-pdf-v1" });
            return { id: paper.id, revision, versionId };
          }
          return { id: paper.id, revision, versionId, ...await enqueue(tx, scope, "convert-paper", versionId, revision, paper.ownerKey, { paperId: paper.id, sourceFileId: c.sourceFileId, sourceHash: files[0].sha256 }) };
        }
        const sourceVersionId = original?.sourceFileId === c.sourceFileId && original.keyFileId === c.keyFileId ? original.id : null;
        const queued = await enqueue(tx, scope, "format-paper", paper.id, revision, paper.ownerKey, { versionId, sourceVersionId, sourceFileId: c.sourceFileId, keyFileId: c.keyFileId, sourceHash: files[0].sha256, keyHash: files[1]?.sha256 ?? null, model: formatModel(), reasoningEffort: formatEffort(), promptVersion: FORMAT_PROMPT_VERSION, formatPrompt: FORMAT_INSTRUCTIONS });
        return { id: paper.id, revision, versionId, ...queued };
      }
      assertRevision(paper.revision, c.expectedRevision);
      const version = await paperVersionForOwner(c.versionId, paper.ownerKey, tx);
      if (version.paperId !== paper.id) throw new WorkspaceError(404, "Paper version not found.");
      const artifacts = await tx.select().from(s.ptPaperArtifacts).where(eq(s.ptPaperArtifacts.versionId, version.id));
      if (c.action === "approve-rubric") {
        const content = structuredPaper(version.paper);
        if (!version.approved || !artifacts.some(a => a.kind === "key")) throw new WorkspaceError(409, "Review the paper and open its private marking scheme first.");
        if (content.warnings.length || content.gradingWarnings?.length || content.questions.some(q => !q.rubric.trim() || !(q.maxMarks > 0))) throw new WorkspaceError(400, "Complete mark allocations and marking criteria in the source paper or key before AI grading.");
        await tx.insert(s.ptRubricApprovals).values({ versionId: version.id, createdBy: scope.user.email }).onConflictDoNothing();
      } else {
        if (!isOriginalPaper(version.paper) && version.paper.warnings.length) throw new WorkspaceError(400, "Resolve the flagged source-content issues, or use your original paper.");
        const artifact = artifacts.find(a => a.kind === "paper");
        if (!artifact) throw new WorkspaceError(409, "Wait for this paper's PDF preview before marking it ready.");
        const [file] = await ownedFiles(scope, [artifact.fileId], paper.ownerKey, tx);
        if (file.mime !== "application/pdf" || !file.sha256 || !file.pageCount) throw new WorkspaceError(409, "The PDF is not ready to preview.");
        await tx.insert(s.ptPaperApprovals).values({ versionId: version.id, createdBy: scope.user.email }).onConflictDoNothing();
      }
      return { id: paper.id, revision: paper.revision, versionId: version.id };
    }
    const { assessment: a, series } = await getAssessment(scope, c.id, tx, true);
    assertRevision(a.revision, c.expectedRevision);
    const update = async (patch: Partial<typeof s.ptAssessments.$inferInsert>) => {
      await tx.update(s.ptAssessments).set({ ...patch, revision: a.revision + 1, updatedAt: new Date() }).where(eq(s.ptAssessments.id, a.id));
      return { id: a.id, revision: a.revision + 1 };
    };
    if (c.action === "prepare") {
      if (a.currentSubmissionId) throw new WorkspaceError(409, "A submitted assessment keeps its approved paper. Create a new submission to correct student work.");
      const paper = await paperVersionForOwner(c.paperVersionId, series.ownerKey, tx);
      if (!paper.approved) throw new WorkspaceError(400, "Review and mark the paper ready in your library first.");
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
    if (c.action === "grade") {
      structuredPaper(paper.paper);
      if (!paper.rubricApproved) throw new WorkspaceError(409, "Review and approve the private rubric before AI grading, or upload a marked PDF.");
      return enqueue(tx, scope, "grade", a.id, a.revision, series.ownerKey, { submissionId: submission.id, paperVersionId: paper.id });
    }
    if (c.action === "save-review" || c.action === "save-marked-review") {
      const report = cleanReport(c.report);
      const common = { report, feedback: current?.data.feedback ?? await feedbackContext(series, a.cycle, tx), priorReviewIds: current?.data.priorReviewIds ?? [], model: null, promptVersion: "manual-v2", submissionId: submission.id, paperVersionId: paper.id };
      let data: ReviewData;
      if (c.action === "save-marked-review") {
        scoreTotals(c.earned, c.possible);
        const [file] = await ownedFiles(scope, [c.markedFileId], series.ownerKey, tx);
        if (file.purpose !== "marked" || file.mime !== "application/pdf" || file.assessmentId !== a.id || !file.sha256) throw new WorkspaceError(400, "Upload a marked PDF specifically for this assessment.");
        data = { ...common, kind: "uploaded", markedFileId: file.id, markedSha256: file.sha256, earned: c.earned, possible: c.possible };
      } else {
        validateMarks(structuredPaper(paper.paper), c.marks);
        data = { ...common, marks: c.marks };
      }
      const [review] = await tx.insert(s.ptReviews).values({ assessmentId: a.id, data, createdBy: scope.user.email }).returning();
      return update({ currentReviewId: review.id, publicationStatus: "not_ready", publicationError: null });
    }
    if (!current) throw new WorkspaceError(400, "Review and save the marks first.");
    if (current.data.paperVersionId !== paper.id || current.data.submissionId !== submission.id) throw new WorkspaceError(409, "These results belong to an earlier paper or submission. Save a new review before continuing.");
    if (c.action === "report") {
      if (isUploadedReview(current.data)) throw new WorkspaceError(409, "Write and save the report for this manually marked assessment.");
      reviewTotals(paper.paper, current.data, true);
      const feedback = await feedbackContext(series, a.cycle, tx);
      const prior = await tx.select({ review: s.ptReviews }).from(s.ptReviews).innerJoin(s.ptAssessments, eq(s.ptReviews.assessmentId, s.ptAssessments.id))
        .where(and(eq(s.ptAssessments.seriesId, series.id), sql`${s.ptAssessments.cycle} < ${a.cycle}`, eq(s.ptReviews.id, s.ptAssessments.approvedReviewId), eq(s.ptReviews.approved, true)))
        .orderBy(desc(s.ptAssessments.cycle)).limit(4);
      return enqueue(tx, scope, "report", a.id, a.revision, series.ownerKey, { reviewId: current.id, feedback, prior: prior.map(r => ({ id: r.review.id, report: r.review.data.report })) });
    }
    if (c.action === "preview-review") return enqueue(tx, scope, "render-review", a.id, a.revision, series.ownerKey, { reviewId: current.id });
    if (c.action === "approve") {
      if (!isUploadedReview(current.data) && !paper.rubricApproved) throw new WorkspaceError(409, "Approve the marking rubric before approving question-based results.");
      if(current.approved)throw new WorkspaceError(409,"These results are already approved. Save a new review for corrections.");
      reviewTotals(paper.paper, current.data, true);
      if (!current.data.report.summary.trim() || !current.data.report.nextSteps.some(step => step.trim())) throw new WorkspaceError(400, "Complete the report summary and next steps before approval.");
      if (!current.data.feedback.length && !current.data.report.contextLimitations.trim()) throw new WorkspaceError(400, "Record the limitation that verified class feedback is unavailable.");
      const artifacts = await tx.select().from(s.ptArtifacts).where(eq(s.ptArtifacts.reviewId, current.id));
      if (!artifacts.some(x => x.kind === "graded") || !artifacts.some(x => x.kind === "report")) throw new WorkspaceError(409, "Generate and preview both PDFs for this saved version before approving.");
      if (isUploadedReview(current.data)) {
        const graded = artifacts.find(x => x.kind === "graded")!;
        const [markedFile, gradedFile] = await ownedFiles(scope, [current.data.markedFileId, graded.fileId], series.ownerKey, tx);
        if (markedFile.purpose !== "marked" || markedFile.assessmentId !== a.id || markedFile.sha256 !== current.data.markedSha256 || gradedFile.sha256 !== current.data.markedSha256) throw new WorkspaceError(409, "The preview must exactly match this review's marked PDF. Generate both previews again.");
      }
      const [approved] = await tx.insert(s.ptReviews).values({ assessmentId: a.id, data: current.data, approved: true, createdBy: scope.user.email }).returning();
      await tx.insert(s.ptArtifacts).values(artifacts.map(x => ({ reviewId: approved.id, kind: x.kind, fileId: x.fileId })));
      const queued=await preparePublication(tx,scope,a,series,approved.id,artifacts);
      return {...await update({currentReviewId:approved.id,approvedReviewId:approved.id,publicationStatus:"queued",publicationError:null}),...queued};
    }
    throw new WorkspaceError(400, "Unknown action.");
  });
}
