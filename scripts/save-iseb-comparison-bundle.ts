/** Save a review bundle without approving it or changing any switches. */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { feedbackIsebRollouts } from "@/lib/db/schema";
import { evidenceHash } from "@/lib/feedback-autowriter/atom/evidence";
import { ISEB_ROLLOUT_ID, validateComparisonBundle } from "@/lib/feedback-autowriter/iseb-rollout";
const opt = (key: string) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
loadEnvConfig(opt("env-dir") ?? process.cwd());
async function main() {
  const dir=opt("dir"); if(!dir) throw new Error("--dir is required");
  const comparisons=fs.readdirSync(dir).filter(file=>/^[a-f0-9]{24}\.json$/u.test(file)).map(file=>JSON.parse(fs.readFileSync(path.join(dir,file),"utf8"))).filter(row=>row.result?.kind==="draft").sort((a,b)=>a.id.localeCompare(b.id));
  const receipt={comparisons}; const comparisonHash=evidenceHash(receipt);
  if(!validateComparisonBundle(receipt,comparisonHash)) throw new Error("The bundle must contain ten accepted Mimi drafts and ten accepted drafts covering Kevin, Gift, Ek and Peat.");
  const db=getDb();
  const [current]=await db.select().from(feedbackIsebRollouts).where(eq(feedbackIsebRollouts.id,ISEB_ROLLOUT_ID)).limit(1);
  if(current?.comparisonHash===comparisonHash) {
    console.log(JSON.stringify({saved:comparisons.length,comparisonHash,approved:Boolean(current.approvedAt),unchanged:true}));
    return;
  }
  const value={id:ISEB_ROLLOUT_ID,receipt,comparisonHash,approvedAt:null,approvedBy:null,
    cloudProofRunId:null,cloudProofReview:null,unattendedConfirmedBy:null};
  await db.insert(feedbackIsebRollouts).values(value).onConflictDoUpdate({target:feedbackIsebRollouts.id,set:value});
  console.log(JSON.stringify({saved:comparisons.length,comparisonHash,approved:false}));
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Bundle save failed");process.exitCode=1});
