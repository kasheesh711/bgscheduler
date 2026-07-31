import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { WiseSessionDetail } from "@/lib/wise/types";
import { getWiseSessionTeacherUserId, getWiseUserId } from "@/lib/wise/types";
import { toFeedbackEventEvidence } from "./events";
import { lockPostClassFinance } from "./finance-lock";
import { assessFeedbackContent, calculateFeedbackDeadline } from "./policy";
import { DEFAULT_FEEDBACK_FIELD_MAPPINGS } from "./wise";

/**
 * How long Wise gets to bring a session it reported missing back before the
 * recheck lane stops paying to look for it. Sessions deleted in Wise never
 * return, and they have no session row to auto-resolve against, so without a
 * floor they occupy the queue permanently.
 */
const MISSING_SESSION_RETRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * REC-03: Wise's own record that a session no longer exists.
 *
 * A deleted session answers every detail fetch with HTTP 400 "Session not
 * found!", and it can never auto-resolve: resolution requires a successful
 * observation, and a feedback event only stops being a candidate once a
 * successful observation links it. Left alone it occupies the highest-priority
 * candidate lane forever. `SessionDeletedEvent` is already mirrored into
 * `wise_activity_events` with an indexed `session_id`, so the collector can
 * simply decline to ask. Anti-joined on that index this costs nothing measurable
 * next to the event scan the lane already pays for.
 */
function deletedInWise(wiseSessionId: SQL | AnyColumn): SQL {
  // The alias is load-bearing. The highest-priority candidate lane selects FROM
  // `wise_activity_events` itself, so an unaliased subquery over the same table
  // binds both sides of the correlation to the *inner* instance: the predicate
  // degrades to `inner.session_id = inner.session_id`, true for every row the
  // moment any deletion event exists, and the lane returns nothing at all.
  return sql`exists (
    select 1 from ${schema.wiseActivityEvents} as deletion_event
    where deletion_event.event_name = 'SessionDeletedEvent'
      and deletion_event.session_id = ${wiseSessionId}
  )`;
}

/** The candidate-lane form: propose a session only while Wise still has it. */
function notDeletedInWise(wiseSessionId: SQL | AnyColumn): SQL {
  return sql`not ${deletedInWise(wiseSessionId)}`;
}

/**
 * REC-02, generalised: a session Wise has reported missing for longer than the
 * grace window is not coming back, whichever lane proposed it.
 *
 * Deletion evidence is the precise signal and `notDeletedInWise` is preferred,
 * but the `SessionDeletedEvent` mirror only reaches back to 2026-05-27. Sessions
 * that disappeared before that floor have no evidence either way, so they get
 * time rather than a guess. The issue row deliberately stays `open` — it is a
 * real unresolved fact and remains visible in Data Health; it just stops being
 * retried.
 */
function notAbandonedMissingSession(wiseSessionId: SQL | AnyColumn): SQL {
  const cutoff = new Date(Date.now() - MISSING_SESSION_RETRY_GRACE_MS);
  // Aliased for the same reason as `deletedInWise`: one caller of this predicate
  // selects FROM `post_class_source_issues`.
  return sql`not exists (
    select 1 from ${schema.postClassSourceIssues} as abandoned_issue
    where abandoned_issue.status = 'open'
      and abandoned_issue.issue_type = 'session_not_found'
      and abandoned_issue.first_seen_at < ${cutoff}
      and ${aliasedIssueWiseSessionId("abandoned_issue")} = ${wiseSessionId}
  )`;
}

/**
 * The Wise session id an issue refers to. Orphan issues — raised before the
 * session ever got a row, which is 228 of the 230 seen in production — carry it
 * only in `details.retryCandidate`; linked ones reach it through `session_id`.
 */
function aliasedIssueWiseSessionId(alias: string): SQL {
  return sql`coalesce(
    ${sql.raw(alias)}.details->'retryCandidate'->>'sessionId',
    (select retired_session.wise_session_id from ${schema.postClassSessions} as retired_session
     where retired_session.id = ${sql.raw(alias)}.session_id)
  )`;
}

/** The same expression bound to the outer `post_class_source_issues` row. */
function issueWiseSessionId(): SQL {
  return aliasedIssueWiseSessionId("post_class_source_issues");
}
import { withPostClassTransaction } from "./transaction";
import type {
  CanonicalTutorResolution,
  FeedbackVersion,
  FeedbackEventEvidence,
  FeedbackFieldMapping,
  PreviousComplianceLock,
  PostClassSessionCandidate,
  PostClassSessionObservation,
  EnforcementMode,
  DeductionStatus,
} from "./types";

export type PostClassSyncTrigger = "cron" | "manual";

export interface PostClassPolicyContext {
  settingsVersion: number;
  enforcementMode: EnforcementMode;
  policyEffectiveAt: Date | null;
  policyVersion: number;
  mappingVersion: number;
  mappings: FeedbackFieldMapping[];
}

export interface PostClassSessionEnforcementContext {
  enforcementMode: EnforcementMode;
  /** Prospective anchor for this window; null means the session is excluded. */
  policyEffectiveAt: Date | null;
}

export interface BeginPostClassSyncInput {
  triggerType: PostClassSyncTrigger;
  actorEmail: string | null;
  startedAt: Date;
  windowStart: string;
  windowEnd: string;
  detailCap: number;
}

export interface CompletePostClassSyncInput {
  runId: string;
  finishedAt: Date;
  status: "success" | "partial";
  discoveredCount: number;
  candidateCount: number;
  detailFetchedCount: number;
  sessionSavedCount: number;
  versionInsertedCount: number;
  assessedCount: number;
  sourceIssueCount: number;
  metadata?: Record<string, unknown>;
}

export interface PostClassSourceIssueInput {
  runId: string;
  sessionId?: string | null;
  scope: "global" | "session";
  issueType:
    | "wise_auth"
    | "wise_rate_limit"
    | "wise_transient"
    | "session_not_found"
    | "contract_error"
    | "configuration_changed"
    | "form_drift"
    | "identity_ambiguous"
    | "billing_evidence_missing";
  severity: "warning" | "error";
  blocksEnforcement: boolean;
  fingerprint: string;
  /** Must never contain source feedback text. */
  message: string;
  observedAt: Date;
  details?: Record<string, unknown>;
}

export interface SavePostClassObservationResult {
  versionsInserted: number;
  assessmentInserted: boolean;
}

/**
 * Persistence port for the collector. The Drizzle adapter is intentionally
 * behind this interface so policy/sync behavior remains unit-testable and
 * cannot accidentally bypass immutable-version or audit invariants.
 */
export interface PostClassFeedbackRepository {
  beginSync(input: BeginPostClassSyncInput): Promise<string>;
  completeSync(input: CompletePostClassSyncInput): Promise<void>;
  failSync(input: {
    runId: string;
    finishedAt: Date;
    errorSummary: string;
  }): Promise<void>;
  loadPolicyContext(): Promise<PostClassPolicyContext>;
  loadSessionEnforcementContext(
    scheduledEndAt: Date,
  ): Promise<PostClassSessionEnforcementContext>;
  listFeedbackEventCandidates(limit: number): Promise<PostClassSessionCandidate[]>;
  listIncompleteRecheckCandidates(limit: number): Promise<PostClassSessionCandidate[]>;
  listReminderCheckpointPersistedCandidates(
    classDate: string,
  ): Promise<PostClassSessionCandidate[]>;
  loadFeedbackEvents(sessionId: string): Promise<FeedbackEventEvidence[]>;
  /**
   * Oldest persisted `SessionFeedbackSubmittedEvent` timestamp, or null when
   * none exist. Sessions whose deadline predates this instant cannot be judged
   * late from event absence — the events simply were not collected yet.
   */
  loadFeedbackEventCoverageFloor(): Promise<Date | null>;
  loadHistoricalFeedbackVersions(sessionId: string): Promise<FeedbackVersion[]>;
  loadPreviousComplianceLock(
    sessionId: string,
    policyVersion: number,
    mappingVersion: number,
    scheduledEndAt: Date,
  ): Promise<PreviousComplianceLock | null>;
  saveObservation(
    runId: string,
    observation: PostClassSessionObservation,
  ): Promise<SavePostClassObservationResult>;
  recordSourceIssue(issue: PostClassSourceIssueInput): Promise<void>;
  pauseForFormDrift(input: {
    runId: string;
    observedAt: Date;
    reason: string;
  }): Promise<void>;
  /**
   * Optional persistence-aware filter. Implementations should remove recently
   * reconciled compliant sessions while retaining event-dirty and incomplete
   * sessions. The returned array must preserve priority order and respect cap.
   */
  filterCandidatesForFetch?(
    candidates: PostClassSessionCandidate[],
    cap: number,
    now: Date,
  ): Promise<PostClassSessionCandidate[]>;
  filterReminderCheckpointCandidates?(
    candidates: PostClassSessionCandidate[],
    freshAfter: Date,
    checkpointStartedAt: Date,
  ): Promise<{ candidates: PostClassSessionCandidate[]; totalPending: number }>;
  /**
   * REC-03. Close out sessions Wise has deleted: resolve their open
   * session-scoped issues and mark the row terminal. Optional so the many
   * hand-rolled test fakes of this interface keep compiling.
   */
  retireDeletedWiseSessions?(input: {
    runId: string;
    observedAt: Date;
  }): Promise<{ retiredIssues: number; retiredSessions: number }>;
}

const STALE_RUNNING_MS = 20 * 60 * 1000;
const CANONICAL_RECHECK_FRESHNESS_MS = 6 * 60 * 60 * 1000;
const TERMINAL_INELIGIBLE_RECHECK_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export class PostClassFeedbackSyncAlreadyRunningError extends Error {
  constructor(message = "Post-class feedback sync is already running.") {
    super(message);
    this.name = "PostClassFeedbackSyncAlreadyRunningError";
  }
}

export class PostClassFeedbackSyncSourceFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostClassFeedbackSyncSourceFenceError";
  }
}

export class PostClassPolicySnapshotConflictError extends Error {
  constructor(
    readonly expected: { settingsVersion: number; policyVersion: number; mappingVersion: number },
    readonly current: { settingsVersion: number; policyVersion: number; mappingVersion: number },
  ) {
    super("Post-class feedback configuration changed during collection.");
    this.name = "PostClassPolicySnapshotConflictError";
  }
}

/**
 * A collector may persist source truth only while its durable run still owns
 * the source-write lane. This rejects a zombie worker after stale-run recovery
 * and extends the payout lease's source freeze across external Google writes.
 */
async function assertPostClassSyncSourceWriteFence(
  db: Database,
  runId: string,
  now = new Date(),
): Promise<void> {
  const [run] = await db.select({
    status: schema.postClassSyncRuns.status,
  }).from(schema.postClassSyncRuns)
    .where(eq(schema.postClassSyncRuns.id, runId))
    .limit(1);
  if (run?.status !== "running") {
    throw new PostClassFeedbackSyncSourceFenceError(
      "This post-class feedback sync no longer owns its running source-write lane.",
    );
  }
  const [activePayout] = await db.select({
    id: schema.postClassPayoutRuns.id,
  }).from(schema.postClassPayoutRuns).where(and(
    isNotNull(schema.postClassPayoutRuns.leaseToken),
    gt(schema.postClassPayoutRuns.leaseExpiresAt, now),
  )).limit(1);
  if (activePayout) {
    throw new PostClassFeedbackSyncSourceFenceError(
      "Source persistence is deferred while a payout operation holds a live lease.",
    );
  }
}

