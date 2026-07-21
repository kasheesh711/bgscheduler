import "server-only";

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

let writePool: Pool | null = null;

function isNeonHttpTransactionUnsupported(error: unknown): boolean {
  return error instanceof Error && /No transactions support in neon-http driver/i.test(error.message);
}

function getWritePool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  writePool ??= new Pool({ connectionString: databaseUrl, max: 1 });
  return writePool;
}

/**
 * Runs a feature write atomically. Production uses the Neon HTTP driver for
 * reads, so transaction-only workflows transparently fall back to one pooled
 * node-postgres connection.
 */
export async function withPostClassTransaction<T>(
  db: Database,
  callback: (tx: Database) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction((tx) => callback(tx as unknown as Database));
  } catch (error) {
    if (!isNeonHttpTransactionUnsupported(error)) throw error;
  }

  const client = await getWritePool().connect();
  try {
    await client.query("BEGIN");
    const tx = drizzleNodePostgres(client, { schema }) as unknown as Database;
    const result = await callback(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
