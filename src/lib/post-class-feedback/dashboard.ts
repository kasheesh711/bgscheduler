import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  addBangkokDays,
  bangkokDateStartUtc,
  endOfBangkokMonth,
  monthStart,
  todayBangkok,
} from "@/lib/room-capacity/dates";

import {
  hasDriveFileScope,
  hasSheetsWriteScope,
} from "@/lib/sales-dashboard/google-oauth";

import type { FeedbackSubmitter } from "@/types/post-class-feedback";

import { PostClassValidationError } from "./errors";
import { payoutConnectedEmail } from "./payout-config";
import {
  isPostClassTerminalReminderFailure,
  isPostClassAssessmentInDenominator,
  postClassSourceIssueCrossedDeadline,
  rankPostClassTutorMetrics,
} from "./metrics";

type Capability = "viewer" | "reviewer" | "finance" | "access_manager";

export interface PostClassDashboardUser {
  email: string;
  name: string;
  capabilities: Capability[];
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function bangkokBucket(value: Date, granularity: "week" | "month"): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
  if (granularity === "month") return date.slice(0, 7);
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const daysFromMonday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - daysFromMonday);
  return utc.toISOString().slice(0, 10);
}

function validateDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PostClassValidationError(`${label} is invalid.`);
  return value;
}

export function defaultPostClassFeedbackRange(now = new Date()) {
  const today = todayBangkok(now);
  return { startDate: monthStart(today), endDate: endOfBangkokMonth(today) };
}

/**
 * Collapse the roles observed on a session's feedback activity events into a
 * single display value, worst-to-best: a tutor submission of their own is the
 * only outcome that reflects the tutor doing the work.
 */
function submitterFromAssessment(details: unknown): FeedbackSubmitter {
  const roles = details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>).submitterRoles
    : null;
  if (!Array.isArray(roles) || roles.length === 0) return "none";
  if (roles.includes("TEACHER")) return "tutor";
  if (roles.includes("ADMIN")) return "admin";
  if (roles.includes("AUTO")) return "auto";
  return "other";
}

function fieldMeaningful(failures: string[], key: string, text: string): boolean {
  if (!text.trim()) return false;
  return !failures.some((failure) => failure.toLowerCase().includes(key));
}

