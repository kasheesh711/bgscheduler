import "server-only";

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { applyPostClassReviewAction } from "./actions";
import { hasWrittenPayoutDeduction } from "./payout-repository";
import {
  calculateFeedbackDeadline,
  deriveEventTimingEvidence,
  evaluateSessionCompliance,
} from "./policy";
import { createDrizzlePostClassFeedbackRepository } from "./repository";
import type { PostClassFeedbackRepository } from "./repository";
import type { TimingStatus } from "./types";

// ── Reassess persisted evidence ─────────────────────────────────────────
//
// A policy change can invalidate verdicts already written against evidence we
// still hold. Replaying those sessions through the collector is the wrong
// instrument: it is capped at 50 Wise detail fetches per run, and it would
// re-derive identity, participants, and content from Wise for sessions whose
// source answers are already preserved immutably here.
//
// Everything the timing rule consumes is persisted — `post_class_feedback_
// versions` (whose `observed_at` and source timestamps are excluded from the
// upsert precisely so they stay immutable) and the `wise_activity_events`
// mirror. This pass re-runs the same pure functions the collector runs over
// that stored evidence, with zero Wise traffic.
//
// It is deliberately verdict-only. It writes an assessment row and the session's
// timing projection; it never rewrites identity, eligibility, participants, or
// content, because it has no fresher evidence for any of them than the row
// already carries.

/**
 * System actor for the unattended waive a cleared violation implies. Mirrors
 * `auto-approval.ts` — every money transition still goes through
 * `applyPostClassReviewAction`, so the audit row is the same shape a human
 * reviewer produces.
 */
const SYSTEM_ACTOR = {
  email: "system:post-class-reassess",
  name: "Post-class Reassessment",
};

export interface PostClassReassessOutcome {
  wiseSessionId: string;
  canonicalTutorName: string | null;
  deadlineAt: Date;
  from: TimingStatus;
  to: TimingStatus;
  changed: boolean;
  provenAt: Date | null;
  deductionWaived: boolean;
}

export interface PostClassReassessResult {
  scanned: number;
  changed: number;
  deductionsWaived: number;
  failed: number;
  outcomes: PostClassReassessOutcome[];
}

/**
 * Re-evaluate stored sessions against the current timing policy.
 *
 * @param options.timingStatuses Which verdicts to revisit. Defaults to `late`,
 *   the only verdict a widened qualifying rule can overturn.
 * @param options.wiseSessionIds Restrict to specific Wise sessions — used to
 *   rehearse the pass on one session before running it over the backlog.
 * @param options.limit Bound the batch. Absent means every matching session.
 * @param options.apply When false, compute and report every verdict change
 *   without writing anything.
 */
