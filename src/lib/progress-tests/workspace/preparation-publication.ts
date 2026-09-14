import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { scopeForEmail, type Scope } from "./access";
import { assertOwner, WorkspaceError } from "./model";
import { readBlobBytes } from "./files";
import { destination, requireSection, publicationReadiness, publishingSettings } from "./publication";
import { fileHash, nativeWise, type NativeWise } from "./wise-publication";

type Publication = typeof s.ptPreparationPublications.$inferSelect;
const terminal = ["published", "removed", "cancelled"];
export async function latestPreparation(assessmentId: string, db: Database) {
  const [row] = await db.select().from(s.ptPreparationPublications).where(eq(s.ptPreparationPublications.assessmentId, assessmentId)).orderBy(desc(s.ptPreparationPublications.assessmentRevision)).limit(1);
  return row ?? null;
}
export async function preparationForScope(scope: Scope, id: string, db: Database) {
  const [row] = await db.select({ publication: s.ptPreparationPublications, assessment: s.ptAssessments, series: s.ptSeries }).from(s.ptPreparationPublications)
    .innerJoin(s.ptAssessments, eq(s.ptAssessments.id, s.ptPreparationPublications.assessmentId))
    .innerJoin(s.ptSeries, eq(s.ptSeries.id, s.ptAssessments.seriesId)).where(eq(s.ptPreparationPublications.id, id));
  if (!row) throw new WorkspaceError(404, "Preparation upload not found.");
  assertOwner(scope.keys, row.series.ownerKey);
  if (row.series.classType !== "ONE_TO_ONE") throw new WorkspaceError(422, "Paper upload requires a verified one-to-one course.");
  return row;
}
/** Caller holds the assessment row lock. No external I/O occurs in this transaction. */
export async function queuePreparation(db: Database, scope: Scope, assessment: typeof s.ptAssessments.$inferSelect, series: typeof s.ptSeries.$inferSelect, paperVersionId: string | null) {
  if (series.classType !== "ONE_TO_ONE") throw new WorkspaceError(422, "Paper upload requires a verified one-to-one course.");
  const latest = await latestPreparation(assessment.id, db);
  const [artifact] = paperVersionId ? await db.select({ file: s.ptFiles, version: s.ptPaperVersions }).from(s.ptPaperArtifacts)
    .innerJoin(s.ptFiles, eq(s.ptFiles.id, s.ptPaperArtifacts.fileId)).innerJoin(s.ptPaperVersions, eq(s.ptPaperVersions.id, s.ptPaperArtifacts.versionId))
    .innerJoin(s.ptPapers, eq(s.ptPapers.id, s.ptPaperVersions.paperId))
    .where(and(eq(s.ptPaperArtifacts.versionId, paperVersionId), eq(s.ptPaperArtifacts.kind, "paper"), eq(s.ptPapers.ownerKey, series.ownerKey))) : [];
  const [approval] = paperVersionId ? await db.select().from(s.ptPaperApprovals).where(eq(s.ptPaperApprovals.versionId, paperVersionId)) : [];
  if (paperVersionId && (!artifact || (!artifact.version.approved && !approval) || artifact.file.ownerKey !== series.ownerKey || artifact.file.status !== "ready" || artifact.file.mime !== "application/pdf" || !artifact.file.sha256 || !["paper", "generated"].includes(artifact.file.purpose)))
    throw new WorkspaceError(409, "Select a ready paper with its reviewed PDF preview before uploading to Wise.");
  if (latest?.status === "published" && latest.paperVersionId === paperVersionId && latest.fileId === artifact?.file.id && latest.sha256 === artifact?.file.sha256)
    return { preparationPublicationId: latest.id };
  let previousId = latest?.status === "published" ? latest.id : null;
  if (latest && !terminal.includes(latest.status)) {
    const [active] = await db.select().from(s.ptJobs).where(and(eq(s.ptJobs.targetId, latest.id), eq(s.ptJobs.kind, "publish-preparation"), inArray(s.ptJobs.status, ["queued", "running"]))).for("update");
    if (latest.operation === "upload" && latest.paperVersionId === paperVersionId && active)
      return { preparationPublicationId: latest.id, jobId: active.id };
    if (latest.phase !== "pending" || (active?.status === "running" && active.leaseUntil && active.leaseUntil > new Date()))
      throw new WorkspaceError(409, "Finish or retry the current Wise operation before changing this paper.");
    previousId = latest.previousId;
    await db.update(s.ptJobs).set({ status: "superseded", finishedAt: new Date(), leaseUntil: null }).where(and(eq(s.ptJobs.targetId, latest.id), eq(s.ptJobs.kind, "publish-preparation"), inArray(s.ptJobs.status, ["queued", "running"])));
    await db.update(s.ptPreparationPublications).set({ status: "cancelled", updatedAt: new Date() }).where(eq(s.ptPreparationPublications.id, latest.id));
  }
  const id = randomUUID();
  const [publication] = await db.insert(s.ptPreparationPublications).values({ id, assessmentId: assessment.id, assessmentRevision: assessment.revision + 1,
    operation: paperVersionId ? "upload" : "remove", paperVersionId, fileId: artifact?.file.id ?? null, sha256: artifact?.file.sha256 ?? null,
    name: artifact ? `Progress-Test-${assessment.cycle}-${artifact.version.paper.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 65)}-${id}.pdf` : null,
    previousId, createdBy: scope.user.email, ...(!paperVersionId && !previousId ? { status: "removed", phase: "completed" } : {}) }).returning();
  if (publication.status === "removed") return { preparationPublicationId: publication.id };
  const [job] = await db.insert(s.ptJobs).values({ ownerKey: series.ownerKey, kind: "publish-preparation", targetId: publication.id, expectedRevision: 0, input: { assessmentId: assessment.id }, createdBy: scope.user.email }).returning();
  return { preparationPublicationId: publication.id, jobId: job.id };
}

