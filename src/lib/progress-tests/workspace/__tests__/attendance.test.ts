import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/credit-control/wise", async original => ({ ...await original<typeof import("@/lib/credit-control/wise")>(), fetchCreditStudents:vi.fn(), fetchCreditSessions:vi.fn(), fetchSessionCredits:vi.fn() }));
import { fetchCreditStudents, fetchCreditSessions, fetchSessionCredits } from "@/lib/credit-control/wise";
import { loadWorkspaceAttendance } from "../attendance";
describe("fresh Progress Tests attendance", () => {
  it("reads its own Wise attendance, reconciles refunds and never requests group credits", async () => {
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:"student",name:"Student",activated:true,parents:[],classrooms:[{_id:"one",classType:"ONE_TO_ONE"},{_id:"group",classType:"GROUP"}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client,_institute,status)=>status==="PAST" ? ["one","group"].map(course=>({_id:`${course}-session`,classId:{_id:course,classType:course==="one"?"ONE_TO_ONE":"GROUP"},scheduledStartTime:new Date("2026-09-02"),meetingStatus:"ENDED",students:["student"],userId:"teacher"})) : []);
    vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[{_id:"one-session",credit:0}]});
    const db={select:()=>({from:()=>({where:async()=>[]})})};
    const result=await loadWorkspaceAttendance(db as never,{} as never,"institute",new Date("2026-09-01"),new Date("2026-09-03"));
    expect(fetchSessionCredits).toHaveBeenCalledExactlyOnceWith({},"institute","one","student");
    expect(result.source.find(row=>row.wiseClassId==="one")).toMatchObject({creditApplied:0,wiseTeacherUserId:"teacher"});
    expect(result.snapshotId).toBeNull();
    expect(result.packages.find(row=>row.wiseClassId==="group")?.classType).toBe("GROUP");
  });
});
