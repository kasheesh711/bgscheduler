/**
 * INC-260829: delete netted −฿100/+฿100 row PAIRS from the Feedback
 * Deductions tab, so the ledger lists only classes that should be deducted.
 *
 * A waived written deduction and its written correction cancel to zero but
 * still occupy two rows each. This removes both members of every such pair
 * from the app-owned tab. Safe by construction:
 *   - written lines are never re-planned (payout-run.ts pendingLines filter),
 *   - every publish re-derives rows from a fresh grid by marker, never by
 *     stored row number,
 *   - the composite QUERY leg is open-ended `A2:H` (interior deletes cannot
 *     produce #REF!), and tutor workbooks reference only the composite,
 *   - only pairs whose adjustment is terminal (`written`) are touched — a
 *     non-terminal adjustment still needs its source row on the tab.
 *
 * DB rows keep their `written` statuses as historical truth; only the
 * now-stale cosmetic row-number labels are nulled. A full pre-deletion
 * snapshot of every removed row lands in `.payout-ops/` first.
 *
 *   npm run payout:remove-netted            dry run
 *   npm run payout:remove-netted -- --commit
 */

import path from "node:path";

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { lockPostClassFinance } from "@/lib/post-class-feedback/finance-lock";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  collectMasterMarkers,
  parseMasterPayoutSheet,
  type MasterPayoutRow,
} from "@/lib/post-class-feedback/payout-master";
import { createPayoutMaintenanceRateGate } from "@/lib/post-class-feedback/payout-writer";
import { withPostClassTransaction } from "@/lib/post-class-feedback/transaction";
import {
  batchUpdateGoogleSpreadsheet,
  fetchGoogleSheetRows,
  listGoogleSheetProperties,
} from "@/lib/sales-dashboard/sheets";