export async function assertPreparationCanSubmit(assessmentId: string, db: Database) {
  const latest = await latestPreparation(assessmentId, db);
  if (latest && !terminal.includes(latest.status)) throw new WorkspaceError(409, "Finish or remove the pending Wise paper upload before submitting student work.");
}

export async function runPreparationPublication(job: typeof s.ptJobs.$inferSelect, db: Database = getDb(), injectedWise?: NativeWise) {
  const row = await preparationForScope(await scopeForEmail(job.createdBy, db), job.targetId, db);
  let pub = row.publication;
  if (row.series.ownerKey !== job.ownerKey) throw new WorkspaceError(404, "Preparation upload not found.");
  const { wiseClassId: classId, wiseStudentId: studentId } = row.series;
  const leaseWhere = sql`exists (select 1 from ${s.ptJobs} j where j.id = ${job.id} and j.lease_token = ${job.leaseToken} and j.status = 'running' and j.lease_until > clock_timestamp())`;
  const guard = async () => {
    const scope = await scopeForEmail(job.createdBy, db); assertOwner(scope.keys, job.ownerKey);
    const [lease] = await db.select({ id: s.ptPreparationPublications.id }).from(s.ptPreparationPublications).where(and(eq(s.ptPreparationPublications.id, pub.id), leaseWhere));
    if (!lease) throw new WorkspaceError(409, "Preparation upload worker lease expired.");
    if ((await latestPreparation(row.assessment.id, db))?.id !== pub.id) throw new WorkspaceError(409, "A newer preparation replaced this operation.");
    const [assessment] = await db.select().from(s.ptAssessments).where(eq(s.ptAssessments.id, row.assessment.id));
    if (assessment.preparation.paperVersionId !== pub.paperVersionId) throw new WorkspaceError(409, "The selected paper changed. Reconcile the latest preparation.");
    const ready = publicationReadiness(await publishingSettings(db));
    if (!ready.ready) throw new WorkspaceError(503, ready.reason);
  };
  const save = async (patch: Partial<Publication>) => {
    const [updated] = await db.update(s.ptPreparationPublications).set({ ...patch, updatedAt: new Date() }).where(and(eq(s.ptPreparationPublications.id, pub.id), leaseWhere)).returning();
    if (!updated) throw new WorkspaceError(409, "Preparation upload worker lease expired.");
    pub = updated;
  };
  try {
    await guard();
    if (terminal.includes(pub.status)) return { type: "preparation-publication", preparationPublicationId: pub.id };
    const wise = injectedWise ?? nativeWise(guard);
    await wise.verifyCourse(classId, studentId);
    const sectionId = pub.sectionId ?? await destination(db, wise, classId, studentId, guard);
    requireSection(await wise.timeline(classId), sectionId);
    await save({ sectionId, status: "publishing", error: null });
    if (pub.operation === "upload" && !["verified", "removing", "completed"].includes(pub.phase)) {
      const [source] = await db.select().from(s.ptFiles).where(eq(s.ptFiles.id, pub.fileId!));
      if (!source || source.ownerKey !== job.ownerKey || source.sha256 !== pub.sha256 || !["paper", "generated"].includes(source.purpose) || source.status !== "ready") throw new WorkspaceError(422, "The reviewed paper's file evidence changed.");
      let matches = requireSection(await wise.timeline(classId), sectionId).entities.filter(e => pub.resourceId ? e._id === pub.resourceId : e.name === pub.name);
      if (matches.length > 1) throw new WorkspaceError(422, "Duplicate paper attachments require administrator review.");
      if (!matches.length) {
        if (pub.phase === "attaching" || pub.resourceId) throw new WorkspaceError(422, "Wise has not confirmed the previous attachment attempt. Check Content before retrying reconciliation.");
        const bytes = await readBlobBytes(source);
        if (fileHash(bytes) !== pub.sha256) throw new WorkspaceError(422, "The reviewed PDF failed its integrity check.");
        const token = await wise.upload(pub.name!, bytes);
        await guard(); await wise.verifyCourse(classId, studentId);
        requireSection(await wise.timeline(classId), sectionId);
        await save({ phase: "attaching" });
        await wise.attach(classId, sectionId, pub.name!, token);
        matches = requireSection(await wise.timeline(classId), sectionId).entities.filter(e => e.name === pub.name);
        if (matches.length !== 1) throw new WorkspaceError(422, "Wise has not confirmed exactly one paper attachment. Retry reconciliation.");
      }
      const remote = matches[0];
      if (remote.classId !== classId || remote.name !== pub.name) throw new WorkspaceError(422, "The Wise paper's destination or name changed.");
      await wise.verifyFile(remote, pub.sha256!); await guard();
      await save({ phase: "verified", resourceId: remote._id, wiseFileId: remote.file!._id, verifiedAt: new Date() });
    }
    // Recheck the replacement on recovery before retiring the previous paper.
    if (pub.operation === "upload") {
      const remote = requireSection(await wise.timeline(classId), sectionId).entities.find(e => e._id === pub.resourceId);
      if (!remote || remote.name !== pub.name || remote.classId !== classId) throw new WorkspaceError(422, "The replacement paper is no longer available in Wise.");
      await wise.verifyFile(remote, pub.sha256!);
    }
    if (pub.previousId) {
      const [previous] = await db.select().from(s.ptPreparationPublications).where(and(eq(s.ptPreparationPublications.id, pub.previousId), eq(s.ptPreparationPublications.assessmentId, pub.assessmentId)));
      if (!previous?.resourceId || !previous.sectionId || !previous.name || !previous.sha256) throw new WorkspaceError(422, "Previous paper attachment evidence needs administrator review.");
      await guard(); await wise.verifyCourse(classId, studentId);
      const remote = requireSection(await wise.timeline(classId), previous.sectionId).entities.find(e => e._id === previous.resourceId);
      await save({ phase: "removing" });
      if (remote) {
        if (remote.classId !== classId || remote.name !== previous.name) throw new WorkspaceError(422, "The previous Wise paper was changed outside this workspace.");
        await wise.verifyFile(remote, previous.sha256); await guard();
        await wise.remove(classId, previous.sectionId, previous.resourceId);
        if (requireSection(await wise.timeline(classId), previous.sectionId).entities.some(e => e._id === previous.resourceId)) throw new WorkspaceError(503, "Wise removal is not confirmed yet. Your changes are saved for retry.");
      }
      await guard();
      await db.update(s.ptPreparationPublications).set({ status: "removed", updatedAt: new Date() }).where(and(eq(s.ptPreparationPublications.id, previous.id), leaseWhere));
    }
    await guard(); await save({ phase: "completed", status: pub.operation === "upload" ? "published" : "removed", error: null });
    return { type: "preparation-publication", preparationPublicationId: pub.id };
  } catch (error) {
    const message = error instanceof WorkspaceError ? error.message : "Wise did not confirm this operation. Retry to reconcile its saved progress.";
    await save({ status: error instanceof WorkspaceError && error.status < 500 ? "needs_review" : job.attempts >= 3 ? "failed" : "retrying", error: message }).catch(() => undefined);
    throw error instanceof WorkspaceError ? error : new WorkspaceError(503, message);
  }
}
