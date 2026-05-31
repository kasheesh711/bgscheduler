import type { PayrollPayload } from "./types";

export interface LegacyAggregateTutorRow {
  tier: string;
  tutorName: string;
  hours: number;
  balance: number;
}

export interface LegacyAggregatePayroll {
  tutors: LegacyAggregateTutorRow[];
  totals: {
    tutorCount: number;
    hours: number;
    balance: number;
  } | null;
}

export interface LegacyLongPayrollLine {
  tutorName: string;
  tier: string;
  date: string;
  description: string;
  income: number;
  payments: number;
  cancelled: boolean;
}

export interface MayPayrollReconciliationReport {
  legacyTotals: LegacyAggregatePayroll["totals"];
  wiseTotals: {
    tutorCount: number;
    hours: number;
    balance: number;
  };
  missingInWise: LegacyAggregateTutorRow[];
  extraInWise: string[];
  tutorDifferences: Array<{
    tutorName: string;
    legacyHours: number;
    wiseHours: number;
    hourVariance: number;
    legacyBalance: number;
    wiseBalance: number;
    balanceVariance: number;
  }>;
  longPayrollLineCount: number;
  cancelledLongPayrollLineCount: number;
  rateIssueCount: number;
}

function cell(row: unknown[], index: number): string {
  return String(row[index] ?? "").trim();
}

export function parsePayrollNumber(value: unknown): number {
  const text = String(value ?? "").replace(/[฿,\s]/g, "").replace(/Hours?/i, "").replace(/Tutors?/i, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTutorName(value: string): string {
  return value
    .replace(/^BG[0-3]:\s*/i, "")
    .replace(/\s+Online$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseLegacyAggregatePayroll(rows: unknown[][]): LegacyAggregatePayroll {
  const tutors: LegacyAggregateTutorRow[] = [];
  let totals: LegacyAggregatePayroll["totals"] = null;

  for (const row of rows) {
    const first = cell(row, 0);
    const match = /^(BG[0-3]|Unassigned):\s*(.+)$/.exec(first);
    if (match) {
      tutors.push({
        tier: match[1],
        tutorName: match[2].trim(),
        hours: parsePayrollNumber(row[1]),
        balance: parsePayrollNumber(row[2]),
      });
      continue;
    }
    if (/Tutors$/i.test(first)) {
      totals = {
        tutorCount: parsePayrollNumber(first),
        hours: parsePayrollNumber(row[1]),
        balance: parsePayrollNumber(row[2]),
      };
    }
  }

  return { tutors, totals };
}

export function parseLegacyLongPayroll(rows: unknown[][]): LegacyLongPayrollLine[] {
  const lines: LegacyLongPayrollLine[] = [];
  let currentTutorName = "";
  let currentTier = "";

  for (const row of rows) {
    const first = cell(row, 0);
    const tutorMatch = /^(BG[0-3]|Unassigned):\s*(.+)$/.exec(first);
    if (tutorMatch) {
      currentTier = tutorMatch[1];
      currentTutorName = tutorMatch[2].trim();
      continue;
    }
    if (!currentTutorName || first === "Date" || first === "Totals" || first === "Tutor Balance") continue;
    const description = cell(row, 1);
    if (!first || !description) continue;
    lines.push({
      tutorName: currentTutorName,
      tier: currentTier,
      date: first,
      description,
      income: parsePayrollNumber(row[2]),
      payments: parsePayrollNumber(row[3]),
      cancelled: /cancelled|canceled/i.test(description),
    });
  }

  return lines;
}

export function buildMayPayrollReconciliationReport(input: {
  aggregateRows: unknown[][];
  longPayrollRows: unknown[][];
  payload: PayrollPayload;
}): MayPayrollReconciliationReport {
  const legacy = parseLegacyAggregatePayroll(input.aggregateRows);
  const longLines = parseLegacyLongPayroll(input.longPayrollRows);
  const wiseByName = new Map(input.payload.tutors.map((row) => [normalizeTutorName(row.tutorName), row]));
  const legacyByName = new Map(legacy.tutors.map((row) => [normalizeTutorName(row.tutorName), row]));
  const missingInWise = legacy.tutors.filter((row) => !wiseByName.has(normalizeTutorName(row.tutorName)));
  const extraInWise = input.payload.tutors
    .filter((row) => !legacyByName.has(normalizeTutorName(row.tutorName)))
    .map((row) => row.tutorName)
    .sort();
  const tutorDifferences = legacy.tutors.flatMap((legacyRow) => {
    const wiseRow = wiseByName.get(normalizeTutorName(legacyRow.tutorName));
    if (!wiseRow) return [];
    const hourVariance = Number((wiseRow.paidHours - legacyRow.hours).toFixed(2));
    const balanceVariance = Number((wiseRow.payoutAmount - legacyRow.balance).toFixed(2));
    if (Math.abs(hourVariance) <= 0.01 && Math.abs(balanceVariance) <= 0.01) return [];
    return [{
      tutorName: legacyRow.tutorName,
      legacyHours: legacyRow.hours,
      wiseHours: wiseRow.paidHours,
      hourVariance,
      legacyBalance: legacyRow.balance,
      wiseBalance: wiseRow.payoutAmount,
      balanceVariance,
    }];
  });

  return {
    legacyTotals: legacy.totals,
    wiseTotals: {
      tutorCount: input.payload.summary.tutorCount,
      hours: input.payload.summary.paidHours,
      balance: input.payload.summary.totalPayoutAmount,
    },
    missingInWise,
    extraInWise,
    tutorDifferences,
    longPayrollLineCount: longLines.length,
    cancelledLongPayrollLineCount: longLines.filter((line) => line.cancelled).length,
    rateIssueCount: input.payload.summary.expectedRateMismatchCount
      + input.payload.summary.missingRateRuleCount
      + input.payload.summary.unmappedRateCourseCount,
  };
}
