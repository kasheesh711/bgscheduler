import "server-only";

import {
  appendGoogleSheetRows,
  fetchGoogleSheetRows,
} from "@/lib/sales-dashboard/sheets";

// ── Appending signed rows to the app-owned deductions tab ───────────────
//
// The only module that talks to Google on the payout path. The gateway is an
// interface so ordering and failure behaviour can be tested against an
// in-memory ledger without a network.
//
// Appending, rather than inserting, is what makes this safe: nothing shifts, no
// row numbers change under us, no formula is disturbed, and a failed call
// leaves nothing behind to clean up.

export interface MasterLedgerGateway {
  /** Finance-owned source. Never write to this tab. */
  readRawGrid(): Promise<unknown[][]>;
  /** App-owned append-only rows; read before every pass for idempotency. */
  readDeductionGrid(): Promise<unknown[][]>;
  /** Appends one row; resolves with the 1-based row it landed on, if known. */
  appendDeductionRow(row: Array<string | number>): Promise<{ rowNumber: number | null }>;
}

/**
 * Google allows 60 write requests per minute per user, and one pinned account
 * performs every payout write in the system. An append costs one write, so
 * ~1.1s between calls keeps a run inside the quota with room to spare.
 */
export const PAYOUT_GOOGLE_MIN_INTERVAL_MS = 1_100;

export function createPayoutRateGate(minIntervalMs = PAYOUT_GOOGLE_MIN_INTERVAL_MS) {
  let nextSlot = Date.now();
  return async (): Promise<void> => {
    const now = Date.now();
    const waitMs = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minIntervalMs;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };
}

/**
 * Fleet maintenance performs several reads per workbook through the same
 * connected account used by the live application. Keep that traffic well
 * below the 60-request/minute per-user Sheets quota so a concurrent health
 * read cannot make an otherwise valid full-fleet preflight fail near the end.
 */
export const PAYOUT_GOOGLE_MAINTENANCE_MIN_INTERVAL_MS = 2_100;
export const PAYOUT_GOOGLE_ROLL_MIN_INTERVAL_MS = 1_500;
export const PAYOUT_GOOGLE_ROLL_CALLS_PER_WORKBOOK = 7;
export const PAYOUT_GOOGLE_ROLL_LEASE_SAFETY_MS = 2 * 60 * 1_000;

export function createPayoutMaintenanceRateGate() {
  return createPayoutRateGate(PAYOUT_GOOGLE_MAINTENANCE_MIN_INTERVAL_MS);
}

export function createPayoutRollRateGate() {
  return createPayoutRateGate(PAYOUT_GOOGLE_ROLL_MIN_INTERVAL_MS);
}

export function assertPayoutRollFitsLease(
  workbookCount: number,
  leaseMs: number,
): {
  pacedCallCount: number;
  minimumPacedDurationMs: number;
  safetyMarginMs: number;
} {
  if (!Number.isInteger(workbookCount) || workbookCount <= 0) {
    throw new Error("The payout roll requires a positive whole workbook count.");
  }
  const pacedCallCount = workbookCount * PAYOUT_GOOGLE_ROLL_CALLS_PER_WORKBOOK;
  const minimumPacedDurationMs = Math.max(0, pacedCallCount - 1)
    * PAYOUT_GOOGLE_ROLL_MIN_INTERVAL_MS;
  const availableMs = leaseMs - PAYOUT_GOOGLE_ROLL_LEASE_SAFETY_MS;
  if (minimumPacedDurationMs > availableMs) {
    throw new Error(
      `${workbookCount} payout workbooks cannot fit the worst-case Google`
      + ` read/write pass inside the durable roll lease with`
      + ` ${PAYOUT_GOOGLE_ROLL_LEASE_SAFETY_MS}ms safety margin.`,
    );
  }
  return {
    pacedCallCount,
    minimumPacedDurationMs,
    safetyMarginMs: leaseMs - minimumPacedDurationMs,
  };
}

