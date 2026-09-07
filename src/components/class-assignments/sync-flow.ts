import type { AssignmentDetail } from "./types";

export const ASSIGNMENT_SYNC_POLL_INTERVAL_MS = 5_000;
export const ASSIGNMENT_SYNC_POLL_TIMEOUT_MS = 12 * 60 * 1000;

export interface WiseSyncResult {
  outcome?: "success" | "partial" | "failed" | "running";
  success?: boolean;
  skipped?: boolean;
  alreadyRunning?: boolean;
  promotedSnapshotId?: string | null;
  error?: string;
  errorSummary?: string | null;
  message?: string;
  runningStartedAt?: string;
}

interface SyncWiseBeforeAssignmentInput {
  date: string;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onMessage?: (message: string) => void;
}

export interface SyncWiseBeforeAssignmentResult {
  sync: WiseSyncResult;
  waitedForRunningSync: boolean;
  latestDetail: AssignmentDetail | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function responseError(body: WiseSyncResult, fallback: string): Error {
  for (const message of [body.errorSummary, body.error]) {
    if (typeof message === "string" && message.trim()) return new Error(message);
  }
  return new Error(fallback);
}

function syncError(syncBody: WiseSyncResult, response: Response): Error {
  return responseError(syncBody, `Wise sync failed with HTTP ${response.status}`);
}

function noPromotionError(syncBody: WiseSyncResult): Error {
  return responseError(syncBody, "Wise sync did not promote a fresh snapshot.");
}

function parseRequiredTimestamp(value: string | undefined): number {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) {
    throw new Error("Wise sync is already running but did not report when it started.");
  }
  return timestamp;
}

function isFreshSnapshotAfterRunningSync(detail: AssignmentDetail, runningStartedAtMs: number): boolean {
  const meta = detail.activeSnapshotMeta;
  const finishedAt = Date.parse(meta.latestSyncFinishedAt ?? "");
  return Boolean(meta.snapshotId) && meta.fresh && Number.isFinite(finishedAt) && finishedAt >= runningStartedAtMs;
}

export async function fetchAssignmentDetail(
  date: string,
  fetcher: typeof fetch = fetch,
): Promise<AssignmentDetail> {
  const response = await fetcher(`/api/class-assignments?date=${encodeURIComponent(date)}`);
  return readAssignmentDetailResponse(response);
}

export async function readAssignmentDetailResponse(response: Response): Promise<AssignmentDetail> {
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw responseError(body, `Unable to load classroom assignments (HTTP ${response.status}).`);
  }
  const meta = body.activeSnapshotMeta;
  if (!meta || typeof meta !== "object" || !("fresh" in meta) || typeof meta.fresh !== "boolean"
    || !("snapshotId" in meta) || (meta.snapshotId !== null && typeof meta.snapshotId !== "string")
    || !("latestSyncFinishedAt" in meta) || (meta.latestSyncFinishedAt !== null && typeof meta.latestSyncFinishedAt !== "string")
    || !Array.isArray(body.rows) || !Array.isArray(body.rooms) || !Array.isArray(body.liveRoomBlocks)
    || !Array.isArray(body.roomConflictWarnings) || !body.snapshotMeta
    || (body.run !== null && (!body.run || typeof body.run !== "object"))) {
    throw new Error("Unable to read the current Wise snapshot. Refresh the page and try again.");
  }
  return body as unknown as AssignmentDetail;
}

export async function waitForFreshAssignmentSnapshot(input: {
  date: string;
  runningStartedAtMs: number;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<AssignmentDetail> {
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const pollIntervalMs = input.pollIntervalMs ?? ASSIGNMENT_SYNC_POLL_INTERVAL_MS;
  const timeoutMs = input.timeoutMs ?? ASSIGNMENT_SYNC_POLL_TIMEOUT_MS;
  const deadline = now() + timeoutMs;

  while (true) {
    const detail = await fetchAssignmentDetail(input.date, fetcher);
    if (isFreshSnapshotAfterRunningSync(detail, input.runningStartedAtMs)) {
      return detail;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error("Wise sync is still running or did not promote a fresh snapshot within 12 minutes.");
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export async function syncWiseBeforeAssignment(
  input: SyncWiseBeforeAssignmentInput,
): Promise<SyncWiseBeforeAssignmentResult> {
  const fetcher = input.fetcher ?? fetch;
  const syncResponse = await fetcher("/api/admin/sync-wise", { method: "POST" });
  const syncBody = await parseJsonResponse(syncResponse) as WiseSyncResult;

  if (!syncResponse.ok) {
    throw syncError(syncBody, syncResponse);
  }

  if (syncBody.skipped && syncBody.alreadyRunning) {
    const runningStartedAtMs = parseRequiredTimestamp(syncBody.runningStartedAt);
    input.onMessage?.("Wise sync already running; waiting for fresh snapshot...");
    const latestDetail = await waitForFreshAssignmentSnapshot({
      date: input.date,
      runningStartedAtMs,
      fetcher,
      now: input.now,
      sleep: input.sleep,
      pollIntervalMs: input.pollIntervalMs,
      timeoutMs: input.timeoutMs,
    });
    return { sync: syncBody, waitedForRunningSync: true, latestDetail };
  }

  if (syncBody.outcome === "failed" || typeof syncBody.promotedSnapshotId !== "string" || !syncBody.promotedSnapshotId.trim()) {
    throw noPromotionError(syncBody);
  }

  return { sync: syncBody, waitedForRunningSync: false, latestDetail: null };
}
