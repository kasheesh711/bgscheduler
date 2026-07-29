/**
 * Validate the recursive Apps Script inventory of tutor payout workbooks.
 *
 * Input is `path<TAB>spreadsheetId`, produced by a folder-owner Apps Script.
 * The filename/path is diagnostic only: ownership is resolved from the TUTOR
 * cell inside each workbook.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json \
 *     scripts/inventory-payout-workbooks.ts payout-workbooks.tsv
 *   ... --output /secure/path/inventory.json
 *   ... --commit
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  parsePayoutWorkbookInventoryTsv,
  payoutWorkbookTutorCell,
  planPayoutFormulaRepoint,
  resolvePayoutWorkbookTutorKeys,
} from "@/lib/post-class-feedback/payout-workbook-operations";
import { withPostClassTransaction } from "@/lib/post-class-feedback/transaction";
import { createPayoutMaintenanceRateGate } from "@/lib/post-class-feedback/payout-writer";
import {
  fetchGoogleSheetRange,
  inspectGoogleSheetRange,
  listGoogleSheetProperties,
  quoteGoogleSheetName,
} from "@/lib/sales-dashboard/sheets";

import {
  formulaCell,
  loadPayoutScriptEnvironment,
  optionValue,
  positionalArguments,
  writeJsonArtifact,
} from "./lib/payout-script";

interface InventoryOutcome {
  path: string;
  spreadsheetId: string;
  sheetName: string | null;
  sheetGid: number | null;
  tutorCell: string | null;
  canonicalKey: string | null;
  startDate: unknown;
  endDate: unknown;
  detailFormula: string | null;
  totalFormula: string | null;
  sourceState: "source" | "composite" | null;
  issueCodes: string[];
  error: string | null;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npm run payout:inventory -- <inventory.tsv>"
      + " [--output manifest.json] [--commit]",
    );
    return;
  }
  loadPayoutScriptEnvironment();
  const target = requirePayoutGoogleTarget();
  const [inputPath] = positionalArguments(["--output"]);
  if (!inputPath) throw new Error("Supply the Apps Script TSV path.");
  const inputs = parsePayoutWorkbookInventoryTsv(
    fs.readFileSync(path.resolve(inputPath), "utf8"),
  );
  if (inputs.length === 0) throw new Error("The inventory contains no spreadsheet IDs.");
  const idCounts = new Map<string, number>();
  for (const input of inputs) {
    idCounts.set(input.spreadsheetId, (idCounts.get(input.spreadsheetId) ?? 0) + 1);
  }

  const db = getDb();
  const activeSnapshots = await db.select({
    id: schema.snapshots.id,
  }).from(schema.snapshots).where(eq(schema.snapshots.active, true));
  if (activeSnapshots.length !== 1) {
    throw new Error(
      `Expected exactly one active Wise snapshot; found ${activeSnapshots.length}.`,
    );
  }
  const identitySnapshotId = activeSnapshots[0].id;
  const tutorRows = await db.select({
    key: schema.tutorIdentityGroups.canonicalKey,
  }).from(schema.tutorIdentityGroups)
    .where(eq(schema.tutorIdentityGroups.snapshotId, identitySnapshotId))
    .groupBy(schema.tutorIdentityGroups.canonicalKey);
  const tutorKeys = tutorRows
    .map((row) => row.key)
    .filter((key): key is string => Boolean(key));
  const pace = createPayoutMaintenanceRateGate();
  const outcomes: InventoryOutcome[] = [];
  const claimed = new Map<string, string>();

  for (const input of inputs) {
    const outcome: InventoryOutcome = {
      ...input,
      sheetName: null,
      sheetGid: null,
      tutorCell: null,
      canonicalKey: null,
      startDate: null,
      endDate: null,
      detailFormula: null,
      totalFormula: null,
      sourceState: null,
      issueCodes: [],
      error: null,
    };
    try {
      if ((idCounts.get(input.spreadsheetId) ?? 0) > 1) {
        throw new Error("The Apps Script inventory lists this spreadsheet ID more than once.");
      }
      await pace();
      const tabs = await listGoogleSheetProperties(
        target.connectedEmail,
        input.spreadsheetId,
      );
      const payoutTabs = tabs.filter((tab) => tab.title === "Payouts");
      if (payoutTabs.length !== 1) {
        throw new Error(`Expected exactly one Payouts tab; found ${payoutTabs.length}.`);
      }
      const tab = payoutTabs[0];
      outcome.sheetName = tab.title;
      outcome.sheetGid = tab.sheetId;
      const boundedRange = `${quoteGoogleSheetName(tab.title)}!A1:H12`;
      await pace();
      const values = await fetchGoogleSheetRange(
        target.connectedEmail,
        input.spreadsheetId,
        boundedRange,
      );
      await pace();
      const formulas = await fetchGoogleSheetRange(
        target.connectedEmail,
        input.spreadsheetId,
        boundedRange,
        { valueRenderOption: "FORMULA" },
      );
      outcome.tutorCell = payoutWorkbookTutorCell(values);
      if (!outcome.tutorCell) throw new Error("The bounded preamble has no TUTOR value.");
      const matches = resolvePayoutWorkbookTutorKeys(outcome.tutorCell, tutorKeys);
      if (matches.length !== 1) {
        throw new Error(
          `TUTOR "${outcome.tutorCell}" resolves to ${matches.length} canonical keys`
          + `${matches.length ? ` (${matches.join(", ")})` : ""}.`,
        );
      }
      outcome.canonicalKey = matches[0];
      const previous = claimed.get(matches[0]);
      if (previous && previous !== input.spreadsheetId) {
        throw new Error(`Canonical tutor ${matches[0]} is also claimed by ${previous}.`);
      }
      claimed.set(matches[0], input.spreadsheetId);

      outcome.startDate = values[3]?.[1] ?? null; // B4
      outcome.endDate = values[4]?.[1] ?? null; // B5
      if (String(values[3]?.[0] ?? "").trim().toLocaleLowerCase("en-US")
        !== "start date"
        || String(values[4]?.[0] ?? "").trim().toLocaleLowerCase("en-US")
        !== "end date") {
        throw new Error("A4:A5 are not the required START DATE / END DATE labels.");
      }
      if (typeof outcome.startDate !== "number" || typeof outcome.endDate !== "number") {
        throw new Error("B4:B5 are not numeric date cells.");
      }
      await pace();
      const dateCells = await inspectGoogleSheetRange(
        target.connectedEmail,
        input.spreadsheetId,
        `${quoteGoogleSheetName(tab.title)}!B4:B5`,
      );
      const dateFormats = dateCells.map((cells) => cells[0]?.numberFormatType ?? null);
      if (dateFormats.length !== 2
        || dateFormats.some((format) => format !== "DATE" && format !== "DATE_TIME")) {
        throw new Error(`B4:B5 are not date-formatted cells (${dateFormats.join(", ")}).`);
      }
      if (dateCells.some((cells) => {
        const inspected = cells[0];
        return !inspected
          || inspected.formulaValue !== null
          || typeof inspected.userEnteredValue !== "number"
          || inspected.userEnteredValue !== inspected.effectiveValue
          || Boolean(inspected.error);
      })) {
        throw new Error("B4:B5 must be literal, error-free numeric date cells.");
      }
      outcome.totalFormula = formulaCell([[formulas[5]?.[1]]], "B6");
      outcome.detailFormula = formulaCell([[formulas[8]?.[0]]], "A9");
      const formulaStates: boolean[] = [];
      for (const [label, formula] of [
        ["A9", outcome.detailFormula],
        ["B6", outcome.totalFormula],
      ] as const) {
        try {
          const plan = planPayoutFormulaRepoint({
            formula,
            masterSpreadsheetId: target.masterSpreadsheetId,
            sourceSheetName: target.sourceSheetName,
            compositeSheetName: target.compositeSheetName,
          });
          formulaStates.push(plan.alreadyRepointed);
        } catch (error) {
          throw new Error(
            `${label} does not import the configured source/composite range:`
            + ` ${error instanceof Error ? error.message : "invalid formula"}`,
          );
        }
      }
      if (formulaStates[0] !== formulaStates[1]) {
        throw new Error("A9 and B6 are in a mixed source/composite state.");
      }
      outcome.sourceState = formulaStates[0] ? "composite" : "source";
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : "Workbook inspection failed.";
      outcome.issueCodes.push("workbook_preflight_failed");
    }
    outcomes.push(outcome);
  }

  const errors = outcomes.filter((row) => row.error);
  const finalActiveSnapshots = await db.select({
    id: schema.snapshots.id,
  }).from(schema.snapshots).where(eq(schema.snapshots.active, true));
  const identitySnapshotStillActive = finalActiveSnapshots.length === 1
    && finalActiveSnapshots[0].id === identitySnapshotId;
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environmentTarget: target.environmentTarget,
    workbooksFolderId: target.workbooksFolderId,
    identitySnapshotId,
    identitySnapshotStillActive,
    inputCount: inputs.length,
    validCount: outcomes.length - errors.length,
    errorCount: errors.length,
    outcomes,
  };
  const fleetSha256 = createHash("sha256")
    .update(JSON.stringify(outcomes.map((row) => ({
      canonicalKey: row.canonicalKey,
      spreadsheetId: row.spreadsheetId,
      sheetName: row.sheetName,
      sheetGid: row.sheetGid,
      tutorCell: row.tutorCell,
      startDate: row.startDate,
      endDate: row.endDate,
      detailFormula: row.detailFormula,
      totalFormula: row.totalFormula,
      sourceState: row.sourceState,
    }))), "utf8")
    .digest("hex");
  const auditedArtifact = { ...artifact, fleetSha256 };
  const outputPath = optionValue("--output");
  if (outputPath) writeJsonArtifact(outputPath, auditedArtifact);
  console.log(JSON.stringify(auditedArtifact, null, 2));
  if (!identitySnapshotStillActive) {
    throw new Error(
      `Wise identity snapshot ${identitySnapshotId} changed during preflight; nothing was written.`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`${errors.length} workbook(s) failed preflight; nothing was written.`);
  }

  if (!process.argv.includes("--commit")) {
    console.log("Dry run complete. Re-run with --commit to refresh the maintenance registry.");
    return;
  }

  // All Google reads and every workbook validation completed before the first
  // database mutation.
  await withPostClassTransaction(db, async (tx) => {
    const lockedActiveSnapshots = await tx.select({
      id: schema.snapshots.id,
    }).from(schema.snapshots)
      .where(eq(schema.snapshots.active, true))
      .for("update");
    if (lockedActiveSnapshots.length !== 1
      || lockedActiveSnapshots[0].id !== identitySnapshotId) {
      throw new Error(
        `Wise identity snapshot ${identitySnapshotId} changed before commit; nothing was written.`,
      );
    }
    await tx.update(schema.postClassTutorPayoutSheets).set({
      active: false,
      updatedByEmail: target.connectedEmail,
      updatedAt: new Date(),
    }).where(eq(schema.postClassTutorPayoutSheets.active, true));
    for (const row of outcomes) {
      await tx.insert(schema.postClassTutorPayoutSheets).values({
        canonicalKey: row.canonicalKey!,
        spreadsheetId: row.spreadsheetId,
        sheetName: row.sheetName!,
        sheetGid: row.sheetGid!,
        active: true,
        updatedByEmail: target.connectedEmail,
      }).onConflictDoUpdate({
        target: schema.postClassTutorPayoutSheets.canonicalKey,
        set: {
          spreadsheetId: row.spreadsheetId,
          sheetName: row.sheetName!,
          sheetGid: row.sheetGid!,
          active: true,
          updatedByEmail: target.connectedEmail,
          updatedAt: new Date(),
        },
      });
    }
    await tx.insert(schema.postClassConfigAuditLog).values({
      entityType: "payout_workbook_registry",
      entityKey: target.environmentTarget,
      action: "inventory_commit",
      actorEmail: target.connectedEmail,
      beforeValue: null,
      afterValue: {
        fleetSha256,
        identitySnapshotId,
        workbookCount: outcomes.length,
        workbooksFolderId: target.workbooksFolderId,
      },
      note: "Validated recursive Apps Script inventory; identity read from each TUTOR cell.",
    });
  });
  console.log(`Registry updated for ${outcomes.length} validated workbook(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
