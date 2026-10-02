import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import {
  freshAttendanceAccess,
  requireAttendanceAdmin,
  type AttendanceAccess,
} from "./access";
import { attendanceConfig } from "./data";
import {
  AttendanceError,
  attendanceEnabled,
  correctionSchema,
  hasAttendanceEvidence,
  instant,
  localDate,
  punchSchema,
  reviewSchema,
  settingsCommandSchema,
  wfhDecisionSchema,
  wfhRequestSchema,
} from "./model";
import { networkRule, networkStatus } from "./network";

// One office, a small enrolled cohort. One DB lock also serializes network revocation
// with punches and schedule/enrollment changes, without holding locks across I/O.
async function transaction<T>(
  access: AttendanceAccess,
  db: Database,
  run: (tx: Database, fresh: AttendanceAccess) => Promise<T>,
) {
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('tutor-office-attendance'))`,
    );
    return run(tx, await freshAttendanceAccess(access, tx));
  });
}
const dayWhere = (key: string, date: string) =>
  and(
    eq(s.tutorAttendanceDays.canonicalKey, key),
    eq(s.tutorAttendanceDays.date, date),
  );
async function dayFor(tx: Database, key: string, date: string) {
  await tx
    .insert(s.tutorAttendanceDays)
    .values({ canonicalKey: key, date })
    .onConflictDoNothing();
  return (await existingDay(tx, key, date))!;
}
async function existingDay(tx: Database, key: string, date: string) {
  const [day] = await tx
    .select()
    .from(s.tutorAttendanceDays)
    .where(dayWhere(key, date));
  return day;
}
function assertRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new AttendanceError(
      409,
      "This record changed. Refresh and review the latest details before trying again.",
      "STALE_REVISION",
    );
}
async function enrollmentFor(tx: Database, key: string, date?: string) {
  const [row] = await tx
    .select({ enrollment: s.tutorAttendanceEnrollments })
    .from(s.tutorAttendanceEnrollments)
    .innerJoin(
      s.tutorContacts,
      eq(
        s.tutorContacts.canonicalKey,
        s.tutorAttendanceEnrollments.canonicalKey,
      ),
    )
    .where(
      and(
        eq(s.tutorAttendanceEnrollments.canonicalKey, key),
        eq(s.tutorContacts.active, true),
      ),
    );
  const enrollment = row?.enrollment;
  if (!enrollment || !enrollment.active)
    throw new AttendanceError(
      403,
      "This tutor is not enrolled for attendance.",
    );
  if (
    date &&
    (date < enrollment.startDate ||
      (enrollment.endDate && date > enrollment.endDate))
  )
    throw new AttendanceError(
      400,
      "This date is outside your attendance enrollment.",
    );
  return enrollment;
}
export async function saveAttendanceSettings(
  access: AttendanceAccess,
  input: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const command = settingsCommandSchema.parse(input);
  return transaction(access, db, async (tx, fresh) => {
    requireAttendanceAdmin(fresh);
    const config = await attendanceConfig(tx);
    assertRevision(config.revision, command.expectedRevision);
    const revision = config.revision + 1;
    const today = localDate(now);
    if (command.action === "enrollment") {
      const [contact] = await tx
        .select()
        .from(s.tutorContacts)
        .where(
          and(
            eq(s.tutorContacts.canonicalKey, command.canonicalKey),
            eq(s.tutorContacts.active, true),
          ),
        );
      if (!contact && command.active)
        throw new AttendanceError(
          400,
          "Select a current active tutor identity.",
        );
      if (command.endDate && command.endDate < command.startDate)
        throw new AttendanceError(
          400,
          "Enrollment end must be on or after its start.",
        );
      const otherContacts = await tx
        .select({ key: s.tutorContacts.canonicalKey })
        .from(s.tutorContacts)
        .where(
          and(
            eq(s.tutorContacts.active, true),
            sql`(${s.tutorContacts.canonicalKey} <> ${command.canonicalKey}) AND (lower(btrim(${s.tutorContacts.onsiteEmail})) = ${command.loginEmail} OR lower(btrim(${s.tutorContacts.onlineEmail})) = ${command.loginEmail})`,
          ),
        );
      if (otherContacts.length)
        throw new AttendanceError(
          409,
          "That sign-in email is already bound to another tutor. Resolve their identity first.",
        );
      const [duplicate] = await tx
        .select()
        .from(s.tutorAttendanceEnrollments)
        .where(
          and(
            eq(s.tutorAttendanceEnrollments.active, true),
            eq(s.tutorAttendanceEnrollments.loginEmail, command.loginEmail),
            sql`${s.tutorAttendanceEnrollments.canonicalKey} <> ${command.canonicalKey}`,
          ),
        );
      if (command.active && duplicate)
        throw new AttendanceError(
          409,
          "That email is already enrolled for another tutor.",
        );
      const [previous] = await tx
        .select()
        .from(s.tutorAttendanceEnrollments)
        .where(
          eq(s.tutorAttendanceEnrollments.canonicalKey, command.canonicalKey),
        );
      if (
        previous &&
        previous.startDate < today &&
        command.startDate !== previous.startDate
      )
        throw new AttendanceError(
          400,
          "Past enrollment start dates are fixed. Use dated exceptions to correct historical requirements.",
        );
      const endDate =
        !command.active && (!command.endDate || command.endDate > today)
          ? today
          : command.endDate;
      if (endDate && endDate < command.startDate)
        throw new AttendanceError(
          400,
          "Enrollment starts in the future. Set its start date to today before deactivating it.",
        );
      const values = {
        canonicalKey: command.canonicalKey,
        loginEmail: command.loginEmail,
        startDate: command.startDate,
        endDate,
        active: command.active,
        updatedAt: now,
      };
      await tx
        .insert(s.tutorAttendanceEnrollments)
        .values(values)
        .onConflictDoUpdate({
          target: s.tutorAttendanceEnrollments.canonicalKey,
          set: values,
        });
    } else if (command.action === "schedule") {
      await enrollmentFor(tx, command.canonicalKey);
      if (command.effectiveFrom < today)
        throw new AttendanceError(
          400,
          "Recurring schedules start today or later. Use a dated exception for historical changes.",
        );
      await tx.insert(s.tutorAttendanceSchedules).values({
        canonicalKey: command.canonicalKey,
        effectiveFrom: command.effectiveFrom,
        week: command.week,
        revision,
      });
    } else if (command.action === "exception") {
      if (command.canonicalKey) {
        const [enrollment] = await tx
          .select()
          .from(s.tutorAttendanceEnrollments)
          .where(
            eq(s.tutorAttendanceEnrollments.canonicalKey, command.canonicalKey),
          );
        if (!enrollment)
          throw new AttendanceError(400, "Select an enrolled tutor.");
      }
      if (
        command.kind === "hours" &&
        (!command.canonicalKey ||
          !command.start ||
          !command.end ||
          command.end <= command.start)
      )
        throw new AttendanceError(
          400,
          "Replacement hours require a tutor and a same-day start and end.",
        );
      await tx.insert(s.tutorAttendanceExceptions).values({
        canonicalKey: command.canonicalKey,
        date: command.date,
        kind: command.kind,
        start: command.kind === "hours" ? command.start : null,
        end: command.kind === "hours" ? command.end : null,
        reason: command.reason,
        revision,
      });
    } else {
      command.networks.forEach((n) => networkRule(n.cidr));
    }
    await tx
      .insert(s.tutorAttendanceConfig)
      .values({
        id: "office",
        networks:
          command.action === "networks" ? command.networks : config.networks,
        revision,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: s.tutorAttendanceConfig.id,
        set: {
          networks:
            command.action === "networks" ? command.networks : config.networks,
          revision,
          updatedAt: now,
        },
      });
    await tx.insert(s.tutorAttendanceAudit).values({
      actor: fresh.email,
      action: `settings_${command.action}`,
      canonicalKey: "canonicalKey" in command ? command.canonicalKey : null,
      date: "date" in command ? command.date : null,
      data: { command, revision },
    });
    return { revision };
  });
}
export async function recordAttendancePunch(
  access: AttendanceAccess,
  input: unknown,
  address: string | null,
  db: Database = getDb(),
  now = new Date(),
) {
  const command = punchSchema.parse(input);
  return transaction(access, db, async (tx, fresh) => {
    if (!fresh.canonicalKey)
      throw new AttendanceError(
        403,
        "Only enrolled tutors can clock themselves in or out.",
      );
    const [replay] = await tx
      .select()
      .from(s.tutorAttendanceAudit)
      .where(
        and(
          eq(s.tutorAttendanceAudit.actor, fresh.email),
          eq(s.tutorAttendanceAudit.requestKey, command.idempotencyKey),
        ),
      );
    if (replay) {
      if (
        replay.action !== `clock_${command.kind}` ||
        replay.date !== command.date ||
        replay.canonicalKey !== fresh.canonicalKey
      )
        throw new AttendanceError(
          409,
          "This request key was used for a different action.",
        );
      return { saved: true, replayed: true };
    }
    if (!attendanceEnabled())
      throw new AttendanceError(
        503,
        "Clocking is not enabled yet. Your history and correction requests remain available.",
        "CLOCKING_DISABLED",
      );
    if (command.date !== localDate(now))
      throw new AttendanceError(
        409,
        "The Bangkok date changed. Refresh before clocking.",
      );
    await enrollmentFor(tx, fresh.canonicalKey, command.date);
    const config = await attendanceConfig(tx);
    const network = networkStatus(address, config.networks);
    const day = await dayFor(tx, fresh.canonicalKey, command.date);
    if (day.workMode === "wfh") {
      const [approval] = await tx
        .select()
        .from(s.tutorAttendanceWfhRequests)
        .where(
          and(
            eq(s.tutorAttendanceWfhRequests.id, day.wfhRequestId!),
            eq(s.tutorAttendanceWfhRequests.canonicalKey, fresh.canonicalKey),
            eq(s.tutorAttendanceWfhRequests.date, command.date),
            eq(s.tutorAttendanceWfhRequests.status, "approved"),
          ),
        );
      if (!approval)
        throw new AttendanceError(
          403,
          "WFH approval is no longer available. Refresh before clocking.",
          "WFH_APPROVAL_REQUIRED",
        );
    } else if (!network.approved)
      throw new AttendanceError(
        403,
        "Connect to approved office Wi-Fi, or request WFH and wait for approval before clocking from home.",
        "OFFICE_NETWORK_REQUIRED",
      );
    if (command.kind === "in" && day.effectiveOut)
      throw new AttendanceError(
        409,
        "A departure is already recorded. Request a correction for a missing arrival.",
      );
    const existing = command.kind === "in" ? day.effectiveIn : day.effectiveOut;
    if (!existing) {
      if (command.kind === "out" && day.effectiveIn && now < day.effectiveIn)
        throw new AttendanceError(409, "Departure cannot precede arrival.");
      const fields =
        command.kind === "in"
          ? { recordedIn: day.recordedIn ?? now, effectiveIn: now }
          : { recordedOut: day.recordedOut ?? now, effectiveOut: now };
      await tx
        .update(s.tutorAttendanceDays)
        .set({ ...fields, revision: day.revision + 1 })
        .where(dayWhere(fresh.canonicalKey, command.date));
    }
    await tx.insert(s.tutorAttendanceAudit).values({
      actor: fresh.email,
      action: `clock_${command.kind}`,
      canonicalKey: fresh.canonicalKey,
      date: command.date,
      requestKey: command.idempotencyKey,
      data: {
        occurredAt: (existing ?? now).toISOString(),
        receivedAt: now.toISOString(),
        duplicate: !!existing,
        address,
        network: network.label,
        configRevision: config.revision,
        workMode: day.workMode,
        wfhRequestId: day.wfhRequestId,
        authorization:
          day.workMode === "wfh" ? "approved_wfh" : "office_network",
      },
    });
    return { saved: true, replayed: !!existing };
  });
}
function assertWfhDateEditable(
  date: string,
  day: Awaited<ReturnType<typeof existingDay>>,
  now: Date,
) {
  if (date < localDate(now))
    throw new AttendanceError(
      400,
      "WFH can only be requested or changed for today or a future date.",
      "WFH_DATE_PASSED",
    );
  if (hasAttendanceEvidence(day))
    throw new AttendanceError(
      409,
      "Attendance is already recorded for this date. Its work location cannot be changed.",
      "WORK_LOCATION_LOCKED",
    );
}

export async function requestAttendanceWfh(
  access: AttendanceAccess,
  input: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const command = wfhRequestSchema.parse(input);
  return transaction(access, db, async (tx, fresh) => {
    if (!fresh.canonicalKey)
      throw new AttendanceError(
        403,
        "Only enrolled tutors can request their own WFH day.",
      );
    const [replay] = await tx
      .select()
      .from(s.tutorAttendanceWfhRequests)
      .where(
        and(
          eq(s.tutorAttendanceWfhRequests.requestedBy, fresh.email),
          eq(s.tutorAttendanceWfhRequests.requestKey, command.idempotencyKey),
        ),
      );
    if (replay) {
      if (
        replay.canonicalKey !== fresh.canonicalKey ||
        replay.date !== command.date ||
        replay.reason !== command.reason
      )
        throw new AttendanceError(
          409,
          "This request key was already used for a different WFH request.",
        );
      return { id: replay.id };
    }
    await enrollmentFor(tx, fresh.canonicalKey, command.date);
    assertWfhDateEditable(
      command.date,
      await existingDay(tx, fresh.canonicalKey, command.date),
      now,
    );
    const [active] = await tx
      .select()
      .from(s.tutorAttendanceWfhRequests)
      .where(
        and(
          eq(s.tutorAttendanceWfhRequests.canonicalKey, fresh.canonicalKey),
          eq(s.tutorAttendanceWfhRequests.date, command.date),
          inArray(s.tutorAttendanceWfhRequests.status, ["pending", "approved"]),
        ),
      );
    if (active)
      throw new AttendanceError(
        409,
        "A WFH request for this date is already pending or approved.",
        "WFH_REQUEST_EXISTS",
      );
    const [request] = await tx
      .insert(s.tutorAttendanceWfhRequests)
      .values({
        canonicalKey: fresh.canonicalKey,
        date: command.date,
        reason: command.reason,
        requestedBy: fresh.email,
        requestKey: command.idempotencyKey,
        createdAt: now,
      })
      .returning();
    await tx.insert(s.tutorAttendanceAudit).values({
      actor: fresh.email,
      action: "wfh_requested",
      canonicalKey: fresh.canonicalKey,
      date: command.date,
      data: { id: request.id, command },
    });
    return { id: request.id };
  });
}

export async function decideAttendanceWfh(
  access: AttendanceAccess,
  id: string,
  input: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const command = wfhDecisionSchema.parse(input);
  return transaction(access, db, async (tx, fresh) => {
    const [request] = await tx
      .select()
      .from(s.tutorAttendanceWfhRequests)
      .where(eq(s.tutorAttendanceWfhRequests.id, id));
    if (
      !request ||
      (!fresh.admin && request.canonicalKey !== fresh.canonicalKey)
    )
      throw new AttendanceError(404, "WFH request not found.");
    const cancelling = command.decision === "cancelled";
    if (!cancelling) {
      requireAttendanceAdmin(fresh);
      if (
        request.requestedBy === fresh.email ||
        request.canonicalKey === fresh.canonicalKey
      )
        throw new AttendanceError(
          403,
          "Another administrator must review your own WFH request.",
        );
    }
    if (
      request.status === command.decision &&
      request.revision === command.expectedRevision + 1 &&
      (cancelling
        ? request.cancelledBy === fresh.email &&
          request.cancellationReason === command.reason
        : request.reviewedBy === fresh.email &&
          request.reviewReason === command.reason)
    )
      return { saved: true, replayed: true };
    assertRevision(request.revision, command.expectedRevision);
    if (
      request.status !== "pending" &&
      !(cancelling && request.status === "approved")
    )
      throw new AttendanceError(
        409,
        "This WFH request has already been resolved.",
      );

    if (
      command.decision === "approved" ||
      (cancelling && request.status === "approved")
    ) {
      const day = await dayFor(tx, request.canonicalKey, request.date);
      assertWfhDateEditable(request.date, day, now);
      if (command.decision === "approved")
        await enrollmentFor(tx, request.canonicalKey, request.date);
      else if (day.wfhRequestId !== request.id)
        throw new AttendanceError(
          409,
          "This attendance record changed. Refresh before cancelling WFH.",
        );
      await tx
        .update(s.tutorAttendanceDays)
        .set({
          workMode: cancelling ? "office" : "wfh",
          wfhRequestId: cancelling ? null : request.id,
          revision: day.revision + 1,
        })
        .where(dayWhere(request.canonicalKey, request.date));
    }
    await tx
      .update(s.tutorAttendanceWfhRequests)
      .set({
        status: command.decision,
        revision: request.revision + 1,
        ...(cancelling
          ? {
              cancelledBy: fresh.email,
              cancellationReason: command.reason,
              cancelledAt: now,
            }
          : {
              reviewedBy: fresh.email,
              reviewReason: command.reason,
              reviewedAt: now,
            }),
      })
      .where(eq(s.tutorAttendanceWfhRequests.id, id));
    await tx.insert(s.tutorAttendanceAudit).values({
      actor: fresh.email,
      action: `wfh_${command.decision}`,
      canonicalKey: request.canonicalKey,
      date: request.date,
      data: {
        id,
        reason: command.reason,
        before: request,
        revision: request.revision + 1,
      },
    });
    return { saved: true, replayed: false };
  });
}
export async function requestAttendanceCorrection(
  access: AttendanceAccess,
  input: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const command = correctionSchema.parse(input);
  return transaction(access, db, async (tx, fresh) => {
    if (!fresh.canonicalKey)
      throw new AttendanceError(
        403,
        "Only an enrolled tutor can request their own correction.",
      );
    const [replay] = await tx
      .select()
      .from(s.tutorAttendanceCorrections)
      .where(
        and(
          eq(s.tutorAttendanceCorrections.requestedBy, fresh.email),
          eq(s.tutorAttendanceCorrections.requestKey, command.idempotencyKey),
        ),
      );
    const proposedIn = command.proposedIn
      ? instant(command.date, command.proposedIn)
      : null;
    const proposedOut = command.proposedOut
      ? instant(command.date, command.proposedOut)
      : null;
    if (replay) {
      if (
        replay.canonicalKey !== fresh.canonicalKey ||
        replay.date !== command.date ||
        replay.reason !== command.reason ||
        replay.expectedRevision !== command.expectedRevision ||
        replay.proposedIn?.getTime() !== proposedIn?.getTime() ||
        replay.proposedOut?.getTime() !== proposedOut?.getTime()
      )
        throw new AttendanceError(
          409,
          "This request key was already used for a different correction.",
        );
      return { id: replay.id };
    }
    await enrollmentFor(tx, fresh.canonicalKey, command.date);
    if (
      command.date > localDate(now) ||
      (proposedIn && proposedIn > now) ||
      (proposedOut && proposedOut > now)
    )
      throw new AttendanceError(
        400,
        "Corrections cannot record a time in the future.",
      );
    if (!proposedIn && !proposedOut)
      throw new AttendanceError(400, "Provide an arrival or departure time.");
    if (proposedIn && proposedOut && proposedOut < proposedIn)
      throw new AttendanceError(400, "Departure cannot precede arrival.");
    const day = await dayFor(tx, fresh.canonicalKey, command.date);
    assertRevision(day.revision, command.expectedRevision);
    const [pending] = await tx
      .select()
      .from(s.tutorAttendanceCorrections)
      .where(
        and(
          eq(s.tutorAttendanceCorrections.canonicalKey, fresh.canonicalKey),
          eq(s.tutorAttendanceCorrections.date, command.date),
          eq(s.tutorAttendanceCorrections.status, "pending"),
        ),
      );
    if (pending)
      throw new AttendanceError(
        409,
        "A correction for this date is already awaiting review.",
      );
    const [row] = await tx
      .insert(s.tutorAttendanceCorrections)
      .values({
        canonicalKey: fresh.canonicalKey,
        date: command.date,
        proposedIn,
        proposedOut,
        reason: command.reason,
        expectedRevision: day.revision,
        requestedBy: fresh.email,
        requestKey: command.idempotencyKey,
      })
      .returning();
    await tx.insert(s.tutorAttendanceAudit).values({
      actor: fresh.email,
      action: "correction_requested",
      canonicalKey: fresh.canonicalKey,
      date: command.date,
      data: { id: row.id, command },
    });
    return { id: row.id };
  });
}
export async function reviewAttendanceCorrection(
  access: AttendanceAccess,
  id: string,
  input: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const command = reviewSchema.parse(input);
  return transaction(access, db, async (tx, fresh) => {
    requireAttendanceAdmin(fresh);
    const [request] = await tx
      .select()
      .from(s.tutorAttendanceCorrections)
      .where(eq(s.tutorAttendanceCorrections.id, id));
    if (!request)
      throw new AttendanceError(404, "Correction request not found.");
    if (request.requestedBy === fresh.email)
      throw new AttendanceError(
        403,
        "Another administrator must review your own correction.",
      );
    if (request.status !== "pending")
      throw new AttendanceError(409, "This request has already been reviewed.");
    const day = await dayFor(tx, request.canonicalKey, request.date);
    assertRevision(day.revision, command.expectedRevision);
    if (command.decision === "approved") {
      assertRevision(day.revision, request.expectedRevision);
      await tx
        .update(s.tutorAttendanceDays)
        .set({
          effectiveIn: request.proposedIn,
          effectiveOut: request.proposedOut,
          corrected: true,
          revision: day.revision + 1,
        })
        .where(dayWhere(request.canonicalKey, request.date));
    }
    await tx
      .update(s.tutorAttendanceCorrections)
      .set({
        status: command.decision,
        reviewedBy: fresh.email,
        reviewReason: command.reason,
        reviewedAt: now,
      })
      .where(eq(s.tutorAttendanceCorrections.id, id));
    await tx.insert(s.tutorAttendanceAudit).values({
      actor: fresh.email,
      action: `correction_${command.decision}`,
      canonicalKey: request.canonicalKey,
      date: request.date,
      data: {
        id,
        reason: command.reason,
        before: day,
        proposedIn: request.proposedIn,
        proposedOut: request.proposedOut,
      },
    });
    return { saved: true };
  });
}
