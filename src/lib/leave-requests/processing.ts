import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { todayBangkok } from "@/lib/room-capacity/dates";
import { LEAVE_NORMALIZATION_BUDGET_MS } from "./config";
import { LeaveNormalizationUnavailable, normalizeLeave, type normalizationInput } from "./normalization";

/** Each result commits before another batch starts. A killed route resumes here. */
export async function processLeaveNormalizations(db: Database, options: { budgetMs?: number; normalize?: typeof normalizeLeave; now?: Date; retryFailures?: boolean } = {}) {
  const started = Date.now();
  const now = options.now ?? new Date();
  const today = todayBangkok(now);
  const work = await db.select({ revision: s.leaveNormalizations, endDate: s.leaveRequests.endDate, startDate: s.leaveRequests.startDate })
    .from(s.leaveNormalizations).innerJoin(s.leaveRequests, and(eq(s.leaveRequests.id, s.leaveNormalizations.requestId), eq(s.leaveRequests.currentNormalizationKey, s.leaveNormalizations.inputKey)))
    .where(and(inArray(s.leaveNormalizations.status, ["pending", "failed"]), options.retryFailures ? undefined : or(sql`${s.leaveNormalizations.nextAttemptAt} is null`, lte(s.leaveNormalizations.nextAttemptAt, now))));
  work.sort((a, b) => Number(!!a.endDate && a.endDate < today) - Number(!!b.endDate && b.endDate < today) || (a.startDate ?? today).localeCompare(b.startDate ?? today) || a.revision.createdAt.getTime() - b.revision.createdAt.getTime());
  let processed = 0;
  let failed = 0;
  let serviceError: string | null = null;
  const budget = options.budgetMs ?? LEAVE_NORMALIZATION_BUDGET_MS;
  for (let offset = 0; offset < work.length && Date.now() - started < budget; offset += 3) {
    const results = await Promise.allSettled(work.slice(offset, offset + 3).map(async ({ revision }) => {
      try {
        const result = await (options.normalize ?? normalizeLeave)(revision.input as ReturnType<typeof normalizationInput>);
        await db.update(s.leaveNormalizations).set({ status: "ok", result, error: null, attempts: revision.attempts + 1, completedAt: new Date(), nextAttemptAt: null }).where(eq(s.leaveNormalizations.id, revision.id));
        await db.update(s.leaveRequests).set({ normalizationStatus: "ok", normalizationError: null }).where(and(eq(s.leaveRequests.id, revision.requestId), eq(s.leaveRequests.currentNormalizationKey, revision.inputKey)));
        processed++;
      } catch (error) {
        if (error instanceof LeaveNormalizationUnavailable) serviceError = error.message;
        const message = error instanceof Error ? error.message.slice(0, 1000) : "Leave interpretation failed.";
        await db.update(s.leaveNormalizations).set({ status: "failed", error: message, attempts: revision.attempts + 1, nextAttemptAt: new Date(Date.now() + Math.min(360, 15 * 2 ** Math.min(revision.attempts, 5)) * 60_000) }).where(eq(s.leaveNormalizations.id, revision.id));
        await db.update(s.leaveRequests).set({ normalizationStatus: "failed", normalizationError: message }).where(and(eq(s.leaveRequests.id, revision.requestId), eq(s.leaveRequests.currentNormalizationKey, revision.inputKey)));
        failed++;
      }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (serviceError) break;
  }
  return { processed, failed, remaining: work.length - processed - failed, serviceError };
}
