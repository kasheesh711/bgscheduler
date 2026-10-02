import { formatInTimeZone } from "date-fns-tz";
import { WiseApiError, WiseClient } from "@/lib/wise/client";
import type {
  ProbeOptions,
  SourceContractReport,
  SourceWindowRequest,
  SourceWindowResult,
  StudentCreditEvidence,
  WorkforceCompleteness,
  WorkforceSession,
} from "./types";

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS_PER_REQUEST = 31;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;

export class WorkforceRequestCapError extends Error {
  constructor() { super("REQUEST_CAP_EXHAUSTED"); this.name = "WorkforceRequestCapError"; }
}

export class WorkforceSourceFetchError extends Error {
  constructor(readonly sourceError: unknown, readonly requests: number, readonly pagesReturned: number) {
    super("SOURCE_FETCH_FAILED", { cause: sourceError });
    this.name = "WorkforceSourceFetchError";
  }
}

export class WorkforceRequestBudget {
  private used = 0;
  constructor(readonly maxRequests: number) {
    if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new Error("maxRequests must be a positive integer");
  }
  beforeRequest = async (_url: string, init: RequestInit): Promise<void> => {
    if ((init.method ?? "GET").toUpperCase() !== "GET") throw new Error("WORKFORCE_SOURCE_GET_ONLY");
    if (this.used >= this.maxRequests) throw new WorkforceRequestCapError();
    this.used += 1;
  };
  get requests(): number { return this.used; }
  get exhausted(): boolean { return this.used >= this.maxRequests; }
}

