// ── Payout run configuration ────────────────────────────────────────────
//
// One pinned Google account performs every payout write, so only that
// account needs the Drive scope and Editor access on the Drive folder and
// the tutor payout sheets. This mirrors LEAVE_REQUESTS_CONNECTED_EMAIL.

export const PAYOUT_DRIVE_FOLDER_ID =
  process.env.POST_CLASS_PAYOUT_DRIVE_FOLDER_ID?.trim() ||
  "17k6MWv3EQEJvJja-wsbb1kBPtL82oxzZ";

export function payoutConnectedEmail(): string {
  return (
    process.env.POST_CLASS_CONNECTED_EMAIL?.trim() ||
    process.env.LEAVE_REQUESTS_CONNECTED_EMAIL?.trim() ||
    process.env.SALES_DASHBOARD_CONNECTED_EMAIL?.trim() ||
    "kevhsh7@gmail.com"
  ).toLowerCase();
}

/** `deductions-2026-06-26_2026-07-25.csv` */
export function payoutCsvFilename(windowStart: string, windowEnd: string): string {
  return `deductions-${windowStart}_${windowEnd}.csv`;
}

// ── The master payout ledger ────────────────────────────────────────────
//
// Deductions are appended here, not to a tutor's workbook: that workbook is a
// `QUERY(IMPORTRANGE(...))` view over this tab, and writing into an array
// formula's output breaks it. One row here reaches every view that filters on
// its Teacher name.

export const PAYOUT_MASTER_SPREADSHEET_ID =
  process.env.POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID?.trim() ||
  "16HG_gVjdqVbo_A-xcQB5aCZeK21Ema4Xr4YZFHldHJg";

export const PAYOUT_MASTER_SHEET_NAME =
  process.env.POST_CLASS_PAYOUT_MASTER_SHEET_NAME?.trim() ||
  "Begifted Payouts Detailed";
