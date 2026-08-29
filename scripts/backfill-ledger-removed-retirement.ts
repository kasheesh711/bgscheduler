/**
 * INC-260829 backfill: retire written payout lines whose sheet rows were
 * already deleted by the netted-pair removal (which predated the retirement
 * flag).
 *
 * `retired_at` on a written line is the durable "removed from the ledger"
 * marker that reinstatement checks. Scope: written, unretired lines whose
 * deduction is waived/reversed AND whose marker is verifiably ABSENT from the
 * live deductions tab. Read-only toward Google (one grid fetch), guarded DB
 * update under the finance lock.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/backfill-ledger-removed-retirement.ts
 *   ... --commit   apply (default is a dry run)
 */

import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { lockPostClassFinance } from "@/lib/post-class-feedback/finance-lock";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import { parseMasterPayoutSheet } from "@/lib/post-class-feedback/payout-master";
import { withPostClassTransaction } from "@/lib/post-class-feedback/transaction";
import { fetchGoogleSheetRows } from "@/lib/sales-dashboard/sheets";

import { loadPayoutScriptEnvironment } from "./lib/payout-script";

async function main(): Promise<void> {
  loadPayoutScriptEnvironment();
  const commit = process.argv.includes("--commit");
  const db = getDb();
  const target = requirePayoutGoogleTarget();
  console.log(commit ? "Mode: COMMIT\n" : "Mode: dry run (pass --commit to apply)\n");

  const table = parseMasterPayoutSheet(await fetchGoogleSheetRows(
    target.connectedEmail,
    target.masterSpreadsheetId,
    target.deductionsSheetName,
  ));
  if (!table) throw new Error("The deductions tab could not be parsed.");
  const liveMarkers = new Set(
    table.rows.map((row) => row.marker).filter((marker): marker is string => Boolean(marker)),
  );

  const lines = await db.select({
    id: schema.postClassPayoutRunLines.id,
    rowSignature: schema.postClassPayoutRunLines.rowSignature,
    tutorName: schema.postClassPayoutRunLines.tutorName,
    wiseSessionId: schema.postClassPayoutRunLines.wiseSessionId,
    deductionStatus: schema.postClassDeductions.status,
  }).from(schema.postClassPayoutRunLines)
    .innerJoin(
      schema.postClassDeductions,
      eq(schema.postClassDeductions.id, schema.postClassPayoutRunLines.deductionId),
    )
    .where(and(
      eq(schema.postClassPayoutRunLines.writeStatus, "written"),
      isNull(schema.postClassPayoutRunLines.retiredAt),
      inArray(schema.postClassDeductions.status, ["waived", "reversed"]),
    ));

  const toRetire = lines.filter((line) => !liveMarkers.has(line.rowSignature));
  const stillOnSheet = lines.filter((line) => liveMarkers.has(line.rowSignature));
  for (const line of toRetire) {
    console.log(`  retire  ${line.tutorName ?? "(unnamed)"}  ${line.wiseSessionId}  ${line.rowSignature}`);
  }
  console.log(
    `\nPlanned: ${toRetire.length} lines to retire (marker absent from the sheet);`
    + ` ${stillOnSheet.length} waived-with-live-row lines left alone.`,
  );
  if (!commit || toRetire.length === 0) return;

  await withPostClassTransaction(db, async (tx) => {
    await lockPostClassFinance(tx);
    await tx.update(schema.postClassPayoutRunLines).set({
      retiredAt: new Date(),
      retiredReason: "Removed from the ledger (netted pair, INC-260829)",
      updatedAt: new Date(),
    }).where(and(
      inArray(schema.postClassPayoutRunLines.id, toRetire.map((line) => line.id)),
      isNull(schema.postClassPayoutRunLines.retiredAt),
    ));
  });
  console.log(`Retired ${toRetire.length} lines.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
