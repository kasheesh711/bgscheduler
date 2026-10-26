import {and,eq,inArray,ne,sql} from "drizzle-orm";
import {z} from "zod";
import {getDb,type Database} from "@/lib/db";
import {withDatabaseTransaction} from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import {bangkokDateKey} from "@/lib/room-capacity/dates";
import {fetchLineGroupSummary,LinePushError,pushLineTextMessage,replyLineMessage} from "./client";
import {isScheduleBotAdmin} from "./schedule-bot";

const iso=z.iso.datetime({offset:true});
const candidateSchema=z.object({ownerKey:z.string().min(1),tutorName:z.string().min(1),seriesId:z.uuid(),assessmentId:z.uuid().nullable(),cycle:z.number().int().positive(),studentName:z.string().min(1),studentEmail:z.string().min(3).max(320).nullable().optional(),courseName:z.string().min(1),wiseClassId:z.string().min(1),wiseStudentId:z.string().min(1),lessonId:z.string().min(1),scheduledAt:iso,updatedAt:iso,url:z.literal("https://www.begifted.app/#/progress-checks")}).strict();
const snapshotSchema=z.object({schemaVersion:z.literal(1),ownerKey:z.string(),observedAt:iso,syncFinishedAt:iso,candidates:z.array(candidateSchema).max(1000)}).strict();
export type ReminderCandidate=z.infer<typeof candidateSchema>;
export type ReminderStage="week_before"|"night_before";
type Delivery=typeof s.progressLineDeliveries.$inferSelect;
export const progressLineEnabled=()=>process.env.PROGRESS_LINE_REMINDERS_ENABLED==="true";
const retryWindow=24*3600000;

