import "server-only";

import { eq } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  hasDriveFileScope,
  hasSheetsWriteScope,
} from "@/lib/sales-dashboard/google-oauth";

import type { PostClassUser } from "./access";
import { uploadCsvToDrive } from "./drive";
import { PostClassValidationError } from "./errors";
import {
  buildMasterDeductionRow,
  collectMasterMarkers,
  matchMasterRow,
  parseMasterPayoutSheet,
  payoutRowMarker,
  type MasterPayoutTable,
} from "./payout-master";
import {
  assertPayoutRunPublishable,
  buildPayoutRunCsv,
  type PayoutPublishAcknowledgements,
  type PayoutRunCoverage,
} from "./payout-plan";
import {
  PAYOUT_DRIVE_FOLDER_ID,
  PAYOUT_MASTER_SHEET_NAME,
  payoutConnectedEmail,
  payoutCsvFilename,
} from "./payout-config";
import {
  finalizePayoutRunPass,
  loadPayoutRunLines,
  markPayoutLine,
  payoutTutorNameStrings,
  preparePayoutRunPass,
  type PayoutRun,
  type PayoutRunLine,
  type PayoutTutorName,
} from "./payout-repository";
import {
  appendMasterDeductions,
  createGoogleMasterLedgerGateway,
  type MasterAppendPlan,
  type MasterLedgerGateway,
} from "./payout-writer";
import { payoutRunWindow, type PayoutRunWindow } from "./payout-window";

// ── Publishing a payout run ─────────────────────────────────────────────
//
// Three phases, and their shape is the point: two short transactions with all
// the network I/O between them, never inside one. A transaction held open
// across a Sheets call would hold the feature-wide finance lock for the length
// of a Google round trip, blocking every reviewer approval in the product.
//
// Deductions are appended to the shared master ledger. A tutor's own workbook
// is a `QUERY(IMPORTRANGE(...))` view over it and must never be written to.

/** Stop with work outstanding rather than overrun the platform timeout. */
const PUBLISH_TIME_BUDGET_MS = 10 * 60 * 1000;

export interface PayoutRunView {
  run: PayoutRun;
  window: PayoutRunWindow;
  coverage: PayoutRunCoverage;
  lines: PayoutRunLine[];
  csvError: string | null;
  stoppedEarly: boolean;
}

export interface PayoutRunDependencies {
  gateway?: MasterLedgerGateway;
  uploadCsv?: typeof uploadCsvToDrive;
  now?: () => number;
}

async function assertPayoutGoogleAccess(db: Database, email: string): Promise<void> {
  const [token] = await db.select({ scope: schema.googleOAuthTokens.scope })
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, email))
    .limit(1);
  if (!token) {
    throw new PostClassValidationError(
      `${email} has never connected Google. Sign in as that account to grant access.`,
    );
  }
  if (!hasSheetsWriteScope(token.scope)) {
    throw new PostClassValidationError(
      `${email} cannot write Google Sheets. Reconnect Google to grant write access.`,
    );
  }
  if (!hasDriveFileScope(token.scope)) {
    throw new PostClassValidationError(
      `${email} has not granted Drive access, so the summary CSV cannot be uploaded.`
      + " Reconnect Google and try again.",
    );
  }
}

/** Read-only: what a publish would do, without doing any of it. */
export async function previewPayoutRun(
  actor: PostClassUser,
  input: { anchorMonth: string },
  db: Database = getDb(),
): Promise<PayoutRunView> {
  const window = payoutRunWindow(input.anchorMonth);
  const prepared = await preparePayoutRunPass({ window, actorEmail: actor.email }, db);
  return {
    run: prepared.run,
    window,
    coverage: prepared.coverage,
    lines: prepared.lines,
    csvError: null,
    stoppedEarly: false,
  };
}

/**
 * Decide, against one read of the ledger, what each pending line needs.
 *
 * Every decision for the pass is made from a single grid read. Appending
 * cannot invalidate it — new rows land at the end and no existing row number
 * moves — which is exactly why appending replaced inserting.
 */
