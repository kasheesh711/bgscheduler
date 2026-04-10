import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const sql = neon(databaseUrl);
  return drizzle({ client: sql, schema });
}

type DbInstance = ReturnType<typeof createDb>;

declare global {
  // eslint-disable-next-line no-var
  var __bgscheduler_db: DbInstance | undefined;
}

/** Get or create the DB singleton (survives HMR in dev). */
export function getDb(): DbInstance {
  if (!globalThis.__bgscheduler_db) {
    globalThis.__bgscheduler_db = createDb();
  }
  return globalThis.__bgscheduler_db;
}

export type Database = ReturnType<typeof getDb>;
