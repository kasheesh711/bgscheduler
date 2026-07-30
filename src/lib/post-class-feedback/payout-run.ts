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
  buildAnchorFingerprintIndex,
  buildPayoutCorrectionRow,
  buildPayoutDeductionRow,
  collectMasterMarkers,
  computeSourceAnchorFingerprint,
  matchMasterRow,
  parseMasterPayoutSheet,
} from "./payout-master";
import {
  buildPayoutRunCsv,
  payoutDeductionSourceIdentity,
  type PayoutPublishAcknowledgements,
  type PayoutRunCoverage,
} from "./payout-plan";
import {
  payoutCsvFilename,
  requirePayoutGoogleTarget,
  type PayoutGoogleTarget,
} from "./payout-config";
import {
  acquirePayoutRunLease,
  claimPayoutCsvRetry,
  closePayoutRun as closePayoutRunRecord,
  finalizePayoutCsvRetry,
  finalizePayoutRunPass,
  loadPayoutAdjustments,
  loadPayoutRunLines,
  markPayoutAdjustment,
  markPayoutLine,
  payoutTutorNameStrings,
  PAYOUT_RUN_LEASE_MS,
  readPayoutRunPreview,
  recordPayoutAnchorMissingException,
  resolvePayoutException as resolvePayoutExceptionRecord,
  type PayoutAdjustment,
  type PayoutException,
  type PayoutPreviewSnapshot,
  type PayoutRun,
  type PayoutRunCandidate,
  type PayoutRunLine,
} from "./payout-repository";
import {
  appendPayoutRows,
  createGoogleMasterLedgerGateway,
  DuplicatePayoutAppendSignatureError,
  type MasterLedgerGateway,
  type PayoutAppendPlan,
} from "./payout-writer";
import {
  payoutBangkokDate,
  payoutRunWindow,
  type PayoutRunWindow,
} from "./payout-window";

const PUBLISH_TIME_BUDGET_MS = 10 * 60 * 1_000;
/**
 * Stop starting irreversible Google writes before the durable lease can be
 * reclaimed. This leaves a quiet interval for an in-flight request to settle,
 * then forces the next publisher to re-read markers before doing any work.
 */
const PUBLISH_LEASE_QUIESCENCE_MS =
  PAYOUT_RUN_LEASE_MS - PUBLISH_TIME_BUDGET_MS;

export function payoutExternalWriteDeadline(input: {
  now: number;
  leaseExpiresAt: Date;
}): number {
  return Math.min(
    input.now + PUBLISH_TIME_BUDGET_MS,
    input.leaseExpiresAt.getTime() - PUBLISH_LEASE_QUIESCENCE_MS,
  );
}

export type PayoutRunLineView = PayoutRunLine & {
  persisted: boolean;
  /** Backward-compatible UI alias; the row now lives in the dedicated tab. */
  masterRowNumber: number | null;
};

export interface PayoutRunView {
  /** A draft projection until first publish; `runPersisted` distinguishes it. */
  run: PayoutRun;
  runPersisted: boolean;
  window: PayoutRunWindow;
  previewToken: string;
  coverage: PayoutRunCoverage;
  lines: PayoutRunLineView[];
  adjustments: PayoutAdjustment[];
  exceptions: PayoutException[];
  policyVersion: number;
  csvError: string | null;
  stoppedEarly: boolean;
}

