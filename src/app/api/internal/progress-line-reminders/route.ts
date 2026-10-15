import {NextRequest,NextResponse} from "next/server";
import {rejectInvalidCronSecret} from "@/lib/internal/cron-auth";
import {withCronInvocationAudit} from "@/lib/data-health/cron-audit";
import {sendProgressLineReminders} from "@/lib/line/progress-reminders";
export const maxDuration = 60;
export async function GET(request:NextRequest){
 const rejected=rejectInvalidCronSecret(request);if(rejected)return rejected;
 return withCronInvocationAudit({jobKey:"progress_line_reminders",triggerSource:"cron",requestMethod:request.method},async()=>{
  try{const result=await sendProgressLineReminders();return NextResponse.json(result,{status:result.failed?502:200});}
  catch{return NextResponse.json({error:"Progress Check LINE reminders need a source or delivery check."},{status:502});}
 });
}
