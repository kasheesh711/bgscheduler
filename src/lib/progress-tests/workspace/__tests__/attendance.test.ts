import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/credit-control/wise", async original => ({ ...await original<typeof import("@/lib/credit-control/wise")>(), fetchCreditStudents:vi.fn(), fetchCreditSessions:vi.fn(), fetchSessionCredits:vi.fn() }));
import { fetchCreditStudents, fetchCreditSessions, fetchSessionCredits } from "@/lib/credit-control/wise";
import { loadWorkspaceAttendance } from "../attendance";
describe("fresh Progress Tests attendance", () => {
  it("reads student-specific credits for one-to-one and group classes", async () => {
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:"student",name:"Student",activated:true,parents:[],classrooms:[{_id:"one",classType:"ONE_TO_ONE"},{_id:"group",classType:"GROUP"}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client,_institute,status)=>status==="PAST" ? ["one","group"].map(course=>({_id:`${course}-session`,classId:{_id:course,classType:course==="one"?"ONE_TO_ONE":"GROUP"},scheduledStartTime:new Date("2026-09-02"),scheduledEndTime:new Date("2026-09-02T01:00:00Z"),meetingStatus:"ENDED",students:["student"],userId:"teacher"})) : []);
    vi.mocked(fetchSessionCredits).mockImplementation(async (_c,_i,course)=>({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[{_id:course+"-session",credit:course==="one"?0:1}]}));
    const db={select:()=>({from:()=>({where:async()=>[]})})};
    const result=await loadWorkspaceAttendance(db as never,{} as never,"institute",new Date("2026-09-01"),new Date("2026-09-03"));
    expect(fetchSessionCredits).toHaveBeenCalledWith({},"institute","one","student");
    expect(fetchSessionCredits).toHaveBeenCalledWith({},"institute","group","student");
    expect(result.source.find(row=>row.wiseClassId==="one")).toMatchObject({creditApplied:0,wiseTeacherUserId:"teacher",scheduledEndTime:new Date("2026-09-02T01:00:00Z")});
    expect(result.source.find(row=>row.wiseClassId==="group")?.creditApplied).toBe(1);
    expect(result.snapshotId).toBeNull();
    expect(result.packages.find(row=>row.wiseClassId==="group")?.classType).toBe("GROUP");
  });
  it("keeps group credits separate and excludes students absent from the session", async () => {
    vi.clearAllMocks();
    vi.mocked(fetchCreditStudents).mockResolvedValue(["student","peer","absent"].map(_id=>({_id,name:_id,activated:true,parents:[],classrooms:[{_id:"group",classType:"GROUP"}]})));
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client,_institute,status)=>status==="PAST"?[{_id:"shared",classId:{_id:"group",classType:"GROUP"},scheduledStartTime:new Date("2026-09-02"),meetingStatus:"ENDED",students:["student","peer"],userId:"teacher"}]:[]);
    vi.mocked(fetchSessionCredits).mockImplementation(async (_c,_i,_course,student)=>({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[{_id:"shared",credit:student==="student"?1:0}]}));
    const db={select:()=>({from:()=>({where:async()=>[]})})};
    const result=await loadWorkspaceAttendance(db as never,{} as never,"institute",new Date("2026-09-01"),new Date("2026-09-03"));
    expect(result.source).toHaveLength(2);
    expect(result.source.find(row=>row.wiseStudentId==="student")?.creditApplied).toBe(1);
    expect(result.source.find(row=>row.wiseStudentId==="peer")?.creditApplied).toBe(0);
    expect(result.source.some(row=>row.wiseStudentId==="absent")).toBe(false);
    expect(fetchSessionCredits).toHaveBeenCalledTimes(2);
    expect(fetchSessionCredits).not.toHaveBeenCalledWith({},"institute","group","absent");
  });
});
