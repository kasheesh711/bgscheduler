/**
 * Strictly close one 26→25 payout run, then roll every validated tutor
 * workbook's B4:B5 date window forward exactly once.
 *
 * Dry-run is the default:
 *
 *   npx tsx --tsconfig scripts/tsconfig.json \
 *     scripts/roll-payout-workbook-dates.ts \
 *     --anchor-month 2026-07 \
 *     --inventory .payout-ops/payout-workbooks.tsv
 *
 * Commit requires an accountable actor and reason:
 *
 *   ... --anchor-month 2026-07 \
 *     --inventory .payout-ops/payout-workbooks.tsv \
 *     --actor-email finance@example.com \
 *     --close-reason "July payout verified" \
 *     --commit
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getDb, type Database } from "@/lib/db";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import {
  beginOrResumePayoutWorkbookRoll,
  closePayoutRun,
  finalizePayoutWorkbookRoll,
  inspectPayoutRunCloseReadiness,
  loadActivePayoutWorkbookRegistry,
  PAYOUT_RUN_LEASE_MS,
  recordPayoutWorkbookRollOutcome,
  type PayoutRollOutcome,
  type PayoutWorkbookRegistryRow,
} from "@/lib/post-class-feedback/payout-repository";
import {
  buildPayoutCompositeFormula,
  inspectPayoutWorkbookDateState,
  parsePayoutWorkbookInventoryTsv,
  PAYOUT_TAB_HEADERS,
  payoutWorkbookRollWindows,
  payoutWorkbookTutorCell,
  payoutWorkbookTutorMatchesKey,
  planPayoutFormulaRepoint,
  type PayoutWorkbookDateState,
} from "@/lib/post-class-feedback/payout-workbook-operations";
import { payoutBangkokDate } from "@/lib/post-class-feedback/payout-window";
import {
  assertPayoutRollFitsLease,
  createPayoutRollRateGate,
} from "@/lib/post-class-feedback/payout-writer";
import {
  batchUpdateGoogleSheetValues,
  fetchGoogleSheetRange,
  inspectGoogleSheetRange,
  listGoogleSheetProperties,
  quoteGoogleSheetName,
  type GoogleSheetCellInspection,
} from "@/lib/sales-dashboard/sheets";

import {
  loadPayoutScriptEnvironment,
  optionValue,
} from "./lib/payout-script";

const HELP = `
Usage:
  npx tsx --tsconfig scripts/tsconfig.json scripts/roll-payout-workbook-dates.ts \\
    --anchor-month YYYY-MM --inventory payout-workbooks.tsv \\
    [--actor-email EMAIL --close-reason TEXT --commit]

--anchor-month is the outgoing anchor. 2026-07 verifies/closes
2026-06-26..2026-07-25 and writes 2026-07-26..2026-08-25.
--inventory must be a fresh recursive folder-owner Apps Script TSV. Its exact
spreadsheet-ID fleet must match the maintenance registry before close or write.
`.trim();

interface WorkbookPreflight {
  registry: PayoutWorkbookRegistryRow;
  tutorCell: string;
  detailFormula: string;
  totalFormula: string;
  dates: PayoutWorkbookDateState;
}

function requiredOption(name: string): string {
  const value = optionValue(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function formulaAt(grid: unknown[][], label: string): string {
  const formula = String(grid[0]?.[0] ?? "").trim();
  if (!formula.startsWith("=")) throw new Error(`${label} is not a formula.`);
  return formula;
}

function exactHeader(grid: unknown[][]): string[] {
  return Array.from({ length: PAYOUT_TAB_HEADERS.length }, (_, index) =>
    String(grid[0]?.[index] ?? ""));
}

function sameHeader(actual: readonly string[]): boolean {
  return actual.length === PAYOUT_TAB_HEADERS.length
    && actual.every((value, index) => value === PAYOUT_TAB_HEADERS[index]);
}

function fleetManifestHash(input: {
  target: {
    environmentTarget: string;
    masterSpreadsheetId: string;
    sourceSheetName: string;
    deductionsSheetName: string;
    compositeSheetName: string;
  };
  anchorMonth: string;
  inventorySha256: string;
  workbooks: readonly WorkbookPreflight[];
}): string {
  const canonical = {
    version: 1,
    environmentTarget: input.target.environmentTarget,
    masterSpreadsheetId: input.target.masterSpreadsheetId,
    sourceSheetName: input.target.sourceSheetName,
    deductionsSheetName: input.target.deductionsSheetName,
    compositeSheetName: input.target.compositeSheetName,
    anchorMonth: input.anchorMonth,
    inventorySha256: input.inventorySha256,
    workbooks: [...input.workbooks]
      .toSorted((left, right) =>
        left.registry.canonicalTutorKey.localeCompare(
          right.registry.canonicalTutorKey,
        ))
      .map((workbook) => ({
        canonicalTutorKey: workbook.registry.canonicalTutorKey,
        spreadsheetId: workbook.registry.spreadsheetId,
        sheetName: workbook.registry.sheetName,
        sheetGid: workbook.registry.sheetGid,
        tutorCell: workbook.tutorCell,
        detailFormula: workbook.detailFormula,
        totalFormula: workbook.totalFormula,
      })),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

async function preflightComposite(input: {
  connectedEmail: string;
  masterSpreadsheetId: string;
  sourceSheetName: string;
  deductionsSheetName: string;
  compositeSheetName: string;
  pace: () => Promise<void>;
}): Promise<void> {
  await input.pace();
  const properties = await listGoogleSheetProperties(
    input.connectedEmail,
    input.masterSpreadsheetId,
  );
  for (const title of [
    input.sourceSheetName,
    input.deductionsSheetName,
    input.compositeSheetName,
  ]) {
    if (properties.filter((sheet) => sheet.title === title).length !== 1) {
      throw new Error(`Master spreadsheet must contain exactly one "${title}" tab.`);
    }
  }
  for (const title of [
    input.sourceSheetName,
    input.deductionsSheetName,
    input.compositeSheetName,
  ]) {
    await input.pace();
    const header = exactHeader(await fetchGoogleSheetRange(
      input.connectedEmail,
      input.masterSpreadsheetId,
      `${quoteGoogleSheetName(title)}!A1:H1`,
    ));
    if (!sameHeader(header)) {
      throw new Error(`"${title}" does not have the exact payout A:H headers.`);
    }
  }
  const expectedFormula = buildPayoutCompositeFormula({
    sourceSheetName: input.sourceSheetName,
    deductionsSheetName: input.deductionsSheetName,
  });
  await input.pace();
  const formula = formulaAt(await fetchGoogleSheetRange(
    input.connectedEmail,
    input.masterSpreadsheetId,
    `${quoteGoogleSheetName(input.compositeSheetName)}!A2`,
    { valueRenderOption: "FORMULA" },
  ), `${input.compositeSheetName} A2`);
  if (formula !== expectedFormula) {
    throw new Error("The composite A2 formula is not the reviewed source/deductions union.");
  }
  await input.pace();
  const inspection = await inspectGoogleSheetRange(
    input.connectedEmail,
    input.masterSpreadsheetId,
    `${quoteGoogleSheetName(input.compositeSheetName)}!A2`,
  );
  const cell = inspection[0]?.[0];
  if (!cell || cell.error) {
    throw new Error(`The composite formula has a Sheets error: ${cell?.error ?? "missing cell"}.`);
  }
}

async function preflightWorkbook(input: {
  target: {
    connectedEmail: string;
    masterSpreadsheetId: string;
    sourceSheetName: string;
    compositeSheetName: string;
  };
  registry: PayoutWorkbookRegistryRow;
  windows: ReturnType<typeof payoutWorkbookRollWindows>;
  pace: () => Promise<void>;
}): Promise<WorkbookPreflight> {
  const { registry } = input;
  await input.pace();
  const tabs = await listGoogleSheetProperties(
    input.target.connectedEmail,
    registry.spreadsheetId,
  );
  const matchedTabs = tabs.filter((tab) => tab.title === registry.sheetName);
  if (matchedTabs.length !== 1 || matchedTabs[0].sheetId !== registry.sheetGid) {
    throw new Error(
      `${registry.canonicalTutorKey}: registered tab/gid no longer matches the workbook.`,
    );
  }
  const quoted = quoteGoogleSheetName(registry.sheetName);
  await input.pace();
  const preamble = await fetchGoogleSheetRange(
    input.target.connectedEmail,
    registry.spreadsheetId,
    `${quoted}!A1:B9`,
  );
  if (String(preamble[3]?.[0] ?? "").trim().toLocaleUpperCase("en-US")
    !== "START DATE"
    || String(preamble[4]?.[0] ?? "").trim().toLocaleUpperCase("en-US")
      !== "END DATE") {
    throw new Error(`${registry.canonicalTutorKey}: A4:A5 date labels changed.`);
  }
  const tutorCell = payoutWorkbookTutorCell(preamble);
  if (!tutorCell
    || !payoutWorkbookTutorMatchesKey(tutorCell, registry.canonicalTutorKey)) {
    throw new Error(
      `${registry.canonicalTutorKey}: TUTOR "${tutorCell ?? ""}" does not match the registry.`,
    );
  }
  await input.pace();
  const detailFormula = formulaAt(await fetchGoogleSheetRange(
    input.target.connectedEmail,
    registry.spreadsheetId,
    `${quoted}!A9`,
    { valueRenderOption: "FORMULA" },
  ), `${registry.canonicalTutorKey} A9`);
  await input.pace();
  const totalFormula = formulaAt(await fetchGoogleSheetRange(
    input.target.connectedEmail,
    registry.spreadsheetId,
    `${quoted}!B6`,
    { valueRenderOption: "FORMULA" },
  ), `${registry.canonicalTutorKey} B6`);
  for (const [label, formula] of [
    ["A9", detailFormula],
    ["B6", totalFormula],
  ] as const) {
    const plan = planPayoutFormulaRepoint({
      formula,
      masterSpreadsheetId: input.target.masterSpreadsheetId,
      sourceSheetName: input.target.sourceSheetName,
      compositeSheetName: input.target.compositeSheetName,
    });
    if (!plan.alreadyRepointed) {
      throw new Error(
        `${registry.canonicalTutorKey} ${label} still imports the read-only source tab.`,
      );
    }
  }
  await input.pace();
  const dateCells: GoogleSheetCellInspection[][] = await inspectGoogleSheetRange(
    input.target.connectedEmail,
    registry.spreadsheetId,
    `${quoted}!B4:B5`,
  );
  const dates = inspectPayoutWorkbookDateState(dateCells, input.windows);
  return {
    registry,
    tutorCell,
    detailFormula,
    totalFormula,
    dates,
  };
}

function assertRollReadiness(
  readiness: Awaited<ReturnType<typeof inspectPayoutRunCloseReadiness>>,
): asserts readiness is typeof readiness & { run: NonNullable<typeof readiness.run> } {
  if (!readiness.run) {
    throw new Error(readiness.blockers.map((blocker) => blocker.message).join(" "));
  }
  const acceptableClosedBlockers = readiness.run.status === "closed"
    && readiness.blockers.every((blocker) => blocker.code === "not_published");
  if (!readiness.ready && !acceptableClosedBlockers) {
    throw new Error(
      `Strict close gates failed: ${readiness.blockers
        .map((blocker) => blocker.message)
        .join(" ")}`,
    );
  }
}

async function recordFailure(input: {
  db: Database;
  outcome: PayoutRollOutcome;
  rollRunId: string;
  leaseToken: string;
  before: PayoutWorkbookDateState | null;
  windows: ReturnType<typeof payoutWorkbookRollWindows>;
  error: unknown;
}): Promise<void> {
  await recordPayoutWorkbookRollOutcome(input.db, {
    rollRunId: input.rollRunId,
    leaseToken: input.leaseToken,
    spreadsheetId: input.outcome.workbookId,
    expectedVersion: input.outcome.version,
    status: "failed",
    beforeStartSerial: input.before?.serials[0] ?? null,
    beforeEndSerial: input.before?.serials[1] ?? null,
    afterStartSerial: null,
    afterEndSerial: null,
    previousWindowStart: input.windows.outgoing.windowStart,
    previousWindowEnd: input.windows.outgoing.windowEnd,
    appliedWindowStart: input.windows.incoming.windowStart,
    appliedWindowEnd: input.windows.incoming.windowEnd,
    error: input.error instanceof Error ? input.error.message : "Workbook roll failed.",
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  loadPayoutScriptEnvironment();
  const anchorMonth = requiredOption("--anchor-month");
  const inventoryPath = requiredOption("--inventory");
  const inventoryRaw = fs.readFileSync(path.resolve(inventoryPath), "utf8");
  const inventory = parsePayoutWorkbookInventoryTsv(inventoryRaw);
  if (inventory.length === 0) {
    throw new Error("The recursive payout workbook inventory is empty.");
  }
  const inventoryIds = inventory.map((entry) => entry.spreadsheetId);
  if (new Set(inventoryIds).size !== inventoryIds.length) {
    throw new Error("The recursive payout workbook inventory contains duplicate spreadsheet IDs.");
  }
  const inventorySha256 = createHash("sha256")
    .update(inventoryRaw, "utf8")
    .digest("hex");
  const commit = process.argv.includes("--commit");
  const actorEmail = optionValue("--actor-email")?.trim().toLowerCase() ?? "";
  const closeReason = optionValue("--close-reason")?.trim() ?? "";
  if (commit && (!actorEmail || !actorEmail.includes("@"))) {
    throw new Error("--actor-email is required with --commit.");
  }
  if (commit && !closeReason) {
    throw new Error("--close-reason is required with --commit.");
  }

  const target = requirePayoutGoogleTarget();
  const db = getDb();
  const windows = payoutWorkbookRollWindows(anchorMonth);
  if (payoutBangkokDate(new Date()) <= windows.outgoing.windowEnd) {
    throw new Error(
      `Payout window ${windows.outgoing.windowStart}..${windows.outgoing.windowEnd}`
      + " has not ended in Bangkok.",
    );
  }
  const pace = createPayoutRollRateGate();
  const registry = await loadActivePayoutWorkbookRegistry(db);
  if (registry.length === 0) throw new Error("The active payout workbook registry is empty.");
  if (new Set(registry.map((row) => row.spreadsheetId)).size !== registry.length) {
    throw new Error("The active payout workbook registry contains duplicate spreadsheet IDs.");
  }
  const leasePacingBudget = assertPayoutRollFitsLease(
    registry.length,
    PAYOUT_RUN_LEASE_MS,
  );
  const registryIds = new Set(registry.map((row) => row.spreadsheetId));
  const inventoryIdSet = new Set(inventoryIds);
  const unregistered = inventoryIds.filter((id) => !registryIds.has(id));
  const missingFromInventory = registry
    .map((row) => row.spreadsheetId)
    .filter((id) => !inventoryIdSet.has(id));
  if (unregistered.length > 0 || missingFromInventory.length > 0) {
    throw new Error(
      "The fresh recursive inventory does not exactly match the active maintenance registry"
      + ` (unregistered=${unregistered.length}, missing=${missingFromInventory.length}).`
      + " Run the inventory/validation command and resolve every workbook before rolling.",
    );
  }

  const readiness = await inspectPayoutRunCloseReadiness(db, { anchorMonth });
  assertRollReadiness(readiness);
  await preflightComposite({ ...target, pace });

  // Full fleet preflight: no Google or database mutation occurs in this loop.
  const preflight: WorkbookPreflight[] = [];
  for (const workbook of registry) {
    preflight.push(await preflightWorkbook({
      target,
      registry: workbook,
      windows,
      pace,
    }));
  }
  if (readiness.run.status !== "closed") {
    const earlyRolled = preflight.filter((workbook) =>
      workbook.dates.state !== "outgoing");
    if (earlyRolled.length > 0) {
      throw new Error(
        `${earlyRolled.length} workbook(s) are not on the exact outgoing source window.`
        + " Restore them before the first close; mixed outgoing/incoming state is"
        + " accepted only when resuming an already-audited partial roll.",
      );
    }
  }
  const manifestHash = fleetManifestHash({
    target,
    anchorMonth,
    inventorySha256,
    workbooks: preflight,
  });
  const summary = {
    mode: commit ? "commit" : "dry-run",
    environmentTarget: target.environmentTarget,
    anchorMonth,
    outgoingWindow: windows.outgoing,
    incomingWindow: windows.incoming,
    payoutRunStatus: readiness.run.status,
    payoutRunVersion: readiness.run.version,
    workbookCount: preflight.length,
    inventoryPath: path.resolve(inventoryPath),
    inventorySha256,
    outgoingCount: preflight.filter((row) => row.dates.state === "outgoing").length,
    alreadyIncomingCount: preflight.filter((row) => row.dates.state === "incoming").length,
    leasePacingBudget,
    manifestHash,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!commit) {
    console.log("Dry run complete. Every workbook and strict close gate passed.");
    return;
  }

  const closed = await closePayoutRun(db, {
    anchorMonth,
    actorEmail,
    expectedVersion: readiness.run.version,
    closeReason,
  });
  const lease = await beginOrResumePayoutWorkbookRoll(db, {
    anchorMonth,
    closedRunId: closed.id,
    targetAnchorMonth: windows.incoming.anchorMonth,
    manifestHash,
    actorEmail,
    workbooks: preflight.map((row) => ({
      spreadsheetId: row.registry.spreadsheetId,
      workbookName: row.registry.canonicalTutorKey,
      canonicalTutorKey: row.registry.canonicalTutorKey,
    })),
  });

  if (lease.rollRun.status === "completed") {
    if (preflight.some((workbook) => workbook.dates.state !== "incoming")) {
      throw new Error("The durable roll is complete but a workbook is not on the target window.");
    }
    console.log("Workbook roll was already completed and remains verified.");
    return;
  }

  const preflightById = new Map(
    preflight.map((workbook) => [workbook.registry.spreadsheetId, workbook]),
  );
  try {
    for (const outcome of lease.outcomes) {
      const original = preflightById.get(outcome.workbookId);
      if (!original) {
        throw new Error(`Roll outcome ${outcome.workbookId} is outside the manifest.`);
      }
      let immediate: WorkbookPreflight | null = null;
      try {
        // Re-read the exact workbook immediately before deciding whether to
        // write. A stale fleet preflight never authorizes a remote mutation.
        immediate = await preflightWorkbook({
          target,
          registry: original.registry,
          windows,
          pace,
        });
        if (immediate.tutorCell !== original.tutorCell
          || immediate.detailFormula !== original.detailFormula
          || immediate.totalFormula !== original.totalFormula) {
          throw new Error("Workbook identity or formulas changed after fleet preflight.");
        }
        if (immediate.dates.state === "incoming") {
          if (outcome.status !== "verified" && outcome.status !== "already_target") {
            await recordPayoutWorkbookRollOutcome(db, {
              rollRunId: lease.rollRun.id,
              leaseToken: lease.leaseToken,
              spreadsheetId: outcome.workbookId,
              expectedVersion: outcome.version,
              status: "already_target",
              beforeStartSerial: immediate.dates.serials[0],
              beforeEndSerial: immediate.dates.serials[1],
              afterStartSerial: immediate.dates.serials[0],
              afterEndSerial: immediate.dates.serials[1],
              previousWindowStart: windows.outgoing.windowStart,
              previousWindowEnd: windows.outgoing.windowEnd,
              appliedWindowStart: windows.incoming.windowStart,
              appliedWindowEnd: windows.incoming.windowEnd,
            });
          }
          continue;
        }

        const quoted = quoteGoogleSheetName(immediate.registry.sheetName);
        await pace();
        await batchUpdateGoogleSheetValues(
          target.connectedEmail,
          immediate.registry.spreadsheetId,
          [{
            range: `${quoted}!B4:B5`,
            values: windows.incomingDateSerials.map((serial) => [serial]),
          }],
          "RAW",
        );
        await pace();
        const readback = inspectPayoutWorkbookDateState(
          await inspectGoogleSheetRange(
            target.connectedEmail,
            immediate.registry.spreadsheetId,
            `${quoted}!B4:B5`,
          ),
          windows,
        );
        if (readback.state !== "incoming") {
          throw new Error("Date readback did not reach the incoming payout window.");
        }
        await recordPayoutWorkbookRollOutcome(db, {
          rollRunId: lease.rollRun.id,
          leaseToken: lease.leaseToken,
          spreadsheetId: outcome.workbookId,
          expectedVersion: outcome.version,
          status: "verified",
          beforeStartSerial: immediate.dates.serials[0],
          beforeEndSerial: immediate.dates.serials[1],
          afterStartSerial: readback.serials[0],
          afterEndSerial: readback.serials[1],
          previousWindowStart: windows.outgoing.windowStart,
          previousWindowEnd: windows.outgoing.windowEnd,
          appliedWindowStart: windows.incoming.windowStart,
          appliedWindowEnd: windows.incoming.windowEnd,
        });
      } catch (error) {
        await recordFailure({
          db,
          outcome,
          rollRunId: lease.rollRun.id,
          leaseToken: lease.leaseToken,
          before: immediate?.dates ?? original.dates,
          windows,
          error,
        });
        throw error;
      }
    }
  } catch (error) {
    await finalizePayoutWorkbookRoll(db, {
      rollRunId: lease.rollRun.id,
      leaseToken: lease.leaseToken,
      actorEmail,
    });
    throw error;
  }
  const finalized = await finalizePayoutWorkbookRoll(db, {
    rollRunId: lease.rollRun.id,
    leaseToken: lease.leaseToken,
    actorEmail,
  });
  if (finalized.rollRun.status !== "completed") {
    throw new Error(
      `Workbook roll finalized as ${finalized.rollRun.status}; rerun after resolving failures.`,
    );
  }
  console.log(`Closed ${anchorMonth} and verified ${finalized.outcomes.length} workbook(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
