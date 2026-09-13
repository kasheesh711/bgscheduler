import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { scopeForEmail, type Scope } from "../access";
import { executeCommand, feedbackContext, getAssessment, ownedFiles, workspaceOverview } from "../data";
import { claimJob, runJob } from "../jobs";
import { notifyWorkspaceTutors, syncWorkspace } from "../sync";
import { fileForScope } from "../files";
import type { Paper } from "../model";
import { assertLegacyActive } from "../cutover";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
let a: Scope, b: Scope;
const paper: Paper = { title:"Fractions",instructions:"Show working",warnings:[],questions:[{id:"q1",text:"Simplify 2/4",topic:"Fractions",maxMarks:2,rubric:"1 for cancellation, 1 for 1/2",sourcePage:null,needsVisual:false}] };
beforeAll(async () => { handle=await startTestDb();db=handle.db as unknown as Database; });
afterAll(async () => { if(handle) await stopTestDb(handle); });
beforeEach(async () => {
  await db.execute(sql`TRUNCATE pt_workspace_config, pt_source_issues, pt_attendance_evidence, pt_series, pt_files, pt_papers, pt_jobs, tutor_contacts, admin_users, credit_control_snapshots, snapshots, progress_test_attendance_ledger, progress_test_sync_runs, post_class_sessions RESTART IDENTITY CASCADE`);
  await db.insert(s.tutorContacts).values([{canonicalKey:"a",displayName:"Tutor A",onsiteEmail:"a@example.test",active:true},{canonicalKey:"b",displayName:"Tutor B",onsiteEmail:"b@example.test",active:true}]);
  a=await scopeForEmail("a@example.test",db);b=await scopeForEmail("b@example.test",db);
});
async function assessment(owner="a",count=8) {
  const [series] = await db.insert(s.ptSeries).values({ownerKey:owner,classType:"ONE_TO_ONE",wiseClassId:"course",wiseStudentId:"student",studentName:"Student",courseName:"Maths",tutorName:`Tutor ${owner}`,count,sessionIds:Array.from({length:count},(_,i)=>`session${i+1}`)}).returning();
  const [a] = await db.insert(s.ptAssessments).values({seriesId:series.id,cycle:1}).returning();
  return {series,a};
}
async function readyPaper() {
  const created = await executeCommand(a,{action:"create-paper",title:paper.title},db);
  const id = created.id!;
  await executeCommand(a,{action:"save-paper",id,expectedRevision:0,paper,sourceFileId:null,keyFileId:null,approved:false},db);
  await db.insert(s.ptJobs).values({kind:"render-paper",targetId:id,ownerKey:"a",expectedRevision:1,status:"completed",createdBy:a.user.email,result:{fileId:crypto.randomUUID()}});
  const saved = await executeCommand(a,{action:"save-paper",id,expectedRevision:1,paper,sourceFileId:null,keyFileId:null,approved:true},db);
  return saved.versionId!;
}
describe("tutor workspace database contracts", () => {
  it("reconciles source corrections and independent attendance while preserving fixed-cycle obligations", async () => {
    const now=new Date("2026-09-30T00:00:00Z"),launch=new Date("2026-09-01T00:00:00Z");
    const [snapshot]=await db.insert(s.snapshots).values({active:true}).returning();
    const [cc]=await db.insert(s.creditControlSnapshots).values({active:true,generatedAt:now}).returning();
    for(const key of ["a","b"]) {
      const [group]=await db.insert(s.tutorIdentityGroups).values({snapshotId:snapshot.id,canonicalKey:key,displayName:`Tutor ${key}`}).returning();
      await db.insert(s.tutorIdentityGroupMembers).values({groupId:group.id,snapshotId:snapshot.id,wiseTeacherId:`teacher-${key}`,wiseUserId:`user-${key}`,wiseDisplayName:`Tutor ${key}`});
    }
    const session=(n:number,student="student",teacher="a")=>({snapshotId:cc.id,wiseSessionId:`session${n}`,wiseClassId:"group-course",wiseStudentId:student,studentKey:student,packageKey:student,studentName:student,packageName:"Maths",title:"Group Maths",scheduledStartTime:new Date(launch.getTime()+n*86400000),meetingStatus:"ENDED",sessionKind:"past",creditApplied:1,wiseTeacherUserId:`user-${teacher}`,wiseTeacherId:`teacher-${teacher}`});
    await db.insert(s.creditControlPackages).values(["student","peer"].map(student=>({snapshotId:cc.id,packageKey:student,studentKey:student,wiseClassId:"group-course",wiseStudentId:student,studentName:student,packageName:"Maths",classType:"ONE_TO_ONE"})));
    await db.insert(s.creditControlSessions).values([...Array.from({length:9},(_,i)=>session(i+1)),session(1,"peer"),session(2,"peer"),session(10,"student","b"),session(-1)]);
    const run=async()=>{const [run]=await db.insert(s.progressTestSyncRuns).values({}).returning();return syncWorkspace({db,client:{} as never,instituteId:"test",syncRunId:run.id,now,sender:{sendEmail:vi.fn().mockResolvedValue({id:"sent"})}},launch,{source:await db.select().from(s.creditControlSessions),packages:await db.select().from(s.creditControlPackages),snapshotId:cc.id});};
    await run();
    const initial=await db.select().from(s.ptSeries);const series=initial.find(r=>r.ownerKey==="a" && r.wiseStudentId==="student")!;
    expect(series.count).toBe(9);expect(initial.find(r=>r.ownerKey==="b")?.count).toBe(1);expect(initial.find(r=>r.wiseStudentId==="peer")?.count).toBe(2);
    expect((await db.select().from(s.ptAssessments).where(eq(s.ptAssessments.seriesId,series.id))).map(r=>r.cycle)).toEqual([1,2]);
    await db.update(s.creditControlSessions).set({meetingStatus:"CANCELLED"}).where(eq(s.creditControlSessions.wiseSessionId,"session9"));
    await db.update(s.creditControlSessions).set({scheduledStartTime:new Date("2026-08-30")}).where(eq(s.creditControlSessions.wiseSessionId,"session8"));
    await run();
    expect((await db.select().from(s.ptSeries).where(eq(s.ptSeries.id,series.id)))[0].count).toBe(7);
    expect((await db.select().from(s.ptAssessments).where(eq(s.ptAssessments.seriesId,series.id)))).toHaveLength(2);
    expect((await db.select().from(s.ptAttendanceEvidence).where(eq(s.ptAttendanceEvidence.wiseSessionId,"session9")))).toHaveLength(2);
    await db.update(s.creditControlSessions).set({meetingStatus:"ENDED"}).where(eq(s.creditControlSessions.wiseSessionId,"session9"));
    await db.update(s.creditControlSessions).set({scheduledStartTime:session(8).scheduledStartTime}).where(eq(s.creditControlSessions.wiseSessionId,"session8"));
    await db.insert(s.creditControlSessions).values(Array.from({length:7},(_,i)=>session(i+11)));
    await run();expect((await db.select().from(s.ptSeries).where(eq(s.ptSeries.id,series.id)))[0].count).toBe(16);
    expect((await db.select().from(s.ptAssessments).where(eq(s.ptAssessments.seriesId,series.id)))).toHaveLength(3);
  });
  it("excludes group and unknown courses from counters, reminders and tutor views", async () => {
    const [snapshot]=await db.insert(s.snapshots).values({active:true}).returning();
    const [group]=await db.insert(s.tutorIdentityGroups).values({snapshotId:snapshot.id,canonicalKey:"a",displayName:"A"}).returning();
    await db.insert(s.tutorIdentityGroupMembers).values({groupId:group.id,snapshotId:snapshot.id,wiseTeacherId:"teacher-a",wiseUserId:"user-a",wiseDisplayName:"A"});
    const [run]=await db.insert(s.progressTestSyncRuns).values({}).returning();
    const sender={sendEmail:vi.fn()};
    const source=["GROUP","unknown"].map((course,i)=>({wiseSessionId:`s${i}`,wiseClassId:course,wiseStudentId:"student",studentKey:"student",studentName:"Student",subject:"Maths",title:"Maths",packageName:"Maths",scheduledStartTime:new Date("2026-09-02"),meetingStatus:"ENDED",sessionKind:"past",creditApplied:1,wiseTeacherUserId:"user-a",wiseTeacherId:"teacher-a"}));
    await syncWorkspace({db,client:{} as never,instituteId:"test",syncRunId:run.id,now:new Date("2026-09-03"),sender},new Date("2026-09-01"),{source,packages:[{wiseClassId:"GROUP",wiseStudentId:"student",classType:"GROUP"}],snapshotId:null});
    expect(await db.select().from(s.ptSeries)).toEqual([]);
    expect(await db.select().from(s.ptAssessments)).toEqual([]);
    expect(await db.select().from(s.ptSourceIssues)).toHaveLength(1);
    expect(sender.sendEmail).not.toHaveBeenCalled();
    expect((await workspaceOverview(a,db)).assessments).toEqual([]);
  });
  it("requires fresh contact ownership on reads, mutations, uploads, downloads and queue visibility", async () => {
    const row=await assessment();
    await expect(getAssessment(b,row.a.id,db)).rejects.toMatchObject({status:404});
    await expect(executeCommand(b,{action:"prepare",id:row.a.id,expectedRevision:0,paperVersionId:crypto.randomUUID(),topics:"Maths",studentInformed:true},db)).rejects.toMatchObject({status:404});
    const intent=await executeCommand(a,{action:"upload-intent",purpose:"work",name:"work.pdf",mime:"application/pdf",size:10},db);
    await expect(fileForScope(b,intent.id!,db)).rejects.toMatchObject({status:404});
    await expect(executeCommand(b,{action:"upload-intent",ownerKey:"a",purpose:"work",name:"x.pdf",mime:"application/pdf",size:10},db)).rejects.toMatchObject({status:404});
    expect((await workspaceOverview(b,db)).assessments).toEqual([]);
    await db.update(s.tutorContacts).set({active:false}).where(eq(s.tutorContacts.canonicalKey,"a"));
    await expect(scopeForEmail(a.user.email,db)).rejects.toMatchObject({status:403});
  });
  it("fails closed for ambiguous contacts and a disabled admin instead of falling back to tutor access", async () => {
    await db.update(s.tutorContacts).set({onlineEmail:a.user.email}).where(eq(s.tutorContacts.canonicalKey,"b"));
    await expect(scopeForEmail(a.user.email,db)).rejects.toMatchObject({status:403});
    await db.insert(s.adminUsers).values({email:b.user.email,disabled:true});
    await expect(scopeForEmail(b.user.email,db)).rejects.toMatchObject({status:403});
  });
  it("commits only one concurrent paper edit and requires a preview of the exact version before readiness", async () => {
    const created=await executeCommand(a,{action:"create-paper",title:"Draft"},db);
    const cmd={action:"save-paper" as const,id:created.id!,expectedRevision:0,paper,sourceFileId:null,keyFileId:null,approved:false};
    const outcomes=await Promise.allSettled([executeCommand(a,cmd,db),executeCommand(a,cmd,db)]);
    expect(outcomes.filter(o=>o.status==="fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o=>o.status==="rejected")).toHaveLength(1);
    await expect(executeCommand(a,{...cmd,expectedRevision:1,approved:true},db)).rejects.toMatchObject({status:409});
  });
  it("preserves submissions and reviewed versions while approvals are blocked from Wise publishing", async () => {
    const versionId=await readyPaper();const row=await assessment();
    await executeCommand(a,{action:"prepare",id:row.a.id,expectedRevision:0,paperVersionId:versionId,topics:"Fractions",studentInformed:true},db);
    const fileId=crypto.randomUUID();
    await db.insert(s.ptFiles).values({id:fileId,ownerKey:"a",name:"work.pdf",mime:"application/pdf",size:10,pageCount:2,pathname:`progress-tests/${fileId}/source`,status:"ready",purpose:"work"});
    await expect(executeCommand(a,{action:"submit",id:row.a.id,expectedRevision:1,sessionId:"another-tutors-session",fileIds:[fileId]},db)).rejects.toMatchObject({status:400});
    await expect(executeCommand(a,{action:"submit",id:row.a.id,expectedRevision:1,sessionId:"session8",fileIds:[fileId],pageOrder:[{fileId,page:1}]},db)).rejects.toMatchObject({status:400});
    await executeCommand(a,{action:"submit",id:row.a.id,expectedRevision:1,sessionId:"session8",fileIds:[fileId],pageOrder:[{fileId,page:2},{fileId,page:1}]},db);
    const marks=[{questionId:"q1",marks:1,explanation:"Correct cancellation, wrong final fraction.",answerReference:"Page 2, first answer",needsReview:false}];
    const report={summary:"Working is developing.",strengths:["Cancellation"],focusAreas:["Final fraction"],nextSteps:["Practise equivalent fractions"],contextLimitations:"Verified class feedback is unavailable."};
    await executeCommand(a,{action:"save-review",id:row.a.id,expectedRevision:2,marks,report},db);
    const reviewed=await getAssessment(a,row.a.id,db);
    await expect(executeCommand(a,{action:"approve",id:row.a.id,expectedRevision:3,confirmed:true},db)).rejects.toMatchObject({status:409});
    const generated=crypto.randomUUID();
    await db.insert(s.ptFiles).values({id:generated,ownerKey:"a",name:"review.pdf",mime:"application/pdf",size:10,pathname:`progress-tests/${generated}/generated`,status:"ready",purpose:"generated",sha256:"a".repeat(64)});
    await db.insert(s.ptArtifacts).values(["graded","report"].map(kind=>({reviewId:reviewed.assessment.currentReviewId!,kind,fileId:generated})));
    await executeCommand(a,{action:"approve",id:row.a.id,expectedRevision:3,confirmed:true},db);
    const approved=await getAssessment(a,row.a.id,db);
    expect(approved.assessment.publicationStatus).toBe("queued");
    expect(approved.series.count).toBe(8);
    await executeCommand(a,{action:"save-review",id:row.a.id,expectedRevision:4,marks:[{...marks[0],marks:2}],report},db);
    const reviews=await db.select().from(s.ptReviews).where(eq(s.ptReviews.assessmentId,row.a.id));
    expect(reviews).toHaveLength(3);expect(reviews.find(r=>r.approved)?.data.marks[0].marks).toBe(1);
    expect((await db.select().from(s.ptSubmissions))).toHaveLength(1);
    await expect(ownedFiles(b,[fileId],"a",db)).rejects.toMatchObject({status:404});
  });
  it("leases one worker, recovers an expired lease, bounds retries and supersedes stale work", async () => {
    const created=await executeCommand(a,{action:"create-paper",title:"Work"},db);
    await db.insert(s.ptJobs).values({ownerKey:"a",kind:"parse-paper",targetId:created.id!,expectedRevision:0,createdBy:a.user.email});
    const claimed=await Promise.all([claimJob(db),claimJob(db)]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    const first=claimed.find(Boolean)!;
    const recovered=await claimJob(db,new Date(Date.now()+301_000));
    expect(recovered?.leaseToken).not.toBe(first.leaseToken);expect(recovered?.attempts).toBe(2);
    const attempts=await db.select().from(s.ptJobAttempts).where(eq(s.ptJobAttempts.jobId,first.id));
    expect(attempts.find(r=>r.attempt===1)?.status).toBe("interrupted");
    expect(attempts.find(r=>r.attempt===2)?.status).toBe("running");
    await executeCommand(a,{action:"save-paper",id:created.id!,expectedRevision:0,paper,sourceFileId:null,keyFileId:null,approved:false},db);
    await runJob(recovered!,db);
    const [job]=await db.select().from(s.ptJobs).where(eq(s.ptJobs.id,first.id));expect(job.status).toBe("superseded");
  });
  it("fails a repeatedly abandoned job after three attempts and preserves each attempt", async () => {
    const created=await executeCommand(a,{action:"create-paper",title:"Interrupted conversion"},db);
    await db.insert(s.ptJobs).values({ownerKey:"a",kind:"render-paper",targetId:created.id!,expectedRevision:0,createdBy:a.user.email});
    const now=new Date(Date.now()+1000);
    const first=await claimJob(db,now);
    expect(first?.attempts).toBe(1);
    expect((await claimJob(db,new Date(now.getTime()+301_000)))?.attempts).toBe(2);
    expect((await claimJob(db,new Date(now.getTime()+602_000)))?.attempts).toBe(3);
    expect(await claimJob(db,new Date(now.getTime()+903_000))).toBeNull();
    const [job]=await db.select().from(s.ptJobs).where(eq(s.ptJobs.id,first!.id));
    expect(job.status).toBe("failed");
    expect(await db.select().from(s.ptJobAttempts).where(eq(s.ptJobAttempts.jobId,job.id))).toHaveLength(3);
  });
  it("rejects edits and deletion of launch and assessment evidence at the database boundary", async () => {
    const versionId=await readyPaper();
    await expect(assertLegacyActive(db)).resolves.toBeUndefined();
    await db.insert(s.ptWorkspaceConfig).values({id:"launch",activatedAt:new Date(),activatedBy:"admin@example.test"});
    await expect(assertLegacyActive(db)).rejects.toMatchObject({status:410});
    await expect(db.update(s.ptWorkspaceConfig).set({activatedAt:new Date("2030-01-01")})).rejects.toThrow();
    await expect(db.delete(s.ptWorkspaceConfig)).rejects.toThrow();
    await expect(db.update(s.ptPaperVersions).set({paper:{...paper,title:"Changed evidence"}}).where(eq(s.ptPaperVersions.id,versionId))).rejects.toThrow();
  });
  it("includes only the latest verified feedback for this tutor, student, course and cycle", async () => {
    const {series}=await assessment("a",9);
    const feedback=async (n:number, options:{owner?:string;course?:string;student?:string;author?:string;peer?:boolean}={})=>{
      const date=new Date(`2026-09-${String(n+1).padStart(2,"0")}T10:00:00Z`);
      const [session]=await db.insert(s.postClassSessions).values({wiseSessionId:`session${n}`,wiseClassId:options.course ?? "course",canonicalTutorKey:options.owner ?? "a",wiseTeacherUserId:"wise-a",scheduledStartAt:date,scheduledEndAt:date,deadlineAt:date,finalStatus:"ENDED",sourceStatus:"ready"}).returning();
      await db.insert(s.postClassSessionParticipants).values({sessionId:session.id,participantKey:"student",wiseStudentId:options.student ?? "student",studentName:"Student"});
      if(options.peer) await db.insert(s.postClassSessionParticipants).values({sessionId:session.id,participantKey:"peer",wiseStudentId:"peer",studentName:"Classmate"});
      const [version]=await db.insert(s.postClassFeedbackVersions).values({sessionId:session.id,versionKey:"v1",contentHash:`hash${n}`,observedAt:date,actorWiseUserId:options.author ?? "wise-a",topics:`Topic ${n}`,performance:"Source context"}).returning();
      await db.update(s.postClassSessions).set({latestFeedbackVersionId:version.id}).where(eq(s.postClassSessions.id,session.id));
      return {session,version};
    };
    const own=await feedback(1);
    await feedback(2,{owner:"b"});await feedback(3,{course:"unrelated-course"});
    await feedback(4,{student:"unrelated-student"});await feedback(5,{author:"wise-b"});
    await feedback(6,{peer:true});await feedback(9);
    expect((await feedbackContext(series,1,db)).map(f=>f.id)).toEqual([own.version.id]);
    const [revised]=await db.insert(s.postClassFeedbackVersions).values({sessionId:own.session.id,versionKey:"v2",contentHash:"revised",observedAt:new Date(),actorWiseUserId:"wise-a",performance:"Corrected source context"}).returning();
    await db.update(s.postClassSessions).set({latestFeedbackVersionId:revised.id}).where(eq(s.postClassSessions.id,own.session.id));
    const context=await feedbackContext(series,1,db);
    expect(context.map(f=>f.id)).toEqual([revised.id]);
    expect(context[0].text).toContain("Corrected source context");
    expect(await db.select().from(s.postClassFeedbackVersions).where(eq(s.postClassFeedbackVersions.id,own.version.id))).toHaveLength(1);
  });
  it("retries a failed catch-up reminder and sends only once per cycle", async () => {
    const row=await assessment("a",9);
    const sendEmail=vi.fn().mockRejectedValueOnce(new Error("temporary relay failure")).mockResolvedValue({id:"sent"});
    expect(await notifyWorkspaceTutors(db,{sendEmail})).toBe(0);
    expect((await getAssessment(a,row.a.id,db)).assessment.notificationError).toBeTruthy();
    expect(await notifyWorkspaceTutors(db,{sendEmail})).toBe(1);
    expect(await notifyWorkspaceTutors(db,{sendEmail})).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0].text).toContain("class 7");
    expect(sendEmail.mock.calls[1][0].idempotencyKey).toBe(`pt-workspace-reminder:${row.a.id}`);
  });
});
