import { describe, expect, it, vi } from "vitest";
import type { DashboardPayload, StudentRecord } from "@/types/credit-control";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { resolveInitialCreditStudentKey } from "../dashboard-shell";

function student(studentKey: string, name: string): StudentRecord {
  return {
    student: name,
    parent: "Parent",
    packages: [],
    dataQualityFlags: [],
    adminOwnerKey: "unassigned",
    adminOwnerName: "Unassigned",
    adminOwnershipSource: "test",
    studentKey,
    actionState: null,
  };
}

function payload(students: StudentRecord[], queueKeys: string[]): DashboardPayload {
  return {
    adminViews: [],
    lastUpdatedAt: "2026-06-15T00:00:00.000Z",
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
      queue: { students: queueKeys.length, pinnedStudents: 0 },
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
    studentQueue: queueKeys.map((key, index) => ({
      key,
      studentKey: key,
      student: students.find((item) => item.studentKey === key)?.student ?? key,
      parent: "Parent",
      studentIndex: index,
      adminOwnerKey: "unassigned",
      adminOwnerName: "Unassigned",
      actionState: null,
      worstStatus: "notify",
      packageCount: 1,
      riskyPackageCount: 1,
      totalCurrentRemaining: 1,
      totalAdjustedRemaining: 1,
      totalPendingDeduction: 0,
      totalCredits: 20,
      packageNames: ["20h"],
      nextSessionDate: null,
      nextSessionPackageName: null,
      nextSessionCount: 0,
      nextAlertDate: null,
      nextExhaustDate: null,
      daysUntilAlert: null,
      daysUntilExhaust: null,
      noFutureSchedule: false,
      pinned: false,
      includeInQueue: true,
      priorityScore: 1,
      recommendedAction: "Follow up",
      whyNow: "Low balance",
      searchText: key,
    })),
    studentQueueAll: [],
    calendar: { availableStart: null, availableEnd: null, days: [] },
    students,
  };
}

describe("resolveInitialCreditStudentKey", () => {
  it("selects a valid deep-linked active student even when they are not first in the queue", () => {
    const model = payload([student("bell", "Bell"), student("mint", "Mint")], ["mint", "bell"]);

    expect(resolveInitialCreditStudentKey(model, "bell")).toBe("bell");
  });

  it("falls back to the existing default selection when the requested key is invalid", () => {
    const model = payload([student("bell", "Bell"), student("mint", "Mint")], ["mint", "bell"]);

    expect(resolveInitialCreditStudentKey(model, "ghost")).toBe("mint");
  });

  it("preserves the normal default when no studentKey is supplied", () => {
    const model = payload([student("bell", "Bell")], ["bell"]);

    expect(resolveInitialCreditStudentKey(model, null)).toBe("bell");
  });
});
