/**
 * SUPERSEDED — kept because its first real run is what found the problem, and
 * its sheet-reading and flagging logic carries over to the replacement.
 *
 * This maps each tutor to their own payout workbook, which is the wrong target.
 * A tutor's `Payouts` tab is a `QUERY(IMPORTRANGE(...))` view, not data; the
 * real store is the shared `Begifted Payouts Detailed` master, and the write is
 * an append to it. See "Where deductions actually go" in
 * `docs/features/post-class-feedback.md`. Running this with `--commit` would
 * populate `post_class_tutor_payout_sheets` with destinations no publish should
 * ever write to.
 *
 * Its dry run remains useful for inspecting a workbook's tabs and shape.
 *
 * ---
 *
 * Build the tutor → payout-spreadsheet mapping that a payout run cannot publish
 * without.
 *
 * `drive.file` only sees files this app created, so the spreadsheet IDs cannot
 * be discovered from inside the app. Supply them as TSV — one `name<TAB>id` per
 * line, which is what the Apps Script folder dump produces:
 *
 *   function listPayoutSheets() {
 *     const folder = DriveApp.getFolderById('<folder id>');
 *     const out = [];
 *     const walk = (f, path) => {
 *       const files = f.getFilesByType(MimeType.GOOGLE_SHEETS);
 *       while (files.hasNext()) { const x = files.next(); out.push(path + x.getName() + '\t' + x.getId()); }
 *       const subs = f.getFolders();
 *       while (subs.hasNext()) { const s = subs.next(); walk(s, path + s.getName() + '/'); }
 *     };
 *     walk(folder, '');
 *     Logger.log(out.sort().join('\n'));
 *   }
 *
 * Identity comes from each sheet's own `TUTOR` preamble cell, never from the
 * filename — a filename is unverified prose, and a wrong match writes a
 * deduction into the wrong person's pay. A sheet that matches zero tutors, or
 * more than one, is reported and skipped rather than guessed at.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/map-tutor-payout-sheets.ts sheets.tsv
 *   ... --commit          actually write the mapping (default is a dry run)
 *   ... --email <address> override the connected Google account
 *
 * `--tsconfig` is required: this reaches server-only modules that plain tsx
 * cannot resolve. See `scripts/stubs/server-only.ts`.
 */

import fs from "node:fs";
import path from "node:path";

import { isNotNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { payoutConnectedEmail } from "@/lib/post-class-feedback/payout-config";
import {
  loadActiveTutorPayoutSheets,
  upsertTutorPayoutSheet,
} from "@/lib/post-class-feedback/payout-repository";
import {
  parsePayoutSheet,
  parsePayoutSheetWindow,
} from "@/lib/post-class-feedback/payout-sheet";
import { createPayoutRateGate } from "@/lib/post-class-feedback/payout-writer";
import {
  fetchGoogleSheetRows,
  listGoogleSheetProperties,
} from "@/lib/sales-dashboard/sheets";

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

interface SheetInput {
  label: string;
  spreadsheetId: string;
}

function readInput(): SheetInput[] {
  const file = process.argv.slice(2).find((arg) => !arg.startsWith("--")
    && process.argv[process.argv.indexOf(arg) - 1] !== "--email");
  const raw = file
    ? fs.readFileSync(path.resolve(file), "utf8")
    : fs.readFileSync(0, "utf8");

  const inputs: SheetInput[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Accept `name<TAB>id`, a bare id, or a full spreadsheet URL.
    const url = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/u);
    if (url) {
      inputs.push({ label: trimmed.split(/\t/)[0] || url[1], spreadsheetId: url[1] });
      continue;
    }
    const parts = trimmed.split(/\t+/);
    const id = parts.length > 1 ? parts[parts.length - 1].trim() : parts[0];
    if (!/^[A-Za-z0-9_-]{20,}$/u.test(id)) continue;
    inputs.push({ label: parts.length > 1 ? parts.slice(0, -1).join(" ").trim() : id, spreadsheetId: id });
  }
  return inputs;
}

