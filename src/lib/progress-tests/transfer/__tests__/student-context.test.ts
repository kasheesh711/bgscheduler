import {beforeEach,describe,expect,it,vi} from 'vitest';
const identities=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/progress-tests/db',()=>({loadActiveIdentityEntries:identities}));
import {exportStudentContext,projectStudentFeedback} from '../student-context';
const target={wise_student_id:'alice',student_name:'Alice (Ali.Sm) Smith'},peer={wise_student_id:'bob',student_name:'Robert (Bob.Jo) Jones'},tutor={wise_student_id:'teacher-a',student_name:'Tutor (Tara) Teacher'};
const fields={topics:'We covered cells and osmosis. Bob needed help with diffusion.',performance:'Ali correctly labelled the cell. Bob scored 2 out of 10.',improvement:'Ali needs to review diffusion.',homework:'Ali should practise questions 1–4.'};
describe('student-specific source lesson context',()=>{
 beforeEach(()=>identities.mockResolvedValue([{canonicalKey:'A',wiseTeacherId:'teacher-id',wiseUserId:'teacher-a'}]));
 it('resolves a verified tutor account instead of counting it as another student',()=>{
  const result=projectStudentFeedback({...fields,topics:'Cells.',performance:'Ali needs help with diffusion. Bob scored 2 out of 10.'},[target,tutor],'alice',new Set(['teacher-a']));
  expect(result?.shared).toBe(false);expect(result?.text).toContain('This student needs help with diffusion.');expect(result?.text).not.toMatch(/Ali|Bob|2 out of 10/);
 });
 it('uses shared topics without transferring anyone’s performance, homework or name',()=>{
  const result=projectStudentFeedback(fields,[target,peer,tutor],'alice',new Set(['teacher-a']));
  expect(result).toEqual({shared:true,text:'Shared-class topics (not evidence of personal mastery): We covered cells and osmosis.'});
  expect(JSON.stringify(result)).not.toMatch(/Alice|Ali|Robert|Bob|scored|questions 1/);
 });
 it('also projects the other student independently without copying personal feedback',()=>{
  expect(projectStudentFeedback(fields,[target,peer],'bob',new Set())?.text).toBe('Shared-class topics (not evidence of personal mastery): We covered cells and osmosis.');
 });
 it('omits comparisons, contact details and unlabelled personal claims from shared topics',()=>{
  const result=projectStudentFeedback({...fields,topics:'Cell structure. She failed the quiz. A classmate was absent. Contact parent@example.test. Call 0812345678.'},[target,peer],'alice',new Set());
  expect(result?.text).toBe('Shared-class topics (not evidence of personal mastery): Cell structure.');
 });
 it('excludes known Thai participant names and personal feedback',()=>{
  const people=[{wise_student_id:'a',student_name:'อารี (เอย) ใจดี'},{wise_student_id:'b',student_name:'บี (บี) ใจเย็น'}];
  const result=projectStudentFeedback({...fields,topics:'เซลล์และการแพร่\nบีไม่เข้าใจการแพร่'},people,'a',new Set());expect(result?.text).toContain('เซลล์และการแพร่');expect(result?.text).not.toContain('บี');
 });
 it('fails closed for absent targets or participants whose names are unknown',()=>{
  expect(projectStudentFeedback(fields,[target,peer],'stranger',new Set())).toBeNull();
  expect(projectStudentFeedback(fields,[target,{wise_student_id:null,student_name:''}],'alice',new Set())).toBeNull();
 });
 it('exports only the selected course, student, author and maximum eight requested sessions',async()=>{
  const execute=vi.fn().mockResolvedValueOnce({rows:[{id:'session-id',wise_session_id:'lesson',scheduled_start_at:'2026-10-01T00:00:00Z',canonical_tutor_key:'A',wise_teacher_user_id:'teacher-a',feedback_id:'note',...fields},{id:'wrong',canonical_tutor_key:'A',wise_teacher_user_id:'wrong-teacher'}]}).mockResolvedValueOnce({rows:[target,peer,tutor].map(p=>({...p,session_id:'session-id'}))});
  const url=new URL('https://source.test/export?type=student-context&studentId=alice&courseId=course&ownerKey=A&sessionIds=%5B%22lesson%22%5D');
  const result=await exportStudentContext(url,{execute} as never);
  expect(result.sessions).toEqual([{sessionId:'lesson',shared:true}]);expect(result.feedback).toHaveLength(1);
  expect(result.feedback[0].text).toBe('Shared-class topics (not evidence of personal mastery): We covered cells and osmosis.');
  expect(JSON.stringify(result)).not.toMatch(/teacher-a|Alice|Bob|performance|homework/);
  url.searchParams.set('sessionIds',JSON.stringify(Array.from({length:9},(_,i)=>String(i))));await expect(exportStudentContext(url,{execute} as never)).rejects.toMatchObject({status:400});expect(execute).toHaveBeenCalledTimes(2);
  url.searchParams.set('sessionIds','invalid');await expect(exportStudentContext(url,{execute} as never)).rejects.toMatchObject({status:400});
 });
});
