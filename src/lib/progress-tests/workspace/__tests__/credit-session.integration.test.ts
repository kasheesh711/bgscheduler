import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { loadCreditSessionAnchors } from "../credit-session";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
beforeAll(async () => { handle=await startTestDb();db=handle.db as unknown as Database; });
afterAll(async () => { if(handle) await stopTestDb(handle); });
beforeEach(async () => { await db.execute(sql`TRUNCATE credit_control_snapshots RESTART IDENTITY CASCADE`); });

const at=new Date("2026-09-20T05:00:00Z"),raw={_id:"session",type:"SESSION",createdAt:at.toISOString(),duration:3600000,classroom:{_id:"course"},credit:1};
async function snapshot(generatedAt:Date,status:"success"|"failed",withAnchor:boolean,metadata:Record<string,unknown>={}){
  const [snap]=await db.insert(s.creditControlSnapshots).values({active:false,generatedAt,createdAt:generatedAt,metadata}).returning();
  await db.insert(s.creditControlSyncRuns).values({status,snapshotId:snap.id,promotedSnapshotId:status==="success"?snap.id:null});
  await db.insert(s.creditControlSessions).values({snapshotId:snap.id,wiseSessionId:"session",wiseClassId:"course",wiseStudentId:"student",studentKey:"student",packageKey:"package",studentName:"Student",packageName:"Package",scheduledStartTime:at,scheduledEndTime:new Date(at.getTime()+3600000),meetingStatus:"ENDED",sessionKind:"past",creditApplied:1});
  // Wise re-mints history IDs; a later snapshot holds the renamed entry only.
  await db.insert(s.creditControlCreditHistory).values({snapshotId:snap.id,wiseCreditHistoryId:withAnchor?"session":"renamed",wiseStudentId:"student",wiseClassId:"course",packageKey:"package",credit:1,type:"SESSION",raw:{...raw,_id:withAnchor?"session":"renamed"}});
  return snap.id;
}

describe("credit session anchors", () => {
  it("keeps the last proven anchors when the active snapshot's run was marked failed after promotion", async () => {
    const proven=await snapshot(new Date("2026-10-08T06:57:00Z"),"success",true);
    const failed=await snapshot(new Date("2026-10-10T06:54:00Z"),"failed",false,{creditAnchorSnapshotIds:[proven]});
    await db.execute(sql`update credit_control_snapshots set active=(id=${failed})`);
    const anchors=await loadCreditSessionAnchors(db,new Date("2026-09-13T00:00:00Z"),new Date("2026-10-24T00:00:00Z"));
    expect(anchors.map(a=>[a.snapshotId,a.wiseSessionId,a.wiseClassId,a.wiseStudentId])).toEqual([[proven,"session","course","student"]]);
  });
  it("does not use a failed run's snapshot as evidence", async () => {
    const failed=await snapshot(new Date("2026-10-10T06:54:00Z"),"failed",true);
    await db.execute(sql`update credit_control_snapshots set active=(id=${failed})`);
    expect(await loadCreditSessionAnchors(db,new Date("2026-09-13T00:00:00Z"),new Date("2026-10-24T00:00:00Z"))).toEqual([]);
  });
});
