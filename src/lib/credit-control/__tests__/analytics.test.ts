import { describe, expect, it } from "vitest";
import { buildAllStudentQueueRows, buildStudentQueue } from "@/lib/credit-control/analytics";
import type { PackageRecord, StudentRecord } from "@/types/credit-control";

function pkg(overrides: Partial<PackageRecord> = {}): PackageRecord {
  return {
    key: "k",
    student: "S",
    parent: "P",
    name: "Math",
    subject: "Math",
    currentRemaining: 0,
    pendingDeduction: 0,
    pendingDeductionDetails: [],
    pendingDeductionUsesFallback: false,
    adjustedRemaining: 0,
    totalCredits: 10,
    alertDate: null,
    exhaustDate: null,
    daysUntilAlert: null,
    daysUntilExhaust: null,
    status: "ok",
    projection: [],
    upcomingSessions: [],
    upcomingCount: 0,
    nextSessionDate: null,
    totalScheduledCredits: 0,
    sessionCadencePerWeek: 0,
    averageCreditsPerWeek: 0,
    cadenceLabel: "No schedule",
    duplicateCount: 1,
    priorityScore: 0,
    recommendedAction: "",
    whyNow: "",
    statusChange: "new",
    balanceDelta: null,
    dataQualityFlags: [],
    ruleContext: {
      included: true,
      exclusionReason: null,
      pendingDeductionApplied: false,
      pendingDeductionUsesFallback: false,
      projectionStatus: "ok",
    },
    ...overrides,
  };
}

function student(name: string, packages: PackageRecord[]): StudentRecord {
  return {
    student: name,
    parent: `${name} Parent`,
    studentKey: `${name.toLowerCase()}::parent`,
    packages,
    dataQualityFlags: [],
    adminOwnerKey: "unassigned",
    adminOwnerName: "Unassigned",
    adminOwnershipSource: "unassigned",
    actionState: null,
  };
}

describe("student queue membership", () => {
  it("includes a healthy ok student in the full list but not the at-risk queue", () => {
    const risky = student("Risky", [
      pkg({ status: "notify", currentRemaining: 0, adjustedRemaining: 0 }),
    ]);
    const healthy = student("Healthy", [
      pkg({
        status: "ok",
        currentRemaining: 10,
        adjustedRemaining: 10,
        upcomingCount: 1,
        nextSessionDate: "2099-01-01",
        upcomingSessions: [{ date: "2099-01-01", durationMin: 60, deduct: 1 }],
      }),
    ]);

    const all = buildAllStudentQueueRows([risky, healthy]);
    const queue = buildStudentQueue([risky, healthy]);

    // The full list carries everyone (so search can reach a healthy student)...
    expect(all.map((row) => row.student).sort()).toEqual(["Healthy", "Risky"]);
    // ...while the default at-risk worklist still excludes the healthy student.
    expect(queue.map((row) => row.student)).toEqual(["Risky"]);
    // includeInQueue flag is preserved on the full-list rows for client filtering.
    expect(all.find((row) => row.student === "Healthy")?.includeInQueue).toBe(false);
    expect(all.find((row) => row.student === "Risky")?.includeInQueue).toBe(true);
  });
});
