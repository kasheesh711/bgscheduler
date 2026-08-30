/**
 * INC-260829 reconciliation report: master-sheet reality vs the payout DB.
 *
 * Thin CLI over `verifyPayoutSheet` (src/lib/post-class-feedback/
 * payout-sheet-verify.ts) — the same engine behind the in-app "Verify sheet"
 * action. STRICTLY READ-ONLY (one Sheets read, zero writes). Prints a
 * summary, flags attention rows, and writes the full row-by-row CSV to
 * `.payout-ops/` for the admin.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/report-payout-sheet-reconciliation.ts
 *   ... [--anchor=2026-08]   target anchor month (default: current window)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getDb } from "@/lib/db";
import { verifyPayoutSheet } from "@/lib/post-class-feedback/payout-sheet-verify";
import { currentPayoutRunWindow } from "@/lib/post-class-feedback/payout-window";

import { loadPayoutScriptEnvironment } from "./lib/payout-script";

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npx tsx --tsconfig scripts/tsconfig.json "
      + "scripts/report-payout-sheet-reconciliation.ts [--anchor=YYYY-MM]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const anchorArg = process.argv.find((arg) => arg.startsWith("--anchor="));
  const anchor = anchorArg?.slice("--anchor=".length)
    ?? currentPayoutRunWindow().anchorMonth;

  const result = await verifyPayoutSheet(getDb(), anchor);

  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const key = `${row.kind} / ${row.sheetStatus} (db: ${row.dbStatus})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`Reconciliation for anchor ${anchor} (${result.sheetRowCount} sheet rows):\n`);
  for (const [key, count] of [...counts.entries()].toSorted()) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
  console.log(
    `\n${result.attention.length} row${result.attention.length === 1 ? "" : "s"}`
    + " need attention (see CSV).",
  );

  const csvPath = path.resolve(
    ".payout-ops",
    `inc-260829-sheet-reconciliation-${new Date().toISOString().replace(/[:.]/gu, "-")}.csv`,
  );
  mkdirSync(path.dirname(csvPath), { recursive: true });
  const header = [
    "kind", "tutor", "wise_session_or_deduction", "db_status", "sheet_status",
    "sheet_row", "sheet_amount", "expected_amount", "marker",
  ].join(",");
  writeFileSync(csvPath, `${header}\n${result.rows.map((row) => [
    row.kind, csvCell(row.tutorName), row.wiseSessionId, csvCell(row.dbStatus), row.sheetStatus,
    csvCell(row.sheetRowNumber), csvCell(row.sheetAmount), csvCell(row.expectedAmount), csvCell(row.marker),
  ].join(",")).join("\n")}\n`, { flag: "wx" });
  console.log(`CSV: ${csvPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
