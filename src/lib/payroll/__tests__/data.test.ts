import { describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { buildPayrollPayload } from "../data";

const now = new Date("2026-05-31T00:00:00.000Z");

type SyncRow = typeof schema.payrollSyncRuns.$inferSelect;
type TierRow = typeof schema.payrollTeacherTiers.$inferSelect;
type SessionRow = typeof schema.payrollSessionObservations.$inferSelect;
type InvoiceRow = typeof schema.payrollPayoutInvoices.$inferSelect;
type AdjustmentRow = typeof schema.payrollAdjustments.$inferSelect;
type RateCardVersionRow = typeof schema.payrollRateCardVersions.$inferSelect;
type RateRuleRow = typeof schema.payrollRateRules.$inferSelect;

function sync(overrides: Partial<SyncRow> = {}): SyncRow {
  const base: SyncRow = {
    id: "run-1",
    payrollMonth: "2026-05-01",
    status: "success",
    triggerType: "manual",
    startedAt: now,
    finishedAt: now,
    teacherCount: 1,
    sessionCount: 1,
    invoiceCount: 1,
    errorSummary: null,
    metadata: {},
  };
  return { ...base, ...overrides };
}

function tier(overrides: Partial<TierRow> = {}): TierRow {
  const base: TierRow = {
    id: "tier-1",
    payrollMonth: "2026-05-01",
    syncRunId: "run-1",
    wiseTeacherId: "teacher-1",
    wiseUserId: "user-1",
    wiseDisplayName: "Tutor One",
    rawTier: "Tier 1",
    normalizedTier: "BG1",
    tags: ["Tier 1"],
    createdAt: now,
  };
  return { ...base, ...overrides };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  const base: SessionRow = {
    id: "session-row-1",
    payrollMonth: "2026-05-01",
    syncRunId: "run-1",
    wiseSessionId: "session-1",
    wiseTeacherUserId: "user-1",
    wiseTeacherId: "teacher-1",
    tutorGroupCanonicalKey: "TutorOne",
    tutorDisplayName: "Tutor One",
    wiseClassId: "class-1",
    className: "Student One",
    subject: "Math",
    classType: "ONLINE",
    startTime: new Date("2026-05-10T03:00:00.000Z"),
    endTime: new Date("2026-05-10T04:00:00.000Z"),
    durationMinutes: 60,
    meetingStatus: "ENDED",
    sessionType: "ONLINE",
    studentCount: 1,
    raw: {},
    createdAt: now,
  };
  return { ...base, ...overrides };
}

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  const base: InvoiceRow = {
    id: "invoice-row-1",
    payrollMonth: "2026-05-01",
    syncRunId: "run-1",
    eventId: "event-1",
    transactionId: "tx-1",
    eventTimestamp: new Date("2026-05-10T05:00:00.000Z"),
    wiseTeacherUserId: "user-1",
    actorWiseUserId: "admin-1",
    wiseClassId: "class-1",
    wiseSessionId: "session-1",
    sessionStartTime: new Date("2026-05-10T03:00:00.000Z"),
    sessionCredits: 1,
    amountMinor: 70000,
    amount: 700,
    currency: "THB",
    transactionStatus: "CREATED",
    note: "Session conducted",
    raw: {},
    createdAt: now,
  };
  return { ...base, ...overrides };
}

