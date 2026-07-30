import type { WiseClient } from "@/lib/wise/client";
import { createWiseClient } from "@/lib/wise/client";
import { getDb } from "@/lib/db";
import {
  fetchWisePastSessionsByBangkokDate,
  fetchWiseSessionDetail,
} from "@/lib/wise/fetchers";
import type { WiseSession, WiseSessionDetail } from "@/lib/wise/types";
import { getWiseSessionClassId } from "@/lib/wise/types";
import {
  calculateFeedbackDeadline,
  deriveEventTimingEvidence,
  evaluateSessionCompliance,
  evaluateSessionEligibility,
} from "./policy";
import type {
  CanonicalTutorResolution,
  FeedbackVersion,
  ParsedPostClassSession,
  PostClassSessionCandidate,
} from "./types";
import type {
  PostClassFeedbackRepository,
  PostClassSourceIssueInput,
  PostClassSyncTrigger,
} from "./repository";
import {
  createDrizzlePostClassFeedbackRepository,
  PostClassPolicySnapshotConflictError,
  resolvePostClassCanonicalTutor,
  resolvePostClassPayoutEligibility,
} from "./repository";
import {
  mapAnswersToFields,
  parseWisePostClassSession,
  PostClassSessionDataError,
  PostClassWiseSchemaError,
} from "./wise";

const DEFAULT_DETAIL_CAP = 50;
/**
 * Manual backfills may request a larger batch than the cron. The rolling cron
 * stays at 50 so a routine run can never monopolise the Wise API; a deliberate
 * admin-triggered backfill has ~11k historical sessions to drain and would
 * otherwise need hundreds of runs.
 */
const BACKFILL_DETAIL_CAP = 400;
const DETAIL_CONCURRENCY = 4;
const ROLLING_WINDOW_DAYS = 4;
/**
 * CONTRACT-01 — how many session-detail payloads must breach the expected shape
 * before the run treats it as a Wise contract change rather than a handful of
 * malformed sessions. A real break fails most of the batch; a bad session fails
 * only itself, over and over, because it never leaves the recheck queue.
 */
const MIN_WIDESPREAD_CONTRACT_BREACHES = 3;

export interface SyncPostClassFeedbackDependencies {
  repository: PostClassFeedbackRepository;
  client: WiseClient;
  instituteId: string;
  resolveTutor(input: {
    candidate: PostClassSessionCandidate;
    session: ParsedPostClassSession;
    detail: WiseSessionDetail;
  }): Promise<CanonicalTutorResolution>;
  resolvePayoutEligibility?(input: {
    candidate: PostClassSessionCandidate;
    session: ParsedPostClassSession;
  }): Promise<boolean | null>;
}

export interface SyncPostClassFeedbackOptions {
  triggerType?: PostClassSyncTrigger;
  actorEmail?: string | null;
  now?: Date;
  detailCap?: number;
  /** Optional inclusive Bangkok calendar-date range for manual recovery/backfill. */
  startDate?: string;
  endDate?: string;
  /** Targeted canonical refresh immediately before one reminder checkpoint. */
  reminderCheckpoint?: "day_after" | "deadline";
  /** Defaults to the reminder service's 20-minute freshness requirement. */
  checkpointFreshnessMinutes?: number;
}

export interface PostClassReminderCheckpointBacklog {
  kind: "day_after" | "deadline";
  classDate: string;
  freshAfter: string;
  pendingCount: number;
  selectedCount: number;
  remainingCount: number;
  hasMore: boolean;
}

export interface SyncPostClassFeedbackResult {
  runId: string;
  status: "success" | "partial";
  windowStart: string;
  windowEnd: string;
  discoveredCount: number;
  candidateCount: number;
  /**
   * Candidates still outstanding from the run's own date window, after the
   * already-reconciled ones are filtered out. `candidateCount` counts all three
   * lanes, so a saturated recheck queue pins it at the cap and says nothing
   * about whether the window is finished; this does. Zero means the window is
   * fully observed.
   */
  windowCandidateCount: number;
  detailFetchedCount: number;
  sessionSavedCount: number;
  sourceIssueCount: number;
  checkpoint: PostClassReminderCheckpointBacklog | null;
}

function bangkokDateParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function isoCalendarDate(year: number, month: number, day: number): string {
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return [
    normalized.getUTCFullYear(),
    String(normalized.getUTCMonth() + 1).padStart(2, "0"),
    String(normalized.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function fourDayBangkokWindow(now: Date): { startDate: string; endDate: string } {
  const { year, month, day } = bangkokDateParts(now);
  return {
    startDate: isoCalendarDate(year, month, day - (ROLLING_WINDOW_DAYS - 1)),
    endDate: isoCalendarDate(year, month, day),
  };
}

export function reminderCheckpointBangkokDate(
  now: Date,
  kind: "day_after" | "deadline",
): string {
  const { year, month, day } = bangkokDateParts(now);
  return isoCalendarDate(year, month, day - (kind === "day_after" ? 1 : 2));
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isoCalendarDate(year, month, day) === value;
}

export function resolvePostClassSyncWindow(
  now: Date,
  options: Pick<SyncPostClassFeedbackOptions, "startDate" | "endDate">,
): { startDate: string; endDate: string } {
  const defaults = fourDayBangkokWindow(now);
  if (!options.startDate && !options.endDate) return defaults;
  if (!options.startDate || !options.endDate) {
    throw new Error("Manual feedback backfill requires both startDate and endDate.");
  }
  if (!validCalendarDate(options.startDate) || !validCalendarDate(options.endDate)) {
    throw new Error("Feedback backfill dates must use valid YYYY-MM-DD calendar dates.");
  }
  if (options.startDate > options.endDate) {
    throw new Error("Feedback backfill startDate must not be after endDate.");
  }
  return { startDate: options.startDate, endDate: options.endDate };
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rollingCandidates(sessions: WiseSession[]): PostClassSessionCandidate[] {
  return sessions.flatMap((session) => {
    if (session.meetingStatus?.trim().toUpperCase() !== "ENDED") return [];
    const classId = getWiseSessionClassId(session);
    if (!classId) return [];
    return [{
      sessionId: session._id,
      classId,
      reason: "rolling_window" as const,
      scheduledStartAt: asDate(session.scheduledStartTime),
      scheduledEndAt: asDate(session.scheduledEndTime),
      rawSession: session as Record<string, unknown>,
    }];
  });
}

const PRIORITY: Record<PostClassSessionCandidate["reason"], number> = {
  feedback_event: 0,
  incomplete_recheck: 1,
  rolling_window: 2,
};

export function buildPostClassSyncCandidates(input: {
  eventCandidates: PostClassSessionCandidate[];
  incompleteCandidates: PostClassSessionCandidate[];
  rollingCandidates: PostClassSessionCandidate[];
  cap?: number;
  /** Raises the ceiling to BACKFILL_DETAIL_CAP for admin-triggered backfills. */
  backfill?: boolean;
}): PostClassSessionCandidate[] {
  const ceiling = input.backfill ? BACKFILL_DETAIL_CAP : DEFAULT_DETAIL_CAP;
  const cap = Math.max(0, Math.min(input.cap ?? DEFAULT_DETAIL_CAP, ceiling));
  return selectPostClassSyncCandidates(buildPostClassSyncCandidatePool(input), cap);
}

function buildPostClassSyncCandidatePool(input: {
  eventCandidates: PostClassSessionCandidate[];
  incompleteCandidates: PostClassSessionCandidate[];
  rollingCandidates: PostClassSessionCandidate[];
}): PostClassSessionCandidate[] {
  const bySession = new Map<string, PostClassSessionCandidate>();
  for (const candidate of [
    ...input.eventCandidates,
    ...input.incompleteCandidates,
    ...input.rollingCandidates,
  ]) {
    const existing = bySession.get(candidate.sessionId);
    const candidateWins = !existing || PRIORITY[candidate.reason] < PRIORITY[existing.reason];
    const preferred = candidateWins ? candidate : existing;
    const secondary = candidateWins ? existing : candidate;
    bySession.set(candidate.sessionId, {
      ...secondary,
      ...preferred,
      rawSession: preferred.rawSession ?? secondary?.rawSession ?? null,
      scheduledStartAt: preferred.scheduledStartAt ?? secondary?.scheduledStartAt ?? null,
      scheduledEndAt: preferred.scheduledEndAt ?? secondary?.scheduledEndAt ?? null,
      recheckPriorityAt: preferred.recheckPriorityAt ?? secondary?.recheckPriorityAt ?? null,
      forceDetailRefresh: Boolean(
        preferred.forceDetailRefresh || secondary?.forceDetailRefresh,
      ),
    });
  }
  return [...bySession.values()].sort((left, right) => {
    const priority = PRIORITY[left.reason] - PRIORITY[right.reason];
    if (priority !== 0) return priority;
    const leftTime = left.scheduledEndAt?.getTime() ?? 0;
    const rightTime = right.scheduledEndAt?.getTime() ?? 0;
    return left.reason === "incomplete_recheck"
      ? (left.recheckPriorityAt?.getTime() ?? leftTime) -
        (right.recheckPriorityAt?.getTime() ?? rightTime)
      : rightTime - leftTime;
  });
}

function selectPostClassSyncCandidates(
  sorted: PostClassSessionCandidate[],
  cap: number,
): PostClassSessionCandidate[] {
  if (sorted.length <= cap) return sorted;

  // Activity events accelerate canonical reconciliation; they must never
  // replace it. Keep bounded lanes for both old incomplete obligations and
  // newly ENDED rolling-window sessions so a permanently failing event burst
  // cannot consume every run. With the production cap of 50 this reserves up
  // to ten calls for each lane while retaining at least thirty priority slots.
  const reservePerLane = Math.min(10, Math.floor(cap / 3));
  const rechecks = sorted.filter((candidate) => candidate.reason === "incomplete_recheck");
  const rolling = sorted.filter((candidate) => candidate.reason === "rolling_window");
  const reservedRechecks = rechecks.slice(0, Math.min(reservePerLane, rechecks.length));
  const reservedRolling = rolling.slice(0, Math.min(reservePerLane, rolling.length));
  const reserved = new Set([
    ...reservedRechecks.map((candidate) => candidate.sessionId),
    ...reservedRolling.map((candidate) => candidate.sessionId),
  ]);
  const selected = new Set<string>();
  for (const candidate of sorted) {
    // Rechecks have their own bounded lane; outside it, leave capacity for
    // event acceleration and canonical rolling discovery. The final fill pass
    // still uses rechecks whenever those sources do not consume the budget.
    if (candidate.reason === "incomplete_recheck") continue;
    if (reserved.has(candidate.sessionId)) continue;
    if (selected.size >= cap - reserved.size) break;
    selected.add(candidate.sessionId);
  }
  for (const sessionId of reserved) selected.add(sessionId);
  for (const candidate of sorted) {
    if (selected.size >= cap) break;
    selected.add(candidate.sessionId);
  }
  return sorted.filter((candidate) => selected.has(candidate.sessionId));
}

function feedbackVersionIdentity(version: FeedbackVersion): string {
  return version.submissionId
    ? `${version.submissionId}:${version.contentHash}`
    : version.contentHash;
}

export function mergeFeedbackVersionHistory(
  historical: FeedbackVersion[],
  observed: FeedbackVersion[],
): FeedbackVersion[] {
  const historicalBySubmission = new Map<string, FeedbackVersion[]>();
  for (const version of historical) {
    if (!version.submissionId) continue;
    const versions = historicalBySubmission.get(version.submissionId) ?? [];
    versions.push(version);
    historicalBySubmission.set(version.submissionId, versions);
  }
  const merged = new Map<string, FeedbackVersion>();
  const safeObserved = observed.map((version): FeedbackVersion => {
    if (!version.submissionId || version.sourceTimestampKind !== "created") return version;
    const priorVersions = historicalBySubmission.get(version.submissionId) ?? [];
    const mutableEdit = priorVersions.some((prior) => prior.contentHash !== version.contentHash);
    return mutableEdit
      ? { ...version, sourceTimestampTrustworthy: false }
      : version;
  });
  for (const version of [...historical, ...safeObserved]) {
    merged.set(feedbackVersionIdentity(version), version);
  }
  return [...merged.values()];
}

export function selectCurrentFeedbackProjection(
  observed: FeedbackVersion[],
  history: FeedbackVersion[],
): FeedbackVersion[] {
  const currentVersionKeys = new Set(observed.map(feedbackVersionIdentity));
  return history.filter((version) => currentVersionKeys.has(feedbackVersionIdentity(version)));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }
  const workers = await Promise.allSettled(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  const rejected = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return results;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return chain;
}

function isNetworkFailure(error: unknown): boolean {
  const networkCodes = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  return errorChain(error).some((entry) => {
    const candidate = entry as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && networkCodes.has(candidate.code.toUpperCase())) {
      return true;
    }
    const name = typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
    const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
    return name === "aborterror" ||
      message.includes("fetch failed") ||
      message.includes("network error") ||
      message.includes("network request failed") ||
      message.includes("socket hang up") ||
      message.includes("dns");
  });
}

function retryCandidateDetails(candidate: PostClassSessionCandidate): Record<string, unknown> {
  return {
    retryCandidate: {
      sessionId: candidate.sessionId,
      classId: candidate.classId,
      scheduledStartAt: candidate.scheduledStartAt?.toISOString() ?? null,
      scheduledEndAt: candidate.scheduledEndAt?.toISOString() ?? null,
    },
  };
}

function safeWiseIssue(
  error: unknown,
  candidate: PostClassSessionCandidate,
  runId: string,
  now: Date,
): PostClassSourceIssueInput {
  const sessionId = candidate.sessionId;
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/Wise API\s+(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  let issueType: PostClassSourceIssueInput["issueType"] = "contract_error";
  // CONTRACT-01: this function classifies a failure that happened while
  // fetching or parsing ONE session's detail, so the default scope is that
  // session. Every failure that is genuinely about the whole run — a network
  // outage, rejected credentials, rate limiting, a timeout, a 5xx, a config
  // change under the run — sets `global` explicitly below.
  //
  // The default used to be `global`, and it was the direct cause of the June
  // 2026 reconciliation collapse: ten unclassified per-session Wise 400s each
  // fell through to here and demoted every eligible row in the table. A run
  // where this genuinely reflects a Wise contract change still suspends
  // enforcement run-wide, via the prevalence check in the fetch pass.
  let scope: PostClassSourceIssueInput["scope"] = "session";
  let safeMessage = `Could not reconcile Wise session ${sessionId}.`;
  if (error instanceof PostClassSessionDataError) {
    scope = "session";
    safeMessage = `Wise session ${sessionId} has incomplete scheduling data.`;
  } else if (error instanceof PostClassPolicySnapshotConflictError) {
    issueType = "configuration_changed";
    scope = "global";
    safeMessage = "Post-class feedback configuration changed during collection; the run was discarded.";
  } else if (isNetworkFailure(error)) {
    // Reaching Wise at all failed, so nothing this run observed can be
    // trusted — genuinely global, and stated explicitly now that the default
    // is per-session.
    issueType = "wise_transient";
    scope = "global";
    safeMessage = "The Wise feedback collector could not reach the Wise API.";
  } else if (error instanceof PostClassWiseSchemaError ||
    /session detail response was missing data/iu.test(message)) {
    // CONTRACT-01: one payload that does not match the expected shape is a
    // per-session condition, for the same reason session_not_found is below —
    // a single malformed session must not mark every other session's source
    // unavailable. A genuine contract change fails most of the batch, and the
    // run escalates to a global issue on that prevalence instead.
    issueType = "contract_error";
    scope = "session";
    safeMessage = "The Wise session-detail response no longer matches the expected contract.";
  } else if (status === 401 || status === 403) {
    issueType = "wise_auth";
    scope = "global";
    safeMessage = `Wise credentials were rejected (${status}).`;
  } else if (status === 404 || (status === 400 && /session not found/iu.test(message))) {
    // Wise answers a deleted session with 400 "Session not found!", not 404.
    // Treating that as a global contract breach would let one removed session
    // mark every other session's source unavailable and suspend the whole
    // feature. It is a per-session condition and stays session-scoped.
    issueType = "session_not_found";
    scope = "session";
    safeMessage = `Wise session ${sessionId} was not found.`;
  } else if (status === 408) {
    issueType = "wise_transient";
    scope = "global";
    safeMessage = "Wise timed out while serving session-detail data (408).";
  } else if (status === 429) {
    issueType = "wise_rate_limit";
    scope = "global";
    safeMessage = "Wise rate-limited the feedback collector.";
  } else if (status && status >= 500) {
    issueType = "wise_transient";
    scope = "global";
    safeMessage = `Wise returned a transient ${status} response.`;
  } else if (status === 422) {
    scope = "global";
    safeMessage = "Wise rejected the session-detail contract (422).";
  }
  return {
    runId,
    sessionId,
    scope,
    issueType,
    severity: "error",
    blocksEnforcement: true,
    fingerprint: `${issueType}:${scope === "global" ? "global" : sessionId}:${status ?? "parse"}`,
    message: safeMessage,
    observedAt: now,
    details: {
      ...(status ? { httpStatus: status } : {}),
      ...(error instanceof PostClassPolicySnapshotConflictError
        ? { expected: error.expected, current: error.current }
        : {}),
      ...retryCandidateDetails(candidate),
    },
  };
}

function durableSessionRetryIssue(
  issue: PostClassSourceIssueInput,
  candidate: PostClassSessionCandidate,
): PostClassSourceIssueInput | null {
  if (issue.scope !== "global") return null;
  return {
    ...issue,
    sessionId: candidate.sessionId,
    scope: "session",
    severity: "warning",
    fingerprint: `detail_retry:${candidate.sessionId}`,
    message: `Wise session ${candidate.sessionId} remains queued for source reconciliation.`,
    details: {
      ...(issue.details ?? {}),
      sourceIssueType: issue.issueType,
      ...retryCandidateDetails(candidate),
    },
  };
}

function genericSyncFailure(error: unknown): string {
  if (error instanceof PostClassPolicySnapshotConflictError) {
    return "Post-class feedback configuration changed during collection.";
  }
  const text = error instanceof Error ? error.message : String(error);
  const status = text.match(/Wise API\s+(\d{3})/i)?.[1];
  return status ? `Wise collection failed with HTTP ${status}.` : "Post-class feedback collection failed.";
}

function safeWiseRunIssue(
  error: unknown,
  runId: string,
  observedAt: Date,
): PostClassSourceIssueInput {
  const classified = safeWiseIssue(error, {
    sessionId: "collector",
    classId: "collector",
    reason: "incomplete_recheck",
  }, runId, observedAt);
  const httpStatus = classified.details?.httpStatus;
  return {
    ...classified,
    sessionId: null,
    scope: "global",
    fingerprint: `${classified.issueType}:global:${httpStatus ?? "collector"}`,
    message: classified.scope === "global"
      ? classified.message
      : "The Wise post-class feedback collector could not reconcile its source window.",
  };
}

export async function syncPostClassFeedback(
  dependencies: SyncPostClassFeedbackDependencies,
  options: SyncPostClassFeedbackOptions = {},
): Promise<SyncPostClassFeedbackResult> {
  const now = options.now ?? new Date();
  const triggerType = options.triggerType ?? "cron";
  // Only an explicit manual date-range backfill may exceed the rolling cap.
  const isBackfill = triggerType === "manual" &&
    Boolean(options.startDate && options.endDate) &&
    !options.reminderCheckpoint;
  const detailCeiling = isBackfill ? BACKFILL_DETAIL_CAP : DEFAULT_DETAIL_CAP;
  const detailCap = Math.max(1, Math.min(options.detailCap ?? DEFAULT_DETAIL_CAP, detailCeiling));
  if (options.reminderCheckpoint && (options.startDate || options.endDate)) {
    throw new Error("Reminder-checkpoint sync cannot be combined with a manual backfill window.");
  }
  const checkpointClassDate = options.reminderCheckpoint
    ? reminderCheckpointBangkokDate(now, options.reminderCheckpoint)
    : null;
  const { startDate, endDate } = checkpointClassDate
    ? { startDate: checkpointClassDate, endDate: checkpointClassDate }
    : resolvePostClassSyncWindow(now, options);
  const runId = await dependencies.repository.beginSync({
    triggerType,
    actorEmail: options.actorEmail?.trim().toLowerCase() ?? null,
    startedAt: now,
    windowStart: startDate,
    windowEnd: endDate,
    detailCap,
  });
  let sourceIssueCount = 0;

  try {
    const [
      policy,
      eventCoverageFrom,
      recentSessions,
      eventCandidates,
      incompleteCandidates,
      persistedCheckpointCandidates,
    ] = await Promise.all([
      dependencies.repository.loadPolicyContext(),
      // Read once per run: sessions whose deadline predates the oldest
      // collected feedback event cannot be judged late from event absence.
      dependencies.repository.loadFeedbackEventCoverageFloor(),
      fetchWisePastSessionsByBangkokDate(
        dependencies.client,
        dependencies.instituteId,
        startDate,
        endDate,
      ),
      dependencies.repository.listFeedbackEventCandidates(detailCap),
      options.reminderCheckpoint
        ? Promise.resolve([])
        : dependencies.repository.listIncompleteRecheckCandidates(detailCap),
      options.reminderCheckpoint && checkpointClassDate
        ? dependencies.repository.listReminderCheckpointPersistedCandidates(checkpointClassDate)
        : Promise.resolve([]),
    ]);
    const discovered = rollingCandidates(recentSessions);
    const discoveredIds = new Set(discovered.map((candidate) => candidate.sessionId));
    const checkpointPersisted = persistedCheckpointCandidates.map((candidate) =>
      discoveredIds.has(candidate.sessionId)
        ? candidate
        : { ...candidate, forceDetailRefresh: true });
    let candidatePool = buildPostClassSyncCandidatePool({
      eventCandidates: options.reminderCheckpoint
        ? eventCandidates.filter((event) => discoveredIds.has(event.sessionId))
        : eventCandidates,
      incompleteCandidates,
      rollingCandidates: [...checkpointPersisted, ...discovered],
    });
    let checkpointPendingCount = 0;
    const checkpointFreshnessMinutes = Math.max(
      1,
      Math.min(options.checkpointFreshnessMinutes ?? 20, 24 * 60),
    );
    const checkpointFreshAfter = new Date(now.getTime() - checkpointFreshnessMinutes * 60_000);
    if (options.reminderCheckpoint && dependencies.repository.filterReminderCheckpointCandidates) {
      const planned = await dependencies.repository.filterReminderCheckpointCandidates(
        candidatePool,
        checkpointFreshAfter,
        now,
      );
      candidatePool = planned.candidates;
      checkpointPendingCount = planned.totalPending;
    } else if (options.reminderCheckpoint) {
      checkpointPendingCount = candidatePool.length;
    } else if (dependencies.repository.filterCandidatesForFetch) {
      // Filter the full candidate pool before the hard cap. Otherwise already
      // reconciled recent sessions can occupy all 50 slots and permanently
      // starve older missing-feedback sessions from the rolling window.
      candidatePool = await dependencies.repository.filterCandidatesForFetch(
        candidatePool,
        candidatePool.length,
        now,
      );
    }
    const candidates = selectPostClassSyncCandidates(candidatePool, detailCap);
    // Measured on the filtered pool rather than on what this batch selected:
    // the question a backfill needs answered is "is any work left in this
    // window", not "did this batch happen to pick some of it up".
    const windowCandidateCount = candidatePool.filter(
      (candidate) => candidate.reason === "rolling_window",
    ).length;

    let detailFetchedCount = 0;
    let sessionSavedCount = 0;
    let versionInsertedCount = 0;
    let assessedCount = 0;
    let blockingGlobalSourceIssue = false;
    let contractBreachCount = 0;

    // Fetch and parse the whole bounded batch before any financial candidate
    // can be created. This makes form-drift a true run-wide circuit breaker,
    // even when detail requests complete out of order.
    const fetched = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async (candidate) => {
      let detail: WiseSessionDetail;
      try {
        detail = await fetchWiseSessionDetail(
          dependencies.client,
          candidate.classId,
          candidate.sessionId,
        );
      } catch (error) {
        sourceIssueCount += 1;
        const issue = safeWiseIssue(error, candidate, runId, now);
        if (issue.scope === "global" && issue.blocksEnforcement) blockingGlobalSourceIssue = true;
        if (issue.issueType === "contract_error") contractBreachCount += 1;
        await dependencies.repository.recordSourceIssue(issue);
        const retryIssue = durableSessionRetryIssue(issue, candidate);
        if (retryIssue) {
          sourceIssueCount += 1;
          await dependencies.repository.recordSourceIssue(retryIssue);
        }
        return null;
      }
      detailFetchedCount += 1;
      const events = await dependencies.repository.loadFeedbackEvents(candidate.sessionId);
      let parsed: ParsedPostClassSession;
      try {
        parsed = parseWisePostClassSession({
          candidateSession: candidate.rawSession as WiseSession | null,
          detail,
          classId: candidate.classId,
          sessionId: candidate.sessionId,
          observedAt: now,
          mappings: policy.mappings,
          events,
        });
      } catch (error) {
        sourceIssueCount += 1;
        const issue = safeWiseIssue(error, candidate, runId, now);
        if (issue.scope === "global" && issue.blocksEnforcement) blockingGlobalSourceIssue = true;
        if (issue.issueType === "contract_error") contractBreachCount += 1;
        await dependencies.repository.recordSourceIssue(issue);
        const retryIssue = durableSessionRetryIssue(issue, candidate);
        if (retryIssue) {
          sourceIssueCount += 1;
          await dependencies.repository.recordSourceIssue(retryIssue);
        }
        return null;
      }
      return { candidate, detail, events, parsed };
    });

    // CONTRACT-01: escalate on prevalence, not on the first occurrence. Wise
    // changing its session-detail contract fails most of what the run touched,
    // and that must still suspend enforcement run-wide; a few sessions with
    // malformed payloads must not, or they would re-suspend the feature every
    // 30 minutes forever, since a session that cannot be parsed never leaves
    // the recheck queue.
    if (contractBreachCount >= MIN_WIDESPREAD_CONTRACT_BREACHES
      && contractBreachCount * 2 >= candidates.length) {
      sourceIssueCount += 1;
      blockingGlobalSourceIssue = true;
      await dependencies.repository.recordSourceIssue({
        runId,
        scope: "global",
        issueType: "contract_error",
        severity: "error",
        blocksEnforcement: true,
        fingerprint: "contract_error:global:widespread",
        message: "Most Wise session-detail responses in this run no longer match the expected contract.",
        observedAt: now,
        details: { contractBreachCount, candidateCount: candidates.length },
      });
    }

    const parsedCandidates = fetched.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    const firstFormDrift = parsedCandidates.find(
      ({ parsed }) => parsed.mapping.status === "form_drift",
    );
    if (firstFormDrift) {
      sourceIssueCount += 1;
      await dependencies.repository.recordSourceIssue({
        runId,
        sessionId: firstFormDrift.candidate.sessionId,
        scope: "global",
        issueType: "form_drift",
        severity: "error",
        blocksEnforcement: true,
        fingerprint: `form_drift:${policy.mappingVersion}`,
        message: firstFormDrift.parsed.mapping.reason ??
          "Required Wise feedback fields could not be mapped safely.",
        observedAt: now,
        details: {
          missingRequiredFields: firstFormDrift.parsed.mapping.missingRequiredFields,
          ambiguousFields: firstFormDrift.parsed.mapping.ambiguousFields,
        },
      });
      await dependencies.repository.pauseForFormDrift({
        runId,
        observedAt: now,
        reason: firstFormDrift.parsed.mapping.reason ?? "Required Wise feedback mapping drifted.",
      });
    }

    await mapWithConcurrency(parsedCandidates, DETAIL_CONCURRENCY, async ({
      candidate,
      detail,
      events,
      parsed,
    }) => {
      const [historicalVersions, previousOnTimeLock] = await Promise.all([
        dependencies.repository.loadHistoricalFeedbackVersions(candidate.sessionId),
        dependencies.repository.loadPreviousComplianceLock(
          candidate.sessionId,
          policy.policyVersion,
          policy.mappingVersion,
          parsed.scheduledEndAt,
        ),
      ]);
      const feedbackVersionHistory = mergeFeedbackVersionHistory(
        // Re-project immutable raw answers through the currently configured
        // form mapping. This lets an access manager repair a mapping and
        // reassess old evidence without mutating the preserved Wise source.
        historicalVersions.map((version) => ({
          ...version,
          fields: mapAnswersToFields(version.answers, parsed.mapping),
        })),
        parsed.feedbackVersions,
      );
      const sessionWithCurrentProjection: ParsedPostClassSession = {
        ...parsed,
        // Historical versions remain immutable audit evidence, but absence
        // from the canonical current detail is a real deletion. Only current
        // versions govern content; scoped locks preserve prior proven states.
        feedbackVersions: selectCurrentFeedbackProjection(
          parsed.feedbackVersions,
          feedbackVersionHistory,
        ),
      };
      const tutor = await dependencies.resolveTutor({
        candidate,
        session: sessionWithCurrentProjection,
        detail,
      });
      const payoutEligible = dependencies.resolvePayoutEligibility
        ? await dependencies.resolvePayoutEligibility({
          candidate,
          session: sessionWithCurrentProjection,
        })
        : null;
      const eligibility = evaluateSessionEligibility({
        meetingStatus: sessionWithCurrentProjection.meetingStatus,
        classType: sessionWithCurrentProjection.classType,
        sessionType: sessionWithCurrentProjection.sessionType,
        attendanceStatus: sessionWithCurrentProjection.attendanceStatus,
        submissionSessionStatuses: sessionWithCurrentProjection.submissionSessionStatuses,
        complimentaryOrTrial: sessionWithCurrentProjection.complimentaryOrTrial,
        creditsConsumed: sessionWithCurrentProjection.creditsConsumed,
        payoutEligible,
      });
      const enforcement = await dependencies.repository.loadSessionEnforcementContext(
        sessionWithCurrentProjection.scheduledEndAt,
      );
      let sourceStatus: "ready" | "form_drift" | "identity_review" | "unavailable" = "ready";
      if (firstFormDrift || parsed.mapping.status === "form_drift") sourceStatus = "form_drift";
      else if (blockingGlobalSourceIssue) sourceStatus = "unavailable";
      else if (tutor.status === "ambiguous") sourceStatus = "identity_review";
      else if (eligibility.status === "ambiguous") sourceStatus = "unavailable";

      const eventTiming = deriveEventTimingEvidence({
        events,
        deadlineAt: calculateFeedbackDeadline(sessionWithCurrentProjection.scheduledEndAt),
        eventCoverageFrom,
      });
      const assessment = eligibility.eligible
        ? evaluateSessionCompliance({
          sourceStatus,
          scheduledEndAt: sessionWithCurrentProjection.scheduledEndAt,
          now,
          versions: sessionWithCurrentProjection.feedbackVersions,
          enforcementMode: enforcement.enforcementMode,
          policyEffectiveAt: enforcement.policyEffectiveAt,
          policyVersion: policy.policyVersion,
          mappingVersion: policy.mappingVersion,
          previousOnTimeLock,
          eventTiming,
        })
        : null;
      const saved = await dependencies.repository.saveObservation(runId, {
        settingsVersion: policy.settingsVersion,
        policyVersion: policy.policyVersion,
        mappingVersion: policy.mappingVersion,
        candidate,
        session: sessionWithCurrentProjection,
        feedbackVersionHistory,
        tutor,
        eligibility,
        sourceStatus,
        assessment,
        enforcementMode: enforcement.enforcementMode,
        events,
        observedAt: now,
      });
      versionInsertedCount += saved.versionsInserted;
      assessedCount += saved.assessmentInserted ? 1 : 0;
      sessionSavedCount += 1;
      if (sourceStatus === "identity_review") {
        sourceIssueCount += 1;
        await dependencies.repository.recordSourceIssue({
          runId,
          sessionId: candidate.sessionId,
          scope: "session",
          issueType: "identity_ambiguous",
          severity: "warning",
          blocksEnforcement: true,
          fingerprint: `identity_ambiguous:${candidate.sessionId}`,
          message: `Tutor identity for Wise session ${candidate.sessionId} needs review.`,
          observedAt: now,
        });
      } else if (sourceStatus === "unavailable" && eligibility.status === "ambiguous") {
        sourceIssueCount += 1;
        await dependencies.repository.recordSourceIssue({
          runId,
          sessionId: candidate.sessionId,
          scope: "session",
          issueType: "billing_evidence_missing",
          severity: "warning",
          blocksEnforcement: true,
          fingerprint: `billing_evidence_missing:${candidate.sessionId}`,
          message: `Billing evidence for Wise session ${candidate.sessionId} is incomplete.`,
          observedAt: now,
        });
      }
    });

    const status = sourceIssueCount > 0 ? "partial" : "success";
    await dependencies.repository.completeSync({
      runId,
      finishedAt: new Date(),
      status,
      discoveredCount: discovered.length,
      candidateCount: candidates.length,
      detailFetchedCount,
      sessionSavedCount,
      versionInsertedCount,
      assessedCount,
      sourceIssueCount,
      metadata: {
        policyVersion: policy.policyVersion,
        mappingVersion: policy.mappingVersion,
        settingsVersion: policy.settingsVersion,
        detailConcurrency: DETAIL_CONCURRENCY,
        ...(options.reminderCheckpoint && checkpointClassDate
          ? {
            reminderCheckpoint: options.reminderCheckpoint,
            checkpointClassDate,
            checkpointFreshAfter: checkpointFreshAfter.toISOString(),
            checkpointPendingCount,
            checkpointRemainingCount: Math.max(0, checkpointPendingCount - candidates.length),
          }
          : {}),
        // Global source health is independent from session-scoped identity,
        // billing, or not-found issues that can keep the run "partial".
        globalSourceHealthy: !blockingGlobalSourceIssue && !firstFormDrift,
        mappingObservedHealthy: parsedCandidates.length > 0 && !firstFormDrift,
      },
    });
    return {
      runId,
      status,
      windowStart: startDate,
      windowEnd: endDate,
      discoveredCount: discovered.length,
      candidateCount: candidates.length,
      windowCandidateCount,
      detailFetchedCount,
      sessionSavedCount,
      sourceIssueCount,
      checkpoint: options.reminderCheckpoint && checkpointClassDate
        ? {
          kind: options.reminderCheckpoint,
          classDate: checkpointClassDate,
          freshAfter: checkpointFreshAfter.toISOString(),
          pendingCount: checkpointPendingCount,
          selectedCount: candidates.length,
          remainingCount: Math.max(0, checkpointPendingCount - candidates.length),
          hasMore: checkpointPendingCount > candidates.length,
        }
        : null,
    };
  } catch (error) {
    const errorSummary = genericSyncFailure(error);
    // A failure before or around the bounded detail batch is systemic: stale
    // projections must not remain in compliance denominators while the source
    // cannot be proven healthy. Recording the issue also marks eligible rows
    // unavailable until a later successful observation restores them.
    await dependencies.repository.recordSourceIssue(
      safeWiseRunIssue(error, runId, new Date()),
    ).catch(() => undefined);
    await dependencies.repository.failSync({
      runId,
      finishedAt: new Date(),
      errorSummary,
    });
    throw new Error(errorSummary);
  }
}

export { calculateFeedbackDeadline };

/** Production entry point used by admin and cron routes. */
export async function runPostClassFeedbackSync(
  options: SyncPostClassFeedbackOptions = {},
): Promise<SyncPostClassFeedbackResult> {
  const instituteId = process.env.WISE_INSTITUTE_ID?.trim();
  if (!instituteId) throw new Error("WISE_INSTITUTE_ID is not configured");
  const db = getDb();
  return syncPostClassFeedback({
    repository: createDrizzlePostClassFeedbackRepository(db),
    client: createWiseClient(),
    instituteId,
    resolveTutor: ({ candidate, detail }) =>
      resolvePostClassCanonicalTutor(db, { candidate, detail }),
    resolvePayoutEligibility: ({ candidate }) =>
      resolvePostClassPayoutEligibility(db, candidate),
  }, options);
}
