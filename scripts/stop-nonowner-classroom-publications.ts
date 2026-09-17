/** Run with a private production env file. Read-only unless --apply is supplied. */
import { inArray, sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { adminUsers, classroomPublishJobs as jobs } from "../src/lib/db/schema";
import { stopNonOwnerClassroomPublications } from "../src/lib/classrooms/operations-shutdown";
import { CLASSROOM_OPERATIONS_OWNER, wiseClassroomAutomationEnabled } from "../src/lib/classrooms/operations-policy";
import { isSuperAdminEmail } from "../src/lib/admin-users/policy";

async function main() {
  const db = getDb();
  const [owner] = await db.select({ disabled: adminUsers.disabled }).from(adminUsers)
    .where(sql`lower(btrim(${adminUsers.email})) = ${CLASSROOM_OPERATIONS_OWNER}`).limit(1);
  if (!owner || owner.disabled || !isSuperAdminEmail(CLASSROOM_OPERATIONS_OWNER)) {
    throw new Error("Kevin must have current enabled owner access before restricting operations.");
  }
  if (wiseClassroomAutomationEnabled()) throw new Error("Disable Wise/classroom automation before closing publications.");
  const activeJobs = () => db.select({ id: jobs.id, runId: jobs.runId, status: jobs.status,
    createdBy: jobs.createdBy, startedAt: jobs.startedAt, updatedAt: jobs.updatedAt,
    successCount: jobs.successCount, completedCount: jobs.completedCount,
  }).from(jobs).where(inArray(jobs.status, ["pending", "running"]));
  const before = await activeJobs();
  const apply = process.argv.includes("--apply");
  const stopped = apply ? await stopNonOwnerClassroomPublications(db) : [];
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), applied: apply, before, stopped,
    after: apply ? await activeJobs() : before }, null, 2));
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error ? error.message : "Publication shutdown failed");
  process.exit(1);
});