async function planMasterAppends(input: {
  db: Database;
  table: MasterPayoutTable;
  lines: PayoutRunLine[];
  tutorNames: Map<string, PayoutTutorName>;
  anchorMonth: string;
}): Promise<MasterAppendPlan[]> {
  const { db, table } = input;
  const markers = collectMasterMarkers(table);
  const claimedRows = new Set<number>();
  const plans: MasterAppendPlan[] = [];

  for (const line of input.lines) {
    const marker = payoutRowMarker({
      anchorMonth: input.anchorMonth,
      deductionId: line.deductionId,
    });

    // The ledger, not the database, is the record of what was written. A marker
    // already present means a previous pass appended this row even if it never
    // got to record the fact.
    const existingRow = markers.get(marker);
    if (existingRow !== undefined) {
      await markPayoutLine(db, line.id, {
        matchStatus: "matched",
        writeStatus: "written",
        sheetName: PAYOUT_MASTER_SHEET_NAME,
        masterRowNumber: existingRow,
        markerMissCount: 0,
        lastSeenInMasterAt: new Date(),
        writeError: null,
        writtenAt: line.writtenAt ?? new Date(),
      });
      continue;
    }

    const mapping = line.canonicalTutorKey ? input.tutorNames.get(line.canonicalTutorKey) : undefined;
    if (!mapping) {
      await markPayoutLine(db, line.id, {
        matchStatus: "no_sheet",
        writeStatus: "skipped",
        writeError: line.canonicalTutorKey
          ? `No ledger name is mapped for ${line.canonicalTutorKey}.`
          : "The session has no resolved tutor, so no ledger identity can be chosen.",
      });
      continue;
    }

    const teacherNames = payoutTutorNameStrings(mapping);
    const match = matchMasterRow({
      table,
      teacherNames,
      scheduledStartAt: line.scheduledStartAt,
      studentNames: line.studentNames,
      claimedRows,
    });

    if (match.status === "clock_disagreement") {
      // The ledger keeps a different clock from ours for this class. Writing
      // against a merely-nearest row would put the deduction on the wrong one.
      await markPayoutLine(db, line.id, {
        matchStatus: "ambiguous",
        writeStatus: "skipped",
        sheetName: PAYOUT_MASTER_SHEET_NAME,
        writeError: `The ledger's rows for this class are ${match.offsetHours} hours from ours;`
          + " the clocks disagree, so nothing was written.",
      });
      continue;
    }
    if (match.status === "unmatched" || !match.row) {
      await markPayoutLine(db, line.id, {
        matchStatus: match.status === "ambiguous" ? "ambiguous" : "unmatched",
        writeStatus: "skipped",
        sheetName: PAYOUT_MASTER_SHEET_NAME,
        writeError: match.status === "ambiguous"
          ? `${match.candidates.length} ledger rows match within the tolerance; nothing was written.`
          : "No ledger row matches the deducted session for this tutor.",
      });
      continue;
    }

    claimedRows.add(match.row.rowNumber);
    await markPayoutLine(db, line.id, {
      matchStatus: "matched",
      writeStatus: "pending",
      sheetName: PAYOUT_MASTER_SHEET_NAME,
      matchedRowNumber: match.row.rowNumber,
      writeError: null,
    });
    plans.push({
      lineId: line.id,
      deductionId: line.deductionId,
      marker,
      row: buildMasterDeductionRow({
        anchor: match.row,
        amountMinor: line.amountMinor,
        marker,
      }),
    });
  }

  return plans;
}

/**
 * Append this run's approved deductions to the master ledger, then upload the
 * summary CSV.
 *
 * Safe to press again: a marker already in the ledger means the row landed, so
 * even a crash between the Sheets call and the database write is recovered on
 * the next pass.
 */
