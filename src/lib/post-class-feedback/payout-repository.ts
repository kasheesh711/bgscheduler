import "server-only";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import {
  PostClassConflictError,
  PostClassNotFoundError,
  PostClassValidationError,
} from "./errors";
import { lockPostClassFinance } from "./finance-lock";
import { payoutCorrectionMarker, payoutRowMarker } from "./payout-master";
import {
  assertPayoutRunPublishable,
  payoutAdjustmentIdempotencyKey,
  payoutAdjustmentSourceIdentity,
  payoutDeductionSourceIdentity,
  payoutLineIdempotencyKey,
  payoutPreviewToken,
  payoutSourceFingerprint,
  type PayoutPreviewFingerprint,
  type PayoutPublishAcknowledgements,
  type PayoutRunCoverage,
} from "./payout-plan";
import {
  payoutBangkokDate,
  payoutRunRangeUtc,
  payoutRunWindow,
  payoutRunWindowForBangkokDate,
  type PayoutRunWindow,
} from "./payout-window";
import { withPostClassTransaction } from "./transaction";

// ── Payout run persistence ──────────────────────────────────────────────

export const PAYOUT_RUN_LEASE_MS = 15 * 60 * 1_000;

export type PayoutRun = typeof schema.postClassPayoutRuns.$inferSelect;
export type PayoutRunLine = typeof schema.postClassPayoutRunLines.$inferSelect;
export type PayoutTutorName = typeof schema.postClassPayoutTutorNames.$inferSelect;
export type PayoutAdjustment = typeof schema.postClassPayoutAdjustments.$inferSelect;
export type PayoutException = typeof schema.postClassPayoutExceptions.$inferSelect;
export type PayoutRollRun = typeof schema.postClassPayoutRollRuns.$inferSelect;
export type PayoutRollOutcome = typeof schema.postClassPayoutRollOutcomes.$inferSelect;

export interface PayoutRunCandidate {
  deductionId: string;
  sessionId: string;
  canonicalTutorKey: string | null;
  tutorName: string | null;
  wiseSessionId: string;
  className: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  deadlineAt: Date;
  /** Signed minor units. A deduction is always negative. */
  amountMinor: number;
  currency: string;
  defaultFinanceMonth: string | null;
  studentNames: string[];
  tutorSubmittedAt: Date | null;
  reason: string;
}

function anchorMonthDate(anchorMonth: string): string {
  return `${anchorMonth}-01`;
}

/** Approved, in-window deductions which have not already been compensated. */
export async function selectPayoutRunCandidates(
  db: Database,
  window: PayoutRunWindow,
): Promise<PayoutRunCandidate[]> {
  const { start, endExclusive } = payoutRunRangeUtc(window);
  const rows = await db.select({
    deductionId: schema.postClassDeductions.id,
    amountMinor: schema.postClassDeductions.amountMinor,
    currency: schema.postClassDeductions.currency,
    defaultFinanceMonth: schema.postClassDeductions.defaultFinanceMonth,
    sessionId: schema.postClassSessions.id,
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    canonicalTutorKey: schema.postClassSessions.canonicalTutorKey,
    tutorName: schema.postClassSessions.canonicalTutorName,
    className: schema.postClassSessions.className,
    scheduledStartAt: schema.postClassSessions.scheduledStartAt,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    deadlineAt: schema.postClassSessions.deadlineAt,
  })
    .from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .leftJoin(
      schema.postClassDeductionOffsets,
      eq(schema.postClassDeductionOffsets.deductionId, schema.postClassDeductions.id),
    )
    .where(and(
      gte(schema.postClassSessions.scheduledEndAt, start),
      lt(schema.postClassSessions.scheduledEndAt, endExclusive),
      eq(schema.postClassDeductions.status, "approved"),
      eq(schema.postClassSessions.eligible, true),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      isNull(schema.postClassDeductionOffsets.id),
    ))
    .orderBy(
      asc(schema.postClassSessions.canonicalTutorKey),
      asc(schema.postClassSessions.scheduledStartAt),
    );

  if (rows.length === 0) return [];
  const sessionIds = rows.map((row) => row.sessionId);
  const participants = await db.select({
    sessionId: schema.postClassSessionParticipants.sessionId,
    studentName: schema.postClassSessionParticipants.studentName,
  }).from(schema.postClassSessionParticipants)
    .where(inArray(schema.postClassSessionParticipants.sessionId, sessionIds));
  const submissions = await db.select({
    sessionId: schema.postClassFeedbackEventLinks.sessionId,
    submittedAt: sql<string | null>`min(${schema.postClassFeedbackEventLinks.eventTimestamp})`,
  }).from(schema.postClassFeedbackEventLinks)
    .innerJoin(
      schema.wiseActivityEvents,
      eq(
        schema.postClassFeedbackEventLinks.wiseActivityEventId,
        schema.wiseActivityEvents.id,
      ),
    )
    .where(and(
      inArray(schema.postClassFeedbackEventLinks.sessionId, sessionIds),
      ne(schema.postClassFeedbackEventLinks.autoSubmitted, true),
      sql`lower(btrim(coalesce(${schema.wiseActivityEvents.actorRole}, ''))) = 'teacher'`,
    ))
    .groupBy(schema.postClassFeedbackEventLinks.sessionId);
  const assessments = await db.select({
    sessionId: schema.postClassAssessments.sessionId,
    fieldFailures: schema.postClassAssessments.fieldFailures,
    assessedAt: schema.postClassAssessments.assessedAt,
  }).from(schema.postClassAssessments)
    .where(inArray(schema.postClassAssessments.sessionId, sessionIds))
    .orderBy(asc(schema.postClassAssessments.assessedAt));

  const studentsBySession = new Map<string, string[]>();
  for (const row of participants) {
    const names = studentsBySession.get(row.sessionId) ?? [];
    if (!names.includes(row.studentName)) names.push(row.studentName);
    studentsBySession.set(row.sessionId, names);
  }
  const submittedBySession = new Map(
    submissions.map((row) => [row.sessionId, row.submittedAt ? new Date(row.submittedAt) : null]),
  );
  const reasonBySession = new Map<string, string>();
  for (const row of assessments) {
    reasonBySession.set(
      row.sessionId,
      row.fieldFailures.join(", ") || "Feedback was incomplete at the deadline",
    );
  }

  return rows.map((row) => ({
    ...row,
    amountMinor: -Math.abs(row.amountMinor),
    studentNames: [
      ...(studentsBySession.get(row.sessionId)
        ?? (row.className ? [row.className] : [])),
    ].toSorted(),
    tutorSubmittedAt: submittedBySession.get(row.sessionId) ?? null,
    reason: reasonBySession.get(row.sessionId) ?? "Feedback was incomplete at the deadline",
  }));
}

