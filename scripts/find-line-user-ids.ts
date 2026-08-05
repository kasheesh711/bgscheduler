import { loadEnvConfig } from "@next/env";
import { and, desc, eq, gte, ilike } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";

loadEnvConfig(process.cwd());

/** Reads a `--flag=value` CLI arg, returning `fallback` when absent. */
function parseArgValue(flag: string, fallback: string): string {
  const prefix = `--${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

interface HarvestedMessage {
  displayName: string | null;
  lineUserId: string;
  text: string | null;
  eventTimestamp: Date | null;
}

/**
 * Finds inbound LINE DMs whose text contains `matchText`, sent within the last
 * `sinceDays` days. Read-only: issues a single SELECT, never writes.
 */
async function findOnboardingMessages(
  db: Database,
  matchText: string,
  sinceDays: number,
): Promise<HarvestedMessage[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  return db
    .select({
      displayName: schema.lineContacts.displayName,
      lineUserId: schema.lineContacts.lineUserId,
      text: schema.lineMessages.text,
      eventTimestamp: schema.lineMessages.eventTimestamp,
    })
    .from(schema.lineMessages)
    .innerJoin(schema.lineContacts, eq(schema.lineMessages.contactId, schema.lineContacts.id))
    .where(and(
      eq(schema.lineMessages.direction, "inbound"),
      gte(schema.lineMessages.eventTimestamp, since),
      ilike(schema.lineMessages.text, `%${matchText}%`),
    ))
    .orderBy(desc(schema.lineMessages.eventTimestamp));
}

async function main() {
  const matchText = parseArgValue("match", "BGSCHED");
  const sinceDays = Number(parseArgValue("since", "7")) || 7;

  const rows = await findOnboardingMessages(getDb(), matchText, sinceDays);

  if (rows.length === 0) {
    console.log(`No inbound LINE messages matching "${matchText}" in the last ${sinceDays} day(s).`);
    return;
  }

  for (const row of rows) {
    console.log(
      `${row.displayName ?? "(no name)"} | ${row.lineUserId} | ${row.text ?? ""} | ${row.eventTimestamp?.toISOString() ?? ""}`,
    );
  }

  console.log("");
  const uniqueIds = [...new Set(rows.map((row) => row.lineUserId))];
  console.log(uniqueIds.join(","));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
