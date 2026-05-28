import { describe, expect, it } from "vitest";
import { buildSalesDashboardPayload } from "@/lib/sales-dashboard/analytics";
import type { ParsedNormalSaleRow } from "@/lib/sales-dashboard/types";

function normalRow(overrides: Partial<ParsedNormalSaleRow>): ParsedNormalSaleRow {
  return {
    sourceMonth: "2026-01-01",
    sourceLabel: "2026-01 Jan",
    rowNumber: 1,
    studentNickname: "Student",
    program: "SAT",
    packageHours: "20-hr",
    numberOfStudents: 1,
    paymentAmount: 10_000,
    salesRepresentative: "Palm",
    paymentDate: "2026-01-01",
    enrollmentType: "New Student",
    programWiseName: "SAT",
    packageHoursClean: "20-hr",
    validUntil: "2026-01-31",
    churnStatus: "—",
    raw: {},
    ...overrides,
  };
}

describe("sales dashboard cohort analytics", () => {
  it("builds first-trial cohorts with conversion dates after the first trial", () => {
    const payload = buildSalesDashboardPayload({
      normalRows: [
        normalRow({ rowNumber: 1, studentNickname: "Alpha", packageHours: "Trial", packageHoursClean: "Trial", paymentDate: "2026-01-05", enrollmentType: "Trial", validUntil: null }),
        normalRow({ rowNumber: 2, studentNickname: "Alpha", paymentDate: "2026-01-20", enrollmentType: "New Student" }),
        normalRow({ rowNumber: 3, studentNickname: "Beta", packageHours: "Trial", packageHoursClean: "Trial", paymentDate: "2026-01-10", enrollmentType: "Trial", validUntil: null }),
        normalRow({ rowNumber: 4, studentNickname: "Gamma", packageHours: "Trial", packageHoursClean: "Trial", paymentDate: "2025-12-01", enrollmentType: "Trial", validUntil: null }),
        normalRow({ rowNumber: 5, studentNickname: "Gamma", paymentDate: "2026-01-05", enrollmentType: "New Student" }),
      ],
      additionalRows: [],
      sources: [],
      token: { connected: true, email: "admin@example.com", expiresAt: null, lastError: null },
      now: new Date("2026-05-01T00:00:00.000Z"),
    });

    expect(payload.trialCohort).toEqual([
      { nick: "gamma", trialDate: "2025-12-01", convertedDate: "2026-01-05" },
      { nick: "alpha", trialDate: "2026-01-05", convertedDate: "2026-01-20" },
      { nick: "beta", trialDate: "2026-01-10", convertedDate: null },
    ]);
  });

  it("builds retention cohorts from valid-until grace deadlines instead of valid-until dates", () => {
    const payload = buildSalesDashboardPayload({
      normalRows: [
        normalRow({ rowNumber: 1, studentNickname: "Alpha", paymentDate: "2026-01-05", enrollmentType: "New Student", validUntil: "2026-01-31" }),
        normalRow({ rowNumber: 2, studentNickname: "Alpha", paymentDate: "2026-02-20", enrollmentType: "Renewal", validUntil: "2026-03-31" }),
        normalRow({ rowNumber: 3, studentNickname: "Beta", paymentDate: "2026-01-08", enrollmentType: "New Student", validUntil: "2026-01-31" }),
      ],
      additionalRows: [],
      sources: [],
      token: { connected: true, email: "admin@example.com", expiresAt: null, lastError: null },
      now: new Date("2026-05-01T00:00:00.000Z"),
    });

    expect(payload.retentionCohort).toContainEqual({
      nick: "alpha",
      saleDate: "2026-01-05",
      validUntil: "2026-01-31",
      decisionDate: "2026-02-14",
      renewedDate: "2026-02-20",
      status: "Retained",
    });
    expect(payload.retentionCohort).toContainEqual({
      nick: "beta",
      saleDate: "2026-01-08",
      validUntil: "2026-01-31",
      decisionDate: "2026-02-14",
      renewedDate: null,
      status: "Churned",
    });
  });
});
