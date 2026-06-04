import { WiseClient } from "./client";
import {
  WiseTeacher,
  WiseAvailabilityResponse,
  WiseSession,
  WiseTeachersResponse,
  WiseAvailabilityEnvelope,
  WiseSessionsResponse,
  WiseLocationsResponse,
  WiseSessionUpdateResponse,
  WiseActivityEvent,
  WiseActivityEventsResponse,
  WiseSessionStatsResponse,
  WiseClassroomStatsResponse,
  WiseClassroomTrendsResponse,
  WiseInstituteTrendsResponse,
  WiseFeeTransaction,
  WiseFeeTransactionsResponse,
} from "./types";
import { addDays } from "date-fns";

const PAGE_LIMIT = 1000;
const RECEIPT_PAGE_SIZE = 50;
const RECEIPT_MAX_PAGES = 200;

/**
 * Fetch all teachers from a Wise institute.
 */
export async function fetchAllTeachers(
  client: WiseClient,
  instituteId: string
): Promise<WiseTeacher[]> {
  const res = await client.get<WiseTeachersResponse>(`/institutes/${instituteId}/teachers`);
  return res.data?.teachers ?? [];
}

/**
 * Fetch availability for a single teacher for a single 7-day window.
 */
export async function fetchTeacherAvailability(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  startDate: Date,
  endDate: Date
): Promise<WiseAvailabilityResponse> {
  const res = await client.get<WiseAvailabilityEnvelope>(
    `/institutes/${instituteId}/teachers/${teacherUserId}/availability`,
    {
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
    }
  );
  return res.data ?? {};
}

/**
 * Fetch recurring workingHours (single 7-day window) and all leaves
 * across the 180-day horizon (26 seven-day windows).
 */
export async function fetchTeacherFullAvailability(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  horizonDays: number = 180
): Promise<{
  workingHours: WiseAvailabilityResponse["workingHours"];
  leaves: WiseAvailabilityResponse["leaves"];
}> {
  const now = new Date();
  const windowCount = Math.ceil(horizonDays / 7);

  // First window gives us workingHours + first batch of leaves
  const firstWindow = await fetchTeacherAvailability(
    client,
    instituteId,
    teacherUserId,
    now,
    addDays(now, 7)
  );

  const workingHours = firstWindow.workingHours;
  const allLeaves = [...(firstWindow.leaves ?? [])];

  // Remaining windows for leaves only
  const leavePromises: Promise<WiseAvailabilityResponse>[] = [];
  for (let i = 1; i < windowCount; i++) {
    const start = addDays(now, i * 7);
    const end = addDays(start, 7);
    leavePromises.push(
      fetchTeacherAvailability(client, instituteId, teacherUserId, start, end)
    );
  }

  const leaveResults = await Promise.all(leavePromises);
  for (const result of leaveResults) {
    if (result.leaves) {
      allLeaves.push(...result.leaves);
    }
  }

  return { workingHours, leaves: allLeaves };
}

/**
 * Fetch all future sessions from a Wise institute, handling pagination.
 */
export async function fetchAllFutureSessions(
  client: WiseClient,
  instituteId: string
): Promise<WiseSession[]> {
  return fetchAllInstituteSessions(client, instituteId, { status: "FUTURE" });
}

export async function fetchAllInstituteSessions(
  client: WiseClient,
  instituteId: string,
  params: { status?: string } = {},
): Promise<WiseSession[]> {
  const all: WiseSession[] = [];
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const requestParams: Record<string, string> = {
      paginateBy: "COUNT",
      page_number: String(page),
      page_size: String(PAGE_LIMIT),
    };
    if (params.status) requestParams.status = params.status;

    const res = await client.get<WiseSessionsResponse>(
      `/institutes/${instituteId}/sessions`,
      requestParams,
    );

    const sessions = res.data?.sessions ?? [];
    all.push(...sessions);
    pageCount = res.data?.page_count ?? page;
    if (sessions.length === 0) break;
    page++;
  }

  return all;
}

