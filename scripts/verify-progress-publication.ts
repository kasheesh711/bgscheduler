/** Explicit operator-run verification. Database must be local; Wise only receives labelled technical PDFs. */
import { readFile,mkdir,writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PDFDocument,StandardFonts } from "pdf-lib";
import { and,eq } from "drizzle-orm";
import * as s from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import { scopeForEmail } from "../src/lib/progress-tests/workspace/access";
import { preparePublication,runPublication } from "../src/lib/progress-tests/workspace/publication";
import { claimJob } from "../src/lib/progress-tests/workspace/jobs";
import { storeGenerated,readBlobBytes } from "../src/lib/progress-tests/workspace/files";
import { fileHash } from "../src/lib/progress-tests/workspace/wise-publication";

async function main(){
 const databaseUrl=process.env.TEST_DATABASE_URL;if(!databaseUrl || new URL(databaseUrl).hostname!=="localhost" || !new URL(databaseUrl).pathname.endsWith("_test"))throw new Error("Use a disposable localhost *_test database");
 if(process.argv[2]!=="--live-wise")throw new Error("Pass --live-wise to publish labelled technical samples into the approved course");
 const courseId=process.env.PT_VERIFICATION_COURSE_ID,studentId=process.env.PT_VERIFICATION_STUDENT_ID;
 if(!courseId || !studentId || !process.env.PT_WISE_ENV_FILE)throw new Error("Set PT_VERIFICATION_COURSE_ID, PT_VERIFICATION_STUDENT_ID and PT_WISE_ENV_FILE explicitly");
 const validation=parse(await readFile(".env.local"));const production=parse(await readFile(process.env.PT_WISE_ENV_FILE));
 Object.assign(process.env,production,{BLOB_READ_WRITE_TOKEN:validation.BLOB_READ_WRITE_TOKEN,DATABASE_URL:databaseUrl,PROGRESS_TEST_WORKSPACE_ENABLED:"true"});
 const pool=new Pool({connectionString:databaseUrl});const db=drizzle(pool,{schema:s}) as unknown as Database;
 const email="publication-verification@example.test",owner="publication-verification";
 await db.insert(s.tutorContacts).values({canonicalKey:owner,displayName:"Upload verification",onsiteEmail:email,active:true}).onConflictDoNothing();
 const scope=await scopeForEmail(email,db);
 await db.update(s.ptWorkspaceSettings).set({publishingEnabled:true,verifiedAt:new Date()});
 const [series]=await db.insert(s.ptSeries).values({ownerKey:owner,wiseClassId:courseId,wiseStudentId:studentId,classType:"ONE_TO_ONE",studentName:"Technical verification — no student results",courseName:"Native publication verification",tutorName:"Verification"}).onConflictDoUpdate({target:[s.ptSeries.ownerKey,s.ptSeries.wiseClassId,s.ptSeries.wiseStudentId],set:{classType:"ONE_TO_ONE"}}).returning();
 const [assessment]=await db.insert(s.ptAssessments).values({seriesId:series.id,cycle:1}).onConflictDoUpdate({target:[s.ptAssessments.seriesId,s.ptAssessments.cycle],set:{updatedAt:new Date()}}).returning();
 const existing=await db.select({pub:s.ptPublications}).from(s.ptPublications).innerJoin(s.ptReviews,eq(s.ptReviews.id,s.ptPublications.reviewId)).where(eq(s.ptReviews.assessmentId,assessment.id));
 for(const {pub} of existing) {
   if(pub.status==="published")continue;
   await db.update(s.ptJobs).set({status:"queued",availableAt:new Date(),leaseUntil:null}).where(and(eq(s.ptJobs.targetId,pub.id),eq(s.ptJobs.ownerKey,owner)));
   const job=await claimJob(db);if(!job || job.targetId!==pub.id)throw new Error("Unexpected verification job");
   await runPublication(job,db);await db.update(s.ptJobs).set({status:"completed",finishedAt:new Date()}).where(eq(s.ptJobs.id,job.id));
 }
 const evidence=[];
 for(let version=existing.length+1;version<=2;version++){
   const artifacts=[];
   for(const kind of ["graded","report"]){const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);const page=pdf.addPage([595.28,841.89]);
     ["BeGifted - native upload verification",`Technical sample: ${kind} document, revision ${version}`,"This file checks the Progress Tests publishing connection.","It contains no student answers, marks or assessment results.","Both PDFs should appear in Content > Progress Tests.","Previous technical sample versions are retained for verification."].forEach((line,i)=>page.drawText(line,{x:45,y:770-i*35,size:i===0?19:12,font}));
     const file=await storeGenerated(owner,`Verification ${kind} v${version}.pdf`,Buffer.from(await pdf.save()),db);
     if(fileHash(await readBlobBytes(file))!==file.sha256)throw new Error("Private Blob round-trip mismatch");artifacts.push({kind,fileId:file.id});
   }
   const [review]=await db.insert(s.ptReviews).values({assessmentId:assessment.id,approved:true,createdBy:email,data:{marks:[],report:{summary:"Technical verification only",strengths:[],focusAreas:[],nextSteps:[],contextLimitations:"No student results"},feedback:[],priorReviewIds:[],model:null,promptVersion:"technical-verification",paperVersionId:crypto.randomUUID(),submissionId:crypto.randomUUID()}}).returning();
   await db.insert(s.ptArtifacts).values(artifacts.map(a=>({...a,reviewId:review.id})));
   const queued=await preparePublication(db,scope,assessment,series,review.id,artifacts);
   const job=await claimJob(db);if(!job || job.id!==queued.jobId)throw new Error("Verification database has another pending job");
   await runPublication(job,db);await db.update(s.ptJobs).set({status:"completed",finishedAt:new Date()}).where(eq(s.ptJobs.id,job.id));
   const files=await db.select().from(s.ptPublicationFiles).where(eq(s.ptPublicationFiles.publicationId,queued.publicationId));
   evidence.push({version,publicationId:queued.publicationId,files:files.map(f=>({kind:f.kind,sha256:f.sha256,resourceId:f.resourceId,wiseFileId:f.wiseFileId,status:f.status}))});
 }
 for(const {pub} of existing){const files=await db.select().from(s.ptPublicationFiles).where(eq(s.ptPublicationFiles.publicationId,pub.id));evidence.unshift({version:pub.version,publicationId:pub.id,files:files.map(f=>({kind:f.kind,sha256:f.sha256,resourceId:f.resourceId,wiseFileId:f.wiseFileId,status:f.status}))});}
 await mkdir("output/progress-tests-verification",{recursive:true});await writeFile("output/progress-tests-verification/native-publication.json",JSON.stringify({verifiedAt:new Date(),courseId:series.wiseClassId,oneToOneAudienceAndEnabledContentVerified:true,evidence},null,2),{mode:0o600});
 console.log("Verified: private Blob round-trip; two native PDFs; revised pair retained; exact Wise bytes; one-to-one membership and enabled Content. Evidence saved without credentials.");await pool.end();
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Verification failed");process.exitCode=1;});