export function assertPostClassObservationSnapshot(
  observation: Pick<
    PostClassSessionObservation,
    "settingsVersion" | "policyVersion" | "mappingVersion"
  >,
  current: { settingsVersion: number; policyVersion: number; mappingVersion: number },
): void {
  const expected = {
    settingsVersion: observation.settingsVersion,
    policyVersion: observation.policyVersion,
    mappingVersion: observation.mappingVersion,
  };
  if (
    expected.settingsVersion !== current.settingsVersion ||
    expected.policyVersion !== current.policyVersion ||
    expected.mappingVersion !== current.mappingVersion
  ) {
    throw new PostClassPolicySnapshotConflictError(expected, current);
  }
}

/**
 * Keeps the cross-source priority contract while putting never-observed
 * rolling-window sessions at the front of their reserved reconciliation lane.
 */
export function prioritizeUnseenRollingCandidates(
  candidates: PostClassSessionCandidate[],
  seenSessionIds: ReadonlySet<string>,
): PostClassSessionCandidate[] {
  const priorityCandidates = candidates.filter((candidate) => candidate.reason !== "rolling_window");
  const rolling = candidates.filter((candidate) => candidate.reason === "rolling_window");
  return [
    ...priorityCandidates,
    ...rolling.filter((candidate) => !seenSessionIds.has(candidate.sessionId)),
    ...rolling.filter((candidate) => seenSessionIds.has(candidate.sessionId)),
  ];
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string }; message?: string };
  return candidate.code === "23505" ||
    candidate.cause?.code === "23505" ||
    /pc_sync_single_running_idx/.test(candidate.message ?? "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedString(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const result = nonEmptyString(nestedValue(value, path));
    if (result) return result;
    const object = asRecord(nestedValue(value, path));
    const objectId = nonEmptyString(object._id) ?? nonEmptyString(object.id);
    if (objectId) return objectId;
  }
  return null;
}

function versionKey(version: FeedbackVersion): string {
  return version.submissionId
    ? `${version.submissionId}:${version.contentHash}`
    : version.contentHash;
}

