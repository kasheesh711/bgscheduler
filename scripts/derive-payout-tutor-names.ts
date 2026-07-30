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

import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { lockPostClassFinance } from "@/lib/post-class-feedback/finance-lock";
import { requirePayoutGoogleTarget } from "@/lib/post-class-feedback/payout-config";
import { parseMasterPayoutSheet } from "@/lib/post-class-feedback/payout-master";
import {
  loadPayoutTutorNames,
  upsertPayoutTutorName,
} from "@/lib/post-class-feedback/payout-repository";
import {
  isExplicitlyUnassignedPayoutLedgerIdentity,
  isPayoutTutorBlockedUntilLedgerIdentity,
  REVIEWED_PAYOUT_TUTOR_MAPPINGS,
} from "@/lib/post-class-feedback/payout-tutor-mapping";
import { withPostClassTransaction } from "@/lib/post-class-feedback/transaction";
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
  primaryLedgerName: string;
  alternateLedgerName: string | null;
  nickname: string | null;
  rowCount: number;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: npm run payout:derive-tutor-names --"
      + " [--email finance@example.com] [--commit]",
    );
    return;
  }
  loadEnvFile(path.resolve(process.cwd(), ".env.local"));

  const commit = process.argv.includes("--commit");
  const target = requirePayoutGoogleTarget();
  const email = (optionValue("--email") ?? target.connectedEmail).toLowerCase();
  const db = getDb();

  console.log(`Connected account: ${email}`);
  console.log(`Source tab:        ${target.sourceSheetName}`);
  console.log(commit ? "Mode:              COMMIT\n" : "Mode:              dry run (pass --commit to write)\n");

  const grid = await fetchGoogleSheetRows(
    email,
    target.masterSpreadsheetId,
    target.sourceSheetName,
  );
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
  const primaryLedgerNames = [...counts.keys()].filter((name) => !name.endsWith(ONLINE_SUFFIX));
  const ledgerTutors: LedgerTutor[] = primaryLedgerNames.map((primaryLedgerName) => ({
    primaryLedgerName,
    alternateLedgerName: counts.has(`${primaryLedgerName}${ONLINE_SUFFIX}`)
      ? `${primaryLedgerName}${ONLINE_SUFFIX}`
      : null,
    nickname: parenthesisedNickname(primaryLedgerName),
    rowCount: (counts.get(primaryLedgerName) ?? 0)
      + (counts.get(`${primaryLedgerName}${ONLINE_SUFFIX}`) ?? 0),
  })).toSorted((a, b) => a.primaryLedgerName.localeCompare(b.primaryLedgerName));

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
  const flagged: Array<{ name: string; reason: string; expectedExclusion?: boolean }> = [];
  const claimed = new Map<string, string>();
  const reviewedNames = new Set<string>();
  for (const override of REVIEWED_PAYOUT_TUTOR_MAPPINGS) {
    reviewedNames.add(override.primaryLedgerName);
    if (override.alternateLedgerName) {
      reviewedNames.add(override.alternateLedgerName);
    }
  }
  for (const name of orphanOnline) {
    if (reviewedNames.has(name)) continue;
    const explicitlyUnassigned = isExplicitlyUnassignedPayoutLedgerIdentity(name);
    flagged.push({
      name,
      reason: explicitlyUnassigned
        ? "explicitly unassigned online-only identity: no reviewed canonical key exists"
        : "unreviewed online-only ledger identity requires an explicit canonical-key decision",
      expectedExclusion: explicitlyUnassigned,
    });
  }

  for (const override of REVIEWED_PAYOUT_TUTOR_MAPPINGS) {
    const keyMatches = keysByLower.get(
      override.canonicalKey.toLocaleLowerCase("en-US"),
    ) ?? [];
    if (keyMatches.length !== 1) {
      flagged.push({
        name: override.primaryLedgerName,
        reason: `reviewed key "${override.canonicalKey}" resolves to ${keyMatches.length} live keys`,
      });
      continue;
    }
    if (!counts.has(override.primaryLedgerName)) {
      flagged.push({
        name: override.primaryLedgerName,
        reason: "reviewed exact ledger identity is absent from the source",
      });
      continue;
    }
    const alternate = override.alternateLedgerName
      && counts.has(override.alternateLedgerName)
      ? override.alternateLedgerName
      : null;
    const tutor: LedgerTutor = {
      primaryLedgerName: override.primaryLedgerName,
      alternateLedgerName: alternate,
      nickname: parenthesisedNickname(override.primaryLedgerName),
      rowCount: (counts.get(override.primaryLedgerName) ?? 0)
        + (alternate ? counts.get(alternate) ?? 0 : 0),
    };
    claimed.set(keyMatches[0], override.primaryLedgerName);
    mapped.push({ key: keyMatches[0], tutor });
  }

  for (const tutor of ledgerTutors) {
    if (reviewedNames.has(tutor.primaryLedgerName)
      || (tutor.alternateLedgerName
        && reviewedNames.has(tutor.alternateLedgerName))) {
      continue;
    }
    if (isExplicitlyUnassignedPayoutLedgerIdentity(tutor.primaryLedgerName)) {
      flagged.push({
        name: tutor.primaryLedgerName,
        reason: "explicitly unassigned: no reviewed canonical key exists",
        expectedExclusion: true,
      });
      continue;
    }
    if (!tutor.nickname) {
      flagged.push({
        name: tutor.primaryLedgerName,
        reason: "the ledger name has no (nickname) to match on",
      });
      continue;
    }
    const matches = keysByLower.get(tutor.nickname) ?? [];
    if (matches.length === 0) {
      flagged.push({
        name: tutor.primaryLedgerName,
        reason: `nickname "${tutor.nickname}" matches no tutor key (${tutor.rowCount} ledger rows)`,
      });
      continue;
    }
    if (matches.length > 1) {
      flagged.push({
        name: tutor.primaryLedgerName,
        reason: `nickname "${tutor.nickname}" matches ${matches.length} tutor keys: ${matches.join(", ")}`,
      });
      continue;
    }
    const key = matches[0];
    if (isPayoutTutorBlockedUntilLedgerIdentity(key)) {
      flagged.push({
        name: tutor.primaryLedgerName,
        reason: `${key} is explicitly blocked until finance reviews an exact ledger identity`,
        expectedExclusion: true,
      });
      continue;
    }
    const already = claimed.get(key);
    if (already) {
      flagged.push({
        name: tutor.primaryLedgerName,
        reason: `${key} is already claimed by "${already}"`,
      });
      continue;
    }
    claimed.set(key, tutor.primaryLedgerName);
    mapped.push({ key, tutor });
  }

  // The two database indexes are individually unique, but a primary on one
  // row must also never equal an alternate on another row.
  const allNames = new Map<string, string>();
  for (const { key, tutor } of mapped) {
    for (const name of [
      tutor.primaryLedgerName,
      tutor.alternateLedgerName,
    ].filter((value): value is string => Boolean(value))) {
      const owner = allNames.get(name);
      if (owner && owner !== key) {
        throw new Error(`Ledger identity "${name}" is claimed by both ${owner} and ${key}.`);
      }
      allNames.set(name, key);
    }
  }

  const unexpectedFlags = flagged.filter((item) => !item.expectedExclusion);
  if (commit && unexpectedFlags.length === 0) {
    // Reconcile the reviewed set atomically. A prior mapping for an explicitly
    // blocked or unassigned tutor must not remain active merely because this
    // run declined to upsert it.
    await withPostClassTransaction(db, async (tx) => {
      // A mapping identity participates in the preview token and determines
      // the exact tutor name written to Google. Serialize mapping commits with
      // payout claims/finalizers so neither can observe a half-reconciled set.
      await lockPostClassFinance(tx as unknown as Database);
      await tx.update(schema.postClassPayoutTutorNames).set({
        active: false,
        updatedByEmail: email,
        updatedAt: new Date(),
      });
      for (const { key, tutor } of mapped) {
        await upsertPayoutTutorName(tx as unknown as Database, {
          canonicalKey: key,
          primaryLedgerName: tutor.primaryLedgerName,
          alternateLedgerName: tutor.alternateLedgerName,
          active: true,
          updatedByEmail: email,
        });
      }
      await tx.insert(schema.postClassConfigAuditLog).values({
        entityType: "payout_tutor_mapping",
        entityKey: target.environmentTarget,
        action: "reviewed_mapping_commit",
        actorEmail: email,
        beforeValue: null,
        afterValue: {
          masterSpreadsheetId: target.masterSpreadsheetId,
          sourceSheetName: target.sourceSheetName,
          mappings: mapped.map(({ key, tutor }) => ({
            canonicalKey: key,
            primaryLedgerName: tutor.primaryLedgerName,
            alternateLedgerName: tutor.alternateLedgerName,
            sourceRowCount: tutor.rowCount,
          })),
          expectedExclusions: flagged
            .filter((item) => item.expectedExclusion)
            .map((item) => ({ name: item.name, reason: item.reason })),
        },
        note: "Exact source-ledger identities reviewed and reconciled; no names were synthesized.",
      });
    });
  }

  console.log(`MAPPED (${mapped.length})`);
  for (const { key, tutor } of mapped.toSorted((a, b) => a.key.localeCompare(b.key))) {
    console.log(
      `  ${key.padEnd(14)} ${tutor.primaryLedgerName}`
      + `${tutor.alternateLedgerName ? `  (+ ${tutor.alternateLedgerName})` : "  (one identity)"}`,
    );
  }

  console.log(`\nFLAGGED (${flagged.length}) — nothing written for these`);
  for (const item of flagged) {
    console.log(
      `  ${item.name}${item.expectedExclusion ? " [expected exclusion]" : ""}`
      + `\n      ${item.reason}`,
    );
  }

  const unreviewedOrphanOnline = orphanOnline.filter((name) => !reviewedNames.has(name));
  if (unreviewedOrphanOnline.length > 0) {
    console.log(
      `\nUNREVIEWED ONLINE-ONLY LEDGER IDENTITIES (${unreviewedOrphanOnline.length})`,
    );
    for (const name of unreviewedOrphanOnline) console.log(`  ${name}`);
  }

  const unmapped = tutorKeys.filter((key) => !claimed.has(key)).toSorted();
  console.log(`\nTUTOR KEYS WITH NO LEDGER NAME (${unmapped.length})`);
  console.log(unmapped.length ? `  ${unmapped.join(", ")}` : "  (none)");

  if (commit && unexpectedFlags.length > 0) {
    throw new Error(
      `${unexpectedFlags.length} unexpected identity mapping(s) remain flagged; nothing was written.`,
    );
  }
  if (!commit) console.log("\nDry run — nothing was written. Re-run with --commit.");
  console.log(`\nMappings currently in the database: ${(await loadPayoutTutorNames(db)).size}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
