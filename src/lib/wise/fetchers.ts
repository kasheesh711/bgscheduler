import { WiseClient } from "./client";
import {
  WiseTeacher,
  WiseAvailabilityResponse,
  WiseSession,
  WiseTeachersResponse,
  WiseAvailabilityEnvelope,
  WiseSessionsResponse,
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
  const all: WiseSession[] = [];
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const res = await client.get<WiseSessionsResponse>(
      `/institutes/${instituteId}/sessions`,
      {
        status: "FUTURE",
        paginateBy: "COUNT",
        page_number: String(page),
        page_size: String(PAGE_LIMIT),
      }
    );

    const sessions = res.data?.sessions ?? [];
    all.push(...sessions);
    pageCount = res.data?.page_count ?? page;
    if (sessions.length === 0) break;
    page++;
  }

  return all;
}
