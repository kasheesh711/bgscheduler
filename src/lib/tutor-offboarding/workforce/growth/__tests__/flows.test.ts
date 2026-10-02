import {describe,expect,it} from 'vitest';
import {buildGrowthFlows,buildAllGrowthFlows} from '../flows';
import {deriveGrowthLifecycleEvents} from '../lifecycle';
import {booking,evidence,now,query} from './fixtures';
const row=(e:ReturnType<typeof evidence>,month:string,level='Y10')=>buildGrowthFlows(e,query,now).months.find(x=>x.month===month&&x.subject==='Maths'&&x.level===level)!;
describe('growth flows',()=>{
 it.each([false,true])('retains verified tutor-hour subtotals before or after an incomplete group (%s)',reverse=>{const e=evidence();if(!reverse)booking(e,'known','2026-06-01',['John']);booking(e,'unknown','2026-06-02',['Evan']);e.workforce.studentCredits=e.workforce.studentCredits.filter(x=>x.wiseSessionId!=='unknown');if(reverse)booking(e,'known','2026-06-03',['John']);const r=row(e,'2026-06');expect(r.creditTutorHours).toMatchObject({value:1,completeness:'partial'});expect(r.cancellationTutorHours).toMatchObject({value:0,completeness:'partial'});});
 it('does not present automatic zero churn when unknown teaching evidence could interrupt the confirmation window',()=>{const e=evidence();booking(e,'last','2026-08-01',['John']);booking(e,'unknown','2026-09-20',['John']);e.workforce.studentCredits=e.workforce.studentCredits.filter(x=>x.wiseSessionId!=='unknown');booking(e,'other','2026-09-05',['Mary'],1,'Physics');const r=buildGrowthFlows(e,query,now);expect(r.averages.find(x=>x.subject==='Maths')!.churnStudentHours.value).toBeNull();expect(r.averages.find(x=>x.subject==='Physics')!.churnStudentHours).toMatchObject({value:0,completeness:'complete'});});
 it('keeps automatic churn unavailable when past membership could omit the student',()=>{const e=evidence();booking(e,'last','2026-08-01',['John']);booking(e,'partial-members','2026-09-20',['Evan'],1,'Maths',{participantCompleteness:'partial'});expect(buildGrowthFlows(e,query,now).averages[0].churnStudentHours.value).toBeNull();});
 it('keeps known group subtotals and recorded group-mix estimates partial',()=>{const e=evidence();booking(e,'known','2026-06-01',['John'],2,'Maths',{participantCompleteness:'partial'});const r=buildGrowthFlows(e,query,now);expect(row(e,'2026-06').bookedStudentHours).toMatchObject({value:2,completeness:'partial'});expect(r.averages[0].newStudentHours.completeness).toBe('partial');expect(r.averages[0].studentHoursPerTutorHour).toMatchObject({value:1,completeness:'partial'});});
 it('uses all retained course dimensions and calendar-normalized weekly patterns for forecast',()=>{const e=evidence();booking(e,'early','2026-04-01',['John']);booking(e,'base','2026-09-03',['John']);const displayed=buildGrowthFlows(e,{...query,filters:{...query.filters,from:'2026-04-01',to:'2026-04-30'}},now);expect(displayed.months.every(x=>x.month==='2026-04')).toBe(true);expect(buildAllGrowthFlows(e,now).months.some(x=>x.month==='2026-09'&&x.bookedStudentHours.value===1)).toBe(true);});
 it('does not convert an unavailable subject churn check into a zero monthly mean',()=>{const e=evidence();booking(e,'a','2026-06-01',['John']);e.workforce.sourceCoverage=e.workforce.sourceCoverage.filter(x=>x.source!=='wise_future_snapshot');expect(buildGrowthFlows(e,query,now).averages[0].churnStudentHours.value).toBe(null);});
 it('distributes the three-month churn baseline by recorded course dimensions',()=>{const e=evidence();booking(e,'may','2026-05-01',['John'],3,'Maths',{level:'Y9'});booking(e,'june','2026-06-01',['John'],6);booking(e,'july','2026-07-01',['John'],9);booking(e,'last','2026-08-20',['John']);const late=new Date('2026-10-19T10:00:00+07:00');e.workforce.sourceCoverage[0].requestedTo='2026-10-19';e.workforce.sourceCoverage[1].observedAt=late.toISOString();const r=buildGrowthFlows(e,query,late);expect(r.months.filter(x=>x.month==='2026-09').map(x=>[x.level,x.churnStudentHours.value]).sort()).toEqual([['Y10',5],['Y9',1]]);});

 it('counts John four and Evan eight as twelve first-month student hours',()=>{const e=evidence();booking(e,'j','2026-04-02',['John'],4);booking(e,'e','2026-04-03',['Evan'],8);expect(row(e,'2026-04').newStudentHours.value).toBe(12);expect(row(e,'2026-04').newlyObservedStudents.value).toBe(2);});
 it('retains inception under date, curriculum, modality, and role filters',()=>{const e=evidence();booking(e,'first','2026-04-02',['John']);booking(e,'new-level','2026-09-02',['John'],1,'Maths',{level:'Y11',modality:'online'});const r=buildGrowthFlows(e,{...query,filters:{...query.filters,from:'2026-09-01',to:'2026-09-30',level:'Y11',modality:'online'}},now);expect(r.months).toHaveLength(1);expect(r.months[0].newlyObservedStudents.value).toBe(0);});
 it('excludes March starts and starts trial learners on their first regular lesson',()=>{const e=evidence();booking(e,'march','2026-03-02',['Evan'],2);booking(e,'trial','2026-04-01',['John']);e.bookingMetadata.find(x=>x.wiseSessionId==='trial')!.classification='trial';booking(e,'regular','2026-05-02',['John'],4);expect(row(e,'2026-03').newStudentHours.value).toBe(0);expect(row(e,'2026-03').startingCohortExcluded).toBe(true);expect(row(e,'2026-04').trialStudentHours.value).toBe(1);expect(row(e,'2026-05').newStudentHours.value).toBe(4);});
 it('uses mean group charge fractions and leaves missing credit/membership visible',()=>{const e=evidence();booking(e,'group','2026-06-02',['John','Evan'],1,'Maths',{meetingStatus:'CANCELLED'});e.workforce.studentCredits.find(x=>x.wiseStudentId==='Evan')!.netCredits=.5;expect(row(e,'2026-06')).toMatchObject({cancellationStudentHours:{value:.5,completeness:'complete'},cancellationTutorHours:{value:.25,completeness:'complete'}});e.workforce.studentCredits.pop();expect(row(e,'2026-06').creditStudentHours.completeness).toBe('partial');expect(row(e,'2026-06').creditTutorHours.value).toBe(null);});
 it('keeps a half-charged one-hour cancellation as half-hour loss',()=>{const e=evidence();booking(e,'single','2026-07-01',['John'],1,'Maths',{meetingStatus:'CANCELLED'});e.workforce.studentCredits[0].netCredits=.5;expect(row(e,'2026-07').cancellationStudentHours.value).toBe(.5);});
 it('reproduces exact subject means on the same June–August window',()=>{const e=evidence();for(const [subject,hours] of [['Maths',[1,2,3]],['Physics',[1,2,6]],['Chemistry',[1,2,12]]] as const)for(let i=0;i<3;i++)booking(e,`${subject}${i}`,`2026-0${i+6}-02`,[`${subject}${i}`],hours[i],subject);const r=buildGrowthFlows(e,query,now);expect(r.commonWindow).toEqual(['2026-06','2026-07','2026-08']);expect(r.averages.map(x=>[x.subject,x.newStudentHours.value]).sort()).toEqual([['Chemistry',5],['Maths',2],['Physics',3]]);e.workforce.sourceCoverage[0].requestedFrom='2026-07-01';expect(buildGrowthFlows(e,query,now).averages.every(x=>x.newStudentHours.value!==null && x.newStudentHours.completeness==='partial')).toBe(true);});
 it('attributes return to reactivation, preserving recorded churn and baseline course mix',()=>{const e=evidence();booking(e,'a','2026-04-01',['John'],3);booking(e,'last','2026-06-01',['John']);const july=new Date('2026-08-01T00:00:00+07:00');e.workforce.sourceCoverage[1].observedAt=july.toISOString();e.lifecycleEvents=deriveGrowthLifecycleEvents(e,july);booking(e,'return','2026-09-03',['John'],2);const r=row(e,'2026-09');expect(r.newStudentHours.value).toBe(0);expect(r.reactivatedStudentHours.value).toBe(2);});
 it('uses Bangkok month midnight, latest moved booking, and reviewed mappings',()=>{const e=evidence();const s=booking(e,'moved','2026-05-01',['John']);s.startAt='2026-04-30T17:00:00.000Z';s.endAt='2026-04-30T18:00:00.000Z';expect(row(e,'2026-05').newStudentHours.value).toBe(1);e.workforce.sessions.push({...s,startAt:'2026-06-01T03:00:00Z',endAt:'2026-06-01T04:00:00Z',observedAt:'2026-10-01T03:00:00Z'});expect(row(e,'2026-05').bookedStudentHours.value).toBe(0);expect(row(e,'2026-06').newStudentHours.value).toBe(1);e.workforce.subjectMappings[0].subject='Physics';expect(buildGrowthFlows(e,query,now).months.some(x=>x.subject==='Maths')).toBe(false);});
});

