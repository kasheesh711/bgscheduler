import {afterEach,expect,it,vi} from 'vitest';
import {WiseClient} from '@/lib/wise/client';
import {loadWorkspaceAttendance} from '../attendance';
import {countedAttendance} from '../cadence';

const launch=new Date('2026-09-01T00:00:00Z'),now=new Date('2026-09-03T00:00:00Z');
function fixture(status:string,failRequired=false){
 const session=(id:string,course:string,meetingStatus:string)=>({_id:id,classId:{_id:course,classType:'ONE_TO_ONE',name:'Synthetic course'},scheduledStartTime:'2026-09-02T01:00:00Z',scheduledEndTime:'2026-09-02T02:00:00Z',meetingStatus,students:['student'],userId:'teacher'});
 const transport=vi.fn(async(address:string)=>{
  const url=new URL(address);
  if(url.hostname!=='wise.example.test')throw new Error('Unexpected external request.');
  if(url.pathname.endsWith('/students'))return Response.json({data:{students:[{_id:'student',name:'Synthetic student',activated:true,parents:[],classrooms:[{_id:'active-course',classType:'ONE_TO_ONE'}]}]}});
  if(url.pathname.endsWith('/sessions'))return Response.json({data:{sessions:url.searchParams.get('status')==='PAST'?[session('completed','active-course','ENDED'),session('excluded','old-course',status)]:[]}});
  if(url.pathname.endsWith('/sessionCredits')){
   if(url.pathname.includes('/old-course/')||failRequired)return Response.json({error:'Synthetic unavailable course'},{status:404});
   return Response.json({data:{credits:{total:1,consumed:1,remaining:0,available:0,bookedSessions:0},sessionCreditHistory:[{_id:'completed',credit:1,type:'SESSION'}]}});
  }
  throw new Error('Unexpected Wise path.');
 });
 vi.stubGlobal('fetch',transport);
 const write=()=>{throw new Error('Attendance reader must not write.');};
 const db={select:()=>({from:()=>({where:async()=>[]})}),execute:async()=>({rows:[]}),insert:write,update:write,delete:write};
 const client=new WiseClient({userId:'synthetic-user',apiKey:'synthetic-not-a-key',namespace:'test',baseUrl:'https://wise.example.test',maxRetries:0,maxConcurrency:4});
 return {db,client,transport};
}
afterEach(()=>vi.unstubAllGlobals());
it.each(['CANCELLED','CANCELED','DELETED','SCHEDULED'])('keeps complete evidence when an unused %s credit path is unavailable',async status=>{
 const {db,client,transport}=fixture(status);
 const result=await loadWorkspaceAttendance(db as never,client,'institute',launch,now);
 expect(result.source).toHaveLength(2);
 expect(result.source.find(r=>r.wiseSessionId==='excluded')).toMatchObject({meetingStatus:status,creditApplied:0});
 expect(result.source.find(r=>r.wiseSessionId==='completed')).toMatchObject({meetingStatus:'ENDED',creditApplied:1});
 const groups=countedAttendance(result.source.map(r=>({sessionId:r.wiseSessionId,studentId:r.wiseStudentId,courseId:r.wiseClassId,ownerKey:'teacher',start:r.scheduledStartTime,status:r.meetingStatus,credit:r.creditApplied})),launch,now);
 expect([...groups.values()]).toEqual([['completed']]);
 expect(transport.mock.calls.filter(([address])=>address.includes('/old-course/'))).toHaveLength(0);
});
it('rejects a failed required ended-class credit read instead of returning partial attendance',async()=>{
 const {db,client}=fixture('CANCELLED',true);
 await expect(loadWorkspaceAttendance(db as never,client,'institute',launch,now)).rejects.toMatchObject({name:'WiseApiError',status:404});
});