export function postClassAssessmentKey(input: {
  syncRunId: string;
  assessedAt: Date;
  wiseSessionId: string;
  policyVersion: number;
  mappingVersion: number;
  scheduledEndAt: Date;
  deadlineAt: Date;
  enforcementMode: EnforcementMode;
  sourceStatus: string;
  contentStatus: string;
  timingStatus: string;
  governingVersionKey: string | null;
  violation: boolean;
  adjustedCompliant: boolean;
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

function bangkokMonthStart(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}-01`;
}

function eventClassId(row: {
  classroomId: string | null;
  payload: Record<string, unknown>;
}): string | null {
  return row.classroomId ?? nestedString(row.payload, [
    ["classId"],
    ["classroomId"],
    ["class", "id"],
    ["class", "_id"],
    ["classroom", "id"],
    ["classroom", "_id"],
    ["session", "classId"],
  ]);
}

const KNOWN_INELIGIBLE_REASON_VALUES = [
  "not_ended",
  "cancelled",
  "missed_or_no_show",
  "excluded_session_type",
  "complimentary_or_trial",
  "non_billable",
] as const;
const KNOWN_INELIGIBLE_REASONS = new Set<string>(KNOWN_INELIGIBLE_REASON_VALUES);

export function isKnownPostClassIneligibleReason(reason: string | null | undefined): boolean {
  return Boolean(reason && KNOWN_INELIGIBLE_REASONS.has(reason));
}

export function projectPostClassDeductionStatus(
  baseStatus: DeductionStatus | null | undefined,
  hasReversalOffset: boolean,
): DeductionStatus {
  return hasReversalOffset ? "reversed" : baseStatus ?? "none";
}

export function shouldFetchPostClassCandidate(input: {
  candidateReason: PostClassSessionCandidate["reason"];
  now: Date;
  existing?: {
    eligibilityReason: string | null;
    sourceStatus: string;
    contentStatus: string;
    timingStatus: string;
    updatedAt: Date;
  } | null;
}): boolean {
  const { existing } = input;
  if (!existing) return true;
  if (input.candidateReason !== "rolling_window") return true;
  if (isKnownPostClassIneligibleReason(existing.eligibilityReason)) {
    return input.now.getTime() - existing.updatedAt.getTime() >=
      TERMINAL_INELIGIBLE_RECHECK_FRESHNESS_MS;
  }
  const fullyReconciled = existing.sourceStatus === "ready" &&
    existing.contentStatus === "substantive" &&
    existing.timingStatus === "on_time";
  if (!fullyReconciled) return true;
  return input.now.getTime() - existing.updatedAt.getTime() >= CANONICAL_RECHECK_FRESHNESS_MS;
}

/**
 * Orders the canonical session-detail work that must finish before a reminder
 * checkpoint can proceed. A fresh successful observation suppresses a fetch,
 * while an unlinked feedback event always makes the session dirty. Failed
 * attempts remain pending but move behind sessions that have not been tried in
 * this checkpoint cycle, so a bounded 50-call batch cannot starve the tail.
 */
export function planPostClassReminderCheckpointCandidates(input: {
  candidates: PostClassSessionCandidate[];
  freshAfter: Date;
  checkpointStartedAt?: Date;
  lastObservedBySession: ReadonlyMap<string, Date | null>;
  lastAttemptBySession?: ReadonlyMap<string, Date | null>;
  eventDirtySessionIds?: ReadonlySet<string>;
}): PostClassSessionCandidate[] {
  const eventDirtySessionIds = input.eventDirtySessionIds ?? new Set<string>();
  const lastAttemptBySession = input.lastAttemptBySession ?? new Map<string, Date | null>();
  return input.candidates
    .flatMap((candidate) => {
      const lastObservedAt = input.lastObservedBySession.get(candidate.sessionId) ?? null;
      const enumerationMissingDirty = candidate.forceDetailRefresh === true && (
        !lastObservedAt ||
        !input.checkpointStartedAt ||
        lastObservedAt < input.checkpointStartedAt
      );
      const eventDirty = enumerationMissingDirty || candidate.reason === "feedback_event" ||
        eventDirtySessionIds.has(candidate.sessionId);
      if (!eventDirty && lastObservedAt && lastObservedAt >= input.freshAfter) return [];
      return [{
        candidate: eventDirty && candidate.reason !== "feedback_event"
          ? { ...candidate, reason: "feedback_event" as const }
          : candidate,
        eventDirty,
        queueAt: Math.max(
          lastObservedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
          lastAttemptBySession.get(candidate.sessionId)?.getTime() ?? Number.NEGATIVE_INFINITY,
        ),
      }];
    })
    .toSorted((left, right) => {
      if (left.queueAt !== right.queueAt) return left.queueAt - right.queueAt;
      if (left.eventDirty !== right.eventDirty) return left.eventDirty ? -1 : 1;
      const scheduled = (left.candidate.scheduledEndAt?.getTime() ?? 0) -
        (right.candidate.scheduledEndAt?.getTime() ?? 0);
      return scheduled || left.candidate.sessionId.localeCompare(right.candidate.sessionId);
    })
    .map(({ candidate }) => candidate);
}

export function postClassBangkokDateBounds(classDate: string): {
  start: Date;
  end: Date;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(classDate)) {
    throw new Error("Post-class checkpoint date must use YYYY-MM-DD.");
  }
  const start = new Date(`${classDate}T00:00:00.000+07:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error("Post-class checkpoint date is invalid.");
  }
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export function postClassRetryCandidateFromIssueDetails(
  details: Record<string, unknown>,
): PostClassSessionCandidate | null {
  const retry = asRecord(details.retryCandidate);
  const sessionId = nonEmptyString(retry.sessionId);
  const classId = nonEmptyString(retry.classId);
  if (!sessionId || !classId || sessionId === "collector" || classId === "collector") return null;
  const scheduledStartAt = retry.scheduledStartAt instanceof Date
    ? retry.scheduledStartAt
    : nonEmptyString(retry.scheduledStartAt)
      ? new Date(nonEmptyString(retry.scheduledStartAt)!)
      : null;
  const scheduledEndAt = retry.scheduledEndAt instanceof Date
    ? retry.scheduledEndAt
    : nonEmptyString(retry.scheduledEndAt)
      ? new Date(nonEmptyString(retry.scheduledEndAt)!)
      : null;
  return {
    sessionId,
    classId,
    reason: "incomplete_recheck",
    scheduledStartAt: scheduledStartAt && !Number.isNaN(scheduledStartAt.getTime())
      ? scheduledStartAt
      : null,
    scheduledEndAt: scheduledEndAt && !Number.isNaN(scheduledEndAt.getTime())
      ? scheduledEndAt
      : null,
  };
}

export function postClassSourceIssueWiseSessionId(input: {
  /** Internal post_class_sessions UUID; intentionally never returned as a Wise ID. */
  sourceIssueSessionId: string | null;
  linkedWiseSessionId: string | null;
  details: Record<string, unknown>;
}): string | null {
  void input.sourceIssueSessionId;
  return input.linkedWiseSessionId ??
    postClassRetryCandidateFromIssueDetails(input.details)?.sessionId ??
    null;
}

export function resolvedPostClassSessionIssueUpdate(
  sessionId: string,
  resolvedAt: Date,
): {
  sessionId: string;
  status: "resolved";
  resolvedAt: Date;
  resolvedByEmail: string;
  lastSeenAt: Date;
} {
  return {
    sessionId,
    status: "resolved",
    resolvedAt,
    resolvedByEmail: "system:post-class-feedback",
    lastSeenAt: resolvedAt,
  };
}

/**
 * Open source issues that suspend enforcement feature-wide.
 *
 * The predicate every money-adjacent gate agrees on — `revalidateDeductionCandidate`,
 * the payout publish coverage, the notification suppressor — kept in one place so
 * the shadow-review gate cannot drift from them. Scope matters: a session-scoped
 * issue is a fact about one row and blocks only that row.
 */
export async function countOpenBlockingGlobalSourceIssues(db: Database): Promise<number> {
  const rows = await db.select({ id: schema.postClassSourceIssues.id })
    .from(schema.postClassSourceIssues)
    .where(and(
      eq(schema.postClassSourceIssues.scope, "global"),
      eq(schema.postClassSourceIssues.status, "open"),
      eq(schema.postClassSourceIssues.blocksEnforcement, true),
    ));
  return rows.length;
}

export interface PostClassRecentReadiness {
  eligible: number;
  ready: number;
}

/**
 * How much of the period about to be enforced has actually resolved.
 *
 * The activation gate's resolvability signal. Measured from persisted state
 * rather than from a sync run's counters, because one run sees at most 50
 * candidates and — with the event and recheck lanes unbounded by date — as few
 * as one of them may be recent. A run-level rate therefore says almost nothing
 * about the period being enforced, which is the only period that matters:
 * sessions ending before the activation instant can be assessed but can never
 * produce a deduction (`policyApplies`, policy.ts).
 *
 * Counts only `eligible` sessions. A cancelled or non-billable class is
 * correctly non-ready and must not drag the rate down.
 */
export async function loadPostClassRecentSessionReadiness(
  db: Database,
  input: { since: Date },
): Promise<PostClassRecentReadiness> {
  const [row] = await db.select({
    eligible: sql<number>`count(*)`,
    ready: sql<number>`count(*) filter (where ${schema.postClassSessions.sourceStatus} = 'ready')`,
  }).from(schema.postClassSessions).where(and(
    gte(schema.postClassSessions.scheduledEndAt, input.since),
    eq(schema.postClassSessions.eligible, true),
  ));
  return { eligible: Number(row?.eligible ?? 0), ready: Number(row?.ready ?? 0) };
}

/**
 * Close an issue whose subject Wise deleted (REC-03).
 *
 * Sibling of `resolvedPostClassSessionIssueUpdate`, which cannot serve here: it
 * writes `sessionId`, and 228 of the 230 issues seen in production are orphans
 * with no session row to point at. `status` stays `"resolved"` rather than
 * gaining a new value — every consumer filters on `"open"`, and a new value
 * would slip past the fingerprint-archival branch in `recordSourceIssue` and
 * silently reopen. `details.retiredReason` is what distinguishes a retirement
 * from a genuine recovery.
 */
export function retiredPostClassSourceIssueUpdate(retiredAt: Date): {
  status: "resolved";
  resolvedAt: Date;
  resolvedByEmail: string;
  lastSeenAt: Date;
} {
  return {
    status: "resolved",
    resolvedAt: retiredAt,
    resolvedByEmail: "system:post-class-feedback",
    lastSeenAt: retiredAt,
  };
}

export function postClassSourceStatusForIssue(
  issue: Pick<PostClassSourceIssueInput, "scope" | "issueType">,
): "identity_review" | "unavailable" {
  return issue.scope === "session" && issue.issueType === "identity_ambiguous"
    ? "identity_review"
    : "unavailable";
}

function latestTeacherVersion(versions: FeedbackVersion[]): FeedbackVersion | null {
  return versions
    .filter((version) => version.profile?.trim().toLowerCase() === "teacher")
    .filter((version) => assessFeedbackContent(version.fields).contentStatus === "substantive")
    .toSorted((left, right) => {
      const leftTime = left.sourceCreatedAt?.getTime() ?? left.observedAt.getTime();
      const rightTime = right.sourceCreatedAt?.getTime() ?? right.observedAt.getTime();
      return leftTime - rightTime || left.observedAt.getTime() - right.observedAt.getTime();
    })
    .at(-1) ?? null;
}

function timingEvidence(
  assessment: NonNullable<PostClassSessionObservation["assessment"]>,
  governing: FeedbackVersion | null,
): string {
  // An immutable Wise activity event outranks every mutable submission
  // timestamp, so it is reported as the evidence whenever it drove the verdict.
  if (assessment.timingEvidenceSource === "activity_event") {
    return assessment.timingStatus === "on_time"
      ? "wise_activity_event_before_deadline"
      : "wise_activity_event_no_tutor_submission";
  }
  if (assessment.onTimeComplianceLocked) return "proven_before_deadline";
  if (assessment.timingStatus === "unknown") return "wise_timestamp_unavailable";
  if (governing?.sourceTimestampKind === "created" &&
    !governing.sourceTimestampTrustworthy &&
    governing.sourceCreatedAt &&
    governing.sourceCreatedAt.getTime() > assessment.deadlineAt.getTime()) {
    return "wise_created_at_late_lower_bound";
  }
  if (governing?.sourceTimestampTrustworthy) return "wise_source_created_at";
  return "observed_state";
}

class DrizzlePostClassFeedbackRepository implements PostClassFeedbackRepository {
  constructor(private readonly db: Database) {}

  async beginSync(input: BeginPostClassSyncInput): Promise<string> {
    try {
      const runId = await withPostClassTransaction(this.db, async (tx) => {
        await lockPostClassFinance(tx);
        await tx
          .update(schema.postClassSyncRuns)
          .set({
            status: "failed",
            finishedAt: input.startedAt,
            errorSummary: "Marked failed after remaining in running state for more than 20 minutes.",
          })
          .where(and(
            eq(schema.postClassSyncRuns.status, "running"),
            lte(
              schema.postClassSyncRuns.startedAt,
              new Date(input.startedAt.getTime() - STALE_RUNNING_MS),
            ),
          ));

        // A payout pass releases the transaction lock while it performs
        // irreversible Google appends. Its durable lease extends the source
        // freeze across that interval: starting a collector here would let
        // eligibility, matching cells, or a global source issue change under
        // the append plan.
        const [activePayout] = await tx.select({
          leaseExpiresAt: schema.postClassPayoutRuns.leaseExpiresAt,
        }).from(schema.postClassPayoutRuns).where(and(
          isNotNull(schema.postClassPayoutRuns.leaseToken),
          gt(schema.postClassPayoutRuns.leaseExpiresAt, input.startedAt),
        )).limit(1);
        if (activePayout) return null;

        const [run] = await tx.insert(schema.postClassSyncRuns).values({
          status: "running",
          triggerType: input.triggerType,
          actorEmail: input.actorEmail,
          startedAt: input.startedAt,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          detailCap: input.detailCap,
        }).returning({ id: schema.postClassSyncRuns.id });
        return run.id;
      });
      if (!runId) {
        throw new PostClassFeedbackSyncAlreadyRunningError(
          "Post-class feedback sync is deferred while a payout operation holds a live lease.",
        );
      }
      return runId;
    } catch (error) {
      if (isUniqueViolation(error)) throw new PostClassFeedbackSyncAlreadyRunningError();
      throw error;
    }
  }

  async completeSync(input: CompletePostClassSyncInput): Promise<void> {
    await withPostClassTransaction(this.db, async (tx) => {
      // Resolving a global issue and restoring the prior per-session source
      // states changes both the close gates and the preview fingerprint. Keep
      // that recovery atomic with every other finance transition.
      await lockPostClassFinance(tx);
      await assertPostClassSyncSourceWriteFence(tx, input.runId);
      await tx.update(schema.postClassSyncRuns).set({
        status: "success",
        finishedAt: input.finishedAt,
        discoveredCount: input.discoveredCount,
        sessionCount: input.sessionSavedCount,
        detailFetchedCount: input.detailFetchedCount,
        versionInsertedCount: input.versionInsertedCount,
        assessedCount: input.assessedCount,
        sourceIssueCount: input.sourceIssueCount,
        metadata: {
          ...input.metadata,
          outcome: input.status,
          candidateCount: input.candidateCount,
        },
      }).where(eq(schema.postClassSyncRuns.id, input.runId));
      if (input.metadata?.globalSourceHealthy === true) {
        await tx.update(schema.postClassSourceIssues).set({
          status: "resolved",
          resolvedAt: input.finishedAt,
          resolvedByEmail: "system:post-class-feedback",
        }).where(and(
          eq(schema.postClassSourceIssues.scope, "global"),
          eq(schema.postClassSourceIssues.status, "open"),
          ne(schema.postClassSourceIssues.issueType, "form_drift"),
        ));
        // REC-01: source health is proven again, so undo the run-wide demotion in
        // one statement. Rows observed first-hand since the demotion already
        // cleared `sourceStatusBefore` in `saveObservation`, so this only touches
        // rows whose status is still the demotion's placeholder.
        await tx.update(schema.postClassSessions).set({
          sourceStatus: sql`${schema.postClassSessions.sourceStatusBefore}`,
          sourceStatusBefore: null,
          updatedAt: input.finishedAt,
        }).where(isNotNull(schema.postClassSessions.sourceStatusBefore));
      }
    });
  }

  async failSync(input: { runId: string; finishedAt: Date; errorSummary: string }): Promise<void> {
    await this.db.update(schema.postClassSyncRuns).set({
      status: "failed",
      finishedAt: input.finishedAt,
      errorSummary: input.errorSummary,
    }).where(eq(schema.postClassSyncRuns.id, input.runId));
  }

  async loadPolicyContext(): Promise<PostClassPolicyContext> {
    const [settings] = await this.db.select().from(schema.postClassSettings).limit(1);
    const mappingVersion = settings?.formMappingVersion ?? 1;
    const rows = await this.db.select().from(schema.postClassFieldMappings).where(and(
      eq(schema.postClassFieldMappings.mappingVersion, mappingVersion),
      eq(schema.postClassFieldMappings.active, true),
    ));
    const validFields = new Set(["topics", "performance", "improvement", "homework"]);
    const mappings = rows.flatMap((row): FeedbackFieldMapping[] =>
      validFields.has(row.fieldKey)
        ? [{
          field: row.fieldKey as FeedbackFieldMapping["field"],
          questionText: row.wiseQuestionText,
        }]
        : []);
    return {
      settingsVersion: settings?.version ?? 1,
      enforcementMode: settings?.enforcementMode ?? "shadow",
      policyEffectiveAt: settings?.policyEffectiveAt ?? null,
      policyVersion: settings?.policyVersion ?? 1,
      mappingVersion,
      mappings: mappings.length > 0 ? mappings : [...DEFAULT_FEEDBACK_FIELD_MAPPINGS],
    };
  }

  async loadSessionEnforcementContext(
    scheduledEndAt: Date,
  ): Promise<PostClassSessionEnforcementContext> {
    const [window] = await this.db.select({
      mode: schema.postClassEnforcementWindows.mode,
      startsAt: schema.postClassEnforcementWindows.startsAt,
      policyEffectiveAt: schema.postClassEnforcementWindows.policyEffectiveAt,
    }).from(schema.postClassEnforcementWindows).where(and(
      lte(schema.postClassEnforcementWindows.startsAt, scheduledEndAt),
      or(
        isNull(schema.postClassEnforcementWindows.endsAt),
        gt(schema.postClassEnforcementWindows.endsAt, scheduledEndAt),
      ),
    )).orderBy(desc(schema.postClassEnforcementWindows.startsAt)).limit(1);
    if (!window) return { enforcementMode: "paused", policyEffectiveAt: null };
    return {
      enforcementMode: window.mode,
      policyEffectiveAt: window.mode === "shadow"
        ? window.startsAt
        : window.policyEffectiveAt,
    };
  }

  async listFeedbackEventCandidates(limit: number): Promise<PostClassSessionCandidate[]> {
    const boundedLimit = Math.max(0, limit);
    if (boundedLimit === 0) return [];
    const batchSize = Math.max(100, boundedLimit * 2);
    const candidates = new Map<string, PostClassSessionCandidate>();
    let offset = 0;

    // Keep scanning after malformed/unresolvable activity rows. Limiting the
    // raw query first allowed a burst of invalid events to consume the entire
    // event-candidate budget indefinitely.
    while (candidates.size < boundedLimit) {
      const rows = await this.db.select({
        sessionId: schema.wiseActivityEvents.sessionId,
        classroomId: schema.wiseActivityEvents.classroomId,
        sessionStartTime: schema.wiseActivityEvents.sessionStartTime,
        sessionEndTime: schema.wiseActivityEvents.sessionEndTime,
        payload: schema.wiseActivityEvents.payload,
        persistedClassId: schema.postClassSessions.wiseClassId,
      }).from(schema.wiseActivityEvents)
        .leftJoin(
          schema.postClassFeedbackEventLinks,
          eq(schema.wiseActivityEvents.id, schema.postClassFeedbackEventLinks.wiseActivityEventId),
        )
        .leftJoin(
          schema.postClassSessions,
          eq(schema.wiseActivityEvents.sessionId, schema.postClassSessions.wiseSessionId),
        )
        .where(and(
          eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
          isNotNull(schema.wiseActivityEvents.sessionId),
          isNull(schema.postClassFeedbackEventLinks.id),
          // Both filters must live inside the query, before the LIMIT. Dropping
          // these candidates after the fact would stop the fetches but not let
          // the paging loop reach the live sessions queued behind them, so a
          // backlog of dead sessions would still starve the run.
          notDeletedInWise(schema.wiseActivityEvents.sessionId),
          notAbandonedMissingSession(schema.wiseActivityEvents.sessionId),
        ))
        .orderBy(desc(schema.wiseActivityEvents.eventTimestamp))
        .limit(batchSize)
        .offset(offset);
      if (rows.length === 0) break;
      offset += rows.length;
      for (const row of rows) {
        if (!row.sessionId) continue;
        const classId = eventClassId(row) ?? row.persistedClassId;
        if (!classId || candidates.has(row.sessionId)) continue;
        candidates.set(row.sessionId, {
          sessionId: row.sessionId,
          classId,
          reason: "feedback_event",
          scheduledStartAt: row.sessionStartTime,
          scheduledEndAt: row.sessionEndTime,
        });
        if (candidates.size >= boundedLimit) break;
      }
      if (rows.length < batchSize) break;
    }
    return [...candidates.values()];
  }

  async listIncompleteRecheckCandidates(limit: number): Promise<PostClassSessionCandidate[]> {
    const boundedLimit = Math.max(0, limit);
    if (boundedLimit === 0) return [];
    const [rows, terminalRows, retryIssueRows] = await Promise.all([
      this.db.select({
        wiseSessionId: schema.postClassSessions.wiseSessionId,
        wiseClassId: schema.postClassSessions.wiseClassId,
        scheduledStartAt: schema.postClassSessions.scheduledStartAt,
        scheduledEndAt: schema.postClassSessions.scheduledEndAt,
        queueAt: schema.postClassSessions.updatedAt,
      }).from(schema.postClassSessions).where(and(
        or(
          eq(schema.postClassSessions.eligible, true),
          eq(schema.postClassSessions.eligibilityReason, "billing_evidence_missing"),
        ),
        isNull(schema.postClassSessions.wiseDeletedAt),
        notDeletedInWise(schema.postClassSessions.wiseSessionId),
        notAbandonedMissingSession(schema.postClassSessions.wiseSessionId),
      )).orderBy(
        // REC-04: not-yet-ready rows sort first. A run-wide fail-closed demotion
        // resets every eligible row's `updated_at` to the same instant, so an
        // `updated_at`-only order lets the already-`ready` rows fill the detailCap
        // slice and the demoted `unavailable` backlog is never re-observed —
        // permanent non-convergence. `source_status = 'ready'` is false for the
        // non-ready rows, and false sorts before true, so the backlog enters the
        // slice and each run drains detailCap of it. Ties keep the prior order.
        asc(sql`${schema.postClassSessions.sourceStatus} = 'ready'`),
        asc(schema.postClassSessions.updatedAt),
        asc(schema.postClassSessions.scheduledEndAt),
      ).limit(boundedLimit),
      this.db.select({
        wiseSessionId: schema.postClassSessions.wiseSessionId,
        wiseClassId: schema.postClassSessions.wiseClassId,
        scheduledStartAt: schema.postClassSessions.scheduledStartAt,
        scheduledEndAt: schema.postClassSessions.scheduledEndAt,
        queueAt: schema.postClassSessions.updatedAt,
      }).from(schema.postClassSessions).where(and(
        inArray(
          schema.postClassSessions.eligibilityReason,
          [...KNOWN_INELIGIBLE_REASON_VALUES],
        ),
        // The one-terminal-row-per-run readmission exists so corrected Wise
        // status or billing can recover. A deleted session has nothing to
        // recover to, so it must not consume that slot.
        isNull(schema.postClassSessions.wiseDeletedAt),
        notDeletedInWise(schema.postClassSessions.wiseSessionId),
      )).orderBy(
        asc(schema.postClassSessions.updatedAt),
        asc(schema.postClassSessions.scheduledEndAt),
      ).limit(1),
      this.db.select({
        details: schema.postClassSourceIssues.details,
        queueAt: schema.postClassSourceIssues.lastSeenAt,
      }).from(schema.postClassSourceIssues).where(and(
        eq(schema.postClassSourceIssues.scope, "session"),
        eq(schema.postClassSourceIssues.status, "open"),
        isNull(schema.postClassSourceIssues.sessionId),
        // A session Wise has reported missing for longer than the grace window
        // is deleted, not late. It has no session row, so it can never
        // auto-resolve, and re-fetching it every run spends a Wise call and a
        // recheck slot a recoverable session could have used. The issue stays
        // open and visible in Data Health — it is a real unresolved fact — it
        // simply stops being retried.
        or(
          ne(schema.postClassSourceIssues.issueType, "session_not_found"),
          gte(
            schema.postClassSourceIssues.firstSeenAt,
            new Date(Date.now() - MISSING_SESSION_RETRY_GRACE_MS),
          ),
        ),
        // Proven deletion needs no grace period at all.
        notDeletedInWise(issueWiseSessionId()),
      )).orderBy(asc(schema.postClassSourceIssues.lastSeenAt)).limit(boundedLimit),
    ]);
    const queued: Array<{ candidate: PostClassSessionCandidate; queueAt: Date }> = rows.map((row) => ({
      candidate: {
        sessionId: row.wiseSessionId,
        classId: row.wiseClassId,
        reason: "incomplete_recheck",
        scheduledStartAt: row.scheduledStartAt,
        scheduledEndAt: row.scheduledEndAt,
        recheckPriorityAt: row.queueAt,
      },
      queueAt: row.queueAt,
    }));
    for (const row of terminalRows) {
      queued.push({
        candidate: {
          sessionId: row.wiseSessionId,
          classId: row.wiseClassId,
          reason: "incomplete_recheck",
          scheduledStartAt: row.scheduledStartAt,
          scheduledEndAt: row.scheduledEndAt,
          // One terminal row is deliberately admitted per run so corrected
          // Wise status/billing can recover without consuming the recheck cap.
          recheckPriorityAt: new Date(0),
        },
        queueAt: new Date(0),
      });
    }
    for (const row of retryIssueRows) {
      const candidate = postClassRetryCandidateFromIssueDetails(row.details);
      if (candidate) queued.push({
        candidate: { ...candidate, recheckPriorityAt: row.queueAt },
        queueAt: row.queueAt,
      });
    }
    const combined = new Map<string, PostClassSessionCandidate>();
    for (const item of queued.toSorted(
      (left, right) => left.queueAt.getTime() - right.queueAt.getTime(),
    )) {
      if (!combined.has(item.candidate.sessionId)) {
        combined.set(item.candidate.sessionId, item.candidate);
      }
    }
    return [...combined.values()].slice(0, boundedLimit);
  }

  async listReminderCheckpointPersistedCandidates(
    classDate: string,
  ): Promise<PostClassSessionCandidate[]> {
    const { start, end } = postClassBangkokDateBounds(classDate);
    const rows = await this.db.select({
      wiseSessionId: schema.postClassSessions.wiseSessionId,
      wiseClassId: schema.postClassSessions.wiseClassId,
      scheduledStartAt: schema.postClassSessions.scheduledStartAt,
      scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    }).from(schema.postClassSessions).where(and(
      eq(schema.postClassSessions.eligible, true),
      gte(schema.postClassSessions.scheduledEndAt, start),
      lt(schema.postClassSessions.scheduledEndAt, end),
    )).orderBy(asc(schema.postClassSessions.scheduledEndAt));
    return rows.map((row) => ({
      sessionId: row.wiseSessionId,
      classId: row.wiseClassId,
      reason: "rolling_window" as const,
      scheduledStartAt: row.scheduledStartAt,
      scheduledEndAt: row.scheduledEndAt,
    }));
  }

  async loadFeedbackEvents(sessionId: string): Promise<FeedbackEventEvidence[]> {
    const rows = await this.db.select({
      rowId: schema.wiseActivityEvents.id,
      eventId: schema.wiseActivityEvents.eventId,
      eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
      actorWiseUserId: schema.wiseActivityEvents.actorWiseUserId,
      actorName: schema.wiseActivityEvents.actorName,
      actorRole: schema.wiseActivityEvents.actorRole,
      payload: schema.wiseActivityEvents.payload,
    }).from(schema.wiseActivityEvents).where(and(
      eq(schema.wiseActivityEvents.sessionId, sessionId),
      eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
    )).orderBy(asc(schema.wiseActivityEvents.eventTimestamp));
    return rows.map((row) => toFeedbackEventEvidence(sessionId, row));
  }

  async loadFeedbackEventCoverageFloor(): Promise<Date | null> {
    const [row] = await this.db
      .select({ oldest: sql<Date | null>`min(${schema.wiseActivityEvents.eventTimestamp})` })
      .from(schema.wiseActivityEvents)
      .where(eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"));
    if (!row?.oldest) return null;
    return row.oldest instanceof Date ? row.oldest : new Date(row.oldest);
  }

  async loadHistoricalFeedbackVersions(sessionId: string): Promise<FeedbackVersion[]> {
    const [session] = await this.db.select({ id: schema.postClassSessions.id })
      .from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.wiseSessionId, sessionId))
      .limit(1);
    if (!session) return [];
    const rows = await this.db.select().from(schema.postClassFeedbackVersions)
      .where(eq(schema.postClassFeedbackVersions.sessionId, session.id))
      .orderBy(asc(schema.postClassFeedbackVersions.observedAt));
    return rows.map((row) => ({
      submissionId: row.wiseSubmissionId,
      profile: row.profile,
      answers: (row.answers ?? []).flatMap((value) => {
        const answer = asRecord(value);
        const rawAnswer = answer.answer;
        if (typeof rawAnswer !== "string") return [];
        return [{
          id: nonEmptyString(answer.id),
          questionId: nonEmptyString(answer.questionId),
          questionText: nonEmptyString(answer.questionText),
          type: nonEmptyString(answer.type),
          answer: rawAnswer,
          rawAnswer: Object.prototype.hasOwnProperty.call(answer, "rawAnswer")
            ? answer.rawAnswer
            : rawAnswer,
        }];
      }),
      fields: {
        topics: row.topics,
        performance: row.performance,
        improvement: row.improvement,
        homework: row.homework,
      },
      contentHash: row.contentHash,
      sourceCreatedAt: row.sourceCreatedAt,
      sourceTimestampTrustworthy: row.sourceTimestampTrustworthy,
      sourceTimestampKind: row.sourceTimestampKind === "created" || row.sourceTimestampKind === "updated"
        ? row.sourceTimestampKind
        : "unknown",
      observedAt: row.observedAt,
      actorWiseUserId: row.actorWiseUserId,
      actorName: row.actorName,
      provenance: row.provenance,
    }));
  }

  async loadPreviousComplianceLock(
    sessionId: string,
    policyVersion: number,
    mappingVersion: number,
    scheduledEndAt: Date,
  ): Promise<PreviousComplianceLock | null> {
    const [session] = await this.db.select({
      id: schema.postClassSessions.id,
    }).from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.wiseSessionId, sessionId))
      .limit(1);
    if (!session) return null;
    const assessments = await this.db.select({
      assessedAt: schema.postClassAssessments.assessedAt,
      rawOnTime: schema.postClassAssessments.rawOnTime,
      objectiveViolation: schema.postClassAssessments.objectiveViolation,
      details: schema.postClassAssessments.details,
    }).from(schema.postClassAssessments).where(and(
      eq(schema.postClassAssessments.sessionId, session.id),
      eq(schema.postClassAssessments.policyVersion, policyVersion),
      eq(schema.postClassAssessments.mappingVersion, mappingVersion),
      eq(schema.postClassAssessments.sourceReady, true),
    )).orderBy(asc(schema.postClassAssessments.assessedAt));
    const deadlineAt = calculateFeedbackDeadline(scheduledEndAt);
    const scopedAssessments = assessments.filter((assessment) => {
      const details = asRecord(assessment.details);
      const assessedEnd = nonEmptyString(details.scheduledEndAt);
      const assessedDeadline = nonEmptyString(details.deadlineAt);
      return Boolean(
        assessedEnd &&
        assessedDeadline &&
        new Date(assessedEnd).getTime() === scheduledEndAt.getTime() &&
        new Date(assessedDeadline).getTime() === deadlineAt.getTime(),
      );
    });
    const onTimeAssessment = scopedAssessments.find((assessment) => assessment.rawOnTime) ?? null;
    const violation = scopedAssessments.find((assessment) => assessment.objectiveViolation) ?? null;
    const onTimeVersionKey = onTimeAssessment
      ? nonEmptyString(asRecord(onTimeAssessment.details).onTimeVersionKey)
      : null;
    const [feedback] = onTimeAssessment && onTimeVersionKey
      ? await this.db.select({
        versionKey: schema.postClassFeedbackVersions.versionKey,
        sourceCreatedAt: schema.postClassFeedbackVersions.sourceCreatedAt,
        observedAt: schema.postClassFeedbackVersions.observedAt,
      }).from(schema.postClassFeedbackVersions)
        .where(and(
          eq(schema.postClassFeedbackVersions.sessionId, session.id),
          eq(schema.postClassFeedbackVersions.versionKey, onTimeVersionKey),
        ))
        .limit(1)
      : [];
    if (!feedback && !violation) return null;
    return {
      locked: Boolean(onTimeAssessment && feedback),
      versionKey: feedback?.versionKey ?? null,
      provedAt: feedback
        ? feedback.sourceCreatedAt ?? feedback.observedAt
        : violation?.assessedAt ?? null,
      violationLocked: Boolean(violation),
      policyVersion,
      mappingVersion,
      scheduledEndAt,
      deadlineAt,
    };
  }

  async filterCandidatesForFetch(
    candidates: PostClassSessionCandidate[],
    cap: number,
    now: Date,
  ): Promise<PostClassSessionCandidate[]> {
    if (candidates.length === 0) return [];
    const rows = await this.db.select({
      wiseSessionId: schema.postClassSessions.wiseSessionId,
      sourceStatus: schema.postClassSessions.sourceStatus,
      contentStatus: schema.postClassSessions.contentStatus,
      timingStatus: schema.postClassSessions.timingStatus,
      eligibilityReason: schema.postClassSessions.eligibilityReason,
      wiseDeletedAt: schema.postClassSessions.wiseDeletedAt,
      updatedAt: schema.postClassSessions.updatedAt,
    }).from(schema.postClassSessions).where(inArray(
      schema.postClassSessions.wiseSessionId,
      candidates.map((candidate) => candidate.sessionId),
    ));
    const byId = new Map(rows.map((row) => [row.wiseSessionId, row]));
    const fetchable = candidates.filter((candidate) => {
      // Belt and braces behind the lane filters: a row already known deleted is
      // never worth a Wise call, whichever lane proposed it.
      if (byId.get(candidate.sessionId)?.wiseDeletedAt) return false;
      return shouldFetchPostClassCandidate({
        candidateReason: candidate.reason,
        existing: byId.get(candidate.sessionId),
        now,
      });
    });
    return prioritizeUnseenRollingCandidates(
      fetchable,
      new Set(rows.map((row) => row.wiseSessionId)),
    ).slice(0, cap);
  }

  /**
   * REC-03: close out every session Wise has deleted.
   *
   * Runs at the top of a sync, before candidates are listed, so the lane
   * filters and this sweep always agree about what is dead. Two statements:
   *
   * 1. Resolve open session-scoped issues whose subject has a
   *    `SessionDeletedEvent`. Covers both `session_not_found` and the
   *    `detail_retry` `contract_error` rows raised alongside them, and reaches
   *    orphan issues (no session row) through `details.retryCandidate`.
   * 2. Mark any session row we do hold terminal — `wiseDeletedAt` for the fact,
   *    `eligible = false` so every existing eligibility-gated path drops it
   *    without needing to learn a new concept.
   *
   * Takes the finance lock and the source-write fence for the same reason
   * `recordSourceIssue` does: it writes the source-truth surface a payout run
   * may be reading under lease.
   */
  async retireDeletedWiseSessions(input: {
    runId: string;
    observedAt: Date;
  }): Promise<{ retiredIssues: number; retiredSessions: number }> {
    return withPostClassTransaction(this.db, async (tx) => {
      await lockPostClassFinance(tx);
      await assertPostClassSyncSourceWriteFence(tx, input.runId);
      const retiredIssues = await tx.update(schema.postClassSourceIssues).set({
        ...retiredPostClassSourceIssueUpdate(input.observedAt),
        details: sql`coalesce(${schema.postClassSourceIssues.details}, '{}'::jsonb)
          || jsonb_build_object('retiredReason', 'wise_session_deleted')`,
      }).where(and(
        eq(schema.postClassSourceIssues.scope, "session"),
        eq(schema.postClassSourceIssues.status, "open"),
        deletedInWise(issueWiseSessionId()),
      )).returning({ id: schema.postClassSourceIssues.id });
      const retiredSessions = await tx.update(schema.postClassSessions).set({
        wiseDeletedAt: input.observedAt,
        eligible: false,
        eligibilityReason: "deleted_in_wise",
        updatedAt: input.observedAt,
      }).where(and(
        isNull(schema.postClassSessions.wiseDeletedAt),
        deletedInWise(schema.postClassSessions.wiseSessionId),
      )).returning({ id: schema.postClassSessions.id });
      return {
        retiredIssues: retiredIssues.length,
        retiredSessions: retiredSessions.length,
      };
    });
  }

  async filterReminderCheckpointCandidates(
    candidates: PostClassSessionCandidate[],
    freshAfter: Date,
    checkpointStartedAt: Date,
  ): Promise<{ candidates: PostClassSessionCandidate[]; totalPending: number }> {
    if (candidates.length === 0) return { candidates: [], totalPending: 0 };
    const sessionIds = candidates.map((candidate) => candidate.sessionId);
    const [sessionRows, issueRows, dirtyEventRows] = await Promise.all([
      this.db.select({
        wiseSessionId: schema.postClassSessions.wiseSessionId,
        lastObservedAt: schema.postClassSessions.lastObservedAt,
      }).from(schema.postClassSessions).where(inArray(
        schema.postClassSessions.wiseSessionId,
        sessionIds,
      )),
      this.db.select({
        sourceIssueSessionId: schema.postClassSourceIssues.sessionId,
        linkedWiseSessionId: schema.postClassSessions.wiseSessionId,
        details: schema.postClassSourceIssues.details,
        lastSeenAt: schema.postClassSourceIssues.lastSeenAt,
      }).from(schema.postClassSourceIssues)
        .leftJoin(
          schema.postClassSessions,
          eq(schema.postClassSourceIssues.sessionId, schema.postClassSessions.id),
        )
        .where(and(
          eq(schema.postClassSourceIssues.scope, "session"),
          eq(schema.postClassSourceIssues.status, "open"),
        )),
      this.db.select({
        sessionId: schema.wiseActivityEvents.sessionId,
      }).from(schema.wiseActivityEvents)
        .leftJoin(
          schema.postClassFeedbackEventLinks,
          eq(schema.wiseActivityEvents.id, schema.postClassFeedbackEventLinks.wiseActivityEventId),
        )
        .where(and(
          eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
          inArray(schema.wiseActivityEvents.sessionId, sessionIds),
          isNull(schema.postClassFeedbackEventLinks.id),
        )),
    ]);
    const lastObservedBySession = new Map(
      sessionRows.map((row) => [row.wiseSessionId, row.lastObservedAt]),
    );
    const lastAttemptBySession = new Map<string, Date | null>();
    const candidateIds = new Set(sessionIds);
    for (const row of issueRows) {
      const wiseSessionId = postClassSourceIssueWiseSessionId({
        sourceIssueSessionId: row.sourceIssueSessionId,
        linkedWiseSessionId: row.linkedWiseSessionId,
        details: row.details,
      });
      if (!wiseSessionId || !candidateIds.has(wiseSessionId)) continue;
      const previous = lastAttemptBySession.get(wiseSessionId);
      if (!previous || row.lastSeenAt > previous) {
        lastAttemptBySession.set(wiseSessionId, row.lastSeenAt);
      }
    }
    const eventDirtySessionIds = new Set(
      dirtyEventRows.flatMap((row) => row.sessionId ? [row.sessionId] : []),
    );
    const pending = planPostClassReminderCheckpointCandidates({
      candidates,
      freshAfter,
      checkpointStartedAt,
      lastObservedBySession,
      lastAttemptBySession,
      eventDirtySessionIds,
    });
    return { candidates: pending, totalPending: pending.length };
  }

  async saveObservation(
    runId: string,
    observation: PostClassSessionObservation,
  ): Promise<SavePostClassObservationResult> {
    return withPostClassTransaction(this.db, async (tx) => {
      // A source refresh can change coverage, candidate membership, and the
      // signed payout obligations for an open window. Serialize those writes
      // with preview-token validation, publication, review mutations, and
      // closing so every finance transition observes one coherent source
      // snapshot.
      await lockPostClassFinance(tx);
      await assertPostClassSyncSourceWriteFence(tx, runId);
      const [settings] = await tx.select().from(schema.postClassSettings)
        .limit(1)
        .for("update");
      const currentSnapshot = {
        settingsVersion: settings?.version ?? 1,
        policyVersion: settings?.policyVersion ?? 1,
        mappingVersion: settings?.formMappingVersion ?? 1,
      };
      // This check happens while holding the settings-row lock and before any
      // source, assessment, or deduction write. A concurrent settings update
      // either commits first and conflicts here, or waits until this correctly
      // versioned observation commits.
      assertPostClassObservationSnapshot(observation, currentSnapshot);
      const policyVersion = observation.policyVersion;
      const mappingVersion = observation.mappingVersion;
      const effectiveMode = observation.enforcementMode;
      const enforcementReady =
        effectiveMode === "live" &&
        settings?.enforcementMode !== "paused" &&
        settings?.formMappingValid !== false;
      const assessment = observation.assessment
        ? {
          ...observation.assessment,
          deductionCandidate: observation.assessment.deductionCandidate && enforcementReady,
        }
        : null;
      const latest = latestTeacherVersion(observation.session.feedbackVersions);
      const latestContent = latest ? assessFeedbackContent(latest.fields) : null;
      const deadlineAt = assessment?.deadlineAt ?? calculateFeedbackDeadline(observation.session.scheduledEndAt);
      const rawSession = observation.candidate.rawSession ?? {};
      const recurrenceId = nonEmptyString(nestedValue(rawSession, ["metadata", "recurrenceId"]));
      // Built once and shared by the insert and the conflict update. Keeping
      // two copies in step is exactly how `subject` went unwritten before.
      const sourceMetadata = {
        syncRunId: runId,
        candidateReason: observation.candidate.reason,
        mappingStatus: observation.session.mapping.status,
        mappingVersion,
        settingsVersion: observation.settingsVersion,
        subject: observation.session.subject,
        questionIds: observation.session.questions.map((question) => question.id).filter(Boolean),
      };

      const [session] = await tx.insert(schema.postClassSessions).values({
        wiseSessionId: observation.session.sessionId,
        wiseClassId: observation.session.classId,
        recurrenceId,
        className: observation.session.className,
        canonicalTutorKey: observation.tutor.canonicalKey,
        canonicalTutorName: observation.tutor.displayName,
        wiseTeacherUserId: observation.tutor.wiseTeacherUserId,
        scheduledStartAt: observation.session.scheduledStartAt,
        scheduledEndAt: observation.session.scheduledEndAt,
        deadlineAt,
        finalStatus: observation.session.meetingStatus ?? "UNKNOWN",
        creditsConsumed: observation.session.creditsConsumed ?? 0,
        payableEligible: observation.eligibility.reason === "ended_payout_eligible",
        eligible: observation.eligibility.eligible,
        eligibilityReason: observation.eligibility.reason,
        sourceStatus: observation.sourceStatus,
        // REC-01: a first-hand observation supersedes any run-wide demotion, so
        // the remembered status is discarded rather than restored later. This
        // holds even when the observation itself is 'unavailable': the row was
        // just looked at, and resurrecting a pre-demotion 'ready' without a
        // fresh observation would be exactly the stale projection the
        // fail-closed rule exists to prevent.
        sourceStatusBefore: null,
        contentStatus: assessment?.contentStatus ?? latestContent?.contentStatus ?? "missing",
        timingStatus: assessment?.timingStatus ?? "not_due",
        enforcementMode: effectiveMode,
        policyVersion,
        lastObservedAt: observation.observedAt,
        lastAssessedAt: assessment ? observation.observedAt : null,
        sourceMetadata,
      }).onConflictDoUpdate({
        target: schema.postClassSessions.wiseSessionId,
        set: {
          wiseClassId: observation.session.classId,
          recurrenceId,
          className: observation.session.className,
          canonicalTutorKey: observation.tutor.canonicalKey,
          canonicalTutorName: observation.tutor.displayName,
          wiseTeacherUserId: observation.tutor.wiseTeacherUserId,
          scheduledStartAt: observation.session.scheduledStartAt,
          scheduledEndAt: observation.session.scheduledEndAt,
          deadlineAt,
          finalStatus: observation.session.meetingStatus ?? "UNKNOWN",
          creditsConsumed: observation.session.creditsConsumed ?? 0,
          payableEligible: observation.eligibility.reason === "ended_payout_eligible",
          eligible: observation.eligibility.eligible,
          eligibilityReason: observation.eligibility.reason,
          sourceStatus: observation.sourceStatus,
          sourceStatusBefore: null,
          contentStatus: assessment?.contentStatus ?? latestContent?.contentStatus ?? "missing",
          timingStatus: assessment?.timingStatus ?? "not_due",
          enforcementMode: effectiveMode,
          policyVersion,
          lastObservedAt: observation.observedAt,
          ...(assessment ? { lastAssessedAt: observation.observedAt } : {}),
          sourceMetadata,
          version: sql`${schema.postClassSessions.version} + 1`,
          updatedAt: observation.observedAt,
        },
      }).returning();

      const creditSessionRows = await tx.select({
        wiseStudentId: schema.creditControlSessions.wiseStudentId,
        studentName: schema.creditControlSessions.studentName,
        creditApplied: schema.creditControlSessions.creditApplied,
      }).from(schema.creditControlSessions)
        .innerJoin(
          schema.creditControlSnapshots,
          eq(schema.creditControlSessions.snapshotId, schema.creditControlSnapshots.id),
        )
        .where(and(
          eq(schema.creditControlSnapshots.active, true),
          eq(schema.creditControlSessions.wiseSessionId, session.wiseSessionId),
        ));
      const participantsById = new Map(observation.session.participants.map((participant) => [
        participant.wiseStudentId,
        participant,
      ]));
      const participants = [...participantsById.values()];
      const creditsByStudentId = new Map(
        creditSessionRows.map((row) => [row.wiseStudentId, row.creditApplied]),
      );
      const wiseStudentIds = participants.map((participant) => participant.wiseStudentId);
      const studentRows = wiseStudentIds.length > 0
        ? await tx.select({
          wiseStudentId: schema.creditControlStudents.wiseStudentId,
          studentName: schema.creditControlStudents.studentName,
        }).from(schema.creditControlStudents)
          .innerJoin(
            schema.creditControlSnapshots,
            eq(schema.creditControlStudents.snapshotId, schema.creditControlSnapshots.id),
          )
          .where(and(
            eq(schema.creditControlSnapshots.active, true),
            inArray(schema.creditControlStudents.wiseStudentId, wiseStudentIds),
          ))
        : [];
      const studentNameById = new Map(studentRows.map((row) => [row.wiseStudentId, row.studentName]));

      // Session detail is canonical. Remove participants that disappeared
      // from a later Wise observation instead of retaining a stale union.
      if (observation.session.participantsAuthoritative) {
        await tx.delete(schema.postClassSessionParticipants).where(
          wiseStudentIds.length > 0
            ? and(
              eq(schema.postClassSessionParticipants.sessionId, session.id),
              notInArray(schema.postClassSessionParticipants.participantKey, wiseStudentIds),
            )
            : eq(schema.postClassSessionParticipants.sessionId, session.id),
        );
      }
      for (const participant of participants) {
        const soleParticipant = participants.length === 1;
        const studentName = participant.studentName ??
          studentNameById.get(participant.wiseStudentId) ??
          participant.wiseStudentId;
        const participantCredits = creditsByStudentId.get(participant.wiseStudentId) ??
          (soleParticipant ? observation.session.creditsConsumed ?? 0 : 0);
        await tx.insert(schema.postClassSessionParticipants).values({
          sessionId: session.id,
          participantKey: participant.wiseStudentId,
          wiseStudentId: participant.wiseStudentId,
          studentName,
          creditsConsumed: participantCredits,
          billable: participantCredits > 0 || observation.eligibility.eligible,
          raw: { allocationKnown: creditsByStudentId.has(participant.wiseStudentId) || soleParticipant },
          updatedAt: observation.observedAt,
        }).onConflictDoUpdate({
          target: [
            schema.postClassSessionParticipants.sessionId,
            schema.postClassSessionParticipants.participantKey,
          ],
          set: {
            studentName,
            creditsConsumed: participantCredits,
            billable: participantCredits > 0 || observation.eligibility.eligible,
            raw: { allocationKnown: creditsByStudentId.has(participant.wiseStudentId) || soleParticipant },
            updatedAt: observation.observedAt,
          },
        });
      }

      const uniqueVersions = new Map<string, FeedbackVersion>();
      for (const feedback of observation.feedbackVersionHistory) {
        uniqueVersions.set(versionKey(feedback), feedback);
      }
      const keys = [...uniqueVersions.keys()];
      const existingVersions = keys.length > 0
        ? await tx.select({ versionKey: schema.postClassFeedbackVersions.versionKey })
          .from(schema.postClassFeedbackVersions)
          .where(and(
            eq(schema.postClassFeedbackVersions.sessionId, session.id),
            inArray(schema.postClassFeedbackVersions.versionKey, keys),
          ))
        : [];
      const existingKeys = new Set(existingVersions.map((row) => row.versionKey));
      for (const [key, feedback] of uniqueVersions) {
        const content = assessFeedbackContent(feedback.fields);
        await tx.insert(schema.postClassFeedbackVersions).values({
          sessionId: session.id,
          versionKey: key,
          wiseSubmissionId: feedback.submissionId,
          contentHash: feedback.contentHash,
          // Wise evidence without an explicit teacher profile must remain
          // distinguishable and can never silently become teacher feedback.
          profile: feedback.profile ?? "unknown",
          provenance: feedback.provenance,
          sourceCreatedAt: feedback.sourceCreatedAt,
          sourceTimestampTrustworthy: feedback.sourceTimestampTrustworthy,
          sourceTimestampKind: feedback.sourceTimestampKind ?? "unknown",
          observedAt: feedback.observedAt,
          actorWiseUserId: feedback.actorWiseUserId,
          actorName: feedback.actorName ?? null,
          topics: feedback.fields.topics,
          performance: feedback.fields.performance,
          improvement: feedback.fields.improvement,
          homework: feedback.fields.homework,
          answers: feedback.answers as unknown as Array<Record<string, unknown>>,
          rawCharCount: content.combinedRawCharacterCount,
          substantive: content.contentStatus === "substantive",
          compliant: content.compliant,
          fieldFailures: content.failureReasons,
        }).onConflictDoUpdate({
          target: [
            schema.postClassFeedbackVersions.sessionId,
            schema.postClassFeedbackVersions.versionKey,
          ],
          // Exact source answers/timestamps stay immutable. These are derived
          // projections that may be corrected after a mapping-version update.
          set: {
            ...(feedback.provenance !== "unknown" ? { provenance: feedback.provenance } : {}),
            ...(feedback.actorWiseUserId ? { actorWiseUserId: feedback.actorWiseUserId } : {}),
            ...(feedback.actorName ? { actorName: feedback.actorName } : {}),
            topics: feedback.fields.topics,
            performance: feedback.fields.performance,
            improvement: feedback.fields.improvement,
            homework: feedback.fields.homework,
            rawCharCount: content.combinedRawCharacterCount,
            substantive: content.contentStatus === "substantive",
            compliant: content.compliant,
            fieldFailures: content.failureReasons,
          },
        });
      }

      const storedVersions = await tx.select().from(schema.postClassFeedbackVersions)
        .where(eq(schema.postClassFeedbackVersions.sessionId, session.id));
      const storedByKey = new Map(storedVersions.map((row) => [row.versionKey, row]));
      const latestStored = latest ? storedByKey.get(versionKey(latest)) ?? null : null;
      const onTimeStored = assessment?.onTimeVersionKey
        ? storedByKey.get(assessment.onTimeVersionKey) ?? null
        : null;

      const activityRowIds = observation.events
        .map((event) => event.activityEventRowId)
        .filter((id): id is string => Boolean(id));
      const activityRows = activityRowIds.length > 0
        ? await tx.select({
          id: schema.wiseActivityEvents.id,
          eventId: schema.wiseActivityEvents.eventId,
        }).from(schema.wiseActivityEvents).where(inArray(schema.wiseActivityEvents.id, activityRowIds))
        : [];
      const activityIdByEvent = new Map(activityRows.map((row) => [row.eventId, row.id]));
      for (const event of observation.events) {
        let linkedVersion: (typeof storedVersions)[number] | null = null;
        let confidence: number | null = null;
        const candidates = event.submissionId
          ? storedVersions.filter((row) => row.wiseSubmissionId === event.submissionId)
          : storedVersions.length === 1 ? storedVersions : [];
        const byDistance = candidates
          .map((candidate) => ({
            candidate,
            distance: Math.abs(
              (candidate.sourceCreatedAt ?? candidate.observedAt).getTime() -
              event.eventTimestamp.getTime(),
            ),
          }))
          .filter(({ distance }) => distance <= 5 * 60 * 1000)
          .sort((left, right) => left.distance - right.distance);
        if (byDistance.length === 1 || (
          byDistance.length > 1 && byDistance[0].distance < byDistance[1].distance
        )) {
          linkedVersion = byDistance[0].candidate;
          confidence = event.submissionId ? 0.95 : 0.7;
        }
        await tx.insert(schema.postClassFeedbackEventLinks).values({
          sessionId: session.id,
          feedbackVersionId: linkedVersion?.id ?? null,
          wiseActivityEventId: event.activityEventRowId ?? activityIdByEvent.get(event.eventId) ?? null,
          wiseEventId: event.eventId,
          eventTimestamp: event.eventTimestamp,
          autoSubmitted: event.autoSubmitted,
          linkConfidence: confidence,
        }).onConflictDoUpdate({
          target: [
            schema.postClassFeedbackEventLinks.sessionId,
            schema.postClassFeedbackEventLinks.wiseEventId,
          ],
          set: {
            eventTimestamp: event.eventTimestamp,
            ...(linkedVersion ? { feedbackVersionId: linkedVersion.id } : {}),
            ...(event.activityEventRowId || activityIdByEvent.get(event.eventId)
              ? {
                wiseActivityEventId:
                  event.activityEventRowId ?? activityIdByEvent.get(event.eventId) ?? null,
              }
              : {}),
            ...(typeof event.autoSubmitted === "boolean"
              ? { autoSubmitted: event.autoSubmitted }
              : {}),
            ...(confidence !== null ? { linkConfidence: confidence } : {}),
          },
        });
      }

      let assessmentInserted = false;
      const [existingDeduction] = await tx.select({
        id: schema.postClassDeductions.id,
        status: schema.postClassDeductions.status,
        defaultFinanceMonth: schema.postClassDeductions.defaultFinanceMonth,
        reversalOffsetId: schema.postClassDeductionOffsets.id,
      })
        .from(schema.postClassDeductions)
        .leftJoin(
          schema.postClassDeductionOffsets,
          eq(schema.postClassDeductions.id, schema.postClassDeductionOffsets.deductionId),
        )
        .where(eq(schema.postClassDeductions.sessionId, session.id))
        .limit(1);
      const existingDeductionStatus = projectPostClassDeductionStatus(
        existingDeduction?.status,
        Boolean(existingDeduction?.reversalOffsetId),
      );
      const correctedDefaultFinanceMonth = bangkokMonthStart(observation.session.scheduledEndAt);
      if (
        assessment?.deductionCandidate &&
        existingDeduction?.status === "pending_review" &&
        existingDeduction.defaultFinanceMonth !== correctedDefaultFinanceMonth
      ) {
        await Promise.all([
          tx.update(schema.postClassDeductions).set({
            defaultFinanceMonth: correctedDefaultFinanceMonth,
            version: sql`${schema.postClassDeductions.version} + 1`,
            updatedAt: observation.observedAt,
          }).where(eq(schema.postClassDeductions.id, existingDeduction.id)),
          tx.insert(schema.postClassDeductionActions).values({
            deductionId: existingDeduction.id,
            action: "default_month_corrected",
            fromStatus: "pending_review",
            toStatus: "pending_review",
            amountMinor: 10_000,
            note: "Canonical Wise session end moved to a different Bangkok month.",
            actorEmail: "system:post-class-feedback",
            idempotencyKey: `default-month:${existingDeduction.id}:${runId}`,
            metadata: {
              syncRunId: runId,
              fromMonth: existingDeduction.defaultFinanceMonth,
              toMonth: correctedDefaultFinanceMonth,
              scheduledEndAt: observation.session.scheduledEndAt.toISOString(),
            },
          }),
        ]);
      }
      if (assessment) {
        const key = postClassAssessmentKey({
          syncRunId: runId,
          assessedAt: observation.observedAt,
          wiseSessionId: session.wiseSessionId,
          policyVersion,
          mappingVersion,
          scheduledEndAt: observation.session.scheduledEndAt,
          deadlineAt: assessment.deadlineAt,
          enforcementMode: effectiveMode,
          sourceStatus: assessment.sourceStatus,
          contentStatus: assessment.contentStatus,
          timingStatus: assessment.timingStatus,
          governingVersionKey: assessment.governingVersionKey,
          violation: assessment.violation,
          adjustedCompliant: assessment.adjustedCompliant,
        });
        const inserted = await tx.insert(schema.postClassAssessments).values({
          sessionId: session.id,
          feedbackVersionId: assessment.governingVersionKey
            ? storedByKey.get(assessment.governingVersionKey)?.id ?? null
            : null,
          assessmentKey: key,
          policyVersion,
          mappingVersion,
          sourceStatus: assessment.sourceStatus,
          contentStatus: assessment.contentStatus,
          timingStatus: assessment.timingStatus,
          deductionStatus: existingDeduction
            ? existingDeductionStatus
            : assessment.deductionCandidate ? "pending_review" : "none",
          enforcementMode: effectiveMode,
          assessedAt: observation.observedAt,
          requiredFieldsPassed: assessment.content.failedFields.length === 0,
          combinedRawCharCount: assessment.content.combinedRawCharacterCount,
          fieldFailures: assessment.content.failureReasons,
          objectiveViolation: assessment.violation,
          rawOnTime: assessment.rawOnTimeCompliant,
          adjustedCompliant: assessment.adjustedCompliant,
          remediatedLate: assessment.remediatedLate,
          timingUnknown: assessment.timingStatus === "unknown",
          timingEvidence: timingEvidence(assessment, latest),
          sourceReady: assessment.sourceStatus === "ready" && assessment.assessed,
          details: {
            due: assessment.due,
            policyApplies: assessment.policyApplies,
            scheduledEndAt: observation.session.scheduledEndAt.toISOString(),
            deadlineAt: assessment.deadlineAt.toISOString(),
            governingVersionKey: assessment.governingVersionKey,
            onTimeVersionKey: assessment.onTimeVersionKey,
            onTimeComplianceLocked: assessment.onTimeComplianceLocked,
            timingEvidenceSource: assessment.timingEvidenceSource,
            submitterRoles: assessment.submitterRoles,
            tutorSubmittedAt: assessment.tutorSubmittedAt?.toISOString() ?? null,
          },
        }).onConflictDoNothing({ target: schema.postClassAssessments.assessmentKey }).returning({
          id: schema.postClassAssessments.id,
        });
        assessmentInserted = inserted.length > 0;
      }

      if (assessment?.deductionCandidate) {
        const inserted = await tx.insert(schema.postClassDeductions).values({
          sessionId: session.id,
          status: "pending_review",
          amountMinor: 10_000,
          currency: "THB",
          defaultFinanceMonth: bangkokMonthStart(observation.session.scheduledEndAt),
        }).onConflictDoNothing({ target: schema.postClassDeductions.sessionId }).returning({
          id: schema.postClassDeductions.id,
        });
        if (inserted.length > 0) {
          await tx.insert(schema.postClassDeductionActions).values({
            deductionId: inserted[0].id,
            action: "candidate_created",
            fromStatus: null,
            toStatus: "pending_review",
            amountMinor: 10_000,
            actorEmail: "system:post-class-feedback",
            idempotencyKey: `candidate:${session.wiseSessionId}`,
            metadata: { syncRunId: runId },
          }).onConflictDoNothing({ target: schema.postClassDeductionActions.idempotencyKey });
        }
      }

      const [deduction] = await tx.select({
        status: schema.postClassDeductions.status,
        reversalOffsetId: schema.postClassDeductionOffsets.id,
      })
        .from(schema.postClassDeductions)
        .leftJoin(
          schema.postClassDeductionOffsets,
          eq(schema.postClassDeductions.id, schema.postClassDeductionOffsets.deductionId),
        )
        .where(eq(schema.postClassDeductions.sessionId, session.id))
        .limit(1);
      await tx.update(schema.postClassSessions).set({
        latestFeedbackVersionId: latestStored?.id ?? null,
        firstOnTimeCompliantVersionId:
          session.firstOnTimeCompliantVersionId ?? onTimeStored?.id ?? null,
        deductionStatus: projectPostClassDeductionStatus(
          deduction?.status,
          Boolean(deduction?.reversalOffsetId),
        ),
        contentStatus: assessment?.contentStatus ?? latestContent?.contentStatus ?? "missing",
        timingStatus: assessment?.timingStatus ?? "not_due",
        updatedAt: observation.observedAt,
      }).where(eq(schema.postClassSessions.id, session.id));

      if (observation.sourceStatus === "ready") {
        await tx.update(schema.postClassSourceIssues).set({
          status: "resolved",
          resolvedAt: observation.observedAt,
          resolvedByEmail: "system:post-class-feedback",
        }).where(and(
          eq(schema.postClassSourceIssues.sessionId, session.id),
          eq(schema.postClassSourceIssues.status, "open"),
        ));
      }

      // A session-scoped fingerprint is `{issueType}:{sessionId}:{status}`,
      // where status is whatever Wise returned — so an exact list can only
      // ever cover the statuses someone thought to enumerate. It did not:
      // every one of the 228 missing-session issues in production was
      // `:400` (Wise answers a deleted session with 400 "Session not found!",
      // not 404) while the list named only `:404`, so none of them could ever
      // resolve. Matching the `{issueType}:{sessionId}` stem instead resolves
      // whatever status the issue was raised under.
      //
      // Fingerprints of already-resolved episodes carry a `:resolved:{uuid}`
      // suffix, but the status filter below excludes them.
      const resolvedStems = [
        ...(observation.tutor.status === "resolved"
          ? [`identity_ambiguous:${session.wiseSessionId}`]
          : []),
        ...(observation.eligibility.status !== "ambiguous"
          ? [`billing_evidence_missing:${session.wiseSessionId}`]
          : []),
        `session_not_found:${session.wiseSessionId}`,
        `contract_error:${session.wiseSessionId}`,
        `detail_retry:${session.wiseSessionId}`,
      ];
      await tx.update(schema.postClassSourceIssues).set(
        resolvedPostClassSessionIssueUpdate(session.id, observation.observedAt),
      ).where(and(
        eq(schema.postClassSourceIssues.status, "open"),
        or(
          inArray(schema.postClassSourceIssues.fingerprint, resolvedStems),
          ...resolvedStems.map((stem) => like(schema.postClassSourceIssues.fingerprint, `${stem}:%`)),
        ),
      ));
      if (observation.session.mapping.status === "ready" && settings?.formMappingValid) {
        await tx.update(schema.postClassSourceIssues).set({
          status: "resolved",
          resolvedAt: observation.observedAt,
          resolvedByEmail: "system:post-class-feedback",
          lastSeenAt: observation.observedAt,
        }).where(and(
          eq(schema.postClassSourceIssues.status, "open"),
          eq(schema.postClassSourceIssues.issueType, "form_drift"),
        ));
      }

      return {
        versionsInserted: keys.filter((key) => !existingKeys.has(key)).length,
        assessmentInserted,
      };
    });
  }

  async recordSourceIssue(issue: PostClassSourceIssueInput): Promise<void> {
    await withPostClassTransaction(this.db, async (tx) => {
      await lockPostClassFinance(tx);
      await assertPostClassSyncSourceWriteFence(tx, issue.runId);
      const [session] = issue.sessionId
        ? await tx.select({ id: schema.postClassSessions.id })
          .from(schema.postClassSessions)
          .where(eq(schema.postClassSessions.wiseSessionId, issue.sessionId))
          .limit(1)
        : [];
      const [existing] = await tx.select({
        id: schema.postClassSourceIssues.id,
        status: schema.postClassSourceIssues.status,
      }).from(schema.postClassSourceIssues)
        .where(eq(schema.postClassSourceIssues.fingerprint, issue.fingerprint))
        .limit(1);
      if (existing?.status === "resolved") {
        // Keep the completed outage interval immutable, then reuse the stable
        // base fingerprint for a new open episode.
        await tx.update(schema.postClassSourceIssues).set({
          fingerprint: `${issue.fingerprint}:resolved:${existing.id}`,
        }).where(and(
          eq(schema.postClassSourceIssues.id, existing.id),
          eq(schema.postClassSourceIssues.status, "resolved"),
        ));
      }
      await tx.insert(schema.postClassSourceIssues).values({
        syncRunId: issue.runId,
        sessionId: session?.id ?? null,
        scope: issue.scope,
        issueType: issue.issueType,
        severity: issue.severity,
        status: "open",
        fingerprint: issue.fingerprint,
        blocksEnforcement: issue.blocksEnforcement,
        message: issue.message,
        details: { ...(issue.details ?? {}), baseFingerprint: issue.fingerprint },
        firstSeenAt: issue.observedAt,
        lastSeenAt: issue.observedAt,
      }).onConflictDoUpdate({
        target: schema.postClassSourceIssues.fingerprint,
        set: {
          syncRunId: issue.runId,
          ...(session?.id ? { sessionId: session.id } : {}),
          status: "open",
          severity: issue.severity,
          blocksEnforcement: issue.blocksEnforcement,
          message: issue.message,
          details: { ...(issue.details ?? {}), baseFingerprint: issue.fingerprint },
          lastSeenAt: issue.observedAt,
          resolvedAt: null,
          resolvedByEmail: null,
        },
      });
      if (issue.scope === "global") {
        // REC-01: the run-wide demotion stays exactly as fail-closed as it was
        // — every eligible row goes to 'unavailable' the instant source health
        // cannot be proven. What is new is that each row remembers what it
        // carried, so `completeSync` can restore them all in one statement
        // instead of one row per Wise detail fetch.
        //
        // `coalesce` keeps the FIRST demotion's value when a second global
        // issue lands before recovery; without it the original status would be
        // overwritten by the 'unavailable' this very statement is writing.
        await tx.update(schema.postClassSessions).set({
          sourceStatusBefore: sql`coalesce(${schema.postClassSessions.sourceStatusBefore}, ${schema.postClassSessions.sourceStatus})`,
          sourceStatus: "unavailable",
          updatedAt: issue.observedAt,
        }).where(eq(schema.postClassSessions.eligible, true));
      } else if (session?.id) {
        await tx.update(schema.postClassSessions).set({
          sourceStatus: postClassSourceStatusForIssue(issue),
          updatedAt: issue.observedAt,
        }).where(eq(schema.postClassSessions.id, session.id));
      }
    });
  }

  async pauseForFormDrift(input: { runId: string; observedAt: Date; reason: string }): Promise<void> {
    await withPostClassTransaction(this.db, async (tx) => {
      await lockPostClassFinance(tx);
      await assertPostClassSyncSourceWriteFence(tx, input.runId);
      const [current] = await tx.select().from(schema.postClassSettings).limit(1);
      if (!current || (current.enforcementMode === "paused" && !current.formMappingValid)) return;
      if (current.currentWindowId) {
        await tx.update(schema.postClassEnforcementWindows).set({
          endsAt: input.observedAt,
        }).where(and(
          eq(schema.postClassEnforcementWindows.id, current.currentWindowId),
          isNull(schema.postClassEnforcementWindows.endsAt),
        ));
      }
      const [window] = await tx.insert(schema.postClassEnforcementWindows).values({
        mode: "paused",
        startsAt: input.observedAt,
        policyEffectiveAt: current.policyEffectiveAt,
        actorEmail: "system:post-class-feedback",
        reason: input.reason,
      }).returning({ id: schema.postClassEnforcementWindows.id });
      await Promise.all([
        tx.update(schema.postClassSettings).set({
          enforcementMode: "paused",
          currentWindowId: window.id,
          formMappingValid: false,
          version: current.version + 1,
          updatedByEmail: "system:post-class-feedback",
          updatedAt: input.observedAt,
        }).where(eq(schema.postClassSettings.id, current.id)),
        tx.insert(schema.postClassConfigAuditLog).values({
          entityType: "settings",
          entityKey: "default",
          action: "auto_pause_form_drift",
          actorEmail: "system:post-class-feedback",
          beforeValue: {
            enforcementMode: current.enforcementMode,
            formMappingValid: current.formMappingValid,
          },
          afterValue: { enforcementMode: "paused", formMappingValid: false },
          note: input.reason,
        }),
      ]);
    });
  }
}

