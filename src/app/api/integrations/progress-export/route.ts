import {transferText} from "@/lib/progress-tests/transfer/text";
import { timingSafeEqual, createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { loadActiveIdentityEntries } from "@/lib/progress-tests/db";
import { sourceTransferControl } from "@/lib/progress-tests/transfer/control";
import { TRANSFER_TABLES } from "@/lib/progress-tests/transfer/tables";
import { rowHash } from "@/lib/progress-tests/transfer/hash";
import { readBlobBytes } from "@/lib/progress-tests/workspace/files";
import { workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";
export const maxDuration=300;
function exportJson(data:unknown){const bytes=new TextEncoder().encode(JSON.stringify(data));let offset=0;return new Response(new ReadableStream({pull(c){if(offset>=bytes.length){c.close();return;}c.enqueue(bytes.subarray(offset,offset+1024*1024));offset+=1024*1024;}}),{headers:{"Content-Type":"application/json","Cache-Control":"private, no-store"}});}
const rows=(r:unknown)=>(r as {rows:Record<string,unknown>[]}).rows;
export async function GET(request:Request) {
 try {
  const secret=process.env.PROGRESS_EXPORT_SECRET,provided=request.headers.get("authorization")?.replace(/^Bearer /,"");
  if(!secret||!provided||secret.length<32||Buffer.byteLength(secret)!==Buffer.byteLength(provided)||!timingSafeEqual(Buffer.from(secret),Buffer.from(provided)))throw new WorkspaceError(401,transferText.export_denied);
  const url=new URL(request.url),db=getDb(),type=url.searchParams.get("type")||"manifest";
  if(type==="roster"){
   const [identities,contacts]=await Promise.all([loadActiveIdentityEntries(db),db.select().from(s.tutorContacts)]);
   const students=rows(await db.execute(sql`select distinct st.wise_student_id as "wiseStudentId",st.student_name as name,st.email,st.activated as active from credit_control_students st join credit_control_snapshots snap on snap.id=st.snapshot_id and snap.active=true where exists(select 1 from credit_control_packages pkg where pkg.snapshot_id=st.snapshot_id and pkg.wise_student_id=st.wise_student_id and pkg.class_type='ONE_TO_ONE')`));
   return exportJson({schemaVersion:1,observedAt:new Date().toISOString(),identities,contacts,students});
  }
  if(type==="context"){
   // Only verified one-to-one context can leave the source service.
   const verified=await loadActiveIdentityEntries(db);
   const sessions=rows(await db.execute(sql`select pc.id,pc.wise_session_id,pc.wise_class_id,pc.canonical_tutor_key,pc.wise_teacher_user_id,pc.latest_feedback_version_id,pc.source_status,pc.wise_deleted_at,pc.scheduled_start_at from post_class_sessions pc where (exists(select 1 from pt_series se where se.owner_key=pc.canonical_tutor_key and se.wise_class_id=pc.wise_class_id and se.class_type='ONE_TO_ONE' and exists(select 1 from post_class_session_participants p where p.session_id=pc.id and p.wise_student_id=se.wise_student_id)) or exists(select 1 from credit_control_packages pkg join credit_control_snapshots sn on sn.id=pkg.snapshot_id and sn.active=true where pkg.wise_class_id=pc.wise_class_id and pkg.class_type='ONE_TO_ONE' and exists(select 1 from post_class_session_participants p where p.session_id=pc.id and p.wise_student_id=pkg.wise_student_id))) and (select count(*) from post_class_session_participants p where p.session_id=pc.id)=1`)).filter(r=>verified.some(i=>i.canonicalKey===r.canonical_tutor_key&&i.wiseUserId===r.wise_teacher_user_id));
   const ids=sessions.map(r=>r.id);
   const participants=ids.length?rows(await db.execute(sql`select id,session_id,wise_student_id from post_class_session_participants where session_id=any(ARRAY(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[])`)):[];
   const feedback=ids.length?rows(await db.execute(sql`select f.id,f.session_id,f.profile,f.actor_wise_user_id,f.topics,f.performance,f.improvement,f.homework from post_class_feedback_versions f join post_class_sessions pc on pc.latest_feedback_version_id=f.id where f.profile='teacher' and f.actor_wise_user_id=pc.wise_teacher_user_id and pc.id=any(ARRAY(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[])`)):[];
   return exportJson({sessions,participants,feedback});
  }
  const control=await sourceTransferControl(db);
  if(control.phase!=="paused"&&control.phase!=="moved")throw new WorkspaceError(409,transferText.pause_source);
  const running=rows(await db.execute(sql`select id from pt_jobs where status='running' union all select id from progress_test_sync_runs where status='running'`));
  if(running.length)throw new WorkspaceError(409,transferText.active_jobs);
  if(type==="file"){
   const id=url.searchParams.get("id");
   if(!id||!/^[a-f0-9-]{36}$/.test(id))throw new WorkspaceError(400,transferText.file_id);
   const [file]=await db.select().from(s.ptFiles).where(and(eq(s.ptFiles.id,id),eq(s.ptFiles.status,"ready")));
   if(!file)throw new WorkspaceError(404,transferText.file_missing);
   const bytes=await readBlobBytes(file);
   if(createHash("sha256").update(bytes).digest("hex")!==file.sha256||bytes.length!==file.size)throw new WorkspaceError(409,transferText.file_hash);
   let offset=0;return new Response(new ReadableStream({pull(c){if(offset>=bytes.length){c.close();return;}c.enqueue(new Uint8Array(bytes.subarray(offset,offset+1024*1024)));offset+=1024*1024;}}),{headers:{"Cache-Control":"private, no-store","Content-Type":file.mime,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
  }
  if(type==="records"){
   const table=url.searchParams.get("table");
   if(!(TRANSFER_TABLES as readonly string[]).includes(table||""))throw new WorkspaceError(400,transferText.table);
   const offset=Number(url.searchParams.get("offset")||0);
   if(!Number.isSafeInteger(offset)||offset<0)throw new WorkspaceError(400,transferText.page);
   return exportJson({table,rows:rows(await db.execute(sql.raw(`select * from "${table}" t order by row_to_json(t)::text collate "C" limit 200 offset ${offset}`)))});
  }
  if(type!=="manifest")throw new WorkspaceError(404,transferText.route);
  const manifest:Record<string,{count:number;sha256:string}>={};
  for(const table of TRANSFER_TABLES){const data=rows(await db.execute(sql.raw(`select * from "${table}"`)));manifest[table]={count:data.length,sha256:rowHash(data)};}
  return exportJson({schemaVersion:1,phase:control.phase,observedAt:new Date().toISOString(),tables:manifest});
 } catch(error){return workspaceError(error);}
}
