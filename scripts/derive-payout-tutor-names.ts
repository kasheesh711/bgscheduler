/**
 * Map each tutor to the exact identity strings the master payout ledger uses.
 *
 * A deduction only reaches a tutor's payout view if its ledger row carries one
 * of those strings verbatim — the view is a `QUERY` filtered on an exact match.
 * So the names are read out of the ledger itself and never constructed: an
 * approximation produces a row that belongs to nobody and is silently invisible
 * to the tutor and to their total.
 *
 * Matching is on the parenthesised nickname, `Apivit (Ek) Sirithana` → `Ek`,
 * because that is what `canonical_tutor_key` holds. Anything that does not
 * match exactly one live tutor key is reported, never guessed.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/derive-payout-tutor-names.ts
 *   ... --commit          write the mapping (default is a dry run)
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
import {
  PAYOUT_MASTER_SHEET_NAME,
  PAYOUT_MASTER_SPREADSHEET_ID,
  payoutConnectedEmail,
} from "@/lib/post-class-feedback/payout-config";
import { parseMasterPayoutSheet } from "@/lib/post-class-feedback/payout-master";
import {
  loadPayoutTutorNames,
  upsertPayoutTutorName,
} from "@/lib/post-class-feedback/payout-repository";
import { fetchGoogleSheetRows } from "@/lib/sales-dashboard/sheets";

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

const ONLINE_SUFFIX = " Online";

/** `Apivit (Ek) Sirithana` → `ek`. Null when the name carries no nickname. */
function parenthesisedNickname(name: string): string | null {
  const match = name.match(/\(([^)]+)\)/u);
  return match ? match[1].trim().toLocaleLowerCase("en-US") : null;
}

interface LedgerTutor {
  onsiteName: string;
  onlineName: string | null;
  nickname: string | null;
  rowCount: number;
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));

  const commit = process.argv.includes("--commit");
  const email = (optionValue("--email") ?? payoutConnectedEmail()).toLowerCase();
  const db = getDb();

  console.log(`Connected account: ${email}`);
  console.log(`Ledger:            ${PAYOUT_MASTER_SHEET_NAME}`);
  console.log(commit ? "Mode:              COMMIT\n" : "Mode:              dry run (pass --commit to write)\n");

  const grid = await fetchGoogleSheetRows(email, PAYOUT_MASTER_SPREADSHEET_ID, PAYOUT_MASTER_SHEET_NAME);
  const table = parseMasterPayoutSheet(grid);
  if (!table) {
    console.error("The ledger's columns are not where they are expected. Nothing was read.");
    process.exit(1);
  }

  // Every distinct identity string, with how often it appears — a name with one
  // row is far more likely to be a typo than a tutor.
  const counts = new Map<string, number>();
  for (const row of table.rows) {
    counts.set(row.teacherName, (counts.get(row.teacherName) ?? 0) + 1);
  }

  // Pair each onsite identity with its " Online" twin.
  const onsiteNames = [...counts.keys()].filter((name) => !name.endsWith(ONLINE_SUFFIX));
  const ledgerTutors: LedgerTutor[] = onsiteNames.map((onsiteName) => ({
    onsiteName,
    onlineName: counts.has(`${onsiteName}${ONLINE_SUFFIX}`) ? `${onsiteName}${ONLINE_SUFFIX}` : null,
    nickname: parenthesisedNickname(onsiteName),
    rowCount: (counts.get(onsiteName) ?? 0)
      + (counts.get(`${onsiteName}${ONLINE_SUFFIX}`) ?? 0),
  })).toSorted((a, b) => a.onsiteName.localeCompare(b.onsiteName));

  // An " Online" name with no onsite twin still belongs to somebody.
  const orphanOnline = [...counts.keys()].filter((name) =>
    name.endsWith(ONLINE_SUFFIX) && !counts.has(name.slice(0, -ONLINE_SUFFIX.length)));

  const tutorRows = await db.select({
    key: schema.postClassSessions.canonicalTutorKey,
    sessions: sql<number>`count(*)`,
  }).from(schema.postClassSessions)
    .where(isNotNull(schema.postClassSessions.canonicalTutorKey))
    .groupBy(schema.postClassSessions.canonicalTutorKey);
  const tutorKeys = tutorRows
    .map((row) => row.key)
    .filter((key): key is string => Boolean(key));
  const keysByLower = new Map<string, string[]>();
  for (const key of tutorKeys) {
    const lower = key.toLocaleLowerCase("en-US");
    keysByLower.set(lower, [...(keysByLower.get(lower) ?? []), key]);
  }

  const mapped: Array<{ key: string; tutor: LedgerTutor }> = [];
  const flagged: Array<{ name: string; reason: string }> = [];
  const claimed = new Map<string, string>();

  for (const tutor of ledgerTutors) {
    if (!tutor.nickname) {
      flagged.push({ name: tutor.onsiteName, reason: "the ledger name has no (nickname) to match on" });
      continue;
    }
    const matches = keysByLower.get(tutor.nickname) ?? [];
    if (matches.length === 0) {
      flagged.push({
        name: tutor.onsiteName,
        reason: `nickname "${tutor.nickname}" matches no tutor key (${tutor.rowCount} ledger rows)`,
      });
      continue;
    }
    if (matches.length > 1) {
      flagged.push({
        name: tutor.onsiteName,
        reason: `nickname "${tutor.nickname}" matches ${matches.length} tutor keys: ${matches.join(", ")}`,
      });
      continue;
    }
    const key = matches[0];
    const already = claimed.get(key);
    if (already) {
      flagged.push({ name: tutor.onsiteName, reason: `${key} is already claimed by "${already}"` });
      continue;
    }
    claimed.set(key, tutor.onsiteName);
    mapped.push({ key, tutor });

    if (commit) {
      await upsertPayoutTutorName(db, {
        canonicalKey: key,
        onsiteName: tutor.onsiteName,
        onlineName: tutor.onlineName,
        active: true,
        updatedByEmail: email,
      });
    }
  }

  console.log(`MAPPED (${mapped.length})`);
  for (const { key, tutor } of mapped.toSorted((a, b) => a.key.localeCompare(b.key))) {
    console.log(`  ${key.padEnd(14)} ${tutor.onsiteName}${tutor.onlineName ? "  (+ Online)" : "  (no Online twin)"}`);
  }

  console.log(`\nFLAGGED (${flagged.length}) — nothing written for these`);
  for (const item of flagged) console.log(`  ${item.name}\n      ${item.reason}`);

  if (orphanOnline.length > 0) {
    console.log(`\nONLINE NAMES WITH NO ONSITE TWIN (${orphanOnline.length})`);
    for (const name of orphanOnline) console.log(`  ${name}`);
  }

  const unmapped = tutorKeys.filter((key) => !claimed.has(key)).toSorted();
  console.log(`\nTUTOR KEYS WITH NO LEDGER NAME (${unmapped.length})`);
  console.log(unmapped.length ? `  ${unmapped.join(", ")}` : "  (none)");

  if (!commit) console.log("\nDry run — nothing was written. Re-run with --commit.");
  console.log(`\nMappings currently in the database: ${(await loadPayoutTutorNames(db)).size}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
