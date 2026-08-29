/**
 * INC-260829 reconciliation report: master-sheet reality vs the payout DB.
 *
 * The admin corrected the ledger by hand, so the DB's picture of the 2026-08
 * run no longer matches the sheet. This report is STRICTLY READ-ONLY (one
 * Sheets read, zero writes) and answers, row by row:
 *
 *   - which `written` payout lines still have their −฿100 row on the sheet
 *     (present / removed / amount changed);
 *   - which correction markers exist on the sheet (system- or hand-added);
 *   - whether any formerly `skipped` line's marker somehow landed;
 *   - which human-approved deductions remain unwritten — the only rows a
 *     deliberate future publish of this window would still append.
 *
 * Output: console summary + CSV in `.payout-ops/` for the admin.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/report-payout-sheet-reconciliation.ts
 *   ... [--anchor=2026-08]   target anchor month (default 2026-08)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { and, eq, gte, inArray, isNull, lt, notLike, isNotNull } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  collectMasterMarkers,
  parseMasterPayoutSheet,
  type MasterPayoutRow,
} from "@/lib/post-class-feedback/payout-master";
import { payoutRunRangeUtc, payoutRunWindow } from "@/lib/post-class-feedback/payout-window";
import { createGoogleMasterLedgerGateway } from "@/lib/post-class-feedback/payout-writer";

import { loadPayoutScriptEnvironment } from "./lib/payout-script";

interface ReportRow {
  kind: "written-line" | "skipped-line" | "adjustment" | "unwritten-candidate";
  tutorName: string;
  wiseSessionId: string;
  dbStatus: string;
  /**
   * `netted-removed`: the row was deliberately deleted as one half of a
   * waived −/+ pair (payout:remove-netted). Expected-absent, not a problem.
   */
  sheetStatus: "present" | "absent" | "amount-changed" | "netted-removed" | "n/a";
  sheetRowNumber: number | null;
  sheetAmount: number | null;
  expectedAmount: number | null;
  marker: string;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sheetStatusFor(
  row: MasterPayoutRow | undefined,
  expectedAmount: number | null,
): { status: ReportRow["sheetStatus"]; amount: number | null; rowNumber: number | null } {
  if (!row) return { status: "absent", amount: null, rowNumber: null };
  const amount = row.payoutAmount;
  if (expectedAmount !== null && amount !== null && amount !== expectedAmount) {
    return { status: "amount-changed", amount, rowNumber: row.rowNumber };
  }
  return { status: "present", amount, rowNumber: row.rowNumber };
}

