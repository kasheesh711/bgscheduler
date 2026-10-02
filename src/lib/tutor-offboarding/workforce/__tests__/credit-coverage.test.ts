import { describe, expect, it } from 'vitest';
import { buildWorkforceReport } from '../aggregate';
import { buildCreditControlWorkforceEvidence } from '../credit-control-capture';
import { computeConsumedMinutes } from '../credits';
import type { CreditControlCaptureInput } from '../credit-control-capture';
import { evidence, now, query, start, HOUR } from './calculation-fixtures';

function captured(studentIds = ['a'], charges: Array<number | null> = [.5]) {
  const input: CreditControlCaptureInput = {
    snapshotId: 'capture', observedAt: now, from: new Date(start), to: now,
    sessions: [{ _id: 'captured', title: 'Physics', classId: { _id: 'class', classType: studentIds.length > 1 ? 'LIVE' : 'ONE_TO_ONE' },
      scheduledStartTime: new Date(start + 10 * HOUR), scheduledEndTime: new Date(start + 11 * HOUR),
      students: studentIds, meetingStatus: 'ENDED', teacherId: 'teacher' }],
    pairs: studentIds.map((wiseStudentId, i) => ({ wiseClassId: 'class', wiseStudentId, creditsObservedAt: now,
      history: charges[i] === null ? [] : [{ raw: { _id: 'captured', type: 'SESSION', credit: charges[i], _workforceRawCreditEvidence: true } }] })),
  };
  const source = buildCreditControlWorkforceEvidence(input);
  const e = evidence();
  e.sessions = source.sessions.map(s => ({ ...s, canonicalTutorKeys: ['Aria'], subject: 'Physics', modality: 'onsite' }));
  e.studentCredits = source.credits;
  e.historicalBookedParticipants = source.evidence.historicalBookedParticipants;
  return { e, source };
}

describe('captured credit coverage', () => {
  it('retains verified half charge as an explicit returned-roster estimate through report and utilization', () => {
    const { e, source } = captured();
    const consumed = computeConsumedMinutes(source.sessions[0], source.credits);
    expect(consumed).toMatchObject({ value: 30, completeness: 'partial', creditCoverage: {
      totalClasses: 1, computedClasses: 1, estimatedClasses: 1, unknownClasses: 0,
      returnedParticipants: 1, verifiedCreditParticipants: 1, unknownCreditParticipants: 0,
    } });
    expect(consumed.reasonCodes).toContain('RETURNED_PARTICIPANT_CREDIT_ESTIMATE');
    const r = buildWorkforceReport(e, query, now);
    expect(r.totals.creditConsumedHours).toMatchObject({ value: .5, completeness: 'partial', creditCoverage: { computedClasses: 1, estimatedClasses: 1 } });
    expect(r.totals.utilizationCreditConsumedHours).toMatchObject({ value: .5, completeness: 'partial' });
    expect(r.totals.consumedUtilizationPercent.completeness).toBe('partial');
    expect(r.totals.consumedUtilizationPercent.value).toBeCloseTo(8.33333333);
    expect(r.months[0].creditConsumedHours.completeness).toBe('partial');
    expect(r.people[0].creditConsumedHours.value).toBe(.5);
  });
  it('uses every returned group member equally and preserves a verified zero', () => {
    const { source } = captured(['a', 'b'], [1, .5]);
    expect(computeConsumedMinutes(source.sessions[0], source.credits)).toMatchObject({ value: 45, completeness: 'partial', creditCoverage: { returnedParticipants: 2, verifiedCreditParticipants: 2 } });
    const refunded = captured(['a'], [0]);
    expect(computeConsumedMinutes(refunded.source.sessions[0], refunded.source.credits)).toMatchObject({ value: 0, completeness: 'partial' });
  });
  it('never computes a mean from only the charged subset or conflicting historical membership', () => {
    const { e, source } = captured(['a', 'b'], [1, null]);
    expect(computeConsumedMinutes(source.sessions[0], source.credits)).toMatchObject({ value: null, creditCoverage: { unknownClasses: 1, verifiedCreditParticipants: 1, unknownCreditParticipants: 1 } });
    const report = buildWorkforceReport(e, query, now);
    expect(report.totals.creditConsumedHours.value).toBeNull();
    expect(report.totals.utilizationCreditConsumedHours.value).toBeNull();
    const valid = captured();
    valid.source.sessions[0].reasonCodes.push('CONFLICTING_PARTICIPANTS');
    expect(computeConsumedMinutes(valid.source.sessions[0], valid.source.credits).value).toBeNull();
    valid.source.sessions[0].reasonCodes = valid.source.sessions[0].reasonCodes.filter(code => code !== 'CONFLICTING_PARTICIPANTS');
    valid.source.sessions[0].historicalBookedStudentIds = [];
    expect(computeConsumedMinutes(valid.source.sessions[0], valid.source.credits).value).toBeNull();
  });
  it('retains computed class subtotal and explicit unknown coverage independent of row order', () => {
    for (const reverse of [false, true]) {
      const { e } = captured();
      e.sessions.push({ ...e.sessions[0], wiseSessionId: 'unknown', startAt: new Date(start + 13 * HOUR).toISOString(), endAt: new Date(start + 14 * HOUR).toISOString() });
      if (reverse) e.sessions.reverse();
      const r = buildWorkforceReport(e, query, now);
      expect(r.totals.creditConsumedHours).toMatchObject({ value: .5, completeness: 'partial', creditCoverage: { totalClasses: 2, computedClasses: 1, estimatedClasses: 1, unknownClasses: 1 } });
      expect(r.totals.consumedUtilizationPercent.value).toBeNull();
    }
  });
});