/**
 * Fetch the institute-level room/location strings used by Wise's webapp.
 */
export async function fetchInstituteLocations(
  client: WiseClient,
  instituteId: string
): Promise<string[]> {
  const res = await client.get<WiseLocationsResponse>(`/institutes/${instituteId}/locations`);
  return res.data?.locations ?? [];
}

export interface WisePromotionStudent {
  _id: string;
  name?: string;
  email?: string;
  activated?: boolean;
  parents?: Array<{ _id?: string; name?: string; [key: string]: unknown }>;
  classrooms?: Array<{ _id?: string; name?: string; subject?: string; classType?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface WiseRegistrationField {
  questionId?: string;
  questionText?: string;
  type?: string;
  answer?: string;
  [key: string]: unknown;
}

export interface WiseParticipantRegistrationData {
  _id?: string;
  name?: string;
  email?: string;
  status?: string;
  tags?: unknown[];
  registrationData?: {
    fields?: WiseRegistrationField[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface WiseCourseDetail {
  _id: string;
  name?: string;
  subject?: string;
  classType?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WiseCourseParticipant {
  _id?: string;
  userId?: string | { _id?: string; name?: string; [key: string]: unknown };
  name?: string;
  profile?: string;
  [key: string]: unknown;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function fetchWiseAcceptedStudents(
  client: WiseClient,
  instituteId: string,
): Promise<WisePromotionStudent[]> {
  const students: WisePromotionStudent[] = [];
  const pageSize = 100;

  for (let page = 1; ; page += 1) {
    const res = await client.get<{ data?: { students?: WisePromotionStudent[] } }>(
      `/institutes/v3/${instituteId}/students`,
      {
        status: "ACCEPTED",
        page_number: String(page),
        page_size: String(pageSize),
        showParents: "true",
        showFeedbackData: "true",
        showContractStatus: "true",
      },
    );
    const batch = res.data?.students ?? [];
    students.push(...batch);
    if (batch.length < pageSize) break;
  }

  return students;
}

export async function fetchWiseStudentRegistrationData(
  client: WiseClient,
  instituteId: string,
  studentId: string,
): Promise<WiseParticipantRegistrationData> {
  const res = await client.get<{ data?: WiseParticipantRegistrationData }>(
    `/institutes/${instituteId}/participants/${studentId}`,
    { showRegistrationData: "true" },
  );
  return res.data ?? {};
}

export async function updateWiseStudentRegistrationAnswers(
  client: WiseClient,
  instituteId: string,
  studentId: string,
  answers: Array<{ questionId: string; answer: string }>,
): Promise<unknown> {
  return client.put<unknown>(
    `/institutes/${instituteId}/students/${studentId}/registration`,
    { answers },
  );
}

export async function fetchWiseCourse(
  client: WiseClient,
  classId: string,
): Promise<WiseCourseDetail | null> {
  const res = await client.get<{ data?: WiseCourseDetail }>(
    `/user/v2/classes/${classId}`,
    { full: "true" },
  );
  return res.data ?? null;
}

export async function updateWiseCourseSubject(
  client: WiseClient,
  classId: string,
  subject: string,
): Promise<unknown> {
  return client.put<unknown>("/teacher/editClass", { classId, subject });
}

export async function fetchWiseCourseParticipants(
  client: WiseClient,
  classId: string,
): Promise<WiseCourseParticipant[]> {
  const res = await client.get<{ data?: Record<string, unknown> }>(
    `/user/classes/${classId}/participants`,
    { showCoTeachers: "true" },
  );
  const data = res.data ?? {};
  const candidates = [
    data.students,
    data.participants,
    data.users,
    data.learners,
  ];

  return candidates.flatMap((candidate) => asArray(candidate) as WiseCourseParticipant[]);
}

export interface WiseSessionAvailabilityInput {
  teacherId?: string;
  sessions: {
    teacherId?: string;
    classId?: string;
    sessionId?: string;
    scheduledStartTime: string | Date;
    scheduledEndTime: string | Date;
    type?: string;
  }[];
  locationToCheck?: string;
  studentId?: string;
  sessionsToSkip?: {
    sessionId: string;
    skipUpcoming: boolean;
    classId?: string;
    startTime?: string | Date;
  } | Array<{
    sessionId: string;
    skipUpcoming?: boolean;
    classId?: string;
    startTime?: string | Date;
  }>;
}

export interface WiseSessionAvailabilityResponse {
  sessions?: { sessionId?: string; conflict?: boolean; hasConflict?: boolean; [key: string]: unknown }[];
  availability?: unknown;
  totalSessions?: number;
  [key: string]: unknown;
}

/**
 * Wise webapp uses this institute endpoint to validate teacher/time/location
 * conflicts before scheduling or editing offline sessions.
 */
export async function checkTeacherAvailabilityForSessions(
  client: WiseClient,
  instituteId: string,
  body: WiseSessionAvailabilityInput
): Promise<WiseSessionAvailabilityResponse> {
  const res = await client.post<{ data?: WiseSessionAvailabilityResponse }>(
    `/institutes/${instituteId}/checkSessionsAvailability`,
    body
  );
  return res.data ?? {};
}

/**
 * Update the Wise location field for one scheduled session.
 * V1 callers only invoke this for OFFLINE sessions.
 */
export async function updateSessionLocation(
  client: WiseClient,
  classId: string,
  sessionId: string,
  location: string
): Promise<WiseSessionUpdateResponse> {
  return client.put<WiseSessionUpdateResponse>(
    `/teacher/classes/${classId}/sessions/${sessionId}?updateType=SINGLE`,
    { location }
  );
}

export interface WiseScheduleSessionInput {
  classId: string;
  userId: string;
  title: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  location?: string;
}

/**
 * Schedule a single new session into an existing Wise class.
 *
 * 1. POST `/teacher/classes/${classId}/sessions` with one SINGLE session
 *    (location is included only when provided — OFFLINE bookings need it).
 * 2. Parse the response as WiseSessionUpdateResponse and pull the created
 *    session id from `data.sessionId` (tolerant of the field being absent).
 *
 * Callers gate this behind WISE_SESSION_CREATE_VERIFIED and run an availability
 * pre-check first; this fetcher itself performs no verification.
 *
 * @returns the created `sessionId` (null when the response omits it) and the raw response.
 */
export async function scheduleWiseSession(
  client: WiseClient,
  input: WiseScheduleSessionInput
): Promise<{ sessionId: string | null; raw: WiseSessionUpdateResponse }> {
  const raw = await client.post<WiseSessionUpdateResponse>(
    `/teacher/classes/${input.classId}/sessions`,
    {
      userId: input.userId,
      title: input.title,
      sessions: [
        {
          type: "SINGLE",
          scheduledStartTime: input.scheduledStartTime,
          scheduledEndTime: input.scheduledEndTime,
          ...(input.location ? { location: input.location } : {}),
        },
      ],
    }
  );

  const data = raw.data;
  const sessionId =
    data && typeof data === "object" && "sessionId" in data
      ? String((data as { sessionId?: unknown }).sessionId ?? "") || null
      : null;

  return { sessionId, raw };
}

export interface WiseActivityEventsParams {
  pageNumber?: number;
  pageSize?: number;
  type?: string;
  eventName?: string;
  userId?: string;
  classIds?: string[];
}

export async function fetchWiseActivityEvents(
  client: WiseClient,
  instituteId: string,
  params: WiseActivityEventsParams = {},
): Promise<WiseActivityEvent[]> {
  const requestParams: Record<string, string> = {
    page_number: String(params.pageNumber ?? 1),
    page_size: String(Math.max(1, Math.min(params.pageSize ?? 50, 50))),
  };
  if (params.type) requestParams.type = params.type;
  if (params.eventName) requestParams.eventName = params.eventName;
  if (params.userId) requestParams.userId = params.userId;
  if (params.classIds?.length) requestParams.classIds = params.classIds.join(",");

  const res = await client.get<WiseActivityEventsResponse>(
    `/institutes/${instituteId}/events`,
    requestParams,
  );
  return res.data?.events ?? [];
}

export async function fetchWiseSessionStats(
  client: WiseClient,
  instituteId: string,
  params: { from?: Date; to?: Date } = {},
): Promise<WiseSessionStatsResponse["data"]> {
  const requestParams: Record<string, string> = {};
  if (params.from) requestParams.from = params.from.toISOString();
  if (params.to) requestParams.to = params.to.toISOString();

  const res = await client.get<WiseSessionStatsResponse>(
    `/institutes/${instituteId}/analytics/sessionStats`,
    requestParams,
  );
  return res.data ?? {};
}

export async function fetchWiseClassroomStats(
  client: WiseClient,
  instituteId: string,
): Promise<WiseClassroomStatsResponse["data"]> {
  const res = await client.get<WiseClassroomStatsResponse>(
    `/institutes/${instituteId}/analytics/classroomStats`,
  );
  return res.data ?? {};
}

export async function fetchWiseClassroomTrends(
  client: WiseClient,
  instituteId: string,
): Promise<WiseClassroomTrendsResponse["data"]> {
  const res = await client.get<WiseClassroomTrendsResponse>(
    `/institutes/${instituteId}/analytics/classroomTrends`,
  );
  return res.data ?? {};
}

export interface WiseFeesPaidTrend {
  timestamp: string;
  count: number;
  amountMinor: number;
  amount: number;
  currency: string;
}

function amountMinorToMajor(value: number, currency: string): number {
  return currency.toUpperCase() === "THB" ? value / 100 : value;
}

export async function fetchWiseFeesPaidTrends(
  client: WiseClient,
  instituteId: string,
): Promise<WiseFeesPaidTrend[]> {
  const res = await client.get<WiseInstituteTrendsResponse>(
    `/institutes/${instituteId}/trends`,
    {
      showFeeCollectionTrends: "true",
      showPayoutTrends: "true",
    },
    {
      headers: {
        "x-wise-timezone": "Asia/Bangkok",
        "x-wise-platform": "web",
      },
    },
  );

  return (res.data?.trends?.feesPaid?.trends ?? [])
    .map((trend) => {
      const timestamp = typeof trend.timestamp === "string" ? trend.timestamp : "";
      const currency = typeof trend.amount?.currency === "string" ? trend.amount.currency : "THB";
      const amountMinor = typeof trend.amount?.value === "number" && Number.isFinite(trend.amount.value)
        ? trend.amount.value
        : 0;
      return {
        timestamp,
        count: typeof trend.count === "number" && Number.isFinite(trend.count) ? trend.count : 0,
        amountMinor,
        amount: amountMinorToMajor(amountMinor, currency),
        currency,
      };
    })
    .filter((trend) => trend.timestamp);
}

export interface WiseReceiptTransaction {
  id: string;
  type: string;
  status: string;
  chargedAt: string;
  createdAt: string | null;
  amountMinor: number | null;
  amount: number | null;
  currency: string;
  note: string;
  classId: string | null;
  classroomName: string | null;
  classroomSubject: string | null;
  studentId: string | null;
  studentName: string | null;
  parentIds: string[];
  parentNames: string[];
  identifiers: string[];
  raw: Record<string, unknown>;
}

export interface WiseReceiptTransactionFetchOptions {
  startDate: string;
  endDate: string;
  pageSize?: number;
  maxPages?: number;
}

function bangkokDateStartIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0)).toISOString();
}

function bangkokDateEndIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, -7, 0, 0, -1)).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedString(value: unknown, path: string[]): string {
  let cursor: unknown = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return "";
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return stringValue(cursor);
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(stringValue).filter(Boolean))];
}