it('keeps returned-roster credit and cancellation estimates partial without completing model inputs', () => {
 const e=evidence();
 booking(e,'group','2026-06-01',['John','Evan'],1,'Maths',{participantCompleteness:'partial',reasonCodes:['HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION']});
 e.workforce.studentCredits[1].netCredits=.5;
 const r=row(e,'2026-06');
 expect(r.creditTutorHours).toMatchObject({value:.75,completeness:'partial',creditCoverage:{estimatedClasses:1}});
 expect(r.cancellationTutorHours).toMatchObject({value:.25,completeness:'partial'});
 expect(r.creditTutorHours.reasonCodes).toContain('RETURNED_PARTICIPANT_CREDIT_ESTIMATE');
 const result=buildGrowthFlows(e,query,now);
 expect(result.averages[0].cancellationFraction).toMatchObject({value:.25,completeness:'partial'});
});

it('estimates cancellation from the same verified booking subset so missing deductions cannot dilute loss', () => {
 const e=evidence();
 booking(e,'refund','2026-06-01',['John']);e.workforce.studentCredits[0].netCredits=0;
 booking(e,'missing','2026-06-02',['Evan'],1,'Maths',{participantCompleteness:'partial',reasonCodes:['HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION']});
 e.workforce.studentCredits=e.workforce.studentCredits.filter(c=>c.wiseSessionId!=='missing');
 const result=buildGrowthFlows(e,query,now).averages[0];
 expect(result.cancellationNumerator).toMatchObject({value:1,completeness:'partial'});
 expect(result.cancellationDenominator).toMatchObject({value:1,completeness:'partial'});
 expect(result.cancellationFraction).toMatchObject({value:1,completeness:'partial'});
 expect(result.studentHoursPerTutorHour).toMatchObject({value:1,completeness:'partial'});
 expect(result.churnStudentHours.value).toBeNull();
});

