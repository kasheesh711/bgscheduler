import { WiseClient } from "@/lib/wise/client";
import { AUTOWRITER_WISE_READ_TIMEOUT_MS } from "../config";

/**
 * The nightly audit's only way into Wise: the session-detail GET, by class and session or by session alone. No retry
 * (`maxRetries: 0`) and `stopOnRateLimit`, so the first 429 throws and every later call refuses; pacing, quiet
 * minutes, STOP and the read cap live in the evidence step's read gate. Nothing that can write is reachable from here.
 */
export interface NightlyWiseReader {
  getSessionDetail(classId: string, sessionId: string): Promise<unknown>;
  getSessionDetailById(sessionId: string): Promise<unknown>;
}

const OBJECT_ID = /^[0-9a-f]{24}$/iu;

function checkedId(value: string): string {
  if (!OBJECT_ID.test(value)) throw new Error("Wise path id is not an object id");
  return value;
}

/** Same query as the autowriter's own detail read (`createWiseFeedbackOps`). */
const DETAIL_PARAMS = {
  showLiveClassInsight: "true",
  showFeedbackConfig: "true",
  showFeedbackSubmission: "true",
  showSessionFiles: "true",
} as const;

export function createNightlyWiseReader(env: Record<string, string | undefined> = process.env): NightlyWiseReader {
  const userId = env.WISE_USER_ID?.trim();
  const apiKey = env.WISE_API_KEY?.trim();
  if (!userId || !apiKey) throw new Error("WISE_USER_ID and WISE_API_KEY are required");
  const client = new WiseClient({
    userId,
    apiKey,
    namespace: env.WISE_NAMESPACE?.trim() || "begifted-education",
    maxConcurrency: 1,
    maxRetries: 0,
    requestsPerSecond: 0,
    stopOnRateLimit: true,
  });
  const init = () => ({ cache: "no-store" as const, signal: AbortSignal.timeout(AUTOWRITER_WISE_READ_TIMEOUT_MS) });
  return Object.freeze({
    getSessionDetail: (classId: string, sessionId: string) =>
      client.get(`/user/classes/${checkedId(classId)}/sessions/${checkedId(sessionId)}`, { ...DETAIL_PARAMS }, init()),
    getSessionDetailById: (sessionId: string) =>
      client.get(`/user/session/${checkedId(sessionId)}`, { ...DETAIL_PARAMS }, init()),
  });
}
