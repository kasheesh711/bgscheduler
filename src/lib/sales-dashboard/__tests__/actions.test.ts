import { describe, expect, it } from "vitest";
import { buildSalesActionsPayload } from "@/lib/sales-dashboard/actions";
import type { SalesDashboardPayload, SalesDimensionsPayload, StudentDirectoryEntry } from "@/lib/sales-dashboard/types";
import type { DashboardPayload, PackageRecord, StudentRecord } from "@/types/credit-control";

const NOW = new Date("2026-06-15T05:00:00.000Z");

function salesPayload(overrides: Partial<SalesDashboardPayload> = {}): SalesDashboardPayload {
  return {
    normalDays: [{
      d: "2026-06-10",
      m: "2026-06 Jun",
      rev: 1_000_000,
      trial: 8,
      newS: 2,
      renew: 3,
      count: 5,
      revT: 80_000,
      revN: 300_000,
      revR: 620_000,
      pkgs: { "20h": 2 },
      prgs: { Math: 2 },
      reps: {
        Alice: { rev: 700_000, count: 3, revT: 20_000, revN: 180_000, revR: 500_000, cntT: 1, cntN: 1, cntR: 1 },
        Bob: { rev: 300_000, count: 2, revT: 60_000, revN: 120_000, revR: 120_000, cntT: 7, cntN: 1, cntR: 2 },
      },
      dow: "Wed",
    }],
    addDays: [],
    pkgCount: {},
    progCount: {},
    addPkgCount: {},
    repArr: [],
    dayCount: {},
    totalTxn: 5,
    totalAddTxn: 0,
    uniqueTrials: 8,
    uniqueNewStudents: 2,
    uniqueRenewals: 3,
    churnedStudents: 1,
    eligibleStudents: 4,
    completionRate: { "15": 0.5 },
    completionMonths: 1,
    weekBandPct: [],
    churnList: [],
    trialCohort: [
      { nick: "T1", trialDate: "2026-06-03", convertedDate: null },
      { nick: "T2", trialDate: "2026-06-04", convertedDate: "2026-06-12" },
      { nick: "T3", trialDate: "2026-06-05", convertedDate: null },
      { nick: "T4", trialDate: "2026-06-06", convertedDate: null },
    ],
    retentionCohort: [],
    lastUpdated: NOW.toISOString(),
    sources: [{
      id: "source-1",
      sourceMonth: "2026-06-01",
      label: "Jun 2026",
      spreadsheetId: "sheet",
      spreadsheetUrl: "https://docs.google.com/sheets/d/sheet",
      normalSheetName: "Normal",
      additionalSheetName: null,
      status: "active",
      lastImportedAt: NOW.toISOString(),
      lastImportError: null,
      lastNormalRowCount: 10,
      lastAdditionalRowCount: 0,
      connectedEmail: "admin@example.com",
      archivedAt: null,
      archivedByEmail: null,
      statusBeforeArchive: null,
    }],
    projection: {
      source: null,
      targetMonthlyRevenue: 4_000_000,
      targetSource: "projection",
      scenarioSummaries: [],
      months: [
        projectionMonth("2026-05-01", "Base", 3_200_000),
        projectionMonth("2026-06-01", "Base", 4_000_000),
        projectionMonth("2026-07-01", "Base", 4_200_000),
      ],
      lastImportedAt: NOW.toISOString(),
      lastImportError: null,
    },
    token: { connected: true, email: "admin@example.com", expiresAt: null, lastError: null },
    ...overrides,
  };
}

function projectionMonth(month: string, scenario: "Base" | "Bear" | "Bull", totalNetRevenue: number) {
  return {
    scenario,
    projectionMonth: month,
    monthLabel: month,
    monthKind: month <= "2026-06-01" ? "actual" as const : "forecast" as const,
    totalNetRevenue,
    renewalRevenue: 0,
    newStudentRevenue: 0,
    trialRevenue: 0,
    activeStudents: 0,
    trialBookings: 0,
    newStudents: 0,
    packRenewals: 0,
    renewalHours: 0,
    newStudentHours: 0,
    trialHours: 0,
    totalHours: 0,
    roomCapacity: 0,
    roomUtilization: 0,
  };
}

