import { describe, expect, it } from "vitest";
import {
  computeLiveStatus,
  decisionDateFor,
  findConversion,
  normalizeRepKey,
  normalizeStudentKey,
} from "../cohorts";
import { analyzeNormalSalesRows } from "../parser";
import type { ParsedNormalSaleRow } from "../types";

function row(overrides: Partial<ParsedNormalSaleRow>): ParsedNormalSaleRow {
  return {
    sourceMonth: "2026-01-01",
    sourceLabel: "2026-01 Jan",
    rowNumber: 4,
    studentNickname: "Nong A",
    program: "Math",
    packageHours: "20 Hours",
    numberOfStudents: 1,
    paymentAmount: 10_000,
    salesRepresentative: "Alice",
    paymentDate: "2026-01-10",
    enrollmentType: "New Student",
    programWiseName: "Mathematics",
    packageHoursClean: "20 Hours",
    validUntil: null,
    churnStatus: "",
    raw: {},
    ...overrides,
  };
}

describe("normalizeRepKey / normalizeStudentKey", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeRepKey("  Alice   Wong ")).toBe("alice wong");
    expect(normalizeStudentKey("Nong\t A ")).toBe("nong a");
  });

  it("maps distinct spellings of the same name to one key", () => {
    expect(normalizeRepKey("ALICE")).toBe(normalizeRepKey(" alice "));
    expect(normalizeStudentKey("Nong  A")).toBe(normalizeStudentKey("nong a"));
  });
});

describe("decisionDateFor", () => {
  it("adds the 14-day grace window", () => {
    expect(decisionDateFor("2026-01-10")).toBe("2026-01-24");
  });

  it("crosses month boundaries", () => {
    expect(decisionDateFor("2026-01-31")).toBe("2026-02-14");
  });
});

describe("findConversion", () => {
  const rows = [
    row({ paymentDate: "2026-01-05", enrollmentType: "Trial" }),
    row({ paymentDate: "2026-01-05", enrollmentType: "New Student" }),
    row({ paymentDate: "2026-01-12", enrollmentType: "New Student" }),
    row({ paymentDate: "2026-02-01", enrollmentType: "Renewal" }),
  ];

  it("returns the first New Student row strictly after the trial date", () => {
    const conversion = findConversion(rows, "2026-01-05");
    expect(conversion?.paymentDate).toBe("2026-01-12");
  });

  it("ignores same-day and renewal rows", () => {
    expect(findConversion(rows, "2026-01-12")).toBeNull();
  });
});

describe("computeLiveStatus", () => {
  it("returns Trial-only when every row is a trial", () => {
    const result = computeLiveStatus(
      [row({ enrollmentType: "Trial", validUntil: null })],
      "2026-06-01",
    );
    expect(result).toEqual({ status: "Trial-only", latestValidUntil: null, decisionDate: null });
  });

  it("returns Pending when the latest paid row has no validUntil", () => {
    const result = computeLiveStatus(
      [row({ enrollmentType: "New Student", validUntil: null })],
      "2026-06-01",
    );
    expect(result).toEqual({ status: "Pending", latestValidUntil: null, decisionDate: null });
  });

  it("returns Active while inside the validUntil+14d grace window", () => {
    const result = computeLiveStatus(
      [row({ paymentDate: "2026-05-01", enrollmentType: "New Student", validUntil: "2026-05-25" })],
      "2026-06-01",
    );
    expect(result.status).toBe("Active");
    expect(result.latestValidUntil).toBe("2026-05-25");
    expect(result.decisionDate).toBe("2026-06-08");
  });

  it("returns Churned after the grace window with no later payment", () => {
    const result = computeLiveStatus(
      [row({ paymentDate: "2026-01-01", enrollmentType: "New Student", validUntil: "2026-01-31" })],
      "2026-06-01",
    );
    expect(result.status).toBe("Churned");
    expect(result.decisionDate).toBe("2026-02-14");
  });

  it("judges from the latest paid row when the student renewed", () => {
    const result = computeLiveStatus(
      [
        row({ paymentDate: "2026-01-01", enrollmentType: "New Student", validUntil: "2026-01-31" }),
        row({ paymentDate: "2026-05-20", enrollmentType: "Renewal", validUntil: "2026-07-31" }),
      ],
      "2026-06-01",
    );
    expect(result.status).toBe("Active");
    expect(result.latestValidUntil).toBe("2026-07-31");
  });

  it("diverges from the stored churn_status when time has passed since import", () => {
    // Imported on 2026-02-01: validUntil+14d (2026-02-14) was still ahead, so
    // the stored churn_status froze as "Active".
    const imported = analyzeNormalSalesRows(
      [row({ paymentDate: "2026-01-01", enrollmentType: "New Student", validUntil: "2026-01-31", churnStatus: "" })],
      new Date("2026-02-01T00:00:00.000Z"),
    );
    expect(imported[0].churnStatus).toBe("Active");

    // Live recompute months later: the grace window passed with no renewal.
    const live = computeLiveStatus(imported, "2026-06-01");
    expect(live.status).toBe("Churned");
    expect(live.status).not.toBe(imported[0].churnStatus);
  });
});
