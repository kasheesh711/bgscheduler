import { and, eq, inArray, lt, or } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { classroomAdminEmailRuns as runs, classroomAdminEmailRecipients as recipients } from "@/lib/db/schema";

export const ADMIN_EMAIL_LEASE_MS = 10 * 60_000;

/** The unique date key plus an atomic UPSERT elects one sender. updatedAt fences this attempt. */
export async function claimAdminEmailRun(db: Database, input: {
  assignmentDate: string; assignmentRunId: string | null; subject: string;
  triggerKind: "ready" | "failure"; now: Date;
}) {
  const { now, ...content } = input;
  const values = { ...content, status: "running", updatedAt: now, lastError: null };
  const [run] = await db.insert(runs).values({
    ...values, idempotencyKey: `classroom-admin:${input.assignmentDate}`,
    createdBy: "cron@classroom-admin-email",
  }).onConflictDoUpdate({
    target: runs.idempotencyKey,
    set: values,
    setWhere: or(inArray(runs.status, ["failed", "partial"]), and(
      inArray(runs.status, ["running", "pending"]),
      lt(runs.updatedAt, new Date(now.getTime() - ADMIN_EMAIL_LEASE_MS)),
    )),
  }).returning();
  return run ?? null;
}

export function adminEmailClaimPredicate(id: string, claimedAt: Date) {
  return and(eq(runs.id, id), eq(runs.status, "running"), eq(runs.updatedAt, claimedAt));
}

export async function assertAdminEmailClaim(db: Database, id: string, claimedAt: Date, now: Date) {
  // Leave more than the relay's 20-second request timeout before another worker can reclaim.
  if (now.getTime() - claimedAt.getTime() >= ADMIN_EMAIL_LEASE_MS - 30_000) throw new Error("Admin email attempt lease expired");
  const [run] = await db.select({ id: runs.id }).from(runs).where(adminEmailClaimPredicate(id, claimedAt)).limit(1);
  if (!run) throw new Error("Admin email attempt no longer owns the delivery claim");
}

export async function sentAdminRecipients(db: Database, emailRunId: string): Promise<Set<string>> {
  const sent = await db.select({ email: recipients.recipientEmail }).from(recipients)
    .where(and(eq(recipients.emailRunId, emailRunId), eq(recipients.status, "sent")));
  return new Set(sent.map(row => row.email.trim().toLowerCase()));
}
