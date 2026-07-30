import { REVIEWED_PAYOUT_TUTOR_MAPPINGS } from "./payout-tutor-mapping";
import { payoutRunWindow, type PayoutRunWindow } from "./payout-window";

export const PAYOUT_TAB_COLUMN_COUNT = 8;
export const PAYOUT_TAB_HEADERS = [
  "Teacher name",
  "Session name",
  "Course name",
  "Date",
  "Time",
  "Duration",
  "Credits deducted",
  "Payout amount",
] as const;

export interface PayoutWorkbookInventoryInput {
  path: string;
  spreadsheetId: string;
}

/** Parse the recursive Apps Script `path<TAB>spreadsheetId` inventory. */
export function parsePayoutWorkbookInventoryTsv(raw: string): PayoutWorkbookInventoryInput[] {
  const inputs: PayoutWorkbookInventoryInput[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urlId = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/u)?.[1];
    const fields = trimmed.split(/\t/u);
    const candidate = urlId ?? fields.at(-1)?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{20,}$/u.test(candidate)) {
      throw new Error(
        `Invalid payout workbook inventory line ${index + 1}; expected path<TAB>spreadsheetId.`,
      );
    }
    const label = fields.length > 1
      ? fields.slice(0, -1).join("\t").trim()
      : trimmed;
    inputs.push({ path: label || candidate, spreadsheetId: candidate });
  }
  return inputs.toSorted((left, right) =>
    left.path.localeCompare(right.path) || left.spreadsheetId.localeCompare(right.spreadsheetId));
}

/** Read the value beside a `TUTOR` label from a bounded preamble grid. */
export function payoutWorkbookTutorCell(grid: unknown[][]): string | null {
  const row = grid.find((cells) =>
    String(cells?.[0] ?? "").trim().toLocaleLowerCase("en-US") === "tutor");
  const value = String(row?.[1] ?? "").trim();
  return value || null;
}

function normalizedTutorIdentity(value: string): string {
  return value.toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function payoutWorkbookTutorCandidateKeys(tutorCell: string): Set<string> {
  const candidates = new Set<string>([normalizedTutorIdentity(tutorCell)]);
  const openingParen = tutorCell.indexOf("(");
  const closingParen = tutorCell.indexOf(")", openingParen + 1);
  if (openingParen < 0 || closingParen < 0) return candidates;

  const leadingName = tutorCell.slice(0, openingParen).trim();
  const parentheticalName = tutorCell.slice(openingParen + 1, closingParen).trim();
  for (const candidate of [
    leadingName,
    parentheticalName,
    `${leadingName} ${parentheticalName}`,
  ]) {
    const normalized = normalizedTutorIdentity(candidate);
    if (normalized) candidates.add(normalized);
  }
  return candidates;
}

function withoutOnlineSuffix(value: string): string {
  return value.replace(/\s+online$/iu, "").trim();
}

function reviewedPayoutWorkbookCanonicalKey(tutorCell: string): string | null {
  const workbookIdentity = withoutOnlineSuffix(normalizedTutorIdentity(tutorCell));
  return REVIEWED_PAYOUT_TUTOR_MAPPINGS.find((reviewed) =>
    [reviewed.primaryLedgerName, reviewed.alternateLedgerName].some((value) =>
      value !== null
      && withoutOnlineSuffix(normalizedTutorIdentity(value)) === workbookIdentity))
    ?.canonicalKey ?? null;
}

/** Conservative workbook TUTOR → canonical-key validation. */
export function payoutWorkbookTutorMatchesKey(
  tutorCell: string,
  canonicalKey: string,
): boolean {
  const reviewedKey = reviewedPayoutWorkbookCanonicalKey(tutorCell);
  if (reviewedKey) return reviewedKey === canonicalKey;

  const key = normalizedTutorIdentity(canonicalKey);
  return payoutWorkbookTutorCandidateKeys(tutorCell).has(key);
}

/** Resolve a TUTOR cell against the active Wise canonical-key catalog. */
export function resolvePayoutWorkbookTutorKeys(
  tutorCell: string,
  canonicalKeys: readonly string[],
): string[] {
  return [...new Set(canonicalKeys.filter((key) =>
    payoutWorkbookTutorMatchesKey(tutorCell, key)))];
}

function quoteFormulaSheetName(name: string): string {
  return `'${name.replace(/'/gu, "''")}'`;
}

/**
 * Composite tab formula placed in A2, beneath literal A:H headers.
 *
 * Both inputs begin at row 2 so refreshed source headers and app-owned headers
 * cannot appear as payout rows.
 */
export function buildPayoutCompositeFormula(input: {
  sourceSheetName: string;
  deductionsSheetName: string;
}): string {
  const source = quoteFormulaSheetName(input.sourceSheetName);
  const deductions = quoteFormulaSheetName(input.deductionsSheetName);
  return `=QUERY({${source}!A2:H;${deductions}!A2:H},`
    + `"where Col1 is not null",0)`;
}

export interface FormulaSubstitution {
  before: string;
  after: string;
  sourceRange: string;
  compositeRange: string;
}

function exactRangeCandidates(sheetName: string): string[] {
  return [
    `${sheetName}!A:H`,
    `${sheetName}!A2:H`,
    `${quoteFormulaSheetName(sheetName)}!A:H`,
    `${quoteFormulaSheetName(sheetName)}!A2:H`,
  ];
}

interface FormulaStringLiteral {
  content: string;
  contentStart: number;
  contentEnd: number;
}

/** Google Sheets strings use doubled `""` to represent a quote. */
function formulaStringLiterals(formula: string): FormulaStringLiteral[] {
  const literals: FormulaStringLiteral[] = [];
  let index = 0;
  while (index < formula.length) {
    if (formula[index] !== '"') {
      index += 1;
      continue;
    }
    const contentStart = index + 1;
    let content = "";
    index += 1;
    while (index < formula.length) {
      if (formula[index] !== '"') {
        content += formula[index];
        index += 1;
        continue;
      }
      if (formula[index + 1] === '"') {
        content += '"';
        index += 2;
        continue;
      }
      literals.push({ content, contentStart, contentEnd: index });
      index += 1;
      break;
    }
  }
  return literals;
}

function approvedMasterReference(reference: string, masterSpreadsheetId: string): boolean {
  if (reference === masterSpreadsheetId) return true;
  const escaped = masterSpreadsheetId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^https://docs\\.google\\.com/spreadsheets/d/${escaped}(?:/|$)`,
    "u",
  ).test(reference);
}

