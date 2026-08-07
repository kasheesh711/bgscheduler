import { and, asc, desc, eq, or } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import type { PostClassUser } from "./access";
import { PostClassNotFoundError } from "./errors";
import { feedbackSubmitterRole } from "./policy";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a Wise feedback event did or did not prove the submission on time.
 *
 * Mirrors `deriveEventTimingEvidence` so the dialog and the policy cannot
 * drift: an auto-submission never qualifies, and a qualifying event only
 * proves compliance when it lands at or before the deadline.
 */
export function eventProofOutcome(
  event: { eventTimestamp: Date; actorRole: string | null; payload: Record<string, unknown> },
  deadlineAt: Date,
): { countedAsProof: boolean; reason: "auto_submitted" | "after_deadline" | null } {
  const autoSubmitted = autoSubmittedFlag(event.payload);
  const role = feedbackSubmitterRole({
    eventId: "",
    sessionId: "",
    eventTimestamp: event.eventTimestamp,
    autoSubmitted,
    actorWiseUserId: null,
    actorName: null,
    actorRole: event.actorRole,
  });
  if (role === "AUTO") return { countedAsProof: false, reason: "auto_submitted" };
  if (event.eventTimestamp.getTime() > deadlineAt.getTime()) {
    return { countedAsProof: false, reason: "after_deadline" };
  }
  return { countedAsProof: true, reason: null };
}