export async function fetchWorkforceAvailabilityWindow(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  from: Date,
  to: Date,
): Promise<unknown> {
  const span = to.getTime() - from.getTime();
  if (!Number.isFinite(span) || span <= 0 || span > 7 * DAY_MS) {
    throw new Error("Wise availability windows must be positive and no wider than 7 days");
  }
  return client.get<unknown>(`/institutes/${instituteId}/teachers/${teacherUserId}/availability`, {
    startTime: from.toISOString(), endTime: to.toISOString(),
  }, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export function createWorkforceWiseClient(budget: WorkforceRequestBudget, signal?: AbortSignal): WiseClient {
  const userId = process.env.WISE_USER_ID?.trim();
  const apiKey = process.env.WISE_API_KEY?.trim();
  if (!userId || !apiKey) throw new Error("Wise credentials are incomplete");
  return new WiseClient({
    userId, apiKey, namespace: process.env.WISE_NAMESPACE?.trim() || "begifted-education",
    maxRetries: 0, maxConcurrency: 1, requestsPerSecond: 1, stopOnRateLimit: true,
    beforeRequest: budget.beforeRequest, signal,
  });
}

function dayKey(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date must be YYYY-MM-DD");
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) throw new Error("Invalid calendar date");
  return instant;
}

function isoDay(value: number): string { return new Date(value).toISOString().slice(0, 10); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function refId(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  return text(record(value)?._id);
}

export function normalizeWorkforceSession(raw: unknown, observedAt: string): { session: WorkforceSession | null; issues: string[] } {
  const row = record(raw);
  const issues: string[] = [];
  if (!row) return { session: null, issues: ["INVALID_SESSION_RECORD"] };
  const id = text(row._id);
  if (!id) return { session: null, issues: ["MISSING_SESSION_ID"] };
  const startMs = typeof row.scheduledStartTime === "string" ? Date.parse(row.scheduledStartTime) : NaN;
  const endMs = typeof row.scheduledEndTime === "string" ? Date.parse(row.scheduledEndTime) : NaN;
  const startAt = Number.isFinite(startMs) ? new Date(startMs).toISOString() : null;
  const endAt = Number.isFinite(endMs) && endMs > startMs ? new Date(endMs).toISOString() : null;
  if (!startAt) issues.push("INVALID_SESSION_START");
  if (startAt && !endAt) issues.push("INVALID_OR_MISSING_SESSION_END");
  const classRef = record(row.classId);
  const wiseClassId = typeof row.classId === "string" ? text(row.classId) : text(classRef?._id);
  // Session titles carry the academic label more reliably. Wise class names
  // often name the student/course container, so they are not substituted here.
  const classTitle = text(row.title);
  if (!classTitle) issues.push("SESSION_TITLE_NOT_EXPOSED");
  const bookingClassificationSource = {
    classType: text(classRef?.classType) ?? text(row.classType),
    purpose: text(row.purpose) ?? text(classRef?.purpose),
    title: text(row.title),
  };
  const userId = refId(row.userId);
  const teacherId = text(row.teacherId);
  if (!userId && !teacherId) issues.push("MISSING_TUTOR_REFERENCE");
  const rawStudents = row.students;
  const studentIds = Array.isArray(rawStudents)
    ? rawStudents.map((student) => typeof student === "string" ? text(student) : refId(student)).filter((id): id is string => Boolean(id))
    : null;
  if (!Array.isArray(rawStudents)) issues.push("HISTORICAL_PARTICIPANTS_NOT_EXPOSED");
  else {
    issues.push("HISTORICAL_PARTICIPANTS_RECONSTRUCTED_FROM_RETURNED_SESSION");
    if (studentIds!.length !== rawStudents.length) issues.push("INVALID_HISTORICAL_PARTICIPANT_ID");
  }
  if (!startAt || !endAt) issues.push("SCHEDULED_INTERVAL_INCOMPLETE");
  const scheduledMinutes = startAt && endAt ? (endMs - startMs) / 60_000 : null;
  const completeness: WorkforceCompleteness = issues.length ? "partial" : "complete";
  return {
    session: {
      wiseSessionId: id, wiseClassId, classTitle, startAt: startAt ?? "", endAt,
      scheduledMinutes, canonicalTutorKeys: [], wiseTeacherIds: teacherId ? [teacherId] : [],
      wiseUserIds: userId ? [userId] : [], historicalBookedStudentIds: studentIds,
      // The endpoint's students array may omit learners removed from the
      // current class roster, so membership is reconstructed and partial.
      participantCompleteness: Array.isArray(rawStudents) && studentIds!.length === rawStudents.length ? "partial" : "unknown",
      completeness, meetingStatus: text(row.meetingStatus), attendanceStatus: text(row.attendanceStatus),
      modality: null, subject: null, curriculum: null, level: null, observedAt, reasonCodes: [...issues],
      bookingClassificationSource,
    },
    issues,
  };
}

/** Credit history has credit units but does not expose a verified normal historical charge.
 * Do not treat account totals or mixed SESSION/CREDIT movements as a session net. */
export function normalizeStudentCreditEvidence(input: {
  wiseSessionId: string;
  wiseStudentId: string;
  observedAt: string;
  scheduledMinutes?: number | null;
  history: unknown[] | null;
}): StudentCreditEvidence {
  const matchingRows = (input.history ?? []).map(record).filter((row): row is Record<string, unknown> => Boolean(row))
    .filter((row) => text(row._id) === input.wiseSessionId);
  const sessionRows = matchingRows.filter((row) => text(row.type)?.toUpperCase() === "SESSION");
  const credit = sessionRows.length === 1 && typeof sessionRows[0].credit === "number" && Number.isFinite(sessionRows[0].credit)
    ? sessionRows[0].credit : null;
  const verifiedSessionMovement = credit !== null && credit >= 0;
  const issueCodes = [input.history === null ? "SESSION_CREDIT_HISTORY_MISSING"
    : matchingRows.length === 0 ? "SESSION_CREDIT_ENTRY_NOT_FOUND"
    : sessionRows.length === 1 && credit !== null && credit >= 0 ? null : "SESSION_CREDIT_SEMANTICS_UNVERIFIED"]
    .filter((code): code is string => code !== null);
  if (sessionRows.length > 1) issueCodes.push("MULTIPLE_SESSION_MOVEMENTS_AMBIGUOUS");
  if (sessionRows.length === 1 && credit !== null && credit < 0) issueCodes.push("NEGATIVE_SESSION_MOVEMENT_AMBIGUOUS_REFUND");
  if (sessionRows.length === 1 && credit === null) issueCodes.push("SESSION_MOVEMENT_AMOUNT_MISSING");
  const normalCredits = input.scheduledMinutes !== null && input.scheduledMinutes !== undefined
    && Number.isFinite(input.scheduledMinutes) && input.scheduledMinutes > 0
    ? input.scheduledMinutes / 60 : null;
  if (normalCredits !== null) issueCodes.push("OWNER_CONFIRMED_ONE_CREDIT_PER_HOUR");
  else issueCodes.push("SCHEDULED_NORMAL_CREDITS_UNKNOWN");
  return {
    wiseSessionId: input.wiseSessionId, wiseStudentId: input.wiseStudentId,
    netCredits: verifiedSessionMovement ? credit : null, normalCredits,
    evidenceStatus: verifiedSessionMovement ? "verified" : "unknown",
    sourceInterpretation: verifiedSessionMovement ? "verified_session_charge" : sessionRows.length || matchingRows.some((row) => ["REFUND", "CREDIT"].includes(text(row.type)?.toUpperCase() ?? "")) ? "ambiguous_ledger_movement" : "unverified_historical_normal_charge",
    observedAt: input.observedAt, issueCodes,
  };
}

interface FetchDependencies { client?: WiseClient; budget?: WorkforceRequestBudget; instituteId?: string; now?: () => Date; }

/** Retrieves a bounded, paginated historical window. A page-complete window stays complete
 * even when individual facts have unsupported credit or participant semantics. */
export async function fetchWorkforceSourceWindow(
  input: SourceWindowRequest,
  dependencies: FetchDependencies = {},
): Promise<SourceWindowResult> {
  const from = dayKey(input.from);
  const to = dayKey(input.to);
  if (to < from) throw new Error("to must be on or after from");
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = input.maxPages ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new Error("pageSize must be between 1 and 100");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");
  const budget = dependencies.budget ?? new WorkforceRequestBudget(input.maxRequests);
  const client = dependencies.client ?? createWorkforceWiseClient(budget);
  const instituteId = dependencies.instituteId ?? process.env.WISE_INSTITUTE_ID;
  if (!instituteId?.trim()) throw new Error("WISE_INSTITUTE_ID is not configured");
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const issues: string[] = [];
  const allSessions: WorkforceSession[] = [];
  const seen = new Set<string>();
  let pagesRequested = 0;
  let pagesReturned = 0;
  let recordsReturned = 0;
  let truncated = false;
  let stoppedByCap = false;
  let advertisedEnd: number | null = null;

  outer: for (let windowStart = from; windowStart <= to;) {
    const windowEndExclusive = Math.min(to + DAY_MS, windowStart + MAX_RANGE_DAYS_PER_REQUEST * DAY_MS);
    let page = 1;
    let advertisedPages: number | null = null;
    while (true) {
      if (pagesRequested >= maxPages || budget.exhausted) {
        truncated = true; stoppedByCap = true; issues.push(pagesRequested >= maxPages ? "PAGE_CAP_EXHAUSTED" : "REQUEST_CAP_EXHAUSTED");
        break outer;
      }
      pagesRequested += 1;
      let response: unknown;
      try {
        response = await client.get<unknown>(`/institutes/${instituteId}/sessions`, {
        status: "PAST", paginateBy: "DATE", startDate: isoDay(windowStart),
        endDate: isoDay(windowEndExclusive), page_number: String(page), page_size: String(pageSize),
      }, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        throw new WorkforceSourceFetchError(error, budget.requests, pagesReturned);
      }
      const envelope = record(response);
      const data = record(envelope?.data);
      const sessions = data?.sessions;
      if (!Array.isArray(sessions)) {
        issues.push("SESSION_RESPONSE_MISSING_ARRAY"); truncated = true; break outer;
      }
      pagesReturned += 1;
      recordsReturned += sessions.length;
      const advertised = typeof data?.page_count === "number" && Number.isInteger(data.page_count) && data.page_count >= 0 ? data.page_count : null;
      if (advertised !== null) {
        if (advertisedPages !== null && advertised !== advertisedPages) { issues.push("SESSION_PAGE_COUNT_CHANGED"); truncated = true; break outer; }
        advertisedPages = advertised;
        if (advertised === 0 && sessions.length > 0) { issues.push("SESSION_PAGE_COUNT_CONTRADICTS_CONTENT"); truncated = true; break outer; }
      }
      for (const raw of sessions) {
        const normalized = normalizeWorkforceSession(raw, observedAt);
        issues.push(...normalized.issues);
        if (!normalized.session) { truncated = true; continue; }
        if (seen.has(normalized.session.wiseSessionId)) { issues.push("DUPLICATE_SESSION_ID"); continue; }
        seen.add(normalized.session.wiseSessionId);
        allSessions.push(normalized.session);
        const startMs = Date.parse(normalized.session.startAt);
        if (Number.isFinite(startMs)) advertisedEnd = advertisedEnd === null ? startMs : Math.max(advertisedEnd, startMs);
      }
      if (sessions.length === 0 && advertisedPages !== null && (page > 1 || advertisedPages > 1)) {
        issues.push("EMPTY_ADVERTISED_SESSION_PAGE"); truncated = true; break outer;
      }
      if (advertisedPages !== null ? page >= advertisedPages : sessions.length < pageSize) break;
      if (sessions.length === 0) { issues.push("EMPTY_ADVERTISED_SESSION_PAGE"); truncated = true; break outer; }
      page += 1;
    }
    windowStart = windowEndExclusive;
  }

  const credits: StudentCreditEvidence[] = [];
  // Undefined means collect all returned participant pairs. An explicit empty
  // array keeps contract probes session-only. Never substitute a class roster.
  const examples = input.creditExamples ?? allSessions.flatMap(session =>
    session.wiseClassId && session.historicalBookedStudentIds
      ? session.historicalBookedStudentIds.map(studentId => ({ classId: session.wiseClassId!, studentId, sessionId: session.wiseSessionId })) : []);
  const pairs = new Map<string, { classId: string; studentId: string; sessionIds: Set<string> }>();
  for (const example of examples) {
    const key = JSON.stringify([example.classId, example.studentId]);
    const pair = pairs.get(key) ?? { classId: example.classId, studentId: example.studentId, sessionIds: new Set<string>() };
    pair.sessionIds.add(example.sessionId ?? "unknown_session");
    pairs.set(key, pair);
  }
  for (const pair of pairs.values()) {
    let history: unknown[] | null = null;
    if (budget.exhausted) {
      // Financial evidence may be partial while session date retrieval is complete.
      issues.push("CREDIT_EXAMPLE_REQUEST_CAP_EXHAUSTED");
    } else {
      try {
        const response = await client.get<unknown>(`/institutes/${instituteId}/classes/${pair.classId}/students/${pair.studentId}/sessionCredits`, { fetchHistory: "true" }, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const data = record(record(response)?.data);
        history = Array.isArray(data?.sessionCreditHistory) ? data.sessionCreditHistory : null;
        if (history === null) issues.push("SESSION_CREDIT_HISTORY_NOT_EXPOSED");
      } catch (error) {
        if (error instanceof WiseApiError && error.status === 429) throw new WorkforceSourceFetchError(error, budget.requests, pagesReturned);
        issues.push("SESSION_CREDIT_FETCH_FAILED");
      }
    }
    for (const sessionId of pair.sessionIds) credits.push(normalizeStudentCreditEvidence({
      wiseSessionId: sessionId, wiseStudentId: pair.studentId, observedAt,
      scheduledMinutes: allSessions.find(session => session.wiseSessionId === sessionId)?.scheduledMinutes, history,
    }));
  }

  const complete = !truncated && !stoppedByCap;
  const completeness: WorkforceCompleteness = complete ? "complete" : "partial";
  const first = allSessions.map((session) => Date.parse(session.startAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const coverage = {
    source: "wise_sessions_past", requestedFrom: input.from, requestedTo: input.to,
    returnedFrom: first === undefined ? null : formatInTimeZone(new Date(first), "Asia/Bangkok", "yyyy-MM-dd"),
    returnedTo: advertisedEnd === null ? null : formatInTimeZone(new Date(advertisedEnd), "Asia/Bangkok", "yyyy-MM-dd"),
    observedAt, pagesRequested, pagesReturned, recordsReturned, truncated, completeness,
    issueCodes: [...new Set(issues)],
  };
  const evidence = {
    people: [], observations: [], tutorFacts: [], sessions: allSessions,
    historicalBookedParticipants: allSessions.flatMap((session) => session.historicalBookedStudentIds === null ? [] : [{
      wiseSessionId: session.wiseSessionId, studentIds: session.historicalBookedStudentIds,
      completeness: session.participantCompleteness, source: "wise_sessions_past", reasonCodes: session.reasonCodes,
    }]),
    studentCredits: credits, subjectMappings: [], terminationMarks: [], sourceCoverage: [coverage],
  };
  return {
    sourceKey: "wise_sessions_past", observedAt, evidence,
    requestedWindow: { from: input.from, to: input.to },
    returnedWindow: { from: coverage.returnedFrom, to: coverage.returnedTo },
    paging: { requests: budget.requests, pagesRequested, pagesReturned, recordsReturned },
    truncated, completeness, complete, sessions: allSessions, credits,
    contractIssues: [...new Set(issues)],
  };
}

/** Bounded source probe; detailed availability payloads stay in its private diagnostics file. */
export async function probeWorkforceSources(options: ProbeOptions): Promise<SourceContractReport> {
  const rangeDays = (dayKey(options.to) - dayKey(options.from)) / DAY_MS + 1;
  if (rangeDays > options.maxDates) throw new Error("Requested date range exceeds maxDates");
  if (options.creditExamples.length > options.maxCreditExamples) throw new Error("creditExamples exceeds maxCreditExamples");
  const budget = new WorkforceRequestBudget(options.maxRequests);
  const client = createWorkforceWiseClient(budget, AbortSignal.timeout(120_000));
  const source = await fetchWorkforceSourceWindow({
    from: options.from, to: options.to, maxRequests: options.maxRequests, maxPages: options.maxPages,
    creditExamples: [],
  }, { client, budget, instituteId: process.env.WISE_INSTITUTE_ID });
  const contractIssues = [...source.contractIssues];
  const availabilitySamples: Array<{ teacherUserId: string; windows: Array<{ from: string; to: string; response: unknown }> }> = [];
  const availabilityTeacherUserIds = options.availabilityTeacherUserIds.length
    ? options.availabilityTeacherUserIds
    : source.sessions.flatMap((session) => session.wiseUserIds ?? []).slice(0, 1);
  let availabilityCompleteness: WorkforceCompleteness = availabilityTeacherUserIds.length ? "complete" : "unknown";
  const availabilityFrom = dayKey(options.from);
  const availabilityTo = Math.max(availabilityFrom, dayKey(options.to) - 7 * DAY_MS);
  for (const teacherUserId of availabilityTeacherUserIds) {
    const windows: Array<{ from: string; to: string; response: unknown }> = [];
    const starts = [...new Set([availabilityFrom, availabilityTo])];
    for (const startDay of starts) {
      if (budget.exhausted) { availabilityCompleteness = "partial"; contractIssues.push("REQUEST_CAP_EXHAUSTED"); break; }
      const from = new Date(startDay);
      const to = new Date(startDay + 7 * DAY_MS);
      try {
        const response = await fetchWorkforceAvailabilityWindow(client, process.env.WISE_INSTITUTE_ID ?? "", teacherUserId, from, to);
        windows.push({ from: isoDay(startDay), to: isoDay(startDay + 7 * DAY_MS), response });
      } catch (error) {
        if (error instanceof WiseApiError && error.status === 429) throw error;
        availabilityCompleteness = "partial"; contractIssues.push("AVAILABILITY_FETCH_FAILED"); break;
      }
    }
    availabilitySamples.push({ teacherUserId, windows });
  }

  // If examples were not supplied, derive a tiny bounded sample from returned
  // participant IDs. This never substitutes a current class roster.
  const credits = [...source.credits];
  const creditDiagnostics: Array<{
    label: string; classId: string; studentId: string; sessionId: string | undefined;
    history: Array<{ id: string | null; type: string | null; credit: number | null; duration: number | null; meetingStatus: string | null; classroomId: string | null; classroomName: string | null }> | null;
  }> = [];
  const requestedExamples = options.creditExamples.length
    ? options.creditExamples.slice(0, options.maxCreditExamples)
    : [...source.sessions].sort((a, b) => (b.historicalBookedStudentIds?.length ?? 0) - (a.historicalBookedStudentIds?.length ?? 0))
      .flatMap((session) => session.wiseClassId && session.historicalBookedStudentIds
      ? session.historicalBookedStudentIds.map((studentId) => ({
        label: "bounded_session_participant", classId: session.wiseClassId!, studentId, sessionId: session.wiseSessionId,
      })) : []).slice(0, options.maxCreditExamples);
  for (const example of requestedExamples) {
    if (credits.some((credit) => credit.wiseSessionId === example.sessionId && credit.wiseStudentId === example.studentId)) continue;
    if (budget.exhausted) { contractIssues.push("REQUEST_CAP_EXHAUSTED"); break; }
    try {
      const response = await client.get<unknown>(`/institutes/${process.env.WISE_INSTITUTE_ID}/classes/${example.classId}/students/${example.studentId}/sessionCredits`, { fetchHistory: "true" }, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const data = record(record(response)?.data);
      const history = Array.isArray(data?.sessionCreditHistory) ? data.sessionCreditHistory : null;
      creditDiagnostics.push({
        label: example.label, classId: example.classId, studentId: example.studentId, sessionId: example.sessionId,
        history: history?.map((value) => {
          const row = record(value);
          const classroom = record(row?.classroom);
          return {
            id: text(row?._id), type: text(row?.type),
            credit: typeof row?.credit === "number" && Number.isFinite(row.credit) ? row.credit : null,
            duration: typeof row?.duration === "number" && Number.isFinite(row.duration) ? row.duration : null,
            meetingStatus: text(row?.meetingStatus), classroomId: text(classroom?._id), classroomName: text(classroom?.name),
          };
        }) ?? null,
      });
      credits.push(normalizeStudentCreditEvidence({
        wiseSessionId: example.sessionId ?? "unknown_session", wiseStudentId: example.studentId,
        observedAt: new Date().toISOString(),
        scheduledMinutes: source.sessions.find((session) => session.wiseSessionId === example.sessionId)?.scheduledMinutes,
        history,
      }));
    } catch (error) {
      if (error instanceof WiseApiError && error.status === 429) throw error;
      contractIssues.push("SESSION_CREDIT_FETCH_FAILED");
    }
  }
  source.evidence.studentCredits = credits;
  const creditConclusions = credits;
  const creditsSeen = new Set(creditConclusions.map((credit) => credit.sourceInterpretation));
  const allCreditExamplesObserved = requestedExamples.length > 0 && requestedExamples.every(example =>
    credits.some(credit => credit.wiseSessionId === (example.sessionId ?? "unknown_session") && credit.wiseStudentId === example.studentId));
  const ambiguousRefunds = "unknown" as const;
  const report: SourceContractReport & {
    availabilityDiagnostics: typeof availabilitySamples;
    sampleLabels: Array<{ classId: string | null; title: string | null; sessionId: string }>;
    creditExamples: ProbeOptions["creditExamples"];
    creditDiagnostics: typeof creditDiagnostics;
  } = {
    requestedWindow: source.requestedWindow, completedAt: new Date().toISOString(),
    requests: budget.requests, pages: source.paging.pagesReturned, contractIssues,
    conclusions: {
      historicalParticipants: source.sessions.some((session) => session.participantCompleteness !== "complete") ? source.sessions.some((session) => session.participantCompleteness === "unknown") ? "unknown" : "partial" : "complete",
      availabilityCoverage: availabilityCompleteness,
      currentBalanceOrLedger: creditsSeen.has("verified_session_charge") || creditsSeen.has("ambiguous_ledger_movement") ? "ledger_movement" : "unknown",
      historicalNormalCharges: !allCreditExamplesObserved ? "unknown"
        : credits.every((credit) => credit.normalCredits !== null) ? "verified" : "not_exposed", ambiguousRefunds,
    },
    evidence: source.evidence,
    availabilityDiagnostics: availabilitySamples,
    sampleLabels: source.sessions.map((session) => ({ classId: session.wiseClassId, title: session.classTitle, sessionId: session.wiseSessionId })),
    creditExamples: requestedExamples,
    creditDiagnostics,
  };
  report.conclusions.availabilityCoverage = availabilityCompleteness;
  report.requests = budget.requests;
  return report;
}
