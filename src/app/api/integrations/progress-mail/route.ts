import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";
export const maxDuration=60;
const inputSchema=z.object({to:z.string().email(),subject:z.string().max(200),html:z.string().max(150000),text:z.string().max(50000),idempotencyKey:z.string().regex(/^pt-workspace-reminder:|^progress-test-digest:/).max(250)}).strict();
export async function POST(request:Request) {
 const secret=process.env.PROGRESS_MAIL_SECRET,provided=request.headers.get("authorization")?.replace(/^Bearer /,"");
 if(!secret||secret.length<32||!provided||Buffer.byteLength(secret)!==Buffer.byteLength(provided)||!timingSafeEqual(Buffer.from(secret),Buffer.from(provided)))return Response.json({error:"Mail access is denied."},{status:401});
 try {
  const body=await request.text();if(body.length>200000)return Response.json({error:"The mail request is too large."},{status:413});
  const input=inputSchema.parse(JSON.parse(body));
  const sent=await createOutboundEmailSender("primary",{strictOutcome:true}).sendEmail(input);
  return Response.json(sent,{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){
  const rejected=error instanceof ScheduleEmailRejection||error instanceof z.ZodError;
  return Response.json({error:rejected?"The mail service rejected this request.":"Mail acceptance is not confirmed. Check the saved delivery record.",definitelyNotAccepted:rejected},{status:rejected?400:502});
 }
}
