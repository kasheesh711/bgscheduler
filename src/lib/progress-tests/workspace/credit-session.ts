import {z} from 'zod';
import {sql} from 'drizzle-orm';
import type {Database} from '@/lib/db';
import type {WiseClient} from '@/lib/wise/client';
import type {WiseSessionCredits} from '@/lib/credit-control/wise';
export type CreditSessionAnchor={wiseSessionId:string;wiseClassId:string;wiseStudentId:string;raw:Record<string,unknown>};
function signature(raw:Record<string,unknown>){
 const classroom=raw.classroom as {_id?:unknown}|undefined,at=new Date(raw.createdAt as string).getTime();
 return raw.type==='SESSION'&&Number.isFinite(at)&&typeof raw.duration==='number'&&Number.isFinite(raw.duration)&&raw.duration>=0&&typeof classroom?._id==='string'?JSON.stringify([at,raw.duration,classroom._id]):null;
}
export function sessionCreditMap(history:WiseSessionCredits['sessionCreditHistory'],anchors:CreditSessionAnchor[],courseId:string,studentId:string){
 const credits=new Map(history.filter(h=>!h.type||h.type==='SESSION').map(h=>[h._id,Math.max(0,h.credit)]));
 const directIds=new Set(anchors.filter(a=>a.wiseClassId===courseId&&a.wiseStudentId===studentId&&credits.has(a.wiseSessionId)).map(a=>a.wiseSessionId));
 const unresolved=new Set<string>(),originals=new Map<string,Set<string>>();
 for(const anchor of anchors){
  if(anchor.wiseClassId!==courseId||anchor.wiseStudentId!==studentId||anchor.raw._id!==anchor.wiseSessionId)continue;
  if(directIds.has(anchor.wiseSessionId))continue;
  const key=signature(anchor.raw);if(!key){unresolved.add(anchor.wiseSessionId);continue;}
  const ids=originals.get(key)??new Set<string>();ids.add(anchor.wiseSessionId);originals.set(key,ids);
 }
 const current=new Map<string,typeof history>();
 for(const entry of history){const key=signature(entry);if(key){const entries=current.get(key)??[];entries.push(entry);current.set(key,entries);}}
 for(const [key,ids] of originals){
  const missing=[...ids].filter(id=>!credits.has(id));if(!missing.length)continue;
  const entries=(current.get(key)??[]).filter(entry=>!directIds.has(entry._id));
  // Wise can rename history IDs. Link only an exact, unique retained SESSION record.
  if(missing.length!==1||entries.length!==1){for(const id of missing)unresolved.add(id);continue;}
  credits.set(missing[0],Math.max(0,entries[0].credit));
 }
 return {credits,unresolved};
}

const SessionDetail=z.object({data:z.object({_id:z.string(),classId:z.string(),attendanceRecorded:z.literal(true),meetingStatus:z.literal('ENDED'),participants:z.array(z.unknown())})});
export async function readSessionCredits(client:WiseClient,courseId:string,studentId:string,sessionId:string){
 const response=await client.get<unknown>(`/user/classes/${encodeURIComponent(courseId)}/sessions/${encodeURIComponent(sessionId)}`,{showFeedbackConfig:'true',showFeedbackSubmission:'true'});
 const detail=SessionDetail.parse(response).data,students=detail.participants.filter(p=>!!p&&typeof p==='object'&&'wiseUserId' in p&&p.wiseUserId===studentId);
 if(detail._id!==sessionId||detail.classId!==courseId||students.length!==1)throw new Error('Current attendance does not identify one student and class.');
 return Math.max(0,z.object({credits:z.number().finite()}).parse(students[0]).credits);
}

export type StoredCreditSessionAnchor = CreditSessionAnchor & {snapshotId:string};
export async function loadCreditSessionAnchors(db:Database,from:Date,to:Date,snapshotIds:string[]=[]):Promise<StoredCreditSessionAnchor[]> {
 // Keep actual source snapshot references; do not invent first-observed provenance.
 const result=await db.execute(sql`with selected as materialized (
  select sn.id,sn.metadata from credit_control_snapshots sn
  where (sn.active or sn.id=any(ARRAY(select jsonb_array_elements_text(${JSON.stringify(snapshotIds)}::jsonb)::uuid)))
   and coalesce((sn.metadata->>'failedCreditPairs')::integer,0)=0
   and exists(select 1 from credit_control_sync_runs cr where cr.promoted_snapshot_id=sn.id and cr.status='success')
 ), retained as materialized (
  select sn.id from credit_control_snapshots sn
  where (sn.id in(select id from selected) or sn.id in(
   select jsonb_array_elements_text(coalesce(metadata->'creditAnchorSnapshotIds','[]'::jsonb))::uuid from selected))
   and coalesce((sn.metadata->>'failedCreditPairs')::integer,0)=0
   and exists(select 1 from credit_control_sync_runs cr where cr.promoted_snapshot_id=sn.id and cr.status='success')
 ) select sn.id as "snapshotId",se.wise_session_id as "wiseSessionId",h.wise_class_id as "wiseClassId",h.wise_student_id as "wiseStudentId",h.raw
 from retained sn join credit_control_sessions se on se.snapshot_id=sn.id
 join credit_control_credit_history h on h.snapshot_id=sn.id and h.wise_class_id=se.wise_class_id
  and h.wise_student_id=se.wise_student_id and h.wise_credit_history_id=se.wise_session_id
 where h.credit>0 and h.raw->>'_id'=se.wise_session_id and h.raw->>'type'='SESSION'
  and se.scheduled_start_time>=${from} and coalesce(se.scheduled_end_time,se.scheduled_start_time)<=${to}`);
 return result.rows as StoredCreditSessionAnchor[];
}
