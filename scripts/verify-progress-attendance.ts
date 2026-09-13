/** Read-only live Wise preflight. Never writes attendance or sends reminders. */
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/lib/db/schema";
import type { Database } from "../src/lib/db";
import { createWiseClient } from "../src/lib/wise/client";
import { loadWorkspaceAttendance } from "../src/lib/progress-tests/workspace/attendance";
async function main() {
  const url=process.env.TEST_DATABASE_URL;
  if(!url || new URL(url).hostname!=="localhost" || !new URL(url).pathname.endsWith("_test") || !process.env.PT_WISE_ENV_FILE)throw new Error("Set a local *_test database and PT_WISE_ENV_FILE");
  Object.assign(process.env,parse(await readFile(process.env.PT_WISE_ENV_FILE)));
  const pool=new Pool({connectionString:url});
  try {
    const client=createWiseClient({requestsPerSecond:3,maxConcurrency:4,signal:AbortSignal.timeout(650_000)});
    const now=new Date();
    const input=await loadWorkspaceAttendance(drizzle(pool,{schema}) as unknown as Database,client,process.env.WISE_INSTITUTE_ID!,now,now);
    const evidence={verifiedAt:now.toISOString(),rows:input.source.length,oneToOne:input.packages.filter(p=>p.classType==="ONE_TO_ONE").length,unknown:input.packages.filter(p=>!p.classType).length,postLaunchEnded:input.source.filter(r=>r.meetingStatus==="ENDED" && r.scheduledStartTime>=now).length};
    await writeFile("output/progress-tests-verification/attendance.json",JSON.stringify(evidence,null,2));console.log(evidence);
  } finally {await pool.end();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Attendance validation failed");process.exitCode=1;});
