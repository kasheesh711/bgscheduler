import { drizzle } from "drizzle-orm/pg-proxy";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

/**
 * A database fake for unit tests: drizzle's proxy driver with a responder instead of Postgres. Every statement is
 * recorded; `rows` answers it (select results as arrays in select-field order, raw `execute` results as objects).
 */
export interface RecordedQuery {
  sql: string;
  params: unknown[];
  method: string;
}

export function fakeDb(rows: (query: RecordedQuery) => unknown[] = () => []): { db: Database; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const db = drizzle(async (sql, params, method) => {
    const query = { sql, params, method };
    queries.push(query);
    return { rows: rows(query) as never[] };
  }, { schema });
  return { db: db as unknown as Database, queries };
}

/** Select rows as the proxy driver expects them: one array per row, values in the select's field order. */
export function asRows(order: readonly string[], objects: ReadonlyArray<Record<string, unknown>>): unknown[][] {
  return objects.map((object) => order.map((key) => object[key] ?? null));
}