function normalizeWiseReceipt(raw: WiseFeeTransaction): WiseReceiptTransaction | null {
  const id = stringValue(raw._id) || stringValue(raw.id);
  const type = stringValue(raw.type);
  const status = stringValue(raw.status);
  const chargedAt = stringValue(raw.chargedAt) || stringValue(raw.createdAt);
  if (!id || !chargedAt) return null;

  const metadata = recordValue(raw.metadata);
  const invoice = recordValue(raw.invoice);
  const paymentOption = recordValue(raw.paymentOption);
  const amountMinor = numberValue(raw.amount?.value);
  const currency = stringValue(raw.amount?.currency) || "THB";

  return {
    id,
    type,
    status,
    chargedAt,
    createdAt: stringValue(raw.createdAt) || null,
    amountMinor,
    amount: amountMinor === null ? null : amountMinorToMajor(amountMinor, currency),
    currency,
    note: stringValue(raw.note),
    classId: stringValue(raw.classId) || stringValue(metadata.classId) || stringValue(raw.classroom?._id) || null,
    classroomName: stringValue(raw.classroom?.name) || null,
    classroomSubject: stringValue(raw.classroom?.subject) || null,
    studentId: stringValue(raw.studentId) || stringValue(raw.student?._id) || stringValue(raw.participant?._id) || null,
    studentName: stringValue(raw.student?.name) || stringValue(raw.participant?.name) || null,
    parentIds: uniqueStrings((raw.parents ?? []).map((parent) => parent._id)),
    parentNames: uniqueStrings((raw.parents ?? []).map((parent) => parent.name)),
    identifiers: uniqueStrings([
      id,
      raw.transactionId,
      raw.invoiceId,
      raw.invoiceNumber,
      metadata.transactionId,
      metadata.invoiceId,
      metadata.invoiceNumber,
      metadata.paymentOptionId,
      invoice._id,
      invoice.id,
      invoice.invoiceNumber,
      paymentOption._id,
      paymentOption.id,
      nestedString(raw, ["payment", "id"]),
      nestedString(raw, ["transaction", "id"]),
    ]),
    raw: raw as Record<string, unknown>,
  };
}

