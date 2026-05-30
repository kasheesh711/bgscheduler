import { desc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  assertPayrollMonth,
  isEndedPayrollSession,
  isKevinCanonicalKey,
  isZeroCreditOrAmount,
  payrollMonthRange,
  roundPayrollNumber,
} from "./domain";
import type {
  PayrollAdjustmentDto,
  PayrollIssue,
  PayrollIssueType,
  PayrollPayload,
  PayrollRateBucket,
  PayrollTier,
  PayrollTutorRow,
} from "./types";

const DURATION_MISMATCH_HOURS = 0.05;

type ReviewRow = typeof schema.payrollReviews.$inferSelect;
type SyncRunRow = typeof schema.payrollSyncRuns.$inferSelect;
type TierRow = typeof schema.payrollTeacherTiers.$inferSelect;
type InvoiceRow = typeof schema.payrollPayoutInvoices.$inferSelect;
type SessionRow = typeof schema.payrollSessionObservations.$inferSelect;
type AdjustmentRow = typeof schema.payrollAdjustments.$inferSelect;

interface AggregateTutor {
  tutorKey: string;
  canonicalKey: string | null;
  tutorName: string;
  tier: PayrollTier;
  rawTier: string | null;
  paidHours: number;
  utilizationHours: number;
  payoutAmount: number;
  invoiceCount: number;
  endedSessionCount: number;
  rateBuckets: Map<number, PayrollRateBucket>;
  flags: Set<PayrollIssueType>;
  isKevin: boolean;
  freePayHours: number;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function emptyReview(): PayrollPayload["review"] {
  return {
    status: "draft",
    notes: "",
    approvedByEmail: null,
    approvedByName: null,
    approvedAt: null,
    updatedAt: null,
  };
}

function reviewDto(row: ReviewRow | null): PayrollPayload["review"] {
  if (!row) return emptyReview();
  return {
    status: row.status,
    notes: row.notes,
    approvedByEmail: row.approvedByEmail,
    approvedByName: row.approvedByName,
    approvedAt: iso(row.approvedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function syncDto(row: SyncRunRow | null): PayrollPayload["lastSync"] {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    teacherCount: row.teacherCount,
    sessionCount: row.sessionCount,
    invoiceCount: row.invoiceCount,
    errorSummary: row.errorSummary,
  };
}

function adjustmentDto(row: AdjustmentRow): PayrollAdjustmentDto {
  return {
    id: row.id,
    payrollMonth: row.payrollMonth,
    adjustmentType: row.adjustmentType,
    tutorCanonicalKey: row.tutorCanonicalKey,
    tutorDisplayName: row.tutorDisplayName,
    hours: row.hours,
    amount: row.amount,
    description: row.description,
    source: row.source,
    createdByEmail: row.createdByEmail,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
  };
}

function tierByUser(rows: TierRow[]): Map<string, TierRow> {
  const byUser = new Map<string, TierRow>();
  for (const row of rows) {
    if (row.wiseUserId) byUser.set(row.wiseUserId, row);
  }
  return byUser;
}

function tutorKeyFor(input: {
  canonicalKey?: string | null;
  wiseTeacherUserId?: string | null;
  wiseSessionId?: string | null;
  transactionId?: string | null;
}): string {
  if (input.canonicalKey) return input.canonicalKey;
  if (input.wiseTeacherUserId) return `unresolved:${input.wiseTeacherUserId}`;
  if (input.wiseSessionId) return `unresolved-session:${input.wiseSessionId}`;
  return `unresolved-transaction:${input.transactionId ?? "unknown"}`;
}

function tutorNameFor(input: {
  canonicalKey?: string | null;
  displayName?: string | null;
  tier?: TierRow | null;
  wiseTeacherUserId?: string | null;
}): string {
  return input.displayName
    ?? input.tier?.wiseDisplayName
    ?? input.canonicalKey
    ?? (input.wiseTeacherUserId ? `Unresolved teacher ${input.wiseTeacherUserId}` : "Unresolved teacher");
}

function getTutor(
  tutors: Map<string, AggregateTutor>,
  input: {
    tutorKey: string;
    canonicalKey?: string | null;
    tutorName: string;
    tier?: TierRow | null;
  },
): AggregateTutor {
  const existing = tutors.get(input.tutorKey);
  if (existing) {
    if (existing.tier === "Unassigned" && input.tier?.normalizedTier) {
      existing.tier = input.tier.normalizedTier as PayrollTier;
      existing.rawTier = input.tier.rawTier;
    }
    return existing;
  }
  const canonicalKey = input.canonicalKey ?? null;
  const tier = (input.tier?.normalizedTier ?? "Unassigned") as PayrollTier;
  const row: AggregateTutor = {
    tutorKey: input.tutorKey,
    canonicalKey,
    tutorName: input.tutorName,
    tier,
    rawTier: input.tier?.rawTier ?? null,
    paidHours: 0,
    utilizationHours: 0,
    payoutAmount: 0,
    invoiceCount: 0,
    endedSessionCount: 0,
    rateBuckets: new Map(),
    flags: new Set(),
    isKevin: isKevinCanonicalKey(canonicalKey),
    freePayHours: 0,
  };
  tutors.set(input.tutorKey, row);
  return row;
}

function addIssue(target: PayrollIssue[], tutor: AggregateTutor, issue: Omit<PayrollIssue, "tutorKey" | "tutorName">): void {
  tutor.flags.add(issue.type);
  target.push({
    tutorKey: tutor.tutorKey,
    tutorName: tutor.tutorName,
    ...issue,
  });
}

function addRateBucket(tutor: AggregateTutor, hours: number, amount: number): void {
  if (hours <= 0 || amount <= 0) return;
  const rate = roundPayrollNumber(amount / hours, 2);
  const current = tutor.rateBuckets.get(rate) ?? { rate, hours: 0, amount: 0, invoiceCount: 0 };
  current.hours += hours;
  current.amount += amount;
  current.invoiceCount += 1;
  tutor.rateBuckets.set(rate, current);
}

function toTutorRow(tutor: AggregateTutor): PayrollTutorRow {
  const effectiveRate = tutor.paidHours > 0 ? roundPayrollNumber(tutor.payoutAmount / tutor.paidHours, 2) : null;
  const rateBuckets = [...tutor.rateBuckets.values()]
    .map((bucket) => ({
      rate: roundPayrollNumber(bucket.rate, 2),
      hours: roundPayrollNumber(bucket.hours, 2),
      amount: roundPayrollNumber(bucket.amount, 2),
      invoiceCount: bucket.invoiceCount,
    }))
    .sort((left, right) => left.rate - right.rate);
  return {
    tutorKey: tutor.tutorKey,
    canonicalKey: tutor.canonicalKey,
    tutorName: tutor.tutorName,
    tier: tutor.tier,
    rawTier: tutor.rawTier,
    paidHours: roundPayrollNumber(tutor.paidHours, 2),
    utilizationHours: roundPayrollNumber(tutor.utilizationHours, 2),
    payoutAmount: roundPayrollNumber(tutor.payoutAmount, 2),
    invoiceCount: tutor.invoiceCount,
    endedSessionCount: tutor.endedSessionCount,
    effectiveRate,
    rateBuckets,
    varianceHours: roundPayrollNumber(tutor.paidHours - tutor.utilizationHours, 2),
    flags: [...tutor.flags].sort(),
    isKevin: tutor.isKevin,
    freePayHours: roundPayrollNumber(tutor.freePayHours, 2),
  };
}

export function buildPayrollPayload(input: {
  month: string;
  review: ReviewRow | null;
  lastSync: SyncRunRow | null;
  tiers: TierRow[];
  invoices: InvoiceRow[];
  sessions: SessionRow[];
  adjustments: AdjustmentRow[];
}): PayrollPayload {
  const range = payrollMonthRange(input.month);
  const tiersByUser = tierByUser(input.tiers);
  const sessionsById = new Map(input.sessions.map((session) => [session.wiseSessionId, session]));
  const invoicesBySession = new Map<string, InvoiceRow[]>();
  for (const invoice of input.invoices) {
    if (!invoice.wiseSessionId) continue;
    const rows = invoicesBySession.get(invoice.wiseSessionId) ?? [];
    rows.push(invoice);
    invoicesBySession.set(invoice.wiseSessionId, rows);
  }

  const tutors = new Map<string, AggregateTutor>();
  const issues: PayrollIssue[] = [];

  for (const session of input.sessions) {
    if (!isEndedPayrollSession(session.meetingStatus)) continue;
    const tier = session.wiseTeacherUserId ? tiersByUser.get(session.wiseTeacherUserId) : null;
    const tutorKey = tutorKeyFor({
      canonicalKey: session.tutorGroupCanonicalKey,
      wiseTeacherUserId: session.wiseTeacherUserId,
      wiseSessionId: session.wiseSessionId,
    });
    const tutor = getTutor(tutors, {
      tutorKey,
      canonicalKey: session.tutorGroupCanonicalKey,
      tutorName: tutorNameFor({
        canonicalKey: session.tutorGroupCanonicalKey,
        displayName: session.tutorDisplayName,
        tier,
        wiseTeacherUserId: session.wiseTeacherUserId,
      }),
      tier,
    });

    const sessionHours = session.durationMinutes / 60;
    tutor.utilizationHours += sessionHours;
    tutor.endedSessionCount += 1;

    if (!session.tutorGroupCanonicalKey) {
      addIssue(issues, tutor, {
        type: "unresolved_tutor_identity",
        severity: "high",
        wiseSessionId: session.wiseSessionId,
        message: "Wise session teacher does not resolve to an active tutor identity group.",
      });
    }
    if (!tier || tier.normalizedTier === "Unassigned") {
      addIssue(issues, tutor, {
        type: "missing_tier",
        severity: "medium",
        wiseSessionId: session.wiseSessionId,
        message: "Tutor has no Wise tier tag for this payroll month.",
      });
    }
    if (!invoicesBySession.has(session.wiseSessionId)) {
      addIssue(issues, tutor, {
        type: "missing_payout_invoice",
        severity: "high",
        wiseSessionId: session.wiseSessionId,
        message: "Ended Wise session has no tutor payout invoice event.",
      });
    }
  }

  for (const invoice of input.invoices) {
    const matchedSession = invoice.wiseSessionId ? sessionsById.get(invoice.wiseSessionId) : null;
    const tier = invoice.wiseTeacherUserId ? tiersByUser.get(invoice.wiseTeacherUserId) : null;
    const canonicalKey = matchedSession?.tutorGroupCanonicalKey ?? null;
    const tutorKey = tutorKeyFor({
      canonicalKey,
      wiseTeacherUserId: invoice.wiseTeacherUserId,
      transactionId: invoice.transactionId,
    });
    const tutor = getTutor(tutors, {
      tutorKey,
      canonicalKey,
      tutorName: tutorNameFor({
        canonicalKey,
        displayName: matchedSession?.tutorDisplayName,
        tier,
        wiseTeacherUserId: invoice.wiseTeacherUserId,
      }),
      tier,
    });

    tutor.paidHours += invoice.sessionCredits;
    tutor.payoutAmount += invoice.amount;
    tutor.invoiceCount += 1;
    addRateBucket(tutor, invoice.sessionCredits, invoice.amount);

    if (!canonicalKey) {
      addIssue(issues, tutor, {
        type: "unresolved_tutor_identity",
        severity: "high",
        wiseSessionId: invoice.wiseSessionId,
        transactionId: invoice.transactionId,
        message: "Payout invoice teacher does not resolve through the active Wise tutor identity snapshot.",
      });
    }
    if (!tier || tier.normalizedTier === "Unassigned") {
      addIssue(issues, tutor, {
        type: "missing_tier",
        severity: "medium",
        wiseSessionId: invoice.wiseSessionId,
        transactionId: invoice.transactionId,
        message: "Payout invoice teacher has no Wise tier tag for this payroll month.",
      });
    }
    if (!matchedSession) {
      addIssue(issues, tutor, {
        type: "orphan_payout_invoice",
        severity: "high",
        wiseSessionId: invoice.wiseSessionId,
        transactionId: invoice.transactionId,
        message: "Payout invoice points to a session that was not found in the Wise past-session pull for this month.",
      });
    } else {
      const sessionHours = matchedSession.durationMinutes / 60;
      if (Math.abs(invoice.sessionCredits - sessionHours) > DURATION_MISMATCH_HOURS) {
        addIssue(issues, tutor, {
          type: "duration_mismatch",
          severity: "medium",
          wiseSessionId: invoice.wiseSessionId,
          transactionId: invoice.transactionId,
          message: `Payout credits ${roundPayrollNumber(invoice.sessionCredits, 2)}h differ from scheduled duration ${roundPayrollNumber(sessionHours, 2)}h.`,
        });
      }
      if (isZeroCreditOrAmount(invoice)) {
        tutor.freePayHours += sessionHours;
      }
    }
    if (isZeroCreditOrAmount(invoice)) {
      addIssue(issues, tutor, {
        type: "zero_credit_or_zero_amount",
        severity: "medium",
        wiseSessionId: invoice.wiseSessionId,
        transactionId: invoice.transactionId,
        message: "Payout invoice has zero session credits or zero payout amount.",
      });
    }
  }

  const tutorRows = [...tutors.values()]
    .map(toTutorRow)
    .sort((left, right) => {
      const tierCompare = left.tier.localeCompare(right.tier);
      if (tierCompare !== 0) return tierCompare;
      return left.tutorName.localeCompare(right.tutorName);
    });

  const manualAdjustmentHours = input.adjustments.reduce((sum, adjustment) => sum + adjustment.hours, 0);
  const manualAdjustmentAmount = input.adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);
  const totalPayoutAmount = tutorRows.reduce((sum, row) => sum + row.payoutAmount, 0);
  const paidHours = tutorRows.reduce((sum, row) => sum + row.paidHours, 0);
  const utilizationHours = tutorRows.reduce((sum, row) => sum + row.utilizationHours, 0);
  const detectedFreePayHours = tutorRows.reduce((sum, row) => sum + row.freePayHours, 0);
  const kevinRows = tutorRows.filter((row) => row.isKevin);
  const kevinHours = kevinRows.reduce((sum, row) => sum + row.utilizationHours, 0);
  const kevinPaidHours = kevinRows.reduce((sum, row) => sum + row.paidHours, 0);
  const kevinPayoutAmount = kevinRows.reduce((sum, row) => sum + row.payoutAmount, 0);

  return {
    month: range.month,
    payrollMonth: range.payrollMonth,
    review: reviewDto(input.review),
    lastSync: syncDto(input.lastSync),
    summary: {
      totalPayoutAmount: roundPayrollNumber(totalPayoutAmount, 2),
      paidHours: roundPayrollNumber(paidHours, 2),
      utilizationHours: roundPayrollNumber(utilizationHours, 2),
      varianceHours: roundPayrollNumber(paidHours - utilizationHours, 2),
      detectedFreePayHours: roundPayrollNumber(detectedFreePayHours, 2),
      kevinHours: roundPayrollNumber(kevinHours, 2),
      kevinPaidHours: roundPayrollNumber(kevinPaidHours, 2),
      kevinPayoutAmount: roundPayrollNumber(kevinPayoutAmount, 2),
      manualAdjustmentHours: roundPayrollNumber(manualAdjustmentHours, 2),
      manualAdjustmentAmount: roundPayrollNumber(manualAdjustmentAmount, 2),
      unresolvedTutorCount: tutorRows.filter((row) => row.flags.includes("unresolved_tutor_identity")).length,
      issueCount: issues.length,
      tutorCount: tutorRows.length,
    },
    tutors: tutorRows,
    issues,
    adjustments: input.adjustments.map(adjustmentDto),
  };
}

export async function getPayrollPayload(db: Database, monthInput: string): Promise<PayrollPayload> {
  const month = assertPayrollMonth(monthInput);
  const range = payrollMonthRange(month);
  const [reviewRows, syncRows, tiers, invoices, sessions, adjustments] = await Promise.all([
    db
      .select()
      .from(schema.payrollReviews)
      .where(eq(schema.payrollReviews.payrollMonth, range.payrollMonth))
      .limit(1),
    db
      .select()
      .from(schema.payrollSyncRuns)
      .where(eq(schema.payrollSyncRuns.payrollMonth, range.payrollMonth))
      .orderBy(desc(schema.payrollSyncRuns.startedAt))
      .limit(1),
    db.select().from(schema.payrollTeacherTiers).where(eq(schema.payrollTeacherTiers.payrollMonth, range.payrollMonth)),
    db.select().from(schema.payrollPayoutInvoices).where(eq(schema.payrollPayoutInvoices.payrollMonth, range.payrollMonth)),
    db.select().from(schema.payrollSessionObservations).where(eq(schema.payrollSessionObservations.payrollMonth, range.payrollMonth)),
    db
      .select()
      .from(schema.payrollAdjustments)
      .where(eq(schema.payrollAdjustments.payrollMonth, range.payrollMonth))
      .orderBy(desc(schema.payrollAdjustments.createdAt)),
  ]);

  return buildPayrollPayload({
    month,
    review: reviewRows[0] ?? null,
    lastSync: syncRows[0] ?? null,
    tiers,
    invoices,
    sessions,
    adjustments,
  });
}

export async function updatePayrollReview(
  db: Database,
  input: {
    month: string;
    status?: "draft" | "approved";
    notes?: string;
    actorEmail: string;
    actorName?: string | null;
  },
): Promise<void> {
  const range = payrollMonthRange(input.month);
  const now = new Date();
  const values: typeof schema.payrollReviews.$inferInsert = {
    payrollMonth: range.payrollMonth,
    status: input.status ?? "draft",
    notes: input.notes ?? "",
    updatedAt: now,
  };
  if (input.status === "approved") {
    values.approvedByEmail = input.actorEmail;
    values.approvedByName = input.actorName ?? input.actorEmail;
    values.approvedAt = now;
  }

  await db
    .insert(schema.payrollReviews)
    .values(values)
    .onConflictDoUpdate({
      target: schema.payrollReviews.payrollMonth,
      set: {
        ...(input.status
          ? {
              status: input.status,
              approvedByEmail: input.status === "approved" ? input.actorEmail : null,
              approvedByName: input.status === "approved" ? input.actorName ?? input.actorEmail : null,
              approvedAt: input.status === "approved" ? now : null,
            }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: now,
      },
    });
}

export async function addPayrollAdjustment(
  db: Database,
  input: {
    month: string;
    adjustmentType: string;
    tutorCanonicalKey?: string | null;
    tutorDisplayName?: string | null;
    hours: number;
    amount: number;
    description: string;
    actorEmail: string;
    actorName?: string | null;
  },
): Promise<PayrollAdjustmentDto> {
  const range = payrollMonthRange(input.month);
  const [row] = await db
    .insert(schema.payrollAdjustments)
    .values({
      payrollMonth: range.payrollMonth,
      adjustmentType: input.adjustmentType.trim() || "manual",
      tutorCanonicalKey: input.tutorCanonicalKey?.trim() || null,
      tutorDisplayName: input.tutorDisplayName?.trim() || null,
      hours: Number.isFinite(input.hours) ? input.hours : 0,
      amount: Number.isFinite(input.amount) ? input.amount : 0,
      description: input.description.trim(),
      source: "manual",
      createdByEmail: input.actorEmail,
      createdByName: input.actorName ?? input.actorEmail,
    })
    .returning();
  return adjustmentDto(row);
}

export async function deletePayrollAdjustment(db: Database, adjustmentId: string): Promise<boolean> {
  const rows = await db
    .delete(schema.payrollAdjustments)
    .where(eq(schema.payrollAdjustments.id, adjustmentId))
    .returning({ id: schema.payrollAdjustments.id });
  return rows.length > 0;
}
