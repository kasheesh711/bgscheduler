import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { getWiseTeacherUserId, type WiseTeacher } from "@/lib/wise/types";
import { assertCompleteRoster } from "./removal-safety";
import { resolveRemovalRoster } from "./removal";
import { readRemovalRoster } from "./removal-wise";

const accounts = schema.tutorOffboardingRunAccounts; const runs = schema.tutorOffboardingRuns;
/** Wise GET only. An applying run is interruptible after 20 min, beyond the apply route's 300s lifetime. */
export async function reconcileRemovalRuns(db: Database = getDb(), roster?: WiseTeacher[], now = new Date()): Promise<{ checked: number; settled: number; restored: number }> {
  const observedAt = roster ? now : new Date();
  const live = roster ?? await readRemovalRoster(); assertCompleteRoster(live);
  const identity = await resolveRemovalRoster(db, live);
  let checked = 0; let settled = 0; let restored = 0;
  await withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tutor_offboarding_reconcile'))`);
    const rows = await tx.select({ account: accounts, run: runs }).from(accounts).innerJoin(runs, eq(runs.id, accounts.runId))
      .where(and(eq(accounts.plan, "remove"), ne(runs.status, "previewed"), ne(runs.status, "expired")));
    const eligible = rows.filter(({ run, account }) => account.updatedAt.getTime() <= observedAt.getTime() && (run.status !== "applying" || (run.appliedAt !== null && now.getTime() - run.appliedAt.getTime() > 20 * 60_000)));
    const seen = new Set<string>();
    for (const { account } of eligible) {
      checked++;
      const present = live.some(t => t._id === account.wiseTeacherId || getWiseTeacherUserId(t) === account.wiseUserId);
      if (present && ["verified", "removed_manually"].includes(account.status)) {
        await tx.update(accounts).set({ status: "restored", updatedAt: now }).where(eq(accounts.id, account.id)); restored++;
      } else if (["sending", "sent", "unknown", "manual_required"].includes(account.status) && !(account.status === "manual_required" && present)) {
        await tx.update(accounts).set({ status: present ? "not_removed" : account.status === "manual_required" ? "removed_manually" : "verified", verifiedAt: now, updatedAt: now }).where(eq(accounts.id, account.id)); settled++;
      } else if (account.status === "planned") {
        await tx.update(accounts).set({ status: "skipped", skipReason: "Execution was interrupted before this account was sent.", updatedAt: now }).where(eq(accounts.id, account.id));
      } else if (["not_removed", "rejected"].includes(account.status) && !present) {
        // A previously uncertain request can settle later; it still never gets another POST.
        await tx.update(accounts).set({ status: "removed_manually", verifiedAt: now, updatedAt: now }).where(eq(accounts.id, account.id)); settled++;
      }
      seen.add(account.canonicalKey);
    }
    for (const key of seen) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tutor_offboarding_local:${key}`}))`);
      const history = await tx.select().from(accounts).where(and(eq(accounts.canonicalKey, key), eq(accounts.plan, "remove")));
      if (history.some(a => a.updatedAt.getTime() > observedAt.getTime())) continue;
      const state = eligible.find(({ account: a }) => a.canonicalKey === key && a.localStateBefore && ["verified", "removed_manually"].includes(a.status))?.account.localStateBefore;
      const liveGroup = identity.groups.find(g => g.canonicalKey === key);
      const anyPresent = history.some(a => live.some(t => t._id === a.wiseTeacherId || getWiseTeacherUserId(t) === a.wiseUserId)) || Boolean(liveGroup?.members.length);
      if (anyPresent && state) {
        if (state.contactActive !== null) await tx.update(schema.tutorContacts).set({ active: state.contactActive, updatedAt: now }).where(eq(schema.tutorContacts.canonicalKey, key));
        if (state.profileActive !== null) await tx.update(schema.tutorBusinessProfiles).set({ active: state.profileActive, updatedAt: now }).where(eq(schema.tutorBusinessProfiles.canonicalKey, key));
        await tx.update(accounts).set({ status: "restored", updatedAt: now }).where(and(eq(accounts.canonicalKey, key), inArray(accounts.status, ["verified", "removed_manually"])));
        continue;
      }
      if (anyPresent || identity.blocked.has(key)) continue;
      // Every durable owned account (including additions after preview) must be absent.
      const owned = await tx.select().from(schema.tutorWiseAccounts).where(eq(schema.tutorWiseAccounts.canonicalKey, key));
      if (owned.some(a => live.some(t => t._id === a.wiseTeacherId || getWiseTeacherUserId(t) === a.wiseUserId))) continue;
      const relevant = await tx.select().from(accounts).where(and(eq(accounts.canonicalKey, key), inArray(accounts.status, ["verified", "removed_manually"])));
      if (!relevant.length || state) continue;
      const [contact] = await tx.select({ active: schema.tutorContacts.active }).from(schema.tutorContacts).where(eq(schema.tutorContacts.canonicalKey, key));
      const [profile] = await tx.select({ active: schema.tutorBusinessProfiles.active }).from(schema.tutorBusinessProfiles).where(eq(schema.tutorBusinessProfiles.canonicalKey, key));
      const before = { contactActive: contact?.active ?? null, profileActive: profile?.active ?? null };
      await tx.update(accounts).set({ localStateBefore: before, updatedAt: now }).where(and(eq(accounts.canonicalKey, key), inArray(accounts.status, ["verified", "removed_manually"])));
      await tx.update(schema.tutorContacts).set({ active: false, updatedAt: now }).where(eq(schema.tutorContacts.canonicalKey, key));
      await tx.update(schema.tutorBusinessProfiles).set({ active: false, updatedAt: now }).where(eq(schema.tutorBusinessProfiles.canonicalKey, key));
    }
    const affected = new Set(eligible.map(r => r.run.id));
    for (const id of affected) {
      const items = await tx.select().from(accounts).where(and(eq(accounts.runId, id), eq(accounts.plan, "remove")));
      const complete = items.every(a => ["verified", "removed_manually", "manual_required"].includes(a.status));
      await tx.update(runs).set({ status: complete ? "applied" : "applied_with_errors", finishedAt: sql`coalesce(${runs.finishedAt}, ${now})` }).where(eq(runs.id, id));
    }
  });
  return { checked, settled, restored };
}
