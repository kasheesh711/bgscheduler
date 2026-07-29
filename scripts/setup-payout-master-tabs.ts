/**
 * Create or validate the app-owned payout tabs in the master spreadsheet.
 *
 * Dry-run is the default. `--commit` is the only Google-write switch for this
 * one-time maintenance operation; app payout writes may remain disabled.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/setup-payout-master-tabs.ts
 *   ... --commit
 */

import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  buildPayoutCompositeFormula,
  PAYOUT_TAB_COLUMN_COUNT,
  PAYOUT_TAB_HEADERS,
} from "@/lib/post-class-feedback/payout-workbook-operations";
import { createPayoutMaintenanceRateGate } from "@/lib/post-class-feedback/payout-writer";
import {
  batchUpdateGoogleSpreadsheet,
  fetchGoogleSheetRange,
  inspectGoogleSheetRange,
  listGoogleSheetProperties,
  quoteGoogleSheetName,
  updateGoogleSheetRangeValues,
} from "@/lib/sales-dashboard/sheets";

import { loadPayoutScriptEnvironment } from "./lib/payout-script";

const COMPOSITE_ROW_RESERVE = 1_000;
const GOOGLE_SHEETS_CELL_LIMIT = 10_000_000;
const DATA_ROW_PREFLIGHT_LIMIT = 50_000;
const BLANK_TARGET_CELL_PREFLIGHT_LIMIT = 50_000;

function row(grid: unknown[][]): unknown[] {
  return Array.from({ length: PAYOUT_TAB_COLUMN_COUNT }, (_, index) =>
    grid[0]?.[index] ?? "");
}

function sameRow(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length
    && left.every((value, index) => String(value ?? "") === String(right[index] ?? ""));
}

