import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pg from "pg";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "ADMISSIONS_EMAIL_FROM",
  "ADMISSIONS_EMAIL_REPLY_TO",
  "NEXT_PUBLIC_APP_URL",
];
const MIGRATIONS = [
  "0050_slim_proemial_gods.sql",
  "0051_foamy_kabuki.sql",
  "0052_light_namor.sql",
  "0053_nosy_spectrum.sql",
  "0054_admissions_test_status_backfill.sql",
];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

function pass(message) {
  process.stdout.write(`PASS: ${message}\n`);
}

function warn(message) {
  process.stdout.write(`WARN: ${message}\n`);
}

for (const name of REQUIRED_ENV) {
  if (!process.env[name]?.trim()) fail(`${name} is missing or blank`);
  else pass(`${name} is configured`);
}

if (process.env.ADMISSIONS_EMAIL_FROM?.includes("onboarding@resend.dev")) {
  fail("ADMISSIONS_EMAIL_FROM still uses the Resend development sender");
}
if (process.env.ADMISSIONS_EMAIL_REPLY_TO === "kevhsh7@gmail.com") {
  warn("ADMISSIONS_EMAIL_REPLY_TO still uses the development fallback; confirm it is monitored");
}

if (!process.env.DATABASE_URL?.trim()) process.exit(1);

const hashes = new Map();
for (const filename of MIGRATIONS) {
  const sql = await readFile(path.join(process.cwd(), "drizzle", filename), "utf8");
  hashes.set(createHash("sha256").update(sql).digest("hex"), filename);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const migrationResult = await pool.query(
    "select hash, created_at from drizzle.__drizzle_migrations order by created_at",
  );
  const duplicateAcademicKeys = await pool.query(`
    select case_id, system, effective_date, count(*)::int as count
    from admissions_academic_records
    group by case_id, system, effective_date
    having count(*) > 1
    limit 10
  `);
  if (duplicateAcademicKeys.rowCount > 0) {
    fail(`${duplicateAcademicKeys.rowCount} duplicate academic-record key(s) would block migration 0053`);
  } else {
    pass("academic-record keys are compatible with migration 0053 uniqueness");
  }
  const installed = new Set(migrationResult.rows.map((row) => row.hash));
  let allRequiredMigrationsInstalled = true;
  for (const [hash, filename] of hashes) {
    if (installed.has(hash)) pass(`migration ${filename} is installed`);
    else {
      allRequiredMigrationsInstalled = false;
      fail(`migration ${filename} is absent; run npm run db:migrate before deploying code`);
    }
  }

  const runResult = await pool.query(`
    select status, run_type, started_at, finished_at, sent_count, skipped_count, error_summary
    from admissions_notification_runs
    order by started_at desc
    limit 1
  `);
  const latestRun = runResult.rows[0];
  if (!latestRun) {
    warn("no admissions notification run exists yet; trigger and verify one before opening portals");
  } else if (latestRun.status !== "success") {
    fail(`latest admissions notification run is ${latestRun.status}`);
  } else {
    pass(`latest ${latestRun.run_type} admissions notification run succeeded at ${latestRun.finished_at ?? latestRun.started_at}`);
  }

  if (allRequiredMigrationsInstalled) {
    const outboxResult = await pool.query(`
      select status, count(*)::int as count
      from admissions_notification_outbox
      group by status
      order by status
    `);
    const failed = outboxResult.rows.find((row) => row.status === "failed")?.count ?? 0;
    if (failed > 0) warn(`${failed} notification outbox row(s) are awaiting retry or operator review`);
    else pass("notification outbox has no failed rows");

    const portalResult = await pool.query(`
      select count(*)::int as count
      from admissions_cases
      where family_portal_open = true and deleted_at is null
    `);
    const openPortals = portalResult.rows[0]?.count ?? 0;
    if (openPortals > 0) warn(`${openPortals} family portal(s) are already open; use the staged rollout runbook`);
    else pass("all family portals are closed for staged rollout");
  } else {
    warn("outbox and family-portal state checks were skipped until migrations 0053–0054 are installed");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "production readiness query failed");
} finally {
  await pool.end();
}

if (process.exitCode) process.exit(process.exitCode);