function rateCardVersion(overrides: Partial<RateCardVersionRow> = {}): RateCardVersionRow {
  const base: RateCardVersionRow = {
    id: "rate-card-1",
    versionName: "PayRate May 2026",
    effectiveMonth: "2026-05-01",
    sourceLabel: "PayRate",
    active: true,
    createdByEmail: "admin@example.com",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  return { ...base, ...overrides };
}

function rateRule(overrides: Partial<RateRuleRow> = {}): RateRuleRow {
  const base: RateRuleRow = {
    id: "rate-rule-1",
    versionId: "rate-card-1",
    studentBand: "1",
    curriculum: "UK/US/IB",
    course: "Year 9-11 or Grade 8-10",
    normalizedCourseKey: "year_9_11_grade_8_10",
    tierKey: "BG1",
    sourceTierKey: "Tier 1",
    pricePerHour: 1400,
    expectedRevenuePerHour: 700,
    revenueShare: 0.5,
    rawSourceRow: {},
    createdAt: now,
  };
  return { ...base, ...overrides };
}

function payload(overrides: {
  tiers?: TierRow[];
  invoices?: InvoiceRow[];
  sessions?: SessionRow[];
  adjustments?: AdjustmentRow[];
  rateCardVersion?: RateCardVersionRow | null;
  rateRules?: RateRuleRow[];
} = {}) {
  return buildPayrollPayload({
    month: "2026-05",
    review: null,
    lastSync: sync(),
    tiers: overrides.tiers ?? [tier()],
    invoices: overrides.invoices ?? [invoice()],
    sessions: overrides.sessions ?? [session()],
    adjustments: overrides.adjustments ?? [],
    rateCardVersion: overrides.rateCardVersion,
    rateRules: overrides.rateRules,
  });
}

describe("payroll aggregation", () => {
  it("matches invoice credits against ended Wise session utilization", () => {
    const result = payload();

    expect(result.summary).toMatchObject({
      paidHours: 1,
      utilizationHours: 1,
      varianceHours: 0,
      totalPayoutAmount: 700,
      issueCount: 0,
    });
    expect(result.tutors[0]).toMatchObject({
      tutorName: "Tutor One",
      tier: "BG1",
      effectiveRate: 700,
      flags: [],
    });
  });

  it("flags missing payout invoices for ended sessions", () => {
    const result = payload({ invoices: [] });

    expect(result.summary.issueCount).toBe(1);
    expect(result.issues[0]).toMatchObject({ type: "missing_payout_invoice", wiseSessionId: "session-1" });
    expect(result.tutors[0].flags).toContain("missing_payout_invoice");
  });

  it("flags orphan payout invoices", () => {
    const result = payload({ sessions: [] });

    expect(result.summary.issueCount).toBe(2);
    expect(result.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(["orphan_payout_invoice", "unresolved_tutor_identity"]),
    );
  });

  it("classifies zero-credit or zero-amount invoices as free-pay review rows", () => {
    const result = payload({ invoices: [invoice({ sessionCredits: 0, amount: 0, amountMinor: 0 })] });

    expect(result.summary.detectedFreePayHours).toBe(1);
    expect(result.tutors[0].flags).toContain("zero_credit_or_zero_amount");
  });

  it("surfaces Kevin hours separately", () => {
    const result = payload({
      sessions: [session({ tutorGroupCanonicalKey: "Kevin", tutorDisplayName: "Kevin" })],
    });

    expect(result.summary.kevinHours).toBe(1);
    expect(result.tutors[0]).toMatchObject({ isKevin: true, tutorName: "Kevin" });
  });

  it("keeps multiple effective rate buckets per tutor", () => {
    const result = payload({
      sessions: [
        session({ wiseSessionId: "session-1", durationMinutes: 60 }),
        session({ wiseSessionId: "session-2", durationMinutes: 60 }),
      ],
      invoices: [
        invoice({ wiseSessionId: "session-1", transactionId: "tx-1", eventId: "event-1", sessionCredits: 1, amount: 600 }),
        invoice({ wiseSessionId: "session-2", transactionId: "tx-2", eventId: "event-2", sessionCredits: 1, amount: 700 }),
      ],
    });

    expect(result.tutors[0].rateBuckets.map((bucket) => bucket.rate)).toEqual([600, 700]);
    expect(result.tutors[0].effectiveRate).toBe(650);
  });

  it("checks invoice rates against the active PayRate card", () => {
    const result = payload({
      rateCardVersion: rateCardVersion(),
      rateRules: [rateRule()],
      sessions: [session({ subject: "Y9-11 / G8-10 (Int.)", studentCount: 1 })],
    });

    expect(result.rateCard).toMatchObject({ versionName: "PayRate May 2026" });
    expect(result.summary.expectedRateCheckedCount).toBe(1);
    expect(result.summary.expectedRateMismatchCount).toBe(0);
    expect(result.tutors[0]).toMatchObject({ expectedRateCheckedCount: 1, expectedRateIssueCount: 0 });
  });

  it("allows one baht per hour tolerance for expected rate checks", () => {
    const result = payload({
      rateCardVersion: rateCardVersion(),
      rateRules: [rateRule({ expectedRevenuePerHour: 701 })],
      sessions: [session({ subject: "Y9-11 / G8-10 (Int.)", studentCount: 1 })],
    });

    expect(result.summary.expectedRateMismatchCount).toBe(0);
    expect(result.summary.issueCount).toBe(0);
  });

  it("flags expected-rate mismatches", () => {
    const result = payload({
      rateCardVersion: rateCardVersion(),
      rateRules: [rateRule({ expectedRevenuePerHour: 600 })],
      sessions: [session({ subject: "Y9-11 / G8-10 (Int.)", studentCount: 1 })],
    });

    expect(result.summary.expectedRateMismatchCount).toBe(1);
    expect(result.issues[0]).toMatchObject({
      type: "expected_rate_mismatch",
      expectedRate: 600,
      actualRate: 700,
      rateDifference: 100,
      studentBand: "1",
      tier: "BG1",
    });
    expect(result.tutors[0].flags).toContain("expected_rate_mismatch");
  });

  it("flags missing and unmapped expected rate rules", () => {
    const missing = payload({
      rateCardVersion: rateCardVersion(),
      rateRules: [],
      sessions: [session({ subject: "Y9-11 / G8-10 (Int.)", studentCount: 1 })],
    });
    expect(missing.summary.missingRateRuleCount).toBe(1);
    expect(missing.issues[0]).toMatchObject({ type: "missing_expected_rate_rule" });

    const unmapped = payload({
      rateCardVersion: rateCardVersion(),
      rateRules: [rateRule()],
      sessions: [session({ subject: "Unmapped Custom Course", studentCount: 1 })],
    });
    expect(unmapped.summary.unmappedRateCourseCount).toBe(1);
    expect(unmapped.issues[0]).toMatchObject({ type: "unmapped_rate_course" });
  });

  it("does not rate-check zero-credit or zero-amount invoices", () => {
    const result = payload({
      rateCardVersion: rateCardVersion(),
      rateRules: [rateRule({ expectedRevenuePerHour: 600 })],
      invoices: [invoice({ sessionCredits: 0, amount: 0, amountMinor: 0 })],
      sessions: [session({ subject: "Y9-11 / G8-10 (Int.)", studentCount: 1 })],
    });

    expect(result.summary.expectedRateCheckedCount).toBe(0);
    expect(result.summary.expectedRateMismatchCount).toBe(0);
    expect(result.tutors[0].flags).toContain("zero_credit_or_zero_amount");
  });
});