it('keeps unknown empty membership unavailable while complete empty membership establishes zero students', () => {
 const unknown=evidence();booking(unknown,'empty','2026-06-01',[],1,'Maths',{participantCompleteness:'partial',reasonCodes:['HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION']});
 const monthly=row(unknown,'2026-06');
 expect(monthly.bookedStudentHours.value).toBeNull();
 expect(monthly.newStudentHours.value).toBeNull();
 expect(buildGrowthFlows(unknown,query,now).averages[0].studentHoursPerTutorHour.value).toBeNull();
 const complete=evidence();booking(complete,'empty','2026-06-01',[]);
 expect(row(complete,'2026-06').bookedStudentHours).toMatchObject({value:0,completeness:'complete'});
 expect(buildGrowthFlows(complete,query,now).averages[0].studentHoursPerTutorHour.value).toBeNull();
});
it.each([false,true])('keeps known participant subtotals without letting unknown empty classes dilute group mix (%s)', reverse => {
 const e=evidence();
 if(!reverse)booking(e,'known','2026-06-01',['John'],1,'Maths',{participantCompleteness:'partial',reasonCodes:['HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION']});
 booking(e,'empty','2026-06-02',[],1,'Maths',{participantCompleteness:'unknown'});
 if(reverse)booking(e,'known','2026-06-03',['John'],1,'Maths',{participantCompleteness:'partial',reasonCodes:['HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION']});
 expect(row(e,'2026-06').bookedStudentHours).toMatchObject({value:1,completeness:'partial'});
 expect(buildGrowthFlows(e,query,now).averages[0].studentHoursPerTutorHour).toMatchObject({value:1,completeness:'partial'});
});