function draftPayoutRun(window: PayoutRunWindow): PayoutRun {
  const createdAt = new Date(0);
  return {
    id: `preview:${window.anchorMonth}`,
    anchorMonth: `${window.anchorMonth}-01`,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    status: "draft",
    leaseToken: null,
    leaseExpiresAt: null,
    publishingByEmail: null,
    publishStartedAt: null,
    publishedByEmail: null,
    publishedAt: null,
    publishAcknowledgements: null,
    csvFileId: null,
    csvUrl: null,
    csvStatus: "pending",
    csvError: null,
    csvAttemptedAt: null,
    closedByEmail: null,
    closedAt: null,
    closeReason: null,
    dateRollStatus: "not_started",
    dateRollStartedAt: null,
    dateRolledAt: null,
    dateRolledByEmail: null,
    rolledToAnchorMonth: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

export interface PayoutRunDependencies {
  gateway?: MasterLedgerGateway;
  uploadCsv?: typeof uploadCsvToDrive;
  now?: () => number;
  /**
   * Tests may inject a complete scratch target. Production always uses the
   * strict runtime resolver, including the write kill switch.
   */
  resolveGoogleTarget?: (input: { forWrite: boolean }) => PayoutGoogleTarget;
}

function resolveWriteTarget(dependencies: PayoutRunDependencies): PayoutGoogleTarget {
  return dependencies.resolveGoogleTarget?.({ forWrite: true })
    ?? requirePayoutGoogleTarget({ forWrite: true });
}

async function assertPayoutGoogleAccess(
  db: Database,
  email: string,
  input: { sheets: boolean; drive: boolean },
): Promise<void> {
  const [token] = await db.select({ scope: schema.googleOAuthTokens.scope })
    .from(schema.googleOAuthTokens)
    .where(eq(schema.googleOAuthTokens.email, email))
    .limit(1);
  if (!token) {
    throw new PostClassValidationError(
      `${email} has never connected Google. Sign in as that account to grant access.`,
    );
  }
  if (input.sheets && !hasSheetsWriteScope(token.scope)) {
    throw new PostClassValidationError(
      `${email} cannot write Google Sheets. Reconnect Google to grant write access.`,
    );
  }
  if (input.drive && !hasDriveFileScope(token.scope)) {
    throw new PostClassValidationError(
      `${email} has not granted Drive access. Reconnect Google and try again.`,
    );
  }
}

function candidateLineView(
  candidate: PayoutRunCandidate,
  window: PayoutRunWindow,
): PayoutRunLineView {
  const createdAt = new Date(0);
  return {
    id: `preview:${candidate.deductionId}`,
    runId: "preview",
    deductionId: candidate.deductionId,
    sessionId: candidate.sessionId,
    lineKind: "deduction",
    sourceIdentity: payoutDeductionSourceIdentity(candidate.deductionId),
    rowSignature: `BGS-PAYOUT ${window.anchorMonth} ${
      candidate.deductionId.replace(/-/gu, "").slice(0, 12)
    }`,
    canonicalTutorKey: candidate.canonicalTutorKey,
    tutorName: candidate.tutorName,
    wiseSessionId: candidate.wiseSessionId,
    className: candidate.className,
    studentNames: candidate.studentNames,
    scheduledStartAt: candidate.scheduledStartAt,
    scheduledEndAt: candidate.scheduledEndAt,
    deadlineAt: candidate.deadlineAt,
    tutorSubmittedAt: candidate.tutorSubmittedAt,
    amountMinor: candidate.amountMinor,
    currency: candidate.currency,
    financeMonth: candidate.defaultFinanceMonth,
    reason: candidate.reason,
    matchStatus: "pending",
    spreadsheetId: null,
    sheetName: null,
    matchedRowNumber: null,
    insertedRowNumber: null,
    sourceAnchorFingerprint: null,
    writeStatus: "pending",
    passToken: null,
    writeError: null,
    writtenAt: null,
    retiredAt: null,
    retiredReason: null,
    idempotencyKey: `preview:${candidate.deductionId}`,
    createdAt,
    updatedAt: createdAt,
    persisted: false,
    masterRowNumber: null,
  };
}

function viewFromSnapshot(
  snapshot: PayoutPreviewSnapshot,
  window: PayoutRunWindow,
  options: { csvError?: string | null; stoppedEarly?: boolean } = {},
): PayoutRunView {
  const persistedIds = new Set(snapshot.lines.map((line) => line.deductionId));
  const lines: PayoutRunLineView[] = [
    ...snapshot.lines.map((line) => ({
      ...line,
      persisted: true,
      masterRowNumber: line.insertedRowNumber,
    })),
    ...snapshot.selectedCandidates
      .filter((candidate) => !persistedIds.has(candidate.deductionId))
      .map((candidate) => candidateLineView(candidate, window)),
  ];
  return {
    run: snapshot.run ?? draftPayoutRun(window),
    runPersisted: Boolean(snapshot.run),
    window,
    previewToken: snapshot.previewToken,
    coverage: snapshot.coverage,
    lines,
    adjustments: snapshot.adjustments,
    exceptions: snapshot.exceptions,
    policyVersion: snapshot.policyVersion,
    csvError: options.csvError ?? snapshot.run?.csvError ?? null,
    stoppedEarly: options.stoppedEarly ?? false,
  };
}

/** Read-only deterministic preview. It does not create a run or line. */
export async function previewPayoutRun(
  _actor: PostClassUser,
  input: { anchorMonth: string; tutorFilter?: string | null },
  db: Database = getDb(),
): Promise<PayoutRunView> {
  const window = payoutRunWindow(input.anchorMonth);
  const snapshot = await readPayoutRunPreview(db, {
    window,
    tutorFilter: input.tutorFilter,
  });
  return viewFromSnapshot(snapshot, window);
}

async function failDeductionLine(
  db: Database,
  input: {
    runId: string;
    leaseToken: string;
    line: PayoutRunLine;
    matchStatus: "unmatched" | "ambiguous" | "no_sheet";
    kind: string;
    reason: string;
    spreadsheetId?: string;
    sheetName?: string;
  },
): Promise<void> {
  await markPayoutLine(db, {
    runId: input.runId,
    lineId: input.line.id,
    leaseToken: input.leaseToken,
    patch: {
      matchStatus: input.matchStatus,
      writeStatus: "skipped",
      spreadsheetId: input.spreadsheetId,
      sheetName: input.sheetName,
      writeError: input.reason,
    },
  });
}

async function planDedicatedAppends(input: {
  db: Database;
  runId: string;
  leaseToken: string;
  rawGrid: unknown[][];
  deductionGrid: unknown[][];
  /** Retryable deduction obligations for this pass. */
  lines: PayoutRunLine[];
  /** Includes already-written source lines needed to build corrections. */
  sourceLines: PayoutRunLine[];
  adjustments: PayoutAdjustment[];
  tutorNames: PayoutPreviewSnapshot["tutorNames"];
  target: PayoutGoogleTarget;
}): Promise<PayoutAppendPlan[]> {
  const raw = parseMasterPayoutSheet(input.rawGrid);
  const dedicated = parseMasterPayoutSheet(input.deductionGrid);
  const plans: PayoutAppendPlan[] = [];
  if (!dedicated) {
    const reason = "The Feedback Deductions tab does not have the required A:H headers.";
    for (const line of input.lines) {
      await failDeductionLine(input.db, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        line,
        matchStatus: "no_sheet",
        kind: "deductions_tab_schema",
        reason,
        spreadsheetId: input.target.masterSpreadsheetId,
        sheetName: input.target.deductionsSheetName,
      });
    }
    for (const adjustment of input.adjustments) {
      await markPayoutAdjustment(input.db, {
        runId: input.runId,
        adjustmentId: adjustment.id,
        leaseToken: input.leaseToken,
        status: "failed",
        writeError: reason,
      });
    }
    return plans;
  }

  const signatures = collectMasterMarkers(dedicated);
  const claimedRawRows = new Set<number>();
  // canonicalTutorKey -> the reason this pass quarantines that tutor's
  // pending lines. A drifted anchor now narrows the blast radius to its own
  // tutor instead of failing every pending line in the run.
  const quarantinedTutors = new Map<string, string>();
  const fingerprintIndex = raw ? buildAnchorFingerprintIndex(raw) : null;

  const quarantineTutor = async (sourceLine: PayoutRunLine, reason: string): Promise<void> => {
    if (!sourceLine.canonicalTutorKey || quarantinedTutors.has(sourceLine.canonicalTutorKey)) return;
    quarantinedTutors.set(sourceLine.canonicalTutorKey, reason);
    await recordPayoutAnchorMissingException(input.db, {
      runId: input.runId,
      deductionId: sourceLine.deductionId,
      canonicalTutorKey: sourceLine.canonicalTutorKey,
      reason,
    });
  };

  for (const sourceLine of input.sourceLines.filter(
    (line) => line.writeStatus === "written",
  )) {
    if (sourceLine.sourceAnchorFingerprint) {
      // Durable fingerprint recorded when this line was written: an O(1)
      // lookup replaces the old re-match search entirely.
      const anchor = fingerprintIndex?.get(sourceLine.sourceAnchorFingerprint);
      if (anchor) {
        claimedRawRows.add(anchor.rowNumber);
      } else {
        await quarantineTutor(
          sourceLine,
          `Written payout line ${sourceLine.rowSignature} anchor is no longer present in the source tab.`,
        );
      }
      continue;
    }
    // Pre-migration row: no durable fingerprint was recorded when it was
    // written, so fall back to today's tolerance-based re-match. On failure,
    // quarantine only this line's tutor instead of aborting the whole pass.
    if (!raw) continue;
    const mapping = sourceLine.canonicalTutorKey
      ? input.tutorNames.get(sourceLine.canonicalTutorKey)
      : undefined;
    if (!mapping) {
      await quarantineTutor(
        sourceLine,
        `Written payout line ${sourceLine.rowSignature} no longer has an exact tutor mapping.`,
      );
      continue;
    }
    const historicalMatch = matchMasterRow({
      table: raw,
      teacherNames: payoutTutorNameStrings(mapping),
      scheduledStartAt: sourceLine.scheduledStartAt,
      studentNames: sourceLine.studentNames,
      claimedRows: claimedRawRows,
    });
    if (historicalMatch.status !== "matched" || !historicalMatch.row) {
      await quarantineTutor(
        sourceLine,
        `Written payout line ${sourceLine.rowSignature} cannot be uniquely`
        + " reconciled to the current read-only source.",
      );
      continue;
    }
    claimedRawRows.add(historicalMatch.row.rowNumber);
  }
  for (const line of input.lines) {
    const existingRow = signatures.get(line.rowSignature);
    if (existingRow !== undefined) {
      await markPayoutLine(input.db, {
        runId: input.runId,
        lineId: line.id,
        leaseToken: input.leaseToken,
        patch: {
          matchStatus: "matched",
          writeStatus: "written",
          spreadsheetId: input.target.masterSpreadsheetId,
          sheetName: input.target.deductionsSheetName,
          insertedRowNumber: existingRow,
          writeError: null,
          writtenAt: line.writtenAt ?? new Date(),
        },
      });
      continue;
    }
    const mapping = line.canonicalTutorKey
      ? input.tutorNames.get(line.canonicalTutorKey)
      : undefined;
    if (!mapping) {
      await failDeductionLine(input.db, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        line,
        matchStatus: "no_sheet",
        kind: "unmapped_tutor",
        reason: line.canonicalTutorKey
          ? `No ledger name is mapped for ${line.canonicalTutorKey}.`
          : "The session has no resolved tutor ledger identity.",
      });
      continue;
    }
    if (!raw) {
      await failDeductionLine(input.db, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        line,
        matchStatus: "no_sheet",
        kind: "source_tab_schema",
        reason: "The read-only payout source tab does not have the required A:H headers.",
        spreadsheetId: input.target.masterSpreadsheetId,
        sheetName: input.target.sourceSheetName,
      });
      continue;
    }
    if (line.canonicalTutorKey && quarantinedTutors.has(line.canonicalTutorKey)) {
      await failDeductionLine(input.db, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        line,
        matchStatus: "ambiguous",
        kind: "source_anchor_missing",
        reason: quarantinedTutors.get(line.canonicalTutorKey)!,
        spreadsheetId: input.target.masterSpreadsheetId,
        sheetName: input.target.sourceSheetName,
      });
      continue;
    }
    const match = matchMasterRow({
      table: raw,
      teacherNames: payoutTutorNameStrings(mapping),
      scheduledStartAt: line.scheduledStartAt,
      studentNames: line.studentNames,
      claimedRows: claimedRawRows,
    });
    if (match.status !== "matched" || !match.row) {
      const clock = match.status === "clock_disagreement";
      const reason = clock
        ? `The source rows for this class are ${match.offsetHours} hours from the scheduled time.`
        : match.status === "ambiguous"
          ? `${match.candidates.length} source rows match; no row was appended.`
          : "No source payout row matches this deducted session and tutor.";
      await failDeductionLine(input.db, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        line,
        matchStatus: clock || match.status === "ambiguous" ? "ambiguous" : "unmatched",
        kind: clock ? "source_clock_disagreement" : `source_${match.status}`,
        reason,
        spreadsheetId: input.target.masterSpreadsheetId,
        sheetName: input.target.sourceSheetName,
      });
      continue;
    }
    claimedRawRows.add(match.row.rowNumber);
    await markPayoutLine(input.db, {
      runId: input.runId,
      lineId: line.id,
      leaseToken: input.leaseToken,
      patch: {
        matchStatus: "matched",
        writeStatus: "pending",
        spreadsheetId: input.target.masterSpreadsheetId,
        sheetName: input.target.deductionsSheetName,
        matchedRowNumber: match.row.rowNumber,
        sourceAnchorFingerprint: computeSourceAnchorFingerprint(match.row),
        writeError: null,
      },
    });
    plans.push({
      lineId: line.id,
      sourceType: "deduction",
      sourceId: line.deductionId,
      marker: line.rowSignature,
      row: buildPayoutDeductionRow({
        anchor: match.row,
        amountMinor: line.amountMinor,
        marker: line.rowSignature,
      }),
    });
  }

  const sourceLines = new Map(input.sourceLines.map((line) => [line.id, line]));
  for (const adjustment of input.adjustments) {
    const existingRow = signatures.get(adjustment.rowSignature);
    if (existingRow !== undefined) {
      await markPayoutAdjustment(input.db, {
        runId: input.runId,
        adjustmentId: adjustment.id,
        leaseToken: input.leaseToken,
        status: "written",
        sheetRowNumber: existingRow,
        writeError: null,
        writtenAt: adjustment.writtenAt ?? new Date(),
      });
      continue;
    }
    const sourceLine = adjustment.sourceLineId
      ? sourceLines.get(adjustment.sourceLineId)
      : undefined;
    const sourceRow = sourceLine
      ? dedicated.rows.find((row) => row.marker === sourceLine.rowSignature)
      : undefined;
    if (!sourceLine || !sourceRow) {
      const reason = "The landed deduction row required by this correction was not found.";
      await markPayoutAdjustment(input.db, {
        runId: input.runId,
        adjustmentId: adjustment.id,
        leaseToken: input.leaseToken,
        status: "failed",
        writeError: reason,
      });
      continue;
    }
    plans.push({
      lineId: adjustment.id,
      sourceType: "adjustment",
      sourceId: adjustment.id,
      marker: adjustment.rowSignature,
      row: buildPayoutCorrectionRow({
        source: sourceRow,
        amountMinor: adjustment.amountMinor,
        marker: adjustment.rowSignature,
        sourceMarker: sourceLine.rowSignature,
      }),
    });
  }
  return plans;
}

