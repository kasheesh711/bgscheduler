import "server-only";

import { and, eq, gte, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  batchUpdateGoogleSpreadsheet,
  fetchGoogleSheetRows,
  listGoogleSheetProperties,
} from "@/lib/sales-dashboard/sheets";

import { autoChargeLowerBoundUtc } from "./auto-approval";
import { lockPostClassFinance } from "./finance-lock";
import {
  requirePayoutGoogleTarget,
  resolveAutoApproveEnabled,
  type PayoutGoogleTarget,
} from "./payout-config";
import {
  collectMasterMarkers,
  parseMasterPayoutSheet,
  type MasterPayoutRow,
} from "./payout-master";
import { createPayoutMaintenanceRateGate } from "./payout-writer";
import { withPostClassTransaction } from "./transaction";

// ── Unattended ledger retirement (auto-un-charge) ───────────────────────
//
// The instant-charge pipeline writes a −฿100 row the moment a violation is
// proven, so evidence that arrives later and clears the violation must be
// able to take the row back OFF the ledger — by deleting the sheet row and
// retiring the line, never by netting a +฿100 correction (the ledger lists
// only classes that should be deducted). Retiring FIRST is what keeps the
// no-netting invariant: a waive that follows sees no live written line, so
// `createPayoutAdjustment` is never reached, and the reopen/ineligible
// sweeps treat the deduction as unwritten and finish the lifecycle on the
// next tick.
//
// Deliberately mirrors scripts/remove-netted-payout-rows.ts: markers locate
// rows (never stored row numbers), deletes run in descending chunks, and a
// readback proves every removed marker gone and every retained marker intact
// before any line is retired.

const DELETE_CHUNK_SIZE = 50;

export interface PayoutRetirementSheetOps {
  listSheetProperties: typeof listGoogleSheetProperties;
  fetchRows: typeof fetchGoogleSheetRows;
  batchUpdate: typeof batchUpdateGoogleSpreadsheet;
}

export interface PayoutRetirementResult {
  /** Live written lines matching a retirement cause this tick. */
  scanned: number;
  retiredLines: number;
  deletedRows: number;
  supersededAdjustments: number;
  skippedTargets: { wiseSessionId: string; reason: string }[];
  /** Set when the whole pass stood down (flag off, lease held, parse failure…). */
  skippedReason: string | null;
}

interface RetirementTarget {
  lineId: string;
  runId: string;
  deductionId: string;
  marker: string;
  amountMinor: number;
  tutorName: string | null;
  wiseSessionId: string;
  cause: "waived" | "ineligible" | "cleared";
  retiredReason: string;
}

function emptyResult(skippedReason: string | null): PayoutRetirementResult {
  return {
    scanned: 0,
    retiredLines: 0,
    deletedRows: 0,
    supersededAdjustments: 0,
    skippedTargets: [],
    skippedReason,
  };
}

/**
 * Select every live written line inside the unattended-charging scope whose
 * deduction should no longer stand: the deduction was waived (or reversed),
 * its session became ineligible, or the latest assessment on a source-ready
 * session no longer finds an objective violation. The `ready` guard on the
 * cleared arm keeps a source-health blip from un-charging anything — only a
 * trustworthy re-decision releases a written row.
 */
