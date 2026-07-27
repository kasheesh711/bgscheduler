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
  assertPayoutRunPublishable,
  buildPayoutRunCsv,
  buildPayoutSheetRowValues,
  groupPayoutPlansBySheet,
  orderPayoutWritesBottomUp,
  payoutRowMarker,
  resolvePayoutRowAction,
  type PayoutPublishAcknowledgements,
  type PayoutRunCoverage,
  type PayoutWritePlan,
} from "./payout-plan";
import {
  PAYOUT_DRIVE_FOLDER_ID,
  payoutConnectedEmail,
  payoutCsvFilename,
} from "./payout-config";
import {
  finalizePayoutRunPass,
  loadPayoutRunLines,
  markPayoutLine,
  preparePayoutRunPass,
  type PayoutRun,
  type PayoutRunLine,
  type TutorPayoutSheet,
} from "./payout-repository";
import {
  parsePayoutSheet,
  parsePayoutSheetWindow,
  payoutSheetWindowMatches,
} from "./payout-sheet";
import {
  createGooglePayoutSheetGateway,
  writePayoutSheetPlans,
  type PayoutSheetGateway,
} from "./payout-writer";
import { payoutRunWindow, type PayoutRunWindow } from "./payout-window";

// ── Publishing a payout run ─────────────────────────────────────────────
//
// Three phases, and the shape of them is the point: two short transactions
// with all the network I/O in between, never inside one. A transaction held
// open across a Sheets call would hold the feature-wide finance lock for the
// length of a Google round trip, blocking every reviewer approval in the
// product.

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
  gateway?: PayoutSheetGateway;
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
  const prepared = await preparePayoutRunPass(
    { window, actorEmail: actor.email },
    db,
  );
  return {
    run: prepared.run,
    window,
    coverage: prepared.coverage,
    lines: prepared.lines,
    csvError: null,
    stoppedEarly: false,
  };
}

interface SheetPlanResult {
  plans: PayoutWritePlan[];
}

/**
 * Match each line in one tutor's sheet and turn the matched ones into plans.
 *
 * The grid is read once per tab and every decision for that tab is made
 * against that one read, which is exactly why the writes then go bottom-up.
 */
async function planSheet(input: {
  db: Database;
  gateway: PayoutSheetGateway;
  sheet: TutorPayoutSheet;
  lines: PayoutRunLine[];
  window: PayoutRunWindow;
  anchorMonth: string;
}): Promise<SheetPlanResult> {
  const { db, gateway, sheet, lines } = input;

  let grid: unknown[][];
  try {
    grid = await gateway.readGrid(sheet.spreadsheetId, sheet.sheetName);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The payout sheet could not be read.";
    for (const line of lines) {
      await markPayoutLine(db, line.id, {
        matchStatus: "no_sheet",
        writeStatus: "failed",
        spreadsheetId: sheet.spreadsheetId,
        sheetName: sheet.sheetName,
        writeError: message,
      });
    }
    return { plans: [] };
  }

  const table = parsePayoutSheet(grid);
  if (!table) {
    // A sheet whose shape we do not recognise must never be written to.
    for (const line of lines) {
      await markPayoutLine(db, line.id, {
        matchStatus: "no_sheet",
        writeStatus: "skipped",
        spreadsheetId: sheet.spreadsheetId,
        sheetName: sheet.sheetName,
        writeError: "The sheet has no Date/Time/Student name/Payout amount header row.",
      });
    }
    return { plans: [] };
  }

  const declared = parsePayoutSheetWindow(grid);
  if (!payoutSheetWindowMatches(declared, input.window)) {
    // The mapping has been re-pointed to another month's sheet. Writing here
    // would land this run's deductions in the wrong payout period, with date
    // matching that still looked correct.
    for (const line of lines) {
      await markPayoutLine(db, line.id, {
        matchStatus: "no_sheet",
        writeStatus: "skipped",
        spreadsheetId: sheet.spreadsheetId,
        sheetName: sheet.sheetName,
        writeError: `The mapped sheet covers ${declared.windowStart ?? "?"} to `
          + `${declared.windowEnd ?? "?"}, not ${input.window.windowStart} to ${input.window.windowEnd}.`,
      });
    }
    return { plans: [] };
  }

  const claimedAnchorRows = new Set<number>();
  const plans: PayoutWritePlan[] = [];

  for (const line of lines) {
    const marker = payoutRowMarker({
      anchorMonth: input.anchorMonth,
      deductionId: line.deductionId,
    });
    const action = resolvePayoutRowAction({
      grid,
      table,
      marker,
      scheduledStartAt: line.scheduledStartAt,
      studentNames: line.studentNames,
      claimedAnchorRows,
      // A blank row under the anchor only means "our half-finished insert" if
      // this line has been attempted before. `failed` is the only state that
      // proves that; a fresh line must never consume a sheet's own blank row.
      previouslyAttempted: line.writeStatus === "failed" || line.insertedRowNumber !== null,
    });

    if (action.kind === "already_written") {
      await markPayoutLine(db, line.id, {
        matchStatus: "matched",
        writeStatus: "written",
        spreadsheetId: sheet.spreadsheetId,
        sheetName: sheet.sheetName,
        insertedRowNumber: action.rowNumber,
        writeError: null,
        writtenAt: line.writtenAt ?? new Date(),
      });
      continue;
    }
    if (action.kind === "unmatched") {
      await markPayoutLine(db, line.id, {
        matchStatus: "unmatched",
        writeStatus: "skipped",
        spreadsheetId: sheet.spreadsheetId,
        sheetName: sheet.sheetName,
        writeError: "No class row on this sheet matches the deducted session.",
      });
      continue;
    }
    if (action.kind === "ambiguous") {
      await markPayoutLine(db, line.id, {
        matchStatus: "ambiguous",
        writeStatus: "skipped",
        spreadsheetId: sheet.spreadsheetId,
        sheetName: sheet.sheetName,
        writeError: `${action.candidates.length} class rows match within the tolerance;`
          + " the deduction was not written.",
      });
      continue;
    }

    claimedAnchorRows.add(action.anchorRowNumber);
    await markPayoutLine(db, line.id, {
      matchStatus: "matched",
      writeStatus: "pending",
      spreadsheetId: sheet.spreadsheetId,
      sheetName: sheet.sheetName,
      matchedRowNumber: action.anchorRowNumber,
      writeError: null,
    });
    plans.push({
      lineId: line.id,
      deductionId: line.deductionId,
      spreadsheetId: sheet.spreadsheetId,
      sheetName: sheet.sheetName,
      sheetGid: sheet.sheetGid,
      anchorRowNumber: action.anchorRowNumber,
      targetRowNumber: action.rowNumber,
      reuseBlankRow: action.kind === "reuse_blank",
      values: buildPayoutSheetRowValues({
        anchorRow: grid[action.anchorRowNumber - 1] ?? [],
        studentName: line.studentNames[0] ?? "",
        amountMinor: line.amountMinor,
        reason: line.reason,
        deadlineAt: line.deadlineAt,
        tutorSubmittedAt: line.tutorSubmittedAt,
        marker,
      }),
      marker,
    });
  }

  return { plans };
}

