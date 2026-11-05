import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { theaWeekendJobs } from "@/lib/db/schema";
import { THEA_ACTOR_PREFIX, theaEnabled } from "./thea-config";

/** Only a live, group-bound command lease can publish while cron automation is paused. */
export async function theaPublishAllowed(db: Database, job: { createdBy: string | null; runId: string }) {
  if (!theaEnabled() || !job.createdBy?.startsWith(THEA_ACTOR_PREFIX)) return false;
  const id = job.createdBy.slice(THEA_ACTOR_PREFIX.length);
  if (!/^[a-f0-9-]{36}$/i.test(id)) return false;
  const [command] = await db.select({ id: theaWeekendJobs.id }).from(theaWeekendJobs).where(and(
    eq(theaWeekendJobs.id, id), eq(theaWeekendJobs.groupId, process.env.THEA_LINE_GROUP_ID!),
    eq(theaWeekendJobs.status, "running"), isNotNull(theaWeekendJobs.claimToken), gt(theaWeekendJobs.leaseExpiresAt, new Date()),
    sql`${theaWeekendJobs.runIds} @> ${JSON.stringify([job.runId])}::jsonb`,
  )).limit(1);
  return Boolean(command);
}
