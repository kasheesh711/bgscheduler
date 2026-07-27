import "server-only";

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import {
  PostClassConflictError,
  PostClassNotFoundError,
  PostClassValidationError,
} from "./errors";
import { withPostClassTransaction } from "./transaction";

export const POST_CLASS_WAIVER_CATEGORIES = [
  "wise_system_outage",
  "incorrect_session_tutor_data",
  "pre_approved_exception",
  "tutor_emergency",
  "duplicate_system_error",
  "other",
] as const;

export type PostClassWaiverCategory = (typeof POST_CLASS_WAIVER_CATEGORIES)[number];

interface Actor {
  email: string;
  name?: string;
}

interface ReviewInput {
  deductionId: string;
  action: "approve" | "waive" | "reopen";
  note: string;
  waiverCategory?: PostClassWaiverCategory;
  expectedVersion: number;
  idempotencyKey: string;
}

interface FinanceInput {
  deductionId: string;
  action: "move" | "process" | "reverse";
  processingMonth: string;
  referenceNote: string;
  reason?: string;
  expectedVersion: number;
  idempotencyKey: string;
}

type FinancePeriodChangeInput = {
  month: string;
  reason?: string;
} & (
  | {
    action: "open";
    idempotencyKey: string;
    expectedVersion?: never;
  }
  | {
    action: "close" | "reopen";
    expectedVersion: number;
    idempotencyKey?: string;
  }
);

type FinancePeriodStatus = "open" | "closed";

interface DeductionCandidateEvidence {
  sessionEligible: boolean;
  sessionSourceStatus: string;
  formMappingValid: boolean;
  hasBlockingGlobalSourceIssue: boolean;
  assessment: {
    sourceReady: boolean;
    sourceStatus: string;
    enforcementMode: string;
    objectiveViolation: boolean;
    rawOnTime: boolean;
    adjustedCompliant: boolean;
    policyApplies: boolean;
  } | null;
}

const POST_CLASS_FINANCE_LOCK_KEY = "post_class_feedback_finance";

/**
 * Finance-period state and deduction transitions share one transaction lock.
 * Keeping the lock feature-wide is deliberate: a deduction with an implicit
 * default month must serialize with a close of that month just as an explicitly
 * assigned deduction does.
 *
 * Exported so the payout run can take the same lock while it selects its lines.
 * Callers must reuse this rather than re-declaring the key string: a typo would
 * take a *different* lock, silently removing all serialization, and no test
 * could catch it.
 */
