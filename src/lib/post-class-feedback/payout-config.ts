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

// ── Unattended charging (post-INC-260829 re-enable) ─────────────────────
//
// INC-260829: an armed accrual cron converted the entire pending_review
// backlog into sheet writes with no human decision. The flag below is the
// single opt-in for the whole unattended pipeline — the approve sweep, the
// payout-candidate carve-out, and the ledger-retirement pass all key on it,
// so flipping it off instantly restores human-only money movement.

/**
 * Unattended charging is opt-in and off by default (INC-260829). Approvals
 * are human-only unless this flag is an explicit `"true"`. The reopen sweep
 * is deliberately NOT behind this flag — reopening restores safety,
 * approving moves money.
 */
export function resolveAutoApproveEnabled(
  raw: string | undefined = process.env.POST_CLASS_AUTO_APPROVE_ENABLED,
): boolean {
  return raw?.trim() === "true";
}

const DEFAULT_AUTO_APPROVE_GRACE_HOURS = 24;

/**
 * Resolve the auto-approval grace window from the environment, defaulting to
 * 24 hours whenever the value is absent, blank, non-numeric, or negative.
 *
 * The bare `Number(raw ?? 24)` it replaces had two live failure modes once
 * the accrual cron is scheduled: `""` coerces to `0` (immediate
 * auto-approval, no grace at all) and a value like `"24h"` coerces to `NaN`,
 * which poisons the deadline `Date` handed to the query. An explicit `"0"`
 * remains allowed — that is a deliberate immediate-approval mode, distinct
 * from a blank or malformed value.
 */
export function resolveAutoApproveGraceHours(
  raw: string | undefined = process.env.POST_CLASS_AUTO_APPROVE_GRACE_HOURS,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_AUTO_APPROVE_GRACE_HOURS;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_APPROVE_GRACE_HOURS;
}

/**
 * The audited actor email the unattended approve sweep signs with. While the
 * flag above is on, `selectPayoutRunCandidates` admits exactly this system
 * actor into payout planning — the sole exception to the human-decision rule.
 */
export const PAYOUT_AUTO_APPROVE_ACTOR_EMAIL = "system:post-class-auto-approve";

/**
 * Earliest Bangkok class date unattended charging may touch — the start of
 * the 2026-09 payout window, the first fully automated period. Everything
 * earlier (the INC-260829 backlog and the settled 2026-08 ledger) remains a
 * human decision in the review UI.
 */
export const PAYOUT_AUTO_CHARGE_FLOOR_BANGKOK = "2026-08-26";