/**
 * Write this run's approved deductions into the tutor payout sheets, then
 * upload the summary CSV.
 *
 * Safe to press again. Lines already written are never re-written: the marker
 * in the sheet is checked before anything else, so even a crash between the
 * Sheets call and the database write is recovered on the next pass.
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
    // Checked before the first write, not discovered halfway through a tutor's
    // sheet: a missing scope is a setup problem, and it should read like one.
    await assertPayoutGoogleAccess(db, connectedEmail);
    gateway = createGooglePayoutSheetGateway(connectedEmail);
  }

  // Phase 2 — no transaction is open for any of this.
  const pendingLines = prepared.lines.filter((line) => line.writeStatus === "pending");
  const bySheet = new Map<string, { sheet: TutorPayoutSheet; lines: PayoutRunLine[] }>();
  for (const line of pendingLines) {
    const sheet = line.canonicalTutorKey ? prepared.sheets.get(line.canonicalTutorKey) : undefined;
    if (!sheet) {
      await markPayoutLine(db, line.id, {
        matchStatus: "no_sheet",
        writeStatus: "skipped",
        writeError: line.canonicalTutorKey
          ? `No payout sheet is mapped for ${line.canonicalTutorKey}.`
          : "The session has no resolved tutor, so no payout sheet can be chosen.",
      });
      continue;
    }
    const key = `${sheet.spreadsheetId}::${sheet.sheetName}`;
    const bucket = bySheet.get(key) ?? { sheet, lines: [] };
    bucket.lines.push(line);
    bySheet.set(key, bucket);
  }

  const plans: PayoutWritePlan[] = [];
  for (const { sheet, lines } of bySheet.values()) {
    const result = await planSheet({
      db,
      gateway,
      sheet,
      lines,
      window,
      anchorMonth: input.anchorMonth,
    });
    plans.push(...result.plans);
  }

  const { stoppedEarly } = await writePayoutSheetPlans({
    gateway,
    plansBySheet: groupPayoutPlansBySheet(orderPayoutWritesBottomUp(plans)),
    deadlineAt: now() + PUBLISH_TIME_BUDGET_MS,
    clock: now,
    onOutcome: async (outcome) => {
      await markPayoutLine(db, outcome.lineId, {
        matchStatus: "matched",
        writeStatus: outcome.status,
        insertedRowNumber: outcome.rowNumber,
        writeError: outcome.error,
        writtenAt: outcome.status === "written" ? new Date() : null,
      });
    },
  });

  // The CSV is built from what was actually persisted, after the writes. Built
  // first, it would assert writes that had not happened.
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
      insertedRowNumber: line.insertedRowNumber,
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
    const result = await upload({
      email: connectedEmail,
      folderId: PAYOUT_DRIVE_FOLDER_ID,
      // A retry after a partial failure would otherwise create a second file
      // with the same name, which Drive permits and nobody can tell apart.
      filename: prepared.run.version > 1
        ? payoutCsvFilename(window.windowStart, window.windowEnd)
          .replace(/\.csv$/u, ` (v${prepared.run.version}).csv`)
        : payoutCsvFilename(window.windowStart, window.windowEnd),
      csv,
    });
    csvFileId = result.fileId;
    csvUrl = result.webViewLink;
  } catch (error) {
    // The sheets are already money. A Drive failure must not make the run look
    // un-executed; it is recorded and retried on its own.
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
