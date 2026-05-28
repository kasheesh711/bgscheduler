import type {
  ParsedSalesProjectionWorkbook,
  SalesProjectionMonthRecord,
  SalesProjectionScenario,
  SalesProjectionScenarioSummary,
} from "./types";

export const DEFAULT_PROJECTION_SPREADSHEET_URL =
  "https://docs.google.com/spreadsheets/d/1WKVBsd6ORCjxTyosjwJ7Azxplv64SDYakL4rBZ68QAs/edit";
export const DEFAULT_PROJECTION_SUMMARY_SHEET = "Summary";
export const DEFAULT_PROJECTION_WHAT_IF_SHEET = "What_If";
export const DEFAULT_PROJECTION_CALC_MULTI_SHEET = "Calc_Multi";

const SCENARIOS: SalesProjectionScenario[] = ["Bear", "Base", "Bull"];
const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

const REQUIRED_CALC_ROWS = {
  totalNetRevenue: ["total net revenue"],
  renewalRevenue: ["renewal rev", "renewal revenue"],
  newStudentRevenue: ["new rev", "new student revenue"],
  trialRevenue: ["trial rev", "trial revenue"],
  activeStudents: ["active students"],
  trialBookings: ["trial bookings"],
  newStudents: ["new students added", "new students"],
  packRenewals: ["pack renewals"],
  renewalHours: ["renewal hours"],
  newStudentHours: ["new student hours"],
  trialHours: ["trial hours"],
  totalHours: ["total hours", "total hours sold"],
  roomCapacity: ["room capacity", "room capacity ceiling"],
  roomUtilization: ["util %", "room utilization"],
} as const;

type ProjectionMetric = keyof typeof REQUIRED_CALC_ROWS;

function compact(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return compact(value).toLowerCase().replace(/\s+/g, " ");
}