/** Everything the publish/close gates need to judge source completeness. */
export async function computePayoutRunCoverage(
  db: Database,
  window: PayoutRunWindow,
  candidates: PayoutRunCandidate[],
  mappedTutorKeys: ReadonlySet<string>,
): Promise<PayoutRunCoverage> {
  const { start, endExclusive } = payoutRunRangeUtc(window);
  const inWindow = and(
    gte(schema.postClassSessions.scheduledEndAt, start),
    lt(schema.postClassSessions.scheduledEndAt, endExclusive),
  );
  const [sessionCounts] = await db.select({
    // The denominator includes every proven-eligible session plus any
    // unproven/non-ready session. Missing billing evidence must make coverage
    // worse, never disappear from the payout gate.
    eligible: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible} or ${schema.postClassSessions.sourceStatus} <> 'ready')`,
    ready: sql<number>`count(*) filter (where ${schema.postClassSessions.eligible} and ${schema.postClassSessions.sourceStatus} = 'ready')`,
    nonReady: sql<number>`count(*) filter (where ${schema.postClassSessions.sourceStatus} <> 'ready')`,
    unavailable: sql<number>`count(*) filter (where ${schema.postClassSessions.sourceStatus} = 'unavailable')`,
    formDrift: sql<number>`count(*) filter (where ${schema.postClassSessions.sourceStatus} = 'form_drift')`,
    identityReview: sql<number>`count(*) filter (where ${schema.postClassSessions.sourceStatus} = 'identity_review')`,
  }).from(schema.postClassSessions).where(inWindow);
  const [pending] = await db.select({ count: sql<number>`count(*)` })
    .from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(and(inWindow, eq(schema.postClassDeductions.status, "pending_review")));
  const [unprovenApproved] = await db.select({ count: sql<number>`count(*)` })
    .from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .leftJoin(
      schema.postClassDeductionOffsets,
      eq(schema.postClassDeductionOffsets.deductionId, schema.postClassDeductions.id),
    )
    .where(and(
      inWindow,
      eq(schema.postClassDeductions.status, "approved"),
      isNull(schema.postClassDeductionOffsets.id),
      or(
        eq(schema.postClassSessions.eligible, false),
        ne(schema.postClassSessions.sourceStatus, "ready"),
      ),
    ));
  const [issues] = await db.select({ count: sql<number>`count(*)` })
    .from(schema.postClassSourceIssues)
    .where(and(
      eq(schema.postClassSourceIssues.scope, "global"),
      eq(schema.postClassSourceIssues.status, "open"),
      eq(schema.postClassSourceIssues.blocksEnforcement, true),
    ));

  const unmapped = new Set<string>();
  let nullTutorKeyLines = 0;
  for (const candidate of candidates) {
    if (!candidate.canonicalTutorKey) nullTutorKeyLines += 1;
    else if (!mappedTutorKeys.has(candidate.canonicalTutorKey)) unmapped.add(candidate.canonicalTutorKey);
  }
  return {
    eligibleSessions: Number(sessionCounts?.eligible ?? 0),
    readySessions: Number(sessionCounts?.ready ?? 0),
    nonReadySessions: Number(sessionCounts?.nonReady ?? 0),
    unavailableSessions: Number(sessionCounts?.unavailable ?? 0),
    formDriftSessions: Number(sessionCounts?.formDrift ?? 0),
    identityReviewSessions: Number(sessionCounts?.identityReview ?? 0),
    pendingReviewDeductions: Number(pending?.count ?? 0),
    unprovenApprovedDeductions: Number(unprovenApproved?.count ?? 0),
    approvedDeductions: candidates.length,
    unmappedTutorKeys: [...unmapped].toSorted(),
    nullTutorKeyLines,
    blockingGlobalSourceIssues: Number(issues?.count ?? 0),
  };
}

export async function loadPayoutTutorNames(
  db: Database,
): Promise<Map<string, PayoutTutorName>> {
  const rows = await db.select().from(schema.postClassPayoutTutorNames)
    .where(eq(schema.postClassPayoutTutorNames.active, true));
  return new Map(rows.map((row) => [row.canonicalKey, row]));
}

export function payoutTutorNameStrings(mapping: PayoutTutorName): string[] {
  return [mapping.primaryLedgerName, mapping.alternateLedgerName].filter(
    (name): name is string => Boolean(name && name.trim()),
  );
}

export type PayoutTutorNameUpsertInput = {
  canonicalKey: string;
  primaryLedgerName: string;
  alternateLedgerName: string | null;
  active: boolean;
  updatedByEmail: string;
};

export async function upsertPayoutTutorName(
  db: Database,
  input: PayoutTutorNameUpsertInput,
): Promise<PayoutTutorName> {
  const primary = input.primaryLedgerName.trim();
  const alternate = input.alternateLedgerName?.trim() || null;
  if (!primary) throw new PostClassValidationError("A primary ledger name is required.");
  if (alternate && alternate.toLocaleLowerCase("en-US") === primary.toLocaleLowerCase("en-US")) {
    throw new PostClassConflictError("Primary and alternate ledger names must be different.");
  }
  const existingMappings = await db.select().from(schema.postClassPayoutTutorNames);
  const wantedNames = new Set(
    [primary, alternate]
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLocaleLowerCase("en-US")),
  );
  const conflict = existingMappings.find((mapping) =>
    mapping.canonicalKey !== input.canonicalKey
    && [mapping.primaryLedgerName, mapping.alternateLedgerName]
      .filter((name): name is string => Boolean(name))
      .some((name) => wantedNames.has(name.toLocaleLowerCase("en-US"))));
  if (conflict) {
    throw new PostClassConflictError(
      `Ledger identity is already assigned to ${conflict.canonicalKey}.`,
    );
  }
  const [row] = await db.insert(schema.postClassPayoutTutorNames).values({
    canonicalKey: input.canonicalKey,
    primaryLedgerName: primary,
    alternateLedgerName: alternate,
    active: input.active,
    updatedByEmail: input.updatedByEmail,
  })
    .onConflictDoUpdate({
      target: schema.postClassPayoutTutorNames.canonicalKey,
      set: {
        primaryLedgerName: primary,
        alternateLedgerName: alternate,
        active: input.active,
        updatedByEmail: input.updatedByEmail,
        updatedAt: new Date(),
      },
    }).returning();
  return row;
}

export async function getPayoutRunByAnchor(
  db: Database,
  anchorMonth: string,
): Promise<PayoutRun | null> {
  const [row] = await db.select().from(schema.postClassPayoutRuns)
    .where(eq(schema.postClassPayoutRuns.anchorMonth, anchorMonthDate(anchorMonth)))
    .limit(1);
  return row ?? null;
}

export async function loadPayoutRunLines(
  db: Database,
  runId: string,
): Promise<PayoutRunLine[]> {
  return db.select().from(schema.postClassPayoutRunLines)
    .where(eq(schema.postClassPayoutRunLines.runId, runId))
    .orderBy(
      asc(schema.postClassPayoutRunLines.canonicalTutorKey),
      asc(schema.postClassPayoutRunLines.scheduledStartAt),
    );
}

export async function loadPayoutAdjustments(
  db: Database,
  runId: string,
  lines?: PayoutRunLine[],
): Promise<PayoutAdjustment[]> {
  const runLines = lines ?? await loadPayoutRunLines(db, runId);
  const lineIds = runLines.map((line) => line.id);
  const predicate = lineIds.length > 0
    ? or(
      eq(schema.postClassPayoutAdjustments.runId, runId),
      inArray(schema.postClassPayoutAdjustments.sourceLineId, lineIds),
    )
    : eq(schema.postClassPayoutAdjustments.runId, runId);
  return db.select().from(schema.postClassPayoutAdjustments)
    .where(predicate)
    .orderBy(asc(schema.postClassPayoutAdjustments.createdAt));
}

export async function loadPayoutExceptions(
  db: Database,
  runId: string,
): Promise<PayoutException[]> {
  return db.select().from(schema.postClassPayoutExceptions)
    .where(eq(schema.postClassPayoutExceptions.runId, runId))
    .orderBy(asc(schema.postClassPayoutExceptions.createdAt));
}

/**
 * Compare immutable, externally written line inputs with the current source.
 *
 * A later publish may add new obligations, but it must never "re-bless" a
 * written row whose tutor, timing, students, amount, reason, or ledger mapping
 * changed after Google received the original signed row.
 */
async function findWrittenPayoutLinePayloadDrift(
  db: Database,
  lines: PayoutRunLine[],
  tutorNames: ReadonlyMap<string, PayoutTutorName>,
): Promise<PayoutRunLine[]> {
  const written = lines.filter((line) => line.writeStatus === "written");
  if (written.length === 0) return [];
  const deductionIds = written.map((line) => line.deductionId);
  const rows = await db.select({
    deductionId: schema.postClassDeductions.id,
    amountMinor: schema.postClassDeductions.amountMinor,
    currency: schema.postClassDeductions.currency,
    financeMonth: schema.postClassDeductions.defaultFinanceMonth,
    sessionId: schema.postClassSessions.id,
    wiseSessionId: schema.postClassSessions.wiseSessionId,
    canonicalTutorKey: schema.postClassSessions.canonicalTutorKey,
    tutorName: schema.postClassSessions.canonicalTutorName,
    className: schema.postClassSessions.className,
    scheduledStartAt: schema.postClassSessions.scheduledStartAt,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
    deadlineAt: schema.postClassSessions.deadlineAt,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(inArray(schema.postClassDeductions.id, deductionIds));
  const sessionIds = rows.map((row) => row.sessionId);
  const participants = await db.select({
    sessionId: schema.postClassSessionParticipants.sessionId,
    studentName: schema.postClassSessionParticipants.studentName,
  }).from(schema.postClassSessionParticipants)
    .where(inArray(schema.postClassSessionParticipants.sessionId, sessionIds));
  const submissions = await db.select({
    sessionId: schema.postClassFeedbackEventLinks.sessionId,
    submittedAt: sql<string | null>`min(${schema.postClassFeedbackEventLinks.eventTimestamp})`,
  }).from(schema.postClassFeedbackEventLinks)
    .innerJoin(
      schema.wiseActivityEvents,
      eq(
        schema.postClassFeedbackEventLinks.wiseActivityEventId,
        schema.wiseActivityEvents.id,
      ),
    )
    .where(and(
      inArray(schema.postClassFeedbackEventLinks.sessionId, sessionIds),
      eq(schema.postClassFeedbackEventLinks.autoSubmitted, false),
      sql`lower(btrim(coalesce(${schema.wiseActivityEvents.actorRole}, ''))) = 'teacher'`,
    ))
    .groupBy(schema.postClassFeedbackEventLinks.sessionId);
  const assessments = await db.select({
    sessionId: schema.postClassAssessments.sessionId,
    fieldFailures: schema.postClassAssessments.fieldFailures,
    assessedAt: schema.postClassAssessments.assessedAt,
  }).from(schema.postClassAssessments)
    .where(inArray(schema.postClassAssessments.sessionId, sessionIds))
    .orderBy(asc(schema.postClassAssessments.assessedAt));

  const studentsBySession = new Map<string, string[]>();
  for (const participant of participants) {
    const names = studentsBySession.get(participant.sessionId) ?? [];
    if (!names.includes(participant.studentName)) names.push(participant.studentName);
    studentsBySession.set(participant.sessionId, names);
  }
  const submittedBySession = new Map(
    submissions.map((submission) => [
      submission.sessionId,
      submission.submittedAt ? new Date(submission.submittedAt) : null,
    ]),
  );
  const reasonBySession = new Map<string, string>();
  for (const assessment of assessments) {
    reasonBySession.set(
      assessment.sessionId,
      assessment.fieldFailures.join(", ") || "Feedback was incomplete at the deadline",
    );
  }
  const currentByDeduction = new Map(rows.map((row) => {
    const students = [
      ...(studentsBySession.get(row.sessionId)
        ?? (row.className ? [row.className] : [])),
    ].toSorted();
    return [row.deductionId, {
      ...row,
      amountMinor: -Math.abs(row.amountMinor),
      studentNames: students,
      tutorSubmittedAt: submittedBySession.get(row.sessionId) ?? null,
      reason: reasonBySession.get(row.sessionId)
        ?? "Feedback was incomplete at the deadline",
    }] as const;
  }));
  const sameInstant = (left: Date | null, right: Date | null) =>
    left?.getTime() === right?.getTime();
  return written.filter((line) => {
    const current = currentByDeduction.get(line.deductionId);
    if (!current) return true;
    const mapping = current.canonicalTutorKey
      ? tutorNames.get(current.canonicalTutorKey)
      : undefined;
    const mappingChangedAfterWrite = Boolean(
      current.canonicalTutorKey
      && (
        !mapping
        || !line.writtenAt
        || mapping.updatedAt.getTime() > line.writtenAt.getTime()
      ),
    );
    return mappingChangedAfterWrite
      || line.sessionId !== current.sessionId
      || line.wiseSessionId !== current.wiseSessionId
      || line.canonicalTutorKey !== current.canonicalTutorKey
      || line.tutorName !== current.tutorName
      || line.className !== current.className
      || JSON.stringify([...line.studentNames].toSorted())
        !== JSON.stringify(current.studentNames)
      || !sameInstant(line.scheduledStartAt, current.scheduledStartAt)
      || !sameInstant(line.scheduledEndAt, current.scheduledEndAt)
      || !sameInstant(line.deadlineAt, current.deadlineAt)
      || !sameInstant(line.tutorSubmittedAt, current.tutorSubmittedAt)
      || line.amountMinor !== current.amountMinor
      || line.currency !== current.currency
      || line.financeMonth !== current.financeMonth
      || line.reason !== current.reason;
  });
}

export interface PayoutPreviewSnapshot {
  run: PayoutRun | null;
  candidates: PayoutRunCandidate[];
  selectedCandidates: PayoutRunCandidate[];
  coverage: PayoutRunCoverage;
  tutorNames: Map<string, PayoutTutorName>;
  lines: PayoutRunLine[];
  adjustments: PayoutAdjustment[];
  exceptions: PayoutException[];
  policyVersion: number;
  previewToken: string;
  sourceFingerprint: string;
}

export async function readPayoutRunPreview(
  db: Database,
  input: {
    window: PayoutRunWindow;
    tutorFilter?: string | null;
  },
): Promise<PayoutPreviewSnapshot> {
  const run = await getPayoutRunByAnchor(db, input.window.anchorMonth);
  const [settings] = await db.select({
    policyVersion: schema.postClassSettings.policyVersion,
  }).from(schema.postClassSettings)
    .where(eq(schema.postClassSettings.id, "default"))
    .limit(1);
  const policyVersion = Number(settings?.policyVersion ?? 0);
  const candidates = await selectPayoutRunCandidates(db, input.window);
  const tutorNames = await loadPayoutTutorNames(db);
  const coverage = await computePayoutRunCoverage(
    db,
    input.window,
    candidates,
    new Set(tutorNames.keys()),
  );
  const selectedCandidates = input.tutorFilter
    ? candidates.filter((candidate) => candidate.canonicalTutorKey === input.tutorFilter)
    : candidates;
  const lines = run ? await loadPayoutRunLines(db, run.id) : [];
  const adjustments = run ? await loadPayoutAdjustments(db, run.id, lines) : [];
  const exceptions = run ? await loadPayoutExceptions(db, run.id) : [];
  const selectedCandidateIds = new Set(
    selectedCandidates.map((candidate) => candidate.deductionId),
  );
  const retainedWrittenObligations = lines
    .filter((line) =>
      line.writeStatus === "written"
      && !selectedCandidateIds.has(line.deductionId)
      && (!input.tutorFilter || line.canonicalTutorKey === input.tutorFilter))
    .map((line) => {
      const mapping = line.canonicalTutorKey
        ? tutorNames.get(line.canonicalTutorKey)
        : undefined;
      return {
        sourceIdentity: line.sourceIdentity,
        rowSignature: line.rowSignature,
        sessionId: line.sessionId,
        wiseSessionId: line.wiseSessionId,
        amountMinor: line.amountMinor,
        currency: line.currency,
        canonicalTutorKey: line.canonicalTutorKey,
        tutorName: line.tutorName,
        className: line.className,
        studentNames: line.studentNames,
        scheduledStartAt: line.scheduledStartAt.toISOString(),
        scheduledEndAt: line.scheduledEndAt.toISOString(),
        deadlineAt: line.deadlineAt.toISOString(),
        tutorSubmittedAt: line.tutorSubmittedAt?.toISOString() ?? null,
        financeMonth: line.financeMonth,
        reason: line.reason,
        mappingIdentity: mapping
          ? `${mapping.primaryLedgerName}\u0000${mapping.alternateLedgerName ?? ""}`
          : null,
      };
    });
  const fingerprint: PayoutPreviewFingerprint = {
    policyVersion,
    anchorMonth: input.window.anchorMonth,
    windowStart: input.window.windowStart,
    windowEnd: input.window.windowEnd,
    tutorFilter: input.tutorFilter ?? null,
    runVersion: run?.version ?? null,
    runStatus: run?.status ?? null,
    coverage,
    obligations: [...selectedCandidates.map((candidate) => {
      const mapping = candidate.canonicalTutorKey
        ? tutorNames.get(candidate.canonicalTutorKey)
        : undefined;
      return {
        sourceIdentity: payoutDeductionSourceIdentity(candidate.deductionId),
        rowSignature: payoutRowMarker({
          anchorMonth: input.window.anchorMonth,
          deductionId: candidate.deductionId,
        }),
        sessionId: candidate.sessionId,
        wiseSessionId: candidate.wiseSessionId,
        amountMinor: candidate.amountMinor,
        currency: candidate.currency,
        canonicalTutorKey: candidate.canonicalTutorKey,
        tutorName: candidate.tutorName,
        className: candidate.className,
        studentNames: candidate.studentNames,
        scheduledStartAt: candidate.scheduledStartAt.toISOString(),
        scheduledEndAt: candidate.scheduledEndAt.toISOString(),
        deadlineAt: candidate.deadlineAt.toISOString(),
        tutorSubmittedAt: candidate.tutorSubmittedAt?.toISOString() ?? null,
        financeMonth: candidate.defaultFinanceMonth,
        reason: candidate.reason,
        mappingIdentity: mapping
          ? `${mapping.primaryLedgerName}\u0000${mapping.alternateLedgerName ?? ""}`
          : null,
      };
    }), ...retainedWrittenObligations],
    adjustments: adjustments.map((adjustment) => ({
      sourceIdentity: adjustment.sourceIdentity,
      rowSignature: adjustment.rowSignature,
      amountMinor: adjustment.amountMinor,
      status: adjustment.status,
    })),
  };
  const previewToken = payoutPreviewToken(fingerprint);
  const sourceFingerprint = payoutSourceFingerprint(fingerprint);
  return {
    run,
    candidates,
    selectedCandidates,
    coverage,
    tutorNames,
    lines,
    adjustments,
    exceptions,
    policyVersion,
    previewToken,
    sourceFingerprint,
  };
}

export interface AcquiredPayoutRun extends PayoutPreviewSnapshot {
  run: PayoutRun;
  leaseToken: string;
  selectionComplete: boolean;
}

/**
 * Revalidate a read-only preview, sync durable obligations, and atomically
 * acquire a 15-minute publish lease.
 */
export async function acquirePayoutRunLease(input: {
  window: PayoutRunWindow;
  actorEmail: string;
  previewToken: string;
  expectedVersion: number;
  tutorFilter?: string | null;
  acknowledgements: PayoutPublishAcknowledgements;
  now?: Date;
}, db: Database = getDb()): Promise<AcquiredPayoutRun> {
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const [runningSync] = await tx.select({
      id: schema.postClassSyncRuns.id,
    }).from(schema.postClassSyncRuns)
      .where(eq(schema.postClassSyncRuns.status, "running"))
      .limit(1);
    if (runningSync) {
      throw new PostClassConflictError(
        "A post-class source sync is active. Let it finish before publishing payouts.",
      );
    }
    const snapshot = await readPayoutRunPreview(tx, {
      window: input.window,
      tutorFilter: input.tutorFilter,
    });
    const currentVersion = snapshot.run?.version ?? 1;
    if (input.expectedVersion !== currentVersion) {
      throw new PostClassConflictError(
        "This payout run version changed. Refresh it before publishing.",
      );
    }
    if (snapshot.previewToken !== input.previewToken) {
      throw new PostClassConflictError(
        "This payout preview is stale. Refresh it before publishing.",
      );
    }
    if (
      input.acknowledgements.confirmed !== true
      || input.acknowledgements.reason.trim().length < 10
    ) {
      throw new PostClassValidationError(
        "Publishing requires explicit confirmation, exact preview counts, and a reason of at least 10 characters.",
      );
    }
    if (
      input.acknowledgements.pendingReviewDeductions
        !== snapshot.coverage.pendingReviewDeductions
      || input.acknowledgements.nonReadySessions
        !== snapshot.coverage.nonReadySessions
    ) {
      throw new PostClassConflictError(
        "The payout acknowledgement counts do not match this preview. Refresh and confirm again.",
      );
    }
    assertPayoutRunPublishable(snapshot.coverage, input.acknowledgements);
    const driftedWrittenLines = await findWrittenPayoutLinePayloadDrift(
      tx,
      snapshot.lines,
      snapshot.tutorNames,
    );
    if (driftedWrittenLines.length > 0) {
      throw new PostClassConflictError(
        `${driftedWrittenLines.length} written payout row`
        + `${driftedWrittenLines.length === 1 ? " no longer matches" : "s no longer match"}`
        + " the current immutable source payload. Finance must review a positive"
        + " compensation or external exception; the row cannot be republished in place.",
      );
    }

    const now = input.now ?? new Date();
    let run = snapshot.run;
    if (run?.status === "closed") {
      throw new PostClassConflictError("This payout run is closed and cannot be changed.");
    }
    if (
      run?.leaseToken
      && run.leaseExpiresAt
      && run.leaseExpiresAt.getTime() > now.getTime()
    ) {
      throw new PostClassConflictError(
        `Another payout operation is active until ${run.leaseExpiresAt.toISOString()}.`,
      );
    }
    if (run?.status === "publishing") {
      const abandoned = run;
      const [recovered] = await tx.update(schema.postClassPayoutRuns).set({
        status: "partial",
        leaseToken: null,
        leaseExpiresAt: null,
        publishingByEmail: null,
        version: abandoned.version + 1,
        updatedAt: now,
      }).where(and(
        eq(schema.postClassPayoutRuns.id, abandoned.id),
        eq(schema.postClassPayoutRuns.status, "publishing"),
        eq(schema.postClassPayoutRuns.version, abandoned.version),
      )).returning();
      if (!recovered) {
        throw new PostClassConflictError(
          "The expired payout publish changed while it was being recovered.",
        );
      }
      await tx.insert(schema.postClassConfigAuditLog).values({
        entityType: "payout_run",
        entityKey: abandoned.id,
        action: "expire_publish_lease",
        actorEmail: input.actorEmail,
        beforeValue: {
          status: abandoned.status,
          version: abandoned.version,
          leaseToken: abandoned.leaseToken,
          leaseExpiresAt: abandoned.leaseExpiresAt?.toISOString() ?? null,
          publishingByEmail: abandoned.publishingByEmail,
          publishStartedAt: abandoned.publishStartedAt?.toISOString() ?? null,
        },
        afterValue: {
          status: recovered.status,
          version: recovered.version,
          leaseToken: null,
          leaseExpiresAt: null,
        },
        note: "Expired payout publish lease recovered to partial before a new pass.",
      });
      run = recovered;
    }
    if (!run) {
      await tx.insert(schema.postClassPayoutRuns).values({
        anchorMonth: anchorMonthDate(input.window.anchorMonth),
        windowStart: input.window.windowStart,
        windowEnd: input.window.windowEnd,
      }).onConflictDoNothing({ target: schema.postClassPayoutRuns.anchorMonth });
      run = await getPayoutRunByAnchor(tx, input.window.anchorMonth);
    }
    if (!run) throw new PostClassConflictError("The payout run could not be created.");

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + PAYOUT_RUN_LEASE_MS);
    const acknowledgementReason = input.acknowledgements.reason!.trim();
    const [claimed] = await tx.update(schema.postClassPayoutRuns).set({
      status: "publishing",
      leaseToken,
      leaseExpiresAt,
      publishingByEmail: input.actorEmail,
      publishStartedAt: now,
      publishAcknowledgements: {
        confirmed: true,
        pendingReviewDeductions: snapshot.coverage.pendingReviewDeductions,
        nonReadySessions: snapshot.coverage.nonReadySessions,
        reason: acknowledgementReason,
        actorEmail: input.actorEmail,
        recordedAt: now.toISOString(),
        policyVersion: snapshot.policyVersion,
        coverage: snapshot.coverage,
        previewToken: input.previewToken,
        sourceFingerprint: snapshot.sourceFingerprint,
        tutorFilter: input.tutorFilter ?? null,
      },
      version: run.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRuns.id, run.id),
      eq(schema.postClassPayoutRuns.version, run.version),
    )).returning();
    if (!claimed) {
      throw new PostClassConflictError("Another payout operation acquired this run first.");
    }

    if (snapshot.selectedCandidates.length > 0) {
      const selectedByIdentity = new Map(
        snapshot.selectedCandidates.map((candidate) => [
          payoutDeductionSourceIdentity(candidate.deductionId),
          candidate,
        ]),
      );
      const crossRunLines = await tx.select()
        .from(schema.postClassPayoutRunLines)
        .where(and(
          inArray(
            schema.postClassPayoutRunLines.sourceIdentity,
            [...selectedByIdentity.keys()],
          ),
          ne(schema.postClassPayoutRunLines.runId, claimed.id),
        ));
      if (crossRunLines.length > 0) {
        const oldRuns = await tx.select().from(schema.postClassPayoutRuns)
          .where(inArray(
            schema.postClassPayoutRuns.id,
            [...new Set(crossRunLines.map((line) => line.runId))],
          ));
        const oldRunById = new Map(oldRuns.map((oldRun) => [oldRun.id, oldRun]));
        for (const line of crossRunLines) {
          const oldRun = oldRunById.get(line.runId);
          const candidate = selectedByIdentity.get(line.sourceIdentity);
          if (!oldRun || !candidate) {
            throw new PostClassConflictError(
              "A cross-window payout line could not be reconciled safely.",
            );
          }
          if (line.writeStatus === "written" || oldRun.status === "closed") {
            throw new PostClassConflictError(
              `Deduction ${line.deductionId} belongs to payout run`
              + ` ${oldRun.anchorMonth.slice(0, 7)} and cannot be moved because`
              + " its row was written or the run is closed. Finance must review"
              + " a positive compensation or post-close external exception.",
            );
          }
          if (
            oldRun.leaseToken
            && oldRun.leaseExpiresAt
            && oldRun.leaseExpiresAt > now
          ) {
            throw new PostClassConflictError(
              `Payout run ${oldRun.anchorMonth.slice(0, 7)} still owns the line lease.`,
            );
          }
          const [reparented] = await tx.update(schema.postClassPayoutRunLines).set({
            runId: claimed.id,
            sessionId: candidate.sessionId,
            rowSignature: payoutRowMarker({
              anchorMonth: input.window.anchorMonth,
              deductionId: candidate.deductionId,
            }),
            canonicalTutorKey: candidate.canonicalTutorKey,
            tutorName: candidate.tutorName,
            wiseSessionId: candidate.wiseSessionId,
            className: candidate.className,
            studentNames: candidate.studentNames,
            scheduledStartAt: candidate.scheduledStartAt,
            scheduledEndAt: candidate.scheduledEndAt,
            deadlineAt: candidate.deadlineAt,
            tutorSubmittedAt: candidate.tutorSubmittedAt,
            amountMinor: candidate.amountMinor,
            currency: candidate.currency,
            financeMonth: candidate.defaultFinanceMonth,
            reason: candidate.reason,
            matchStatus: "pending",
            spreadsheetId: null,
            sheetName: null,
            matchedRowNumber: null,
            insertedRowNumber: null,
            writeStatus: "pending",
            passToken: leaseToken,
            writeError: null,
            writtenAt: null,
            retiredAt: null,
            retiredReason: null,
            idempotencyKey: payoutLineIdempotencyKey({
              runId: claimed.id,
              deductionId: candidate.deductionId,
            }),
            updatedAt: now,
          }).where(and(
            eq(schema.postClassPayoutRunLines.id, line.id),
            eq(schema.postClassPayoutRunLines.runId, oldRun.id),
            ne(schema.postClassPayoutRunLines.writeStatus, "written"),
          )).returning();
          if (!reparented) {
            throw new PostClassConflictError(
              "The cross-window payout line changed while it was being reparented.",
            );
          }
          await tx.insert(schema.postClassConfigAuditLog).values({
            entityType: "payout_run_line",
            entityKey: line.id,
            action: "reparent_payout_run_line",
            actorEmail: input.actorEmail,
            beforeValue: {
              runId: line.runId,
              anchorMonth: oldRun.anchorMonth,
              rowSignature: line.rowSignature,
              idempotencyKey: line.idempotencyKey,
              writeStatus: line.writeStatus,
              scheduledEndAt: line.scheduledEndAt.toISOString(),
            },
            afterValue: {
              runId: reparented.runId,
              anchorMonth: claimed.anchorMonth,
              rowSignature: reparented.rowSignature,
              idempotencyKey: reparented.idempotencyKey,
              writeStatus: reparented.writeStatus,
              scheduledEndAt: reparented.scheduledEndAt.toISOString(),
            },
            note: `Reparented unwritten deduction ${line.deductionId} across payout windows.`,
          });
        }
        for (const oldRun of oldRuns) {
          const [updatedOldRun] = await tx.update(schema.postClassPayoutRuns).set({
            status: oldRun.status === "published" || oldRun.status === "publishing"
              ? "partial"
              : oldRun.status,
            leaseToken: null,
            leaseExpiresAt: null,
            publishingByEmail: null,
            version: oldRun.version + 1,
            updatedAt: now,
          }).where(and(
            eq(schema.postClassPayoutRuns.id, oldRun.id),
            eq(schema.postClassPayoutRuns.version, oldRun.version),
          )).returning({ id: schema.postClassPayoutRuns.id });
          if (!updatedOldRun) {
            throw new PostClassConflictError(
              "The prior payout run changed while its line was being reparented.",
            );
          }
        }
      }
      await tx.insert(schema.postClassPayoutRunLines).values(
        snapshot.selectedCandidates.map((candidate) => ({
          runId: claimed.id,
          deductionId: candidate.deductionId,
          sessionId: candidate.sessionId,
          lineKind: "deduction" as const,
          sourceIdentity: payoutDeductionSourceIdentity(candidate.deductionId),
          rowSignature: payoutRowMarker({
            anchorMonth: input.window.anchorMonth,
            deductionId: candidate.deductionId,
          }),
          canonicalTutorKey: candidate.canonicalTutorKey,
          tutorName: candidate.tutorName,
          wiseSessionId: candidate.wiseSessionId,
          className: candidate.className,
          studentNames: candidate.studentNames,
          scheduledStartAt: candidate.scheduledStartAt,
          scheduledEndAt: candidate.scheduledEndAt,
          deadlineAt: candidate.deadlineAt,
          tutorSubmittedAt: candidate.tutorSubmittedAt,
          amountMinor: candidate.amountMinor,
          currency: candidate.currency,
          financeMonth: candidate.defaultFinanceMonth,
          reason: candidate.reason,
          passToken: leaseToken,
          idempotencyKey: payoutLineIdempotencyKey({
            runId: claimed.id,
            deductionId: candidate.deductionId,
          }),
        })),
      ).onConflictDoUpdate({
        target: schema.postClassPayoutRunLines.sourceIdentity,
        // A retry must use the exact source snapshot which produced the fresh
        // preview, not stale matching inputs retained from a failed pass.
        // Written rows are immutable and excluded by setWhere.
        set: {
          runId: sql`excluded.run_id`,
          sessionId: sql`excluded.session_id`,
          rowSignature: sql`excluded.row_signature`,
          canonicalTutorKey: sql`excluded.canonical_tutor_key`,
          tutorName: sql`excluded.tutor_name`,
          wiseSessionId: sql`excluded.wise_session_id`,
          className: sql`excluded.class_name`,
          studentNames: sql`excluded.student_names`,
          scheduledStartAt: sql`excluded.scheduled_start_at`,
          scheduledEndAt: sql`excluded.scheduled_end_at`,
          deadlineAt: sql`excluded.deadline_at`,
          tutorSubmittedAt: sql`excluded.tutor_submitted_at`,
          amountMinor: sql`excluded.amount_minor`,
          currency: sql`excluded.currency`,
          financeMonth: sql`excluded.finance_month`,
          reason: sql`excluded.reason`,
          matchStatus: "pending",
          spreadsheetId: null,
          sheetName: null,
          matchedRowNumber: null,
          insertedRowNumber: null,
          writeStatus: "pending",
          passToken: leaseToken,
          writeError: null,
          writtenAt: null,
          retiredAt: null,
          retiredReason: null,
          idempotencyKey: sql`excluded.idempotency_key`,
          updatedAt: now,
        },
        setWhere: ne(schema.postClassPayoutRunLines.writeStatus, "written"),
      });
    }

    const allPublishableIds = new Set(snapshot.candidates.map((candidate) => candidate.deductionId));
    const existing = await loadPayoutRunLines(tx, claimed.id);
    const retired = existing.filter((line) =>
      line.writeStatus !== "written"
      && line.retiredAt === null
      && !allPublishableIds.has(line.deductionId));
    if (retired.length > 0) {
      await tx.update(schema.postClassPayoutRunLines).set({
        matchStatus: "no_sheet",
        writeStatus: "skipped",
        writeError: "The deduction is no longer approved.",
        retiredAt: now,
        retiredReason: "The deduction is no longer approved.",
        updatedAt: now,
      }).where(inArray(
        schema.postClassPayoutRunLines.id,
        retired.map((line) => line.id),
      ));
    }

    const attachedAdjustments = await loadPayoutAdjustments(tx, claimed.id, existing);
    const unattached = attachedAdjustments.filter((adjustment) => adjustment.runId === null);
    if (unattached.length > 0) {
      await tx.update(schema.postClassPayoutAdjustments).set({
        runId: claimed.id,
        passToken: leaseToken,
        updatedAt: now,
      }).where(inArray(
        schema.postClassPayoutAdjustments.id,
        unattached.map((adjustment) => adjustment.id),
      ));
    }
    await tx.update(schema.postClassPayoutAdjustments).set({
      passToken: leaseToken,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutAdjustments.runId, claimed.id),
      ne(schema.postClassPayoutAdjustments.status, "written"),
    ));

    const lines = await loadPayoutRunLines(tx, claimed.id);
    const adjustments = await loadPayoutAdjustments(tx, claimed.id, lines);
    const exceptions = await loadPayoutExceptions(tx, claimed.id);
    return {
      ...snapshot,
      run: claimed,
      leaseToken,
      lines,
      adjustments,
      exceptions,
      selectionComplete: !input.tutorFilter
        || snapshot.selectedCandidates.length === snapshot.candidates.length,
    };
  });
}

export interface PayoutLineMatchPatch {
  matchStatus: "matched" | "unmatched" | "ambiguous" | "no_sheet";
  spreadsheetId?: string | null;
  sheetName?: string | null;
  matchedRowNumber?: number | null;
  insertedRowNumber?: number | null;
  writeStatus?: "pending" | "written" | "failed" | "skipped";
  writeError?: string | null;
  writtenAt?: Date | null;
}

/** CAS-fenced persistence immediately after each irreversible Google outcome. */
export async function markPayoutLine(
  db: Database,
  input: {
    runId: string;
    lineId: string;
    leaseToken: string;
    patch: PayoutLineMatchPatch;
  },
): Promise<PayoutRunLine> {
  const [row] = await db.update(schema.postClassPayoutRunLines).set({
    ...input.patch,
    writeError: input.patch.writeError === undefined
      ? undefined
      : input.patch.writeError?.slice(0, 500) ?? null,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.postClassPayoutRunLines.id, input.lineId),
    eq(schema.postClassPayoutRunLines.runId, input.runId),
    eq(schema.postClassPayoutRunLines.passToken, input.leaseToken),
    sql`exists (
      select 1 from ${schema.postClassPayoutRuns}
      where ${schema.postClassPayoutRuns.id} = ${input.runId}
        and ${schema.postClassPayoutRuns.status} = 'publishing'
        and ${schema.postClassPayoutRuns.leaseToken} = ${input.leaseToken}::uuid
        and ${schema.postClassPayoutRuns.leaseExpiresAt} > now()
    )`,
  )).returning();
  if (!row) throw new PostClassConflictError("The payout line outcome lost its publish lease.");
  return row;
}

export async function markPayoutAdjustment(
  db: Database,
  input: {
    runId: string;
    adjustmentId: string;
    leaseToken: string;
    status: "pending" | "written" | "failed" | "exception";
    sheetRowNumber?: number | null;
    writeError?: string | null;
    writtenAt?: Date | null;
  },
): Promise<PayoutAdjustment> {
  const [row] = await db.update(schema.postClassPayoutAdjustments).set({
    status: input.status,
    sheetRowNumber: input.sheetRowNumber,
    writeError: input.writeError?.slice(0, 500) ?? null,
    writtenAt: input.writtenAt,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.postClassPayoutAdjustments.id, input.adjustmentId),
    eq(schema.postClassPayoutAdjustments.runId, input.runId),
    eq(schema.postClassPayoutAdjustments.passToken, input.leaseToken),
    sql`exists (
      select 1 from ${schema.postClassPayoutRuns}
      where ${schema.postClassPayoutRuns.id} = ${input.runId}
        and ${schema.postClassPayoutRuns.status} = 'publishing'
        and ${schema.postClassPayoutRuns.leaseToken} = ${input.leaseToken}::uuid
        and ${schema.postClassPayoutRuns.leaseExpiresAt} > now()
    )`,
  )).returning();
  if (!row) throw new PostClassConflictError("The payout adjustment outcome lost its publish lease.");
  return row;
}

async function upsertPayoutExceptionRecord(db: Database, input: {
  runId: string;
  deductionId?: string | null;
  adjustmentId?: string | null;
  kind: string;
  reason: string;
}): Promise<PayoutException> {
  const sourceIdentity = [
    "payout-exception",
    input.runId,
    input.deductionId ?? "-",
    input.adjustmentId ?? "-",
    input.kind,
  ].join(":");
  const [existing] = await db.select().from(schema.postClassPayoutExceptions)
    .where(eq(schema.postClassPayoutExceptions.sourceIdentity, sourceIdentity))
    .limit(1);
  if (existing?.status === "open") return existing;
  if (existing) {
    const [reopened] = await db.update(schema.postClassPayoutExceptions).set({
      status: "open",
      reason: input.reason.slice(0, 1_000),
      resolutionNote: null,
      resolutionReference: null,
      resolvedByEmail: null,
      resolvedAt: null,
      version: existing.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.postClassPayoutExceptions.id, existing.id),
      eq(schema.postClassPayoutExceptions.version, existing.version),
    )).returning();
    if (!reopened) {
      throw new PostClassConflictError("The payout exception changed while reopening.");
    }
    return reopened;
  }
  const [row] = await db.insert(schema.postClassPayoutExceptions).values({
    runId: input.runId,
    deductionId: input.deductionId ?? null,
    adjustmentId: input.adjustmentId ?? null,
    kind: input.kind,
    sourceIdentity,
    idempotencyKey: sourceIdentity,
    reason: input.reason.slice(0, 1_000),
  }).returning();
  return row;
}

export async function finalizePayoutRunPass(db: Database, input: {
  runId: string;
  leaseToken: string;
  actorEmail: string;
  csvFileId: string | null;
  csvUrl: string | null;
  csvError: string | null;
  forcePartial?: boolean;
}): Promise<PayoutRun> {
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const now = new Date();
    const [current] = await tx.select().from(schema.postClassPayoutRuns)
      .where(and(
        eq(schema.postClassPayoutRuns.id, input.runId),
        eq(schema.postClassPayoutRuns.status, "publishing"),
        eq(schema.postClassPayoutRuns.leaseToken, input.leaseToken),
        gt(schema.postClassPayoutRuns.leaseExpiresAt, now),
      )).limit(1);
    if (!current) {
      throw new PostClassConflictError("The payout finalizer lost its publish lease.");
    }
    const lines = await loadPayoutRunLines(tx, input.runId);
    const adjustments = await loadPayoutAdjustments(tx, input.runId, lines);
    const exceptions = await loadPayoutExceptions(tx, input.runId);
    const incompleteLines = lines.some((line) =>
      line.retiredAt === null && line.writeStatus !== "written");
    const incompleteAdjustments = adjustments.some((adjustment) =>
      adjustment.status !== "written");
    const openExceptions = exceptions.some((exception) => exception.status === "open");
    const finalSourceSnapshot = await readPayoutRunPreview(tx, {
      window: {
        anchorMonth: current.anchorMonth.slice(0, 7),
        windowStart: current.windowStart,
        windowEnd: current.windowEnd,
      },
      tutorFilter: current.publishAcknowledgements?.tutorFilter ?? null,
    });
    const claimedSourceFingerprint =
      current.publishAcknowledgements?.sourceFingerprint;
    const sourceChangedDuringPublish = !claimedSourceFingerprint
      || finalSourceSnapshot.sourceFingerprint !== claimedSourceFingerprint;
    const writtenPayloadChangedDuringPublish =
      (await findWrittenPayoutLinePayloadDrift(
        tx,
        lines,
        finalSourceSnapshot.tutorNames,
      )).length > 0;
    const status = input.forcePartial
      || incompleteLines
      || incompleteAdjustments
      || openExceptions
      || sourceChangedDuringPublish
      || writtenPayloadChangedDuringPublish
      ? "partial" as const
      : "published" as const;
    const [row] = await tx.update(schema.postClassPayoutRuns).set({
      status,
      leaseToken: null,
      leaseExpiresAt: null,
      publishingByEmail: null,
      ...(status === "published" ? {
        publishedByEmail: input.actorEmail,
        publishedAt: sql`coalesce(${schema.postClassPayoutRuns.publishedAt}, now())`,
      } : {}),
      csvStatus: input.csvFileId ? "uploaded" : "failed",
      csvFileId: input.csvFileId,
      csvUrl: input.csvUrl,
      csvError: input.csvError?.slice(0, 500) ?? null,
      csvAttemptedAt: now,
      version: current.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRuns.id, input.runId),
      eq(schema.postClassPayoutRuns.status, "publishing"),
      eq(schema.postClassPayoutRuns.leaseToken, input.leaseToken),
      gt(schema.postClassPayoutRuns.leaseExpiresAt, now),
      eq(schema.postClassPayoutRuns.version, current.version),
    )).returning();
    if (!row) throw new PostClassConflictError("The payout finalizer lost its publish lease.");
    return row;
  });
}

/** Finance action guard: a correction is valid only after a negative row landed. */
export async function findWrittenPayoutDeductionLine(
  db: Database,
  deductionId: string,
): Promise<PayoutRunLine | null> {
  const [line] = await db.select().from(schema.postClassPayoutRunLines)
    .where(and(
      eq(schema.postClassPayoutRunLines.deductionId, deductionId),
      eq(schema.postClassPayoutRunLines.writeStatus, "written"),
    ))
    .orderBy(asc(schema.postClassPayoutRunLines.writtenAt))
    .limit(1);
  return line ?? null;
}

export async function hasWrittenPayoutDeduction(
  db: Database,
  deductionId: string,
): Promise<boolean> {
  return Boolean(await findWrittenPayoutDeductionLine(db, deductionId));
}

export async function createPayoutAdjustment(db: Database, input: {
  deductionId: string;
  kind: "waiver" | "reversal";
  reason: string;
  actorEmail: string;
  actionIdentity: string;
}): Promise<PayoutAdjustment> {
  const sourceLine = await findWrittenPayoutDeductionLine(db, input.deductionId);
  if (!sourceLine) {
    throw new PostClassConflictError(
      "This deduction has no written payout row, so no correction may be appended.",
    );
  }
  const [run] = await db.select().from(schema.postClassPayoutRuns)
    .where(eq(schema.postClassPayoutRuns.id, sourceLine.runId)).limit(1);
  if (!run) throw new PostClassNotFoundError("The source payout run was not found.");
  const idempotencyKey = payoutAdjustmentIdempotencyKey(input);
  const [existing] = await db.select().from(schema.postClassPayoutAdjustments)
    .where(eq(schema.postClassPayoutAdjustments.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing) return existing;
  const adjustmentId = randomUUID();
  const postClose = run.status === "closed";
  const [adjustment] = await db.insert(schema.postClassPayoutAdjustments).values({
    id: adjustmentId,
    deductionId: input.deductionId,
    sourceLineId: sourceLine.id,
    runId: sourceLine.runId,
    kind: input.kind,
    status: postClose ? "exception" : "pending",
    amountMinor: Math.abs(sourceLine.amountMinor),
    currency: sourceLine.currency,
    reason: input.reason,
    actorEmail: input.actorEmail,
    sourceIdentity: payoutAdjustmentSourceIdentity(adjustmentId),
    rowSignature: payoutCorrectionMarker({
      anchorMonth: run.anchorMonth.slice(0, 7),
      adjustmentId,
    }),
    idempotencyKey,
    writeError: postClose
      ? "The source payout run was already closed; resolve with an external correction reference."
      : null,
  }).returning();
  if (postClose) {
    await upsertPayoutExceptionRecord(db, {
      runId: run.id,
      deductionId: input.deductionId,
      adjustmentId: adjustment.id,
      kind: "post_close_adjustment",
      reason: `${input.kind} was recorded after the payout run closed: ${input.reason}`,
    });
  }
  const [updatedRun] = await db.update(schema.postClassPayoutRuns).set({
    status: run.status === "published" ? "partial" : run.status,
    version: run.version + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.postClassPayoutRuns.id, run.id),
    eq(schema.postClassPayoutRuns.version, run.version),
  )).returning({ id: schema.postClassPayoutRuns.id });
  if (!updatedRun) {
    throw new PostClassConflictError(
      "The payout run changed while its correction was being recorded.",
    );
  }
  return adjustment;
}

/**
 * Shared mutation guard for approvals, reopens, period reassignment, and any
 * other action which could create a new obligation in a frozen payout window.
 */
export async function assertPayoutWindowOpenForSession(
  db: Database,
  sessionId: string,
): Promise<void> {
  const [session] = await db.select({
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
  }).from(schema.postClassSessions)
    .where(eq(schema.postClassSessions.id, sessionId))
    .limit(1);
  if (!session) throw new PostClassNotFoundError("Post-class session not found.");
  const window = payoutRunWindowForBangkokDate(
    payoutBangkokDate(session.scheduledEndAt),
  );
  const run = await getPayoutRunByAnchor(db, window.anchorMonth);
  if (run?.status === "closed") {
    throw new PostClassConflictError(
      `Payout run ${window.anchorMonth} is closed; this finance action would change a frozen window.`,
    );
  }
}

export async function assertPayoutWindowOpenForDeduction(
  db: Database,
  deductionId: string,
): Promise<void> {
  const [deduction] = await db.select({
    sessionId: schema.postClassDeductions.sessionId,
  }).from(schema.postClassDeductions)
    .where(eq(schema.postClassDeductions.id, deductionId))
    .limit(1);
  if (!deduction) throw new PostClassNotFoundError("Deduction not found.");
  await assertPayoutWindowOpenForSession(db, deduction.sessionId);
}

/**
 * Finance-action seam for an approval that races/arrives after publication.
 *
 * The caller invokes this inside its existing finance-locked transaction.
 * A published run is demoted to partial so the new obligation is visible to
 * the next pass. A closed window gets one idempotent open exception instead.
 */
export async function recordLateApprovalPayoutExceptionIfClosed(
  db: Database,
  input: {
    deductionId: string;
    reason?: string;
  },
): Promise<PayoutException | null> {
  const [row] = await db.select({
    sessionId: schema.postClassDeductions.sessionId,
    scheduledEndAt: schema.postClassSessions.scheduledEndAt,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(eq(schema.postClassDeductions.id, input.deductionId))
    .limit(1);
  if (!row) throw new PostClassNotFoundError("Deduction not found.");
  const window = payoutRunWindowForBangkokDate(payoutBangkokDate(row.scheduledEndAt));
  const run = await getPayoutRunByAnchor(db, window.anchorMonth);
  if (run?.status === "published") {
    const [reopened] = await db.update(schema.postClassPayoutRuns).set({
      status: "partial",
      version: run.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.postClassPayoutRuns.id, run.id),
      eq(schema.postClassPayoutRuns.status, "published"),
      eq(schema.postClassPayoutRuns.version, run.version),
    )).returning({ id: schema.postClassPayoutRuns.id });
    if (!reopened) {
      throw new PostClassConflictError(
        "The payout run changed while its late approval was being recorded.",
      );
    }
    return null;
  }
  if (run?.status !== "closed") return null;
  const exception = await upsertPayoutExceptionRecord(db, {
    runId: run.id,
    deductionId: input.deductionId,
    kind: "post_close_late_approval",
    reason: input.reason?.trim()
      || `Deduction was approved after payout run ${window.anchorMonth} closed.`,
  });
  await db.update(schema.postClassPayoutRuns).set({
    version: sql`${schema.postClassPayoutRuns.version} + 1`,
    updatedAt: new Date(),
  }).where(eq(schema.postClassPayoutRuns.id, run.id));
  return exception;
}

export async function resolvePayoutException(db: Database, input: {
  exceptionId: string;
  actorEmail: string;
  expectedVersion: number;
  resolutionNote: string;
  resolutionReference?: string | null;
}): Promise<PayoutException> {
  if (!input.resolutionNote.trim()) {
    throw new PostClassValidationError("A resolution note is required.");
  }
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const [exception] = await tx.select().from(schema.postClassPayoutExceptions)
      .where(eq(schema.postClassPayoutExceptions.id, input.exceptionId)).limit(1);
    if (!exception) throw new PostClassNotFoundError("Payout exception not found.");
    if (exception.status === "resolved") return exception;
    if (exception.version !== input.expectedVersion) {
      throw new PostClassConflictError("This payout exception changed. Refresh and try again.");
    }
    const [run] = await tx.select().from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, exception.runId)).limit(1);
    if (!run) throw new PostClassNotFoundError("The payout run was not found.");
    if (run.status !== "closed") {
      throw new PostClassConflictError(
        "Payout exceptions may be resolved only after the run is closed.",
      );
    }
    if (!input.resolutionReference?.trim()) {
      throw new PostClassValidationError(
        "A closed-run exception requires an external correction reference.",
      );
    }
    const now = new Date();
    const [resolved] = await tx.update(schema.postClassPayoutExceptions).set({
      status: "resolved",
      resolutionNote: input.resolutionNote.trim(),
      resolutionReference: input.resolutionReference?.trim() || null,
      resolvedByEmail: input.actorEmail,
      resolvedAt: now,
      version: exception.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutExceptions.id, input.exceptionId),
      eq(schema.postClassPayoutExceptions.status, "open"),
      eq(schema.postClassPayoutExceptions.version, input.expectedVersion),
    )).returning();
    if (!resolved) throw new PostClassConflictError("The exception was resolved elsewhere.");
    await tx.update(schema.postClassPayoutRuns).set({
      version: sql`${schema.postClassPayoutRuns.version} + 1`,
      updatedAt: now,
    }).where(eq(schema.postClassPayoutRuns.id, resolved.runId));
    return resolved;
  });
}

export interface PayoutCloseBlocker {
  code:
    | "missing_run"
    | "not_published"
    | "active_operation"
    | "active_sync"
    | "csv_missing"
    | "coverage"
    | "source_changed"
    | "written_payload_changed"
    | "approved_unpublished"
    | "incomplete_lines"
    | "incomplete_adjustments"
    | "open_exceptions";
  message: string;
  count?: number;
}

export interface PayoutRunCloseReadiness {
  run: PayoutRun | null;
  ready: boolean;
  blockers: PayoutCloseBlocker[];
}

/** Read-only exact dry-run of every strict close gate. */
export async function inspectPayoutRunCloseReadiness(
  db: Database,
  input: { anchorMonth: string; now?: Date },
): Promise<PayoutRunCloseReadiness> {
  const run = await getPayoutRunByAnchor(db, input.anchorMonth);
  if (!run) {
    const blockers: PayoutCloseBlocker[] = [{
      code: "missing_run",
      message: "Payout run not found.",
    }];
    return { run: null, ready: false, blockers };
  }
  const blockers: PayoutCloseBlocker[] = [];
  if (run.status !== "published") {
    blockers.push({
      code: "not_published",
      message: "Only a fully published payout run can be closed.",
    });
  }
  if (run.leaseToken && run.leaseExpiresAt && run.leaseExpiresAt > (input.now ?? new Date())) {
    blockers.push({
      code: "active_operation",
      message: "A payout operation is still active.",
    });
  }
  const [runningSync] = await db.select({
    id: schema.postClassSyncRuns.id,
  }).from(schema.postClassSyncRuns)
    .where(eq(schema.postClassSyncRuns.status, "running"))
    .limit(1);
  if (runningSync) {
    blockers.push({
      code: "active_sync",
      message: "A post-class source sync is active.",
    });
  }
  if (run.csvStatus !== "uploaded" || !run.csvFileId) {
    blockers.push({
      code: "csv_missing",
      message: "Upload the payout CSV successfully before closing.",
    });
  }
  const window: PayoutRunWindow = {
    anchorMonth: input.anchorMonth,
    windowStart: run.windowStart,
    windowEnd: run.windowEnd,
  };
  const snapshot = await readPayoutRunPreview(db, {
    window,
    tutorFilter: null,
  });
  const {
    candidates,
    lines,
    exceptions,
    coverage,
    adjustments,
  } = snapshot;
  const publishedFingerprint = run.publishAcknowledgements?.sourceFingerprint;
  if (
    !publishedFingerprint
    || run.publishAcknowledgements?.tutorFilter !== null
    || snapshot.sourceFingerprint !== publishedFingerprint
  ) {
    blockers.push({
      code: "source_changed",
      message: "The payout source changed after publication; publish a fresh complete pass before closing.",
    });
  }
  const driftedWrittenLines = await findWrittenPayoutLinePayloadDrift(
    db,
    lines,
    snapshot.tutorNames,
  );
  if (driftedWrittenLines.length > 0) {
    blockers.push({
      code: "written_payload_changed",
      message: "A written payout row no longer matches its immutable source payload; finance review and compensation or an external exception are required.",
      count: driftedWrittenLines.length,
    });
  }
  try {
    assertPayoutRunPublishable(coverage);
  } catch (error) {
    blockers.push({
      code: "coverage",
      message: error instanceof Error ? error.message : "Payout coverage is incomplete.",
    });
  }
  const writtenIds = new Set(
    lines.filter((line) => line.writeStatus === "written").map((line) => line.deductionId),
  );
  const approvedUnpublished = candidates.filter(
    (candidate) => !writtenIds.has(candidate.deductionId),
  ).length;
  if (approvedUnpublished > 0) {
    blockers.push({
      code: "approved_unpublished",
      message: "Approved deductions remain unpublished.",
      count: approvedUnpublished,
    });
  }
  const incompleteLines = lines.filter((line) =>
    line.retiredAt === null && line.writeStatus !== "written").length;
  if (incompleteLines > 0) {
    blockers.push({
      code: "incomplete_lines",
      message: "Payout lines remain incomplete.",
      count: incompleteLines,
    });
  }
  const incompleteAdjustments = adjustments.filter(
    (adjustment) => adjustment.status !== "written").length;
  if (incompleteAdjustments > 0) {
    blockers.push({
      code: "incomplete_adjustments",
      message: "Payout corrections remain incomplete.",
      count: incompleteAdjustments,
    });
  }
  const openExceptions = exceptions.filter((exception) => exception.status === "open").length;
  if (openExceptions > 0) {
    blockers.push({
      code: "open_exceptions",
      message: "Resolve every payout exception before closing.",
      count: openExceptions,
    });
  }
  return { run, ready: blockers.length === 0, blockers };
}

export async function closePayoutRun(db: Database, input: {
  anchorMonth: string;
  actorEmail: string;
  expectedVersion: number;
  closeReason: string;
}): Promise<PayoutRun> {
  if (!input.closeReason.trim()) {
    throw new PostClassValidationError("A close reason is required.");
  }
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const readiness = await inspectPayoutRunCloseReadiness(tx, {
      anchorMonth: input.anchorMonth,
    });
    const run = readiness.run;
    if (!run) throw new PostClassNotFoundError("Payout run not found.");
    if (run.status === "closed") return run;
    if (run.version !== input.expectedVersion) {
      throw new PostClassConflictError("This payout run changed. Refresh before closing it.");
    }
    if (!readiness.ready) {
      throw new PostClassConflictError(
        readiness.blockers.map((blocker) => blocker.message).join(" "),
      );
    }
    const now = new Date();
    const [closed] = await tx.update(schema.postClassPayoutRuns).set({
      status: "closed",
      closedByEmail: input.actorEmail,
      closedAt: now,
      closeReason: input.closeReason.trim(),
      version: run.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRuns.id, run.id),
      eq(schema.postClassPayoutRuns.status, "published"),
      eq(schema.postClassPayoutRuns.version, input.expectedVersion),
    )).returning();
    if (!closed) throw new PostClassConflictError("The payout run changed while closing.");
    return closed;
  });
}

export async function claimPayoutCsvRetry(db: Database, input: {
  anchorMonth: string;
  actorEmail: string;
  expectedVersion: number;
  now?: Date;
}): Promise<{ run: PayoutRun; leaseToken: string }> {
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const now = input.now ?? new Date();
    const [run] = await tx.select().from(schema.postClassPayoutRuns)
      .where(eq(
        schema.postClassPayoutRuns.anchorMonth,
        anchorMonthDate(input.anchorMonth),
      )).limit(1);
    if (!run) throw new PostClassNotFoundError("Payout run not found.");
    if (run.status !== "partial" && run.status !== "published") {
      throw new PostClassConflictError("The payout run is not ready for a CSV retry.");
    }
    const abandonedPendingRetry = run.csvStatus === "pending"
      && (!run.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt <= now);
    if (run.csvStatus !== "failed" && !abandonedPendingRetry) {
      throw new PostClassConflictError(
        "Only a failed payout CSV may be retried; an uploaded artifact is immutable.",
      );
    }
    if (run.version !== input.expectedVersion) {
      throw new PostClassConflictError("This payout run changed. Refresh before retrying the CSV.");
    }
    if (run.leaseToken && run.leaseExpiresAt && run.leaseExpiresAt > now) {
      throw new PostClassConflictError("Another payout operation is still active.");
    }
    const leaseToken = randomUUID();
    const [claimed] = await tx.update(schema.postClassPayoutRuns).set({
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + PAYOUT_RUN_LEASE_MS),
      publishingByEmail: input.actorEmail,
      csvStatus: "pending",
      csvError: null,
      version: run.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRuns.id, run.id),
      eq(schema.postClassPayoutRuns.version, input.expectedVersion),
    )).returning();
    if (!claimed) throw new PostClassConflictError("Another CSV retry started first.");
    if (abandonedPendingRetry) {
      await tx.insert(schema.postClassConfigAuditLog).values({
        entityType: "payout_run",
        entityKey: run.id,
        action: "expire_csv_retry_lease",
        actorEmail: input.actorEmail,
        beforeValue: {
          csvStatus: run.csvStatus,
          version: run.version,
          leaseToken: run.leaseToken,
          leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null,
          publishingByEmail: run.publishingByEmail,
        },
        afterValue: {
          csvStatus: claimed.csvStatus,
          version: claimed.version,
          leaseToken: claimed.leaseToken,
          leaseExpiresAt: claimed.leaseExpiresAt?.toISOString() ?? null,
          publishingByEmail: claimed.publishingByEmail,
        },
        note: "Expired payout CSV retry reclaimed after its outcome was not persisted.",
      });
    }
    return { run: claimed, leaseToken };
  });
}

export async function finalizePayoutCsvRetry(db: Database, input: {
  runId: string;
  leaseToken: string;
  expectedVersion: number;
  csvFileId: string | null;
  csvUrl: string | null;
  csvError: string | null;
}): Promise<PayoutRun> {
  const [run] = await db.update(schema.postClassPayoutRuns).set({
    leaseToken: null,
    leaseExpiresAt: null,
    publishingByEmail: null,
    csvStatus: input.csvFileId ? "uploaded" : "failed",
    csvFileId: input.csvFileId,
    csvUrl: input.csvUrl,
    csvError: input.csvError?.slice(0, 500) ?? null,
    csvAttemptedAt: new Date(),
    version: input.expectedVersion + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.postClassPayoutRuns.id, input.runId),
    eq(schema.postClassPayoutRuns.leaseToken, input.leaseToken),
    eq(schema.postClassPayoutRuns.version, input.expectedVersion),
    gt(schema.postClassPayoutRuns.leaseExpiresAt, new Date()),
  )).returning();
  if (!run) throw new PostClassConflictError("The CSV retry lost its run lease.");
  return run;
}

export interface PayoutWorkbookRegistryRow {
  canonicalTutorKey: string;
  spreadsheetId: string;
  sheetName: string;
  sheetGid: number;
}

/** Compatibility registry seam for roll scripts; callers need no schema import. */
export async function loadActivePayoutWorkbookRegistry(
  db: Database = getDb(),
): Promise<PayoutWorkbookRegistryRow[]> {
  return db.select({
    canonicalTutorKey: schema.postClassTutorPayoutSheets.canonicalKey,
    spreadsheetId: schema.postClassTutorPayoutSheets.spreadsheetId,
    sheetName: schema.postClassTutorPayoutSheets.sheetName,
    sheetGid: schema.postClassTutorPayoutSheets.sheetGid,
  }).from(schema.postClassTutorPayoutSheets)
    .where(eq(schema.postClassTutorPayoutSheets.active, true))
    .orderBy(asc(schema.postClassTutorPayoutSheets.canonicalKey));
}

export interface PayoutWorkbookRollTarget {
  spreadsheetId: string;
  workbookName: string;
  canonicalTutorKey?: string | null;
}

export interface PayoutWorkbookRollLease {
  rollRun: PayoutRollRun;
  leaseToken: string;
  outcomes: PayoutRollOutcome[];
}

interface PayoutWorkbookRollEvidence {
  status: "pending" | "already_target" | "verified" | "failed";
  beforeStartSerial: number | null;
  beforeEndSerial: number | null;
  afterStartSerial: number | null;
  afterEndSerial: number | null;
  previousWindowStart: string | null;
  previousWindowEnd: string | null;
  appliedWindowStart: string | null;
  appliedWindowEnd: string | null;
  error?: string | null;
}

function payoutGoogleDateSerial(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000) + 25_569;
}

function payoutRollRunAuditValue(
  rollRun: PayoutRollRun,
): Record<string, unknown> {
  return {
    rollRunId: rollRun.id,
    payoutRunId: rollRun.payoutRunId,
    manifestHash: rollRun.manifestHash,
    status: rollRun.status,
    version: rollRun.version,
    leaseToken: rollRun.leaseToken,
    leaseExpiresAt: rollRun.leaseExpiresAt.toISOString(),
    startedByEmail: rollRun.startedByEmail,
    startedAt: rollRun.startedAt.toISOString(),
    completedAt: rollRun.completedAt?.toISOString() ?? null,
  };
}

function payoutRollOutcomeAuditValue(
  outcome: PayoutRollOutcome,
  manifestHash: string,
): Record<string, unknown> {
  return {
    rollRunId: outcome.rollRunId,
    manifestHash,
    workbookId: outcome.workbookId,
    workbookName: outcome.workbookName,
    status: outcome.status,
    version: outcome.version,
    beforeStartSerial: outcome.beforeStartSerial,
    beforeEndSerial: outcome.beforeEndSerial,
    afterStartSerial: outcome.afterStartSerial,
    afterEndSerial: outcome.afterEndSerial,
    previousWindowStart: outcome.previousWindowStart,
    previousWindowEnd: outcome.previousWindowEnd,
    appliedWindowStart: outcome.appliedWindowStart,
    appliedWindowEnd: outcome.appliedWindowEnd,
    error: outcome.error,
    attemptedAt: outcome.attemptedAt?.toISOString() ?? null,
  };
}

function assertPayoutWorkbookRollSuccessEvidence(
  evidence: PayoutWorkbookRollEvidence,
  rollRun: PayoutRollRun,
  sourceRun: PayoutRun,
): void {
  if (evidence.status !== "verified" && evidence.status !== "already_target") return;
  const expectedTargetStart = payoutGoogleDateSerial(rollRun.targetWindowStart);
  const expectedTargetEnd = payoutGoogleDateSerial(rollRun.targetWindowEnd);
  const expectedBeforeStart = evidence.status === "verified"
    ? payoutGoogleDateSerial(sourceRun.windowStart)
    : expectedTargetStart;
  const expectedBeforeEnd = evidence.status === "verified"
    ? payoutGoogleDateSerial(sourceRun.windowEnd)
    : expectedTargetEnd;
  const exactEvidence = evidence.beforeStartSerial === expectedBeforeStart
    && evidence.beforeEndSerial === expectedBeforeEnd
    && evidence.afterStartSerial === expectedTargetStart
    && evidence.afterEndSerial === expectedTargetEnd
    && evidence.previousWindowStart === sourceRun.windowStart
    && evidence.previousWindowEnd === sourceRun.windowEnd
    && evidence.appliedWindowStart === rollRun.targetWindowStart
    && evidence.appliedWindowEnd === rollRun.targetWindowEnd
    && !evidence.error;
  if (!exactEvidence) {
    throw new PostClassValidationError(
      "A successful workbook roll requires exact before/after serials and source/target windows.",
    );
  }
}

/**
 * Claim/resume the database side of a workbook date roll.
 *
 * The caller performs each Google update outside this transaction and records
 * its verified outcome separately.
 */
export async function beginOrResumePayoutWorkbookRoll(
  db: Database,
  input: {
    anchorMonth: string;
    closedRunId: string;
    targetAnchorMonth: string;
    manifestHash: string;
    actorEmail: string;
    workbooks: PayoutWorkbookRollTarget[];
    now?: Date;
  },
): Promise<PayoutWorkbookRollLease> {
  if (!input.manifestHash.trim()) {
    throw new PostClassValidationError("A workbook manifest hash is required.");
  }
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const [payoutRun] = await tx.select().from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, input.closedRunId)).limit(1);
    if (!payoutRun || payoutRun.anchorMonth !== anchorMonthDate(input.anchorMonth)) {
      throw new PostClassNotFoundError("Closed payout run not found.");
    }
    if (payoutRun.status !== "closed") {
      throw new PostClassConflictError("Close the payout run before rolling workbook dates.");
    }
    const target = payoutRunWindow(input.targetAnchorMonth);
    const expectedTarget = payoutRunWindowForBangkokDate(
      `${payoutRun.anchorMonth.slice(0, 7)}-26`,
    );
    if (target.anchorMonth !== expectedTarget.anchorMonth) {
      throw new PostClassValidationError(
        `The closed ${payoutRun.anchorMonth.slice(0, 7)} run may roll only to`
        + ` ${expectedTarget.anchorMonth}.`,
      );
    }
    const now = input.now ?? new Date();
    const [existing] = await tx.select().from(schema.postClassPayoutRollRuns)
      .where(eq(schema.postClassPayoutRollRuns.payoutRunId, payoutRun.id))
      .limit(1);
    if (
      existing
      && existing.targetAnchorMonth !== anchorMonthDate(input.targetAnchorMonth)
    ) {
      throw new PostClassConflictError(
        "This closed payout run already has a different date-roll target.",
      );
    }
    if (existing && existing.manifestHash !== input.manifestHash) {
      throw new PostClassConflictError(
        "The workbook fleet changed since this date roll started.",
      );
    }
    if (existing?.status === "completed") {
      const outcomes = await tx.select().from(schema.postClassPayoutRollOutcomes)
        .where(eq(schema.postClassPayoutRollOutcomes.rollRunId, existing.id))
        .orderBy(asc(schema.postClassPayoutRollOutcomes.workbookName));
      return { rollRun: existing, leaseToken: existing.leaseToken, outcomes };
    }
    if (
      existing?.status === "running"
      && existing.leaseExpiresAt > now
    ) {
      throw new PostClassConflictError(
        `Another workbook roll is active until ${existing.leaseExpiresAt.toISOString()}.`,
      );
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + PAYOUT_RUN_LEASE_MS);
    let rollRun: PayoutRollRun;
    if (existing) {
      const failedOutcomes = await tx.select()
        .from(schema.postClassPayoutRollOutcomes)
        .where(and(
          eq(schema.postClassPayoutRollOutcomes.rollRunId, existing.id),
          eq(schema.postClassPayoutRollOutcomes.status, "failed"),
        ));
      const [resumed] = await tx.update(schema.postClassPayoutRollRuns).set({
        status: "running",
        leaseToken,
        leaseExpiresAt,
        startedByEmail: input.actorEmail,
        startedAt: now,
        completedAt: null,
        version: existing.version + 1,
        updatedAt: now,
      }).where(and(
        eq(schema.postClassPayoutRollRuns.id, existing.id),
        eq(schema.postClassPayoutRollRuns.version, existing.version),
      )).returning();
      if (!resumed) throw new PostClassConflictError("The workbook roll changed.");
      rollRun = resumed;
      const resetOutcomes = await tx.update(schema.postClassPayoutRollOutcomes).set({
        status: "pending",
        error: null,
        version: sql`${schema.postClassPayoutRollOutcomes.version} + 1`,
        updatedAt: now,
      }).where(and(
        eq(schema.postClassPayoutRollOutcomes.rollRunId, rollRun.id),
        eq(schema.postClassPayoutRollOutcomes.status, "failed"),
      )).returning();
      await tx.insert(schema.postClassConfigAuditLog).values({
        entityType: "payout_roll_run",
        entityKey: existing.id,
        action: "resume_payout_workbook_roll",
        actorEmail: input.actorEmail,
        beforeValue: payoutRollRunAuditValue(existing),
        afterValue: payoutRollRunAuditValue(resumed),
        note: `Resumed payout workbook roll ${existing.id} for manifest ${existing.manifestHash}.`,
      });
      if (resetOutcomes.length > 0) {
        const failedById = new Map(
          failedOutcomes.map((outcome) => [outcome.id, outcome]),
        );
        await tx.insert(schema.postClassConfigAuditLog).values(
          resetOutcomes.map((outcome) => ({
            entityType: "payout_roll_outcome",
            entityKey: outcome.id,
            action: "reset_payout_workbook_roll_outcome",
            actorEmail: input.actorEmail,
            beforeValue: payoutRollOutcomeAuditValue(
              failedById.get(outcome.id)!,
              existing.manifestHash,
            ),
            afterValue: payoutRollOutcomeAuditValue(
              outcome,
              resumed.manifestHash,
            ),
            note: `Reset failed workbook ${outcome.workbookId} while resuming roll ${resumed.id}.`,
          })),
        );
      }
    } else {
      const [created] = await tx.insert(schema.postClassPayoutRollRuns).values({
        payoutRunId: payoutRun.id,
        targetAnchorMonth: anchorMonthDate(input.targetAnchorMonth),
        targetWindowStart: target.windowStart,
        targetWindowEnd: target.windowEnd,
        manifestHash: input.manifestHash,
        status: "running",
        leaseToken,
        leaseExpiresAt,
        startedByEmail: input.actorEmail,
        startedAt: now,
        totalWorkbooks: input.workbooks.length,
      }).returning();
      rollRun = created;
      if (input.workbooks.length > 0) {
        await tx.insert(schema.postClassPayoutRollOutcomes).values(
          input.workbooks.map((workbook) => ({
            rollRunId: rollRun.id,
            workbookId: workbook.spreadsheetId,
            workbookName: workbook.workbookName,
            canonicalTutorKey: workbook.canonicalTutorKey ?? null,
          })),
        );
      }
    }
    await tx.update(schema.postClassPayoutRuns).set({
      dateRollStatus: "running",
      dateRollStartedAt: now,
      rolledToAnchorMonth: anchorMonthDate(input.targetAnchorMonth),
      version: payoutRun.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRuns.id, payoutRun.id),
      eq(schema.postClassPayoutRuns.version, payoutRun.version),
    ));
    const outcomes = await tx.select().from(schema.postClassPayoutRollOutcomes)
      .where(eq(schema.postClassPayoutRollOutcomes.rollRunId, rollRun.id))
      .orderBy(asc(schema.postClassPayoutRollOutcomes.workbookName));
    return { rollRun, leaseToken, outcomes };
  });
}

/** CAS-fenced verified outcome for one workbook, after its Google call returns. */
export async function recordPayoutWorkbookRollOutcome(
  db: Database,
  input: {
    rollRunId: string;
    leaseToken: string;
    spreadsheetId: string;
    expectedVersion: number;
    status: "already_target" | "verified" | "failed";
    beforeStartSerial: number | null;
    beforeEndSerial: number | null;
    afterStartSerial: number | null;
    afterEndSerial: number | null;
    previousWindowStart: string | null;
    previousWindowEnd: string | null;
    appliedWindowStart: string | null;
    appliedWindowEnd: string | null;
    error?: string | null;
    attemptedAt?: Date;
  },
): Promise<PayoutRollOutcome> {
  return withPostClassTransaction(db, async (tx) => {
    const leaseNow = new Date();
    const [rollRun] = await tx.select().from(schema.postClassPayoutRollRuns)
      .where(and(
        eq(schema.postClassPayoutRollRuns.id, input.rollRunId),
        eq(schema.postClassPayoutRollRuns.status, "running"),
        eq(schema.postClassPayoutRollRuns.leaseToken, input.leaseToken),
        gt(schema.postClassPayoutRollRuns.leaseExpiresAt, leaseNow),
      )).limit(1);
    if (!rollRun) {
      throw new PostClassConflictError("The workbook outcome lost its roll lease.");
    }
    const [sourceRun] = await tx.select().from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, rollRun.payoutRunId))
      .limit(1);
    if (!sourceRun) throw new PostClassNotFoundError("The source payout run was not found.");
    const [before] = await tx.select()
      .from(schema.postClassPayoutRollOutcomes)
      .where(and(
        eq(schema.postClassPayoutRollOutcomes.rollRunId, input.rollRunId),
        eq(schema.postClassPayoutRollOutcomes.workbookId, input.spreadsheetId),
      ))
      .limit(1);
    if (!before) {
      throw new PostClassNotFoundError("The workbook roll outcome was not found.");
    }
    if (before.status !== "pending" && before.status !== "failed") {
      throw new PostClassConflictError(
        "Verified workbook roll evidence is immutable.",
      );
    }
    assertPayoutWorkbookRollSuccessEvidence(input, rollRun, sourceRun);

    const attemptedAt = input.attemptedAt ?? new Date();
    const [outcome] = await tx.update(schema.postClassPayoutRollOutcomes).set({
      status: input.status,
      beforeStartSerial: input.beforeStartSerial,
      beforeEndSerial: input.beforeEndSerial,
      afterStartSerial: input.afterStartSerial,
      afterEndSerial: input.afterEndSerial,
      previousWindowStart: input.previousWindowStart,
      previousWindowEnd: input.previousWindowEnd,
      appliedWindowStart: input.appliedWindowStart,
      appliedWindowEnd: input.appliedWindowEnd,
      error: input.error?.slice(0, 500) ?? null,
      attemptedAt,
      version: input.expectedVersion + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.postClassPayoutRollOutcomes.rollRunId, input.rollRunId),
      eq(schema.postClassPayoutRollOutcomes.workbookId, input.spreadsheetId),
      eq(schema.postClassPayoutRollOutcomes.version, input.expectedVersion),
      inArray(schema.postClassPayoutRollOutcomes.status, ["pending", "failed"]),
      sql`exists (
        select 1 from ${schema.postClassPayoutRollRuns}
        where ${schema.postClassPayoutRollRuns.id} = ${input.rollRunId}
          and ${schema.postClassPayoutRollRuns.status} = 'running'
          and ${schema.postClassPayoutRollRuns.leaseToken} = ${input.leaseToken}::uuid
          and ${schema.postClassPayoutRollRuns.leaseExpiresAt} > now()
      )`,
    )).returning();
    if (!outcome) {
      throw new PostClassConflictError("The workbook outcome lost its roll lease or version.");
    }
    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "payout_roll_outcome",
      entityKey: outcome.id,
      action: "record_payout_workbook_roll_outcome",
      actorEmail: rollRun.startedByEmail,
      beforeValue: payoutRollOutcomeAuditValue(before, rollRun.manifestHash),
      afterValue: payoutRollOutcomeAuditValue(outcome, rollRun.manifestHash),
      note: `Recorded workbook ${outcome.workbookId} outcome for roll ${rollRun.id}.`,
    });
    return outcome;
  });
}

export async function finalizePayoutWorkbookRoll(
  db: Database,
  input: {
    rollRunId: string;
    leaseToken: string;
    actorEmail: string;
  },
): Promise<{ rollRun: PayoutRollRun; outcomes: PayoutRollOutcome[] }> {
  return withPostClassTransaction(db, async (tx) => {
    const [current] = await tx.select().from(schema.postClassPayoutRollRuns)
      .where(and(
        eq(schema.postClassPayoutRollRuns.id, input.rollRunId),
        eq(schema.postClassPayoutRollRuns.status, "running"),
        eq(schema.postClassPayoutRollRuns.leaseToken, input.leaseToken),
        gt(schema.postClassPayoutRollRuns.leaseExpiresAt, new Date()),
      )).limit(1);
    if (!current) throw new PostClassConflictError("The workbook roll lease was lost.");
    const [sourceRun] = await tx.select().from(schema.postClassPayoutRuns)
      .where(eq(schema.postClassPayoutRuns.id, current.payoutRunId))
      .limit(1);
    if (!sourceRun) throw new PostClassNotFoundError("The source payout run was not found.");
    const outcomes = await tx.select().from(schema.postClassPayoutRollOutcomes)
      .where(eq(schema.postClassPayoutRollOutcomes.rollRunId, current.id))
      .orderBy(asc(schema.postClassPayoutRollOutcomes.workbookName));
    if (outcomes.length !== current.totalWorkbooks) {
      throw new PostClassConflictError(
        "The workbook roll outcome set does not match its audited fleet size.",
      );
    }
    for (const outcome of outcomes) {
      assertPayoutWorkbookRollSuccessEvidence(outcome, current, sourceRun);
    }
    const succeeded = outcomes.filter((outcome) =>
      outcome.status === "verified" || outcome.status === "already_target").length;
    const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
    const pending = outcomes.filter((outcome) => outcome.status === "pending").length;
    const status = pending === 0 && failed === 0
      ? "completed" as const
      : succeeded === 0 && failed > 0 && pending === 0
        ? "failed" as const
        : "partial" as const;
    const now = new Date();
    const [rollRun] = await tx.update(schema.postClassPayoutRollRuns).set({
      status,
      completedAt: now,
      succeededWorkbooks: succeeded,
      failedWorkbooks: failed + pending,
      version: current.version + 1,
      updatedAt: now,
    }).where(and(
      eq(schema.postClassPayoutRollRuns.id, current.id),
      eq(schema.postClassPayoutRollRuns.leaseToken, input.leaseToken),
      eq(schema.postClassPayoutRollRuns.version, current.version),
      gt(schema.postClassPayoutRollRuns.leaseExpiresAt, now),
    )).returning();
    if (!rollRun) throw new PostClassConflictError("The workbook roll finalizer lost its lease.");
    await tx.update(schema.postClassPayoutRuns).set({
      dateRollStatus: status === "completed" ? "completed" : "partial",
      dateRolledAt: status === "completed" ? now : null,
      dateRolledByEmail: input.actorEmail,
      version: sql`${schema.postClassPayoutRuns.version} + 1`,
      updatedAt: now,
    }).where(eq(schema.postClassPayoutRuns.id, current.payoutRunId));
    return { rollRun, outcomes };
  });
}
