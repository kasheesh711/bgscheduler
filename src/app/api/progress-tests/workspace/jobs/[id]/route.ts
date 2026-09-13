import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { ptJobs,ptJobAttempts } from "@/lib/db/schema";
import { requireWorkspace } from "@/lib/progress-tests/workspace/access";
import { ownerWhere } from "@/lib/progress-tests/workspace/data";
import { privateJson,uuidParam,workspaceError } from "@/lib/progress-tests/workspace/http";
import { WorkspaceError } from "@/lib/progress-tests/workspace/model";
export async function GET(_request:Request,context:{params:Promise<{id:string}>}) {
  try {
    const scope=await requireWorkspace();const id=uuidParam((await context.params).id);const db=getDb();
    const [job]=await db.select().from(ptJobs).where(and(eq(ptJobs.id,id),ownerWhere(ptJobs.ownerKey,scope))).limit(1);
    if(!job) throw new WorkspaceError(404,"Job not found.");
    const attempts=await db.select().from(ptJobAttempts).where(eq(ptJobAttempts.jobId,id)).orderBy(desc(ptJobAttempts.attempt));
    return privateJson({job,attempts});
  } catch(error) {return workspaceError(error);}
}
