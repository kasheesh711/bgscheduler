import { and,eq } from "drizzle-orm";
import { z } from "zod";
import { getDb,type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { ptGuideProgress } from "@/lib/db/schema";
import type { Scope } from "./access";
import { assertRevision } from "./model";
export const GUIDE_VERSION=1;
export const guideCommand=z.object({status:z.enum(["started","skipped","completed"]),step:z.number().int().min(0).max(8),expectedRevision:z.number().int().min(0)}).strict();
export async function getGuide(scope:Scope,db:Database=getDb()) {
  const [row]=await db.select({status:ptGuideProgress.status,step:ptGuideProgress.step,revision:ptGuideProgress.revision}).from(ptGuideProgress).where(and(eq(ptGuideProgress.email,scope.user.email),eq(ptGuideProgress.guideVersion,GUIDE_VERSION)));
  return {guideVersion:GUIDE_VERSION,...(row??{status:"new" as const,step:0,revision:0})};
}
export async function saveGuide(scope:Scope,input:z.infer<typeof guideCommand>,db:Database=getDb()) {
  return withDatabaseTransaction(db,async tx=>{
    await tx.insert(ptGuideProgress).values({email:scope.user.email,guideVersion:GUIDE_VERSION,status:"new"}).onConflictDoNothing();
    const where=and(eq(ptGuideProgress.email,scope.user.email),eq(ptGuideProgress.guideVersion,GUIDE_VERSION));
    const [row]=await tx.select().from(ptGuideProgress).where(where).for("update");
    assertRevision(row.revision,input.expectedRevision);
    await tx.update(ptGuideProgress).set({status:input.status,step:input.step,revision:row.revision+1,updatedAt:new Date()}).where(where);
    return getGuide(scope,tx);
  });
}