function wiseSessionUrl(classId: string, sessionId: string, metadata: Record<string, unknown>): string {
  const configured = metadata.wiseUrl;
  if (typeof configured === "string" && /^https:\/\//.test(configured)) return configured;
  return `https://app.wise.live/classes/${encodeURIComponent(classId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export async function getPostClassFeedbackDashboard(
  user: PostClassDashboardUser,
  range = defaultPostClassFeedbackRange(),
  db: Database = getDb(),
) {
  const startDate = validateDate(range.startDate, "Start date");
  const endDate = validateDate(range.endDate, "End date");
  if (startDate > endDate) throw new PostClassValidationError("Start date must be on or before end date.");
  const canReview = user.capabilities.includes("reviewer");
  const canFinance = user.capabilities.includes("finance");
  const canManageAccess = user.capabilities.includes("access_manager");

  const start = bangkokDateStartUtc(startDate);
  const endExclusive = bangkokDateStartUtc(addBangkokDays(endDate, 1));
  const trendGranularity = endExclusive.getTime() - start.getTime() > 120 * 86_400_000
    ? "month" as const
    : "week" as const;
  const [
    settingsRows,
    sessions,
    mappings,
    syncRuns,
    openIssues,
    sourceIssueHistory,
    digestRecipients,
    admins,
    accessRows,
    accessGrantVersions,
    tutorContacts,
    eligibleTutorIdentities,
    financePeriods,
    configAudit,
    deductionAudit,
    aiReviewAudit,
  ] = await Promise.all([
    db.select().from(schema.postClassSettings).limit(1),
    db.select().from(schema.postClassSessions)
      .where(and(
        gte(schema.postClassSessions.scheduledEndAt, start),
        lt(schema.postClassSessions.scheduledEndAt, endExclusive),
      ))
      .orderBy(desc(schema.postClassSessions.deadlineAt)),
    db.select().from(schema.postClassFieldMappings)
      .where(eq(schema.postClassFieldMappings.active, true)),
    db.select().from(schema.postClassSyncRuns)
      .orderBy(desc(schema.postClassSyncRuns.startedAt)).limit(8),
    db.select().from(schema.postClassSourceIssues)
      .where(eq(schema.postClassSourceIssues.status, "open"))
      .orderBy(desc(schema.postClassSourceIssues.lastSeenAt)).limit(100),
    db.select().from(schema.postClassSourceIssues)
      .where(eq(schema.postClassSourceIssues.blocksEnforcement, true))
      .orderBy(desc(schema.postClassSourceIssues.lastSeenAt)).limit(250),
    db.select().from(schema.postClassDigestRecipients)
      .where(eq(schema.postClassDigestRecipients.enabled, true)),
    db.select().from(schema.adminUsers).orderBy(schema.adminUsers.email),
    db.select().from(schema.postClassAccessGrants),
    db.select({
      email: schema.postClassConfigAuditLog.entityKey,
      version: sql<string | null>`max(case
        when jsonb_typeof(${schema.postClassConfigAuditLog.afterValue}->'version') = 'number'
        then (${schema.postClassConfigAuditLog.afterValue}->>'version')::bigint
        else null
      end)::text`,
    }).from(schema.postClassConfigAuditLog)
      .where(eq(schema.postClassConfigAuditLog.entityType, "access_grant"))
      .groupBy(schema.postClassConfigAuditLog.entityKey),
    db.select().from(schema.tutorContacts)
      .where(eq(schema.tutorContacts.active, true))
      .orderBy(schema.tutorContacts.displayName),
    db.selectDistinct({
      canonicalKey: schema.postClassSessions.canonicalTutorKey,
      displayName: schema.postClassSessions.canonicalTutorName,
    }).from(schema.postClassSessions).where(and(
      eq(schema.postClassSessions.eligible, true),
      isNotNull(schema.postClassSessions.canonicalTutorKey),
    )),
    db.select().from(schema.postClassFinancePeriods)
      .orderBy(desc(schema.postClassFinancePeriods.month)),
    db.select().from(schema.postClassConfigAuditLog)
      .orderBy(desc(schema.postClassConfigAuditLog.createdAt)).limit(100),
    db.select().from(schema.postClassDeductionActions)
      .orderBy(desc(schema.postClassDeductionActions.occurredAt)).limit(100),
    db.select({
      id: schema.postClassAiReviews.id,
      createdAt: schema.postClassAiReviews.createdAt,
      actorEmail: schema.postClassAiReviews.actorEmail,
      decision: schema.postClassAiReviews.decision,
      concernId: schema.postClassAiReviews.concernId,
      note: schema.postClassAiReviews.note,
    }).from(schema.postClassAiReviews)
      .orderBy(desc(schema.postClassAiReviews.createdAt)).limit(100),
  ]);

  const settings = settingsRows[0] ?? null;
  const sessionIds = sessions.map((session) => session.id);
  const wiseSessionIds = sessions.map((session) => session.wiseSessionId);
  const sessionQueriesEnabled = sessionIds.length > 0;
  const [
    participants,
    versions,
    assessments,
    deductionRows,
    notificationRows,
    aiConcernRows,
    tutorSubmissionRows,
  ] = await Promise.all([
    sessionQueriesEnabled
      ? db.select().from(schema.postClassSessionParticipants)
        .where(inArray(schema.postClassSessionParticipants.sessionId, sessionIds))
      : Promise.resolve([]),
    sessionQueriesEnabled
      ? db.select().from(schema.postClassFeedbackVersions)
        .where(inArray(schema.postClassFeedbackVersions.sessionId, sessionIds))
        .orderBy(desc(schema.postClassFeedbackVersions.observedAt))
      : Promise.resolve([]),
    sessionQueriesEnabled
      ? db.select().from(schema.postClassAssessments)
        .where(inArray(schema.postClassAssessments.sessionId, sessionIds))
        .orderBy(
          desc(schema.postClassAssessments.assessedAt),
          desc(schema.postClassAssessments.createdAt),
        )
      : Promise.resolve([]),
    sessionQueriesEnabled
      ? db.select({
        deduction: schema.postClassDeductions,
        processingMonth: schema.postClassFinancePeriods.month,
      }).from(schema.postClassDeductions)
        .leftJoin(
          schema.postClassFinancePeriods,
          eq(schema.postClassDeductions.financePeriodId, schema.postClassFinancePeriods.id),
        )
        .where(inArray(schema.postClassDeductions.sessionId, sessionIds))
      : Promise.resolve([]),
    sessionQueriesEnabled
      ? db.select({
        sessionId: schema.postClassNotificationItems.sessionId,
        deliveryId: schema.postClassNotificationDeliveries.id,
        status: schema.postClassNotificationDeliveries.status,
        sentAt: schema.postClassNotificationDeliveries.sentAt,
        createdAt: schema.postClassNotificationDeliveries.createdAt,
        attemptCount: schema.postClassNotificationDeliveries.attemptCount,
        nextAttemptAt: schema.postClassNotificationDeliveries.nextAttemptAt,
        kind: schema.postClassNotificationRuns.kind,
      }).from(schema.postClassNotificationItems)
        .innerJoin(
          schema.postClassNotificationDeliveries,
          eq(schema.postClassNotificationItems.deliveryId, schema.postClassNotificationDeliveries.id),
        )
        .innerJoin(
          schema.postClassNotificationRuns,
          eq(schema.postClassNotificationDeliveries.runId, schema.postClassNotificationRuns.id),
        )
        .where(inArray(schema.postClassNotificationItems.sessionId, sessionIds))
      : Promise.resolve([]),
    sessionQueriesEnabled
      ? db.select({
        sessionId: schema.postClassAiRuns.sessionId,
        concernId: schema.postClassAiConcerns.id,
        dimension: schema.postClassAiConcerns.dimension,
        summary: schema.postClassAiConcerns.summary,
        confidence: schema.postClassAiConcerns.confidence,
        decision: schema.postClassAiConcerns.decision,
        version: schema.postClassAiConcerns.version,
      }).from(schema.postClassAiConcerns)
        .innerJoin(schema.postClassAiRuns, eq(schema.postClassAiConcerns.runId, schema.postClassAiRuns.id))
        .where(inArray(schema.postClassAiRuns.sessionId, sessionIds))
      : Promise.resolve([]),
    // Earliest non-auto submission per session, read straight from the
    // immutable event stream. Deriving here rather than reading a persisted
    // column means the column is correct for every historical session without
    // re-observing any of them. The actor role is deliberately not filtered:
    // Wise stamps it from the account's role, not from authorship, so a
    // `TEACHER` predicate hid a tutor's own submission whenever that tutor also
    // held an admin account (D-EVT-04). This matches the qualifying rule in
    // `deriveEventTimingEvidence`, so the column never disagrees with the
    // verdict beside it.
    sessionQueriesEnabled
      ? db.select({
        wiseSessionId: schema.wiseActivityEvents.sessionId,
        submittedAt: sql<Date | null>`min(${schema.wiseActivityEvents.eventTimestamp})`,
      }).from(schema.wiseActivityEvents)
        .where(and(
          eq(schema.wiseActivityEvents.eventName, "SessionFeedbackSubmittedEvent"),
          inArray(schema.wiseActivityEvents.sessionId, wiseSessionIds),
          sql`coalesce(${schema.wiseActivityEvents.payload} -> 'session' ->> 'autoSubmitted', 'false') <> 'true'`,
        ))
        .groupBy(schema.wiseActivityEvents.sessionId)
      : Promise.resolve([]),
  ]);
  const deductionIds = deductionRows.map(({ deduction }) => deduction.id);
  const writtenPayoutLines = deductionIds.length > 0
    ? await db.selectDistinct({
      deductionId: schema.postClassPayoutRunLines.deductionId,
    }).from(schema.postClassPayoutRunLines).where(and(
      inArray(schema.postClassPayoutRunLines.deductionId, deductionIds),
      eq(schema.postClassPayoutRunLines.writeStatus, "written"),
    ))
    : [];
  const writtenPayoutDeductionIds = new Set(
    writtenPayoutLines.map((line) => line.deductionId),
  );

  const tutorSubmittedByWiseSession = new Map<string, Date>();
  for (const row of tutorSubmissionRows) {
    if (!row.wiseSessionId || !row.submittedAt) continue;
    const value = row.submittedAt instanceof Date ? row.submittedAt : new Date(row.submittedAt);
    if (!Number.isNaN(value.getTime())) tutorSubmittedByWiseSession.set(row.wiseSessionId, value);
  }

  const participantsBySession = new Map<string, string[]>();
  for (const participant of participants) {
    const names = participantsBySession.get(participant.sessionId) ?? [];
    if (!names.includes(participant.studentName)) names.push(participant.studentName);
    participantsBySession.set(participant.sessionId, names);
  }
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const versionCountBySession = new Map<string, number>();
  for (const version of versions) {
    versionCountBySession.set(version.sessionId, (versionCountBySession.get(version.sessionId) ?? 0) + 1);
  }
  const latestAssessmentBySession = new Map<string, (typeof assessments)[number]>();
  for (const assessment of assessments) {
    if (!latestAssessmentBySession.has(assessment.sessionId)) latestAssessmentBySession.set(assessment.sessionId, assessment);
  }
  const deductionOffsets = deductionRows.length > 0
    ? await db.select().from(schema.postClassDeductionOffsets).where(inArray(
      schema.postClassDeductionOffsets.deductionId,
      deductionRows.map((row) => row.deduction.id),
    ))
    : [];
  const offsetByDeduction = new Map(deductionOffsets.map((offset) => [offset.deductionId, offset]));
  const deductionsBySession = new Map(deductionRows.map((row) => [row.deduction.sessionId, {
    ...row,
    offset: offsetByDeduction.get(row.deduction.id) ?? null,
  }]));
  const latestNotificationBySession = new Map<string, (typeof notificationRows)[number]>();
  for (const notification of notificationRows.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (!latestNotificationBySession.has(notification.sessionId)) latestNotificationBySession.set(notification.sessionId, notification);
  }
  const aiBySession = new Map<string, {
    pending: number;
    confirmed: number;
    concerns: Array<{
      id: string;
      dimension: string;
      summary: string;
      confidence: number | null;
      decision: "pending" | "confirmed" | "dismissed";
      version: number;
    }>;
  }>();
  for (const concern of aiConcernRows) {
    const counts = aiBySession.get(concern.sessionId) ?? { pending: 0, confirmed: 0, concerns: [] };
    if (concern.decision === "pending") counts.pending += 1;
    if (concern.decision === "confirmed") counts.confirmed += 1;
    counts.concerns.push({
      id: concern.concernId,
      dimension: concern.dimension,
      summary: concern.summary,
      confidence: concern.confidence,
      decision: concern.decision,
      version: concern.version,
    });
    aiBySession.set(concern.sessionId, counts);
  }

  const sourceContextBySession = new Map<string, Array<{
    type: string;
    message: string;
    firstSeenAt: string;
    resolvedAt: string | null;
  }>>();
  for (const session of sessions) {
    const context = sourceIssueHistory
      .filter((issue) => postClassSourceIssueCrossedDeadline(issue, session.id, session.deadlineAt))
      .map((issue) => ({
        type: issue.issueType,
        message: issue.message,
        firstSeenAt: issue.firstSeenAt.toISOString(),
        resolvedAt: iso(issue.resolvedAt),
      }));
    if (context.length > 0) sourceContextBySession.set(session.id, context);
  }

  const sessionRows = sessions.map((session) => {
    const latest = session.latestFeedbackVersionId ? versionsById.get(session.latestFeedbackVersionId) ?? null : null;
    const assessment = latestAssessmentBySession.get(session.id) ?? null;
    // Per-field flags come from the version's informational failures; the
    // assessment's field_failures now carries only bar-violating reasons.
    const failures = latest?.fieldFailures ?? [];
    const notification = latestNotificationBySession.get(session.id) ?? null;
    const deductionResult = deductionsBySession.get(session.id) ?? null;
    const ai = aiBySession.get(session.id) ?? { pending: 0, confirmed: 0, concerns: [] };
    const metadata = session.sourceMetadata ?? {};
    const topics = latest?.topics ?? "";
    const performance = latest?.performance ?? "";
    const improvement = latest?.improvement ?? "";
    const reminderKind = notification?.kind === "tutor_day_after"
      ? "day_after"
      : notification?.kind === "tutor_deadline" ? "deadline_day" : null;
    return {
      id: session.id,
      wiseSessionId: session.wiseSessionId,
      classId: session.wiseClassId,
      className: session.className ?? "Untitled class",
      subject: asString(metadata.subject),
      tutorKey: session.canonicalTutorKey ?? "unresolved",
      tutorName: session.canonicalTutorName ?? "Tutor needs review",
      students: participantsBySession.get(session.id) ?? [],
      scheduledStartAt: session.scheduledStartAt.toISOString(),
      scheduledEndAt: session.scheduledEndAt.toISOString(),
      deadlineAt: session.deadlineAt.toISOString(),
      eligible: session.eligible,
      eligibilityReason: session.eligibilityReason,
      sourceStatus: session.sourceStatus,
      contentStatus: session.contentStatus,
      timingStatus: session.timingStatus,
      submittedBy: submitterFromAssessment(assessment?.details),
      submittedAt: iso(tutorSubmittedByWiseSession.get(session.wiseSessionId)),
      combinedCharacterCount: assessment?.combinedRawCharCount ?? latest?.rawCharCount ?? 0,
      required: {
        topics: { characters: codePointLength(topics), meaningful: fieldMeaningful(failures, "topic", topics) },
        performance: { characters: codePointLength(performance), meaningful: fieldMeaningful(failures, "performance", performance) },
        improvement: { characters: codePointLength(improvement), meaningful: fieldMeaningful(failures, "improvement", improvement) },
      },
      versionCount: versionCountBySession.get(session.id) ?? 0,
      observedAt: iso(latest?.observedAt),
      reminder: {
        lastKind: reminderKind,
        lastSentAt: iso(notification?.sentAt),
        status: notification?.status ?? "none",
        attempts: notification?.attemptCount ?? 0,
      },
      deduction: (canReview || canFinance) && deductionResult ? {
        id: deductionResult.deduction.id,
        status: deductionResult.offset ? "reversed" as const : deductionResult.deduction.status,
        amount: deductionResult.deduction.amountMinor / 100,
        processingMonth: deductionResult.processingMonth?.slice(0, 7) ?? null,
        version: deductionResult.deduction.version,
      } : null,
      ai: canReview ? {
        suspect: ai.pending + ai.confirmed > 0,
        confirmedConcerns: ai.confirmed,
        pendingConcerns: ai.pending,
        concerns: ai.concerns,
      } : {
        suspect: false,
        confirmedConcerns: 0,
        pendingConcerns: 0,
        concerns: [],
      },
      sourceIssueContext: sourceContextBySession.get(session.id) ?? [],
      wiseUrl: wiseSessionUrl(session.wiseClassId, session.wiseSessionId, metadata),
    };
  });

  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const latestAssessments = [...latestAssessmentBySession.values()];
  const assessed = latestAssessments.filter((row) => {
    const session = sessionById.get(row.sessionId);
    return isPostClassAssessmentInDenominator(session, row);
  });
  const rawOnTime = assessed.filter((row) => row.rawOnTime).length;
  const adjustedCompliant = assessed.filter((row) => row.adjustedCompliant || deductionsBySession.get(row.sessionId)?.deduction.status === "waived").length;
  const substantiveCounts = sessionRows
    .filter((row) => row.contentStatus === "substantive" && Boolean(
      sessionById.get(row.id)?.eligible && sessionById.get(row.id)?.sourceStatus === "ready",
    ))
    .map((row) => row.combinedCharacterCount);
  const pendingDeductions = deductionRows.filter((row) => row.deduction.status === "pending_review");
  const reminderFailures = new Set(notificationRows
    .filter(isPostClassTerminalReminderFailure)
    .map((row) => row.deliveryId)).size;

  const tutorGroups = new Map<string, typeof sessions>();
  for (const session of sessions.filter((row) => row.eligible)) {
    const key = session.canonicalTutorKey ?? `unresolved:${session.id}`;
    const group = tutorGroups.get(key) ?? [];
    group.push(session);
    tutorGroups.set(key, group);
  }
  const tutorMetrics = rankPostClassTutorMetrics([...tutorGroups.entries()].map(([tutorKey, tutorSessions]) => {
    const assessedTutorSessions = tutorSessions.filter((session) => {
      const value = latestAssessmentBySession.get(session.id);
      return isPostClassAssessmentInDenominator(session, value);
    });
    const tutorAssessments = assessedTutorSessions.map((session) => latestAssessmentBySession.get(session.id)!);
    const raw = tutorAssessments.filter((row) => row.rawOnTime).length;
    const adjusted = tutorAssessments.filter((row) => row.adjustedCompliant || deductionsBySession.get(row.sessionId)?.deduction.status === "waived").length;
    const characters = assessedTutorSessions
      .map((session) => sessionRows.find((row) => row.id === session.id))
      .filter((row): row is (typeof sessionRows)[number] => row?.contentStatus === "substantive")
      .map((row) => row.combinedCharacterCount);
    const unresolvedViolations = tutorAssessments.filter((row) => row.objectiveViolation && deductionsBySession.get(row.sessionId)?.deduction.status !== "waived").length;
    // Authorship split across every eligible session, not just assessed ones,
    // so a tutor who never submitted still shows up as an auto/admin case.
    const submitters = tutorSessions.map((session) =>
      submitterFromAssessment(latestAssessmentBySession.get(session.id)?.details));
    const trendGroups = new Map<string, typeof assessedTutorSessions>();
    for (const session of assessedTutorSessions) {
      const period = bangkokBucket(session.scheduledEndAt, trendGranularity);
      const values = trendGroups.get(period) ?? [];
      values.push(session);
      trendGroups.set(period, values);
    }
    return {
      tutorKey,
      tutorName: tutorSessions[0]?.canonicalTutorName ?? "Tutor needs review",
      eligible: tutorSessions.length,
      assessed: tutorAssessments.length,
      rawOnTimeRate: rate(raw, tutorAssessments.length),
      adjustedComplianceRate: rate(adjusted, tutorAssessments.length),
      unresolvedViolations,
      meanCharacters: mean(characters),
      confirmedAiConcerns: tutorSessions.reduce((sum, session) => sum + (aiBySession.get(session.id)?.confirmed ?? 0), 0),
      tutorAuthored: submitters.filter((value) => value === "tutor").length,
      adminRescued: submitters.filter((value) => value === "admin").length,
      autoFilled: submitters.filter((value) => value === "auto").length,
      trend: [...trendGroups.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([period, periodSessions]) => ({
        period,
        adjustedComplianceRate: rate(periodSessions.filter((session) => {
          const assessment = latestAssessmentBySession.get(session.id)!;
          return assessment.adjustedCompliant || deductionsBySession.get(session.id)?.deduction.status === "waived";
        }).length, periodSessions.length),
      })),
    };
  }));

  const periodById = new Map(financePeriods.map((period) => [period.id, period]));
  const deductionDto = deductionRows.filter(({ deduction }) =>
    canReview || (canFinance && (deduction.status === "approved" || deduction.status === "processed")),
  ).map(({ deduction, processingMonth }) => {
    const session = sessions.find((row) => row.id === deduction.sessionId)!;
    const assessment = latestAssessmentBySession.get(deduction.sessionId);
    const offset = offsetByDeduction.get(deduction.id) ?? null;
    return {
      id: deduction.id,
      sessionId: deduction.sessionId,
      // Carried so a payout view can group by identity rather than by display
      // name — two tutors can share a name, and one tutor's name can change.
      tutorKey: session?.canonicalTutorKey ?? null,
      wiseSessionId: session?.wiseSessionId ?? null,
      tutorName: session?.canonicalTutorName ?? "Tutor needs review",
      className: session?.className ?? "Untitled class",
      students: participantsBySession.get(deduction.sessionId) ?? [],
      sessionEndAt: session?.scheduledEndAt.toISOString() ?? "",
      reason: [
        assessment?.fieldFailures.join(", ") || "Feedback was incomplete at the deadline",
        sourceContextBySession.has(deduction.sessionId) ? "Wise/system source issue crossed the deadline" : null,
      ].filter(Boolean).join(" · "),
      amount: deduction.amountMinor / 100,
      status: offset ? "reversed" as const : deduction.status,
      payoutVerifiedWritten: writtenPayoutDeductionIds.has(deduction.id),
      processingMonth: offset
        ? periodById.get(offset.financePeriodId)?.month.slice(0, 7) ?? deduction.defaultFinanceMonth.slice(0, 7)
        : processingMonth?.slice(0, 7) ?? deduction.defaultFinanceMonth.slice(0, 7),
      referenceNote: user.capabilities.includes("finance") ? offset?.reference ?? deduction.processingReference : null,
      waiverCategory: user.capabilities.includes("reviewer") ? deduction.waiverCategory : null,
      decisionNote: user.capabilities.includes("reviewer") ? deduction.waiverNote : null,
      // Audit facts, deliberately ungated within the row-level capability
      // filter above: finance-only users need decision identity in the CSV
      // export as payroll evidence, and the values are internal admin emails.
      decisionByEmail: deduction.decisionByEmail,
      decisionAt: deduction.decisionAt?.toISOString() ?? null,
      processedByEmail: deduction.processedByEmail,
      processedAt: deduction.processedAt?.toISOString() ?? null,
      version: deduction.version,
      updatedAt: (offset?.createdAt ?? deduction.updatedAt).toISOString(),
    };
  });

  const activeAdminEmails = new Set(admins.map((admin) => admin.email.trim().toLowerCase()));
  const validAccessRows = accessRows.filter((row) => activeAdminEmails.has(row.email.trim().toLowerCase()));
  const validDigestRecipients = digestRecipients.filter((row) => activeAdminEmails.has(row.email.trim().toLowerCase()));
  const grantsByEmail = new Map<string, Set<Capability>>();
  const grantUpdatedAtByEmail = new Map<string, Date>();
  for (const grant of validAccessRows) {
    const email = grant.email.trim().toLowerCase();
    const set = grantsByEmail.get(email) ?? new Set<Capability>();
    set.add(grant.capability);
    grantsByEmail.set(email, set);
    const latest = grantUpdatedAtByEmail.get(email);
    if (!latest || grant.updatedAt > latest) grantUpdatedAtByEmail.set(email, grant.updatedAt);
  }
  const accessVersionByEmail = new Map<string, number>();
  for (const row of accessGrantVersions) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 0) continue;
    const email = row.email.trim().toLowerCase();
    accessVersionByEmail.set(email, Math.max(accessVersionByEmail.get(email) ?? 0, version));
  }
  const adminRows = canManageAccess ? admins.map((admin) => {
    const email = admin.email.trim().toLowerCase();
    const grants = grantsByEmail.get(email) ?? new Set<Capability>();
    const timestampVersion = Math.floor(
      (grantUpdatedAtByEmail.get(email) ?? admin.createdAt).getTime() / 1_000,
    );
    const version = Math.max(timestampVersion, accessVersionByEmail.get(email) ?? 0);
    return {
      email,
      name: admin.name ?? email,
      viewer: grants.has("viewer"),
      reviewer: grants.has("reviewer"),
      finance: grants.has("finance"),
      accessManager: grants.has("access_manager"),
      version,
      updatedAt: new Date(version * 1_000).toISOString(),
    };
  }) : [];

  const contactsByKey = new Map(tutorContacts.map((contact) => [contact.canonicalKey, contact]));
  const tutorNamesByKey = new Map(eligibleTutorIdentities.flatMap((row) =>
    row.canonicalKey ? [[row.canonicalKey, row.displayName ?? row.canonicalKey] as const] : []));
  const tutorKeys = [...new Set([...contactsByKey.keys(), ...tutorNamesByKey.keys()])];
  const allTutorEmailRows = tutorKeys.map((tutorKey) => {
    const contact = contactsByKey.get(tutorKey);
    const wiseEmails = [...new Set([contact?.onsiteEmail, contact?.onlineEmail]
      .map((email) => email?.trim().toLowerCase())
      .filter((email): email is string => Boolean(email)))];
    const status = contact?.primaryEmail ? "primary" : wiseEmails.length === 1 ? "fallback" : wiseEmails.length === 0 ? "missing" : "conflict";
    return {
      tutorKey,
      tutorName: contact?.displayName ?? tutorNamesByKey.get(tutorKey) ?? tutorKey,
      wiseEmails,
      primaryEmail: contact?.primaryEmail ?? null,
      status,
      warning: status === "missing" ? "No Wise email is available" : status === "conflict" ? "Paired Wise accounts have different emails" : null,
      version: contact ? Math.floor(contact.updatedAt.getTime() / 1000) : 0,
    };
  });
  const tutorEmailRows = canManageAccess ? allTutorEmailRows : [];

  const approvedByPeriod = new Map<string, number>();
  for (const row of deductionRows) {
    if (row.deduction.status === "approved") {
      const periodId = row.deduction.financePeriodId ?? financePeriods.find(
        (period) => period.month === row.deduction.defaultFinanceMonth,
      )?.id;
      if (periodId) approvedByPeriod.set(periodId, (approvedByPeriod.get(periodId) ?? 0) + 1);
    }
  }
  const financePeriodRows = canFinance ? financePeriods.map((period) => ({
    month: period.month.slice(0, 7),
    status: period.status,
    approvedUnprocessed: approvedByPeriod.get(period.id) ?? 0,
    version: period.version,
    updatedAt: period.updatedAt.toISOString(),
  })) : [];
  const reviewerActions = new Set(["approve", "waive", "reopen", "candidate_created"]);
  const financeActions = new Set(["move", "process", "reverse"]);
  const accessOnlyConfigEntities = new Set(["access_grant", "tutor_primary_email", "email_delivery"]);
  const visibleConfigAudit = configAudit.filter((row) => {
    if (accessOnlyConfigEntities.has(row.entityType)) return canManageAccess;
    if (row.entityType === "finance_period") return canFinance;
    if (row.entityType === "ai_review_request") return canReview;
    return true;
  });
  const audit = [
    ...visibleConfigAudit.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityKey,
      summary: canManageAccess || (canFinance && row.entityType === "finance_period")
        ? row.note ?? `${row.entityType} ${row.action}`
        : `${row.entityType} ${row.action}`,
    })),
    ...deductionAudit.map((row) => ({
      id: row.id,
      createdAt: row.occurredAt.toISOString(),
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: "deduction",
      entityId: row.deductionId,
      summary: reviewerActions.has(row.action) && canReview
        ? row.note ?? `${row.fromStatus ?? "none"} → ${row.toStatus}`
        : financeActions.has(row.action) && canFinance
          ? row.note ?? row.reference ?? `${row.fromStatus ?? "none"} → ${row.toStatus}`
          : `${row.fromStatus ?? "none"} → ${row.toStatus}`,
    })),
    ...(canReview ? aiReviewAudit.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actorEmail: row.actorEmail,
      action: row.decision,
      entityType: "ai_concern",
      entityId: row.concernId,
      summary: row.note,
    })) : []),
  ].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 150);

  const latestSync = syncRuns[0] ?? null;
  // Scope matters here for the same reason it matters at every other gate: a
  // session-scoped issue is a fact about one row, and one messy row does not
  // make the source unhealthy. Counting them here pinned this badge at
  // "degraded" indefinitely, since a `session_not_found` for a session Wise
  // deleted can never resolve.
  const blockingGlobalIssues = openIssues.filter((issue) =>
    issue.blocksEnforcement && issue.scope === "global");
  const sessionScopedIssues = openIssues.filter((issue) => issue.scope !== "global");
  const latestSyncGloballyHealthy = latestSync?.metadata?.globalSourceHealthy === true;
  const sourceHealth = !latestSync
    ? "unavailable"
    : latestSync.status === "success"
      && latestSyncGloballyHealthy
      && blockingGlobalIssues.length === 0
      && settings?.formMappingValid !== false
      ? "healthy"
      : "degraded";
  const activeMappings = mappings.filter((mapping) => mapping.mappingVersion === settings?.formMappingVersion);
  const mappingByKey = new Map(activeMappings.map((mapping) => [mapping.fieldKey, mapping.wiseQuestionText || null]));
  const formMappingHealth = !activeMappings.length ? "unmapped" : settings?.formMappingValid ? "healthy" : "drift";
  const coverage = {
    reviewer: validAccessRows.some((row) => row.capability === "reviewer"),
    finance: validAccessRows.some((row) => row.capability === "finance"),
    manager: validAccessRows.some((row) => row.capability === "access_manager"),
  };
  // Email relay, admin digest recipients, and tutor email coverage no longer
  // appear here: outbound reminders and the digest are parked, so they cannot
  // gate activation.
  const setupItems = [
    { key: "mapping" as const, label: "Wise field mapping", complete: formMappingHealth === "healthy", detail: formMappingHealth === "healthy" ? "All required fields mapped" : "Mapping needs review" },
    { key: "roles" as const, label: "Role coverage", complete: coverage.reviewer && coverage.finance && coverage.manager, detail: `${coverage.reviewer ? 1 : 0}/1 reviewer, ${coverage.finance ? 1 : 0}/1 finance, ${coverage.manager ? 1 : 0}/1 access manager` },
    { key: "shadow_review" as const, label: "Shadow review", complete: Boolean(settings?.shadowReviewedAt), detail: settings?.shadowReviewedAt ? `Reviewed ${settings.shadowReviewedAt.toISOString()}` : "Run and review a shadow sync" },
    { key: "activation" as const, label: "Prospective activation", complete: settings?.enforcementMode === "live", detail: settings?.enforcementMode === "live" ? `Live from ${iso(settings.policyEffectiveAt)}` : "Not live" },
  ];

  // One pinned Google account performs every payout write, so only that
  // account's grants matter. Reported to finance users so the missing Drive
  // consent is visible before a publish fails on it, and deliberately kept out
  // of `setup` — the payout handoff is not part of activation.
  const payoutGoogleEmail = payoutConnectedEmail();
  const [payoutToken] = canFinance
    ? await db.select({ scope: schema.googleOAuthTokens.scope })
      .from(schema.googleOAuthTokens)
      .where(eq(schema.googleOAuthTokens.email, payoutGoogleEmail))
      .limit(1)
    : [];

  return {
    capabilities: {
      viewer: user.capabilities.includes("viewer"),
      reviewer: user.capabilities.includes("reviewer"),
      finance: user.capabilities.includes("finance"),
      accessManager: user.capabilities.includes("access_manager"),
    },
    payoutGoogle: canFinance
      ? {
        connectedEmail: payoutGoogleEmail,
        sheetsWriteReady: hasSheetsWriteScope(payoutToken?.scope),
        driveReady: hasDriveFileScope(payoutToken?.scope),
      }
      : null,
    settings: {
      mode: settings?.enforcementMode ?? "shadow",
      effectiveAt: iso(settings?.policyEffectiveAt),
      sourceHealth,
      openSourceIssues: {
        global: blockingGlobalIssues.length,
        session: sessionScopedIssues.length,
      },
      sourceLastSyncedAt: iso(latestSync?.finishedAt),
      formMappingHealth,
      mapping: {
        topics: canManageAccess ? mappingByKey.get("topics") ?? null : null,
        performance: canManageAccess ? mappingByKey.get("performance") ?? null : null,
        improvement: canManageAccess ? mappingByKey.get("improvement") ?? null : null,
        homework: canManageAccess ? mappingByKey.get("homework") ?? null : null,
      },
      digestRecipientEmails: canManageAccess ? validDigestRecipients.map((row) => row.email) : [],
      policyVersion: `v${settings?.policyVersion ?? 1}`,
      version: settings?.version ?? 1,
    },
    summary: {
      eligible: sessions.filter((row) => row.eligible).length,
      assessed: assessed.length,
      rawOnTime,
      rawOnTimeRate: rate(rawOnTime, assessed.length),
      adjustedCompliant,
      adjustedComplianceRate: rate(adjustedCompliant, assessed.length),
      openViolations: assessed.filter((row) => row.objectiveViolation && deductionsBySession.get(row.sessionId)?.deduction.status !== "waived").length,
      pendingDeductions: pendingDeductions.length,
      pendingDeductionAmount: pendingDeductions.reduce((sum, row) => sum + row.deduction.amountMinor / 100, 0),
      reminderFailures,
      late: assessed.filter((row) => row.timingStatus === "late").length,
      // Content-bar violations only (char count / all-placeholder) — an empty
      // field alone is informational, not incomplete.
      incomplete: assessed.filter((row) => (row.fieldFailures?.length ?? 0) > 0).length,
      waived: deductionRows.filter((row) => row.deduction.status === "waived").length,
      meanCharacters: mean(substantiveCounts),
      medianCharacters: median(substantiveCounts),
      confirmedAiConcerns: aiConcernRows.filter((row) => row.decision === "confirmed").length,
    },
    sessions: sessionRows,
    tutorMetrics,
    deductions: deductionDto,
    audit,
    admins: adminRows,
    tutorEmails: tutorEmailRows,
    financePeriods: financePeriodRows,
    setup: {
      complete: setupItems.every((item) => item.complete),
      items: setupItems,
    },
  };
}