async function buildReport(db: Database, anchor: string): Promise<ReportRow[]> {
  const target = requirePayoutGoogleTarget({ forWrite: false });
  const gateway = createGoogleMasterLedgerGateway({
    email: target.connectedEmail,
    spreadsheetId: target.masterSpreadsheetId,
    sourceSheetName: target.sourceSheetName,
    deductionsSheetName: target.deductionsSheetName,
  });
  const table = parseMasterPayoutSheet(await gateway.readDeductionGrid());
  if (!table) throw new Error("The deductions tab could not be parsed (no header row).");
  const markerRows = new Map<string, MasterPayoutRow>();
  collectMasterMarkers(table); // throws on duplicated markers — surface that loudly
  for (const row of table.rows) {
    if (row.marker) markerRows.set(row.marker, row);
  }

  const [run] = await db.select().from(schema.postClassPayoutRuns)
    .where(eq(schema.postClassPayoutRuns.anchorMonth, `${anchor}-01`)).limit(1);
  if (!run) throw new Error(`No payout run for anchor ${anchor}.`);
  const lines = await db.select().from(schema.postClassPayoutRunLines)
    .where(eq(schema.postClassPayoutRunLines.runId, run.id));
  const adjustments = await db.select().from(schema.postClassPayoutAdjustments)
    .where(eq(schema.postClassPayoutAdjustments.runId, run.id));
  const deductionStatuses = new Map(
    (lines.length > 0
      ? await db.select({
        id: schema.postClassDeductions.id,
        status: schema.postClassDeductions.status,
      }).from(schema.postClassDeductions)
        .where(inArray(schema.postClassDeductions.id, lines.map((line) => line.deductionId)))
      : []
    ).map((row) => [row.id, row.status]),
  );
  const writtenAdjustmentByDeduction = new Map(
    adjustments
      .filter((adjustment) => adjustment.status === "written")
      .map((adjustment) => [adjustment.deductionId, adjustment]),
  );
  const writtenLineMarkerByDeduction = new Map(
    lines
      .filter((line) => line.writeStatus === "written")
      .map((line) => [line.deductionId, line.rowSignature]),
  );
  // A waived/reversed deduction whose written −row AND written +row are BOTH
  // gone was removed as a netted pair — expected-absent, not attention-worthy.
  // One half missing while the other remains is still a problem.
  const isNettedRemoved = (deductionId: string): boolean => {
    const status = deductionStatuses.get(deductionId);
    if (status !== "waived" && status !== "reversed") return false;
    const adjustment = writtenAdjustmentByDeduction.get(deductionId);
    const lineMarker = writtenLineMarkerByDeduction.get(deductionId);
    return Boolean(adjustment) && Boolean(lineMarker)
      && !markerRows.has(adjustment!.rowSignature)
      && !markerRows.has(lineMarker!);
  };

  const report: ReportRow[] = [];
  for (const line of lines) {
    const expected = line.amountMinor / 100;
    const sheet = sheetStatusFor(markerRows.get(line.rowSignature), expected);
    const netted = line.writeStatus === "written"
      && sheet.status === "absent"
      && isNettedRemoved(line.deductionId);
    report.push({
      kind: line.writeStatus === "written" ? "written-line" : "skipped-line",
      tutorName: line.tutorName ?? "(unnamed)",
      wiseSessionId: line.wiseSessionId,
      dbStatus: `${line.writeStatus}${line.retiredAt ? "+retired" : ""}`,
      sheetStatus: netted ? "netted-removed" : sheet.status,
      sheetRowNumber: sheet.rowNumber,
      sheetAmount: sheet.amount,
      expectedAmount: expected,
      marker: line.rowSignature,
    });
  }
  for (const adjustment of adjustments) {
    const expected = Math.abs(adjustment.amountMinor) / 100;
    const sheet = sheetStatusFor(markerRows.get(adjustment.rowSignature), expected);
    const netted = adjustment.status === "written"
      && sheet.status === "absent"
      && isNettedRemoved(adjustment.deductionId);
    report.push({
      kind: "adjustment",
      tutorName: "",
      wiseSessionId: adjustment.deductionId,
      dbStatus: adjustment.status,
      sheetStatus: netted ? "netted-removed" : sheet.status,
      sheetRowNumber: sheet.rowNumber,
      sheetAmount: sheet.amount,
      expectedAmount: expected,
      marker: adjustment.rowSignature,
    });
  }

  // Human-approved, unwritten deductions still in the candidate set — the
  // only rows a deliberate publish of this window would append today.
  const window = payoutRunWindow(anchor);
  const { start, endExclusive } = payoutRunRangeUtc(window);
  const writtenDeductionIds = new Set(
    lines.filter((line) => line.writeStatus === "written").map((line) => line.deductionId),
  );
  const candidates = await db.select({
    deductionId: schema.postClassDeductions.id,
    tutorName: schema.postClassSessions.canonicalTutorName,
    wiseSessionId: schema.postClassSessions.wiseSessionId,
  }).from(schema.postClassDeductions)
    .innerJoin(
      schema.postClassSessions,
      eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id),
    )
    .where(and(
      gte(schema.postClassSessions.scheduledEndAt, start),
      lt(schema.postClassSessions.scheduledEndAt, endExclusive),
      eq(schema.postClassDeductions.status, "approved"),
      isNotNull(schema.postClassDeductions.decisionByEmail),
      notLike(schema.postClassDeductions.decisionByEmail, "system:%"),
      eq(schema.postClassSessions.eligible, true),
      eq(schema.postClassSessions.sourceStatus, "ready"),
      isNull(schema.postClassSessions.wiseDeletedAt),
    ));
  for (const candidate of candidates) {
    if (writtenDeductionIds.has(candidate.deductionId)) continue;
    report.push({
      kind: "unwritten-candidate",
      tutorName: candidate.tutorName ?? "(unnamed)",
      wiseSessionId: candidate.wiseSessionId,
      dbStatus: "approved (human), no written line",
      sheetStatus: "n/a",
      sheetRowNumber: null,
      sheetAmount: null,
      expectedAmount: null,
      marker: "",
    });
  }
  return report;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx --tsconfig scripts/tsconfig.json "
      + "scripts/report-payout-sheet-reconciliation.ts [--anchor=YYYY-MM]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const anchorArg = process.argv.find((arg) => arg.startsWith("--anchor="));
  const anchor = anchorArg?.slice("--anchor=".length) ?? "2026-08";

  const report = await buildReport(getDb(), anchor);

  const counts = new Map<string, number>();
  for (const row of report) {
    const key = `${row.kind} / ${row.sheetStatus} (db: ${row.dbStatus})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`Reconciliation for anchor ${anchor}:\n`);
  for (const [key, count] of [...counts.entries()].toSorted()) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  const attention = report.filter((row) =>
    (row.kind === "written-line"
      && row.sheetStatus !== "present" && row.sheetStatus !== "netted-removed")
    || (row.kind === "adjustment" && row.dbStatus === "superseded" && row.sheetStatus === "present")
    || (row.kind === "adjustment" && row.dbStatus === "written"
      && row.sheetStatus !== "present" && row.sheetStatus !== "netted-removed")
    || (row.kind === "skipped-line" && row.sheetStatus === "present")
    || row.kind === "unwritten-candidate"
    || row.sheetStatus === "amount-changed");
  console.log(`\n${attention.length} row${attention.length === 1 ? "" : "s"} need attention (see CSV).`);

  const csvPath = path.resolve(
    ".payout-ops",
    `inc-260829-sheet-reconciliation-${new Date().toISOString().replace(/[:.]/gu, "-")}.csv`,
  );
  mkdirSync(path.dirname(csvPath), { recursive: true });
  const header = [
    "kind", "tutor", "wise_session_or_deduction", "db_status", "sheet_status",
    "sheet_row", "sheet_amount", "expected_amount", "marker",
  ].join(",");
  writeFileSync(csvPath, `${header}\n${report.map((row) => [
    row.kind, csvCell(row.tutorName), row.wiseSessionId, csvCell(row.dbStatus), row.sheetStatus,
    csvCell(row.sheetRowNumber), csvCell(row.sheetAmount), csvCell(row.expectedAmount), csvCell(row.marker),
  ].join(",")).join("\n")}\n`, { flag: "wx" });
  console.log(`CSV: ${csvPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
