/**
 * Restore exact A9/B6 formulas from a repoint backup artifact.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json \
 *     scripts/restore-payout-workbook-formulas.ts --backup /secure/payout-formulas.json
 *   ... --commit
 */

import { eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  payoutWorkbookTutorCell,
  payoutWorkbookTutorMatchesKey,
} from "@/lib/post-class-feedback/payout-workbook-operations";
import { createPayoutMaintenanceRateGate } from "@/lib/post-class-feedback/payout-writer";
import {
  batchUpdateGoogleSheetValues,
  fetchGoogleSheetRange,
  inspectGoogleSheetRange,
  listGoogleSheetProperties,
  quoteGoogleSheetName,
} from "@/lib/sales-dashboard/sheets";

import {
  payoutFormulaFleetSha256,
  type PayoutFormulaBackupArtifact,
} from "./lib/payout-formula-backup";
import {
  loadPayoutScriptEnvironment,
  optionValue,
  readJsonArtifact,
} from "./lib/payout-script";

function formulaAt(grid: unknown[][], label: string): string {
  const formula = String(grid[0]?.[0] ?? "").trim();
  if (!formula.startsWith("=")) throw new Error(`${label} is not a formula.`);
  return formula;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npm run payout:restore-workbooks --"
      + " --backup .payout-ops/formulas.json [--commit]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const target = requirePayoutGoogleTarget();
  const backupPath = optionValue("--backup");
  if (!backupPath) throw new Error("--backup is required.");
  const artifact = readJsonArtifact<PayoutFormulaBackupArtifact>(backupPath);
  if (artifact.version !== 1
    || artifact.environmentTarget !== target.environmentTarget
    || artifact.masterSpreadsheetId !== target.masterSpreadsheetId
    || artifact.sourceSheetName !== target.sourceSheetName
    || artifact.compositeSheetName !== target.compositeSheetName) {
    throw new Error("The backup artifact belongs to a different payout target.");
  }
  if (artifact.fleetSha256 !== payoutFormulaFleetSha256(artifact.entries)) {
    throw new Error("The backup artifact fleet hash is invalid.");
  }
  if (new Set(artifact.entries.map((entry) => entry.spreadsheetId)).size
    !== artifact.entries.length) {
    throw new Error("The backup artifact contains duplicate spreadsheet IDs.");
  }
  const pace = createPayoutMaintenanceRateGate();
  const current = new Map<string, { detail: string; total: string }>();

  // Validate the entire artifact/fleet before the first restore write.
  for (const entry of artifact.entries) {
    await pace();
    const tabs = await listGoogleSheetProperties(
      target.connectedEmail,
      entry.spreadsheetId,
    );
    const tab = tabs.find((candidate) => candidate.title === entry.sheetName);
    if (!tab || tab.sheetId !== entry.sheetGid) {
      throw new Error(
        `${entry.canonicalKey}: backup tab identity no longer matches the workbook.`,
      );
    }
    const quoted = quoteGoogleSheetName(entry.sheetName);
    await pace();
    const preamble = await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!A1:B9`,
    );
    const tutorCell = payoutWorkbookTutorCell(preamble);
    if (tutorCell !== entry.tutorCell
      || !payoutWorkbookTutorMatchesKey(tutorCell ?? "", entry.canonicalKey)) {
      throw new Error(
        `${entry.canonicalKey}: TUTOR identity changed after the formula backup.`,
      );
    }
    await pace();
    const detail = formulaAt(await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!A9`,
      { valueRenderOption: "FORMULA" },
    ), `${entry.canonicalKey} A9`);
    await pace();
    const total = formulaAt(await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!B6`,
      { valueRenderOption: "FORMULA" },
    ), `${entry.canonicalKey} B6`);
    if (![entry.detailFormula, entry.repointedDetailFormula].includes(detail)
      || ![entry.totalFormula, entry.repointedTotalFormula].includes(total)) {
      throw new Error(`${entry.canonicalKey}: current formulas disagree with the backup.`);
    }
    current.set(entry.spreadsheetId, { detail, total });
  }

  const commit = process.argv.includes("--commit");
  if (commit && target.environmentTarget === "production") {
    const [published] = await getDb().select({
      count: sql<number>`count(*)`,
    }).from(schema.postClassPayoutRunLines)
      .where(eq(schema.postClassPayoutRunLines.writeStatus, "written"));
    if (Number(published?.count ?? 0) > 0) {
      throw new Error(
        "Production already has written payout adjustments. Restoring source-only"
        + " formulas would hide them; disable writes and use append-only positive"
        + " compensation instead.",
      );
    }
  }
  console.log(JSON.stringify({
    mode: commit ? "commit" : "dry-run",
    environmentTarget: target.environmentTarget,
    workbookCount: artifact.entries.length,
    needsRestore: artifact.entries.filter((entry) =>
      current.get(entry.spreadsheetId)?.detail !== entry.detailFormula
      || current.get(entry.spreadsheetId)?.total !== entry.totalFormula).length,
  }, null, 2));
  if (!commit) {
    console.log("Dry run complete. Re-run with --commit to restore.");
    return;
  }

  for (const entry of artifact.entries) {
    const quoted = quoteGoogleSheetName(entry.sheetName);
    const existing = current.get(entry.spreadsheetId)!;
    if (existing.detail !== entry.detailFormula || existing.total !== entry.totalFormula) {
      await pace();
      await batchUpdateGoogleSheetValues(
        target.connectedEmail,
        entry.spreadsheetId,
        [
          { range: `${quoted}!A9`, values: [[entry.detailFormula]] },
          { range: `${quoted}!B6`, values: [[entry.totalFormula]] },
        ],
        "USER_ENTERED",
      );
    }
    await pace();
    const detail = formulaAt(await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!A9`,
      { valueRenderOption: "FORMULA" },
    ), `${entry.canonicalKey} A9`);
    await pace();
    const total = formulaAt(await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!B6`,
      { valueRenderOption: "FORMULA" },
    ), `${entry.canonicalKey} B6`);
    if (detail !== entry.detailFormula || total !== entry.totalFormula) {
      throw new Error(`${entry.canonicalKey}: restore readback failed.`);
    }
    await pace();
    const detailEffective = await inspectGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!A9`,
    );
    await pace();
    const totalEffective = await inspectGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!B6`,
    );
    const formulaErrors = [
      detailEffective[0]?.[0]?.error,
      totalEffective[0]?.[0]?.error,
    ].filter((value): value is string => Boolean(value));
    if (formulaErrors.length > 0) {
      throw new Error(`${entry.canonicalKey}: restored formula error ${formulaErrors.join(", ")}.`);
    }
  }
  console.log(`Restored and verified ${artifact.entries.length} workbook(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
