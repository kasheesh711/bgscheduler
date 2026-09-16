import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import {
  accessForEmail,
  assertScope,
  resolveObserver,
  type SitInAccess,
} from "./access";
import {
  SCOPE_INFO,
  deliveryEnabled,
  scopeOf,
  coverageScopes,
  lessonScopes,
  OPERATIONS,
  SitInError,
  type CoverageScope,
  type Participant,
} from "./model";
import { suggestionsFor, teachingEvidence, type Sources } from "./sources";

import { allocateScience, type ScienceCandidate } from "./allocation";

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
  assertScope(access, scopeOf(row));
  return row;
}
export async function listAssignments(
  access: SitInAccess,
  quarter: string,
  db: Database,
) {
  if (access.role === "observer" && !coverageScopes(access).length) return [];
  return db
    .select()
    .from(s.tutorSitInAssignments)
    .where(
      and(
        eq(s.tutorSitInAssignments.quarter, quarter),
        ne(s.tutorSitInAssignments.status, "superseded"),
        access.role === "observer"
          ? inArray(
              sql`coalesce(${s.tutorSitInAssignments.coverageScope}, case when ${s.tutorSitInAssignments.department} = 'iseb' then 'iseb_other' else ${s.tutorSitInAssignments.department} end)`,
              coverageScopes(access),
            )
          : undefined,
      ),
    );
}
export async function generateAssignments(
  quarter: string,
  sources: Sources,
  db: Database,
  scopes?: CoverageScope[],
) {
  const grants = await db
    .select()
    .from(s.tutorSitInGrants)
    .where(eq(s.tutorSitInGrants.active, true));
  const eligible = new Map<string, typeof grants>();
  for (const info of SCOPE_INFO) {
    const heads: typeof grants = [];
    for (const grant of grants.filter(
      (g) =>
        info.observers.some((e) => e === g.email) &&
        coverageScopes(g).includes(info.scope),
    )) {
      try {
        await resolveObserver(grant.email, info.scope, "", db);
        heads.push(grant);
      } catch (error) {
        if (!(error instanceof SitInError)) throw error;
      }
    }
    eligible.set(info.scope, heads);
  }
  const values = new Map<string, typeof s.tutorSitInAssignments.$inferInsert>();
  for (const lesson of sources.lessons) {
    if (!lesson.tutorKey || !teachingEvidence(lesson)) continue;
    for (const scope of lessonScopes(lesson)) {
      if (scopes && !scopes.includes(scope)) continue;
      const info = SCOPE_INFO.find((v) => v.scope === scope)!;
      const head = eligible
        .get(scope)
        ?.find((g) => g.canonicalKey !== lesson.tutorKey);
      values.set(lesson.tutorKey + ":" + scope, {
        quarter,
        department: info.department,
        coverageScope: scope,
        canonicalKey: lesson.tutorKey,
        tutorName: lesson.tutorName,
        observerEmail: head?.email || null,
      });
    }
  }
  const science: ScienceCandidate[] = [];
  // Network checks occur outside the transaction. Selection and load balancing
  // are serialized below and confirmed lessons always undergo fresh live checks.
  for (const [key, value] of values) {
    if (value.coverageScope !== "science") continue;
    const options: ScienceCandidate["options"] = [];
    for (const head of eligible.get("science") || []) {
      if (head.canonicalKey === value.canonicalKey) continue;
      let starts: string[] = [];
      try {
        starts = (
          await suggestionsFor(
            { ...value, observerEmail: head.email } as Assignment,
            sources,
            db,
            new Date(),
          )
        ).map((s) => s.start);
      } catch (error) {
        if (!(error instanceof SitInError)) throw error;
      }
      options.push({ email: head.email, starts });
    }
    science.push({ key, options });
  }
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"tutor-sit-ins:" + quarter}))`,
    );
    // A grant may have been revoked or rebound while external availability was
    // loading. Re-read and hold grants during allocation; stale identity evidence
    // cannot choose a new observer.
    const currentGrants = await tx
      .select()
      .from(s.tutorSitInGrants)
      .for("share");
    const existing = await tx
      .select()
      .from(s.tutorSitInAssignments)
      .where(eq(s.tutorSitInAssignments.quarter, quarter))
      .for("update");
    const ids = existing.map((a) => a.id);
    const observations = ids.length
      ? await tx
          .select({ assignmentId: s.tutorSitInObservations.assignmentId })
          .from(s.tutorSitInObservations)
          .where(inArray(s.tutorSitInObservations.assignmentId, ids))
      : [];
    const reports = ids.length
      ? await tx
          .select({ assignmentId: s.tutorSitInReports.assignmentId })
          .from(s.tutorSitInReports)
          .where(inArray(s.tutorSitInReports.assignmentId, ids))
      : [];
    const historical = new Set(
      [...observations, ...reports].map((o) => o.assignmentId),
    );
    const untouched = (a: Assignment) =>
      a.allocationMode === "automatic" &&
      a.status === "pending" &&
      !historical.has(a.id);
    const keyOf = (a: Assignment) => a.canonicalKey + ":" + scopeOf(a);
    const disabled = new Set(
      (
        await tx
          .select()
          .from(s.adminUsers)
          .where(eq(s.adminUsers.disabled, true))
      ).map((a) => a.email.trim().toLowerCase()),
    );
    const stillEligible = (
      email: string,
      value: typeof s.tutorSitInAssignments.$inferInsert,
    ) => {
      const original = grants.find((g) => g.email === email);
      const current = currentGrants.find((g) => g.email === email);
      return (
        !!current?.active &&
        !disabled.has(email) &&
        current.canonicalKey === original?.canonicalKey &&
        current.canonicalKey !== value.canonicalKey &&
        current.role !== "coordinator" &&
        coverageScopes(current).includes(scopeOf(value))
      );
    };
    for (const value of values.values())
      if (value.observerEmail && !stillEligible(value.observerEmail, value))
        value.observerEmail = null;
    const mutableScience = science
      .filter(
        (c) =>
          !existing.some(
            (a) =>
              keyOf(a) === c.key && a.status !== "superseded" && !untouched(a),
          ),
      )
      .map((c) => ({
        ...c,
        options: c.options.filter((o) =>
          stillEligible(o.email, values.get(c.key)!),
        ),
      }));
    const loads = new Map<string, number>();
    for (const a of existing.filter(
      (a) =>
        scopeOf(a) === "science" &&
        a.status !== "superseded" &&
        !mutableScience.some((c) => c.key === keyOf(a)),
    ))
      if (a.observerEmail)
        loads.set(a.observerEmail, (loads.get(a.observerEmail) || 0) + 1);
    const allocations = allocateScience(mutableScience, loads);
    let inserted = 0;
    for (const [key, value] of values) {
      if (allocations.has(key)) value.observerEmail = allocations.get(key);
      const old = existing.find(
        (a) => keyOf(a) === key && a.status !== "superseded",
      );
      if (!old) {
        const rows = await tx
          .insert(s.tutorSitInAssignments)
          .values(value)
          .onConflictDoNothing()
          .returning({ id: s.tutorSitInAssignments.id });
        inserted += rows.length;
      } else if (
        untouched(old) &&
        (value.coverageScope === "science" || !old.observerEmail) &&
        old.observerEmail !== value.observerEmail
      ) {
        await tx
          .update(s.tutorSitInAssignments)
          .set({
            observerEmail: value.observerEmail,
            suggestions: [],
            suggestionError: null,
            readinessIssues: [],
            revision: old.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(s.tutorSitInAssignments.id, old.id));
        await audit(tx, "system", "automatic_observer_allocated", old.id, {
          before: old.observerEmail,
          after: value.observerEmail,
          coverageScope: value.coverageScope,
        });
      }
    }
    // Positive reclassification evidence only: disappearing/cancelled lessons
    // alone never erase a quarterly obligation or any history.
    for (const old of existing.filter(untouched)) {
      const scope = scopeOf(old);
      if ((scopes && !scopes.includes(scope)) || values.has(keyOf(old)))
        continue;
      const corrected = sources.lessons.some(
        (l) =>
          l.tutorKey === old.canonicalKey &&
          teachingEvidence(l) &&
          ((scope === "english" &&
            lessonScopes(l).includes("iseb_english_vr")) ||
            (scope === "maths" && lessonScopes(l).includes("iseb_maths_vr")) ||
            (scope === "iseb_other" &&
              lessonScopes(l).some(
                (v) => v === "iseb_english_vr" || v === "iseb_maths_vr",
              ))),
      );
      if (!corrected) continue;
      await tx
        .update(s.tutorSitInAssignments)
        .set({
          status: "superseded",
          reason: "Replaced by the corrected ISEB strand coverage.",
          suggestions: [],
          revision: old.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(s.tutorSitInAssignments.id, old.id));
      await audit(tx, "system", "assignment_superseded", old.id, {
        previousScope: scope,
        reason: "Corrected ISEB title classification",
        replacementScopes: [...values.values()]
          .filter((v) => v.canonicalKey === old.canonicalKey)
          .map((v) => v.coverageScope),
      });
    }
    return inserted;
  });
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
    deliveryEnabled: deliveryEnabled(),
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