export function createGoogleMasterLedgerGateway(
  input: {
    email: string;
    spreadsheetId: string;
    sourceSheetName: string;
    deductionsSheetName: string;
    pace?: () => Promise<void>;
  },
): MasterLedgerGateway {
  const pace = input.pace ?? createPayoutRateGate();
  return {
    async readRawGrid() {
      await pace();
      return fetchGoogleSheetRows(
        input.email,
        input.spreadsheetId,
        input.sourceSheetName,
      );
    },
    async readDeductionGrid() {
      await pace();
      return fetchGoogleSheetRows(
        input.email,
        input.spreadsheetId,
        input.deductionsSheetName,
      );
    },
    async appendDeductionRow(row) {
      await pace();
      const result = await appendGoogleSheetRows(
        input.email,
        input.spreadsheetId,
        input.deductionsSheetName,
        [row],
      );
      return { rowNumber: result.firstRowNumber };
    },
  };
}

export interface MasterAppendPlan {
  lineId: string;
  sourceType: "deduction" | "adjustment";
  sourceId: string;
  marker: string;
  row: Array<string | number>;
}

export interface MasterAppendOutcome {
  lineId: string;
  sourceType: "deduction" | "adjustment";
  sourceId: string;
  status: "written" | "failed";
  rowNumber: number | null;
  error: string | null;
}

export interface AppendMasterDeductionsInput {
  gateway: MasterLedgerGateway;
  plans: MasterAppendPlan[];
  /** Persisted the moment each outcome is known — Google cannot be rolled back. */
  onOutcome: (outcome: MasterAppendOutcome) => Promise<void>;
  /** Stop cleanly rather than overrun the platform function timeout. */
  deadlineAt?: number;
  clock?: () => number;
}

export interface AppendMasterDeductionsResult {
  outcomes: MasterAppendOutcome[];
  stoppedEarly: boolean;
}

export class DuplicatePayoutAppendSignatureError extends Error {
  constructor(public readonly marker: string) {
    super(`The payout append plan contains duplicate signature ${marker}.`);
    this.name = "DuplicatePayoutAppendSignatureError";
  }
}

/**
 * Append one ledger row per deduction, one call at a time.
 *
 * Deliberately not batched. A batched append that fails part-way gives no way
 * to tell which rows landed, and the recovery for that is a re-read plus a
 * marker scan — the same work, done later, with a window in which the ledger
 * and the database disagree. One row per call makes every outcome unambiguous
 * and gives an exact row number to record.
 *
 * A failure marks its line and the loop continues, mirroring the leave-requests
 * sheet writeback. There is no in-loop retry: `sheets.ts` throws a bare Error
 * with no status, so a 429, a 403 and a lost response are indistinguishable —
 * and a lost response may well mean the append landed. Re-running the pass
 * re-reads the ledger, where the marker says what actually happened.
 */
export async function appendMasterDeductions(
  input: AppendMasterDeductionsInput,
): Promise<AppendMasterDeductionsResult> {
  const markers = new Set<string>();
  for (const plan of input.plans) {
    if (markers.has(plan.marker)) {
      // Validate the whole batch before the first irreversible append.
      throw new DuplicatePayoutAppendSignatureError(plan.marker);
    }
    markers.add(plan.marker);
  }
  const clock = input.clock ?? Date.now;
  const outcomes: MasterAppendOutcome[] = [];
  let stoppedEarly = false;

  for (const plan of input.plans) {
    if (input.deadlineAt !== undefined && clock() >= input.deadlineAt) {
      stoppedEarly = true;
      break;
    }
    let outcome: MasterAppendOutcome;
    try {
      const { rowNumber } = await input.gateway.appendDeductionRow(plan.row);
      outcome = {
        lineId: plan.lineId,
        sourceType: plan.sourceType,
        sourceId: plan.sourceId,
        status: "written",
        rowNumber,
        error: null,
      };
    } catch (error) {
      outcome = {
        lineId: plan.lineId,
        sourceType: plan.sourceType,
        sourceId: plan.sourceId,
        status: "failed",
        rowNumber: null,
        error: error instanceof Error ? error.message : "The ledger append failed.",
      };
    }
    outcomes.push(outcome);
    await input.onOutcome(outcome);
  }

  return { outcomes, stoppedEarly };
}

export type PayoutAppendPlan = MasterAppendPlan;
export type PayoutAppendOutcome = MasterAppendOutcome;
export const appendPayoutRows = appendMasterDeductions;
