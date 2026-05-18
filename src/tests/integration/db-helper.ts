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
  container: StartedPostgreSqlContainer;
}

export async function startTestDb(): Promise<Handle> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("bgscheduler_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool, { schema });

  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "../../../drizzle"),
  });

  return { db, pool, container };
}

export async function stopTestDb(h: Handle): Promise<void> {
  await h.pool.end();
  await h.container.stop();
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
      admin_users,
      sync_runs,
      snapshots
    RESTART IDENTITY CASCADE
  `);
}
