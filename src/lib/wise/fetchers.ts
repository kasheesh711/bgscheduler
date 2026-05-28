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
} from "./types";
import { addDays } from "date-fns";

const PAGE_LIMIT = 1000;

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
