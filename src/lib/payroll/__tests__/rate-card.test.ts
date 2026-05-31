import { describe, expect, it } from "vitest";
import {
  actualInvoiceRate,
  normalizePayrollRateCourse,
  parsePayRateRows,
  payrollStudentBand,
} from "../rate-card";

describe("payroll rate card helpers", () => {
  it("parses PayRate sections and expands grouped tier columns", () => {
    const rules = parsePayRateRows([
      ["1 student"],
      ["Curriculum", "Course", "Price/Hour", "Tutors' Revenue Per Hour"],
      ["", "", "", "Tier 0-1", "Tier 0-2", "Tier 1", "Tier 2", "Tier 3"],
      ["UK/US/IB", "Year 2-8 or Grade 1-7", "1,200", "N/A", "N/A", "600", "500", "400", "n/a", "n/a", "0.5", "0.4166666667", "0.3333333333"],
      ["", "Year 2-8 or Grade 1-7 | Master Class", "2,000", "N/A", "1,000", "N/A", "N/A", "N/A", "n/a", "0.5", "n/a", "n/a", "n/a"],
      ["", "IGCSE Pathway", "", "จ่าย additional", "N/A", "N/A", "N/A", "N/A"],
      [],
      ["2 students"],
      ["Curriculum", "Course", "Price/Hour", "Tutors' Revenue Per Hour"],
      ["", "", "", "Tier 0-1", "Tier 0-2", "Tier 1", "Tier 2", "Tier 3"],
      ["UK/US/IB", "Year 9-11 or Grade 8-10", "1,200", "N/A", "N/A", "1,050", "900", "750", "n/a", "n/a", "0.4375", "0.375", "0.3125"],
      [],
      ["3 students & More"],
      ["Curriculum", "Course", "Price/Hour", "Tutors' Revenue Per Hour"],
      ["", "", "", "Tier 0-1", "Tier 0-2", "Tier 1", "Tier 2", "Tier 3"],
      ["UK/US/IB", "English Master Class", "2,300", "2,700", "N/A", "N/A", "N/A", "N/A", "0.3913043478"],
    ]);

    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentBand: "1", normalizedCourseKey: "year_2_8_grade_1_7", tierKey: "BG1", expectedRevenuePerHour: 600 }),
      expect.objectContaining({ studentBand: "1", normalizedCourseKey: "year_2_8_grade_1_7", tierKey: "BG2", expectedRevenuePerHour: 500 }),
      expect.objectContaining({ studentBand: "1", normalizedCourseKey: "year_2_8_grade_1_7_master", tierKey: "BG0", expectedRevenuePerHour: 1000 }),
      expect.objectContaining({ studentBand: "2", normalizedCourseKey: "year_9_11_grade_8_10", tierKey: "BG3", expectedRevenuePerHour: 750 }),
      expect.objectContaining({ studentBand: "3_plus", normalizedCourseKey: "english_master_class", tierKey: "BG0", expectedRevenuePerHour: 2700 }),
    ]));
    expect(rules.some((rule) => rule.normalizedCourseKey === "igcse_pathway")).toBe(false);
  });

  it("normalizes Wise subject names into PayRate course keys", () => {
    expect(normalizePayrollRateCourse("Y2-8 / G1-7 (Int.)")).toBe("year_2_8_grade_1_7");
    expect(normalizePayrollRateCourse("(2-STU) Y9-11 / G8-10 (Int.)")).toBe("year_9_11_grade_8_10");
    expect(normalizePayrollRateCourse("11+/13+ Master")).toBe("admission_exam_prep_11_13_master");
    expect(normalizePayrollRateCourse("English Masterclass")).toBe("english_master_class");
    expect(normalizePayrollRateCourse("Unknown Subject")).toBeNull();
  });

  it("calculates student bands and invoice rates", () => {
    expect(payrollStudentBand(1)).toBe("1");
    expect(payrollStudentBand(2)).toBe("2");
    expect(payrollStudentBand(4)).toBe("3_plus");
    expect(payrollStudentBand(null)).toBe("1");
    expect(actualInvoiceRate({ amount: 1050, sessionCredits: 1.5 })).toBe(700);
    expect(actualInvoiceRate({ amount: 0, sessionCredits: 1 })).toBeNull();
  });
});
