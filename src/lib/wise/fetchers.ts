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
  WiseSessionDetail,
  WiseSessionDetailResponse,
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
 * Fetch recurring workingHours (single 7-day window) and all leaves across the
 * availability horizon, stitched from 7-day windows because Wise rejects any
 * wider span with HTTP 400 ("Difference between end date and start date should
 * not be more then a week", probed 2026-09-02).
 *
 * AVAIL-00: the horizon is operator-tunable via WISE_AVAILABILITY_HORIZON_DAYS.
 * Lowering it is the emergency valve when Wise throttles us — at 159 teachers the
 * default costs 26 calls each per run, and cutting to 28 days costs 4. It is a
 * blunt instrument: leaves beyond the horizon are simply not fetched, and the
 * search engine treats an absent leave row as "no leave". Prefer the tiered
 * fetchers below, which keep full coverage; reach for this only to stop bleeding.
 */
export const DEFAULT_AVAILABILITY_HORIZON_DAYS = 180;
export const AVAILABILITY_WINDOW_DAYS = 7;

export function resolveAvailabilityHorizonDays(): number {
  const raw = process.env.WISE_AVAILABILITY_HORIZON_DAYS;
  if (!raw) return DEFAULT_AVAILABILITY_HORIZON_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < AVAILABILITY_WINDOW_DAYS) {
    return DEFAULT_AVAILABILITY_HORIZON_DAYS;
  }
  return parsed;
}

/**
 * AVAIL-01 near/far leave tiering.
 *
 * Days 0..NEAR_HORIZON_DAYS are the "near" tier — fetched live every run, because
 * that is the window admins actually book into. Days NEAR_HORIZON_DAYS..horizon
 * are the "far" tier: 22 of the 26 Wise calls per teacher per run, yielding
 * almost nothing in practice (the whole active snapshot held 21 leave rows when
 * this was built, exactly one of them beyond day 28). The far tier is therefore
 * cached across runs — see `src/lib/wise/availability-cache.ts`.
 */
export const NEAR_HORIZON_DAYS = 28;

export const DEFAULT_FAR_HORIZON_MAX_AGE_MINUTES = 360;

/**
 * AVAIL-01: how long a cached far-leave row may be reused, tunable via
 * WISE_FAR_HORIZON_MAX_AGE_MINUTES. `0` disables the cache entirely (every run
 * fetches the far tier live) — the setting to reach for if far-horizon leaves
 * ever start mattering, or to prove the cache is what changed behaviour.
 */
export function resolveFarHorizonMaxAgeMinutes(): number {
  const raw = process.env.WISE_FAR_HORIZON_MAX_AGE_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_FAR_HORIZON_MAX_AGE_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FAR_HORIZON_MAX_AGE_MINUTES;
  return parsed;
}

/**
 * Day offsets of the 7-day windows tiling [startDay, endDay).
 *
 * The last window is never truncated — it always spans a full
 * AVAILABILITY_WINDOW_DAYS, so coverage runs slightly PAST endDay rather than
 * short of it. Erring long is the fail-closed direction: a short final window
 * would silently drop leaves the caller believes it fetched.
 */
function availabilityWindowStarts(startDay: number, endDay: number): number[] {
  const starts: number[] = [];
  for (let day = startDay; day < endDay; day += AVAILABILITY_WINDOW_DAYS) {
    starts.push(day);
  }
  return starts;
}

/**
 * Fetch the leave-only windows tiling [startDay, endDay).
 *
 * `Promise.all` is LOAD-BEARING (AVAIL-01) — do not soften it to `allSettled`.
 * If any window rejects the whole teacher fetch must reject, so the orchestrator
 * drops that teacher from the snapshot instead of persisting a partial leave
 * set. The search engine decides leave conflicts with `Array.some()`, so a
 * missing leave row reads as "no leave" and reports the tutor Available.
 */
async function fetchLeaveWindows(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  from: Date,
  startDay: number,
  endDay: number
): Promise<NonNullable<WiseAvailabilityResponse["leaves"]>> {
  const responses = await Promise.all(
    availabilityWindowStarts(startDay, endDay).map((day) =>
      fetchTeacherAvailability(
        client,
        instituteId,
        teacherUserId,
        addDays(from, day),
        addDays(from, day + AVAILABILITY_WINDOW_DAYS)
      )
    )
  );

  const leaves: NonNullable<WiseAvailabilityResponse["leaves"]> = [];
  for (const response of responses) {
    if (response.leaves) leaves.push(...response.leaves);
  }
  return leaves;
}

/**
 * Near tier: recurring workingHours plus every leave in days 0..nearDays.
 *
 * The first window is awaited BEFORE the rest are issued (as the single-tier
 * fetcher always did) so a hard failure — auth, 429 — costs one Wise call for
 * this teacher rather than a full fan-out.
 */