export function reminderDate(candidate:ReminderCandidate,stage:ReminderStage){
 const date=bangkokDateKey(new Date(candidate.scheduledAt));
 return new Date(Date.parse(`${date}T00:00:00Z`)-(stage==="week_before"?7:1)*86400000).toISOString().slice(0,10);
}
export function reminderAction(date:string,now:Date){
 const today=bangkokDateKey(now);
 if(date<today)return "missed";
 if(date>today||now.getTime()<Date.parse(`${today}T19:00:00+07:00`))return "wait";
 return "send";
}
export function reminderText(c:ReminderCandidate,stage:ReminderStage){
 const when=new Date(c.scheduledAt).toLocaleString("en-GB",{timeZone:"Asia/Bangkok",dateStyle:"long",timeStyle:"short"});
 return `Progress Check reminder — ${stage==="week_before"?"one week before":"tomorrow"}\n\nHello ${c.tutorName},\nStudent: ${c.studentName}\nStudent login email: ${c.studentEmail??"not linked yet. Ask BeGifted."}\nCourse: ${c.courseName}\nTest lesson: ${when} (Bangkok time)\nProgress Check: cycle ${c.cycle} (due after class ${c.cycle*8})\n\n${stage==="week_before"?"Prepare the test paper and marking guide. Explain the test topics to the student before the test lesson.":"Check that the test paper and marking guide are ready. Give the Progress Check in the scheduled lesson."}\n\nOpen Progress Checks: ${c.url}`;
}
export function sameOccurrence(a:ReminderCandidate,b:ReminderCandidate){return a.ownerKey===b.ownerKey&&a.seriesId===b.seriesId&&a.cycle===b.cycle&&a.lessonId===b.lessonId&&Date.parse(a.scheduledAt)===Date.parse(b.scheduledAt);}
export function parseReminderSnapshot(value:unknown,ownerKey:string,now=new Date()){
 const snapshot=snapshotSchema.parse(value),at=now.getTime();
 if(snapshot.ownerKey!==ownerKey||Date.parse(snapshot.observedAt)<at-60000||Date.parse(snapshot.observedAt)>at+300000||Date.parse(snapshot.syncFinishedAt)<at-3600000||Date.parse(snapshot.syncFinishedAt)>at+300000||snapshot.candidates.some(c=>c.ownerKey!==ownerKey||Date.parse(c.updatedAt)<at-3600000||Date.parse(c.updatedAt)>at+300000||Date.parse(c.scheduledAt)<=at)||new Set(snapshot.candidates.map(c=>`${c.seriesId}:${c.cycle}`)).size!==snapshot.candidates.length)throw new Error("The Progress Check data is stale or does not match the tutor.");
 return snapshot.candidates;
}
export async function loadLineReminderCandidates(ownerKey:string,now=new Date()){
 const address=process.env.PROGRESS_LINE_CANDIDATES_URL,secret=process.env.PROGRESS_LINE_REMINDER_SECRET;
 if(!address||!secret||secret.length<32)throw new Error("The Progress Check reminder connection is not configured.");
 const url=new URL(address);
 if(url.protocol!=="https:"||url.username||url.password||url.pathname!=="/api/progress-cron/line-reminder-candidates")throw new Error("The Progress Check reminder address is not valid.");
 url.searchParams.set("ownerKey",ownerKey);
 const response=await fetch(url,{headers:{authorization:`Bearer ${secret}`},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(`Progress Check reminder data returned HTTP ${response.status}.`);
 return parseReminderSnapshot(await response.json(),ownerKey,now);
}

export async function handleProgressGroupCommand(input:{db:Database;groupId:string;lineUserId:string;text:string;replyToken:string|null}){
 const match=/^\/progress\s+setup\s+(.+)$/i.exec(input.text.trim());
 if(!match)return false;
 if(!isScheduleBotAdmin(input.lineUserId))return true;
 const key=match[1].trim();
 const [contact]=await input.db.select().from(s.tutorContacts).where(and(eq(s.tutorContacts.canonicalKey,key),eq(s.tutorContacts.active,true)));
 if(!contact)throw new Error("The active tutor identity could not be verified.");
 const group=await fetchLineGroupSummary(input.groupId);
 const [previous]=await input.db.select().from(s.progressLineGroups).where(eq(s.progressLineGroups.canonicalKey,key));
 if(key==="Buzz"&&group.groupName!=="Kru Buzz x BeGifted")throw new Error("Buzz reminders must use Kru Buzz x BeGifted.");
 await input.db.insert(s.progressLineGroups).values({canonicalKey:key,groupId:group.groupId,groupName:group.groupName,enabled:true,registeredBy:input.lineUserId}).onConflictDoUpdate({target:s.progressLineGroups.canonicalKey,set:{groupId:group.groupId,groupName:group.groupName,enabled:true,registeredBy:input.lineUserId,updatedAt:new Date()}});
 // A reply is the setup receipt; it is not a preparation reminder.
 if(input.replyToken)await replyLineMessage({replyToken:input.replyToken,text:`Progress Check reminders registered for ${contact.displayName} in ${group.groupName}${previous&&previous.groupId!==group.groupId?` (moved from ${previous.groupName})`:""}. Send time: 19:00 Bangkok, seven days before and the night before. Only tutors with a registered group receive reminders.`});
 return true;
}

async function finish(db:Database,id:string,status:string,error:string|null=null){await db.update(s.progressLineDeliveries).set({status,error,leaseUntil:null,updatedAt:new Date()}).where(eq(s.progressLineDeliveries.id,id));}
export async function sendProgressLineReminders(db:Database=getDb(),deps:{now?:()=>Date;load?:typeof loadLineReminderCandidates;push?:typeof pushLineTextMessage}={}){
 if(!progressLineEnabled())return {disabled:true,sent:0};
 const clock=deps.now??(()=>new Date()),load=deps.load??loadLineReminderCandidates,push=deps.push??pushLineTextMessage;
 const groups=await db.select().from(s.progressLineGroups).where(eq(s.progressLineGroups.enabled,true));
 let sent=0,failed=0;
 for(const group of groups){
  let candidates:ReminderCandidate[];
  // One tutor's bad source data must not stop the other tutors' reminders.
  try{candidates=await load(group.canonicalKey,clock());}catch{failed++;continue;}
  const prior=await db.select().from(s.progressLineDeliveries).where(and(eq(s.progressLineDeliveries.canonicalKey,group.canonicalKey),inArray(s.progressLineDeliveries.status,["pending","retry","sending"])));
  for(const row of prior){
   if(row.status==="sending"&&row.leaseUntil&&row.leaseUntil>clock())continue;
   if(row.groupId!==group.groupId||!candidates.some(c=>sameOccurrence(c,row.candidate)))await finish(db,row.id,row.attempts?"uncertain":"cancelled",row.attempts?"The lesson changed after an attempted send. Check delivery before another send.":"The lesson or group changed.");
  }
  for(const candidate of candidates)for(const stage of ["week_before","night_before"] as const){
   const date=reminderDate(candidate,stage),action=reminderAction(date,clock());
   const blocked=await db.select({id:s.progressLineDeliveries.id}).from(s.progressLineDeliveries).where(and(eq(s.progressLineDeliveries.seriesId,candidate.seriesId),eq(s.progressLineDeliveries.cycle,candidate.cycle),eq(s.progressLineDeliveries.stage,stage),inArray(s.progressLineDeliveries.status,["sent","uncertain"])));
   if(blocked.length)continue;
   await db.insert(s.progressLineDeliveries).values({canonicalKey:group.canonicalKey,seriesId:candidate.seriesId,cycle:candidate.cycle,stage,lessonId:candidate.lessonId,scheduledAt:new Date(candidate.scheduledAt),reminderDate:date,groupId:group.groupId,text:reminderText(candidate,stage),candidate,status:action==="missed"?"missed":"pending",error:action==="missed"?"The reminder date has passed.":null}).onConflictDoUpdate({target:[s.progressLineDeliveries.seriesId,s.progressLineDeliveries.cycle,s.progressLineDeliveries.stage,s.progressLineDeliveries.lessonId,s.progressLineDeliveries.scheduledAt,s.progressLineDeliveries.groupId],set:{status:action==="missed"?"missed":"pending",error:action==="missed"?"The reminder date has passed.":null,candidate,text:reminderText(candidate,stage),updatedAt:clock()},setWhere:and(eq(s.progressLineDeliveries.status,"cancelled"),eq(s.progressLineDeliveries.attempts,0))});
  }
  const work=await db.select().from(s.progressLineDeliveries).where(and(eq(s.progressLineDeliveries.canonicalKey,group.canonicalKey),inArray(s.progressLineDeliveries.status,["pending","retry","sending"])));
  for(const row of work){
   const now=clock(),action=reminderAction(row.reminderDate,now);
   if(row.status==="sending"&&row.leaseUntil&&row.leaseUntil>now)continue;
   if(row.nextAttemptAt&&row.nextAttemptAt>now)continue;
   if(action==="missed"){await finish(db,row.id,row.attempts?"uncertain":"missed","The reminder date has passed. Check any attempted delivery.");continue;}
   if(action!=="send")continue;
   if(row.firstAttemptAt&&now.getTime()-row.firstAttemptAt.getTime()>=retryWindow){await finish(db,row.id,"uncertain","The LINE retry window has ended. Check delivery before another send.");continue;}
   // Persist the original key and attempt time before any external request.
   const [claim]=await db.update(s.progressLineDeliveries).set({status:"sending",attempts:sql`${s.progressLineDeliveries.attempts}+1`,firstAttemptAt:row.firstAttemptAt??now,leaseUntil:new Date(now.getTime()+120000),updatedAt:now}).where(and(eq(s.progressLineDeliveries.id,row.id),inArray(s.progressLineDeliveries.status,["pending","retry","sending"]),sql`(${s.progressLineDeliveries.leaseUntil} is null or ${s.progressLineDeliveries.leaseUntil} <= ${now})`)).returning();
   if(!claim)continue;
   try{
    const delivered=await withDatabaseTransaction(db,async tx=>{
     const lock=await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`${row.seriesId}:${row.cycle}:${row.stage}`})) as acquired`);
     if(!(lock as unknown as {rows:{acquired:boolean}[]}).rows[0]?.acquired)return false;
     const [currentGroup]=await tx.select().from(s.progressLineGroups).where(eq(s.progressLineGroups.canonicalKey,row.canonicalKey)).for("update");
     const [current]=await tx.select().from(s.progressLineDeliveries).where(eq(s.progressLineDeliveries.id,row.id)).for("update");
     if(!current||current.status!=="sending"||current.attempts!==claim.attempts)return false;
     const other=await tx.select({id:s.progressLineDeliveries.id}).from(s.progressLineDeliveries).where(and(eq(s.progressLineDeliveries.seriesId,row.seriesId),eq(s.progressLineDeliveries.cycle,row.cycle),eq(s.progressLineDeliveries.stage,row.stage),ne(s.progressLineDeliveries.id,row.id),inArray(s.progressLineDeliveries.status,["sent","uncertain"])));
     const [contact]=await tx.select().from(s.tutorContacts).where(and(eq(s.tutorContacts.canonicalKey,row.canonicalKey),eq(s.tutorContacts.active,true)));
     if(!progressLineEnabled()||!currentGroup?.enabled||currentGroup.groupId!==row.groupId||!contact||other.length){await finish(tx,row.id,"cancelled","The reminder is no longer enabled or another send is already recorded.");return false;}
     const fresh=await load(row.canonicalKey,clock());
     if(!fresh.some(c=>sameOccurrence(c,row.candidate))||reminderAction(row.reminderDate,clock())!=="send"){await finish(tx,row.id,current.attempts>1?"uncertain":"cancelled","The lesson changed before delivery.");return false;}
     const result=await push({to:row.groupId,text:row.text,retryKey:row.retryKey,signal:AbortSignal.timeout(10000)});
     await tx.update(s.progressLineDeliveries).set({status:"sent",sentAt:clock(),providerMessageId:result.sentMessageId,providerReceipt:result.response,error:null,leaseUntil:null,updatedAt:clock()}).where(eq(s.progressLineDeliveries.id,row.id));
     return true;
    });
    if(delivered)sent++;
   }catch(error){
    const permanent=error instanceof LinePushError&&error.status>=400&&error.status<500;
    const nextAttempt=new Date(clock().getTime()+Math.min(3600000,600000*2**Math.min(claim.attempts-1,3)));
    await db.update(s.progressLineDeliveries).set({status:permanent?"failed":"retry",error:permanent?`LINE refused the request (HTTP ${error.status}).`:"Delivery needs a retry with the saved LINE key.",leaseUntil:null,nextAttemptAt:nextAttempt,updatedAt:clock()}).where(and(eq(s.progressLineDeliveries.id,row.id),eq(s.progressLineDeliveries.status,"sending"),eq(s.progressLineDeliveries.attempts,claim.attempts)));
    failed++;
   }
  }
 }
 return {sent,failed};
}
