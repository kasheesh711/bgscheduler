import type { WorkforceEvidence, WorkforceSession, WorkforceQuery } from '../types';
export const DAY = 86400000, HOUR = 3600000;
export const start = Date.parse('2026-03-02T00:00:00+07:00');
export const query: WorkforceQuery = { from: '2026-03-02', to: '2026-03-02', viewMonth: '2026-03', role: 'all', modality: 'all' };
export const now = new Date(start + DAY);
export function evidence(): WorkforceEvidence {
    const person = { canonicalKey: 'Aria', displayName: 'Aria', role: 'tutor' as const, rosterState: 'active' as const, joinedAt: '2026-01-01T00:00:00Z', accounts: [], firstObservedAt: new Date(start).toISOString(), lastObservedAt: now.toISOString(), identityCompleteness: 'complete' as const, reasonCodes: [] };
    return { revision: 'fixture', people: [person], observations: Array.from({ length: 24 }, (_, i) => ({ id: 'o' + i, canonicalKey: 'Aria', observedAt: new Date(start + i * HOUR).toISOString(), source: 'fixture', role: 'tutor' as const, accounts: [], qualifications: ['Math', 'Physics'].map(subject => ({ subject, curriculum: 'International', level: 'G1-9', modality: 'onsite' as const })), offeredWindows: [{ weekday: 1, startMinute: 480, endMinute: 960, modality: 'onsite' as const }], leaves: [{ startAt: new Date(start + 8 * HOUR).toISOString(), endAt: new Date(start + 10 * HOUR).toISOString(), status: 'approved' as const }], availabilityCompleteness: 'complete' as const, qualificationCompleteness: 'complete' as const, completeness: 'complete' as const, reasonCodes: [] })), sessions: [], tutorFacts: [], historicalBookedParticipants: [], studentCredits: [], subjectMappings: [], terminationMarks: [], sourceCoverage: [{ source: 'wise_history', requestedFrom: '2026-03-01', requestedTo: '2026-03-31', returnedFrom: '2026-03-01', returnedTo: '2026-03-31', pagesRequested: 1, pagesReturned: 1, recordsReturned: 1, truncated: false, completeness: 'complete', issueCodes: [] }] };
}
export function addSession(e: WorkforceEvidence, id: string, localHour: number, minutes: number, subject = 'Physics', fraction = 1): WorkforceSession {
    const session: WorkforceSession = { wiseSessionId: id, wiseClassId: 'c' + id, classTitle: subject, startAt: new Date(start + localHour * HOUR).toISOString(), endAt: new Date(start + localHour * HOUR + minutes * 60000).toISOString(), scheduledMinutes: minutes, canonicalTutorKeys: ['Aria'], historicalBookedStudentIds: ['st' + id], participantCompleteness: 'complete', completeness: 'complete', meetingStatus: 'ENDED', attendanceStatus: null, modality: 'onsite', subject, curriculum: 'International', level: 'G1-9', reasonCodes: [] };
    e.sessions.push(session);
    e.studentCredits.push({ wiseSessionId: id, wiseStudentId: 'st' + id, netCredits: minutes / 60 * fraction, normalCredits: minutes / 60, evidenceStatus: 'verified', sourceInterpretation: 'verified_session_charge', observedAt: now.toISOString(), issueCodes: [] });
    return session;
}