async function assertExistingTargetIsOtherwiseBlank(input: {
  connectedEmail: string;
  masterSpreadsheetId: string;
  sheetName: string;
  rowCount: number;
  columnCount: number;
  pace: () => Promise<void>;
}): Promise<void> {
  const inspectedColumns = Math.min(
    Math.max(input.columnCount, PAYOUT_TAB_COLUMN_COUNT),
    PAYOUT_TAB_COLUMN_COUNT,
  );
  if (input.rowCount * inspectedColumns > BLANK_TARGET_CELL_PREFLIGHT_LIMIT) {
    throw new Error(
      `"${input.sheetName}" has a blank payout header but its`
      + ` ${input.rowCount}x${input.columnCount} grid is too large to prove empty safely.`,
    );
  }
  await input.pace();
  const grid = await fetchGoogleSheetRange(
    input.connectedEmail,
    input.masterSpreadsheetId,
    `${quoteGoogleSheetName(input.sheetName)}!A1:H${Math.max(input.rowCount, 1)}`,
    { valueRenderOption: "FORMULA" },
  );
  const hasUnexpectedContent = grid.some((cells) =>
    cells.some((cell) => String(cell ?? "").trim()));
  if (hasUnexpectedContent) {
    throw new Error(`"${input.sheetName}" contains data outside its initialization cells.`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run payout:setup-master-tabs -- [--commit]");
    return;
  }
  loadPayoutScriptEnvironment();
  const target = requirePayoutGoogleTarget();
  const commit = process.argv.includes("--commit");
  const pace = createPayoutMaintenanceRateGate();

  await pace();
  const tabs = await listGoogleSheetProperties(
    target.connectedEmail,
    target.masterSpreadsheetId,
  );
  const titleSet = new Set(tabs.map((tab) => tab.title));
  const titlesByLower = new Map(
    tabs.map((tab) => [tab.title.toLocaleLowerCase("en-US"), tab.title]),
  );
  for (const requiredName of [
    target.sourceSheetName,
    target.deductionsSheetName,
    target.compositeSheetName,
  ]) {
    const actual = titlesByLower.get(requiredName.toLocaleLowerCase("en-US"));
    if (actual && actual !== requiredName) {
      throw new Error(`Tab "${actual}" differs in case from required "${requiredName}".`);
    }
  }
  if (!titleSet.has(target.sourceSheetName)) {
    throw new Error(`Read-only source tab "${target.sourceSheetName}" does not exist.`);
  }
  if (target.sourceSheetName === target.deductionsSheetName
    || target.sourceSheetName === target.compositeSheetName
    || target.deductionsSheetName === target.compositeSheetName) {
    throw new Error("Source, deductions, and composite tab names must be distinct.");
  }

  await pace();
  const sourceHeader = row(await fetchGoogleSheetRange(
    target.connectedEmail,
    target.masterSpreadsheetId,
    `${quoteGoogleSheetName(target.sourceSheetName)}!A1:H1`,
  ));
  if (!sameRow(sourceHeader, [...PAYOUT_TAB_HEADERS])) {
    throw new Error("The source tab's A:H headers do not exactly match the payout schema.");
  }

  const expectedFormula = buildPayoutCompositeFormula({
    sourceSheetName: target.sourceSheetName,
    deductionsSheetName: target.deductionsSheetName,
  });
  const missingTabs = [target.deductionsSheetName, target.compositeSheetName]
    .filter((name) => !titleSet.has(name));
  await pace();
  const sourceKeys = await fetchGoogleSheetRange(
    target.connectedEmail,
    target.masterSpreadsheetId,
    `${quoteGoogleSheetName(target.sourceSheetName)}!A2:A${DATA_ROW_PREFLIGHT_LIMIT + 2}`,
  );
  if (sourceKeys.length > DATA_ROW_PREFLIGHT_LIMIT) {
    throw new Error(`Source data exceeds the ${DATA_ROW_PREFLIGHT_LIMIT}-row preflight bound.`);
  }
  let deductionKeys: unknown[][] = [];
  if (titleSet.has(target.deductionsSheetName)) {
    await pace();
    deductionKeys = await fetchGoogleSheetRange(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(target.deductionsSheetName)}!A2:A${DATA_ROW_PREFLIGHT_LIMIT + 2}`,
    );
    if (deductionKeys.length > DATA_ROW_PREFLIGHT_LIMIT) {
      throw new Error(
        `Deduction data exceeds the ${DATA_ROW_PREFLIGHT_LIMIT}-row preflight bound.`,
      );
    }
  }
  const requiredCompositeRows = Math.max(
    1_000,
    1 + sourceKeys.length + deductionKeys.length + COMPOSITE_ROW_RESERVE,
  );
  const currentComposite = tabs.find((tab) => tab.title === target.compositeSheetName);
  const currentCells = tabs.reduce(
    (sum, tab) => sum + tab.rowCount * tab.columnCount,
    0,
  );
  const newDeductionsCells = titleSet.has(target.deductionsSheetName) ? 0 : 1_000 * 8;
  const compositeCurrentCells = currentComposite
    ? currentComposite.rowCount * currentComposite.columnCount
    : 0;
  const compositeTargetColumns = Math.max(8, currentComposite?.columnCount ?? 0);
  const compositeTargetRows = Math.max(
    requiredCompositeRows,
    currentComposite?.rowCount ?? 0,
  );
  const proposedCells = currentCells
    + newDeductionsCells
    - compositeCurrentCells
    + compositeTargetRows * compositeTargetColumns;
  if (proposedCells > GOOGLE_SHEETS_CELL_LIMIT) {
    throw new Error(
      `Composite growth would exceed the Google Sheets ${GOOGLE_SHEETS_CELL_LIMIT}`
      + ` cell limit (${proposedCells}).`,
    );
  }

  let deductionsNeedsHeader = !titleSet.has(target.deductionsSheetName);
  let compositeNeedsHeader = !titleSet.has(target.compositeSheetName);
  let compositeNeedsFormula = !titleSet.has(target.compositeSheetName);

  // Validate every existing target before the first mutation.
  if (titleSet.has(target.deductionsSheetName)) {
    const deductionsProperties = tabs.find(
      (tab) => tab.title === target.deductionsSheetName,
    )!;
    await pace();
    const bounded = await fetchGoogleSheetRange(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(target.deductionsSheetName)}!A1:H20`,
    );
    const header = row(bounded);
    const empty = header.every((cell) => !String(cell ?? "").trim());
    const hasOtherContent = bounded.some((cells, rowIndex) =>
      rowIndex > 0 && cells.some((cell) => String(cell ?? "").trim()));
    if (empty && hasOtherContent) {
      throw new Error(`"${target.deductionsSheetName}" has data beneath a blank header.`);
    }
    if (empty) {
      await assertExistingTargetIsOtherwiseBlank({
        connectedEmail: target.connectedEmail,
        masterSpreadsheetId: target.masterSpreadsheetId,
        sheetName: target.deductionsSheetName,
        rowCount: deductionsProperties.rowCount,
        columnCount: deductionsProperties.columnCount,
        pace,
      });
    }
    if (!empty && !sameRow(header, sourceHeader)) {
      throw new Error(`"${target.deductionsSheetName}" has unexpected A:H headers.`);
    }
    deductionsNeedsHeader = empty;
  }
  if (titleSet.has(target.compositeSheetName)) {
    await pace();
    const bounded = await fetchGoogleSheetRange(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(target.compositeSheetName)}!A1:H20`,
      { valueRenderOption: "FORMULA" },
    );
    const header = row(bounded);
    await pace();
    const formulaGrid = await fetchGoogleSheetRange(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(target.compositeSheetName)}!A2`,
      { valueRenderOption: "FORMULA" },
    );
    const formula = String(formulaGrid[0]?.[0] ?? "").trim();
    const headerEmpty = header.every((cell) => !String(cell ?? "").trim());
    const hasOtherContent = bounded.some((cells, rowIndex) =>
      rowIndex > 1 && cells.some((cell) => String(cell ?? "").trim()));
    if (headerEmpty && (formula || hasOtherContent)) {
      throw new Error(`"${target.compositeSheetName}" has content beneath a blank header.`);
    }
    if (headerEmpty && !formula) {
      await assertExistingTargetIsOtherwiseBlank({
        connectedEmail: target.connectedEmail,
        masterSpreadsheetId: target.masterSpreadsheetId,
        sheetName: target.compositeSheetName,
        rowCount: currentComposite!.rowCount,
        columnCount: currentComposite!.columnCount,
        pace,
      });
    }
    const empty = headerEmpty && !formula;
    if (!empty && (!sameRow(header, sourceHeader) || formula !== expectedFormula)) {
      throw new Error(`"${target.compositeSheetName}" is not the approved composite.`);
    }
    compositeNeedsHeader = headerEmpty;
    compositeNeedsFormula = !formula;
  }
  const compositeNeedsGrowth = Boolean(currentComposite
    && (currentComposite.rowCount < compositeTargetRows
      || currentComposite.columnCount < compositeTargetColumns));
  const needsMutation = missingTabs.length > 0
    || deductionsNeedsHeader
    || compositeNeedsHeader
    || compositeNeedsFormula
    || compositeNeedsGrowth;

  console.log(JSON.stringify({
    mode: commit ? "commit" : "dry-run",
    environmentTarget: target.environmentTarget,
    spreadsheetId: target.masterSpreadsheetId,
    sourceSheetName: target.sourceSheetName,
    deductionsSheetName: target.deductionsSheetName,
    compositeSheetName: target.compositeSheetName,
    sourceHeader,
    sourceDataRows: sourceKeys.length,
    deductionRows: deductionKeys.length,
    requiredCompositeRows,
    proposedWorkbookCells: proposedCells,
    missingTabs,
    needsMutation,
    compositeFormula: expectedFormula,
  }, null, 2));
  if (!commit) {
    console.log("Dry run complete. Re-run with --commit to create/configure the tabs.");
    return;
  }
  if (!needsMutation) {
    console.log("Master payout tabs are already valid; zero writes performed.");
    return;
  }

  if (missingTabs.length > 0) {
    const addRequests = missingTabs.map((title) => ({
      addSheet: {
        properties: {
          title,
          gridProperties: {
            rowCount: title === target.compositeSheetName ? compositeTargetRows : 1_000,
            columnCount: 8,
          },
        },
      },
    }));
    await pace();
    await batchUpdateGoogleSpreadsheet(
      target.connectedEmail,
      target.masterSpreadsheetId,
      addRequests,
    );
  }
  if (currentComposite && compositeNeedsGrowth) {
    await pace();
    await batchUpdateGoogleSpreadsheet(
      target.connectedEmail,
      target.masterSpreadsheetId,
      [{
        updateSheetProperties: {
          properties: {
            sheetId: currentComposite.sheetId,
            gridProperties: {
              rowCount: compositeTargetRows,
              columnCount: compositeTargetColumns,
            },
          },
          fields: "gridProperties(rowCount,columnCount)",
        },
      }],
    );
  }
  const headerWrites = [
    ...(deductionsNeedsHeader ? [target.deductionsSheetName] : []),
    ...(compositeNeedsHeader ? [target.compositeSheetName] : []),
  ];
  for (const sheetName of headerWrites) {
    await pace();
    await updateGoogleSheetRangeValues(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(sheetName)}!A1:H1`,
      [sourceHeader.map((cell) => String(cell))],
      "RAW",
    );
  }
  if (compositeNeedsFormula) {
    await pace();
    await updateGoogleSheetRangeValues(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(target.compositeSheetName)}!A2`,
      [[expectedFormula]],
      "USER_ENTERED",
    );
  }

  // Read every mutation back. A Sheets 200 without the expected cell contents
  // is not a successful workbook migration.
  for (const sheetName of [target.deductionsSheetName, target.compositeSheetName]) {
    await pace();
    const verified = row(await fetchGoogleSheetRange(
      target.connectedEmail,
      target.masterSpreadsheetId,
      `${quoteGoogleSheetName(sheetName)}!A1:H1`,
    ));
    if (!sameRow(verified, sourceHeader)) {
      throw new Error(`Header readback failed for "${sheetName}".`);
    }
  }
  await pace();
  const formulaReadback = await fetchGoogleSheetRange(
    target.connectedEmail,
    target.masterSpreadsheetId,
    `${quoteGoogleSheetName(target.compositeSheetName)}!A2`,
    { valueRenderOption: "FORMULA" },
  );
  if (String(formulaReadback[0]?.[0] ?? "") !== expectedFormula) {
    throw new Error("Composite formula readback failed.");
  }
  await pace();
  const effectiveReadback = await inspectGoogleSheetRange(
    target.connectedEmail,
    target.masterSpreadsheetId,
    `${quoteGoogleSheetName(target.compositeSheetName)}!A2`,
  );
  if (effectiveReadback[0]?.[0]?.error) {
    throw new Error(`Composite spill failed: ${effectiveReadback[0][0].error}`);
  }
  console.log("Master payout tabs verified.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
