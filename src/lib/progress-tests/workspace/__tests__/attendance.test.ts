import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/credit-control/wise", async original => ({ ...await original<typeof import("@/lib/credit-control/wise")>(), fetchCreditStudents:vi.fn(), fetchCreditSessions:vi.fn(), fetchSessionCredits:vi.fn() }));
import { fetchCreditStudents, fetchCreditSessions, fetchSessionCredits } from "@/lib/credit-control/wise";
import {regularGroupCourseIds} from "../course-policy";
import { loadWorkspaceAttendance } from "../attendance";
describe("fresh Progress Tests attendance", () => {
  it.each(["GROUP","LIVE"])("reads student-specific credits for one-to-one and %s classes", async classType => {
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:"student",name:"Student",activated:true,parents:[],classrooms:[{_id:"one",classType:"ONE_TO_ONE"},{_id:regularGroupCourseIds[0],classType}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client,_institute,status)=>status==="PAST" ? ["one",regularGroupCourseIds[0]].map(course=>({_id:`${course}-session`,classId:{_id:course,classType:course==="one"?"ONE_TO_ONE":classType},scheduledStartTime:new Date("2026-09-02"),scheduledEndTime:new Date("2026-09-02T01:00:00Z"),meetingStatus:"ENDED",students:["student"],userId:"teacher"})) : []);
    vi.mocked(fetchSessionCredits).mockImplementation(async (_c,_i,course)=>({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[{_id:course+"-session",credit:course==="one"?0:1}]}));
    const db={select:()=>({from:()=>({where:async()=>[]})})};
    const result=await loadWorkspaceAttendance(db as never,{} as never,"institute",new Date("2026-09-01"),new Date("2026-09-03"));
    expect(fetchSessionCredits).toHaveBeenCalledWith({},"institute","one","student");
    expect(fetchSessionCredits).toHaveBeenCalledWith({},"institute",regularGroupCourseIds[0],"student");
    expect(result.source.find(row=>row.wiseClassId==="one")).toMatchObject({creditApplied:0,wiseTeacherUserId:"teacher",scheduledEndTime:new Date("2026-09-02T01:00:00Z")});
    expect(result.source.find(row=>row.wiseClassId===regularGroupCourseIds[0])?.creditApplied).toBe(1);
    expect(result.snapshotId).toBeNull();
    expect(result.packages.find(row=>row.wiseClassId===regularGroupCourseIds[0])?.classType).toBe(classType);
  });
  it.each(["GROUP","LIVE"])("keeps %s credits separate and excludes students absent from the session", async classType => {
    vi.clearAllMocks();
    vi.mocked(fetchCreditStudents).mockResolvedValue(["student","peer","absent"].map(_id=>({_id,name:_id,activated:true,parents:[],classrooms:[{_id:regularGroupCourseIds[0],classType}]})));
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client,_institute,status)=>status==="PAST"?[{_id:"shared",classId:{_id:regularGroupCourseIds[0],classType},scheduledStartTime:new Date("2026-09-02"),meetingStatus:"ENDED",students:["student","peer"],userId:"teacher"}]:[]);
    vi.mocked(fetchSessionCredits).mockImplementation(async (_c,_i,_course,student)=>({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[{_id:"shared",credit:student==="student"?1:0}]}));
    const db={select:()=>({from:()=>({where:async()=>[]})})};
    const result=await loadWorkspaceAttendance(db as never,{} as never,"institute",new Date("2026-09-01"),new Date("2026-09-03"));
    expect(result.source).toHaveLength(2);
    expect(result.source.find(row=>row.wiseStudentId==="student")?.creditApplied).toBe(1);
    expect(result.source.find(row=>row.wiseStudentId==="peer")?.creditApplied).toBe(0);
    expect(result.source.some(row=>row.wiseStudentId==="absent")).toBe(false);
    expect(fetchSessionCredits).toHaveBeenCalledTimes(2);
    expect(fetchSessionCredits).not.toHaveBeenCalledWith({},"institute",regularGroupCourseIds[0],"absent");
  });
  it("reads recent attendance before the counter launch and keeps inactive students out",async()=>{
    vi.clearAllMocks();
    const launch=new Date('2026-09-13T00:00Z'),now=new Date('2026-10-10T00:00Z');
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:'active',name:'Student',activated:true,parents:[],classrooms:[{_id:'one',classType:'ONE_TO_ONE'}]},{_id:'inactive',name:'Inactive',activated:false,parents:[],classrooms:[{_id:'one',classType:'ONE_TO_ONE'}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async(_c,_i,status,start)=>{
      if(status==='PAST')expect(start.getTime()).toBeLessThanOrEqual(now.getTime()-60*86400000);
      return status==='PAST'?[{_id:'before-launch',classId:{_id:'one',classType:'ONE_TO_ONE'},scheduledStartTime:new Date('2026-08-19'),meetingStatus:'ENDED',students:['active','inactive'],userId:'teacher'}]:[];
    });
    vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:1,consumed:1,remaining:0,bookedSessions:0,available:0},sessionCreditHistory:[{_id:'before-launch',credit:1}]});
    const db={select:()=>({from:()=>({where:async()=>[]})})},result=await loadWorkspaceAttendance(db as never,{} as never,'institute',launch,now);
    expect(result.source.find(row=>row.wiseStudentId==='active')?.creditApplied).toBe(1);
    expect(result.source.find(row=>row.wiseStudentId==='inactive')?.creditApplied).toBe(0);
    expect(fetchSessionCredits).not.toHaveBeenCalledWith({},'institute','one','inactive');
  });

});