async function selectRetirementTargets(
  db: Database,
  now: Date,
): Promise<RetirementTarget[]> {
  const latestAssessmentClear = sql<boolean>`coalesce((
    select a.objective_violation = false
    from post_class_assessments a
    where a.session_id = ${schema.postClassSessions.id}
    order by a.assessed_at desc
    limit 1
  ), false)`;
  const rows = await db.select({
    lineId: schema.postClassPayoutRunLines.id,
    runId: schema.postClassPayoutRunLines.runId,
    deductionId: schema.postClassPayoutRunLines.deductionId,
    marker: schema.postClassPayoutRunLines.rowSignature,
    amountMinor: schema.postClassPayoutRunLines.amountMinor,
    tutorName: schema.postClassPayoutRunLines.tutorName,
    wiseSessionId: schema.postClassPayoutRunLines.wiseSessionId,
    deductionStatus: schema.postClassDeductions.status,
    eligible: schema.postClassSessions.eligible,
    eligibilityReason: schema.postClassSessions.eligibilityReason,
    cleared: latestAssessmentClear,
  }).from(schema.postClassPayoutRunLines)
    .innerJoin(
      schema.postClassDeductions,
      eq(schema.postClassPayoutRunLines.deductionId, schema.postClassDeductions.id),
    )
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(and(
      eq(schema.postClassPayoutRunLines.writeStatus, "written"),
      isNull(schema.postClassPayoutRunLines.retiredAt),
      gte(schema.postClassSessions.scheduledEndAt, autoChargeLowerBoundUtc(now)),
      or(
        inArray(schema.postClassDeductions.status, ["waived", "reversed"]),
        eq(schema.postClassSessions.eligible, false),
        and(
          eq(schema.postClassSessions.sourceStatus, "ready"),
          latestAssessmentClear,
        ),
      ),
    ));
  return rows.map((row) => {
    const cause: RetirementTarget["cause"] =
      row.deductionStatus === "waived" || row.deductionStatus === "reversed"
        ? "waived"
        : row.eligible === false
          ? "ineligible"
          : "cleared";
    const retiredReason = cause === "waived"
      ? "Auto-retired: the deduction was waived after its row was written; the ledger row was deleted instead of netting a correction."
      : cause === "ineligible"
        ? `Auto-retired: the session is no longer eligible (${row.eligibilityReason ?? "ineligible"}); the ledger row was deleted.`
        : "Auto-retired: reassessment cleared the violation; the ledger row was deleted.";
    return {
      lineId: row.lineId,
      runId: row.runId,
      deductionId: row.deductionId,
      marker: row.marker,
      amountMinor: row.amountMinor,
      tutorName: row.tutorName,
      wiseSessionId: row.wiseSessionId,
      cause,
      retiredReason,
    };
  });
}

/**
 * Take rows that should no longer be charged off the master ledger.
 *
 * Wholly gated on `POST_CLASS_AUTO_APPROVE_ENABLED` — with the flag off this
 * is a no-op and written rows are only ever released by an operator (the
 * remove-netted maintenance script / a deliberate correction). Runs stand
 * down for a tick rather than fight a live publish lease, and every partial
 * failure self-heals: a deleted-but-unretired row is re-found as an
 * already-absent marker next tick, and an undeleted row simply stays a
 * target.
 */
