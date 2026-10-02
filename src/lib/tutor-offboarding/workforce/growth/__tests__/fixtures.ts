import type { GrowthEvidence, GrowthQuery } from '../types';
import type { WorkforceSession } from '../../types';
export const now = new Date('2026-10-01T00:00:00+07:00');
export const query: GrowthQuery = {filters:{from:'2026-03-01',to:'2026-09-30',viewMonth:'2026-09',role:'all',modality:'all'},assumptions:{bufferPercent:0}};
export function evidence(): GrowthEvidence {
 return {revision:'fixture',bookingMetadata:[],lifecycleEvents:[],workforce:{people:[{canonicalKey:'Tutor',displayName:'Tutor',role:'tutor',rosterState:'active',joinedAt:null,accounts:[],firstObservedAt:null,lastObservedAt:null,identityCompleteness:'complete',reasonCodes:[]}],observations:[],tutorFacts:[],sessions:[],historicalBookedParticipants:[],studentCredits:[],subjectMappings:[],terminationMarks:[],sourceCoverage:[{source:'wise_history',requestedFrom:'2026-03-01',requestedTo:'2026-09-30',returnedFrom:null,returnedTo:null,pagesRequested:1,pagesReturned:1,recordsReturned:0,truncated:false,completeness:'complete',issueCodes:[]},{source:'wise_future_snapshot',requestedFrom:'2026-10-01',requestedTo:'2027-10-01',returnedFrom:null,returnedTo:null,observedAt:now.toISOString(),pagesRequested:1,pagesReturned:1,recordsReturned:0,truncated:false,completeness:'complete',issueCodes:[]}]}};
}
export function booking(e:GrowthEvidence,id:string,day:string,studentIds:string[],hours=1,subject='Maths',options:Partial<WorkforceSession>={}):WorkforceSession {
 const startAt = new Date(`${day}T10:00:00+07:00`).toISOString();
 const s:WorkforceSession={wiseSessionId:id,wiseClassId:id,classTitle:subject,startAt,endAt:new Date(Date.parse(startAt)+hours*3600000).toISOString(),scheduledMinutes:hours*60,canonicalTutorKeys:['Tutor'],historicalBookedStudentIds:studentIds,participantCompleteness:'complete',completeness:'complete',meetingStatus:'ENDED',attendanceStatus:null,modality:'onsite',subject,curriculum:'International',level:'Y10',observedAt:now.toISOString(),reasonCodes:[],...options};
 e.workforce.sessions.push(s);
 e.workforce.subjectMappings.push({id, classId:id,sourceValue:s.classTitle!,subject,curriculum:s.curriculum,level:s.level,revision:1,reviewedBy:'owner',reviewedAt:now.toISOString()});
 e.bookingMetadata.push({wiseSessionId:id,classification:'regular',sourceField:'purpose',sourceValue:'REGULAR',observedAt:now.toISOString(),completeness:'complete',reasonCodes:[]});
 for(const student of studentIds)e.workforce.studentCredits.push({wiseSessionId:id,wiseStudentId:student,netCredits:hours,normalCredits:hours,evidenceStatus:'verified',sourceInterpretation:'verified_session_charge',observedAt:now.toISOString(),issueCodes:[]});
 return s;
}