export async function fetchWiseReceiptTransactions(
  client: WiseClient,
  instituteId: string,
  options: WiseReceiptTransactionFetchOptions,
): Promise<WiseReceiptTransaction[]> {
  const pageSize = options.pageSize ?? RECEIPT_PAGE_SIZE;
  const maxPages = options.maxPages ?? RECEIPT_MAX_PAGES;
  const receipts: WiseReceiptTransaction[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const res = await client.get<WiseFeeTransactionsResponse>(
      `/institutes/${instituteId}/fees/transactions`,
      {
        type: "PAYMENT,OFFLINE_PAYMENT,DISBURSAL",
        status: "CHARGED,PENDING_CONFIRMATION",
        populateParticipant: "true",
        populateClassroom: "true",
        page_size: String(pageSize),
        page_number: String(pageNumber),
        startDate: bangkokDateStartIso(options.startDate),
        endDate: bangkokDateEndIso(options.endDate),
      },
      {
        headers: {
          "x-wise-timezone": "Asia/Bangkok",
          "x-wise-platform": "web",
        },
      },
    );

    const pageReceipts = (res.data?.transactions ?? [])
      .map(normalizeWiseReceipt)
      .filter((receipt): receipt is WiseReceiptTransaction => Boolean(receipt));
    receipts.push(...pageReceipts);

    const pageCount = res.data?.page_count ?? 1;
    if (pageNumber >= pageCount || (!res.data?.page_count && pageReceipts.length < pageSize)) break;
  }

  return receipts;
}
