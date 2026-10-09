import {sourcePairEligibility} from '../workspace/course-policy-sql';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Database} from '@/lib/db';
import {loadActiveIdentityEntries} from '../db';
import {redactForModel,otherPeopleNamed} from '@/lib/feedback-autowriter/prompt';
import {WorkspaceError} from '../workspace/model';

type Participant={wise_student_id:string|null;student_name:string};
type Fields={topics:string;performance:string;improvement:string;homework:string};
const privateDetail=/\b(?:other students?|classmates?|peers?|compared|parents?|mother|father|siblings?|brother|sister)\b|เพื่อน|คนอื่น|น้องชาย|น้องสาว|ผู้ปกครอง|@|https?:\/\/|(?:\+?\d[\s()-]*){7,}/iu;
const personalTopic=/\b(?:he|she|they|his|her|their|students?|score[ds]?|struggl\w*|difficulty|understood|failed|passed)\b|นักเรียน|น้อง|คะแนน|เข้าใจ|ทำโจทย์|การบ้าน|ทำได้|ทำไม่ได้|ขาดเรียน|ป่วย/iu;

export function projectStudentFeedback(fields:Fields,participants:Participant[],studentId:string,tutorIds:Set<string>){
 const target=participants.find(p=>p.wise_student_id===studentId);
 if(!target?.student_name.trim())return null;
 const peers=participants.filter(p=>p.wise_student_id!==studentId&&(!p.wise_student_id||!tutorIds.has(p.wise_student_id)));
 if(peers.some(p=>!p.student_name.trim()))return null;
 const tutors=participants.filter(p=>p.wise_student_id&&tutorIds.has(p.wise_student_id)).map(p=>p.student_name);
 const redact=(text:string)=>{
  for(const peer of peers)text=redactForModel(text,{studentFullName:peer.student_name,tutorNames:[]}).replaceAll('[STUDENT_1]','[OTHER_STUDENT]');
  return redactForModel(text,{studentFullName:target.student_name,tutorNames:tutors});
 };
 const clean=(text:string,sharedTopic=false)=>redact(text).split(/\r?\n/u).flatMap(line=>[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(line)])
  .map(part=>part.segment.trim()).filter(line=>line&&!line.includes('[OTHER_STUDENT]')&&!privateDetail.test(line)&&!otherPeopleNamed(line,target.student_name).length&&(!sharedTopic||!line.includes('[STUDENT_1]')&&!personalTopic.test(line)))
  .join(' ').replaceAll('[STUDENT_1]','This student').replaceAll('[TUTOR]','the tutor');
 const shared=peers.length>0;
 // Session-level personal feedback has no student ID. Shared classes supply topics only.
 const entries=shared?[['Shared-class topics (not evidence of personal mastery)',clean(fields.topics,true)]]:
  Object.entries(fields).map(([key,value])=>[key,clean(value)]);
 const text=entries.filter(([,value])=>value).map(([key,value])=>`${key}: ${value}`).join('\n');
 return {shared,text};
}

const input=z.object({studentId:z.string().min(1).max(128),courseId:z.string().min(1).max(128),ownerKey:z.string().min(1).max(128),sessionIds:z.array(z.string().min(1).max(128)).min(1).max(8)});
const rows=(result:unknown)=>Array.isArray(result)?result:(result as {rows:Record<string,unknown>[]}).rows;
export async function exportStudentContext(url:URL,db:Database){
 let parsed;
 try{parsed=input.safeParse({...Object.fromEntries(url.searchParams),sessionIds:JSON.parse(url.searchParams.get('sessionIds')??'null')});}catch{throw new WorkspaceError(400,'The lesson context request is not valid.');}
 if(!parsed.success)throw new WorkspaceError(400,'The lesson context request is not valid.');
 const {studentId,courseId,ownerKey,sessionIds}=parsed.data,identities=await loadActiveIdentityEntries(db);
 const tutorIds=new Set(identities.flatMap(i=>[i.wiseTeacherId,...(i.wiseUserId?[i.wiseUserId]:[])]));
 const sessions=rows(await db.execute(sql`select pc.id,pc.wise_session_id,pc.scheduled_start_at,pc.canonical_tutor_key,pc.wise_teacher_user_id,f.id as feedback_id,f.topics,f.performance,f.improvement,f.homework from post_class_sessions pc join post_class_feedback_versions f on f.id=pc.latest_feedback_version_id and f.profile='teacher' and f.actor_wise_user_id=pc.wise_teacher_user_id where pc.source_status='ready' and pc.wise_deleted_at is null and pc.wise_class_id=${courseId} and pc.canonical_tutor_key=${ownerKey} and ${sourcePairEligibility(sql`${studentId}`,sql`${courseId}`)} and pc.wise_session_id=any(ARRAY(select jsonb_array_elements_text(${JSON.stringify(sessionIds)}::jsonb))) and exists(select 1 from post_class_session_participants p where p.session_id=pc.id and p.wise_student_id=${studentId}) and (exists(select 1 from pt_series se where se.owner_key=${ownerKey} and se.wise_class_id=${courseId} and se.wise_student_id=${studentId} and se.class_type in ('ONE_TO_ONE','GROUP','LIVE')) or exists(select 1 from credit_control_packages pkg join credit_control_snapshots sn on sn.id=pkg.snapshot_id and sn.active=true where pkg.wise_class_id=${courseId} and pkg.wise_student_id=${studentId} and pkg.class_type in ('ONE_TO_ONE','GROUP','LIVE')))`))
  .filter(row=>identities.some(i=>i.canonicalKey===row.canonical_tutor_key&&i.wiseUserId===row.wise_teacher_user_id));
 const ids=sessions.map(row=>row.id),participants=ids.length?rows(await db.execute(sql`select session_id,wise_student_id,student_name from post_class_session_participants where session_id=any(ARRAY(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[])`)):[];
 const context=sessions.flatMap(row=>{
  const people=participants.filter(p=>p.session_id===row.id) as (Participant&{session_id:string})[];
  const projection=projectStudentFeedback({topics:String(row.topics??''),performance:String(row.performance??''),improvement:String(row.improvement??''),homework:String(row.homework??'')},people,studentId,tutorIds);
  return projection?[{sessionId:String(row.wise_session_id),shared:projection.shared,feedback:projection.text?{id:String(row.feedback_id),sessionId:String(row.wise_session_id),date:new Date(String(row.scheduled_start_at)).toISOString(),text:projection.text}:null}]:[];
 });
 return {schemaVersion:1,sessions:context.map(({sessionId,shared})=>({sessionId,shared})),feedback:context.flatMap(row=>row.feedback?[row.feedback]:[])};
}