export function createDrizzlePostClassFeedbackRepository(
  db: Database,
): PostClassFeedbackRepository {
  return new DrizzlePostClassFeedbackRepository(db);
}

export async function resolvePostClassCanonicalTutor(
  db: Database,
  input: {
    candidate: PostClassSessionCandidate;
    detail: WiseSessionDetail;
  },
): Promise<CanonicalTutorResolution> {
  const raw = input.candidate.rawSession ?? {};
  const identifiers = [...new Set([
    getWiseSessionTeacherUserId(input.detail),
    nonEmptyString(input.detail.teacherId),
    getWiseUserId(input.detail.userId),
    nonEmptyString(raw.teacherId),
    nonEmptyString(nestedValue(raw, ["userId", "_id"])),
    nonEmptyString(raw.userId),
  ].filter((value): value is string => Boolean(value)))];
  if (identifiers.length === 0) {
    return { status: "ambiguous", canonicalKey: null, displayName: null, wiseTeacherUserId: null };
  }
  const matches = await db.select({
    groupId: schema.tutorIdentityGroups.id,
    canonicalKey: schema.tutorIdentityGroups.canonicalKey,
    displayName: schema.tutorIdentityGroups.displayName,
    wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
  }).from(schema.tutorIdentityGroupMembers)
    .innerJoin(
      schema.tutorIdentityGroups,
      eq(schema.tutorIdentityGroupMembers.groupId, schema.tutorIdentityGroups.id),
    )
    .innerJoin(schema.snapshots, eq(schema.tutorIdentityGroups.snapshotId, schema.snapshots.id))
    .where(and(
      eq(schema.snapshots.active, true),
      or(
        inArray(schema.tutorIdentityGroupMembers.wiseUserId, identifiers),
        inArray(schema.tutorIdentityGroupMembers.wiseTeacherId, identifiers),
      ),
    ));
  const groups = new Map(matches.map((match) => [match.groupId, match]));
  if (groups.size !== 1) {
    return {
      status: "ambiguous",
      canonicalKey: null,
      displayName: null,
      wiseTeacherUserId: matches.find((match) => match.wiseUserId)?.wiseUserId ?? identifiers[0],
    };
  }
  const match = [...groups.values()][0];
  const members = await db.select({
    online: schema.tutorIdentityGroupMembers.isOnlineVariant,
  }).from(schema.tutorIdentityGroupMembers).where(eq(
    schema.tutorIdentityGroupMembers.groupId,
    match.groupId,
  ));
  const validIdentity = members.length === 1 || (
    members.length === 2 &&
    members.filter((member) => member.online).length === 1
  );
  return {
    status: validIdentity ? "resolved" : "ambiguous",
    canonicalKey: validIdentity ? match.canonicalKey : null,
    displayName: validIdentity ? match.displayName : null,
    wiseTeacherUserId: match.wiseUserId ?? identifiers[0],
  };
}

export async function resolvePostClassPayoutEligibility(
  db: Database,
  candidate: PostClassSessionCandidate,
): Promise<boolean | null> {
  const [invoice] = await db.select({ id: schema.payrollPayoutInvoices.id })
    .from(schema.payrollPayoutInvoices)
    .where(and(
      eq(schema.payrollPayoutInvoices.wiseSessionId, candidate.sessionId),
      or(
        gt(schema.payrollPayoutInvoices.sessionCredits, 0),
        gt(schema.payrollPayoutInvoices.amount, 0),
      ),
    ))
    .limit(1);
  // This resolver asks whether an existing payable invoice is present. Its
  // absence is a negative result; only missing credit evidence remains
  // ambiguous in the eligibility policy.
  return Boolean(invoice);
}
