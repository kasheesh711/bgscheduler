import { formatInTimeZone } from "date-fns-tz";
import type { Database } from "@/lib/db";
import type { WiseCreditSession } from "@/lib/credit-control/wise";
import { persistWorkforceSourceWindow } from "./observation-store";
import { normalizeStudentCreditEvidence, normalizeWorkforceSession } from "./wise-source";
import type { SourceWindowResult } from "./types";

export interface CreditControlCaptureInput {
  snapshotId: string;
  observedAt: Date;
  from: Date;
  to: Date;
  sessions: WiseCreditSession[];
  pairs: Array<{
    wiseClassId: string;
    wiseStudentId: string;
    creditsObservedAt: Date;
    history: Array<{ raw: Record<string, unknown> }>;
  }>;
}

/** Converts existing GET results; never makes a Wise request or claims date coverage. */
export function buildCreditControlWorkforceEvidence(input: CreditControlCaptureInput): SourceWindowResult {
  const observedAt = input.observedAt.toISOString();
  const sessions = new Map<string, SourceWindowResult["sessions"][number]>();
  for (const raw of input.sessions) {
    const normalized = normalizeWorkforceSession({
      ...raw, scheduledStartTime: raw.scheduledStartTime.toISOString(),
      scheduledEndTime: raw.scheduledEndTime?.toISOString(),
    }, observedAt).session;
    if (normalized && normalized.startAt) sessions.set(normalized.wiseSessionId, normalized);
  }
  const pairs = new Map(input.pairs.map(pair => [JSON.stringify([pair.wiseClassId, pair.wiseStudentId]), pair]));
  const credits: SourceWindowResult["credits"] = [];
  for (const session of sessions.values()) {
    for (const studentId of new Set(session.historicalBookedStudentIds ?? [])) {
      const pair = pairs.get(JSON.stringify([session.wiseClassId, studentId]));
      // Old cached raw rows may contain a Zod-defaulted zero. Only new raw
      // source-preserving rows prove the presence of the numeric credit field.
      const history = pair?.history.map(({ raw }) => raw._workforceRawCreditEvidence === true ? raw : { ...raw, credit: undefined }) ?? null;
      credits.push(normalizeStudentCreditEvidence({
        wiseSessionId: session.wiseSessionId, wiseStudentId: studentId,
        observedAt: pair?.creditsObservedAt.toISOString() ?? observedAt,
        scheduledMinutes: session.scheduledMinutes, history,
      }));
    }
  }
  const facts = [...sessions.values()];
  const requestedWindow = { from: formatInTimeZone(input.from, "Asia/Bangkok", "yyyy-MM-dd"), to: formatInTimeZone(input.to, "Asia/Bangkok", "yyyy-MM-dd") };
  const coverage = {
    source: "credit_control_observation", requestedFrom: requestedWindow.from, requestedTo: requestedWindow.to,
    returnedFrom: null, returnedTo: null, observedAt, pagesRequested: 0, pagesReturned: 0,
    recordsReturned: facts.length, truncated: false, completeness: "partial" as const,
    issueCodes: ["CREDIT_CONTROL_DATE_RETRIEVAL_COMPLETENESS_UNVERIFIED"],
  };
  return {
    sourceKey: `credit-control-workforce:${input.snapshotId}`, observedAt,
    requestedWindow, returnedWindow: { from: null, to: null },
    paging: { requests: 0, pagesRequested: 0, pagesReturned: 0, recordsReturned: facts.length },
    truncated: false, complete: false, completeness: "partial", sessions: facts, credits,
    contractIssues: coverage.issueCodes,
    evidence: { people: [], observations: [], tutorFacts: [], sessions: facts,
      historicalBookedParticipants: facts.flatMap(session => session.historicalBookedStudentIds === null ? [] : [{
        wiseSessionId: session.wiseSessionId, studentIds: session.historicalBookedStudentIds,
        completeness: session.participantCompleteness, source: "credit_control_observation", reasonCodes: session.reasonCodes,
      }]), studentCredits: credits, subjectMappings: [], terminationMarks: [], sourceCoverage: [coverage] },
  };
}

export async function captureCreditControlWorkforceEvidence(db: Database, input: CreditControlCaptureInput): Promise<SourceWindowResult> {
  const evidence = buildCreditControlWorkforceEvidence(input);
  await persistWorkforceSourceWindow(db, evidence, { mode: "observation_only" });
  return evidence;
}