/** Whole-word tokens of a name, so "Kevin (Kev) Y. Hsieh" yields kevin/kev/y/hsieh. */
function nameTokens(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase("en-US")
      .split(/[^a-z0-9-]+/u)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

interface Outcome {
  label: string;
  spreadsheetId: string;
  tutorKey?: string;
  sheetName?: string;
  sheetGid?: number;
  declaredWindow?: string;
  tutorCell?: string;
  flag?: string;
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));

  const commit = process.argv.includes("--commit");
  const email = (optionValue("--email") ?? payoutConnectedEmail()).toLowerCase();
  const inputs = readInput();
  if (inputs.length === 0) {
    console.error("No spreadsheet IDs on stdin or in the given file.");
    process.exit(1);
  }

  const db = getDb();
  const tutors = await db.select({
    key: schema.postClassSessions.canonicalTutorKey,
    sessions: sql<number>`count(*)`,
  }).from(schema.postClassSessions)
    .where(isNotNull(schema.postClassSessions.canonicalTutorKey))
    .groupBy(schema.postClassSessions.canonicalTutorKey);
  const tutorKeys = tutors
    .map((row) => row.key)
    .filter((key): key is string => Boolean(key));

  console.log(`Connected account: ${email}`);
  console.log(`Sheets to inspect: ${inputs.length}`);
  console.log(`Known tutor keys:  ${tutorKeys.length}`);
  console.log(commit ? "Mode:              COMMIT\n" : "Mode:              dry run (pass --commit to write)\n");

  const pace = createPayoutRateGate();
  const outcomes: Outcome[] = [];
  const claimed = new Map<string, string>();

  for (const input of inputs) {
    const outcome: Outcome = { label: input.label, spreadsheetId: input.spreadsheetId };
    try {
      await pace();
      const tabs = await listGoogleSheetProperties(email, input.spreadsheetId);
      if (tabs.length === 0) {
        outcome.flag = "the spreadsheet reports no tabs";
        outcomes.push(outcome);
        continue;
      }

      // Find the tab that actually holds a payout table. A sheet whose shape we
      // do not recognise must never be written to, so an unrecognised workbook
      // is reported rather than mapped to its first tab and hoped for.
      let matchedTab: { title: string; sheetId: number } | null = null;
      let grid: unknown[][] = [];
      for (const tab of tabs) {
        await pace();
        const candidate = await fetchGoogleSheetRows(email, input.spreadsheetId, tab.title);
        if (!parsePayoutSheet(candidate)) continue;
        if (matchedTab) {
          outcome.flag = `more than one tab parses as a payout table (${matchedTab.title}, ${tab.title})`;
          break;
        }
        matchedTab = tab;
        grid = candidate;
      }
      if (outcome.flag) { outcomes.push(outcome); continue; }
      if (!matchedTab) {
        outcome.flag = "no tab has a Date/Time/Student name/Payout amount header row";
        outcomes.push(outcome);
        continue;
      }

      outcome.sheetName = matchedTab.title;
      outcome.sheetGid = matchedTab.sheetId;
      const window = parsePayoutSheetWindow(grid);
      outcome.declaredWindow = `${window.windowStart ?? "?"} → ${window.windowEnd ?? "?"}`;

      // The TUTOR preamble cell is the identity source.
      const tutorRow = grid.find((row) =>
        String(row?.[0] ?? "").trim().toLocaleLowerCase("en-US") === "tutor");
      const tutorCell = String(tutorRow?.[1] ?? "").trim();
      outcome.tutorCell = tutorCell;
      if (!tutorCell) {
        outcome.flag = "no TUTOR cell in the preamble, so the sheet does not say whose it is";
        outcomes.push(outcome);
        continue;
      }

      const tokens = nameTokens(tutorCell);
      const matches = tutorKeys.filter((key) => tokens.has(key.toLocaleLowerCase("en-US")));
      if (matches.length === 0) {
        outcome.flag = `TUTOR "${tutorCell}" matches no known tutor key`;
        outcomes.push(outcome);
        continue;
      }
      if (matches.length > 1) {
        outcome.flag = `TUTOR "${tutorCell}" matches ${matches.length} tutor keys (${matches.join(", ")})`;
        outcomes.push(outcome);
        continue;
      }

      const tutorKey = matches[0];
      const already = claimed.get(tutorKey);
      if (already && already !== input.spreadsheetId) {
        outcome.flag = `${tutorKey} already claimed by ${already} — two sheets for one tutor`;
        outcomes.push(outcome);
        continue;
      }
      claimed.set(tutorKey, input.spreadsheetId);
      outcome.tutorKey = tutorKey;

      if (commit) {
        await upsertTutorPayoutSheet(db, {
          canonicalKey: tutorKey,
          spreadsheetId: input.spreadsheetId,
          sheetName: matchedTab.title,
          sheetGid: matchedTab.sheetId,
          active: true,
          updatedByEmail: email,
        });
      }
    } catch (error) {
      outcome.flag = error instanceof Error ? error.message : "the sheet could not be read";
    }
    outcomes.push(outcome);
  }

  const mapped = outcomes.filter((row) => row.tutorKey && !row.flag);
  const flagged = outcomes.filter((row) => row.flag);
  const mappedKeys = new Set(mapped.map((row) => row.tutorKey));
  const missing = tutorKeys.filter((key) => !mappedKeys.has(key)).toSorted();

  console.log(`MAPPED (${mapped.length})`);
  for (const row of mapped.toSorted((a, b) => (a.tutorKey ?? "").localeCompare(b.tutorKey ?? ""))) {
    console.log(`  ${row.tutorKey?.padEnd(14)} ${row.sheetName}!gid=${row.sheetGid}  ${row.declaredWindow}  ${row.spreadsheetId}`);
  }

  console.log(`\nFLAGGED (${flagged.length}) — nothing written for these`);
  for (const row of flagged) {
    console.log(`  ${row.label || row.spreadsheetId}`);
    console.log(`      ${row.flag}`);
  }

  console.log(`\nTUTORS WITH NO SHEET (${missing.length})`);
  console.log(missing.length ? `  ${missing.join(", ")}` : "  (none)");

  if (!commit) console.log("\nDry run — nothing was written. Re-run with --commit.");
  const existing = await loadActiveTutorPayoutSheets(db);
  console.log(`\nMappings currently in the database: ${existing.size}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
