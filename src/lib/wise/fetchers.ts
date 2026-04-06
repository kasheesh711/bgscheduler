import { WiseClient } from "./client";
import {
  WiseTeacher,
  WiseAvailabilityResponse,
  WiseSession,
  WisePaginatedResponse,
} from "./types";
import { addDays, formatISO } from "date-fns";

const PAGE_LIMIT = 100;

/**
 * Fetch all teachers from a Wise institute, handling pagination.
 */
export async function fetchAllTeachers(
  client: WiseClient,
  instituteId: string
): Promise<WiseTeacher[]> {
  const all: WiseTeacher[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await client.get<WisePaginatedResponse<WiseTeacher>>(
      `/institutes/${instituteId}/teachers`,
      { page: String(page), limit: String(PAGE_LIMIT) }
    );

    all.push(...(res.data ?? []));
    hasMore = res.hasMore === true && (res.data?.length ?? 0) > 0;
    page++;
  }

  return all;
}

/**
 * Fetch availability for a single teacher for a single 7-day window.
 */
export async function fetchTeacherAvailability(
  client: WiseClient,
  instituteId: string,
  teacherId: string,
  startDate: Date,
  endDate: Date
): Promise<WiseAvailabilityResponse> {
  return client.get<WiseAvailabilityResponse>(
    `/institutes/${instituteId}/teachers/${teacherId}/availability`,
    {
      startDate: formatISO(startDate, { representation: "date" }),
      endDate: formatISO(endDate, { representation: "date" }),
    }
  );
}

/**
 * Fetch recurring workingHours (single 7-day window) and all leaves
 * across the 180-day horizon (26 seven-day windows).
 */
export async function fetchTeacherFullAvailability(
  client: WiseClient,
  instituteId: string,
  teacherId: string,
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
    teacherId,
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
      fetchTeacherAvailability(client, instituteId, teacherId, start, end)
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
  let hasMore = true;

  while (hasMore) {
    const res = await client.get<WisePaginatedResponse<WiseSession>>(
      `/institutes/${instituteId}/sessions`,
      { status: "FUTURE", page: String(page), limit: String(PAGE_LIMIT) }
    );

    all.push(...(res.data ?? []));
    hasMore = res.hasMore === true && (res.data?.length ?? 0) > 0;
    page++;
  }

  return all;
}
