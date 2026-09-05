import { isDeepStrictEqual } from "node:util";
import { and, eq, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import type { WiseTeacher } from "@/lib/wise/types";
import type { IdentityGroup } from "@/lib/normalization/identity";
import { planTutorContacts, type AccountMapping, type Contact } from "./planner";

export async function loadAccountMappings(db: Database): Promise<AccountMapping[]> {
  const durable = await db.select().from(schema.tutorWiseAccounts);
  const current = await db.select({
    wiseTeacherId: schema.tutorIdentityGroupMembers.wiseTeacherId,
    wiseUserId: schema.tutorIdentityGroupMembers.wiseUserId,
    canonicalKey: schema.tutorIdentityGroups.canonicalKey,
    displayName: schema.tutorIdentityGroupMembers.wiseDisplayName,
    isOnlineVariant: schema.tutorIdentityGroupMembers.isOnlineVariant,
  }).from(schema.tutorIdentityGroupMembers)
    .innerJoin(schema.tutorIdentityGroups, eq(schema.tutorIdentityGroups.id, schema.tutorIdentityGroupMembers.groupId))
    .innerJoin(schema.snapshots, eq(schema.snapshots.id, schema.tutorIdentityGroups.snapshotId))
    .where(eq(schema.snapshots.active, true));
  const ids = new Set(durable.map(a => a.wiseTeacherId));
  return [...durable, ...current.filter(a => !ids.has(a.wiseTeacherId))];
}

export function contactValues(c: Contact): Contact {
  return { canonicalKey: c.canonicalKey, displayName: c.displayName, onsiteEmail: c.onsiteEmail, onlineEmail: c.onlineEmail,
    sourceNames: c.sourceNames, active: c.active, wiseEmailState: c.wiseEmailState ?? {} };
}

/** Re-read contacts under locks so concurrent human edits are never overwritten. */
export async function promoteWithTutorContacts(db: Database, input: {
  snapshotId: string; teachers: WiseTeacher[]; groups: IdentityGroup[]; blocked: Set<string>;
  // A stale worker must not promote after a newer candidate. Existing run guard is also checked.
  syncRunId: string;
}) {
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('wise_snapshot_promotion'))`);
    await tx.execute(sql`select id from sync_runs where id = ${input.syncRunId} for update`);
    const [run] = await tx.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, input.syncRunId));
    if (!run || run.status !== "running") throw new Error("Wise sync no longer owns its running claim");
    const [candidate] = await tx.select().from(schema.snapshots).where(eq(schema.snapshots.id, input.snapshotId));
    const [active] = await tx.select().from(schema.snapshots).where(eq(schema.snapshots.active, true));
    if (!candidate || (active && active.createdAt > candidate.createdAt)) throw new Error("A newer Wise snapshot has already been promoted");
    // Contact imports are infrequent and small. Serialize inserts as well as existing-row edits.
    await tx.execute(sql`lock table tutor_contacts in share row exclusive mode`);
    const contacts = (await tx.select().from(schema.tutorContacts)).map(contactValues);
    const previous = await tx.select().from(schema.tutorWiseAccounts);
    const plan = planTutorContacts(input.teachers, input.groups, input.blocked, contacts, previous);
    for (const a of plan.accounts) {
      const value = { wiseTeacherId: a.wiseTeacherId, wiseUserId: a.wiseUserId, canonicalKey: a.canonicalKey,
        displayName: a.displayName, isOnlineVariant: a.isOnlineVariant, email: a.email, status: a.status };
      const old = previous.find(p => p.wiseTeacherId === a.wiseTeacherId);
      const before = old ? { wiseTeacherId: old.wiseTeacherId, wiseUserId: old.wiseUserId, canonicalKey: old.canonicalKey,
        displayName: old.displayName, isOnlineVariant: old.isOnlineVariant, email: old.email, status: old.status } : null;
      // Keep the established mapping even when conflicting records are encountered.
      if (old && old.canonicalKey !== a.canonicalKey) throw new Error("Wise account ownership changed during sync; retry with current mappings");
      if (isDeepStrictEqual(before, value)) continue;
      await tx.insert(schema.tutorWiseAccounts).values({ ...value, lastSnapshotId: input.snapshotId })
        .onConflictDoUpdate({ target: schema.tutorWiseAccounts.wiseTeacherId, set: { ...value, lastSnapshotId: input.snapshotId, updatedAt: new Date() } });
      await tx.insert(schema.tutorContactSyncEvents).values({ snapshotId: input.snapshotId, canonicalKey: a.canonicalKey,
        entityType: "wise_account", entityId: a.wiseTeacherId, beforeValue: before, afterValue: value });
    }
    for (const c of plan.contacts) {
      const before = contacts.find(p => p.canonicalKey === c.canonicalKey) ?? null;
      if (isDeepStrictEqual(before, c)) continue;
      // Never write primaryEmail, phones, active flags or names over an existing row.
      if (before) {
        await tx.update(schema.tutorContacts).set({ onsiteEmail: c.onsiteEmail, onlineEmail: c.onlineEmail, wiseEmailState: c.wiseEmailState,
          updatedAt: sql`greatest(now(), date_trunc('second', ${schema.tutorContacts.updatedAt}) + interval '1 second')` })
          .where(eq(schema.tutorContacts.canonicalKey, c.canonicalKey));
      } else await tx.insert(schema.tutorContacts).values(c);
      await tx.insert(schema.tutorContactSyncEvents).values({ snapshotId: input.snapshotId, canonicalKey: c.canonicalKey,
        entityType: "contact", entityId: c.canonicalKey, beforeValue: before ? { ...before } : null, afterValue: { ...c } });
    }
    if (plan.issues.length) await tx.insert(schema.dataIssues).values(plan.issues.map(i => ({ snapshotId: input.snapshotId,
      type: "completeness" as const, severity: "high" as const, entityType: "teacher_contact", entityId: i.entityId,
      entityName: i.canonicalKey, message: i.message })));
    if (plan.issues.length) await tx.update(schema.snapshotStats).set({
      totalDataIssues: sql`${schema.snapshotStats.totalDataIssues} + ${plan.issues.length}`,
      issuesByType: sql`jsonb_set(${schema.snapshotStats.issuesByType}, '{completeness}', to_jsonb(coalesce((${schema.snapshotStats.issuesByType}->>'completeness')::integer, 0) + ${plan.issues.length}))`,
    }).where(eq(schema.snapshotStats.snapshotId, input.snapshotId));
    await tx.update(schema.snapshots).set({ active: sql`(${schema.snapshots.id} = ${input.snapshotId})` })
      .where(or(eq(schema.snapshots.active, true), eq(schema.snapshots.id, input.snapshotId)));
    await tx.update(schema.syncRuns).set({ promotedSnapshotId: input.snapshotId })
      .where(and(eq(schema.syncRuns.id, input.syncRunId), eq(schema.syncRuns.status, "running")));
    return plan;
  });
}