function numeric(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = compact(value).replace(/[฿,%\s,]/g, "");
  const parsed = Number(cleaned);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Projection workbook has a non-numeric value for ${label}`);
}

function optionalNumeric(value: unknown): number {
  if (value === null || value === undefined || compact(value) === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(compact(value).replace(/[฿,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthStartFromProjectionLabel(label: unknown): string | null {
  const raw = compact(label);
  const match = raw.match(/^([A-Za-z]{3,})\s*'?\s*(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const year = match[2].length === 2 ? `20${match[2]}` : match[2];
  return `${year}-${month}-01`;
}

function rowLabel(row: unknown[]): string {
  return normalized(row[0]);
}

function findRow(rows: unknown[][], aliases: readonly string[]): unknown[] | null {
  const normalizedAliases = aliases.map((alias) => normalized(alias));
  return rows.find((row) => normalizedAliases.includes(rowLabel(row))) ?? null;
}

function findSummaryValue(summaryRows: unknown[][], rowAlias: string, scenario: SalesProjectionScenario): number | string {
  const headerRow = summaryRows.find((row) => SCENARIOS.every((item) => row.map(compact).includes(item)));
  if (!headerRow) throw new Error("Projection Summary sheet is missing Bear/Base/Bull headers");
  const scenarioIndex = headerRow.findIndex((cell) => compact(cell) === scenario);
  if (scenarioIndex < 0) throw new Error(`Projection Summary sheet is missing ${scenario} column`);

  const row = summaryRows.find((candidate) => normalized(candidate[1]) === normalized(rowAlias));
  if (!row) throw new Error(`Projection Summary sheet is missing "${rowAlias}"`);
  return row[scenarioIndex] as number | string;
}

function parseScenarioSummaries(summaryRows: unknown[][]): SalesProjectionScenarioSummary[] {
  return SCENARIOS.map((scenario) => ({
    scenario,
    totalRevenue21Month: numeric(findSummaryValue(summaryRows, "21-month total revenue", scenario), `${scenario} 21-month total revenue`),
    revenueAprDec2026: numeric(findSummaryValue(summaryRows, "Apr-Dec '26 (9 mo)", scenario), `${scenario} Apr-Dec 2026 revenue`),
    revenueCy2027: numeric(findSummaryValue(summaryRows, "CY 2027 (12 mo)", scenario), `${scenario} CY 2027 revenue`),
    avgMonthlyRevenue: numeric(findSummaryValue(summaryRows, "Avg monthly revenue", scenario), `${scenario} average monthly revenue`),
    endActiveStudents: numeric(findSummaryValue(summaryRows, "Dec '27 active (end)", scenario), `${scenario} Dec 2027 active students`),
    studentGrowthPct: numeric(findSummaryValue(summaryRows, "Student growth 21 mo", scenario), `${scenario} student growth`),
    endPackRenewals: numeric(findSummaryValue(summaryRows, "Dec '27 packs renewed", scenario), `${scenario} Dec 2027 pack renewals`),
    revenueStatus: compact(findSummaryValue(summaryRows, "Revenue status", scenario)),
  }));
}

function parseTargetMonthlyRevenue(whatIfRows: unknown[][]): number {
  const targetRow = whatIfRows.find((row) => normalized(row[1]) === "effective monthly revenue target")
    ?? whatIfRows.find((row) => normalized(row[1]) === "target monthly revenue (thb)");
  if (!targetRow) {
    throw new Error("Projection What_If sheet is missing Effective monthly revenue target");
  }
  return numeric(targetRow[2], "What_If target monthly revenue");
}

function findMonthHeader(calcRows: unknown[][]): Array<{ index: number; label: string; month: string }> {
  for (const row of calcRows) {
    const months = row
      .map((cell, index) => {
        const month = monthStartFromProjectionLabel(cell);
        return month ? { index, label: compact(cell), month } : null;
      })
      .filter((cell): cell is { index: number; label: string; month: string } => Boolean(cell));
    if (months.length >= 2) return months;
  }
  throw new Error("Projection Calc_Multi sheet is missing monthly projection headers");
}

function findScenarioBlocks(calcRows: unknown[][]): Map<SalesProjectionScenario, unknown[][]> {
  const starts: Array<{ scenario: SalesProjectionScenario; rowIndex: number }> = [];
  calcRows.forEach((row, rowIndex) => {
    const marker = compact(row[0]).match(/^---\s*(Bear|Base|Bull)\s*---$/i);
    if (!marker) return;
    const scenario = SCENARIOS.find((item) => item.toLowerCase() === marker[1].toLowerCase());
    if (scenario) starts.push({ scenario, rowIndex });
  });
  if (starts.length < SCENARIOS.length) {
    throw new Error("Projection Calc_Multi sheet is missing one or more Bear/Base/Bull scenario blocks");
  }

  const blocks = new Map<SalesProjectionScenario, unknown[][]>();
  starts.forEach((start, index) => {
    const end = starts[index + 1]?.rowIndex ?? calcRows.length;
    blocks.set(start.scenario, calcRows.slice(start.rowIndex + 1, end));
  });
  return blocks;
}

function parseMonthKind(calcRows: unknown[][], monthColumns: Array<{ index: number; label: string; month: string }>): Map<number, "actual" | "forecast"> {
  const statusRow = calcRows.find((row) => monthColumns.some((column) => normalized(row[column.index]) === "actual"));
  const map = new Map<number, "actual" | "forecast">();
  for (const column of monthColumns) {
    const status = normalized(statusRow?.[column.index]);
    map.set(column.index, status === "actual" ? "actual" : "forecast");
  }
  return map;
}

function parseScenarioMonths(calcRows: unknown[][]): SalesProjectionMonthRecord[] {
  const monthColumns = findMonthHeader(calcRows);
  const monthKinds = parseMonthKind(calcRows, monthColumns);
  const blocks = findScenarioBlocks(calcRows);
  const records: SalesProjectionMonthRecord[] = [];

  for (const scenario of SCENARIOS) {
    const rows = blocks.get(scenario);
    if (!rows) throw new Error(`Projection Calc_Multi sheet is missing ${scenario} scenario rows`);
    const metricRows = Object.fromEntries(
      Object.entries(REQUIRED_CALC_ROWS).map(([metric, aliases]) => {
        const row = findRow(rows, aliases);
        if (!row) throw new Error(`Projection Calc_Multi ${scenario} block is missing "${aliases[0]}"`);
        return [metric, row];
      }),
    ) as Record<ProjectionMetric, unknown[]>;

    for (const column of monthColumns) {
      records.push({
        scenario,
        projectionMonth: column.month,
        monthLabel: column.label,
        monthKind: monthKinds.get(column.index) ?? "forecast",
        totalNetRevenue: optionalNumeric(metricRows.totalNetRevenue[column.index]),
        renewalRevenue: optionalNumeric(metricRows.renewalRevenue[column.index]),
        newStudentRevenue: optionalNumeric(metricRows.newStudentRevenue[column.index]),
        trialRevenue: optionalNumeric(metricRows.trialRevenue[column.index]),
        activeStudents: optionalNumeric(metricRows.activeStudents[column.index]),
        trialBookings: optionalNumeric(metricRows.trialBookings[column.index]),
        newStudents: optionalNumeric(metricRows.newStudents[column.index]),
        packRenewals: optionalNumeric(metricRows.packRenewals[column.index]),
        renewalHours: optionalNumeric(metricRows.renewalHours[column.index]),
        newStudentHours: optionalNumeric(metricRows.newStudentHours[column.index]),
        trialHours: optionalNumeric(metricRows.trialHours[column.index]),
        totalHours: optionalNumeric(metricRows.totalHours[column.index]),
        roomCapacity: optionalNumeric(metricRows.roomCapacity[column.index]),
        roomUtilization: optionalNumeric(metricRows.roomUtilization[column.index]),
      });
    }
  }

  return records.sort((left, right) => left.projectionMonth.localeCompare(right.projectionMonth) || left.scenario.localeCompare(right.scenario));
}

export function parseSalesProjectionWorkbook(input: {
  summaryRows: unknown[][];
  whatIfRows: unknown[][];
  calcMultiRows: unknown[][];
}): ParsedSalesProjectionWorkbook {
  const targetMonthlyRevenue = parseTargetMonthlyRevenue(input.whatIfRows);
  const scenarioSummaries = parseScenarioSummaries(input.summaryRows);
  const months = parseScenarioMonths(input.calcMultiRows);

  return {
    targetMonthlyRevenue,
    scenarioSummaries,
    months,
    metadata: {
      scenarioSummaries,
      projectionStart: months[0]?.projectionMonth ?? null,
      projectionEnd: months.at(-1)?.projectionMonth ?? null,
    },
  };
}
