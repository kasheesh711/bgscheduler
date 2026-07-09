import { describe, expect, it } from "vitest";
import type { AdmissionsCaseSummary } from "@/lib/admissions/types";
import { computeCaseloadKpis } from "../caseload-shell";

function summary(overrides: Partial<AdmissionsCaseSummary> = {}): AdmissionsCaseSummary {
  return {
    caseId: overrides.caseId ?? "case-1",
    studentId: overrides.studentId ?? "student-1",
    studentName: overrides.studentName ?? "Ada Lovelace",
    preferredName: overrides.preferredName === undefined ? null : overrides.preferredName,
    cohortId: overrides.cohortId ?? "cohort-1",
    cohortName: overrides.cohortName ?? "Class of 2027",
    graduationYear: overrides.graduationYear ?? 2027,
    status: overrides.status ?? "active",
    counselorEmails: overrides.counselorEmails ?? ["mint@bg.com"],
    counselorNames: overrides.counselorNames ?? ["Mint"],
    progressPercent: overrides.progressPercent ?? 0,
    nextDeadline: overrides.nextDeadline ?? null,
    daysSinceLastTouch: overrides.daysSinceLastTouch === undefined ? null : overrides.daysSinceLastTouch,
    committedCollegeName: overrides.committedCollegeName ?? null,
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("computeCaseloadKpis", () => {
  it("counts totals and per-status buckets", () => {
    const kpis = computeCaseloadKpis([
      summary({ caseId: "c1", status: "active" }),
      summary({ caseId: "c2", status: "active" }),
      summary({ caseId: "c3", status: "committed" }),
      summary({ caseId: "c4", status: "archived" }),
    ]);
    expect(kpis.totalCases).toBe(4);
    expect(kpis.statusCounts).toEqual({
      active: 2,
      committed: 1,
      completed: 0,
      withdrawn: 0,
      archived: 1,
    });
  });

  it("returns zeros for an empty caseload", () => {
    const kpis = computeCaseloadKpis([]);
    expect(kpis.totalCases).toBe(0);
    expect(Object.values(kpis.statusCounts).every((count) => count === 0)).toBe(true);
  });
});
