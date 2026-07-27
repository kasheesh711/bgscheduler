import "server-only";

import {
  fetchGoogleSheetRows,
  insertGoogleSheetRow,
  updateGoogleSheetRowValues,
} from "@/lib/sales-dashboard/sheets";

import type { PayoutWritePlan } from "./payout-plan";

// ── Writing deduction rows into tutor payout sheets ─────────────────────
//
// The only module that talks to Google. The gateway is an interface so the
// ordering and crash-recovery behaviour can be tested against a real grid that
// actually shifts on insert, without a network.

export interface PayoutSheetGateway {
  readGrid(spreadsheetId: string, sheetName: string): Promise<unknown[][]>;
  insertRow(spreadsheetId: string, sheetGid: number, afterRowNumber: number): Promise<void>;
  updateRow(
    spreadsheetId: string,
    sheetName: string,
    rowNumber: number,
    values: Array<string | number | null>,
  ): Promise<void>;
}

/**
 * Google allows 60 write requests per minute per user, and one pinned account
 * performs every payout write in the system. Each line costs two writes, so
 * ~1.1s between calls keeps a run comfortably inside the quota at roughly 27
 * lines a minute.
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

export function createGooglePayoutSheetGateway(
  email: string,
  pace: () => Promise<void> = createPayoutRateGate(),
): PayoutSheetGateway {
  return {
    async readGrid(spreadsheetId, sheetName) {
      await pace();
      return fetchGoogleSheetRows(email, spreadsheetId, sheetName);
    },
    async insertRow(spreadsheetId, sheetGid, afterRowNumber) {
      await pace();
      await insertGoogleSheetRow(email, spreadsheetId, sheetGid, afterRowNumber);
    },
    async updateRow(spreadsheetId, sheetName, rowNumber, values) {
      await pace();
      await updateGoogleSheetRowValues(email, spreadsheetId, sheetName, rowNumber, values);
    },
  };
}

export interface PayoutWriteOutcome {
  lineId: string;
  status: "written" | "failed";
  rowNumber: number | null;
  error: string | null;
}

export interface WritePayoutSheetPlansInput {
  gateway: PayoutSheetGateway;
  /** Already ordered bottom-up within each sheet by `orderPayoutWritesBottomUp`. */
  plansBySheet: Map<string, PayoutWritePlan[]>;
  /** Persisted the moment each outcome is known — Google cannot be rolled back. */
  onOutcome: (outcome: PayoutWriteOutcome) => Promise<void>;
  /** Stop cleanly rather than overrun the platform function timeout. */
  deadlineAt?: number;
  clock?: () => number;
}

export interface WritePayoutSheetPlansResult {
  outcomes: PayoutWriteOutcome[];
  stoppedEarly: boolean;
}

/**
 * Apply every plan, sheet by sheet, one line at a time.
 *
 * Sequential on purpose: the writes into a single sheet are order-dependent,
 * and the whole run shares one Google account's quota.
 *
 * A failure marks its line and the loop continues, mirroring how the
 * leave-requests sheet writeback records a per-row failure and carries on.
 * There is deliberately no in-loop retry: `sheets.ts` throws a bare Error with
 * no status, so a 429 (retryable), a 403 (never retryable) and a lost response
 * (the request may well have landed) are indistinguishable — and retrying a
 * non-idempotent insert on a lost response would duplicate a payout row. The
 * retry pass re-reads the grid instead, where the marker and blank-row checks
 * can tell what actually happened.
 */
export async function writePayoutSheetPlans(
  input: WritePayoutSheetPlansInput,
): Promise<WritePayoutSheetPlansResult> {
  const clock = input.clock ?? Date.now;
  const outcomes: PayoutWriteOutcome[] = [];
  let stoppedEarly = false;

  for (const plans of input.plansBySheet.values()) {
    if (stoppedEarly) break;
    for (const plan of plans) {
      if (input.deadlineAt !== undefined && clock() >= input.deadlineAt) {
        stoppedEarly = true;
        break;
      }
      try {
        if (!plan.reuseBlankRow) {
          await input.gateway.insertRow(plan.spreadsheetId, plan.sheetGid, plan.anchorRowNumber);
        }
        await input.gateway.updateRow(
          plan.spreadsheetId,
          plan.sheetName,
          plan.targetRowNumber,
          plan.values,
        );
        const outcome: PayoutWriteOutcome = {
          lineId: plan.lineId,
          status: "written",
          rowNumber: plan.targetRowNumber,
          error: null,
        };
        outcomes.push(outcome);
        await input.onOutcome(outcome);
      } catch (error) {
        const outcome: PayoutWriteOutcome = {
          lineId: plan.lineId,
          status: "failed",
          rowNumber: null,
          error: error instanceof Error ? error.message : "The payout sheet write failed.",
        };
        outcomes.push(outcome);
        await input.onOutcome(outcome);
      }
    }
  }

  return { outcomes, stoppedEarly };
}