function payoutCsv(
  window: PayoutRunWindow,
  lines: PayoutRunLine[],
  adjustments: PayoutAdjustment[],
): string {
  const sourceLines = new Map(lines.map((line) => [line.id, line]));
  return buildPayoutRunCsv(
    {
      anchorMonth: window.anchorMonth,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
    },
    [
      ...lines.map((line) => ({
        lineKind: "deduction" as const,
        sourceIdentity: line.sourceIdentity,
        rowSignature: line.rowSignature,
        canonicalTutorKey: line.canonicalTutorKey,
        tutorName: line.tutorName,
        wiseSessionId: line.wiseSessionId,
        className: line.className,
        studentNames: line.studentNames,
        scheduledStartAt: line.scheduledStartAt,
        scheduledEndAt: line.scheduledEndAt,
        deadlineAt: line.deadlineAt,
        tutorSubmittedAt: line.tutorSubmittedAt,
        amountMinor: line.amountMinor,
        currency: line.currency,
        financeMonth: line.financeMonth,
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
      ...adjustments.map((adjustment) => {
        const source = adjustment.sourceLineId
          ? sourceLines.get(adjustment.sourceLineId)
          : undefined;
        return {
          lineKind: "correction" as const,
          sourceIdentity: adjustment.sourceIdentity,
          rowSignature: adjustment.rowSignature,
          canonicalTutorKey: source?.canonicalTutorKey ?? null,
          tutorName: source?.tutorName ?? null,
          wiseSessionId: source?.wiseSessionId ?? null,
          className: source?.className ?? null,
          studentNames: source?.studentNames ?? [],
          scheduledStartAt: source?.scheduledStartAt ?? null,
          scheduledEndAt: source?.scheduledEndAt ?? null,
          deadlineAt: source?.deadlineAt ?? null,
          tutorSubmittedAt: source?.tutorSubmittedAt ?? null,
          amountMinor: adjustment.amountMinor,
          currency: adjustment.currency,
          financeMonth: source?.financeMonth ?? null,
          reason: adjustment.reason,
          spreadsheetId: source?.spreadsheetId ?? null,
          sheetName: source?.sheetName ?? null,
          matchedRowNumber: source?.matchedRowNumber ?? null,
          insertedRowNumber: adjustment.sheetRowNumber,
          matchStatus: source?.matchStatus ?? "no_sheet",
          writeStatus: adjustment.status === "written" ? "written" : "failed",
          writeError: adjustment.writeError,
          writtenAt: adjustment.writtenAt,
        };
      }),
    ],
  );
}

async function uploadPayoutCsv(input: {
  target: PayoutGoogleTarget;
  window: PayoutRunWindow;
  runVersion: number;
  csv: string;
  upload: typeof uploadCsvToDrive;
}): Promise<{ fileId: string; webViewLink: string | null }> {
  const base = payoutCsvFilename(input.window.windowStart, input.window.windowEnd);
  const result = await input.upload({
    email: input.target.connectedEmail,
    folderId: input.target.driveFolderId,
    filename: input.runVersion > 2
      ? base.replace(/\.csv$/u, ` (v${input.runVersion}).csv`)
      : base,
    csv: input.csv,
  });
  return { fileId: result.fileId, webViewLink: result.webViewLink };
}

/**
 * Publish signed rows into the app-owned tab under a durable lease.
 *
 * A missing preview token never falls back to "current": callers must refresh
 * and explicitly publish exactly what they saw.
 */
export async function publishPayoutRun(
  actor: PostClassUser,
  input: {
    anchorMonth: string;
    previewToken: string;
    tutorFilter?: string | null;
    acknowledgements: PayoutPublishAcknowledgements;
    expectedVersion: number;
  },
  db: Database = getDb(),
  dependencies: PayoutRunDependencies = {},
): Promise<PayoutRunView> {
  if (!input.previewToken) {
    throw new PostClassValidationError("Preview this payout run before publishing it.");
  }
  if (
    input.acknowledgements.confirmed !== true
    || input.acknowledgements.pendingReviewDeductions === undefined
    || input.acknowledgements.nonReadySessions === undefined
    || (input.acknowledgements.reason?.trim().length ?? 0) < 10
  ) {
    throw new PostClassValidationError(
      "Publish requires the exact preview counts and an explicit reason of at least 10 characters.",
    );
  }
  const window = payoutRunWindow(input.anchorMonth);
  const operationNow = new Date(dependencies.now?.() ?? Date.now());
  if (payoutBangkokDate(operationNow) <= window.windowEnd) {
    throw new PostClassValidationError(
      `Payout window ${window.windowStart}–${window.windowEnd} has not ended in Bangkok.`,
    );
  }
  // Fail closed before the run is created or leased, even when tests/clients
  // inject a gateway and no Google call would otherwise resolve configuration.
  const target = resolveWriteTarget(dependencies);
  const acquired = await acquirePayoutRunLease({
    window,
    actorEmail: actor.email,
    previewToken: input.previewToken,
    expectedVersion: input.expectedVersion,
    tutorFilter: input.tutorFilter,
    acknowledgements: input.acknowledgements,
    now: operationNow,
  }, db);

  const selectedIds = new Set(
    acquired.selectedCandidates.map((candidate) => candidate.deductionId),
  );
  const pendingLines = acquired.lines.filter((line) =>
    selectedIds.has(line.deductionId)
    && line.retiredAt === null
    && line.writeStatus !== "written");
  const sourceLineById = new Map(acquired.lines.map((line) => [line.id, line]));
  const sourceLineByDeduction = new Map(
    acquired.lines.map((line) => [line.deductionId, line]),
  );
  const pendingAdjustments = acquired.adjustments.filter((adjustment) =>
    adjustment.status !== "written"
    && (!input.tutorFilter || (
      (adjustment.sourceLineId
        ? sourceLineById.get(adjustment.sourceLineId)
        : sourceLineByDeduction.get(adjustment.deductionId)
      )?.canonicalTutorKey === input.tutorFilter
    )));
  let stoppedEarly = false;

  if (pendingLines.length > 0 || pendingAdjustments.length > 0) {
    if (!dependencies.gateway) {
      await assertPayoutGoogleAccess(db, target.connectedEmail, {
        sheets: true,
        drive: !dependencies.uploadCsv,
      });
    }
    const gateway = dependencies.gateway ?? createGoogleMasterLedgerGateway({
      email: target.connectedEmail,
      spreadsheetId: target.masterSpreadsheetId,
      sourceSheetName: target.sourceSheetName,
      deductionsSheetName: target.deductionsSheetName,
    });
    let plans: PayoutAppendPlan[] = [];
    try {
      const [rawGrid, deductionGrid] = await Promise.all([
        gateway.readRawGrid(),
        gateway.readDeductionGrid(),
      ]);
      plans = await planDedicatedAppends({
        db,
        runId: acquired.run.id,
        leaseToken: acquired.leaseToken,
        rawGrid,
        deductionGrid,
        lines: pendingLines,
        sourceLines: acquired.lines,
        adjustments: pendingAdjustments,
        tutorNames: acquired.tutorNames,
        target,
      });
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : "The payout tabs could not be read.";
      for (const line of pendingLines) {
        await failDeductionLine(db, {
          runId: acquired.run.id,
          leaseToken: acquired.leaseToken,
          line,
          matchStatus: "no_sheet",
          kind: "payout_tab_read_failed",
          reason,
        });
      }
      for (const adjustment of pendingAdjustments) {
        await markPayoutAdjustment(db, {
          runId: acquired.run.id,
          adjustmentId: adjustment.id,
          leaseToken: acquired.leaseToken,
          status: "failed",
          writeError: reason,
        });
      }
    }
    if (plans.length > 0) {
      try {
        if (!acquired.run.leaseExpiresAt) {
          throw new PostClassValidationError(
            "The payout publish lease has no expiry and cannot write safely.",
          );
        }
        const result = await appendPayoutRows({
          gateway,
          plans,
          deadlineAt: payoutExternalWriteDeadline({
            now: dependencies.now?.() ?? Date.now(),
            leaseExpiresAt: acquired.run.leaseExpiresAt,
          }),
          clock: dependencies.now,
          onOutcome: async (outcome) => {
            if (outcome.sourceType === "deduction") {
              await markPayoutLine(db, {
                runId: acquired.run.id,
                lineId: outcome.lineId,
                leaseToken: acquired.leaseToken,
                patch: {
                  matchStatus: "matched",
                  writeStatus: outcome.status,
                  insertedRowNumber: outcome.rowNumber,
                  writeError: outcome.error,
                  writtenAt: outcome.status === "written" ? new Date() : null,
                },
              });
            } else {
              await markPayoutAdjustment(db, {
                runId: acquired.run.id,
                adjustmentId: outcome.sourceId,
                leaseToken: acquired.leaseToken,
                status: outcome.status === "written" ? "written" : "failed",
                sheetRowNumber: outcome.rowNumber,
                writeError: outcome.error,
                writtenAt: outcome.status === "written" ? new Date() : null,
              });
            }
          },
        });
        stoppedEarly = result.stoppedEarly;
      } catch (error) {
        if (!(error instanceof DuplicatePayoutAppendSignatureError)) throw error;
        const reason = error.message;
        for (const plan of plans) {
          if (plan.sourceType === "deduction") {
            const line = pendingLines.find((candidate) => candidate.id === plan.lineId);
            if (line) {
              await failDeductionLine(db, {
                runId: acquired.run.id,
                leaseToken: acquired.leaseToken,
                line,
                matchStatus: "ambiguous",
                kind: "duplicate_row_signature",
                reason,
              });
            }
          } else {
            const adjustment = pendingAdjustments.find(
              (candidate) => candidate.id === plan.sourceId,
            );
            if (adjustment) {
              await markPayoutAdjustment(db, {
                runId: acquired.run.id,
                adjustmentId: adjustment.id,
                leaseToken: acquired.leaseToken,
                status: "failed",
                writeError: reason,
              });
            }
          }
        }
      }
    }
  } else if (!dependencies.uploadCsv) {
    // Zero-obligation runs intentionally skip Sheets scope and all tab reads.
    await assertPayoutGoogleAccess(db, target.connectedEmail, {
      sheets: false,
      drive: true,
    });
  }

  const finalLines = await loadPayoutRunLines(db, acquired.run.id);
  const finalAdjustments = await loadPayoutAdjustments(db, acquired.run.id, finalLines);
  const csv = payoutCsv(window, finalLines, finalAdjustments);
  let csvFileId: string | null = null;
  let csvUrl: string | null = null;
  let csvError: string | null = null;
  try {
    if (!dependencies.uploadCsv && (pendingLines.length > 0 || pendingAdjustments.length > 0)
      && dependencies.gateway) {
      await assertPayoutGoogleAccess(db, target.connectedEmail, {
        sheets: false,
        drive: true,
      });
    }
    const uploaded = await uploadPayoutCsv({
      target,
      window,
      runVersion: acquired.run.version,
      csv,
      upload: dependencies.uploadCsv ?? uploadCsvToDrive,
    });
    csvFileId = uploaded.fileId;
    csvUrl = uploaded.webViewLink;
  } catch (error) {
    csvError = error instanceof Error
      ? error.message
      : "The payout CSV could not be uploaded.";
  }

  const run = await finalizePayoutRunPass(db, {
    runId: acquired.run.id,
    leaseToken: acquired.leaseToken,
    actorEmail: actor.email,
    csvFileId,
    csvUrl,
    csvError,
    forcePartial: !acquired.selectionComplete || stoppedEarly,
  });
  const snapshot = await readPayoutRunPreview(db, {
    window,
    tutorFilter: input.tutorFilter,
  });
  return viewFromSnapshot({ ...snapshot, run }, window, { csvError, stoppedEarly });
}

/** Retry only the durable CSV artifact; no sheet read or append occurs. */
export async function retryPayoutRunCsv(
  actor: PostClassUser,
  input: { anchorMonth: string; expectedVersion: number },
  db: Database = getDb(),
  dependencies: PayoutRunDependencies = {},
): Promise<PayoutRunView> {
  const target = resolveWriteTarget(dependencies);
  if (!dependencies.uploadCsv) {
    await assertPayoutGoogleAccess(db, target.connectedEmail, {
      sheets: false,
      drive: true,
    });
  }
  const claimed = await claimPayoutCsvRetry(db, {
    anchorMonth: input.anchorMonth,
    actorEmail: actor.email,
    expectedVersion: input.expectedVersion,
    now: new Date(dependencies.now?.() ?? Date.now()),
  });
  const window = payoutRunWindow(input.anchorMonth);
  const lines = await loadPayoutRunLines(db, claimed.run.id);
  const adjustments = await loadPayoutAdjustments(db, claimed.run.id, lines);
  let csvFileId: string | null = null;
  let csvUrl: string | null = null;
  let csvError: string | null = null;
  try {
    const uploaded = await uploadPayoutCsv({
      target,
      window,
      runVersion: claimed.run.version,
      csv: payoutCsv(window, lines, adjustments),
      upload: dependencies.uploadCsv ?? uploadCsvToDrive,
    });
    csvFileId = uploaded.fileId;
    csvUrl = uploaded.webViewLink;
  } catch (error) {
    csvError = error instanceof Error ? error.message : "The payout CSV retry failed.";
  }
  const run = await finalizePayoutCsvRetry(db, {
    runId: claimed.run.id,
    leaseToken: claimed.leaseToken,
    expectedVersion: claimed.run.version,
    csvFileId,
    csvUrl,
    csvError,
  });
  const snapshot = await readPayoutRunPreview(db, { window });
  return viewFromSnapshot({ ...snapshot, run }, window, { csvError });
}

export async function resolvePayoutException(
  actor: PostClassUser,
  input: {
    exceptionId: string;
    expectedVersion: number;
    resolutionNote: string;
    resolutionReference?: string | null;
  },
  db: Database = getDb(),
): Promise<PayoutException> {
  return resolvePayoutExceptionRecord(db, {
    ...input,
    actorEmail: actor.email,
  });
}

export async function closePayoutRun(
  actor: PostClassUser,
  input: {
    anchorMonth: string;
    expectedVersion: number;
    closeReason: string;
  },
  db: Database = getDb(),
): Promise<PayoutRun> {
  return closePayoutRunRecord(db, {
    ...input,
    actorEmail: actor.email,
  });
}
