import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { scopeForEmail, type Scope } from "./access";
import { assertOwner, WorkspaceError } from "./model";
import { readBlobBytes } from "./files";
import { fileHash, nativeWise, SECTION_NAME, type NativeWise, type WiseSection } from "./wise-publication";

export async function publishingSettings(db: Database = getDb()) {
  const [row] = await db.select().from(s.ptWorkspaceSettings).where(eq(s.ptWorkspaceSettings.id,"workspace"));
  if (!row) throw new WorkspaceError(503,"Progress Tests setup has not completed.");
  return row;
}
export function publicationReadiness(settings?: Pick<typeof s.ptWorkspaceSettings.$inferSelect,"publishingEnabled" | "verifiedAt" | "revision">) {
  const missing = [!process.env.BLOB_READ_WRITE_TOKEN && "Private file storage", !(process.env.WISE_USER_ID && process.env.WISE_API_KEY) && "Wise credentials", !settings?.verifiedAt && "Publication integration validation"].filter((x): x is string => !!x);
  const configured = missing.length === 0;
  return {ready:configured && !!settings?.publishingEnabled,configured,paused:!settings?.publishingEnabled,revision:settings?.revision ?? 0,missing,
    reason:!configured ? `Setup required: ${missing.join(", ")}.` : !settings?.publishingEnabled ? "Wise publishing is paused. Approved results remain queued." : "Approved results publish to the student's Wise Content → Progress Tests section."};
}
export async function preparePublication(db: Database, scope: Scope, assessment: typeof s.ptAssessments.$inferSelect, series: typeof s.ptSeries.$inferSelect, reviewId: string, artifacts: {kind:string;fileId:string}[]) {
  const [count] = await db.select({n:sql<number>`count(*)::int`}).from(s.ptPublications).innerJoin(s.ptReviews,eq(s.ptPublications.reviewId,s.ptReviews.id)).where(eq(s.ptReviews.assessmentId,assessment.id));
  const [pub] = await db.insert(s.ptPublications).values({reviewId,status:"queued",version:count.n+1}).returning();
  const files = [];
  for (const kind of ["graded","report"] as const) {
    const artifact = artifacts.find(a=>a.kind===kind);
    const [file] = artifact ? await db.select().from(s.ptFiles).where(eq(s.ptFiles.id,artifact.fileId)) : [];
    if (!file || file.ownerKey !== series.ownerKey || file.purpose !== "generated" || file.status !== "ready" || !file.sha256 || file.mime !== "application/pdf") throw new WorkspaceError(422,"Approved document evidence is incomplete. Rebuild both PDF previews.");
    const tutor = series.tutorName.replace(/[^a-z0-9]+/gi,"-").slice(0,50);
    files.push({publicationId:pub.id,kind,fileId:file.id,sha256:file.sha256,name:`Progress-Test-${assessment.cycle}-${tutor}-v${pub.version}-${pub.id}-${kind}.pdf`});
  }
  await db.insert(s.ptPublicationFiles).values(files);
  const [job] = await db.insert(s.ptJobs).values({ownerKey:series.ownerKey,kind:"publish",targetId:pub.id,expectedRevision:0,input:{assessmentId:assessment.id,reviewId},createdBy:scope.user.email}).returning();
  return {publicationId:pub.id,jobId:job.id};
}
export async function publicationForScope(scope: Scope, id: string, db: Database) {
  const [row] = await db.select({pub:s.ptPublications,review:s.ptReviews,assessment:s.ptAssessments,series:s.ptSeries}).from(s.ptPublications)
    .innerJoin(s.ptReviews,eq(s.ptReviews.id,s.ptPublications.reviewId)).innerJoin(s.ptAssessments,eq(s.ptAssessments.id,s.ptReviews.assessmentId)).innerJoin(s.ptSeries,eq(s.ptSeries.id,s.ptAssessments.seriesId))
    .where(eq(s.ptPublications.id,id));
  if (!row) throw new WorkspaceError(404,"Publication not found.");
  assertOwner(scope.keys,row.series.ownerKey);
  if (!row.review.approved || row.series.classType !== "ONE_TO_ONE") throw new WorkspaceError(422,"Publication requires an approved one-to-one assessment.");
  return row;
}
function sectionById(sections: WiseSection[], id: string): WiseSection | undefined {
  for (const s of sections) { if(s._id===id) return s; const child=sectionById(s.children??[],id); if(child)return child; }
}
export function requireSection(sections: WiseSection[], id: string) {
  const section=sectionById(sections,id);
  if (!section || section.enabled !== true || !Array.isArray(section.entities)) throw new WorkspaceError(422,"The Progress Tests section is missing or inaccessible. An administrator must review the destination.");
  return section;
}
export async function destination(db: Database, wise: NativeWise, classId: string, studentId: string, guard:()=>Promise<void>) {
  await db.insert(s.ptWiseDestinations).values({wiseClassId:classId,wiseStudentId:studentId}).onConflictDoNothing();
  const [binding]=await db.select().from(s.ptWiseDestinations).where(eq(s.ptWiseDestinations.wiseClassId,classId));
  if(binding.wiseStudentId!==studentId)throw new WorkspaceError(422,"The course's saved student destination changed. Administrator review is required.");
  const timeline=await wise.timeline(classId);
  if(binding.sectionId)return requireSection(timeline,binding.sectionId)._id;
  const candidates=timeline.filter(s=>s.name===SECTION_NAME);
  if(candidates.length>1)throw new WorkspaceError(422,"More than one Progress Tests section exists. An administrator must resolve the duplicate sections in Wise.");
  let sectionId=candidates.length ? requireSection(timeline,candidates[0]._id)._id : null;
  if(!sectionId) {
    // Persist the intent before the non-idempotent POST. An interrupted POST is
    // reconciled by section name, never repeated simply because its reply was lost.
    await guard();
    const [claimed]=await db.update(s.ptWiseDestinations).set({status:"creating",updatedAt:new Date()}).where(and(eq(s.ptWiseDestinations.wiseClassId,classId),eq(s.ptWiseDestinations.status,"new"))).returning();
    if(!claimed)throw new WorkspaceError(422,"A section creation has an uncertain outcome. Check Wise Content, then retry reconciliation.");
    await wise.verifyCourse(classId,studentId);
    sectionId=await wise.createSection(classId);
    requireSection(await wise.timeline(classId),sectionId);
  }
  await guard();
  await db.update(s.ptWiseDestinations).set({sectionId,status:"ready",updatedAt:new Date()}).where(eq(s.ptWiseDestinations.wiseClassId,classId));
  return sectionId;
}
export async function runPublication(job: typeof s.ptJobs.$inferSelect, db: Database = getDb(), injectedWise?: NativeWise) {
  const guard=async()=>{
    const scope=await scopeForEmail(job.createdBy,db);assertOwner(scope.keys,job.ownerKey);
    const [lease]=await db.select({id:s.ptJobs.id}).from(s.ptJobs).where(and(eq(s.ptJobs.id,job.id),eq(s.ptJobs.leaseToken,job.leaseToken!),eq(s.ptJobs.status,"running"),sql`${s.ptJobs.leaseUntil}>clock_timestamp()`));
    if(!lease)throw new WorkspaceError(409,"Publication worker lease expired.");
    const readiness=publicationReadiness(await publishingSettings(db));
    if(!readiness.ready)throw new WorkspaceError(503,readiness.reason);
  };
  const setStatus=async(status:string,error:string|null=null)=>{
    await withDatabaseTransaction(db,async tx=>{
      const [lease]=await tx.select().from(s.ptJobs).where(and(eq(s.ptJobs.id,job.id),eq(s.ptJobs.leaseToken,job.leaseToken!),eq(s.ptJobs.status,"running"))).for("update");
      if(!lease)return;
      await tx.update(s.ptPublications).set({status,error,updatedAt:new Date()}).where(eq(s.ptPublications.id,job.targetId));
      const [pub]=await tx.select().from(s.ptPublications).where(eq(s.ptPublications.id,job.targetId));
      if(pub)await tx.update(s.ptAssessments).set({publicationStatus:status,publicationError:error}).where(and(eq(s.ptAssessments.approvedReviewId,pub.reviewId),eq(s.ptAssessments.currentReviewId,pub.reviewId)));
    });
  };
  let currentFileId: string | null = null;
  try {
    await guard();
    const row=await publicationForScope(await scopeForEmail(job.createdBy,db),job.targetId,db);
    if(row.series.ownerKey!==job.ownerKey)throw new WorkspaceError(404,"Publication not found.");
    const {wiseClassId:classId,wiseStudentId:studentId}=row.series;
    const wise=injectedWise??nativeWise(guard);
    await wise.verifyCourse(classId,studentId);
    const sectionId=await destination(db,wise,classId,studentId,guard);
    await db.update(s.ptPublications).set({sectionId}).where(eq(s.ptPublications.id,row.pub.id));
    await setStatus("publishing");
    const files=await db.select().from(s.ptPublicationFiles).where(eq(s.ptPublicationFiles.publicationId,row.pub.id)).orderBy(s.ptPublicationFiles.kind);
    if(files.length!==2 || !files.some(f=>f.kind==="graded") || !files.some(f=>f.kind==="report"))throw new WorkspaceError(422,"Both approved document records are required.");
    const remoteIds:string[]=[];
    for(const file of files) {
      currentFileId=file.id;
      await guard();
      await db.update(s.ptPublicationFiles).set({attempts:sql`${s.ptPublicationFiles.attempts}+1`,updatedAt:new Date()}).where(eq(s.ptPublicationFiles.id,file.id));
      await wise.verifyCourse(classId,studentId);
      let section=requireSection(await wise.timeline(classId),sectionId);
      let matches=section.entities.filter(e=>file.resourceId ? e._id===file.resourceId : e.name===file.name);
      if(matches.length>1)throw new WorkspaceError(422,"Duplicate Wise attachments need administrator review.");
      if(!matches.length) {
        if(file.status==="attaching" || file.status==="verified" || file.resourceId)throw new WorkspaceError(422,"A Wise attachment has an uncertain or changed outcome. Check Content and retry reconciliation; it will not be uploaded twice.");
        const [source]=await db.select().from(s.ptFiles).where(eq(s.ptFiles.id,file.fileId));
        if(!source || source.ownerKey!==job.ownerKey || source.purpose!=="generated" || source.sha256!==file.sha256)throw new WorkspaceError(422,"Approved file evidence changed.");
        const bytes=await readBlobBytes(source);
        if(fileHash(bytes)!==file.sha256)throw new WorkspaceError(422,"Approved PDF integrity check failed.");
        const token=await wise.upload(file.name,bytes);
        await guard();
        await wise.verifyCourse(classId,studentId);
        requireSection(await wise.timeline(classId),sectionId);
        await db.update(s.ptPublicationFiles).set({status:"attaching",updatedAt:new Date()}).where(eq(s.ptPublicationFiles.id,file.id));
        await wise.attach(classId,sectionId,file.name,token);
        section=requireSection(await wise.timeline(classId),sectionId);
        matches=section.entities.filter(e=>e.name===file.name);
        if(matches.length!==1)throw new WorkspaceError(422,"Wise has not confirmed exactly one attachment. Retry reconciliation after checking Content.");
      }
      const remote=matches[0];
      if(remote.classId!==classId || remote.name!==file.name)throw new WorkspaceError(422,"Wise attachment destination or name changed.");
      await wise.verifyFile(remote,file.sha256);
      await guard();
      await db.update(s.ptPublicationFiles).set({status:"verified",resourceId:remote._id,wiseFileId:remote.file!._id,verifiedAt:new Date(),error:null,updatedAt:new Date()}).where(eq(s.ptPublicationFiles.id,file.id));
      remoteIds.push(remote._id);
    }
    await guard();
    await db.update(s.ptPublications).set({remoteIds}).where(eq(s.ptPublications.id,row.pub.id));
    await setStatus("published");
    return {type:"publication" as const,publicationId:row.pub.id,remoteIds};
  } catch(error) {
    const message=error instanceof WorkspaceError ? error.message : "Wise publication was interrupted. Saved checkpoints will be reconciled before retrying.";
    if(currentFileId)await db.update(s.ptPublicationFiles).set({error:message,updatedAt:new Date()}).where(and(eq(s.ptPublicationFiles.id,currentFileId),sql`exists (select 1 from ${s.ptJobs} j where j.id=${job.id} and j.lease_token=${job.leaseToken} and j.status='running')`));
    await setStatus(error instanceof WorkspaceError && error.status<500 ? "needs_review" : job.attempts>=3 ? "failed" : "retrying",message);
    throw error instanceof WorkspaceError ? error : new WorkspaceError(503,message);
  }
}
