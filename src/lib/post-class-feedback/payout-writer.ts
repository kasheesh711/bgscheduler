import "server-only";

import {
  appendGoogleSheetRows,
  fetchGoogleSheetRows,
} from "@/lib/sales-dashboard/sheets";

import {
  PAYOUT_MASTER_SHEET_NAME,
  PAYOUT_MASTER_SPREADSHEET_ID,
} from "./payout-config";

// ── Appending deductions to the master ledger ───────────────────────────
//
// The only module that talks to Google on the payout path. The gateway is an
// interface so ordering and failure behaviour can be tested against an
// in-memory ledger without a network.
//
// Appending, rather than inserting, is what makes this safe: nothing shifts, no
// row numbers change under us, no formula is disturbed, and a failed call
// leaves nothing behind to clean up.

export interface MasterLedgerGateway {
  readGrid(): Promise<unknown[][]>;
  /** Appends one row; resolves with the 1-based row it landed on, if known. */
  appendRow(row: Array<string | number>): Promise<{ rowNumber: number | null }>;
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

export function createGoogleMasterLedgerGateway(
  email: string,
  pace: () => Promise<void> = createPayoutRateGate(),
  spreadsheetId: string = PAYOUT_MASTER_SPREADSHEET_ID,
  sheetName: string = PAYOUT_MASTER_SHEET_NAME,
): MasterLedgerGateway {
  return {
    async readGrid() {
      await pace();
      return fetchGoogleSheetRows(email, spreadsheetId, sheetName);
    },
    async appendRow(row) {
      await pace();
      const result = await appendGoogleSheetRows(email, spreadsheetId, sheetName, [row]);
      return { rowNumber: result.firstRowNumber };
    },
  };
}

export interface MasterAppendPlan {
  lineId: string;
  deductionId: string;
  marker: string;
  row: Array<string | number>;
}

export interface MasterAppendOutcome {
  lineId: string;
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
      const { rowNumber } = await input.gateway.appendRow(plan.row);
      outcome = { lineId: plan.lineId, status: "written", rowNumber, error: null };
    } catch (error) {
      outcome = {
        lineId: plan.lineId,
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
