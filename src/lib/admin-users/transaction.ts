import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

declare global {
  var __bgscheduler_adminAccessPool: Pool | undefined;
}

/** Neon HTTP reads need a pg client for atomic account updates and audit writes. */
export async function withAdminAccessTransaction<T>(db: Database, callback: (tx: Database) => Promise<T>): Promise<T> {
  try {
    return await db.transaction((tx) => callback(tx as unknown as Database));
  } catch (error) {
    if (!(error instanceof Error && /No transactions support in neon-http driver/i.test(error.message))) throw error;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = globalThis.__bgscheduler_adminAccessPool ??= new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(drizzle(client, { schema }) as unknown as Database);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