function student(overrides: Partial<StudentDirectoryEntry> & Pick<StudentDirectoryEntry, "key" | "displayName">): StudentDirectoryEntry {
  return {
    displayNameVariants: [overrides.displayName],
    firstSeen: "2026-01-01",
    lastPaymentDate: "2026-06-01",
    totalRevenue: 100_000,
    txnCount: 2,
    addTxnCount: 0,
    programs: ["Math"],
    reps: ["Alice"],
    latestValidUntil: "2026-06-20",
    status: "Active",
    decisionDate: "2026-07-04",
    ...overrides,
  };
}

function dimensions(students: StudentDirectoryEntry[]): SalesDimensionsPayload {
  return {
    months: ["2026-06-01"],
    reps: [],
    repFunnels: [],
    programs: [],
    packages: [],
    additionalMix: [],
    students,
    targetMonthlyRevenue: 4_000_000,
    unparsedPackageCount: 0,
    generatedAt: NOW.toISOString(),
  };
}

function packageRecord(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    key: "pkg",
    student: "Bell",
    parent: "Parent",
    name: "20h",
    subject: "Math",
    currentRemaining: 1,
    pendingDeduction: 0,
    pendingDeductionDetails: [],
    pendingDeductionUsesFallback: false,
    adjustedRemaining: 1,
    totalCredits: 20,
    alertDate: "2026-06-16",
    exhaustDate: "2026-06-18",
    daysUntilAlert: 1,
    daysUntilExhaust: 3,
    status: "notify",
    projection: [],
    upcomingSessions: [],
    upcomingCount: 1,
    nextSessionDate: "2026-06-16",
    totalScheduledCredits: 2,
    sessionCadencePerWeek: 2,
    averageCreditsPerWeek: 2,
    cadenceLabel: "2/wk",
    duplicateCount: 1,
    priorityScore: 90,
    recommendedAction: "Ask parent to renew",
    whyNow: "Package will exhaust this week.",
    statusChange: "stable",
    balanceDelta: null,
    dataQualityFlags: [],
    ruleContext: {
      included: true,
      exclusionReason: null,
      pendingDeductionApplied: false,
      pendingDeductionUsesFallback: false,
      projectionStatus: "notify",
    },
    ...overrides,
  };
}

function creditStudent(name: string, key: string, packages: PackageRecord[] = [packageRecord({ student: name })]): StudentRecord {
  return {
    student: name,
    parent: "Parent",
    packages,
    dataQualityFlags: [],
    adminOwnerKey: "unassigned",
    adminOwnerName: "Unassigned",
    adminOwnershipSource: "test",
    studentKey: key,
    actionState: null,
  };
}

function creditPayload(students: StudentRecord[]): DashboardPayload {
  return {
    adminViews: [],
    lastUpdatedAt: NOW.toISOString(),
    previousUpdatedAt: null,
    summary: {
      students: { notify: 0, watch: 0, ok: 0, nodata: 0, total: students.length },
      packages: { notify: 0, watch: 0, ok: 0, nodata: 0, total: 0 },
      portfolio: {
        exhaustedNow: 0,
        risk7: 0,
        risk14: 0,
        risk30: 0,
        noSchedule: 0,
        pendingDeductionBacklog: 0,
        pendingDeductionPackages: 0,
        lowBalanceNoSchedule: 0,
        multiRiskStudents: 0,
      },
      queue: { students: 0, pinnedStudents: 0 },
      deltas: {
        packagesNotify: null,
        packagesWatch: null,
        risk7: null,
        risk30: null,
        pendingDeductionBacklog: null,
        noSchedule: null,
        queueStudents: null,
        pinnedStudents: null,
      },
    },
    studentQueue: [],
    studentQueueAll: [],
    calendar: { availableStart: null, availableEnd: null, days: [] },
    students,
  };
}