export async function reassessPostClassSessions(options: {
  timingStatuses?: TimingStatus[];
  wiseSessionIds?: string[];
  limit?: number;
  apply?: boolean;
  now?: Date;
  db?: Database;
  repository?: PostClassFeedbackRepository;
} = {}): Promise<PostClassReassessResult> {
  const db = options.db ?? getDb();
  const repository = options.repository ?? createDrizzlePostClassFeedbackRepository(db);
  const now = options.now ?? new Date();
  const apply = options.apply ?? true;
  const timingStatuses = options.timingStatuses ?? ["late"];

  // Only eligible, source-ready sessions carry an enforceable verdict; every
  // other row is already outside the assessed denominator, so re-deciding it
  // would change a number nobody reads.
  const rows = await db.select({
    id: schema.postClassSessions.id,
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    canonicalTutorName: schema.postClassSessions.canonicalTutorName,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    timingStatus: schema.postClassSessions.timingStatus,
  }).from(schema.postClassSessions)
    .where(and(
      eq(schema.postClassSessions.eligible, true),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      isNull(schema.postClassSessions.wiseDeletedAt),
      inArray(schema.postClassSessions.timingStatus, timingStatuses),
      ...(options.wiseSessionIds?.length
        ? [inArray(schema.postClassSessions.wiseSessionId, options.wiseSessionIds)]
        : []),
    ))
    .orderBy(schema.postClassSessions.scheduledEndAt)
    .limit(options.limit ?? Number.MAX_SAFE_INTEGER);

  const [policy, eventCoverageFrom] = await Promise.all([
    repository.loadPolicyContext(),
    repository.loadFeedbackEventCoverageFloor(),
  ]);

  const result: PostClassReassessResult = {
    scanned: 0,
    changed: 0,
    deductionsWaived: 0,
    failed: 0,
    outcomes: [],
  };

  for (const row of rows) {
    result.scanned += 1;
    try {
      const [versions, events, enforcement] = await Promise.all([
        repository.loadHistoricalFeedbackVersions(row.wiseSessionId),
        repository.loadFeedbackEvents(row.wiseSessionId),
        repository.loadSessionEnforcementContext(row.scheduledEndAt),
      ]);
      const deadlineAt = calculateFeedbackDeadline(row.scheduledEndAt);
      const eventTiming = deriveEventTimingEvidence({ events, deadlineAt, eventCoverageFrom });
      // The previous lock is deliberately not loaded. A violation lock was
      // written by the rule this pass exists to correct, and feeding it back in
      // would pin the very verdict being re-decided; a genuine on-time lock is
      // re-derived from the same evidence anyway.
      const assessment = evaluateSessionCompliance({
        sourceStatus: "ready",
        scheduledEndAt: row.scheduledEndAt,
        now,
        versions,
        enforcementMode: enforcement.enforcementMode,
        policyEffectiveAt: enforcement.policyEffectiveAt,
        policyVersion: policy.policyVersion,
        mappingVersion: policy.mappingVersion,
        previousOnTimeLock: null,
        eventTiming,
      });

      const changed = assessment.timingStatus !== row.timingStatus;
      let deductionWaived = false;
      if (changed && apply) {
        await writeReassessedVerdict(db, {
          sessionId: row.id,
          wiseSessionId: row.wiseSessionId,
          scheduledEndAt: row.scheduledEndAt,
          policyVersion: policy.policyVersion,
          mappingVersion: policy.mappingVersion,
          enforcementMode: enforcement.enforcementMode,
          assessment,
          assessedAt: now,
        });
      }
      if (changed && apply && !assessment.violation) {
        deductionWaived = await waiveClearedDeduction(db, row.id, row.wiseSessionId);
        if (deductionWaived) result.deductionsWaived += 1;
      }

      if (changed) result.changed += 1;
      result.outcomes.push({
        wiseSessionId: row.wiseSessionId,
        canonicalTutorName: row.canonicalTutorName,
        deadlineAt,
        from: row.timingStatus,
        to: assessment.timingStatus,
        changed,
        provenAt: assessment.tutorSubmittedAt,
        deductionWaived,
      });
    } catch (error) {
      result.failed += 1;
      console.error("[post-class-reassess]", row.wiseSessionId, error);
    }
  }

  return result;
}

/**
 * Persist one re-decided verdict: an immutable assessment row plus the
 * session's timing projection.
 *
 * The assessment key carries `reassess:` rather than a sync-run id, because no
 * sync run observed this — the row records a re-decision over evidence already
 * held, and the prefix keeps it distinguishable in the audit trail forever.
 */
