import type * as schema from "@/lib/db/schema";
import { roundPayrollNumber } from "./domain";
import type { PayrollTier } from "./types";

export type PayrollStudentBand = "1" | "2" | "3_plus";

export interface ParsedPayRateRule {
  studentBand: PayrollStudentBand;
  curriculum: string;
  course: string;
  normalizedCourseKey: string;
  tierKey: PayrollTier;
  sourceTierKey: string;
  pricePerHour: number | null;
  expectedRevenuePerHour: number;
  revenueShare: number | null;
  rawSourceRow: Record<string, unknown>;
}

export type PayrollRateRuleRow = typeof schema.payrollRateRules.$inferSelect;

const RATE_COLUMNS = [
  { revenueIndex: 3, shareIndex: 8, sourceTierKey: "Tier 0-1", tiers: ["BG0", "BG1"] as PayrollTier[], priority: 2 },
  { revenueIndex: 4, shareIndex: 9, sourceTierKey: "Tier 0-2", tiers: ["BG0", "BG1", "BG2"] as PayrollTier[], priority: 1 },
  { revenueIndex: 5, shareIndex: 10, sourceTierKey: "Tier 1", tiers: ["BG1"] as PayrollTier[], priority: 3 },
  { revenueIndex: 6, shareIndex: 11, sourceTierKey: "Tier 2", tiers: ["BG2"] as PayrollTier[], priority: 3 },
  { revenueIndex: 7, shareIndex: 12, sourceTierKey: "Tier 3", tiers: ["BG3"] as PayrollTier[], priority: 3 },
];

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function compactKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\([^)]*stu[^)]*\)/gi, " ")
    .replace(/\bmasterclass\b/g, "master class")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePayRateNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cleanText(value).replace(/,/g, "");
  if (!text || /^n\/?a$/i.test(text) || /จ่าย/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePayrollRateCourse(value: string | null | undefined): string | null {
  const text = compactKey(value ?? "");
  if (!text) return null;
  const isMaster = /\bmaster\b/.test(text);

  if (/english\s+master/.test(text)) return "english_master_class";
  if (/critical\s+thinking/.test(text)) return "critical_thinking";
  if (/interview\s+prep/.test(text)) return "interview_prep";
  if (/igcse/.test(text)) return "igcse_pathway";
  if (/university/.test(text)) return isMaster ? "university_level_master" : "university_level";
  if (/(y|year)\s*2\s*-\s*8|g(rade)?\s*1\s*-\s*7/.test(text)) {
    return isMaster ? "year_2_8_grade_1_7_master" : "year_2_8_grade_1_7";
  }
  if (/(y|year)\s*9\s*-\s*11|g(rade)?\s*8\s*-\s*10/.test(text)) {
    return isMaster ? "year_9_11_grade_8_10_master" : "year_9_11_grade_8_10";
  }
  if (/(y|year)\s*12\s*-\s*13|g(rade)?\s*11\s*-\s*12/.test(text)) {
    return isMaster ? "year_12_13_grade_11_12_master" : "year_12_13_grade_11_12";
  }
  if (/grade\s*1\s*-\s*9/.test(text)) return isMaster ? "grade_1_9_master" : "grade_1_9";
  if (/grade\s*10\s*-\s*12/.test(text)) return isMaster ? "grade_10_12_master" : "grade_10_12";
  if (/11\s*\+?\s*\/\s*13\s*\+?/.test(text)) {
    return isMaster ? "admission_exam_prep_11_13_master" : "admission_exam_prep_11_13";
  }
  if (/16\s*\+/.test(text)) return isMaster ? "admission_exam_prep_16_master" : "admission_exam_prep_16";
  if (/\bged\b/.test(text)) return isMaster ? "ged_master" : "ged";
  if (/\bsat\b/.test(text)) return isMaster ? "sat_master" : "sat";
  if (/\bielts\b/.test(text)) return isMaster ? "ielts_master" : "ielts";
  return null;
}

export function payrollStudentBand(studentCount: number | null | undefined): PayrollStudentBand {
  const count = Number(studentCount);
  if (Number.isFinite(count) && count >= 3) return "3_plus";
  if (Number.isFinite(count) && count === 2) return "2";
  return "1";
}

function studentBandFromSection(value: unknown): PayrollStudentBand | null {
  const text = cleanText(value).toLowerCase();
  if (/^1\s+student\b/.test(text)) return "1";
  if (/^2\s+students?\b/.test(text)) return "2";
  if (/^3\s+students?.*more\b/.test(text)) return "3_plus";
  return null;
}

export function parsePayRateRows(rows: unknown[][]): ParsedPayRateRule[] {
  const rulesByKey = new Map<string, ParsedPayRateRule & { priority: number }>();
  let studentBand: PayrollStudentBand | null = null;
  let curriculum = "";

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const sectionBand = studentBandFromSection(row[0]);
    if (sectionBand) {
      studentBand = sectionBand;
      curriculum = "";
      continue;
    }
    if (!studentBand) continue;
    if (cleanText(row[0]) === "Curriculum" || cleanText(row[1]) === "Course") continue;

    const nextCurriculum = cleanText(row[0]);
    if (nextCurriculum) curriculum = nextCurriculum;
    const course = cleanText(row[1]);
    if (!course) continue;

    const normalizedCourseKey = normalizePayrollRateCourse(course);
    if (!normalizedCourseKey) continue;
    const pricePerHour = parsePayRateNumber(row[2]);

    for (const column of RATE_COLUMNS) {
      const expectedRevenuePerHour = parsePayRateNumber(row[column.revenueIndex]);
      if (expectedRevenuePerHour === null) continue;
      const revenueShare = parsePayRateNumber(row[column.shareIndex]);

      for (const tierKey of column.tiers) {
        const key = `${studentBand}|${normalizedCourseKey}|${tierKey}`;
        const existing = rulesByKey.get(key);
        if (existing && existing.priority >= column.priority) continue;
        rulesByKey.set(key, {
          studentBand,
          curriculum,
          course,
          normalizedCourseKey,
          tierKey,
          sourceTierKey: column.sourceTierKey,
          pricePerHour,
          expectedRevenuePerHour,
          revenueShare,
          priority: column.priority,
          rawSourceRow: {
            rowNumber: rowIndex + 1,
            sourceTierKey: column.sourceTierKey,
            values: row,
          },
        });
      }
    }
  }

  return [...rulesByKey.values()]
    .map(({ priority: _priority, ...rule }) => rule)
    .sort((left, right) => (
      left.studentBand.localeCompare(right.studentBand)
      || left.normalizedCourseKey.localeCompare(right.normalizedCourseKey)
      || left.tierKey.localeCompare(right.tierKey)
    ));
}

export function buildRateRuleLookup(rules: PayrollRateRuleRow[]): Map<string, PayrollRateRuleRow> {
  const lookup = new Map<string, PayrollRateRuleRow>();
  for (const rule of rules) {
    lookup.set(`${rule.studentBand}|${rule.normalizedCourseKey}|${rule.tierKey}`, rule);
  }
  return lookup;
}

export function rateRuleKey(input: {
  studentBand: PayrollStudentBand;
  normalizedCourseKey: string;
  tierKey: PayrollTier;
}): string {
  return `${input.studentBand}|${input.normalizedCourseKey}|${input.tierKey}`;
}

export function actualInvoiceRate(input: {
  amount: number;
  sessionCredits: number;
}): number | null {
  if (input.amount <= 0 || input.sessionCredits <= 0) return null;
  return roundPayrollNumber(input.amount / input.sessionCredits, 2);
}
