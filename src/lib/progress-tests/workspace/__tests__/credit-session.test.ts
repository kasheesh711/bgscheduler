import {describe,it,expect} from 'vitest';
import {sessionCreditMap,readSessionCredits,type CreditSessionAnchor} from '../credit-session';
const raw={_id:'session',createdAt:'2026-10-07T13:03:41.774Z',duration:3647000,type:'SESSION',classroom:{_id:'course'},credit:1};
const anchor:CreditSessionAnchor={wiseSessionId:'session',wiseClassId:'course',wiseStudentId:'student',raw};
const current={...raw,_id:'renamed',createdAt:new Date(raw.createdAt)};
describe('rekeyed Wise session credits',()=>{
 it('links only a unique exact anchor and keeps the live credit value',()=>{
  for(const credit of [1,0,-1,0.5])expect(sessionCreditMap([{...current,credit}],[anchor],'course','student').credits.get('session')).toBe(Math.max(0,credit));
 });
 it('gives the direct current ID priority over duplicate renamed records',()=>{const value=sessionCreditMap([{...current,credit:1},{...current,_id:'duplicate',credit:1},{_id:'session',credit:0}],[anchor],'course','student');expect(value.credits.get('session')).toBe(0);expect(value.unresolved.size).toBe(0);});
 it('accepts an exact uniquely recorded zero-duration class',()=>expect(sessionCreditMap([{...current,duration:0,credit:2}],[{...anchor,raw:{...raw,duration:0}}],'course','student').credits.get('session')).toBe(2));
 it('does not borrow credits from a peer, another course, missing history or a changed timestamp',()=>{
  expect(sessionCreditMap([current],[{...anchor,wiseStudentId:'peer'}],'course','student').credits.has('session')).toBe(false);
  expect(sessionCreditMap([current],[{...anchor,wiseClassId:'other'}],'course','student').credits.has('session')).toBe(false);
  expect(sessionCreditMap([current],[],'course','student').credits.has('session')).toBe(false);
  expect([...sessionCreditMap([], [anchor],'course','student').unresolved]).toEqual(['session']);
  expect([...sessionCreditMap([{...current,createdAt:new Date(+current.createdAt+1)}],[anchor],'course','student').unresolved]).toEqual(['session']);
  expect([...sessionCreditMap([{...current,duration:raw.duration+1}],[anchor],'course','student').unresolved]).toEqual(['session']);
  expect([...sessionCreditMap([{...current,type:'CREDIT'}],[anchor],'course','student').unresolved]).toEqual(['session']);
 });
 it('deduplicates the same retained anchor and rejects distinct duplicate identities',()=>{
  expect(sessionCreditMap([current],[anchor,anchor],'course','student').credits.get('session')).toBe(1);
  expect([...sessionCreditMap([current],[anchor,{...anchor,wiseSessionId:'other',raw:{...raw,_id:'other'}}],'course','student').unresolved].sort()).toEqual(['other','session']);
  expect([...sessionCreditMap([current,{...current,_id:'duplicate'}],[anchor],'course','student').unresolved]).toEqual(['session']);
 });
});

describe('explicit current class credits',()=>{
 const detail={_id:'session',classId:'course',attendanceRecorded:true,meetingStatus:'ENDED',participants:[{wiseUserId:'student',credits:1}]};
 it('validates only the named student and excludes tutor and peer fields',async()=>{
  const client={get:async()=>({data:{...detail,participants:[{role:'teacher'},{wiseUserId:'peer'},{wiseUserId:'student',credits:1}]}})};
  expect(await readSessionCredits(client as never,'course','student','session')).toBe(1);
 });
 it.each([0,1,2,-1])('uses the named student current credit %s',async credits=>{const client={get:async()=>({data:{...detail,participants:[{wiseUserId:'student',credits}]}})};expect(await readSessionCredits(client as never,'course','student','session')).toBe(Math.max(0,credits));});
 it.each([{_id:'wrong'},{classId:'wrong'},{attendanceRecorded:false},{meetingStatus:'CANCELLED'},{participants:[{wiseUserId:'peer',credits:1}]},{participants:[{wiseUserId:'student'}]},{participants:[{wiseUserId:'student',credits:Infinity}]},{participants:[{wiseUserId:'student',credits:NaN}]},{participants:[{wiseUserId:'student',credits:1},{wiseUserId:'student',credits:1}]}])('rejects unresolved detail %j',async bad=>{const client={get:async()=>({data:{...detail,...bad}})};await expect(readSessionCredits(client as never,'course','student','session')).rejects.toThrow();});
});
