import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import {
  accessForEmail,
  assertDepartment,
  requireManager,
  resolveObserver,
  type SitInAccess,
} from "./access";
import { assertCalendarDelivery, calendarConnection } from "./calendar";
import {
  assignmentCommandSchema,
  bookingSchema,
  deliveryEnabled,
  HEADS,
  overlap,
  requireNotice,
  REPORT_WINDOW_MS,
  settingsSchema,
  SitInError,
  tutorInvitationEmail,
  type Department,
} from "./model";
import {
  EMPTY_REPORT,
  reportCommandSchema,
  reportScore,
  RUBRIC,
} from "./rubric";
import {
  audit,
  createCommunications,
  detail,
  generateAssignments,
  getAssignment,
  listAssignments,
  queueJob,
  withObserverOperation,
} from "./repository";
import {
  loadSources,
  suggestionsFor,
  verifyLiveLesson,
  type SuggestionCache,
} from "./sources";

export async function overview(
  access: SitInAccess,
  quarter: string,
  db: Database = getDb(),
) {
  const assignments = await listAssignments(access, quarter, db);
  const ids = assignments.map((a) => a.id);
  const observations = ids.length
    ? await db
        .select()
        .from(s.tutorSitInObservations)
        .where(
          and(
            inArray(s.tutorSitInObservations.assignmentId, ids),
            eq(s.tutorSitInObservations.current, true),
          ),
        )
    : [];
  const allObservations = ids.length
    ? await db
        .select()
        .from(s.tutorSitInObservations)
        .where(inArray(s.tutorSitInObservations.assignmentId, ids))
    : [];
  const observationIds = allObservations.map((o) => o.id);
  const communications = observationIds.length
    ? await db
        .select()
        .from(s.tutorSitInCommunications)
        .where(
          and(
            inArray(s.tutorSitInCommunications.observationId, observationIds),
            isNull(s.tutorSitInCommunications.supersededAt),
          ),
        )
    : [];
  const deliveryIssues = await db
    .select({
      id: s.tutorSitInJobs.id,
      observationId: s.tutorSitInJobs.observationId,
      kind: s.tutorSitInJobs.kind,
      recipient: s.tutorSitInJobs.recipient,
      error: s.tutorSitInJobs.lastError,
      retryAt: s.tutorSitInJobs.retryAt,
    })
    .from(s.tutorSitInJobs)
    .where(
      and(
        eq(s.tutorSitInJobs.status, "failed"),
        or(
          eq(s.tutorSitInJobs.recipient, access.email),
          observationIds.length
            ? inArray(s.tutorSitInJobs.observationId, observationIds)
            : undefined,
        ),
      ),
    )
    .limit(50);
  const now = Date.now();
  const rows = assignments
    .map((a) => {
      const observation = observations.find((o) => o.assignmentId === a.id);
      const reportDue = observation
        ? new Date(
            observation.endTime.getTime() + REPORT_WINDOW_MS,
          ).toISOString()
        : null;
      return {
        ...a,
        observation: observation ?? null,
        reportDue,
        reportOverdue:
          a.status !== "completed" &&
          !!reportDue &&
          Date.parse(reportDue) < now,
      };
    })
    .sort(
      (a, b) =>
        Number(b.reportOverdue) - Number(a.reportOverdue) ||
        (a.suggestions.length || Infinity) -
          (b.suggestions.length || Infinity) ||
        (a.suggestions[0]?.start || "~").localeCompare(
          b.suggestions[0]?.start || "~",
        ) ||
        a.tutorName.localeCompare(b.tutorName),
    );
  return {
    access,
    quarter,
    assignments: rows,
    communications: communications.map((c) => ({
      ...c,
      observation: allObservations.find((o) => o.id === c.observationId)!,
    })),
    deliveryEnabled: deliveryEnabled(),
    deliveryIssues,
    departments: HEADS,
  };
}
export async function refreshQuarter(
  access: SitInAccess,
  quarter: string,
  db: Database = getDb(),
) {
  const deadline = Date.now() + 220_000;
  const fresh = await accessForEmail(access.email, db);
  const sources = await loadSources(quarter, db);
  if (fresh.role !== "coordinator")
    await generateAssignments(
      quarter,
      sources,
      db,
      fresh.role === "observer" ? fresh.departments : undefined,
    );
  const assignments = await listAssignments(fresh, quarter, db);
  const { reconcileObservation } = await import("./worker");
  for (const assignment of assignments.filter(
    (a) => a.status === "scheduled",
  )) {
    if (Date.now() > deadline - 90_000) break;
    const [observation] = await db
      .select()
      .from(s.tutorSitInObservations)
      .where(
        and(
          eq(s.tutorSitInObservations.assignmentId, assignment.id),
          eq(s.tutorSitInObservations.current, true),
        ),
      );
    if (
      deliveryEnabled() &&
      observation?.calendarStatus === "synced" &&
      observation.startTime > new Date()
    )
      await reconcileObservation(db, assignment, observation, sources);
  }
  const refreshed = await listAssignments(fresh, quarter, db);
  const cache: SuggestionCache = new Map();
  for (const assignment of refreshed.filter((a) =>
    ["pending", "needs_rescheduling"].includes(a.status),
  )) {
    if (Date.now() > deadline) break;
    let suggestions: typeof assignment.suggestions = [],
      error: string | null = null;
    try {
      suggestions = await suggestionsFor(
        assignment,
        sources,
        db,
        new Date(),
        cache,
      );
    } catch (e) {
      error =
        e instanceof SitInError
          ? e.message
          : "Availability could not be refreshed. Try again.";
    }
    await db
      .update(s.tutorSitInAssignments)
      .set({ suggestions, suggestionError: error, checkedAt: new Date() })
      .where(
        and(
          eq(s.tutorSitInAssignments.id, assignment.id),
          eq(s.tutorSitInAssignments.revision, assignment.revision),
        ),
      );
  }
  return overview(fresh, quarter, db);
}
export async function bookObservation(
  access: SitInAccess,
  assignmentId: string,
  input: z.infer<typeof bookingSchema>,
  db: Database = getDb(),
) {
  assertCalendarDelivery();
  access = await accessForEmail(access.email, db);
  const assignment = await getAssignment(access, assignmentId, db);
  if (
    access.role === "coordinator" ||
    (access.role === "observer" && assignment.observerEmail !== access.email)
  )
    throw new SitInError(
      403,
      "Only the assigned head or an administrator can schedule this observation.",
    );
  if (!assignment.observerEmail)
    throw new SitInError(409, "Assign an observer first.");
  if (["completed", "exempt"].includes(assignment.status))
    throw new SitInError(409, "This assignment is already complete or exempt.");
  return withObserverOperation(
    db,
    assignment.observerEmail,
    async (assertLease) => {
      const [existing] = await db
        .select()
        .from(s.tutorSitInObservations)
        .where(
          and(
            eq(s.tutorSitInObservations.assignmentId, assignmentId),
            eq(s.tutorSitInObservations.current, true),
          ),
        );
      if (existing) {
        if (
          existing.lesson.id === input.sessionId &&
          existing.observerEmail === assignment.observerEmail
        )
          return detail(access, assignmentId, db);
        throw new SitInError(
          409,
          "Cancel the current observation before choosing its replacement.",
        );
      }
      if (assignment.revision !== input.expectedRevision)
        throw new SitInError(
          409,
          "This assignment changed. Refresh and try again.",
        );
      const sources = await loadSources(assignment.quarter, db);
      const candidate = sources.lessons.find(
        (l) =>
          l.id === input.sessionId &&
          l.tutorKey === assignment.canonicalKey &&
          l.departments.includes(assignment.department as Department),
      );
      if (!candidate)
        throw new SitInError(
          409,
          "This is no longer an eligible lesson. Refresh the available slots.",
        );
      const { lesson, observer } = await verifyLiveLesson(
        assignment,
        candidate,
        sources,
        db,
      );
      const connection = await calendarConnection(observer.email, db);
      const [tutorContact] = await db
        .select()
        .from(s.tutorContacts)
        .where(
          and(
            eq(s.tutorContacts.canonicalKey, assignment.canonicalKey),
            eq(s.tutorContacts.active, true),
          ),
        );
      lesson.tutorEmail = tutorInvitationEmail(tutorContact, lesson.modality);
      await assertLease();
      await withDatabaseTransaction(db, async (tx) => {
        await assertLease(tx);
        const freshAccess = await accessForEmail(access.email, tx);
        const [locked] = await tx
          .select()
          .from(s.tutorSitInAssignments)
          .where(eq(s.tutorSitInAssignments.id, assignmentId))
          .for("update");
        assertDepartment(freshAccess, locked.department);
        if (
          freshAccess.role === "coordinator" ||
          (freshAccess.role === "observer" &&
            locked.observerEmail !== freshAccess.email)
        )
          throw new SitInError(403, "Scheduling access changed.");
        if (locked.revision !== input.expectedRevision)
          throw new SitInError(
            409,
            "This assignment changed during verification. Try again.",
          );
        await resolveObserver(
          observer.email,
          locked.department,
          locked.canonicalKey,
          tx,
        );
        const bookings = await tx
          .select()
          .from(s.tutorSitInObservations)
          .where(
            and(
              eq(
                s.tutorSitInObservations.observerCanonicalKey,
                observer.canonicalKey,
              ),
              eq(s.tutorSitInObservations.current, true),
            ),
          );
        if (
          bookings.some((b) =>
            overlap(
              { start: new Date(lesson.start), end: new Date(lesson.end) },
              { start: b.startTime, end: b.endTime },
            ),
          )
        )
          throw new SitInError(
            409,
            "Another observation already occupies this time.",
          );
        // Verification can take time; enforce notice again at the commit boundary.
        requireNotice(new Date(lesson.start));
        const id = randomUUID();
        const [observation] = await tx
          .insert(s.tutorSitInObservations)
          .values({
            id,
            assignmentId,
            observerEmail: observer.email,
            observerCanonicalKey: observer.canonicalKey,
            lesson,
            startTime: new Date(lesson.start),
            endTime: new Date(lesson.end),
            calendarId: connection.calendarId,
            eventId: id.replaceAll("-", ""),
          })
          .returning();
        await tx
          .update(s.tutorSitInAssignments)
          .set({
            status: "scheduled",
            reason: null,
            suggestions: [],
            revision: locked.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(s.tutorSitInAssignments.id, assignmentId));
        const [previous] = await tx
          .select()
          .from(s.tutorSitInReports)
          .where(eq(s.tutorSitInReports.assignmentId, assignmentId))
          .orderBy(desc(s.tutorSitInReports.reportVersion))
          .limit(1);
        await tx.insert(s.tutorSitInReports).values({
          assignmentId,
          observationId: id,
          authorEmail: observer.email,
          reportVersion: (previous?.reportVersion || 0) + 1,
          rubric: RUBRIC,
          data: EMPTY_REPORT,
        });
        await createCommunications(tx, observation, "scheduled");
        await queueJob(tx, id + ":create", "calendar_upsert", id);
        await audit(tx, access.email, "observation_booked", assignmentId, {
          observationId: id,
          sessionId: lesson.id,
        });
      });
      return detail(access, assignmentId, db);
    },
  );
}
export async function assignmentCommand(
  access: SitInAccess,
  id: string,
  command: z.infer<typeof assignmentCommandSchema>,
  db: Database = getDb(),
) {
  const fresh = await accessForEmail(access.email, db);
  const assignment = await getAssignment(fresh, id, db);
  if (command.action !== "cancel") requireManager(fresh);
  else if (
    fresh.role === "coordinator" ||
    (fresh.role === "observer" && assignment.observerEmail !== fresh.email)
  )
    throw new SitInError(
      403,
      "Only the assigned observer or an administrator can cancel.",
    );
  if (assignment.revision !== command.expectedRevision)
    throw new SitInError(
      409,
      "This assignment changed. Refresh and try again.",
    );
  if (assignment.status === "completed" && command.action !== "reopen")
    throw new SitInError(
      409,
      "Reopen the report before changing this assignment.",
    );
  if (command.action === "reassign")
    await resolveObserver(
      command.email,
      assignment.department,
      assignment.canonicalKey,
      db,
    );
  await withDatabaseTransaction(db, async (tx) => {
    const [locked] = await tx
      .select()
      .from(s.tutorSitInAssignments)
      .where(eq(s.tutorSitInAssignments.id, id))
      .for("update");
    if (locked.revision !== command.expectedRevision)
      throw new SitInError(
        409,
        "This assignment changed. Refresh and try again.",
      );
    // Re-check the actor inside the write transaction too.
    const actor = await accessForEmail(access.email, tx);
    if (command.action !== "cancel") requireManager(actor);
    else if (
      actor.role === "coordinator" ||
      (actor.role === "observer" && locked.observerEmail !== actor.email)
    )
      throw new SitInError(403, "Scheduling access changed.");
    if (command.action === "reassign")
      await resolveObserver(
        command.email,
        locked.department,
        locked.canonicalKey,
        tx,
      );
    if (command.action === "reopen") {
      if (locked.status !== "completed")
        throw new SitInError(409, "Only a completed report can be reopened.");
      const [report] = await tx
        .select()
        .from(s.tutorSitInReports)
        .where(eq(s.tutorSitInReports.assignmentId, id))
        .orderBy(desc(s.tutorSitInReports.reportVersion))
        .limit(1);
      if (!report?.submittedAt)
        throw new SitInError(409, "There is no submitted report to reopen.");
      await tx.insert(s.tutorSitInReports).values({
        assignmentId: id,
        observationId: report.observationId,
        authorEmail: report.authorEmail,
        reportVersion: report.reportVersion + 1,
        rubric: report.rubric,
        data: report.data,
      });
      await tx
        .update(s.tutorSitInAssignments)
        .set({
          status: "scheduled",
          reason: command.reason,
          revision: locked.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(s.tutorSitInAssignments.id, id));
    } else {
      const [observation] = await tx
        .select()
        .from(s.tutorSitInObservations)
        .where(
          and(
            eq(s.tutorSitInObservations.assignmentId, id),
            eq(s.tutorSitInObservations.current, true),
          ),
        );
      // Inline state transition shares this transaction; no nested transaction.
      if (observation) {
        await tx
          .update(s.tutorSitInObservations)
          .set({
            current: false,
            invalidReason: command.reason,
            calendarStatus: "cancel_pending",
          })
          .where(eq(s.tutorSitInObservations.id, observation.id));
        await tx
          .update(s.tutorSitInCommunications)
          .set({ supersededAt: new Date() })
          .where(
            and(
              eq(s.tutorSitInCommunications.observationId, observation.id),
              eq(s.tutorSitInCommunications.kind, "scheduled"),
            ),
          );
        await createCommunications(tx, observation, "cancelled");
        await queueJob(
          tx,
          observation.id + ":delete",
          "calendar_delete",
          observation.id,
        );
        const { queueStaffEmail } = await import("./repository");
        await queueStaffEmail(tx, observation, "cancelled");
        await queueJob(
          tx,
          observation.id + ":head:cancelled",
          "head_alert",
          observation.id,
          observation.observerEmail,
          { reason: command.reason },
        );
      }
      await tx
        .update(s.tutorSitInAssignments)
        .set({
          status:
            command.action === "exempt"
              ? "exempt"
              : command.action === "reassign"
                ? "pending"
                : "needs_rescheduling",
          observerEmail:
            command.action === "reassign"
              ? command.email
              : locked.observerEmail,
          reason: command.reason,
          revision: locked.revision + 1,
          suggestions: [],
          updatedAt: new Date(),
        })
        .where(eq(s.tutorSitInAssignments.id, id));
    }
    await audit(tx, actor.email, command.action, id, {
      reason: command.reason,
      ...(command.action === "reassign"
        ? { observerEmail: command.email }
        : {}),
    });
  });
  return detail(fresh, id, db);
}
export async function saveReport(
  access: SitInAccess,
  reportId: string,
  command: z.infer<typeof reportCommandSchema>,
  db: Database = getDb(),
  now = new Date(),
) {
  const [initial] = await db
    .select({ assignmentId: s.tutorSitInReports.assignmentId })
    .from(s.tutorSitInReports)
    .where(eq(s.tutorSitInReports.id, reportId));
  if (!initial) throw new SitInError(404, "Report not found.");
  await withDatabaseTransaction(db, async (tx) => {
    const [assignment] = await tx
      .select()
      .from(s.tutorSitInAssignments)
      .where(eq(s.tutorSitInAssignments.id, initial.assignmentId))
      .for("update");
    const actor = await accessForEmail(access.email, tx);
    const [report] = await tx
      .select()
      .from(s.tutorSitInReports)
      .where(eq(s.tutorSitInReports.id, reportId))
      .for("update");
    if (!report) throw new SitInError(404, "Report not found.");
    assertDepartment(actor, assignment.department, true);
    if (
      report.authorEmail !== actor.email ||
      assignment.observerEmail !== actor.email
    )
      throw new SitInError(
        403,
        "Only the assigned observer can write this report.",
      );
    const [observation] = await tx
      .select()
      .from(s.tutorSitInObservations)
      .where(eq(s.tutorSitInObservations.id, report.observationId));
    if (!observation?.current || observation.invalidReason)
      throw new SitInError(
        409,
        "This observation needs rescheduling before a report can be submitted.",
      );
    if (report.submittedAt || report.revision !== command.expectedRevision)
      throw new SitInError(
        409,
        "This report changed or was submitted. Refresh before editing.",
      );
    const score = reportScore(report.rubric, command.data, command.submit);
    if (
      command.submit &&
      (observation.endTime > now || observation.calendarStatus !== "synced")
    )
      throw new SitInError(
        409,
        "Submit after the confirmed observation has finished.",
      );
    await tx
      .update(s.tutorSitInReports)
      .set({
        data: command.data,
        score,
        revision: report.revision + 1,
        submittedAt: command.submit ? now : null,
        late:
          command.submit &&
          now.getTime() > observation.endTime.getTime() + REPORT_WINDOW_MS,
        updatedAt: now,
      })
      .where(eq(s.tutorSitInReports.id, reportId));
    if (command.submit) {
      await tx
        .update(s.tutorSitInAssignments)
        .set({
          status: "completed",
          revision: sql`${s.tutorSitInAssignments.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(s.tutorSitInAssignments.id, assignment.id));
      await audit(tx, actor.email, "report_submitted", assignment.id, {
        reportId,
        version: report.reportVersion,
        score,
      });
    }
  });
  const [result] = await db
    .select()
    .from(s.tutorSitInReports)
    .where(eq(s.tutorSitInReports.id, reportId));
  return result;
}
export const communicationSchema = z.union([
  z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      audience: z.enum(["parent", "student"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      expectedRevision: z.number().int().nonnegative(),
      parentName: z.string().trim().min(2).max(200),
      familyKey: z.string().trim().min(2).max(200),
      reason: z.string().trim().min(3).max(1000),
    })
    .strict(),
]);
export async function acknowledgeCommunication(
  access: SitInAccess,
  id: string,
  command: z.infer<typeof communicationSchema>,
  db: Database = getDb(),
) {
  return withDatabaseTransaction(db, async (tx) => {
    const fresh = await accessForEmail(access.email, tx);
    if (fresh.role === "observer")
      throw new SitInError(
        403,
        "Administrative staff record family communication.",
      );
    const [row] = await tx
      .select()
      .from(s.tutorSitInCommunications)
      .where(eq(s.tutorSitInCommunications.id, id))
      .for("update");
    if (!row) throw new SitInError(404, "Communication task not found.");
    if (row.supersededAt || row.revision !== command.expectedRevision)
      throw new SitInError(
        409,
        "This communication task changed. Refresh and try again.",
      );
    if ("action" in command) {
      requireManager(fresh);
      if (!row.unresolved)
        throw new SitInError(409, "This family is already resolved.");
      const [changed] = await tx
        .update(s.tutorSitInCommunications)
        .set({
          familyKey: command.familyKey,
          unresolved: false,
          participants: row.participants.map((p) => ({
            ...p,
            familyKey: command.familyKey,
            parentName: command.parentName,
          })),
          revision: row.revision + 1,
        })
        .where(eq(s.tutorSitInCommunications.id, id))
        .returning();
      await audit(tx, fresh.email, "family_resolved", row.observationId, {
        communicationId: id,
        reason: command.reason,
        familyKey: command.familyKey,
      });
      return changed;
    }
    if (row.unresolved)
      throw new SitInError(
        409,
        "Resolve this family before recording communication.",
      );
    const [observation] = await tx
      .select()
      .from(s.tutorSitInObservations)
      .where(eq(s.tutorSitInObservations.id, row.observationId));
    if (
      row.kind === "scheduled" &&
      (!observation.current || observation.calendarStatus !== "synced")
    )
      throw new SitInError(
        409,
        "Wait for the Calendar invitation to be confirmed before informing this family.",
      );
    if (
      command.audience === "parent"
        ? row.parentInformedAt
        : row.studentInformedAt
    )
      return row;
    const [changed] = await tx
      .update(s.tutorSitInCommunications)
      .set({
        ...(command.audience === "parent"
          ? { parentInformedAt: new Date(), parentInformedBy: fresh.email }
          : { studentInformedAt: new Date(), studentInformedBy: fresh.email }),
        revision: row.revision + 1,
      })
      .where(eq(s.tutorSitInCommunications.id, id))
      .returning();
    await audit(tx, fresh.email, "family_informed", row.observationId, {
      audience: command.audience,
      communicationId: id,
    });
    return changed;
  });
}
export async function settings(
  access: SitInAccess,
  quarter: string,
  db: Database = getDb(),
) {
  requireManager(await accessForEmail(access.email, db));
  const [grants, mappings, contacts] = await Promise.all([
    db
      .select({
        email: s.tutorSitInGrants.email,
        role: s.tutorSitInGrants.role,
        departments: s.tutorSitInGrants.departments,
        canonicalKey: s.tutorSitInGrants.canonicalKey,
        active: s.tutorSitInGrants.active,
        revision: s.tutorSitInGrants.revision,
      })
      .from(s.tutorSitInGrants),
    db.select().from(s.tutorSitInMappings),
    db
      .select({
        canonicalKey: s.tutorContacts.canonicalKey,
        name: s.tutorContacts.displayName,
      })
      .from(s.tutorContacts)
      .where(eq(s.tutorContacts.active, true)),
  ]);
  let classes: Array<{
      classId: string;
      title: string;
      tutorName: string;
      departments: Department[];
      unresolved: boolean;
    }> = [],
    sourceError: string | null = null;
  try {
    const sources = await loadSources(quarter, db);
    classes = [
      ...new Map(
        sources.lessons.map((l) => [
          l.classId,
          {
            classId: l.classId,
            title: l.title,
            tutorName: l.tutorName,
            departments: l.departments,
            unresolved:
              !l.tutorKey ||
              !l.participants.length ||
              (!l.departments.length &&
                !mappings.some((m) => m.classId === l.classId)),
          },
        ]),
      ).values(),
    ];
  } catch (e) {
    sourceError =
      e instanceof SitInError ? e.message : "Source data is unavailable.";
  }
  return { grants, mappings, contacts, classes, sourceError };
}
export async function updateSettings(
  access: SitInAccess,
  command: z.infer<typeof settingsSchema>,
  db: Database = getDb(),
) {
  requireManager(await accessForEmail(access.email, db));
  await withDatabaseTransaction(db, async (tx) => {
    requireManager(await accessForEmail(access.email, tx));
    if (command.action === "grant") {
      if (command.canonicalKey) {
        const [contact] = await tx
          .select()
          .from(s.tutorContacts)
          .where(
            and(
              eq(s.tutorContacts.canonicalKey, command.canonicalKey),
              eq(s.tutorContacts.active, true),
            ),
          );
        if (!contact)
          throw new SitInError(400, "Choose a verified active tutor identity.");
      }
      const [old] = await tx
        .select()
        .from(s.tutorSitInGrants)
        .where(eq(s.tutorSitInGrants.email, command.email))
        .for("update");
      if (old && old.revision !== command.expectedRevision)
        throw new SitInError(409, "This access grant changed.");
      const values = {
        email: command.email,
        role: command.role,
        departments: [...new Set(command.departments)],
        canonicalKey: command.canonicalKey,
        active: command.active,
        revision: (old?.revision ?? -1) + 1,
        updatedAt: new Date(),
      };
      if (old)
        await tx
          .update(s.tutorSitInGrants)
          .set(values)
          .where(eq(s.tutorSitInGrants.email, command.email));
      else await tx.insert(s.tutorSitInGrants).values(values);
      await audit(tx, access.email, "grant_changed", command.email, {
        before: old
          ? {
              role: old.role,
              departments: old.departments,
              active: old.active,
              canonicalKey: old.canonicalKey,
            }
          : null,
        after: values,
        reason: command.reason,
      });
    } else if (command.action === "mapping") {
      const [old] = await tx
        .select()
        .from(s.tutorSitInMappings)
        .where(eq(s.tutorSitInMappings.classId, command.classId))
        .for("update");
      if (old && old.revision !== command.expectedRevision)
        throw new SitInError(409, "This class mapping changed.");
      const values = {
        classId: command.classId,
        departments: [...new Set(command.departments)],
        revision: (old?.revision ?? -1) + 1,
        updatedBy: access.email,
        reason: command.reason,
        updatedAt: new Date(),
      };
      if (old)
        await tx
          .update(s.tutorSitInMappings)
          .set(values)
          .where(eq(s.tutorSitInMappings.classId, command.classId));
      else await tx.insert(s.tutorSitInMappings).values(values);
      await audit(tx, access.email, "mapping_changed", command.classId, {
        departments: values.departments,
        reason: command.reason,
      });
    } else {
      const [tutor] = await tx
        .select()
        .from(s.tutorContacts)
        .where(
          and(
            eq(s.tutorContacts.canonicalKey, command.canonicalKey),
            eq(s.tutorContacts.active, true),
          ),
        );
      if (!tutor) throw new SitInError(400, "Choose an active tutor.");
      const head = HEADS.find((h) => h.department === command.department)!;
      const [grant] = await tx
        .select()
        .from(s.tutorSitInGrants)
        .where(eq(s.tutorSitInGrants.email, head.email));
      const [row] = await tx
        .insert(s.tutorSitInAssignments)
        .values({
          quarter: command.quarter,
          department: command.department,
          canonicalKey: command.canonicalKey,
          tutorName: tutor.displayName,
          observerEmail:
            grant?.active && grant.canonicalKey !== command.canonicalKey
              ? head.email
              : null,
          reason: command.reason,
        })
        .onConflictDoNothing()
        .returning();
      if (!row)
        throw new SitInError(
          409,
          "This tutor already has an obligation in this department and quarter.",
        );
      await audit(tx, access.email, "assignment_added", row.id, {
        reason: command.reason,
      });
    }
  });
}
