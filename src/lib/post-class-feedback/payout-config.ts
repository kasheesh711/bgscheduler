// ── Durable payout target configuration ─────────────────────────────────
//
// Payout publishing moves money. There are deliberately no live spreadsheet,
// folder, tab, or account fallbacks in source code: every deployment must say
// whether it targets scratch or production and name every Google resource.

export type PayoutEnvironmentTarget = "scratch" | "production";

type PayoutEnvironment = Record<string, string | undefined>;

function value(env: PayoutEnvironment, name: string): string {
  return env[name]?.trim() ?? "";
}

export const PAYOUT_DRIVE_FOLDER_ID =
  value(process.env, "POST_CLASS_PAYOUT_DRIVE_FOLDER_ID");

/** Folder recursively inventoried for tutor-facing payout workbooks. */
export const PAYOUT_WORKBOOKS_FOLDER_ID =
  value(process.env, "POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID");

export const PAYOUT_MASTER_SPREADSHEET_ID =
  value(process.env, "POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID");

/** Externally refreshed source. The app never writes to this tab. */
export const PAYOUT_SOURCE_SHEET_NAME =
  value(process.env, "POST_CLASS_PAYOUT_SOURCE_SHEET_NAME");

/** App-owned append-only A:H rows. */
export const PAYOUT_DEDUCTIONS_SHEET_NAME =
  value(process.env, "POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME");

/** Formula-backed union imported by tutor workbooks. */
export const PAYOUT_COMPOSITE_SHEET_NAME =
  value(process.env, "POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME");

export function payoutConnectedEmail(env: PayoutEnvironment = process.env): string {
  return value(env, "POST_CLASS_PAYOUT_CONNECTED_EMAIL").toLowerCase();
}

export function payoutEnvironmentTarget(
  env: PayoutEnvironment = process.env,
): PayoutEnvironmentTarget | null {
  const target = value(env, "POST_CLASS_PAYOUT_TARGET");
  return target === "scratch" || target === "production" ? target : null;
}

/** Only the exact string `true` enables app-originated payout writes. */
export function payoutWritesEnabled(env: PayoutEnvironment = process.env): boolean {
  return env.POST_CLASS_PAYOUT_WRITES_ENABLED === "true";
}

export interface PayoutGoogleTarget {
  environmentTarget: PayoutEnvironmentTarget;
  connectedEmail: string;
  driveFolderId: string;
  workbooksFolderId: string;
  masterSpreadsheetId: string;
  sourceSheetName: string;
  deductionsSheetName: string;
  compositeSheetName: string;
  writesEnabled: boolean;
}

/**
 * Resolve and validate the complete Google target at the operation boundary.
 *
 * Keeping validation out of module initialisation lets the dashboard report a
 * missing setup without crashing. Publish and maintenance scripts call this
 * before their first Google request.
 */
export function requirePayoutGoogleTarget(input: {
  env?: PayoutEnvironment;
  forWrite?: boolean;
  vercelEnvironment?: string | null;
} = {}): PayoutGoogleTarget {
  const env = input.env ?? process.env;
  const fields = {
    POST_CLASS_PAYOUT_TARGET: value(env, "POST_CLASS_PAYOUT_TARGET"),
    POST_CLASS_PAYOUT_CONNECTED_EMAIL: value(env, "POST_CLASS_PAYOUT_CONNECTED_EMAIL"),
    POST_CLASS_PAYOUT_DRIVE_FOLDER_ID: value(env, "POST_CLASS_PAYOUT_DRIVE_FOLDER_ID"),
    POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID: value(
      env,
      "POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID",
    ),
    POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID: value(
      env,
      "POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID",
    ),
    POST_CLASS_PAYOUT_SOURCE_SHEET_NAME: value(
      env,
      "POST_CLASS_PAYOUT_SOURCE_SHEET_NAME",
    ),
    POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME: value(
      env,
      "POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME",
    ),
    POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME: value(
      env,
      "POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME",
    ),
  };
  const missing = Object.entries(fields)
    .filter(([, fieldValue]) => !fieldValue)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Payout Google target is incomplete: ${missing.join(", ")}.`);
  }

  const environmentTarget = payoutEnvironmentTarget(env);
  if (!environmentTarget) {
    throw new Error("POST_CLASS_PAYOUT_TARGET must be scratch or production.");
  }

  const vercelEnvironment = input.vercelEnvironment
    ?? value(env, "VERCEL_ENV")
    ?? null;
  if (vercelEnvironment === "production" && environmentTarget !== "production") {
    throw new Error("A production deployment must use POST_CLASS_PAYOUT_TARGET=production.");
  }
  if (vercelEnvironment === "preview" && environmentTarget !== "scratch") {
    throw new Error("A preview deployment must use POST_CLASS_PAYOUT_TARGET=scratch.");
  }

  const writesEnabled = payoutWritesEnabled(env);
  if (input.forWrite && !writesEnabled) {
    throw new Error(
      "Payout writes are disabled. Set POST_CLASS_PAYOUT_WRITES_ENABLED=true only after rollout gates pass.",
    );
  }

  return {
    environmentTarget,
    connectedEmail: fields.POST_CLASS_PAYOUT_CONNECTED_EMAIL.toLowerCase(),
    driveFolderId: fields.POST_CLASS_PAYOUT_DRIVE_FOLDER_ID,
    workbooksFolderId: fields.POST_CLASS_PAYOUT_WORKBOOKS_FOLDER_ID,
    masterSpreadsheetId: fields.POST_CLASS_PAYOUT_MASTER_SPREADSHEET_ID,
    sourceSheetName: fields.POST_CLASS_PAYOUT_SOURCE_SHEET_NAME,
    deductionsSheetName: fields.POST_CLASS_PAYOUT_DEDUCTIONS_SHEET_NAME,
    compositeSheetName: fields.POST_CLASS_PAYOUT_COMPOSITE_SHEET_NAME,
    writesEnabled,
  };
}

/** `deductions-2026-06-26_2026-07-25.csv` */
export function payoutCsvFilename(windowStart: string, windowEnd: string): string {
  return `deductions-${windowStart}_${windowEnd}.csv`;
}
