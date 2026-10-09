import { sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { WorkspaceError } from "../workspace/model";
export type TransferPhase = "source" | "paused" | "moved";
export class MovedWorkflowError extends WorkspaceError {
 readonly code="workflow_moved";
 constructor(readonly targetUrl:string|null,paused=false){super(paused?503:410,paused?"Progress checks are paused for transfer.":"Progress checks moved. Open the question bank workflow.");}
}
export function assertSourcePhase(phase:TransferPhase,targetUrl:string|null=null) {
 if(phase!=="source")throw new MovedWorkflowError(targetUrl,phase==="paused");
}
export async function sourceTransferControl(db:Database=getDb()) {
  const exists=await db.execute(sql`select to_regclass('public.progress_transfer_control') as table_name`);
  if(!(exists as unknown as {rows:{table_name:string|null}[]}).rows[0]?.table_name)return {phase:"source" as TransferPhase,targetUrl:null as string|null};
  const result=await db.execute(sql`select phase,target_url as "targetUrl" from progress_transfer_control where id='writer'`);
  return ((result as unknown as {rows:{phase:TransferPhase;targetUrl:string|null}[]}).rows[0]??{phase:"source" as TransferPhase,targetUrl:null});
}
export async function assertSourceWriter(db:Database=getDb()) { const state=await sourceTransferControl(db);assertSourcePhase(state.phase,state.targetUrl); }