export async function publishPayoutRun(
  actor: PostClassUser,
  input: {
    anchorMonth: string;
    expectedVersion: number;
    acknowledgements?: PayoutPublishAcknowledgements;
  },
  db: Database = getDb(),
  dependencies: PayoutRunDependencies = {},
): Promise<PayoutRunView> {
  const window = payoutRunWindow(input.anchorMonth);
  const connectedEmail = payoutConnectedEmail();
  const now = dependencies.now ?? Date.now;

  // Phase 1 — short transaction under the finance lock.
  const prepared = await preparePayoutRunPass(
    { window, actorEmail: actor.email, expectedVersion: input.expectedVersion },
    db,
  );
  assertPayoutRunPublishable(prepared.coverage, input.acknowledgements ?? {});

  let gateway = dependencies.gateway;
  if (!gateway) {
    // Checked before the first write, not discovered halfway through: a missing
    // scope is a setup problem and should read like one.
    await assertPayoutGoogleAccess(db, connectedEmail);
    gateway = createGoogleMasterLedgerGateway(connectedEmail);
  }

  // Phase 2 — no transaction is open for any of this.
  const pendingLines = prepared.lines.filter((line) => line.writeStatus === "pending");
  let stoppedEarly = false;

  if (pendingLines.length > 0) {
    const grid = await gateway.readGrid();
    const table = parseMasterPayoutSheet(grid);
    if (!table) {
      // A ledger whose shape we cannot recognise must never be appended to —
      // that is how a column reorder becomes deductions under wrong headings.
      for (const line of pendingLines) {
        await markPayoutLine(db, line.id, {
          matchStatus: "no_sheet",
          writeStatus: "skipped",
          sheetName: PAYOUT_MASTER_SHEET_NAME,
          writeError: "The master ledger's columns are not where they are expected.",
        });
      }
    } else {
      const plans = await planMasterAppends({
        db,
        table,
        lines: pendingLines,
        tutorNames: prepared.tutorNames,
        anchorMonth: input.anchorMonth,
      });
      const result = await appendMasterDeductions({
        gateway,
        plans,
        deadlineAt: now() + PUBLISH_TIME_BUDGET_MS,
        clock: now,
        onOutcome: async (outcome) => {
          await markPayoutLine(db, outcome.lineId, {
            matchStatus: "matched",
            writeStatus: outcome.status,
            masterRowNumber: outcome.rowNumber,
            writeError: outcome.error,
            writtenAt: outcome.status === "written" ? new Date() : null,
            ...(outcome.status === "written"
              ? { markerMissCount: 0, lastSeenInMasterAt: new Date() }
              : {}),
          });
        },
      });
      stoppedEarly = result.stoppedEarly;
    }
  }

  // The CSV is built after the writes, from what was actually persisted; built
  // first it would assert writes that had not happened.
  const finalLines = await loadPayoutRunLines(db, prepared.run.id);
  const csv = buildPayoutRunCsv(
    { anchorMonth: input.anchorMonth, windowStart: window.windowStart, windowEnd: window.windowEnd },
    finalLines.map((line) => ({
      canonicalTutorKey: line.canonicalTutorKey,
      tutorName: line.tutorName,
      wiseSessionId: line.wiseSessionId,
      className: null,
      studentNames: line.studentNames,
      scheduledStartAt: line.scheduledStartAt,
      scheduledEndAt: null,
      deadlineAt: line.deadlineAt,
      tutorSubmittedAt: line.tutorSubmittedAt,
      amountMinor: line.amountMinor,
      currency: line.currency,
      financeMonth: null,
      reason: line.reason,
      spreadsheetId: line.spreadsheetId,
      sheetName: line.sheetName,
      matchedRowNumber: line.matchedRowNumber,
      insertedRowNumber: line.masterRowNumber,
      matchStatus: line.matchStatus,
      writeStatus: line.writeStatus,
      writeError: line.writeError,
      writtenAt: line.writtenAt,
    })),
  );

  let csvError: string | null = null;
  let csvFileId: string | null = null;
  let csvUrl: string | null = null;
  try {
    const upload = dependencies.uploadCsv ?? uploadCsvToDrive;
    const base = payoutCsvFilename(window.windowStart, window.windowEnd);
    const result = await upload({
      email: connectedEmail,
      folderId: PAYOUT_DRIVE_FOLDER_ID,
      // Drive permits two files with the same name in a folder and nobody can
      // tell them apart afterwards, so a later pass names itself.
      filename: prepared.run.version > 1
        ? base.replace(/\.csv$/u, ` (v${prepared.run.version}).csv`)
        : base,
      csv,
    });
    csvFileId = result.fileId;
    csvUrl = result.webViewLink;
  } catch (error) {
    // The ledger rows are already money. A Drive failure must not make a run
    // that moved money look like one that did not.
    csvError = error instanceof Error ? error.message : "The summary CSV could not be uploaded.";
  }

  // Phase 3 — short transaction, no lock needed: one row, by id.
  const run = await finalizePayoutRunPass(db, {
    runId: prepared.run.id,
    actorEmail: actor.email,
    csvFileId,
    csvUrl,
  });

  return {
    run,
    window,
    coverage: prepared.coverage,
    lines: await loadPayoutRunLines(db, run.id),
    csvError,
    stoppedEarly,
  };
}
