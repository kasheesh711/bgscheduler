// Test-only preload for a real Next server backed by disposable local Postgres.
// The production database driver remains Neon HTTP. Never use this on a deployment.
const url = new URL(process.env.TEST_DATABASE_URL || "invalid:");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
  throw new Error("Room browser preload requires a disposable localhost TEST_DATABASE_URL ending in _test");
}
const { Pool } = require("pg");
const { drizzle } = require("drizzle-orm/node-postgres");
globalThis.__bgscheduler_db = drizzle(new Pool({ connectionString: url.toString(), max: 4 }));
