import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { accessForEmail, assertDepartment, type SitInAccess } from "./access";
import {
  HEADS,
  OPERATIONS,
  SitInError,
  type Department,
  type Participant,
} from "./model";
import { teachingEvidence, type Sources } from "./sources";

export type Assignment = typeof s.tutorSitInAssignments.$inferSelect;
export type Observation = typeof s.tutorSitInObservations.$inferSelect;
export async function audit(
  db: Database,
  actor: string,
  action: string,
  entityId: string,
  detail: Record<string, unknown> = {},
) {
  await db
    .insert(s.tutorSitInAudit)
    .values({ actor, action, entityId, detail });
}
export async function getAssignment(
  access: SitInAccess,
  id: string,
  db: Database,
) {
  const [row] = await db
    .select()
    .from(s.tutorSitInAssignments)
    .where(eq(s.tutorSitInAssignments.id, id));
  if (!row) throw new SitInError(404, "Observation assignment not found.");
  assertDepartment(access, row.department);
  return row;
}
export async function listAssignments(
  access: SitInAccess,
  quarter: string,
  db: Database,
) {
  if (access.role === "observer" && !access.departments.length) return [];
  return db
    .select()
    .from(s.tutorSitInAssignments)
    .where(
      and(
        eq(s.tutorSitInAssignments.quarter, quarter),
        access.role === "observer"
          ? inArray(s.tutorSitInAssignments.department, access.departments)
          : undefined,
      ),
    );
}
export async function generateAssignments(
  quarter: string,
  sources: Sources,
  db: Database,
  departments?: Department[],
) {
  const grants = await db
    .select()
    .from(s.tutorSitInGrants)
    .where(eq(s.tutorSitInGrants.active, true));
  const values = new Map<string, typeof s.tutorSitInAssignments.$inferInsert>();
  for (const lesson of sources.lessons) {
    if (!lesson.tutorKey || !teachingEvidence(lesson)) continue;
    for (const department of lesson.departments) {
      if (departments && !departments.includes(department)) continue;
      const primary = HEADS.find((h) => h.department === department)!;
      const head =
        grants.find(
          (g) =>
            g.email === primary.email &&
            g.role === "observer" &&
            g.departments.includes(department),
        ) ||
        grants.find(
          (g) => g.role === "observer" && g.departments.includes(department),
        );
      values.set(lesson.tutorKey + ":" + department, {
        quarter,
        department,
        canonicalKey: lesson.tutorKey,
        tutorName: lesson.tutorName,
        observerEmail:
          head?.canonicalKey === lesson.tutorKey ? null : (head?.email ?? null),
      });
    }
  }
  if (!values.size) return 0;
  const inserted = await db
    .insert(s.tutorSitInAssignments)
    .values([...values.values()])
    .onConflictDoNothing()
    .returning({ id: s.tutorSitInAssignments.id });
  return inserted.length;
}
export async function queueJob(
  db: Database,
  key: string,
  kind: string,
  observationId: string | null,
  recipient: string | null = null,
  payload: Record<string, unknown> = {},
) {
  await db
    .insert(s.tutorSitInJobs)
    .values({ key, kind, observationId, recipient, payload })
    .onConflictDoNothing();
}
export async function queueStaffEmail(
  db: Database,
  observation: Observation,
  kind: string,
) {
  for (const person of OPERATIONS)
    await queueJob(
      db,
      observation.id + ":staff:" + kind + ":" + person.email,
      "staff_email",
      observation.id,
      person.email,
      { kind },
    );
}
export async function createCommunications(
  db: Database,
  observation: Observation,
  kind: "scheduled" | "cancelled",
) {
  const groups = new Map<string, Participant[]>();
  const participants = observation.lesson.participants;
  for (const person of participants) {
    const key = person.familyKey || "unresolved:" + person.studentKey;
    groups.set(key, [...(groups.get(key) || []), person]);
  }
  if (!groups.size) groups.set("unresolved:class", []);
  for (const [familyKey, participants] of groups)
    await db
      .insert(s.tutorSitInCommunications)
      .values({
        observationId: observation.id,
        familyKey,
        kind,
        participants,
        unresolved: familyKey.startsWith("unresolved:"),
      })
      .onConflictDoNothing();
}
export async function invalidateObservation(
  db: Database,
  observation: Observation,
  reason: string,
  actor: string,
  status = "needs_rescheduling",
) {
  await withDatabaseTransaction(db, async (tx) => {
    const [assignment] = await tx
      .select()
      .from(s.tutorSitInAssignments)
      .where(eq(s.tutorSitInAssignments.id, observation.assignmentId))
      .for("update");
    const [current] = await tx
      .select()
      .from(s.tutorSitInObservations)
      .where(
        and(
          eq(s.tutorSitInObservations.id, observation.id),
          eq(s.tutorSitInObservations.current, true),
        ),
      );
    if (!current || !assignment || assignment.status === "completed") return;
    await tx
      .update(s.tutorSitInObservations)
      .set({
        current: false,
        invalidReason: reason,
        calendarStatus: "cancel_pending",
      })
      .where(eq(s.tutorSitInObservations.id, observation.id));
    await tx
      .update(s.tutorSitInAssignments)
      .set({
        status,
        reason,
        revision: assignment.revision + 1,
        suggestions: [],
        updatedAt: new Date(),
      })
      .where(eq(s.tutorSitInAssignments.id, assignment.id));
    await tx
      .update(s.tutorSitInCommunications)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(s.tutorSitInCommunications.observationId, observation.id),
          eq(s.tutorSitInCommunications.kind, "scheduled"),
          isNull(s.tutorSitInCommunications.supersededAt),
        ),
      );
    await createCommunications(tx, current, "cancelled");
    await queueJob(
      tx,
      observation.id + ":delete",
      "calendar_delete",
      observation.id,
    );
    await queueStaffEmail(tx, current, "cancelled");
    await queueJob(
      tx,
      observation.id + ":head:cancelled",
      "head_alert",
      observation.id,
      observation.observerEmail,
      { reason },
    );
    await audit(tx, actor, "observation_invalidated", assignment.id, {
      observationId: observation.id,
      reason,
    });
  });
}
export async function detail(access: SitInAccess, id: string, db: Database) {
  const assignment = await getAssignment(access, id, db);
  const observations = await db
    .select()
    .from(s.tutorSitInObservations)
    .where(eq(s.tutorSitInObservations.assignmentId, id))
    .orderBy(desc(s.tutorSitInObservations.createdAt));
  const ids = observations.map((o) => o.id);
  const communications = ids.length
    ? await db
        .select()
        .from(s.tutorSitInCommunications)
        .where(inArray(s.tutorSitInCommunications.observationId, ids))
    : [];
  const reports =
    access.role === "coordinator"
      ? []
      : await db
          .select()
          .from(s.tutorSitInReports)
          .where(eq(s.tutorSitInReports.assignmentId, id))
          .orderBy(desc(s.tutorSitInReports.reportVersion));
  const events =
    access.role === "coordinator"
      ? []
      : await db
          .select()
          .from(s.tutorSitInAudit)
          .where(eq(s.tutorSitInAudit.entityId, id))
          .orderBy(desc(s.tutorSitInAudit.createdAt))
          .limit(60);
  const deliveries = ids.length
    ? await db
        .select({
          id: s.tutorSitInJobs.id,
          kind: s.tutorSitInJobs.kind,
          status: s.tutorSitInJobs.status,
          lastError: s.tutorSitInJobs.lastError,
          recipient: s.tutorSitInJobs.recipient,
          observationId: s.tutorSitInJobs.observationId,
        })
        .from(s.tutorSitInJobs)
        .where(inArray(s.tutorSitInJobs.observationId, ids))
    : [];
  return {
    assignment,
    observations,
    communications,
    reports,
    events,
    deliveries,
  };
}
export async function withObserverOperation<T>(
  db: Database,
  email: string,
  work: (assertLease: (tx?: Database) => Promise<void>) => Promise<T>,
  options: { cleanup?: boolean } = {},
) {
  if (!options.cleanup) {
    try {
      await accessForEmail(email, db);
    } catch (error) {
      if (error instanceof SitInError)
        throw new SitInError(error.status, error.message, "HEAD_UNAVAILABLE");
      throw error;
    }
  }
  const owner = randomUUID(),
    now = new Date();
  const [claim] = await db
    .update(s.tutorSitInGrants)
    .set({
      operationOwner: owner,
      operationUntil: new Date(now.getTime() + 120_000),
    })
    .where(
      and(
        eq(s.tutorSitInGrants.email, email),
        options.cleanup ? undefined : eq(s.tutorSitInGrants.active, true),
        or(
          isNull(s.tutorSitInGrants.operationOwner),
          lt(s.tutorSitInGrants.operationUntil, now),
        ),
      ),
    )
    .returning();
  if (!claim)
    throw new SitInError(
      409,
      "Another observation is being scheduled for this head. Try again shortly.",
    );
  try {
    return await work(async (tx) => {
      const query = (tx || db)
        .select()
        .from(s.tutorSitInGrants)
        .where(
          and(
            eq(s.tutorSitInGrants.email, email),
            eq(s.tutorSitInGrants.operationOwner, owner),
            options.cleanup ? undefined : eq(s.tutorSitInGrants.active, true),
          ),
        );
      const [current] = await (tx ? query.for("update") : query);
      if (
        !current ||
        !current.operationUntil ||
        current.operationUntil <= new Date()
      )
        throw new SitInError(
          409,
          "Scheduling took too long or access changed. Refresh and retry.",
        );
      if (!options.cleanup) await accessForEmail(email, tx || db);
      await (tx || db)
        .update(s.tutorSitInGrants)
        .set({ operationUntil: new Date(Date.now() + 120_000) })
        .where(
          and(
            eq(s.tutorSitInGrants.email, email),
            eq(s.tutorSitInGrants.operationOwner, owner),
          ),
        );
    });
  } finally {
    await db
      .update(s.tutorSitInGrants)
      .set({ operationOwner: null, operationUntil: null })
      .where(
        and(
          eq(s.tutorSitInGrants.email, email),
          eq(s.tutorSitInGrants.operationOwner, owner),
        ),
      );
  }
}
export async function claimJob(
  db: Database,
  id: string,
  owner: string,
  now = new Date(),
) {
  const [job] = await db
    .update(s.tutorSitInJobs)
    .set({
      status: "running",
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + 300_000),
      attempts: sql`${s.tutorSitInJobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(s.tutorSitInJobs.id, id),
        or(
          and(
            inArray(s.tutorSitInJobs.status, ["pending", "failed"]),
            lt(s.tutorSitInJobs.retryAt, new Date(now.getTime() + 1)),
          ),
          and(
            eq(s.tutorSitInJobs.status, "running"),
            lt(s.tutorSitInJobs.leaseUntil, now),
          ),
        ),
      ),
    )
    .returning();
  return job;
}
