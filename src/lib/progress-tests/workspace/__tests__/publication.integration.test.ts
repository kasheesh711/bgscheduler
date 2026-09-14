import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from "vitest";
import { eq,sql } from "drizzle-orm";
import { startTestDb,stopTestDb } from "@/tests/integration/db-helper";
import * as s from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { scopeForEmail } from "../access";
import { preparePublication,runPublication } from "../publication";
import { claimJob } from "../jobs";
import { getGuide,saveGuide } from "../guide";
import { fileHash,type NativeWise,type WiseSection } from "../wise-publication";
import type { Review } from "../model";
vi.mock("../files",async()=>({...await vi.importActual("../files"),readBlobBytes:vi.fn().mockResolvedValue(Buffer.from("approved PDF bytes"))}));
let handle:Awaited<ReturnType<typeof startTestDb>>,db:Database;
const bytes=Buffer.from("approved PDF bytes");
beforeAll(async()=>{handle=await startTestDb();db=handle.db as unknown as Database;});
afterAll(async()=>{await stopTestDb(handle);vi.unstubAllEnvs();});
beforeEach(async()=>{
  await db.execute(sql`TRUNCATE pt_series,pt_files,pt_jobs,pt_wise_destinations,pt_guide_progress,tutor_contacts,admin_users RESTART IDENTITY CASCADE`);
  await db.insert(s.tutorContacts).values({canonicalKey:"tutor",displayName:"Tutor",onsiteEmail:"tutor@example.test",active:true});
  await db.update(s.ptWorkspaceSettings).set({publishingEnabled:true,verifiedAt:new Date()});
  vi.stubEnv("BLOB_READ_WRITE_TOKEN","test");vi.stubEnv("WISE_USER_ID","test");vi.stubEnv("WISE_API_KEY","test");
});
async function setup(){
  const scope=await scopeForEmail("tutor@example.test",db);
  const [series]=await db.insert(s.ptSeries).values({ownerKey:"tutor",wiseClassId:"course",wiseStudentId:"student",studentName:"Student",courseName:"Maths",tutorName:"Tutor",classType:"ONE_TO_ONE"}).returning();
  const [assessment]=await db.insert(s.ptAssessments).values({seriesId:series.id,cycle:1}).returning();
  const [review]=await db.insert(s.ptReviews).values({assessmentId:assessment.id,approved:true,createdBy:scope.user.email,data:{marks:[],report:{summary:"Reviewed",strengths:[],focusAreas:[],nextSteps:["Practise"],contextLimitations:""},feedback:[],priorReviewIds:[],model:null,promptVersion:"manual",paperVersionId:crypto.randomUUID(),submissionId:crypto.randomUUID()} satisfies Review}).returning();
  const [file]=await db.insert(s.ptFiles).values({ownerKey:"tutor",name:"Reviewed.pdf",mime:"application/pdf",size:bytes.length,pathname:`progress-tests/${crypto.randomUUID()}/generated`,purpose:"generated",status:"ready",sha256:fileHash(bytes)}).returning();
  await db.update(s.ptAssessments).set({currentReviewId:review.id,approvedReviewId:review.id}).where(eq(s.ptAssessments.id,assessment.id));
  const queued=await preparePublication(db,scope,assessment,series,review.id,[{kind:"graded",fileId:file.id},{kind:"report",fileId:file.id}]);
  const job=(await claimJob(db))!;
  const sections:WiseSection[]=[];
  let sequence=0;
  const wise:NativeWise={remove:vi.fn(),verifyCourse:vi.fn().mockResolvedValue(undefined),timeline:vi.fn(async()=>structuredClone(sections)),createSection:vi.fn(async()=>{sections.push({_id:"section",name:"Progress Tests",enabled:true,entities:[]});return "section";}),upload:vi.fn().mockResolvedValue("private-token"),attach:vi.fn(async(classId,sectionId,name)=>{sections[0].entities.push({_id:`resource-${++sequence}`,name,type:"file",classId,file:{_id:`file-${sequence}`,path:"https://files.wiseapp.live/test",type:"pdf",size:bytes.length}});}),verifyFile:vi.fn().mockResolvedValue(undefined)};
  return {scope,series,assessment,review,queued,job,wise,sections};
}
describe("durable native publication",()=>{
  it("publishes both approved PDFs and keeps running independently of later draft revisions",async()=>{
    const x=await setup();await db.update(s.ptAssessments).set({revision:9,currentReviewId:null}).where(eq(s.ptAssessments.id,x.assessment.id));
    await runPublication(x.job,db,x.wise);
    expect(x.wise.attach).toHaveBeenCalledTimes(2);expect(x.wise.verifyFile).toHaveBeenCalledTimes(2);
    expect((await db.select().from(s.ptPublications))[0].status).toBe("published");
    expect((await db.select().from(s.ptAssessments))[0].currentReviewId).toBeNull();
    expect((await db.select().from(s.ptPublicationFiles)).every(f=>f.status==="verified")).toBe(true);
  });
  it("reconciles an attachment whose successful reply was lost without duplicating it",async()=>{
    const x=await setup();const attach=x.wise.attach;
    x.wise.attach=vi.fn(async(classId,sectionId,name,token)=>{await attach(classId,sectionId,name,token);if(vi.mocked(attach).mock.calls.length===1)throw new Error("Lost reply");});
    await expect(runPublication(x.job,db,x.wise)).rejects.toMatchObject({status:503});
    await runPublication(x.job,db,x.wise);
    expect(attach).toHaveBeenCalledTimes(2);expect(x.sections[0].entities).toHaveLength(2);
  });
  it("does not repeat a POST when its outcome cannot be proven",async()=>{
    const x=await setup();x.wise.attach=vi.fn().mockRejectedValue(new Error("Lost reply"));
    await expect(runPublication(x.job,db,x.wise)).rejects.toMatchObject({status:503});
    await expect(runPublication(x.job,db,x.wise)).rejects.toMatchObject({status:422});
    expect(x.wise.attach).toHaveBeenCalledTimes(1);expect((await db.select().from(s.ptPublications))[0].status).toBe("needs_review");
  });
  it("retains the first file on a second-file upload failure",async()=>{
    const x=await setup();vi.mocked(x.wise.upload).mockResolvedValueOnce("token").mockRejectedValueOnce(new Error("Expired upload URL")).mockResolvedValue("new-token");
    await expect(runPublication(x.job,db,x.wise)).rejects.toMatchObject({status:503});await runPublication(x.job,db,x.wise);
    expect(x.wise.attach).toHaveBeenCalledTimes(2);expect(x.sections[0].entities).toHaveLength(2);
  });
  it("pauses external work and refuses revoked access or lost leases",async()=>{
    const x=await setup();await db.update(s.ptWorkspaceSettings).set({publishingEnabled:false});
    await expect(runPublication(x.job,db,x.wise)).rejects.toMatchObject({status:503});expect(x.wise.verifyCourse).not.toHaveBeenCalled();
    await db.update(s.ptWorkspaceSettings).set({publishingEnabled:true});await db.update(s.tutorContacts).set({active:false});
    await expect(runPublication(x.job,db,x.wise)).rejects.toMatchObject({status:403});expect(x.wise.attach).not.toHaveBeenCalled();
  });
  it("retains versioned publications and reuses the course section",async()=>{
    const x=await setup();await runPublication(x.job,db,x.wise);await db.update(s.ptJobs).set({status:"completed"});
    const [review]=await db.insert(s.ptReviews).values({assessmentId:x.assessment.id,approved:true,createdBy:x.scope.user.email,data:x.review.data}).returning();
    const files=await db.select().from(s.ptPublicationFiles);await preparePublication(db,x.scope,x.assessment,x.series,review.id,files.map(f=>({kind:f.kind,fileId:f.fileId})));
    await runPublication((await claimJob(db))!,db,x.wise);
    expect(x.wise.createSection).toHaveBeenCalledTimes(1);expect(x.sections[0].entities).toHaveLength(4);expect((await db.select().from(s.ptPublications)).map(p=>p.version)).toEqual([1,2]);
  });
  it("persists first use, skip, resume and completion per authenticated account and revision",async()=>{
    const scope=await scopeForEmail("tutor@example.test",db);expect((await getGuide(scope,db)).status).toBe("new");
    await saveGuide(scope,{status:"skipped",step:0,expectedRevision:0},db);
    await saveGuide(scope,{status:"started",step:4,expectedRevision:1},db);
    expect(await getGuide(scope,db)).toMatchObject({step:4,status:"started",revision:2});
    await expect(saveGuide(scope,{status:"completed",step:7,expectedRevision:1},db)).rejects.toMatchObject({status:409});
    await saveGuide(scope,{status:"completed",step:7,expectedRevision:2},db);
    expect((await getGuide({...scope,user:{...scope.user,email:"other@example.test"}},db)).status).toBe("new");
  });
});