export async function fetchTeacherNearAvailability(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  nearDays: number = NEAR_HORIZON_DAYS,
  from: Date = new Date()
): Promise<{
  workingHours: WiseAvailabilityResponse["workingHours"];
  leaves: NonNullable<WiseAvailabilityResponse["leaves"]>;
}> {
  // Window 0 carries workingHours; every other window is leaves-only.
  const firstWindow = await fetchTeacherAvailability(
    client,
    instituteId,
    teacherUserId,
    from,
    addDays(from, AVAILABILITY_WINDOW_DAYS)
  );

  const leaves = [...(firstWindow.leaves ?? [])];
  leaves.push(
    ...(await fetchLeaveWindows(
      client,
      instituteId,
      teacherUserId,
      from,
      AVAILABILITY_WINDOW_DAYS,
      nearDays
    ))
  );

  return { workingHours: firstWindow.workingHours, leaves };
}

/**
 * Far tier: leaves in days nearDays..horizonDays. Returns no workingHours —
 * recurring hours come from the near tier's first window and never change with
 * the window offset.
 */
export async function fetchTeacherFarLeaves(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  nearDays: number = NEAR_HORIZON_DAYS,
  horizonDays: number = resolveAvailabilityHorizonDays(),
  from: Date = new Date()
): Promise<{ leaves: NonNullable<WiseAvailabilityResponse["leaves"]> }> {
  return {
    leaves: await fetchLeaveWindows(
      client,
      instituteId,
      teacherUserId,
      from,
      nearDays,
      horizonDays
    ),
  };
}

/**
 * Single-tier fetch of workingHours + the full leave horizon, composed from the
 * two tiers so all three functions share one window-tiling implementation.
 *
 * The near/far split point is clamped to the horizon, so the composed window set
 * is byte-identical to the pre-tiering loop for every horizon: at 180 days both
 * produce the 26 windows starting at day 0, 7, … 175. `from` is shared by both
 * tiers so the boundary tiles exactly — no gap, no lost overlap.
 */
export async function fetchTeacherFullAvailability(
  client: WiseClient,
  instituteId: string,
  teacherUserId: string,
  horizonDays: number = resolveAvailabilityHorizonDays()
): Promise<{
  workingHours: WiseAvailabilityResponse["workingHours"];
  leaves: WiseAvailabilityResponse["leaves"];
}> {
  const from = new Date();
  const nearDays = Math.min(NEAR_HORIZON_DAYS, horizonDays);

  const near = await fetchTeacherNearAvailability(
    client,
    instituteId,
    teacherUserId,
    nearDays,
    from
  );
  const far = await fetchTeacherFarLeaves(
    client,
    instituteId,
    teacherUserId,
    nearDays,
    horizonDays,
    from
  );

  return { workingHours: near.workingHours, leaves: [...near.leaves, ...far.leaves] };
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
 * Fetch Wise PAST sessions for an inclusive pair of Bangkok calendar dates.
 * Wise's date-window endpoint expects YYYY-MM-DD rather than UTC instants.
 */
export async function fetchWisePastSessionsByBangkokDate(
  client: WiseClient,
  instituteId: string,
  startDate: string,
  endDate: string,
  pageSize = 100,
): Promise<WiseSession[]> {
  const all: WiseSession[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const res = await client.get<WiseSessionsResponse>(
      `/institutes/${instituteId}/sessions`,
      {
        status: "PAST",
        paginateBy: "DATE",
        startDate,
        endDate,
        page_number: String(pageNumber),
        page_size: String(pageSize),
      },
    );
    const sessions = res.data?.sessions ?? [];
    all.push(...sessions);
    const pageCount = res.data?.page_count;
    if (typeof pageCount === "number" ? pageNumber >= pageCount : sessions.length < pageSize) {
      break;
    }
  }
  return all;
}

/**
 * Fetch the canonical Wise session representation used for post-class
 * feedback. This feature is strictly read-only toward Wise.
 */
export async function fetchWiseSessionDetail(
  client: WiseClient,
  classId: string,
  sessionId: string,
): Promise<WiseSessionDetail> {
  const res = await client.get<WiseSessionDetailResponse>(
    `/user/classes/${classId}/sessions/${sessionId}`,
    {
      showLiveClassInsight: "true",
      showFeedbackConfig: "true",
      showFeedbackSubmission: "true",
    },
  );
  if (!res.data || typeof res.data !== "object") {
    throw new Error(`Wise session detail response was missing data for session ${sessionId}`);
  }
  return res.data;
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

/**
 * Update the Wise subject field for one scheduled session.
 * Student Promotions only calls this behind the verified session-subject gate.
 */
export async function updateSessionSubject(
  client: WiseClient,
  classId: string,
  sessionId: string,
  subject: string
): Promise<WiseSessionUpdateResponse> {
  return client.put<WiseSessionUpdateResponse>(
    `/teacher/classes/${classId}/sessions/${sessionId}?updateType=SINGLE`,
    { subject }
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
