import { WiseClient, WiseApiError } from "@/lib/wise/client";
import { fetchAllTeachers, fetchAllInstituteSessions } from "@/lib/wise/fetchers";
import type { WiseTeacher, WiseSession } from "@/lib/wise/types";
import { assertCompleteRoster } from "./removal-safety";

export interface RemovalWiseEvidence { roster: WiseTeacher[]; sessions: WiseSession[] }
export type RemovalRequestResult = { status: "sent" | "rejected" | "unknown"; errorMessage: string | null; responsePayload: Record<string, unknown> | null };
export function createRemovalWiseClient(signal = AbortSignal.timeout(15_000)): WiseClient {
  if (![process.env.WISE_USER_ID, process.env.WISE_API_KEY, process.env.WISE_INSTITUTE_ID].every(v => v?.trim())) throw new Error("Wise removal credentials are incomplete.");
  return new WiseClient({ userId: process.env.WISE_USER_ID!, apiKey: process.env.WISE_API_KEY!,
    namespace: process.env.WISE_NAMESPACE ?? "begifted-education", maxRetries: 0, maxConcurrency: 1, signal });
}
export async function readRemovalRoster(): Promise<WiseTeacher[]> {
  const roster = await fetchAllTeachers(createRemovalWiseClient(), process.env.WISE_INSTITUTE_ID!);
  assertCompleteRoster(roster); return roster;
}
export async function readRemovalWiseEvidence(): Promise<RemovalWiseEvidence> {
  const roster = await readRemovalRoster();
  const sessions = await fetchAllInstituteSessions(createRemovalWiseClient(AbortSignal.timeout(90_000)), process.env.WISE_INSTITUTE_ID!,
    { status: "FUTURE" }, { strict: true, deadlineAt: Date.now() + 90_000 });
  return { roster, sessions };
}
/** Only explicit apply calls this; zero retries and a bounded request. Raw bodies never enter the audit. */
export async function removeWiseParticipantOnce(userId: string): Promise<RemovalRequestResult> {
  if (!userId?.trim()) throw new Error("A Wise user ID is required.");
  try {
    const result = await createRemovalWiseClient().post<{ status?: unknown; message?: unknown }>(
      `/institutes/${process.env.WISE_INSTITUTE_ID!}/removeParticipant`, { userId });
    if (result?.status !== 200 || result?.message !== "Success") return { status: "unknown", errorMessage: "Wise did not confirm the request. Check the roster; do not retry.", responsePayload: null };
    return { status: "sent", errorMessage: null, responsePayload: { status: 200, message: "Success" } };
  } catch (error) {
    const rejected = error instanceof WiseApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
    return { status: rejected ? "rejected" : "unknown", errorMessage: rejected ? "Wise rejected the request." : "The request outcome is unknown. Check the roster; do not retry.", responsePayload: error instanceof WiseApiError ? { httpStatus: error.status } : null };
  }
}