export async function runPayoutLedgerRetirement(
  db: Database = getDb(),
  options: {
    now?: Date;
    sheetOps?: PayoutRetirementSheetOps;
    resolveGoogleTarget?: () => PayoutGoogleTarget;
  } = {},
): Promise<PayoutRetirementResult> {
  if (!resolveAutoApproveEnabled()) {
    return emptyResult("auto-charge disabled");
  }
  const now = options.now ?? new Date();
  const targets = await selectRetirementTargets(db, now);
  if (targets.length === 0) return emptyResult(null);

  // Never delete under someone else's live publish lease; the lease is short
  // (15 minutes) and the next tick retries.
  const [liveLease] = await db.select({ id: schema.postClassPayoutRuns.id })
    .from(schema.postClassPayoutRuns)
    .where(and(
      eq(schema.postClassPayoutRuns.status, "publishing"),
      gt(schema.postClassPayoutRuns.leaseExpiresAt, sql`now()`),
    )).limit(1);
  if (liveLease) {
    return { ...emptyResult("publish lease live"), scanned: targets.length };
  }

  let target: PayoutGoogleTarget;
  try {
    // Maintenance operation: deliberately no `forWrite` — the runtime write
    // switch gates money rows, not workbook maintenance (house convention,
    // same as the remove-netted script).
    target = options.resolveGoogleTarget?.() ?? requirePayoutGoogleTarget();
  } catch (error) {
    console.error("[payout-retirement] target unresolved:", error);
    return { ...emptyResult("payout target unresolved"), scanned: targets.length };
  }
  const ops: PayoutRetirementSheetOps = options.sheetOps ?? {
    listSheetProperties: listGoogleSheetProperties,
    fetchRows: fetchGoogleSheetRows,
    batchUpdate: batchUpdateGoogleSpreadsheet,
  };
  const pace = createPayoutMaintenanceRateGate();

  await pace();
  const tabs = await ops.listSheetProperties(target.connectedEmail, target.masterSpreadsheetId);
  const matching = tabs.filter((tab) => tab.title === target.deductionsSheetName);
  if (matching.length !== 1) {
    console.error(
      `[payout-retirement] expected exactly one "${target.deductionsSheetName}" tab, found ${matching.length}`,
    );
    return { ...emptyResult("deductions tab ambiguous"), scanned: targets.length };
  }
  const sheetId = matching[0].sheetId;

  await pace();
  const grid = await ops.fetchRows(
    target.connectedEmail,
    target.masterSpreadsheetId,
    target.deductionsSheetName,
  );
  const table = parseMasterPayoutSheet(grid);
  if (!table) {
    console.error("[payout-retirement] the deductions tab could not be parsed");
    return { ...emptyResult("deductions tab unparseable"), scanned: targets.length };
  }
  let markerRows: Map<string, MasterPayoutRow>;
  try {
    collectMasterMarkers(table); // throws loudly on duplicated markers
    markerRows = new Map<string, MasterPayoutRow>();
    for (const row of table.rows) {
      if (row.marker) markerRows.set(row.marker, row);
    }
  } catch (error) {
    console.error("[payout-retirement]", error);
    return { ...emptyResult("duplicate markers on the tab"), scanned: targets.length };
  }

  // Any correction obligations riding on the target lines: written ones are
  // netted pairs whose +row leaves with the −row; unwritten ones are
  // superseded so the planner never writes a lone +฿100.
  const adjustments = targets.length > 0
    ? await db.select().from(schema.postClassPayoutAdjustments)
      .where(inArray(
        schema.postClassPayoutAdjustments.sourceLineId,
        targets.map((entry) => entry.lineId),
      ))
    : [];
  const adjustmentsByLine = new Map<string, typeof adjustments>();
  for (const adjustment of adjustments) {
    const key = adjustment.sourceLineId ?? "";
    adjustmentsByLine.set(key, [...(adjustmentsByLine.get(key) ?? []), adjustment]);
  }

  const skippedTargets: PayoutRetirementResult["skippedTargets"] = [];
  const deletable: {
    target: RetirementTarget;
    rowNumbers: number[];
    removedMarkers: string[];
    supersedeAdjustmentIds: string[];
    clearRowNumberAdjustmentIds: string[];
  }[] = [];
  for (const entry of targets) {
    const skip = (reason: string) => {
      skippedTargets.push({ wiseSessionId: entry.wiseSessionId, reason });
      console.error(`[payout-retirement] skip ${entry.wiseSessionId}: ${reason}`);
    };
    const lineRow = markerRows.get(entry.marker);
    if (lineRow && lineRow.payoutAmount !== entry.amountMinor / 100) {
      // Someone edited the row; deleting would destroy the evidence. Leave it
      // for Verify sheet to flag as amount-changed.
      skip(`sheet amount ${lineRow.payoutAmount} != expected ${entry.amountMinor / 100}`);
      continue;
    }
    const rowNumbers: number[] = lineRow ? [lineRow.rowNumber] : [];
    const removedMarkers: string[] = lineRow ? [entry.marker] : [];
    const supersedeAdjustmentIds: string[] = [];
    const clearRowNumberAdjustmentIds: string[] = [];
    let blocked = false;
    for (const adjustment of adjustmentsByLine.get(entry.lineId) ?? []) {
      if (adjustment.status === "written") {
        const correctionRow = markerRows.get(adjustment.rowSignature);
        if (!correctionRow) {
          skip("a written correction's sheet row is missing");
          blocked = true;
          break;
        }
        if (correctionRow.payoutAmount !== Math.abs(adjustment.amountMinor) / 100) {
          skip("a written correction's sheet amount changed");
          blocked = true;
          break;
        }
        rowNumbers.push(correctionRow.rowNumber);
        removedMarkers.push(adjustment.rowSignature);
        clearRowNumberAdjustmentIds.push(adjustment.id);
      } else if (adjustment.status !== "superseded") {
        supersedeAdjustmentIds.push(adjustment.id);
      }
    }
    if (blocked) continue;
    deletable.push({
      target: entry,
      rowNumbers,
      removedMarkers,
      supersedeAdjustmentIds,
      clearRowNumberAdjustmentIds,
    });
  }
  if (deletable.length === 0) {
    return { ...emptyResult(null), scanned: targets.length, skippedTargets };
  }

  // Delete descending so earlier requests never shift later indices.
  const rowNumbers = deletable
    .flatMap((entry) => entry.rowNumbers)
    .toSorted((left, right) => right - left);
  for (let start = 0; start < rowNumbers.length; start += DELETE_CHUNK_SIZE) {
    const chunk = rowNumbers.slice(start, start + DELETE_CHUNK_SIZE);
    await pace();
    await ops.batchUpdate(
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
  }

  // Readback: retire only what is provably off the tab.
  await pace();
  const after = parseMasterPayoutSheet(await ops.fetchRows(
    target.connectedEmail,
    target.masterSpreadsheetId,
    target.deductionsSheetName,
  ));
  if (!after) {
    console.error("[payout-retirement] readback failed: the tab no longer parses");
    return { ...emptyResult("readback unparseable"), scanned: targets.length, skippedTargets };
  }
  const remainingMarkers = new Set(
    after.rows.map((row) => row.marker).filter((marker): marker is string => Boolean(marker)),
  );
  const confirmed = deletable.filter((entry) => {
    const stillPresent = entry.removedMarkers.some((marker) => remainingMarkers.has(marker));
    if (stillPresent) {
      skippedTargets.push({
        wiseSessionId: entry.target.wiseSessionId,
        reason: "row still present after deletion; retrying next tick",
      });
    }
    return !stillPresent;
  });
  if (confirmed.length === 0) {
    return { ...emptyResult(null), scanned: targets.length, skippedTargets };
  }

  const retiredAt = new Date();
  const supersededIds = confirmed.flatMap((entry) => entry.supersedeAdjustmentIds);
  const clearRowIds = confirmed.flatMap((entry) => entry.clearRowNumberAdjustmentIds);
  await withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    for (const entry of confirmed) {
      await tx.update(schema.postClassPayoutRunLines).set({
        insertedRowNumber: null,
        matchedRowNumber: null,
        retiredAt,
        retiredReason: entry.target.retiredReason,
        updatedAt: retiredAt,
      }).where(and(
        eq(schema.postClassPayoutRunLines.id, entry.target.lineId),
        isNull(schema.postClassPayoutRunLines.retiredAt),
      ));
    }
    if (supersededIds.length > 0) {
      await tx.update(schema.postClassPayoutAdjustments).set({
        status: "superseded",
        updatedAt: retiredAt,
      }).where(and(
        inArray(schema.postClassPayoutAdjustments.id, supersededIds),
        inArray(schema.postClassPayoutAdjustments.status, ["pending", "failed", "exception"]),
      ));
    }
    if (clearRowIds.length > 0) {
      await tx.update(schema.postClassPayoutAdjustments).set({
        sheetRowNumber: null,
        updatedAt: retiredAt,
      }).where(inArray(schema.postClassPayoutAdjustments.id, clearRowIds));
    }
    // Invalidate stale operator previews of the affected runs.
    const runIds = [...new Set(confirmed.map((entry) => entry.target.runId))];
    await tx.update(schema.postClassPayoutRuns).set({
      version: sql`${schema.postClassPayoutRuns.version} + 1`,
      updatedAt: retiredAt,
    }).where(inArray(schema.postClassPayoutRuns.id, runIds));
  });

  return {
    scanned: targets.length,
    retiredLines: confirmed.length,
    deletedRows: rowNumbers.length,
    supersededAdjustments: supersededIds.length,
    skippedTargets,
    skippedReason: null,
  };
}