async function writeReassessedVerdict(
  db: Database,
  input: {
    sessionId: string;
    wiseSessionId: string;
    scheduledEndAt: Date;
    policyVersion: number;
    mappingVersion: number;
    enforcementMode: "shadow" | "live" | "paused";
    assessment: Awaited<ReturnType<typeof evaluateSessionCompliance>>;
    assessedAt: Date;
  },
): Promise<void> {
  const { assessment } = input;
  await db.insert(schema.postClassAssessments).values({
    sessionId: input.sessionId,
    feedbackVersionId: null,
    assessmentKey: [
      "reassess",
      input.wiseSessionId,
      input.policyVersion,
      input.mappingVersion,
      assessment.deadlineAt.toISOString(),
      assessment.timingStatus,
      input.assessedAt.toISOString(),
    ].join(":"),
    policyVersion: input.policyVersion,
    mappingVersion: input.mappingVersion,
    sourceStatus: assessment.sourceStatus,
    contentStatus: assessment.contentStatus,
    timingStatus: assessment.timingStatus,
    deductionStatus: "none",
    enforcementMode: input.enforcementMode,
    assessedAt: input.assessedAt,
    requiredFieldsPassed: assessment.content.failedFields.length === 0,
    combinedRawCharCount: assessment.content.combinedRawCharacterCount,
    fieldFailures: assessment.content.failureReasons,
    objectiveViolation: assessment.violation,
    rawOnTime: assessment.rawOnTimeCompliant,
    adjustedCompliant: assessment.adjustedCompliant,
    remediatedLate: assessment.remediatedLate,
    timingUnknown: assessment.timingStatus === "unknown",
    timingEvidence: assessment.timingEvidenceSource === "activity_event"
      ? assessment.timingStatus === "on_time"
        ? "wise_activity_event_before_deadline"
        : "wise_activity_event_no_tutor_submission"
      : "observed_state",
    sourceReady: assessment.sourceStatus === "ready" && assessment.assessed,
    details: {
      due: assessment.due,
      reassessed: true,
      policyApplies: assessment.policyApplies,
      scheduledEndAt: input.scheduledEndAt.toISOString(),
      deadlineAt: assessment.deadlineAt.toISOString(),
      governingVersionKey: assessment.governingVersionKey,
      onTimeVersionKey: assessment.onTimeVersionKey,
      onTimeComplianceLocked: assessment.onTimeComplianceLocked,
      timingEvidenceSource: assessment.timingEvidenceSource,
      submitterRoles: assessment.submitterRoles,
      tutorSubmittedAt: assessment.tutorSubmittedAt?.toISOString() ?? null,
    },
  }).onConflictDoNothing({ target: schema.postClassAssessments.assessmentKey });

  await db.update(schema.postClassSessions).set({
    timingStatus: assessment.timingStatus,
    lastAssessedAt: input.assessedAt,
    updatedAt: input.assessedAt,
  }).where(eq(schema.postClassSessions.id, input.sessionId));
}

/**
 * Waive the open deduction on a session whose violation the reassessment
 * cleared.
 *
 * Waive rather than delete: the deduction was a real decision made on the
 * evidence available at the time, and the audit trail should say it was
 * withdrawn and why. A deduction already written to a payout ledger is left
 * alone — unwinding money that has moved is Finance's reversal path, not this
 * pass's.
 */
async function waiveClearedDeduction(
  db: Database,
  sessionId: string,
  wiseSessionId: string,
): Promise<boolean> {
  const [deduction] = await db.select({
    id: schema.postClassDeductions.id,
    version: schema.postClassDeductions.version,
  }).from(schema.postClassDeductions)
    .where(and(
      eq(schema.postClassDeductions.sessionId, sessionId),
      or(
        eq(schema.postClassDeductions.status, "pending_review"),
        eq(schema.postClassDeductions.status, "approved"),
      ),
    ))
    .limit(1);
  if (!deduction) return false;
  if (await hasWrittenPayoutDeduction(db, deduction.id)) return false;

  await applyPostClassReviewAction(SYSTEM_ACTOR, {
    deductionId: deduction.id,
    action: "waive",
    waiverCategory: "incorrect_session_tutor_data",
    note: "Reassessment proved a qualifying Wise submission event at or before the deadline.",
    expectedVersion: deduction.version,
    idempotencyKey: `reassess-waive:${wiseSessionId}`,
  }, db);
  return true;
}