import {
  loadPayoutScriptEnvironment,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

const DELETE_CHUNK_SIZE = 50;

interface NettedPair {
  deductionId: string;
  lineId: string;
  adjustmentId: string;
  tutorName: string | null;
  wiseSessionId: string;
  lineMarker: string;
  correctionMarker: string;
  lineRow: MasterPayoutRow;
  correctionRow: MasterPayoutRow;
}

interface SkippedPair {
  deductionId: string;
  wiseSessionId: string;
  reason: string;
}

function snapshotRow(row: MasterPayoutRow): Record<string, unknown> {
  return {
    rowNumber: row.rowNumber,
    teacherName: row.teacherName,
    sessionName: row.sessionName,
    studentName: row.studentName,
    rawDate: row.rawDate,
    rawTime: row.rawTime,
    rawDuration: row.rawDuration,
    rawCredits: row.rawCredits,
    payoutAmount: row.payoutAmount,
  };
}

async function planPairs(db: Database, markerRows: Map<string, MasterPayoutRow>): Promise<{
  pairs: NettedPair[];
  skipped: SkippedPair[];
}> {
  const rows = await db.select({
    deductionId: schema.postClassDeductions.id,
    deductionStatus: schema.postClassDeductions.status,
    lineId: schema.postClassPayoutRunLines.id,
    lineMarker: schema.postClassPayoutRunLines.rowSignature,
    amountMinor: schema.postClassPayoutRunLines.amountMinor,
    tutorName: schema.postClassPayoutRunLines.tutorName,
    wiseSessionId: schema.postClassPayoutRunLines.wiseSessionId,
    adjustmentId: schema.postClassPayoutAdjustments.id,
    adjustmentStatus: schema.postClassPayoutAdjustments.status,
    adjustmentAmountMinor: schema.postClassPayoutAdjustments.amountMinor,
    correctionMarker: schema.postClassPayoutAdjustments.rowSignature,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassPayoutRunLines,
      eq(schema.postClassPayoutRunLines.deductionId, schema.postClassDeductions.id),
    )
    .innerJoin(
      schema.postClassPayoutAdjustments,
      eq(schema.postClassPayoutAdjustments.deductionId, schema.postClassDeductions.id),
    )
    .where(and(
      inArray(schema.postClassDeductions.status, ["waived", "reversed"]),
      eq(schema.postClassPayoutRunLines.writeStatus, "written"),
      isNull(schema.postClassPayoutRunLines.retiredAt),
    ))
    .orderBy(schema.postClassPayoutRunLines.tutorName);

  const pairs: NettedPair[] = [];
  const skipped: SkippedPair[] = [];
  for (const row of rows) {
    const skip = (reason: string) =>
      skipped.push({ deductionId: row.deductionId, wiseSessionId: row.wiseSessionId, reason });
    if (row.adjustmentStatus !== "written") {
      // A non-terminal correction still needs its source deduction row on the
      // tab to publish; deleting the pair would wedge it permanently.
      skip(`adjustment is ${row.adjustmentStatus}, not written`);
      continue;
    }
    const lineRow = markerRows.get(row.lineMarker);
    const correctionRow = markerRows.get(row.correctionMarker);
    if (!lineRow || !correctionRow) {
      skip(`sheet is missing the ${!lineRow ? "deduction" : "correction"} row`);
      continue;
    }
    if (lineRow.payoutAmount !== row.amountMinor / 100) {
      skip(`deduction row amount ${lineRow.payoutAmount} != expected ${row.amountMinor / 100}`);
      continue;
    }
    if (correctionRow.payoutAmount !== Math.abs(row.adjustmentAmountMinor) / 100) {
      skip(`correction row amount ${correctionRow.payoutAmount} != expected ${Math.abs(row.adjustmentAmountMinor) / 100}`);
      continue;
    }
    if (!correctionRow.sessionName.toLowerCase().includes(row.lineMarker.toLowerCase())) {
      skip("correction row does not reference the deduction marker");
      continue;
    }
    pairs.push({
      deductionId: row.deductionId,
      lineId: row.lineId,
      adjustmentId: row.adjustmentId,
      tutorName: row.tutorName,
      wiseSessionId: row.wiseSessionId,
      lineMarker: row.lineMarker,
      correctionMarker: row.correctionMarker,
      lineRow,
      correctionRow,
    });
  }
  return { pairs, skipped };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run payout:remove-netted [-- --commit]");
    return;
  }
  loadPayoutScriptEnvironment();
  const commit = process.argv.includes("--commit");
  const db = getDb();
  // Maintenance operation: deliberately no `forWrite` — the runtime write
  // switch gates money rows, not workbook maintenance (house convention).
  const target = requirePayoutGoogleTarget();
  const pace = createPayoutMaintenanceRateGate();
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit to apply)\n");

  // Preflight: no live publish lease may hold the tab.
  const [liveLease] = await db.select({ id: schema.postClassPayoutRuns.id })
    .from(schema.postClassPayoutRuns)
    .where(and(
      eq(schema.postClassPayoutRuns.status, "publishing"),
      gt(schema.postClassPayoutRuns.leaseExpiresAt, sql`now()`),
    )).limit(1);
  if (liveLease) throw new Error("A payout publish lease is live; retry after it expires.");

  // Resolve the tab's gid; exactly one tab may carry the configured title.
  await pace();
  const tabs = await listGoogleSheetProperties(target.connectedEmail, target.masterSpreadsheetId);
  const matching = tabs.filter((tab) => tab.title === target.deductionsSheetName);
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one "${target.deductionsSheetName}" tab, found ${matching.length}.`);
  }
  const sheetId = matching[0].sheetId;

  await pace();
  const grid = await fetchGoogleSheetRows(
    target.connectedEmail,
    target.masterSpreadsheetId,
    target.deductionsSheetName,
  );
  const table = parseMasterPayoutSheet(grid);
  if (!table) throw new Error("The deductions tab could not be parsed (no header row).");
  collectMasterMarkers(table); // throws loudly on duplicated markers
  const markerRows = new Map<string, MasterPayoutRow>();
  for (const row of table.rows) {
    if (row.marker) markerRows.set(row.marker, row);
  }

  const { pairs, skipped } = await planPairs(db, markerRows);
  for (const pair of pairs) {
    console.log(
      `  remove  ${pair.tutorName ?? "(unnamed)"}  ${pair.wiseSessionId}`
      + `  rows ${pair.lineRow.rowNumber} (−) + ${pair.correctionRow.rowNumber} (+)`,
    );
  }
  for (const entry of skipped) {
    console.log(`  SKIP    ${entry.wiseSessionId}  ${entry.reason}`);
  }
  const expectedRemaining = table.rows.length - pairs.length * 2;
  console.log(
    `\nPlanned: ${pairs.length} netted pairs (${pairs.length * 2} rows) to delete,`
    + ` ${skipped.length} skipped; ${table.rows.length} rows now → ${expectedRemaining} after.`,
  );
  if (pairs.length === 0 || !commit) return;

  writeJsonArtifactExclusive(
    path.resolve(
      ".payout-ops",
      `inc-260829-remove-netted-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
    ),
    {
      kind: "inc-260829-remove-netted-payout-rows",
      plannedAt: new Date().toISOString(),
      spreadsheetId: target.masterSpreadsheetId,
      sheet: target.deductionsSheetName,
      sheetId,
      skipped,
      pairs: pairs.map((pair) => ({
        deductionId: pair.deductionId,
        lineId: pair.lineId,
        adjustmentId: pair.adjustmentId,
        tutorName: pair.tutorName,
        wiseSessionId: pair.wiseSessionId,
        deductionRow: snapshotRow(pair.lineRow),
        correctionRow: snapshotRow(pair.correctionRow),
      })),
    },
  );

  // Delete descending so earlier requests never shift later indices.
  const rowNumbers = pairs
    .flatMap((pair) => [pair.lineRow.rowNumber, pair.correctionRow.rowNumber])
    .toSorted((left, right) => right - left);
  for (let start = 0; start < rowNumbers.length; start += DELETE_CHUNK_SIZE) {
    const chunk = rowNumbers.slice(start, start + DELETE_CHUNK_SIZE);
    await pace();
    await batchUpdateGoogleSpreadsheet(
      target.connectedEmail,
      target.masterSpreadsheetId,
      chunk.map((rowNumber) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber,
          },
        },
      })),
    );
    console.log(`Deleted rows ${chunk.at(-1)}–${chunk[0]} (${chunk.length}).`);
  }

  // Readback: every removed marker gone, every retained marker still present.
  await pace();
  const after = parseMasterPayoutSheet(await fetchGoogleSheetRows(
    target.connectedEmail,
    target.masterSpreadsheetId,
    target.deductionsSheetName,
  ));
  if (!after) throw new Error("Readback failed: deductions tab no longer parses.");
  const remainingMarkers = new Set(
    after.rows.map((row) => row.marker).filter((marker): marker is string => Boolean(marker)),
  );
  const removedMarkers = pairs.flatMap((pair) => [pair.lineMarker, pair.correctionMarker]);
  const stillPresent = removedMarkers.filter((marker) => remainingMarkers.has(marker));
  const expectedRetained = [...markerRows.keys()].filter(
    (marker) => !removedMarkers.includes(marker),
  );
  const lost = expectedRetained.filter((marker) => !remainingMarkers.has(marker));
  if (stillPresent.length > 0 || lost.length > 0) {
    throw new Error(
      `READBACK MISMATCH: ${stillPresent.length} removed markers still present,`
      + ` ${lost.length} retained markers missing. Inspect the sheet before retrying.`,
    );
  }
  console.log(`Readback OK: ${after.rows.length} rows remain, all retained markers intact.`);

  // Null the now-stale cosmetic row-number labels (display-only columns).
  await withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    await tx.update(schema.postClassPayoutRunLines).set({
      insertedRowNumber: null,
      matchedRowNumber: null,
      updatedAt: new Date(),
    }).where(inArray(schema.postClassPayoutRunLines.id, pairs.map((pair) => pair.lineId)));
    await tx.update(schema.postClassPayoutAdjustments).set({
      sheetRowNumber: null,
      updatedAt: new Date(),
    }).where(inArray(schema.postClassPayoutAdjustments.id, pairs.map((pair) => pair.adjustmentId)));
  });
  console.log("Stale row-number labels cleared.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
