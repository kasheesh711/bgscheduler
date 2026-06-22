import { describe, it, expect } from "vitest";
import { institutionsToCsv } from "../csv";
import type { IpedsInstitutionSummary } from "../types";

function summary(overrides: Partial<IpedsInstitutionSummary>): IpedsInstitutionSummary {
  return { instName: "Test U", ...overrides } as unknown as IpedsInstitutionSummary;
}

describe("institutionsToCsv", () => {
  it("emits a header row with the institution name column", () => {
    const csv = institutionsToCsv([summary({ instName: "Yale University", stateAbbr: "CT" })]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toContain('"Institution"');
    expect(lines[1]).toContain('"Yale University"');
    expect(lines[1]).toContain('"CT"');
  });

  it("renders null/undefined metrics as empty strings (not 'null')", () => {
    const csv = institutionsToCsv([summary({ instName: "X", acceptanceRate: null })]);
    expect(csv).not.toContain("null");
  });

  it("maps control code to a label", () => {
    const csv = institutionsToCsv([summary({ instName: "X", control: 1 })]);
    expect(csv).toContain('"Public"');
  });
});