export async function lockPostClassFinance(db: Database): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${POST_CLASS_FINANCE_LOCK_KEY}))`);
}

/** Pure invariant used by the approval path and focused concurrency tests. */
export function assertPostClassApprovalPeriodInvariant(input: {
  financePeriodId: string | null;
  assignedPeriodStatus: FinancePeriodStatus | null;
  defaultPeriodStatus: FinancePeriodStatus | null;
}): void {
  const status = input.financePeriodId
    ? input.assignedPeriodStatus
    : input.defaultPeriodStatus;
  if (input.financePeriodId && status === null) {
    throw new PostClassValidationError("The assigned finance period could not be verified.");
  }
  if (status === "closed") {
    throw new PostClassValidationError(
      "Reopen the deduction's finance period before approving it.",
    );
  }
}

export function assertPostClassFinanceMonthActionInvariant(input: {
  action: FinanceInput["action"];
  requestedMonth: string;
  defaultMonth: string;
  assignedMonth: string;
}): void {
  if (input.requestedMonth < input.defaultMonth) {
    throw new PostClassValidationError("A deduction cannot move before its class month.");
  }
  if (input.action === "process" && input.requestedMonth !== input.assignedMonth) {
    throw new PostClassValidationError(
      `Move the deduction to ${input.requestedMonth.slice(0, 7)} before processing it there.`,
    );
  }
  if (input.action === "move") {
    if (input.requestedMonth === input.defaultMonth) {
      throw new PostClassValidationError("A moved deduction must use a later month than its class month.");
    }
    if (input.requestedMonth === input.assignedMonth) {
      throw new PostClassValidationError("The deduction is already assigned to that finance period.");
    }
  }
}

export function assertPostClassDeductionCandidateStillActionable(
  evidence: DeductionCandidateEvidence,
): void {
  if (!evidence.sessionEligible) {
    throw new PostClassValidationError("The session is no longer eligible for a deduction.");
  }
  if (
    evidence.sessionSourceStatus !== "ready" ||
    !evidence.formMappingValid ||
    evidence.hasBlockingGlobalSourceIssue ||
    !evidence.assessment ||
    !evidence.assessment.sourceReady ||
    evidence.assessment.sourceStatus !== "ready"
  ) {
    throw new PostClassValidationError(
      "Current Wise evidence is paused or ambiguous; resync before continuing.",
    );
  }
  if (
    evidence.assessment.enforcementMode !== "live" ||
    !evidence.assessment.policyApplies
  ) {
    throw new PostClassValidationError("The current assessment is outside live enforcement.");
  }
  if (evidence.assessment.rawOnTime || evidence.assessment.adjustedCompliant) {
    throw new PostClassValidationError("The session is compliant and cannot be deducted.");
  }
  if (!evidence.assessment.objectiveViolation) {
    throw new PostClassValidationError("The current assessment is no longer an objective violation.");
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new PostClassValidationError(`${label} is required.`);
  return normalized;
}

function requireMonth(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new PostClassValidationError("Processing month must use YYYY-MM.");
  }
  return value;
}

async function loadDeduction(
  db: Database,
  deductionId: string,
): Promise<typeof schema.postClassDeductions.$inferSelect> {
  const [row] = await db
    .select()
    .from(schema.postClassDeductions)
    .where(eq(schema.postClassDeductions.id, deductionId))
    .limit(1);
  if (!row) throw new PostClassNotFoundError("Deduction was not found.");
  return row;
}

async function loadOpenPeriod(db: Database, month: string) {
  const [period] = await db
    .select()
    .from(schema.postClassFinancePeriods)
    .where(eq(schema.postClassFinancePeriods.month, month))
    .limit(1);
  if (!period || period.status !== "open") {
    throw new PostClassValidationError(`${month} is not an open finance period.`);
  }
  return period;
}

async function assignedFinanceMonth(
  db: Database,
  deduction: typeof schema.postClassDeductions.$inferSelect,
): Promise<string> {
  if (!deduction.financePeriodId) return deduction.defaultFinanceMonth;
  const [period] = await db.select({ month: schema.postClassFinancePeriods.month })
    .from(schema.postClassFinancePeriods)
    .where(eq(schema.postClassFinancePeriods.id, deduction.financePeriodId))
    .limit(1);
  if (!period) throw new PostClassNotFoundError("The assigned finance period was not found.");
  return period.month;
}

async function assertApprovalPeriodOpen(
  db: Database,
  deduction: typeof schema.postClassDeductions.$inferSelect,
): Promise<void> {
  const [period] = deduction.financePeriodId
    ? await db
      .select({ status: schema.postClassFinancePeriods.status })
      .from(schema.postClassFinancePeriods)
      .where(eq(schema.postClassFinancePeriods.id, deduction.financePeriodId))
      .limit(1)
    : await db
      .select({ status: schema.postClassFinancePeriods.status })
      .from(schema.postClassFinancePeriods)
      .where(eq(schema.postClassFinancePeriods.month, deduction.defaultFinanceMonth))
      .limit(1);
  assertPostClassApprovalPeriodInvariant({
    financePeriodId: deduction.financePeriodId,
    assignedPeriodStatus: deduction.financePeriodId ? period?.status ?? null : null,
    defaultPeriodStatus: deduction.financePeriodId ? null : period?.status ?? null,
  });
}

function policyApplies(details: unknown): boolean {
  return Boolean(
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    (details as Record<string, unknown>).policyApplies === true,
  );
}

async function revalidateDeductionCandidate(
  db: Database,
  deduction: typeof schema.postClassDeductions.$inferSelect,
): Promise<void> {
  // Lock the mutable source projection and settings row so a sync or mapping
  // change cannot invalidate the evidence between this check and the decision.
  await db.execute(sql`
    select id
    from post_class_sessions
    where id = ${deduction.sessionId}
    for update
  `);
  await db.execute(sql`
    select id
    from post_class_settings
    where id = 'default'
    for share
  `);
  const [[session], [settings], [blockingIssue]] = await Promise.all([
    db.select({
      eligible: schema.postClassSessions.eligible,
      sourceStatus: schema.postClassSessions.sourceStatus,
    }).from(schema.postClassSessions)
      .where(eq(schema.postClassSessions.id, deduction.sessionId))
      .limit(1),
    db.select({
      policyVersion: schema.postClassSettings.policyVersion,
      mappingVersion: schema.postClassSettings.formMappingVersion,
      formMappingValid: schema.postClassSettings.formMappingValid,
    }).from(schema.postClassSettings).where(eq(schema.postClassSettings.id, "default")).limit(1),
    db.select({ id: schema.postClassSourceIssues.id })
      .from(schema.postClassSourceIssues)
      .where(and(
        eq(schema.postClassSourceIssues.scope, "global"),
        eq(schema.postClassSourceIssues.status, "open"),
        eq(schema.postClassSourceIssues.blocksEnforcement, true),
      )).limit(1),
  ]);
  if (!session || !settings) {
    throw new PostClassValidationError("Current deduction evidence could not be verified.");
  }
  const [assessment] = await db.select({
    sourceReady: schema.postClassAssessments.sourceReady,
    sourceStatus: schema.postClassAssessments.sourceStatus,
    enforcementMode: schema.postClassAssessments.enforcementMode,
    objectiveViolation: schema.postClassAssessments.objectiveViolation,
    rawOnTime: schema.postClassAssessments.rawOnTime,
    adjustedCompliant: schema.postClassAssessments.adjustedCompliant,
    details: schema.postClassAssessments.details,
  }).from(schema.postClassAssessments).where(and(
    eq(schema.postClassAssessments.sessionId, deduction.sessionId),
    eq(schema.postClassAssessments.policyVersion, settings.policyVersion),
    eq(schema.postClassAssessments.mappingVersion, settings.mappingVersion),
  )).orderBy(
    desc(schema.postClassAssessments.assessedAt),
    desc(schema.postClassAssessments.createdAt),
  ).limit(1);
  assertPostClassDeductionCandidateStillActionable({
    sessionEligible: session.eligible,
    sessionSourceStatus: session.sourceStatus,
    formMappingValid: settings.formMappingValid,
    hasBlockingGlobalSourceIssue: Boolean(blockingIssue),
    assessment: assessment
      ? {
        sourceReady: assessment.sourceReady,
        sourceStatus: assessment.sourceStatus,
        enforcementMode: assessment.enforcementMode,
        objectiveViolation: assessment.objectiveViolation,
        rawOnTime: assessment.rawOnTime,
        adjustedCompliant: assessment.adjustedCompliant,
        policyApplies: policyApplies(assessment.details),
      }
      : null,
  });
}

async function existingActionByKey(db: Database, key: string) {
  const [action] = await db
    .select({
      deductionId: schema.postClassDeductionActions.deductionId,
      action: schema.postClassDeductionActions.action,
      note: schema.postClassDeductionActions.note,
      reference: schema.postClassDeductionActions.reference,
      waiverCategory: schema.postClassDeductionActions.waiverCategory,
      toStatus: schema.postClassDeductionActions.toStatus,
      metadata: schema.postClassDeductionActions.metadata,
    })
    .from(schema.postClassDeductionActions)
    .where(eq(schema.postClassDeductionActions.idempotencyKey, key))
    .limit(1);
  return action ?? null;
}

function recordedExpectedVersion(
  duplicate: NonNullable<Awaited<ReturnType<typeof existingActionByKey>>>,
): number | null {
  return typeof duplicate.metadata.expectedVersion === "number"
    ? duplicate.metadata.expectedVersion
    : null;
}

export function assertPostClassFinanceIdempotentPayloadMatches(
  duplicate: NonNullable<Awaited<ReturnType<typeof existingActionByKey>>>,
  expected: {
    processingMonth: string;
    reference: string | null;
    reason: string | null;
    expectedVersion: number;
    targetStatus: "approved" | "processed" | "reversed";
  },
): void {
  const recordedMonth = typeof duplicate.metadata.processingMonth === "string"
    ? duplicate.metadata.processingMonth
    : null;
  if (
    recordedMonth !== expected.processingMonth ||
    duplicate.reference !== expected.reference ||
    duplicate.note !== expected.reason ||
    recordedExpectedVersion(duplicate) !== expected.expectedVersion ||
    duplicate.toStatus !== expected.targetStatus
  ) {
    throw new PostClassConflictError(
      "The idempotency key was already used with a different finance payload.",
    );
  }
}

export function assertPostClassReviewIdempotentPayloadMatches(
  duplicate: NonNullable<Awaited<ReturnType<typeof existingActionByKey>>>,
  expected: {
    note: string | null;
    waiverCategory: PostClassWaiverCategory | null;
    expectedVersion: number;
    targetStatus: "pending_review" | "approved" | "waived";
  },
): void {
  if (
    duplicate.note !== expected.note ||
    duplicate.waiverCategory !== expected.waiverCategory ||
    recordedExpectedVersion(duplicate) !== expected.expectedVersion ||
    duplicate.toStatus !== expected.targetStatus
  ) {
    throw new PostClassConflictError(
      "The idempotency key was already used with a different review payload.",
    );
  }
}

export function assertPostClassFinancePeriodIdempotentPayloadMatches(
  prior: {
    entityKey: string;
    action: string;
    note: string | null;
    afterValue: Record<string, unknown> | null;
  },
  expected: {
    month: string;
    action: "open" | "close" | "reopen";
    reason: string | null;
    expectedVersion: number | null;
  },
): void {
  const recordedVersion = typeof prior.afterValue?.requestedExpectedVersion === "number"
    ? prior.afterValue.requestedExpectedVersion
    : null;
  if (
    prior.entityKey !== expected.month ||
    prior.action !== expected.action ||
    prior.note !== expected.reason ||
    recordedVersion !== expected.expectedVersion
  ) {
    throw new PostClassConflictError(
      "The idempotency key was already used with different finance-period inputs.",
    );
  }
}

function assertIdempotentActionMatches(
  duplicate: Awaited<ReturnType<typeof existingActionByKey>>,
  expected: { deductionId: string; action: string },
): void {
  if (
    duplicate &&
    (duplicate.deductionId !== expected.deductionId || duplicate.action !== expected.action)
  ) {
    throw new PostClassConflictError(
      "The idempotency key was already used for a different deduction action.",
    );
  }
}

function reviewPayload(input: ReviewInput): {
  note: string | null;
  waiverCategory: PostClassWaiverCategory | null;
  expectedVersion: number;
  targetStatus: "pending_review" | "approved" | "waived";
} {
  const note = input.note.trim() || null;
  if (input.action === "waive") {
    if (!input.waiverCategory || !POST_CLASS_WAIVER_CATEGORIES.includes(input.waiverCategory)) {
      throw new PostClassValidationError("A valid waiver category is required.");
    }
    return {
      note: requireText(input.note, "Waiver note"),
      waiverCategory: input.waiverCategory,
      expectedVersion: input.expectedVersion,
      targetStatus: "waived",
    };
  }
  if (input.waiverCategory) {
    throw new PostClassValidationError("Waiver category is only valid when waiving a deduction.");
  }
  return {
    note: input.action === "reopen" ? requireText(input.note, "Reopen reason") : note,
    waiverCategory: null,
    expectedVersion: input.expectedVersion,
    targetStatus: input.action === "approve" ? "approved" : "pending_review",
  };
}

export async function applyPostClassReviewAction(
  actor: Actor,
  input: ReviewInput,
  db: Database = getDb(),
) {
  const requestedPayload = reviewPayload(input);
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const duplicate = await existingActionByKey(tx, input.idempotencyKey);
    assertIdempotentActionMatches(duplicate, input);
    if (duplicate) {
      assertPostClassReviewIdempotentPayloadMatches(duplicate, requestedPayload);
      return loadDeduction(tx, duplicate.deductionId);
    }

    const current = await loadDeduction(tx, input.deductionId);
    if (current.version !== input.expectedVersion) throw new PostClassConflictError();
    if (current.status === "processed" || current.status === "reversed") {
      throw new PostClassValidationError("Processed deductions can only be corrected by Finance reversal.");
    }

    const now = new Date();
    let toStatus: "pending_review" | "approved" | "waived";
    let waiverCategory: PostClassWaiverCategory | null = null;
    let waiverNote: string | null = null;
    let actionNote = input.note.trim() || null;

    if (input.action === "approve") {
      if (current.status !== "pending_review") {
        throw new PostClassValidationError("Only pending deductions can be approved.");
      }
      await revalidateDeductionCandidate(tx, current);
      await assertApprovalPeriodOpen(tx, current);
      toStatus = "approved";
    } else if (input.action === "waive") {
      if (current.status !== "pending_review" && current.status !== "approved") {
        throw new PostClassValidationError("Only pending or approved deductions can be waived.");
      }
      actionNote = requestedPayload.note;
      waiverCategory = requestedPayload.waiverCategory;
      waiverNote = actionNote;
      toStatus = "waived";
    } else {
      if (current.status !== "approved") {
        throw new PostClassValidationError("Only an unprocessed approved deduction can be reopened.");
      }
      actionNote = requestedPayload.note;
      toStatus = "pending_review";
    }

    const [updated] = await tx
      .update(schema.postClassDeductions)
      .set({
        status: toStatus,
        waiverCategory,
        waiverNote,
        decisionByEmail: input.action === "reopen" ? null : actor.email,
        decisionAt: input.action === "reopen" ? null : now,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(and(
        eq(schema.postClassDeductions.id, current.id),
        eq(schema.postClassDeductions.version, input.expectedVersion),
      ))
      .returning();
    if (!updated) throw new PostClassConflictError();

    await Promise.all([
      tx.update(schema.postClassSessions)
        .set({ deductionStatus: toStatus, updatedAt: now })
        .where(eq(schema.postClassSessions.id, current.sessionId)),
      tx.insert(schema.postClassDeductionActions).values({
        deductionId: current.id,
        action: input.action,
        fromStatus: current.status,
        toStatus,
        amountMinor: current.amountMinor,
        financePeriodId: current.financePeriodId,
        waiverCategory,
        note: actionNote,
        actorEmail: actor.email,
        idempotencyKey: input.idempotencyKey,
        metadata: {
          actorName: actor.name ?? null,
          expectedVersion: input.expectedVersion,
        },
      }),
    ]);
    return updated;
  });
}

export async function applyPostClassFinanceAction(
  actor: Actor,
  input: FinanceInput,
  db: Database = getDb(),
) {
  const month = requireMonth(input.processingMonth);
  const databaseMonth = `${month}-01`;
  const reference = input.action === "move"
    ? input.referenceNote.trim() || null
    : requireText(input.referenceNote, "Payroll/reference note");
  const requestedReason = input.reason?.trim() || null;
  const requestedTargetStatus = input.action === "move"
    ? "approved" as const
    : input.action === "process" ? "processed" as const : "reversed" as const;

  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    const duplicate = await existingActionByKey(tx, input.idempotencyKey);
    assertIdempotentActionMatches(duplicate, input);
    if (duplicate) {
      assertPostClassFinanceIdempotentPayloadMatches(duplicate, {
        processingMonth: month,
        reference,
        reason: requestedReason,
        expectedVersion: input.expectedVersion,
        targetStatus: requestedTargetStatus,
      });
      const deduction = await loadDeduction(tx, duplicate.deductionId);
      return input.action === "reverse" && duplicate.action === "reverse"
        ? { ...deduction, status: "reversed" as const }
        : deduction;
    }

    const current = await loadDeduction(tx, input.deductionId);
    if (current.version !== input.expectedVersion) throw new PostClassConflictError();
    if (input.action === "process") {
      if (current.status !== "approved") {
        throw new PostClassValidationError("Only approved deductions can be processed.");
      }
      await revalidateDeductionCandidate(tx, current);
    }
    const assignedMonth = await assignedFinanceMonth(tx, current);
    assertPostClassFinanceMonthActionInvariant({
      action: input.action,
      requestedMonth: databaseMonth,
      defaultMonth: current.defaultFinanceMonth,
      assignedMonth,
    });
    const period = await loadOpenPeriod(tx, databaseMonth);
    const now = new Date();

    let toStatus = current.status;
    let amountMinor = current.amountMinor;
    let reason = requestedReason;
    if (input.action === "move") {
      if (current.status !== "approved") {
        throw new PostClassValidationError("Only approved, unprocessed deductions can move month.");
      }
      reason = requireText(input.reason ?? "", "Move reason");
    } else if (input.action === "process") {
      toStatus = "processed";
    } else {
      if (current.status !== "processed") {
        throw new PostClassValidationError("Only a processed deduction can be reversed.");
      }
      reason = requireText(input.reason ?? "", "Reversal reason");
      toStatus = "reversed";
      amountMinor = -current.amountMinor;
    }

    if (input.action === "reverse") {
      const [existingOffset] = await tx.select({ id: schema.postClassDeductionOffsets.id })
        .from(schema.postClassDeductionOffsets)
        .where(eq(schema.postClassDeductionOffsets.deductionId, current.id))
        .limit(1);
      if (existingOffset) {
        throw new PostClassValidationError("This processed deduction already has a reversal offset.");
      }
      await Promise.all([
        tx.insert(schema.postClassDeductionOffsets).values({
          deductionId: current.id,
          financePeriodId: period.id,
          amountMinor,
          currency: current.currency,
          reason: reason!,
          reference: reference!,
          actorEmail: actor.email,
          idempotencyKey: input.idempotencyKey,
        }),
        tx.update(schema.postClassSessions)
          .set({ deductionStatus: "reversed", updatedAt: now })
          .where(eq(schema.postClassSessions.id, current.sessionId)),
        tx.insert(schema.postClassDeductionActions).values({
          deductionId: current.id,
          action: "reverse",
          fromStatus: "processed",
          toStatus: "reversed",
          amountMinor,
          financePeriodId: period.id,
          note: reason,
          reference: reference!,
          actorEmail: actor.email,
          idempotencyKey: input.idempotencyKey,
          metadata: {
            actorName: actor.name ?? null,
            processingMonth: month,
            expectedVersion: input.expectedVersion,
          },
        }),
      ]);
      return { ...current, status: "reversed" as const };
    }

    const [updated] = await tx
      .update(schema.postClassDeductions)
      .set({
        status: toStatus,
        financePeriodId: period.id,
        processingReference: input.action === "process" ? reference : current.processingReference,
        processedByEmail: input.action === "process" ? actor.email : current.processedByEmail,
        processedAt: input.action === "process" ? now : current.processedAt,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(and(
        eq(schema.postClassDeductions.id, current.id),
        eq(schema.postClassDeductions.version, input.expectedVersion),
      ))
      .returning();
    if (!updated) throw new PostClassConflictError();

    await Promise.all([
      tx.update(schema.postClassSessions)
        .set({ deductionStatus: toStatus, updatedAt: now })
        .where(eq(schema.postClassSessions.id, current.sessionId)),
      tx.insert(schema.postClassDeductionActions).values({
        deductionId: current.id,
        action: input.action,
        fromStatus: current.status,
        toStatus,
        amountMinor,
        financePeriodId: period.id,
        note: reason,
        reference,
        actorEmail: actor.email,
        idempotencyKey: input.idempotencyKey,
        metadata: {
          actorName: actor.name ?? null,
          processingMonth: month,
          expectedVersion: input.expectedVersion,
        },
      }),
    ]);
    return updated;
  });
}

export async function changePostClassFinancePeriod(
  actor: Actor,
  input: FinancePeriodChangeInput,
  db: Database = getDb(),
) {
  const month = requireMonth(input.month);
  const databaseMonth = `${month}-01`;
  const requestedReason = input.reason?.trim() || null;
  const requestedExpectedVersion = input.action === "open" ? null : input.expectedVersion;
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 250) {
    throw new PostClassValidationError("Idempotency key must be 250 characters or fewer.");
  }
  if (input.action === "open" && !idempotencyKey) {
    throw new PostClassValidationError("An idempotency key is required to open a finance period.");
  }
  if (input.action !== "open" && input.expectedVersion === undefined) {
    throw new PostClassValidationError("Expected version is required to close or reopen a finance period.");
  }
  return withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    if (idempotencyKey) {
      const [duplicate] = await tx.select({
        entityKey: schema.postClassConfigAuditLog.entityKey,
        action: schema.postClassConfigAuditLog.action,
        note: schema.postClassConfigAuditLog.note,
        afterValue: schema.postClassConfigAuditLog.afterValue,
      }).from(schema.postClassConfigAuditLog).where(and(
        eq(schema.postClassConfigAuditLog.entityType, "finance_period"),
        sql<boolean>`${schema.postClassConfigAuditLog.afterValue}->>'idempotencyKey' = ${idempotencyKey}`,
      )).limit(1);
      if (duplicate) {
        assertPostClassFinancePeriodIdempotentPayloadMatches(duplicate, {
          month,
          action: input.action,
          reason: requestedReason,
          expectedVersion: requestedExpectedVersion,
        });
        const [period] = await tx.select().from(schema.postClassFinancePeriods)
          .where(eq(schema.postClassFinancePeriods.month, databaseMonth))
          .limit(1);
        if (!period) throw new PostClassConflictError("The prior finance-period action cannot be resolved.");
        return period;
      }
    }
    const [current] = await tx
      .select()
      .from(schema.postClassFinancePeriods)
      .where(eq(schema.postClassFinancePeriods.month, databaseMonth))
      .limit(1);
    const now = new Date();

    if (!current) {
      if (input.action !== "open") throw new PostClassNotFoundError("Finance period was not found.");
      const [created] = await tx.insert(schema.postClassFinancePeriods).values({
        month: databaseMonth,
        status: "open",
        openedByEmail: actor.email,
        openedAt: now,
      }).returning();
      await tx.insert(schema.postClassConfigAuditLog).values({
        entityType: "finance_period",
        entityKey: month,
        action: "open",
        actorEmail: actor.email,
        beforeValue: null,
        afterValue: {
          status: "open",
          idempotencyKey,
          requestedExpectedVersion,
        },
        note: requestedReason,
      });
      return created;
    }

    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new PostClassConflictError();
    }
    if (input.action === "open") {
      if (current.status === "open") {
        await tx.insert(schema.postClassConfigAuditLog).values({
          entityType: "finance_period",
          entityKey: month,
          action: "open",
          actorEmail: actor.email,
          beforeValue: { status: current.status, version: current.version },
          afterValue: {
            status: current.status,
            version: current.version,
            idempotencyKey,
            requestedExpectedVersion,
            idempotentNoop: true,
          },
          note: requestedReason,
        });
        return current;
      }
      throw new PostClassValidationError("The finance period already exists.");
    }

    let status: "open" | "closed";
    if (input.action === "close") {
      if (current.status !== "open") throw new PostClassValidationError("The period is already closed.");
      const [pending] = await tx
        .select({ count: sql<string>`count(*)::text` })
        .from(schema.postClassDeductions)
        .where(and(
          eq(schema.postClassDeductions.status, "approved"),
          or(
            eq(schema.postClassDeductions.financePeriodId, current.id),
            and(
              isNull(schema.postClassDeductions.financePeriodId),
              eq(schema.postClassDeductions.defaultFinanceMonth, current.month),
            ),
          ),
        ));
      if (Number(pending?.count ?? "0") > 0) {
        throw new PostClassValidationError("Move or process every approved deduction before closing this month.");
      }
      status = "closed";
    } else {
      if (current.status !== "closed") throw new PostClassValidationError("The period is already open.");
      requireText(input.reason ?? "", "Reopen reason");
      status = "open";
    }

    const [updated] = await tx
      .update(schema.postClassFinancePeriods)
      .set({
        status,
        closedByEmail: status === "closed" ? actor.email : null,
        closedAt: status === "closed" ? now : null,
        closeReason: status === "closed" ? input.reason?.trim() || null : null,
        reopenReason: status === "open" ? input.reason!.trim() : current.reopenReason,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(and(
        eq(schema.postClassFinancePeriods.id, current.id),
        eq(schema.postClassFinancePeriods.version, current.version),
      ))
      .returning();
    if (!updated) throw new PostClassConflictError();

    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "finance_period",
      entityKey: month,
      action: input.action,
      actorEmail: actor.email,
      beforeValue: { status: current.status, version: current.version },
      afterValue: {
        status,
        version: updated.version,
        idempotencyKey,
        requestedExpectedVersion,
      },
      note: requestedReason,
    });
    return updated;
  });
}