describe("buildSalesActionsPayload", () => {
  it("matches Sales students to Credit Control only when the normalized nickname is unique", () => {
    const payload = buildSalesActionsPayload({
      sales: salesPayload(),
      dimensions: dimensions([
        student({ key: "bell", displayName: "Bell", totalRevenue: 600_000 }),
        student({ key: "mint", displayName: "Mint", status: "Churned", decisionDate: "2026-05-10", totalRevenue: 900_000 }),
        student({ key: "ghost", displayName: "Ghost", status: "Churned", decisionDate: "2026-05-10", totalRevenue: 200_000 }),
      ]),
      creditControl: creditPayload([
        creditStudent("Bell", "bell-parent-a"),
        creditStudent("Mint", "mint-parent-a", [packageRecord({ status: "ok" })]),
        creditStudent("Mint", "mint-parent-b", [packageRecord({ status: "ok" })]),
      ]),
      from: "2026-06-01",
      to: "2026-06-30",
      now: NOW,
    });

    expect(payload.matchStats).toMatchObject({ unique: 1, ambiguous: 1, unmatched: 1 });
    const bell = payload.items.find((item) => item.id === "renewal-bell");
    expect(bell?.match.status).toBe("unique");
    expect(bell?.primaryAction.kind).toBe("credit-control");
    expect(bell?.primaryAction.href).toBe("/credit-control?studentKey=bell-parent-a");
    expect(payload.items.find((item) => item.id === "data-ambiguous-student-matches")).toBeTruthy();
  });

  it("ranks critical data failures above revenue recovery and target-gap work", () => {
    const payload = buildSalesActionsPayload({
      sales: salesPayload({
        sources: [{
          ...salesPayload().sources[0],
          lastImportError: "Sheets timeout",
        }],
      }),
      dimensions: dimensions([student({ key: "bell", displayName: "Bell", totalRevenue: 600_000 })]),
      creditControl: creditPayload([creditStudent("Bell", "bell-parent-a")]),
      from: "2026-06-01",
      to: "2026-06-30",
      now: NOW,
    });

    expect(payload.items[0].family).toBe("data_trust");
    expect(payload.items[0].severity).toBe("critical");
    expect(payload.items.some((item) => item.family === "target_gap")).toBe(true);
  });

  it("labels non-current ranges as historical while keeping unique Credit links as current-state context", () => {
    const payload = buildSalesActionsPayload({
      sales: salesPayload(),
      dimensions: dimensions([student({ key: "bell", displayName: "Bell", totalRevenue: 600_000 })]),
      creditControl: creditPayload([creditStudent("Bell", "bell-parent-a")]),
      from: "2026-05-01",
      to: "2026-05-31",
      now: NOW,
    });

    expect(payload.mode).toBe("historical");
    expect(payload.modeLabel).toBe("Historical analysis mode");
    const bell = payload.items.find((item) => item.family === "renewal_rescue");
    expect(bell?.primaryAction.label).toBe("View current credit state");
  });

  it("falls back to Sales-only actions when Credit Control cannot be loaded", () => {
    const payload = buildSalesActionsPayload({
      sales: salesPayload(),
      dimensions: dimensions([student({ key: "bell", displayName: "Bell", status: "Churned", decisionDate: "2026-05-10" })]),
      creditControl: null,
      creditControlError: "database unavailable",
      from: "2026-06-01",
      to: "2026-06-30",
      now: NOW,
    });

    expect(payload.dependencyWarnings[0].id).toBe("credit-control-unavailable");
    expect(payload.matchStats.creditControlAvailable).toBe(false);
    expect(payload.items.some((item) => item.primaryAction.kind === "credit-control")).toBe(false);
    expect(payload.items.some((item) => item.family === "renewal_rescue")).toBe(true);
  });

  it("gates Credit Control links when the user lacks page access", () => {
    const payload = buildSalesActionsPayload({
      sales: salesPayload(),
      dimensions: dimensions([student({ key: "bell", displayName: "Bell", totalRevenue: 600_000 })]),
      creditControl: creditPayload([creditStudent("Bell", "bell-parent-a")]),
      canAccessCreditControl: false,
      from: "2026-06-01",
      to: "2026-06-30",
      now: NOW,
    });

    const bell = payload.items.find((item) => item.id === "renewal-bell");
    expect(bell?.match.status).toBe("unique");
    expect(bell?.match.canOpenCreditControl).toBe(false);
    expect(bell?.primaryAction.kind).toBe("sales-tab");
  });
});
