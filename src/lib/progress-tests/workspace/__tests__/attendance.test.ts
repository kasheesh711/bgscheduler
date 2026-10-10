vi.mock('../credit-session',async original=>({...await original<typeof import('../credit-session')>(),readSessionCredits:vi.fn(async()=>{throw new Error('Current attendance does not identify one class.');})}));
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/credit-control/wise", async original => ({ ...await original<typeof import("@/lib/credit-control/wise")>(), fetchCreditStudents:vi.fn(), fetchCreditSessions:vi.fn(), fetchSessionCredits:vi.fn() }));
import { fetchCreditStudents, fetchCreditSessions, fetchSessionCredits } from "@/lib/credit-control/wise";
import {regularGroupCourseIds} from "../course-policy";
import { loadWorkspaceAttendance } from "../attendance";
import {readSessionCredits} from '../credit-session';
describe("fresh Progress Tests attendance", () => {
  it('keeps an unrecorded class at zero without borrowing participant or peer credits',async()=>{
    vi.clearAllMocks();
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:'student',name:'Student',activated:true,parents:[],classrooms:[{_id:'one',classType:'ONE_TO_ONE'}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async(_c,_i,status)=>status==='PAST'?[{_id:'unrecorded',classId:{_id:'one',classType:'ONE_TO_ONE'},scheduledStartTime:new Date('2026-09-02'),meetingStatus:'ENDED',students:['student'],userId:'teacher'}]:[]);
    vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[]});
    const db={execute:async()=>({rows:[]}),select:()=>({from:()=>({where:async()=>[]})})};
    const result=await loadWorkspaceAttendance(db as never,{} as never,'institute',new Date('2026-09-01'),new Date('2026-09-03'));
    expect(result.source[0].creditApplied).toBe(0);expect(readSessionCredits).not.toHaveBeenCalled();
  });
  it.each([1,0,null])('reads exact current credit %s when there is no retained anchor, before any write',async credit=>{
    vi.clearAllMocks();const at=new Date('2026-09-02T01:00Z');
    const prior={wiseSessionId:'new-session',wiseClassId:'one',wiseStudentId:'student',studentName:'Student',subject:'Science',scheduledStartTime:at,meetingStatus:'ENDED',creditApplied:1,firstObservedSnapshotId:null};
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:'student',name:'Student',activated:true,parents:[],classrooms:[{_id:'one',classType:'ONE_TO_ONE'}]}]);
    vi.mocked(fetchCreditSessions).mockResolvedValue([]);
    vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:1,consumed:1,remaining:0,bookedSessions:0,available:0},sessionCreditHistory:[]});
    if(credit===null)vi.mocked(readSessionCredits).mockRejectedValueOnce(new Error('Exact student credit is missing.'));
    else vi.mocked(readSessionCredits).mockResolvedValueOnce(credit);
    const write=vi.fn(()=>{throw new Error('Write blocked.');}),db={execute:async()=>({rows:[]}),select:()=>({from:()=>({where:async()=>[prior]})}),insert:write,update:write,delete:write};
    const result=loadWorkspaceAttendance(db as never,{} as never,'institute',new Date('2026-09-01'),new Date('2026-09-03'));
    if(credit===null)await expect(result).rejects.toThrow('Exact student credit');
    else expect((await result).source[0].creditApplied).toBe(credit);
    expect(readSessionCredits).toHaveBeenCalledWith({},'one','student','new-session');
    expect(prior.creditApplied).toBe(1);expect(write).not.toHaveBeenCalled();
  });
  it.each([1,0,-1,null])('reconciles the live credit %s and rejects missing positive evidence before any write',async credit=>{
    vi.clearAllMocks();const at=new Date('2026-09-02T01:00Z');
    const prior={wiseSessionId:'old-session',wiseClassId:'one',wiseStudentId:'student',studentName:'Student',subject:'Science',scheduledStartTime:at,meetingStatus:'ENDED',creditApplied:1};
    const raw={_id:'old-session',createdAt:'2026-09-02T01:01:02.345Z',duration:3600000,type:'SESSION',classroom:{_id:'one'},credit:1};
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:'student',name:'Student',activated:true,parents:[],classrooms:[{_id:'one',classType:'ONE_TO_ONE'}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async(_c,_i,status)=>status==='PAST'?[{_id:'old-session',classId:{_id:'one',classType:'ONE_TO_ONE'},scheduledStartTime:at,meetingStatus:'ENDED',students:['student'],userId:'teacher'}]:[]);
    vi.mocked(fetchSessionCredits).mockResolvedValue({credits:{total:1,consumed:1,remaining:0,bookedSessions:0,available:0},sessionCreditHistory:credit===null?[]:[{...raw,_id:'renamed',createdAt:new Date(raw.createdAt),credit}]});
    const write=vi.fn(()=>{throw new Error('Write blocked.');}),db={execute:async()=>({rows:[{wiseSessionId:'old-session',wiseClassId:'one',wiseStudentId:'student',raw}]}),select:()=>({from:()=>({where:async()=>[prior]})}),insert:write,update:write,delete:write};
    const result=loadWorkspaceAttendance(db as never,{} as never,'institute',new Date('2026-09-01'),new Date('2026-09-03'));
    if(credit===null)await expect(result).rejects.toThrow('one class');
    else expect((await result).source[0].creditApplied).toBe(Math.max(0,credit));
    expect(prior.creditApplied).toBe(1);expect(write).not.toHaveBeenCalled();
  });
  it.each(["GROUP","LIVE"])("reads student-specific credits for one-to-one and %s classes", async classType => {
    vi.mocked(fetchCreditStudents).mockResolvedValue([{_id:"student",name:"Student",activated:true,parents:[],classrooms:[{_id:"one",classType:"ONE_TO_ONE"},{_id:regularGroupCourseIds[0],classType}]}]);
    vi.mocked(fetchCreditSessions).mockImplementation(async (_client,_institute,status)=>status==="PAST" ? ["one",regularGroupCourseIds[0]].map(course=>({_id:`${course}-session`,classId:{_id:course,classType:course==="one"?"ONE_TO_ONE":classType},scheduledStartTime:new Date("2026-09-02"),scheduledEndTime:new Date("2026-09-02T01:00:00Z"),meetingStatus:"ENDED",students:["student"],userId:"teacher"})) : []);
    vi.mocked(fetchSessionCredits).mockImplementation(async (_c,_i,course)=>({credits:{total:1,consumed:0,remaining:1,bookedSessions:0,available:1},sessionCreditHistory:[{_id:course+"-session",credit:course==="one"?0:1}]}));
    const db={execute:async()=>({rows:[]}),select:()=>({from:()=>({where:async()=>[]})})};
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
    const db={execute:async()=>({rows:[]}),select:()=>({from:()=>({where:async()=>[]})})};
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
    const db={execute:async()=>({rows:[]}),select:()=>({from:()=>({where:async()=>[]})})},result=await loadWorkspaceAttendance(db as never,{} as never,'institute',launch,now);
    expect(result.source.find(row=>row.wiseStudentId==='active')?.creditApplied).toBe(1);
    expect(result.source.find(row=>row.wiseStudentId==='inactive')?.creditApplied).toBe(0);
    expect(fetchSessionCredits).not.toHaveBeenCalledWith({},'institute','one','inactive');
  });

});