function formulaRangeMatches(
  formula: string,
  sheetName: string,
  masterSpreadsheetId: string,
) {
  const candidates = new Set(exactRangeCandidates(sheetName));
  const literals = formulaStringLiterals(formula);
  const matches: Array<{ candidate: string; index: number; end: number }> = [];
  for (let index = 0; index < literals.length - 1; index += 1) {
    const spreadsheet = literals[index];
    const range = literals[index + 1];
    if (!approvedMasterReference(spreadsheet.content, masterSpreadsheetId)
      || !candidates.has(range.content)) {
      continue;
    }
    const beforeSpreadsheet = formula.slice(0, spreadsheet.contentStart - 1);
    const separator = formula.slice(spreadsheet.contentEnd + 1, range.contentStart - 1);
    if (!/IMPORTRANGE\s*\(\s*$/iu.test(beforeSpreadsheet)
      || !/^\s*[,;]\s*$/u.test(separator)) {
      continue;
    }
    matches.push({
      candidate: range.content,
      index: range.contentStart,
      end: range.contentEnd,
    });
  }
  return matches;
}

/**
 * Repoint exactly one imported A:H/A2:H source range.
 *
 * The rest of the formula—including tutor identity and B4:B5 predicates—is
 * byte-for-byte preserved. Unknown variants abort preflight rather than being
 * rewritten heuristically.
 */
export function substitutePayoutSourceRange(input: {
  formula: string;
  masterSpreadsheetId: string;
  sourceSheetName: string;
  compositeSheetName: string;
}): FormulaSubstitution {
  const matches = formulaRangeMatches(
    input.formula,
    input.sourceSheetName,
    input.masterSpreadsheetId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${input.sourceSheetName} A:H source range; found ${matches.length}.`,
    );
  }
  const sourceRange = matches[0].candidate;
  const quoted = sourceRange.startsWith("'");
  const startsAtRow2 = sourceRange.endsWith("A2:H");
  const compositeRange = `${
    quoted ? quoteFormulaSheetName(input.compositeSheetName) : input.compositeSheetName
  }!${startsAtRow2 ? "A2:H" : "A:H"}`;
  const after = input.formula.slice(0, matches[0].index)
    + compositeRange
    + input.formula.slice(matches[0].end);
  return {
    before: input.formula,
    after,
    sourceRange,
    compositeRange,
  };
}

export function planPayoutFormulaRepoint(input: {
  formula: string;
  masterSpreadsheetId: string;
  sourceSheetName: string;
  compositeSheetName: string;
}): FormulaSubstitution & { alreadyRepointed: boolean } {
  const sourceMatches = formulaRangeMatches(
    input.formula,
    input.sourceSheetName,
    input.masterSpreadsheetId,
  );
  const compositeMatches = formulaRangeMatches(
    input.formula,
    input.compositeSheetName,
    input.masterSpreadsheetId,
  );
  if (sourceMatches.length === 1 && compositeMatches.length === 0) {
    return {
      ...substitutePayoutSourceRange(input),
      alreadyRepointed: false,
    };
  }
  if (sourceMatches.length === 0 && compositeMatches.length === 1) {
    return {
      before: input.formula,
      after: input.formula,
      sourceRange: "",
      compositeRange: compositeMatches[0].candidate,
      alreadyRepointed: true,
    };
  }
  throw new Error(
    `Expected one source or composite A:H range; found source=${sourceMatches.length},`
    + ` composite=${compositeMatches.length}.`,
  );
}

/** Sheets/Excel serial for a calendar date, using the conventional 1899-12-30 epoch. */
export function payoutGoogleDateSerial(date: string): number {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) throw new Error(`Invalid payout date ${date}; expected YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = Date.UTC(year, month - 1, day);
  const normalized = new Date(instant).toISOString().slice(0, 10);
  if (normalized !== date) throw new Error(`Invalid payout date ${date}.`);
  return Math.round((instant - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function nextAnchorMonth(anchorMonth: string): string {
  const [year, month] = anchorMonth.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error("Payout run month must be YYYY-MM.");
  }
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 7);
}

export function payoutWorkbookRollWindows(anchorMonth: string): {
  outgoing: PayoutRunWindow;
  incoming: PayoutRunWindow;
  outgoingDateSerials: [number, number];
  incomingDateSerials: [number, number];
} {
  const outgoing = payoutRunWindow(anchorMonth);
  const incoming = payoutRunWindow(nextAnchorMonth(anchorMonth));
  return {
    outgoing,
    incoming,
    outgoingDateSerials: [
      payoutGoogleDateSerial(outgoing.windowStart),
      payoutGoogleDateSerial(outgoing.windowEnd),
    ],
    incomingDateSerials: [
      payoutGoogleDateSerial(incoming.windowStart),
      payoutGoogleDateSerial(incoming.windowEnd),
    ],
  };
}

export interface PayoutWorkbookDateCell {
  effectiveValue: number | string | boolean | null;
  userEnteredValue: number | string | boolean | null;
  formulaValue: string | null;
  numberFormatType: string | null;
  error: string | null;
}

export interface PayoutWorkbookDateState {
  state: "outgoing" | "incoming";
  serials: [number, number];
}

/**
 * Prove that B4:B5 are literal, date-formatted serials in one approved state.
 *
 * Date rolling is deliberately stricter than comparing displayed dates:
 * formulas, mixed outgoing/incoming pairs, error cells, and third values all
 * abort the fleet preflight before the first remote write.
 */
export function inspectPayoutWorkbookDateState(
  cells: readonly (readonly PayoutWorkbookDateCell[])[],
  windows: ReturnType<typeof payoutWorkbookRollWindows>,
): PayoutWorkbookDateState {
  if (cells.length !== 2 || cells.some((row) => row.length !== 1)) {
    throw new Error("B4:B5 must contain exactly two date cells.");
  }
  const inspected = cells.map((row) => row[0]);
  for (const [index, cell] of inspected.entries()) {
    const label = index === 0 ? "B4" : "B5";
    if (cell.error) throw new Error(`${label} has a Sheets error: ${cell.error}.`);
    if (cell.formulaValue) throw new Error(`${label} must be a literal date, not a formula.`);
    if (typeof cell.userEnteredValue !== "number"
      || typeof cell.effectiveValue !== "number") {
      throw new Error(`${label} must be a numeric literal date.`);
    }
    if (cell.userEnteredValue !== cell.effectiveValue) {
      throw new Error(`${label} effective and entered date serials disagree.`);
    }
    if (cell.numberFormatType !== "DATE" && cell.numberFormatType !== "DATE_TIME") {
      throw new Error(`${label} must retain DATE or DATE_TIME formatting.`);
    }
  }
  const serials: [number, number] = [
    inspected[0].effectiveValue as number,
    inspected[1].effectiveValue as number,
  ];
  if (serials[0] === windows.outgoingDateSerials[0]
    && serials[1] === windows.outgoingDateSerials[1]) {
    return { state: "outgoing", serials };
  }
  if (serials[0] === windows.incomingDateSerials[0]
    && serials[1] === windows.incomingDateSerials[1]) {
    return { state: "incoming", serials };
  }
  throw new Error(
    `B4:B5 are neither the outgoing nor incoming payout window (${serials.join(", ")}).`,
  );
}
