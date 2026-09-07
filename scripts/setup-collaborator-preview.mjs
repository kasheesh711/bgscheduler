#!/usr/bin/env node
/** Owner-only, one-time seed of an empty preview database from current snapshots.
 * SOURCE_DATABASE_URL stays read-only. PREVIEW_DATABASE_URL must use a distinct,
 * restricted role and a bgscheduler_*_preview_* database. No credentials or rows
 * are printed. Create a fresh database for refreshes; existing snapshots are refused.
 */
import pg from "pg";

// Keep SQL calendar dates as dates, independent of the operator's timezone.
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1114, (value) => value);

const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const previewUrl = process.env.PREVIEW_DATABASE_URL;
if (!sourceUrl || !previewUrl) throw new Error("SOURCE_DATABASE_URL and PREVIEW_DATABASE_URL are required");
const sourceLocation = new URL(sourceUrl);
const previewLocation = new URL(previewUrl);
if (!/^\/bgscheduler_[a-z0-9_]+_preview_[a-z0-9_]+$/.test(previewLocation.pathname)
    || sourceLocation.pathname === previewLocation.pathname
    || sourceLocation.username === previewLocation.username) {
  throw new Error("Refusing a destination without a separate preview database and role");
}

const source = new pg.Client({ connectionString: sourceUrl });
const preview = new pg.Client({ connectionString: previewUrl });
const selectors = new Map();
const add = (table, where = "true") => selectors.set(table, where);
const sourceSnapshots = "select id from snapshots where active = true";
const creditSnapshots = "select id from credit_control_snapshots where active = true";
const financeSnapshots = "select id from unearned_revenue_snapshots where active = true";

for (const table of ["admin_users", "tutor_aliases", "tutor_contacts", "tutor_business_profiles",
  "tutor_wise_accounts", "classroom_rooms", "classroom_tutor_room_profiles",
  "learning_plan_access_grants", "post_class_access_grants", "unearned_revenue_access_grants",
  "sales_dashboard_sources", "sales_dashboard_projection_sources"]) add(table);
add("snapshots", "active = true");
for (const table of ["sync_runs", "snapshot_stats", "tutor_identity_groups", "tutor_identity_group_members",
  "tutors", "raw_teacher_tags", "subject_level_qualifications", "recurring_availability_windows",
  "dated_leaves", "future_session_blocks", "data_issues"]) add(table, `snapshot_id in (${sourceSnapshots})`);
add("credit_control_snapshots", "active = true");
for (const table of ["credit_control_students", "credit_control_packages", "credit_control_sessions",
  "credit_control_credit_history"]) add(table, `snapshot_id in (${creditSnapshots})`);
add("unearned_revenue_sync_runs", `id in (select sync_run_id from unearned_revenue_snapshots where active = true)`);
add("unearned_revenue_snapshots", "active = true");
for (const table of ["unearned_revenue_periods", "unearned_revenue_student_periods", "unearned_revenue_account_periods",
  "unearned_revenue_lot_periods", "unearned_revenue_package_periods"]) add(table, `snapshot_id in (${financeSnapshots})`);
const salesRuns = "select last_successful_import_run_id from sales_dashboard_sources";
const projectionRuns = "select last_successful_import_run_id from sales_dashboard_projection_sources";
add("sales_dashboard_import_runs", `id in (${salesRuns})`);
for (const table of ["sales_dashboard_normal_rows", "sales_dashboard_additional_rows"]) add(table, `import_run_id in (${salesRuns})`);
add("sales_dashboard_projection_import_runs", `id in (${projectionRuns})`);
add("sales_dashboard_projection_months", `import_run_id in (${projectionRuns})`);

