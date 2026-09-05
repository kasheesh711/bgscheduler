import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "@/lib/db/schema";
import path from "path";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

interface Handle {
  db: TestDb;
  pool: Pool;
  /** Null when the suite is pointed at an external Postgres via TEST_DATABASE_URL. */
  container: StartedPostgreSqlContainer | null;
}

export async function startTestDb(): Promise<Handle> {
  // TEST_DATABASE_URL points the suite at an already-running Postgres instead
  // of a container. Docker is the default because it guarantees a clean server;
  // this escape hatch exists for machines without a running daemon. The target
  // is migrated and truncated like any container, so it must be a scratch
  // database — never a database holding data anyone wants to keep.
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  const container = externalUrl
    ? null
    : await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("bgscheduler_test")
      .withUsername("test")
      .withPassword("test")
      .start();

  const pool = new Pool({ connectionString: externalUrl || container!.getConnectionUri() });
  const db = drizzle(pool, { schema });

  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "../../../drizzle"),
  });

  return { db, pool, container };
}

export async function stopTestDb(h: Handle): Promise<void> {
  await h.pool.end();
  await h.container?.stop();
}

/**
 * Truncate every data table between tests. Schema (enums, indexes) preserved.
 * Order does not matter because CASCADE follows FK chains.
 */
export async function truncateAll(db: TestDb): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      room_utilization_sessions,
      data_issues,
      snapshot_stats,
      classroom_assignment_rows,
      classroom_assignment_runs,
      classroom_rooms,
      future_session_blocks,
      past_session_blocks,
      dated_leaves,
      recurring_availability_windows,
      raw_teacher_tags,
      subject_level_qualifications,
      tutors,
      tutor_identity_group_members,
      tutor_identity_groups,
      tutor_aliases,
      tutor_contacts,
      tutor_wise_accounts,
      tutor_contact_sync_events,
      wise_teacher_availability_cache,
      admin_users,
      sync_runs,
      snapshots,
      post_class_payout_roll_outcomes,
      post_class_payout_roll_runs,
      post_class_payout_exceptions,
      post_class_payout_adjustments,
      post_class_payout_run_lines,
      post_class_payout_runs,
      post_class_payout_tutor_names,
      post_class_tutor_payout_sheets,
      post_class_config_audit_log,
      post_class_deduction_offsets,
      post_class_deduction_actions,
      post_class_deductions,
      post_class_finance_periods,
      post_class_source_issues,
      post_class_assessments,
      post_class_feedback_event_links,
      post_class_feedback_versions,
      post_class_session_participants,
      post_class_sessions,
      post_class_sync_runs
    RESTART IDENTITY CASCADE
  `);
}
