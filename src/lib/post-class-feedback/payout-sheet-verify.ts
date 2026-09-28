import "server-only";

import { selectPayoutRunCandidates } from "./payout-repository";
import { selectRetirementTargets, type RetirementTarget } from "./payout-retirement";
import { deductionEvidenceIssue, loadCurrentDeductionEvidence } from "./deduction-evidence";

import { and, eq, gte, lt } from "drizzle-orm";

import { type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

import { requirePayoutGoogleTarget } from "./payout-config";
import {
  collectMasterMarkers,
  parseMasterPayoutSheet,
  type MasterPayoutRow,
} from "./payout-master";
import { payoutRunRangeUtc, payoutRunWindow } from "./payout-window";
import {
  createGoogleMasterLedgerGateway,
  type MasterLedgerGateway,
  createPayoutMaintenanceRateGate,
} from "./payout-writer";

// ── Read-only ledger verification ───────────────────────────────────────
//
// One Sheets read of the app-owned Feedback Deductions tab, then a pure
// DB-vs-sheet comparison. Never writes anywhere; `POST_CLASS_PAYOUT_WRITES_
// ENABLED` deliberately does not gate it (it gates money rows, not reads).
// This is the same engine behind `scripts/report-payout-sheet-reconciliation`.

export interface PayoutSheetVerifyRow {
  kind: "written-line" | "skipped-line" | "adjustment" | "unwritten-candidate";
  tutorName: string;
  wiseSessionId: string;
  dbStatus: string;
  /**
   * `netted-removed`: the row was deliberately deleted (netted pair /
   * reinstatement); expected-absent, not a problem.
   */
  sheetStatus: "present" | "absent" | "amount-changed" | "netted-removed" | "n/a";
  sheetRowNumber: number | null;
  sheetAmount: number | null;
  expectedAmount: number | null;
  marker: string;
}

export interface PayoutSheetTutorRollup {
  tutorName: string;
  /** Live written rows expected on the sheet. */
  expectedRows: number;
  presentRows: number;
  missingRows: number;
  /** Signed THB sum of the live written obligations (deductions negative). */
  expectedTotal: number;
  /** Signed THB sum of this tutor's app rows actually on the sheet. */
  sheetTotal: number;
  /** Approved and currently proven deductions still awaiting a publish. */
  unwrittenApproved: number;
  excludedDeductions: number;
  retirementRows: number;
}

export interface PayoutSheetVerifyResult {
  anchorMonth: string;
  checkedAt: string;
  sheetRowCount: number;
  summary: {
    present: number;
    ledgerRemoved: number;
    missing: number;
    amountChanged: number;
    unwrittenApproved: number;
  };
  rows: PayoutSheetVerifyRow[];
  attention: PayoutSheetVerifyRow[];
  perTutor: PayoutSheetTutorRollup[];
  unexpectedMarkers: string[];
  retirements: RetirementTarget[];
  exclusions: { deductionId: string; wiseSessionId: string; tutorName: string | null; status: string; reason: string }[];
}

function sheetStatusFor(
  row: MasterPayoutRow | undefined,
  expectedAmount: number | null,
): { status: PayoutSheetVerifyRow["sheetStatus"]; amount: number | null; rowNumber: number | null } {
  if (!row) return { status: "absent", amount: null, rowNumber: null };
  const amount = row.payoutAmount;
  if (expectedAmount !== null && amount !== expectedAmount) {
    return { status: "amount-changed", amount, rowNumber: row.rowNumber };
  }
  return { status: "present", amount, rowNumber: row.rowNumber };
}

export function payoutSheetAttentionRows(rows: PayoutSheetVerifyRow[]): PayoutSheetVerifyRow[] {
  return rows.filter((row) =>
    (row.kind === "written-line"
      && row.sheetStatus !== "present" && row.sheetStatus !== "netted-removed")
    || (row.kind === "adjustment" && row.dbStatus === "superseded" && row.sheetStatus === "present")
    || (row.kind === "adjustment" && row.dbStatus === "written"
      && row.sheetStatus !== "present" && row.sheetStatus !== "netted-removed")
    || (row.kind === "skipped-line" && row.sheetStatus === "present")
    || row.kind === "unwritten-candidate"
    || row.sheetStatus === "amount-changed");
}

export async function verifyPayoutSheet(
  db: Database,
  anchorMonth: string,
  suppliedGateway?: MasterLedgerGateway,
): Promise<PayoutSheetVerifyResult> {
  const gateway = suppliedGateway ?? (() => {
    const target = requirePayoutGoogleTarget({ forWrite: false });
    return createGoogleMasterLedgerGateway({
      email: target.connectedEmail,
      spreadsheetId: target.masterSpreadsheetId,
      sourceSheetName: target.sourceSheetName,
      deductionsSheetName: target.deductionsSheetName,
      // Health-read pacing: never contend with a concurrent publish.
      pace: createPayoutMaintenanceRateGate(),
    });
  })();
  const table = parseMasterPayoutSheet(await gateway.readDeductionGrid());
  if (!table) throw new Error("The deductions tab could not be parsed (no header row).");
  collectMasterMarkers(table); // throws loudly on duplicated markers
  const markerRows = new Map<string, MasterPayoutRow>();
  for (const row of table.rows) {
    if (row.marker) markerRows.set(row.marker, row);
  }

  const [run] = await db.select().from(schema.postClassPayoutRuns)
    .where(eq(schema.postClassPayoutRuns.anchorMonth, `${anchorMonth}-01`)).limit(1);
  const lines = run
    ? await db.select().from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.runId, run.id))
    : [];
  const adjustments = run
    ? await db.select().from(schema.postClassPayoutAdjustments)
      .where(eq(schema.postClassPayoutAdjustments.runId, run.id))
    : [];
  const knownMarkers = new Set([...lines, ...adjustments].map(row => row.rowSignature));
  const unexpectedMarkers = [...markerRows.keys()].filter(marker =>
    (marker.startsWith(`BGS-PAYOUT ${anchorMonth} `) || marker.startsWith(`BGS-PAYOUT-CORRECTION ${anchorMonth} `))
    && !knownMarkers.has(marker));
  const retiredWrittenDeductionIds = new Set(
    lines
      .filter((line) => line.writeStatus === "written" && line.retiredAt !== null)
      .map((line) => line.deductionId),
  );

  const rows: PayoutSheetVerifyRow[] = [];
  for (const line of lines) {
    const expected = line.amountMinor / 100;
    const sheet = sheetStatusFor(markerRows.get(line.rowSignature), expected);
    const netted = line.writeStatus === "written"
      && sheet.status === "absent"
      && line.retiredAt !== null;
    rows.push({
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
    const netted = sheet.status === "absent"
      && (adjustment.status === "superseded"
        || (adjustment.status === "written"
          && retiredWrittenDeductionIds.has(adjustment.deductionId)));
    rows.push({
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

  const window = payoutRunWindow(anchorMonth);
  const { start, endExclusive } = payoutRunRangeUtc(window);
  const liveWrittenDeductionIds = new Set(lines.filter(line => line.writeStatus === "written" && line.retiredAt === null).map(line => line.deductionId));
  const candidates = await selectPayoutRunCandidates(db, window);
  const retirements = await selectRetirementTargets(db, new Date(), anchorMonth);
  const deductions = await db.select({
    deductionId: schema.postClassDeductions.id, sessionId: schema.postClassSessions.id,
    wiseSessionId: schema.postClassSessions.wiseSessionId, tutorName: schema.postClassSessions.canonicalTutorName,
    status: schema.postClassDeductions.status,
  }).from(schema.postClassDeductions).innerJoin(schema.postClassSessions,
    eq(schema.postClassDeductions.sessionId, schema.postClassSessions.id)).where(and(
      gte(schema.postClassSessions.scheduledEndAt, start), lt(schema.postClassSessions.scheduledEndAt, endExclusive),
    ));
  const candidateIds = new Set(candidates.map(c => c.deductionId));
  const excluded = deductions.filter(d => !candidateIds.has(d.deductionId) && !liveWrittenDeductionIds.has(d.deductionId));
  const evidence = await loadCurrentDeductionEvidence(db, excluded.map(d => d.sessionId));
  const exclusions = excluded.map(({ sessionId, ...d }) => ({ ...d,
    reason: d.status !== "approved" ? d.status : deductionEvidenceIssue(evidence.get(sessionId)) ?? "Decision actor or reversal excludes this approval.",
  }));
  for (const candidate of candidates) {
    if (liveWrittenDeductionIds.has(candidate.deductionId)) continue;
    rows.push({
      kind: "unwritten-candidate",
      tutorName: candidate.tutorName ?? "(unnamed)",
      wiseSessionId: candidate.wiseSessionId,
      dbStatus: "approved, no ledger row yet",
      sheetStatus: "n/a",
      sheetRowNumber: null,
      sheetAmount: null,
      expectedAmount: candidate.amountMinor / 100,
      marker: "",
    });
  }

  const attention = payoutSheetAttentionRows(rows);
  const perTutorMap = new Map<string, PayoutSheetTutorRollup>();
  const rollup = (tutorName: string) => {
    const existing = perTutorMap.get(tutorName);
    if (existing) return existing;
    const created: PayoutSheetTutorRollup = {
      tutorName,
      expectedRows: 0,
      presentRows: 0,
      missingRows: 0,
      expectedTotal: 0,
      sheetTotal: 0,
      unwrittenApproved: 0,
      excludedDeductions: 0,
      retirementRows: 0,
    };
    perTutorMap.set(tutorName, created);
    return created;
  };
  for (const row of rows) {
    if (row.kind === "written-line" && row.dbStatus === "written") {
      const tutor = rollup(row.tutorName);
      tutor.expectedRows += 1;
      tutor.expectedTotal += row.expectedAmount ?? 0;
      if (row.sheetStatus === "present" || row.sheetStatus === "amount-changed") {
        tutor.presentRows += 1;
        tutor.sheetTotal += row.sheetAmount ?? 0;
      } else {
        tutor.missingRows += 1;
      }
    } else if (row.kind === "unwritten-candidate") {
      rollup(row.tutorName).unwrittenApproved += 1;
    }
  }

  for (const row of exclusions) rollup(row.tutorName ?? "(unnamed)").excludedDeductions += 1;
  for (const row of retirements) rollup(row.tutorName ?? "(unnamed)").retirementRows += 1;

  return {
    unexpectedMarkers,
    anchorMonth,
    retirements,
    exclusions,
    checkedAt: new Date().toISOString(),
    sheetRowCount: table.rows.length,
    summary: {
      present: rows.filter((row) => row.sheetStatus === "present").length,
      ledgerRemoved: rows.filter((row) =>
        row.kind === "written-line" && row.sheetStatus === "netted-removed").length,
      missing: rows.filter((row) =>
        row.kind === "written-line" && row.sheetStatus === "absent").length,
      amountChanged: rows.filter((row) => row.sheetStatus === "amount-changed").length,
      unwrittenApproved: rows.filter((row) => row.kind === "unwritten-candidate").length,
    },
    rows,
    attention,
    perTutor: [...perTutorMap.values()].toSorted((left, right) =>
      left.tutorName.localeCompare(right.tutorName)),
  };
}