/** Wise carries the auto-submission flag at `payload.session.autoSubmitted`. */
function autoSubmittedFlag(payload: Record<string, unknown>): boolean | null {
  const session = asRecord(payload.session);
  const value = session.autoSubmitted;
  return typeof value === "boolean" ? value : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function fieldMeaningful(failures: string[], field: string, text: string): boolean {
  return Boolean(text.trim()) && !failures.some((failure) => failure.toLowerCase().includes(field));
}

/** Keep the lossless Wise value while exposing an exact text projection for display. */
export function serializePostClassFeedbackAnswer(value: unknown) {
  const answer = asRecord(value);
  const rawValue = Object.prototype.hasOwnProperty.call(answer, "rawAnswer")
    ? answer.rawAnswer
    : answer.answer ?? null;
  const rawAnswer = rawValue === undefined ? null : rawValue;
  return {
    id: nullableString(answer.id),
    questionId: nullableString(answer.questionId),
    questionText: nullableString(answer.questionText),
    type: nullableString(answer.type),
    text: typeof answer.answer === "string"
      ? answer.answer
      : typeof rawAnswer === "string" ? rawAnswer : "",
    rawAnswer,
  };
}

/**
 * Load one session's full evidence record.
 *
 * `identifier` accepts either our internal UUID or the Wise session id, so an
 * admin holding only a Wise id from a Wise screen can open the same record
 * without a database round trip. The UUID branch is guarded by a pattern test
 * because Postgres rejects a non-UUID literal against a `uuid` column outright.
 */
export async function getPostClassFeedbackSessionDetail(
  identifier: string,
  user: PostClassUser,
  db: Database = getDb(),
) {
  const [session] = await db.select().from(schema.postClassSessions)
    .where(UUID_PATTERN.test(identifier)
      ? or(
        eq(schema.postClassSessions.id, identifier),
        eq(schema.postClassSessions.wiseSessionId, identifier),
      )
      : eq(schema.postClassSessions.wiseSessionId, identifier))
    .limit(1);
  if (!session) throw new PostClassNotFoundError("Post-class feedback session was not found.");
  const sessionId = session.id;

  const [participants, versions, assessments, eventLinks, feedbackEvents, notificationItems, aiRows, sourceIssues] = await Promise.all([
    db.select().from(schema.postClassSessionParticipants)
      .where(eq(schema.postClassSessionParticipants.sessionId, sessionId))
      .orderBy(asc(schema.postClassSessionParticipants.studentName)),
    db.select().from(schema.postClassFeedbackVersions)
      .where(eq(schema.postClassFeedbackVersions.sessionId, sessionId))
      .orderBy(desc(schema.postClassFeedbackVersions.observedAt)),
    db.select().from(schema.postClassAssessments)
      .where(eq(schema.postClassAssessments.sessionId, sessionId))
      .orderBy(
        desc(schema.postClassAssessments.assessedAt),
        desc(schema.postClassAssessments.createdAt),
      ),
    db.select().from(schema.postClassFeedbackEventLinks)
      .where(eq(schema.postClassFeedbackEventLinks.sessionId, sessionId))
      .orderBy(desc(schema.postClassFeedbackEventLinks.eventTimestamp)),
    // Read the activity mirror directly rather than through the link table:
    // this is the exact evidence set `deriveEventTimingEvidence` consumes
    // (`repository.loadFeedbackEvents`), so the timeline shows what actually
    // decided the verdict, including events the parser could not bind to a
    // submission.
    db.select({
      id: schema.wiseActivityEvents.id,
      eventId: schema.wiseActivityEvents.eventId,
      eventTimestamp: schema.wiseActivityEvents.eventTimestamp,
      actorWiseUserId: schema.wiseActivityEvents.actorWiseUserId,
      actorName: schema.wiseActivityEvents.actorName,
      actorRole: schema.wiseActivityEvents.actorRole,
      payload: schema.wiseActivityEvents.payload,
    }).from(schema.wiseActivityEvents).where(and(
      eq(schema.wiseActivityEvents.sessionId, session.wiseSessionId),
      eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
    )).orderBy(asc(schema.wiseActivityEvents.eventTimestamp)),
    db.select({
      item: schema.postClassNotificationItems,
      delivery: schema.postClassNotificationDeliveries,
      run: schema.postClassNotificationRuns,
    }).from(schema.postClassNotificationItems)
      .innerJoin(schema.postClassNotificationDeliveries, eq(schema.postClassNotificationItems.deliveryId, schema.postClassNotificationDeliveries.id))
      .innerJoin(schema.postClassNotificationRuns, eq(schema.postClassNotificationDeliveries.runId, schema.postClassNotificationRuns.id))
      .where(eq(schema.postClassNotificationItems.sessionId, sessionId))
      .orderBy(desc(schema.postClassNotificationDeliveries.createdAt)),
    db.select({
      run: schema.postClassAiRuns,
      concern: schema.postClassAiConcerns,
    }).from(schema.postClassAiRuns)
      .leftJoin(schema.postClassAiConcerns, eq(schema.postClassAiRuns.id, schema.postClassAiConcerns.runId))
      .where(eq(schema.postClassAiRuns.sessionId, sessionId))
      .orderBy(desc(schema.postClassAiRuns.createdAt)),
    db.select().from(schema.postClassSourceIssues)
      .where(or(
        eq(schema.postClassSourceIssues.sessionId, sessionId),
        eq(schema.postClassSourceIssues.scope, "global"),
      ))
      .orderBy(desc(schema.postClassSourceIssues.lastSeenAt)),
  ]);

  const canReview = user.capabilities.includes("reviewer");
  const canFinance = user.capabilities.includes("finance");
  const [deduction] = canReview || canFinance
    ? await db.select().from(schema.postClassDeductions)
      .where(eq(schema.postClassDeductions.sessionId, sessionId)).limit(1)
    : [];
  const deductionActions = deduction && canFinance
    ? await db.select().from(schema.postClassDeductionActions)
      .where(eq(schema.postClassDeductionActions.deductionId, deduction.id))
      .orderBy(desc(schema.postClassDeductionActions.occurredAt))
    : [];
  const [offset] = deduction && (canReview || canFinance)
    ? await db.select().from(schema.postClassDeductionOffsets)
      .where(eq(schema.postClassDeductionOffsets.deductionId, deduction.id)).limit(1)
    : [];

  return {
    session: {
      id: session.id,
      wiseSessionId: session.wiseSessionId,
      wiseClassId: session.wiseClassId,
      recurrenceId: session.recurrenceId,
      className: session.className,
      canonicalTutorKey: session.canonicalTutorKey,
      canonicalTutorName: session.canonicalTutorName,
      wiseTeacherUserId: session.wiseTeacherUserId,
      scheduledStartAt: session.scheduledStartAt.toISOString(),
      scheduledEndAt: session.scheduledEndAt.toISOString(),
      deadlineAt: session.deadlineAt.toISOString(),
      finalStatus: session.finalStatus,
      creditsConsumed: session.creditsConsumed,
      payableEligible: session.payableEligible,
      eligible: session.eligible,
      eligibilityReason: session.eligibilityReason,
      sourceStatus: session.sourceStatus,
      contentStatus: session.contentStatus,
      timingStatus: session.timingStatus,
      latestFeedbackVersionId: session.latestFeedbackVersionId,
      firstOnTimeCompliantVersionId: session.firstOnTimeCompliantVersionId,
      enforcementMode: session.enforcementMode,
      policyVersion: session.policyVersion,
      lastObservedAt: iso(session.lastObservedAt),
      lastAssessedAt: iso(session.lastAssessedAt),
    },
    participants: participants.map((participant) => ({
      id: participant.id,
      participantKey: participant.participantKey,
      wiseStudentId: participant.wiseStudentId,
      studentName: participant.studentName,
      creditsConsumed: participant.creditsConsumed,
      billable: participant.billable,
    })),
    evidence: {
      versions: versions.map((version) => ({
        // Exact source answers and timestamps are returned only from the
        // authenticated detail endpoint and are never written to logs.
        id: version.id,
        submissionId: version.wiseSubmissionId,
        contentHash: version.contentHash,
        profile: version.profile,
        provenance: version.provenance,
        submittedAt: iso(version.sourceCreatedAt),
        sourceTimestampTrustworthy: version.sourceTimestampTrustworthy,
        sourceTimestampKind: version.sourceTimestampKind === "created" || version.sourceTimestampKind === "updated"
          ? version.sourceTimestampKind
          : "unknown" as const,
        observedAt: version.observedAt.toISOString(),
        actorWiseUserId: version.actorWiseUserId,
        actorName: version.actorName,
        answers: (version.answers ?? []).map(serializePostClassFeedbackAnswer),
        required: {
          topics: {
            text: version.topics,
            characters: codePointLength(version.topics),
            meaningful: fieldMeaningful(version.fieldFailures, "topic", version.topics),
          },
          performance: {
            text: version.performance,
            characters: codePointLength(version.performance),
            meaningful: fieldMeaningful(version.fieldFailures, "performance", version.performance),
          },
          improvement: {
            text: version.improvement,
            characters: codePointLength(version.improvement),
            meaningful: fieldMeaningful(version.fieldFailures, "improvement", version.improvement),
          },
        },
        homework: version.homework,
        combinedCharacterCount: version.rawCharCount,
        substantive: version.substantive,
        compliant: version.compliant,
        fieldFailures: version.fieldFailures,
      })),
      eventAssociations: eventLinks.map((event) => ({
        id: event.id,
        feedbackVersionId: event.feedbackVersionId,
        wiseActivityEventId: event.wiseActivityEventId,
        wiseEventId: event.wiseEventId,
        eventTimestamp: event.eventTimestamp.toISOString(),
        autoSubmitted: event.autoSubmitted,
        linkConfidence: event.linkConfidence,
      })),
      // Every Wise feedback-submission event for this session, with the actor
      // Wise recorded and whether it proved the submission on time. The actor
      // role is audit detail only — since D-EVT-04 it no longer gates the
      // verdict, because Wise stamps the account's role rather than authorship.
      feedbackEvents: feedbackEvents.map((event) => {
        const outcome = eventProofOutcome(event, session.deadlineAt);
        return {
          id: event.id,
          wiseEventId: event.eventId,
          eventTimestamp: event.eventTimestamp.toISOString(),
          actorWiseUserId: event.actorWiseUserId,
          actorName: event.actorName,
          actorRole: event.actorRole,
          autoSubmitted: autoSubmittedFlag(event.payload),
          isSessionTutor: Boolean(
            event.actorWiseUserId &&
            session.wiseTeacherUserId &&
            event.actorWiseUserId === session.wiseTeacherUserId,
          ),
          countedAsProof: outcome.countedAsProof,
          notCountedReason: outcome.reason,
        };
      }),
    },
    assessments: assessments.map((assessment) => ({
      id: assessment.id,
      feedbackVersionId: assessment.feedbackVersionId,
      policyVersion: assessment.policyVersion,
      mappingVersion: assessment.mappingVersion,
      sourceStatus: assessment.sourceStatus,
      contentStatus: assessment.contentStatus,
      timingStatus: assessment.timingStatus,
      deductionStatus: assessment.deductionStatus,
      enforcementMode: assessment.enforcementMode,
      assessedAt: assessment.assessedAt.toISOString(),
      requiredFieldsPassed: assessment.requiredFieldsPassed,
      combinedRawCharCount: assessment.combinedRawCharCount,
      fieldFailures: assessment.fieldFailures,
      objectiveViolation: assessment.objectiveViolation,
      rawOnTime: assessment.rawOnTime,
      adjustedCompliant: assessment.adjustedCompliant,
      remediatedLate: assessment.remediatedLate,
      timingUnknown: assessment.timingUnknown,
      timingEvidence: assessment.timingEvidence,
      sourceReady: assessment.sourceReady,
    })),
    sourceIssues: sourceIssues.map((issue) => ({
      id: issue.id,
      scope: issue.scope,
      issueType: issue.issueType,
      severity: issue.severity,
      status: issue.status,
      blocksEnforcement: issue.blocksEnforcement,
      message: issue.message,
      firstSeenAt: issue.firstSeenAt.toISOString(),
      lastSeenAt: issue.lastSeenAt.toISOString(),
      resolvedAt: iso(issue.resolvedAt),
      resolvedByEmail: issue.resolvedByEmail,
    })),
    reminders: notificationItems,
    ai: canReview ? aiRows : [],
    review: canReview && deduction ? {
      id: deduction.id,
      status: offset ? "reversed" : deduction.status,
      amountMinor: deduction.amountMinor,
      waiverCategory: deduction.waiverCategory,
      waiverNote: deduction.waiverNote,
      decisionByEmail: deduction.decisionByEmail,
      decisionAt: iso(deduction.decisionAt),
      version: deduction.version,
    } : null,
    finance: canFinance && deduction ? {
      id: deduction.id,
      status: deduction.status,
      amountMinor: deduction.amountMinor,
      defaultFinanceMonth: deduction.defaultFinanceMonth,
      financePeriodId: deduction.financePeriodId,
      processingReference: deduction.processingReference,
      processedByEmail: deduction.processedByEmail,
      processedAt: deduction.processedAt,
      version: deduction.version,
      actions: deductionActions,
      offset: offset ?? null,
    } : null,
  };
}
