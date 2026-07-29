/**
 * Back up and repoint every active tutor payout workbook.
 *
 * A9 and B6 are changed only by replacing one exact IMPORTRANGE range string.
 * Every workbook is preflighted before the first Google write.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json \
 *     scripts/repoint-payout-workbook-formulas.ts --backup /secure/payout-formulas.json
 *   ... --commit
 */

import fs from "node:fs";

import { asc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  payoutWorkbookTutorCell,
  payoutWorkbookTutorMatchesKey,
  planPayoutFormulaRepoint,
} from "@/lib/post-class-feedback/payout-workbook-operations";
import { createPayoutRateGate } from "@/lib/post-class-feedback/payout-writer";
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
  type PayoutFormulaBackupEntry,
} from "./lib/payout-formula-backup";
import {
  loadPayoutScriptEnvironment,
  optionValue,
  readJsonArtifact,
  writeJsonArtifactExclusive,
} from "./lib/payout-script";

function formulaAt(grid: unknown[][], label: string): string {
  const formula = String(grid[0]?.[0] ?? "").trim();
  if (!formula.startsWith("=")) throw new Error(`${label} is not a formula.`);
  return formula;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npm run payout:repoint-workbooks --"
      + " [--backup .payout-ops/formulas.json] [--commit]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const target = requirePayoutGoogleTarget();
  const commit = process.argv.includes("--commit");
  const backupPath = optionValue("--backup");
  if (commit && !backupPath) throw new Error("--backup is required with --commit.");

  const db = getDb();
  const workbooks = await db.select().from(schema.postClassTutorPayoutSheets)
    .where(eq(schema.postClassTutorPayoutSheets.active, true))
    .orderBy(asc(schema.postClassTutorPayoutSheets.canonicalKey));
  if (workbooks.length === 0) throw new Error("The active payout workbook registry is empty.");
  if (new Set(workbooks.map((row) => row.spreadsheetId)).size !== workbooks.length) {
    throw new Error("The active registry contains duplicate spreadsheet IDs.");
  }

  const existingBackup = backupPath && fs.existsSync(backupPath)
    ? readJsonArtifact<PayoutFormulaBackupArtifact>(backupPath)
    : null;
  if (existingBackup && (
    existingBackup.version !== 1
    || existingBackup.environmentTarget !== target.environmentTarget
    || existingBackup.masterSpreadsheetId !== target.masterSpreadsheetId
    || existingBackup.sourceSheetName !== target.sourceSheetName
    || existingBackup.compositeSheetName !== target.compositeSheetName
    || existingBackup.fleetSha256 !== payoutFormulaFleetSha256(existingBackup.entries)
  )) {
    throw new Error("The existing backup artifact belongs to a different payout target.");
  }
  const priorById = new Map(
    (existingBackup?.entries ?? []).map((entry) => [entry.spreadsheetId, entry]),
  );
  const pace = createPayoutRateGate();
  const entries: PayoutFormulaBackupEntry[] = [];
  const currentById = new Map<string, { detail: string; total: string }>();

  // Full fleet preflight. No values.update call occurs in this loop.
  for (const workbook of workbooks) {
    await pace();
    const tabs = await listGoogleSheetProperties(
      target.connectedEmail,
      workbook.spreadsheetId,
    );
    const registeredTab = tabs.find((tab) => tab.title === workbook.sheetName);
    if (!registeredTab) {
      throw new Error(
        `${workbook.canonicalKey}: registered tab "${workbook.sheetName}" is missing.`,
      );
    }
    if (registeredTab.sheetId !== workbook.sheetGid) {
      throw new Error(
        `${workbook.canonicalKey}: registered tab gid ${workbook.sheetGid}`
        + ` changed to ${registeredTab.sheetId}. Refresh and review the workbook inventory first.`,
      );
    }
    const quoted = quoteGoogleSheetName(workbook.sheetName);
    await pace();
    const preamble = await fetchGoogleSheetRange(
      target.connectedEmail,
      workbook.spreadsheetId,
      `${quoted}!A1:B9`,
    );
    const tutorCell = payoutWorkbookTutorCell(preamble);
    if (!tutorCell
      || !payoutWorkbookTutorMatchesKey(tutorCell, workbook.canonicalKey)) {
      throw new Error(
        `${workbook.canonicalKey}: TUTOR "${tutorCell ?? ""}" does not match the registry.`,
      );
    }
    await pace();
    const detailGrid = await fetchGoogleSheetRange(
      target.connectedEmail,
      workbook.spreadsheetId,
      `${quoted}!A9`,
      { valueRenderOption: "FORMULA" },
    );
    await pace();
    const totalGrid = await fetchGoogleSheetRange(
      target.connectedEmail,
      workbook.spreadsheetId,
      `${quoted}!B6`,
      { valueRenderOption: "FORMULA" },
    );
    const currentDetail = formulaAt(detailGrid, `${workbook.canonicalKey} A9`);
    const currentTotal = formulaAt(totalGrid, `${workbook.canonicalKey} B6`);
    currentById.set(workbook.spreadsheetId, {
      detail: currentDetail,
      total: currentTotal,
    });
    const prior = priorById.get(workbook.spreadsheetId);
    if (prior) {
      if (prior.canonicalKey !== workbook.canonicalKey
        || prior.sheetName !== workbook.sheetName
        || ![prior.detailFormula, prior.repointedDetailFormula].includes(currentDetail)
        || ![prior.totalFormula, prior.repointedTotalFormula].includes(currentTotal)) {
        throw new Error(`${workbook.canonicalKey}: current formulas disagree with the backup.`);
      }
      entries.push(prior);
      continue;
    }
    const detailPlan = planPayoutFormulaRepoint({
      formula: currentDetail,
      masterSpreadsheetId: target.masterSpreadsheetId,
      sourceSheetName: target.sourceSheetName,
      compositeSheetName: target.compositeSheetName,
    });
    const totalPlan = planPayoutFormulaRepoint({
      formula: currentTotal,
      masterSpreadsheetId: target.masterSpreadsheetId,
      sourceSheetName: target.sourceSheetName,
      compositeSheetName: target.compositeSheetName,
    });
    if (detailPlan.alreadyRepointed || totalPlan.alreadyRepointed) {
      throw new Error(
        `${workbook.canonicalKey}: already repointed but absent from the backup artifact.`,
      );
    }
    entries.push({
      canonicalKey: workbook.canonicalKey,
      spreadsheetId: workbook.spreadsheetId,
      sheetName: workbook.sheetName,
      sheetGid: registeredTab.sheetId,
      tutorCell,
      detailFormula: currentDetail,
      totalFormula: currentTotal,
      repointedDetailFormula: detailPlan.after,
      repointedTotalFormula: totalPlan.after,
    });
  }
  if (existingBackup && existingBackup.entries.length !== entries.length) {
    throw new Error("The active registry no longer has the backup artifact's exact fleet.");
  }
  const fleetSha256 = payoutFormulaFleetSha256(entries);
  if (existingBackup && existingBackup.fleetSha256 !== fleetSha256) {
    throw new Error("The active registry/formula fleet no longer matches the backup hash.");
  }

  const artifact: PayoutFormulaBackupArtifact = existingBackup ?? {
    version: 1,
    createdAt: new Date().toISOString(),
    environmentTarget: target.environmentTarget,
    masterSpreadsheetId: target.masterSpreadsheetId,
    sourceSheetName: target.sourceSheetName,
    compositeSheetName: target.compositeSheetName,
    fleetSha256,
    entries,
  };
  console.log(JSON.stringify({
    mode: commit ? "commit" : "dry-run",
    environmentTarget: target.environmentTarget,
    workbookCount: entries.length,
    alreadyRepointed: entries.filter((entry) => priorById.has(entry.spreadsheetId)).length,
    backupPath: backupPath ?? null,
  }, null, 2));
  if (!commit) {
    console.log("Dry run complete. Supply --backup and --commit to write.");
    return;
  }
  if (!existingBackup) writeJsonArtifactExclusive(backupPath!, artifact);

  for (const entry of entries) {
    const quoted = quoteGoogleSheetName(entry.sheetName);
    const current = currentById.get(entry.spreadsheetId)!;
    if (current.detail !== entry.repointedDetailFormula
      || current.total !== entry.repointedTotalFormula) {
      await pace();
      await batchUpdateGoogleSheetValues(
        target.connectedEmail,
        entry.spreadsheetId,
        [
          { range: `${quoted}!A9`, values: [[entry.repointedDetailFormula]] },
          { range: `${quoted}!B6`, values: [[entry.repointedTotalFormula]] },
        ],
        "USER_ENTERED",
      );
    }
    await pace();
    const detailReadback = formulaAt(await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!A9`,
      { valueRenderOption: "FORMULA" },
    ), `${entry.canonicalKey} A9`);
    await pace();
    const totalReadback = formulaAt(await fetchGoogleSheetRange(
      target.connectedEmail,
      entry.spreadsheetId,
      `${quoted}!B6`,
      { valueRenderOption: "FORMULA" },
    ), `${entry.canonicalKey} B6`);
    if (detailReadback !== entry.repointedDetailFormula
      || totalReadback !== entry.repointedTotalFormula) {
      throw new Error(`${entry.canonicalKey}: formula readback failed.`);
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
    const errors = [detailEffective[0]?.[0]?.error, totalEffective[0]?.[0]?.error]
      .filter((value): value is string => Boolean(value));
    if (errors.length > 0) {
      throw new Error(`${entry.canonicalKey}: repointed formula error ${errors.join(", ")}.`);
    }
  }
  console.log(`Repointed and verified ${entries.length} workbook(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
