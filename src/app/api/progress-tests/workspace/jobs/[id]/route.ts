import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { ptJobs,ptJobAttempts } from "@/lib/db/schema";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { ownerWhere } from "@/lib/progress-tests/workspace/data";
import { privateJson,uuidParam,workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";
import { jobProgress } from "@/lib/progress-tests/workspace/progress";
export async function GET(_request:Request,context:{params:Promise<{id:string}>}) {
  try {
    const scope=await requireWorkspace();const id=uuidParam((await context.params).id);const db=getDb();
    const [job]=await db.select().from(ptJobs).where(and(eq(ptJobs.id,id),ownerWhere(ptJobs.ownerKey,scope))).limit(1);
    if(!job) throw new WorkspaceError(404,"Job not found.");
    const attempts=await db.select().from(ptJobAttempts).where(eq(ptJobAttempts.jobId,id)).orderBy(desc(ptJobAttempts.attempt));
    return privateJson({job: await jobProgress(job,scope,db),attempts: attempts.map(a=>({attempt:a.attempt,status:a.status,startedAt:a.startedAt,finishedAt:a.finishedAt,error:a.error,model:a.model}))});
  } catch(error) {return workspaceError(error);}
}