try {
  await source.connect();
  await preview.connect();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await source.query("SET LOCAL statement_timeout = '120s'");
  const role = (await preview.query("select current_user as role")).rows[0].role;
  const isolation = (await source.query(`select exists(
    select 1 from pg_tables where schemaname='public'
    and (has_table_privilege($1,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT')
      or has_table_privilege($1,quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE'))
  ) as has_production_access`, [role])).rows[0];
  if (isolation.has_production_access) throw new Error("Preview role has production data privileges");

  const sourceColumns = (await source.query(`select table_name,column_name from information_schema.columns
    where table_schema='public' order by table_name,ordinal_position`)).rows;
  const previewColumns = (await preview.query(`select table_name,column_name from information_schema.columns
    where table_schema='public' order by table_name,ordinal_position`)).rows;
  const columns = new Map();
  for (const row of sourceColumns) {
    if (!selectors.has(row.table_name)) continue;
    if (!previewColumns.some((target) => target.table_name === row.table_name && target.column_name === row.column_name)) continue;
    columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
  }
  for (const table of selectors.keys()) {
    if (!columns.has(table)) throw new Error(`Missing required source/destination table ${table}`);
  }
  const dependencies = (await source.query(`select child.relname as child,parent.relname as parent
    from pg_constraint c join pg_class child on child.oid=c.conrelid join pg_class parent on parent.oid=c.confrelid
    where c.contype='f' and c.connamespace='public'::regnamespace`)).rows;
  const order = [];
  const pending = new Set(selectors.keys());
  while (pending.size) {
    const ready = [...pending].filter((table) => !dependencies.some((edge) => edge.child === table && edge.parent !== table && pending.has(edge.parent)));
    if (!ready.length) throw new Error("Preview seed has a dependency cycle");
    for (const table of ready) { order.push(table); pending.delete(table); }
  }
  console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "apply" : "inspect", tables: order, isolatedRole: role }));
  if (!process.argv.includes("--apply")) process.exitCode = 0;
  else {
    await preview.query("BEGIN");
    for (const table of ["snapshots", "credit_control_snapshots", "unearned_revenue_snapshots"]) {
      if ((await preview.query(`select 1 from ${quote(table)} limit 1`)).rowCount) throw new Error("Destination already contains snapshots; provision a fresh preview DB for a refresh");
    }
    // Migrations create room IDs and initial grants. Replace only those reference
    // defaults in this fresh database so copied foreign keys retain source IDs.
    if ((await preview.query("select 1 from classroom_tutor_room_profiles limit 1")).rowCount) {
      throw new Error("Destination already contains room profiles; provision a fresh preview DB");
    }
    for (const table of ["classroom_rooms", "learning_plan_access_grants", "post_class_access_grants", "unearned_revenue_access_grants"]) {
      await preview.query(`delete from ${quote(table)}`);
    }
    for (const table of order) {
      const selectedColumns = columns.get(table).map(quote).join(",");
      await source.query(`DECLARE preview_seed_cursor NO SCROLL CURSOR FOR select ${selectedColumns} from ${quote(table)} where ${selectors.get(table)}`);
      let count = 0;
      while (true) {
        const rows = (await source.query("FETCH 250 FROM preview_seed_cursor")).rows;
        if (!rows.length) break;
        await preview.query(`insert into ${quote(table)} (${selectedColumns})
          select ${selectedColumns} from json_populate_recordset(null::${quote(table)},$1::json) on conflict do nothing`, [JSON.stringify(rows)]);
        count += rows.length;
        if (count > 500_000) throw new Error(`Unexpectedly large current snapshot: ${table}`);
      }
      await source.query("CLOSE preview_seed_cursor");
      console.log(JSON.stringify({ table, rows: count }));
    }
    for (const table of ["google_oauth_tokens", "student_schedule_links", "line_oa_resolver_runs"]) {
      if ((await preview.query(`select 1 from ${quote(table)} limit 1`)).rowCount) throw new Error(`Credential-bearing table is not empty: ${table}`);
    }
    await preview.query("COMMIT");
    console.log(JSON.stringify({ seeded: true, credentialsCopied: false }));
  }
} catch (error) {
  await preview.query("ROLLBACK").catch(() => {});
  // Driver messages can include row contents. Keep the operator log credential/data free.
  console.error(JSON.stringify({ failed: true, code: error?.code ?? null, table: error?.table, constraint: error?.constraint, message: error?.code ? "Database operation failed; transaction rolled back" : error.message }));
  process.exitCode = 1;
} finally {
  await source.query("ROLLBACK").catch(() => {});
  await source.end().catch(() => {});
  await preview.end().catch(() => {});
}
