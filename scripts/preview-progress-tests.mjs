// Disposable local fixtures and sign-in for browser verification, never a deployed route.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { encode } from "next-auth/jwt";

const database = new URL(process.env.TEST_DATABASE_URL || "invalid:");
if (!["127.0.0.1","localhost"].includes(database.hostname) || !database.pathname.endsWith("_test")) throw new Error("Use a migrated disposable localhost database ending in _test.");
const appOrigin = process.env.PROGRESS_TEST_PREVIEW_ORIGIN || "http://localhost:3334";
if (new URL(appOrigin).hostname !== "localhost") throw new Error("The preview server must use localhost.");
const secret = process.env.AUTH_SECRET;
if (!secret) throw new Error("Set a local-only AUTH_SECRET shared with the Next preview server.");
const pool = new Pool({connectionString:database.toString()});
await pool.query("TRUNCATE pt_workspace_config, pt_series, pt_papers, pt_files, pt_jobs, progress_test_attendance_ledger, tutor_contacts, admin_users RESTART IDENTITY CASCADE");
await pool.query("INSERT INTO tutor_contacts(canonical_key,display_name,onsite_email,active) VALUES('a','Sample Tutor A','a@example.test',true),('b','Sample Tutor B','b@example.test',true)");
await pool.query("INSERT INTO admin_users(email,name,allowed_pages) VALUES('admin@example.test','Sample Admin','[\"/progress-tests\"]')");
await pool.query("INSERT INTO pt_workspace_config(id,activated_at,activated_by) VALUES('launch','2026-09-01','local-fixture')");
await pool.query("UPDATE pt_workspace_settings SET publishing_enabled=false,formatting_enabled=true");
const paperId = randomUUID(),versionId = randomUUID();
const paper = {title:"Algebra foundations",instructions:"Show your working. Answer each question.",warnings:[],questions:[{id:"q1",text:"Solve 3x + 6 = 21.",topic:"Linear equations",maxMarks:3,rubric:"1 mark for subtracting 6, 1 for dividing by 3, 1 for x = 5.",sourcePage:null,needsVisual:false},{id:"q2",text:"Expand and simplify 2(x + 4) + 3x.",topic:"Algebraic expressions",maxMarks:2,rubric:"1 mark for expanding 2x + 8, 1 for 5x + 8.",sourcePage:null,needsVisual:false}]};
await pool.query("INSERT INTO pt_papers(id,owner_key,title,revision) VALUES($1,'a',$2,1)",[paperId,paper.title]);
await pool.query("INSERT INTO pt_paper_versions(id,paper_id,revision,paper,approved,created_by) VALUES($1,$2,1,$3,true,'a@example.test')",[versionId,paperId,paper]);
const students = [{name:"Sample Maya",course:"Year 8 · Mathematics",count:6},{name:"Sample Nathan",course:"Year 10 · Physics",count:7},{name:"Sample Aria",course:"Year 9 · Chemistry",count:9},{name:"Sample Ethan",course:"Year 7 · Mathematics",count:4},{name:"Other tutor’s student",course:"Year 9 · Biology",count:8,owner:"b"}];
for (const [index,student] of students.entries()) {
  const id=randomUUID();const owner=student.owner || "a";
  const sessions=Array.from({length:student.count},(_,i)=>`fixture-${index}-${i+1}`);
  const upcoming=Array.from({length:8},(_,i)=>({id:`future-${index}-${i}`,date:new Date(Date.now()+(i+1)*86400000).toISOString()}));
  await pool.query("INSERT INTO pt_series(id,owner_key,wise_class_id,wise_student_id,student_name,course_name,tutor_name,count,session_ids,upcoming_sessions,class_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ONE_TO_ONE')",[id,owner,`course-${index}`,`student-${index}`,student.name,student.course,`Sample Tutor ${owner.toUpperCase()}`,student.count,JSON.stringify(sessions),JSON.stringify(upcoming)]);
  for (const [offset,session] of sessions.entries()) await pool.query("INSERT INTO progress_test_attendance_ledger(enrollment_key,wise_session_id,wise_class_id,wise_student_id,student_key,student_name,subject,scheduled_start_time,meeting_status,tutor_canonical_key,tutor_display_name) VALUES($1,$2,$3,$4,$4,$5,$6,$7,'COMPLETED',$8,$9)", [`course-${index}:student-${index}`,session,`course-${index}`,`student-${index}`,student.name,student.course,new Date(Date.UTC(2026,8,1+offset)),owner,`Sample Tutor ${owner.toUpperCase()}`]);
  for(let cycle=1;cycle<=Math.floor(student.count/8)+1;cycle++) await pool.query("INSERT INTO pt_assessments(series_id,cycle,preparation) VALUES($1,$2,$3)",[id,cycle,index===1?{paperVersionId:versionId,topics:"Linear equations and simplifying expressions",studentInformed:true}:{paperVersionId:null,topics:"",studentInformed:false}]);
}
await pool.end();
const server=http.createServer(async(req,res)=>{
  if (!["/teacher","/admin","/other-tutor"].includes(req.url || "")) {res.writeHead(404);res.end();return;}
  const admin=req.url==="/admin";const email=admin?"admin@example.test":req.url==="/other-tutor"?"b@example.test":"a@example.test";
  const cookie=await encode({secret,salt:"authjs.session-token",token:{email,name:admin?"Sample Admin":"Sample Tutor",sub:email,role:admin?"admin":"teacher",allowedPages:["/progress-tests"],...(admin?{adminAccessVersion:0}:{})},maxAge:3600});
  res.writeHead(302,{"Set-Cookie":`authjs.session-token=${cookie}; Path=/; HttpOnly; SameSite=Lax`,Location:`${appOrigin}/progress-tests`});res.end();
});
const signInPort=Number(process.env.PROGRESS_TEST_PREVIEW_SIGNIN_PORT || 3335);
server.listen(signInPort,"127.0.0.1",()=>console.log(`Local fixture sign-in: http://localhost:${signInPort}/teacher (or /admin, /other-tutor)`));
