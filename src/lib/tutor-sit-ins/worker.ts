import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import {
  createAppsScriptScheduleEmailSender,
  type ScheduleEmailSender,
} from "@/lib/classrooms/schedule-email";
import { renderTeacherEmail } from "@/lib/teacher-emails/render";
import { teacherEmailLogoUrl } from "@/lib/teacher-emails/brand";
import { accessForEmail, assertScope } from "./access";
import {
  appOrigin,
  calendarConnection,
  calendarProvider,
  assertCalendarBooking,
} from "./calendar";
import type { CalendarEvent } from "./calendar-provider";
import {
  assertDeliveryRecipients,
  scopeOf,
  scopeLabel,
  issueFromError,
  type ReadinessIssue,
  defaultQuarter,
  deliveryEnabled,
  enabled,
  localDate,
  REPORT_WINDOW_MS,
  tutorInvitationEmail,
  SitInError,
  ZONE,
} from "./model";
import {
  claimJob,
  generateAssignments,
  invalidateObservation,
  queueJob,
  withObserverOperation,
  type Observation,
} from "./repository";
import { loadSources, suggestionsFor, verifyLiveLesson } from "./sources";

export function eventMatches(observation: Observation, event: CalendarEvent) {
  return (
    event.id === observation.eventId &&
    event.status !== "cancelled" &&
    (observation.calendarProvider !== "microsoft" ||
      event.visibility === "private") &&
    event.extendedProperties?.private?.sitInObservationId === observation.id &&
    Date.parse(event.start?.dateTime || "") ===
      observation.startTime.getTime() &&
    Date.parse(event.end?.dateTime || "") === observation.endTime.getTime() &&
    event.summary ===
      "BeGifted Sit-in · " +
        observation.lesson.title +
        " · " +
        observation.lesson.tutorName &&
    event.description ===
      "Quarterly tutor observation. Details: " +
        appOrigin() +
        "/tutor-sit-ins/" +
        observation.assignmentId &&
    !!observation.lesson.tutorEmail &&
    event.attendees?.length === 1 &&
    event.attendees[0].email?.toLowerCase() === observation.lesson.tutorEmail &&
    (event.location || "") === (observation.lesson.location || "")
  );
}
async function rememberEventId(
  observation: Observation,
  event: CalendarEvent | null,
  db: Database,
) {
  if (event && !observation.eventId) {
    if (
      event.extendedProperties?.private?.sitInObservationId !== observation.id
    )
      throw new SitInError(
        409,
        "Calendar event ownership could not be verified.",
      );
    await db
      .update(s.tutorSitInObservations)
      .set({ eventId: event.id })
      .where(
        and(
          eq(s.tutorSitInObservations.id, observation.id),
          isNull(s.tutorSitInObservations.eventId),
        ),
      );
    observation.eventId = event.id;
  }
  return event;
}
export async function observationEvent(observation: Observation, db: Database) {
  if (!observation.calendarProvider || !observation.calendarId) return null;
  const { provider } = await calendarProvider(
    observation.observerEmail,
    db,
    observation,
  );
  return rememberEventId(
    observation,
    await provider.findEvent({
      calendarId: observation.calendarId,
      eventId: observation.eventId,
      observationId: observation.id,
    }),
    db,
  );
}
const calendarDiscrepancy = () =>
  new SitInError(
    409,
    "The exported Calendar event was changed or removed. Review the Calendar copy; the Wise booking remains confirmed.",
    "CALENDAR_DISCREPANCY",
  );
const missedInvitation = () =>
  new SitInError(
    409,
    "The lesson has started. No new Calendar invitation will be created; the observation and report remain available.",
    "CALENDAR_MISSED",
  );
export async function publishObservation(observationId: string, db: Database) {
  const [initial] = await db
    .select()
    .from(s.tutorSitInObservations)
    .where(eq(s.tutorSitInObservations.id, observationId));
  if (!initial?.current) return;
  await withObserverOperation(
    db,
    initial.observerEmail,
    async (assertLease) => {
      let [observation] = await db
        .select()
        .from(s.tutorSitInObservations)
        .where(eq(s.tutorSitInObservations.id, observationId));
      if (!observation?.current) return;
      const [assignment] = await db
        .select()
        .from(s.tutorSitInAssignments)
        .where(eq(s.tutorSitInAssignments.id, observation.assignmentId));
      try {
        const access = await accessForEmail(observation.observerEmail, db);
        assertScope(access, scopeOf(assignment), true);
      } catch (error) {
        if (error instanceof SitInError)
          throw new SitInError(error.status, error.message, "HEAD_UNAVAILABLE");
        throw error;
      }
      if (assignment.observerEmail !== observation.observerEmail)
        throw new SitInError(
          409,
          "The assigned observer changed.",
          "HEAD_UNAVAILABLE",
        );
      // Before any attempted send there cannot be an event to recover.
      if (
        observation.startTime <= new Date() &&
        !observation.calendarAttemptedAt &&
        !observation.calendarSyncedAt
      )
        throw missedInvitation();
      if (observation.startTime > new Date()) {
        const sources = await loadSources(assignment.quarter, db);
        await verifyLiveLesson(assignment, observation.lesson, sources, db, {
          observation,
          requireAdvance: false,
        });
      }
      const connection = await calendarConnection(
        observation.observerEmail,
        db,
      );
      if (!observation.calendarProvider || !observation.calendarId) {
        assertCalendarBooking(connection.provider);
        const { provider } = await calendarProvider(
          observation.observerEmail,
          db,
        );
        const calendars = await provider.list();
        const destination = calendars.find(
          (c) =>
            c.id === connection.calendarId ||
            (connection.calendarId === "primary" && c.primary),
        );
        if (!destination || destination.accessRole !== "owner")
          throw new SitInError(
            409,
            "Choose an owned calendar for event delivery.",
            "CALENDAR_DESTINATION",
          );
        await assertLease();
        const [bound] = await db
          .update(s.tutorSitInObservations)
          .set({
            calendarProvider: connection.provider,
            calendarAccountId: connection.providerAccountId,
            calendarId: destination.id,
            eventId:
              connection.provider === "google"
                ? observation.id.replaceAll("-", "")
                : null,
          })
          .where(
            and(
              eq(s.tutorSitInObservations.id, observation.id),
              eq(s.tutorSitInObservations.current, true),
            ),
          )
          .returning();
        if (!bound) return;
        observation = bound;
      }
      let event = await observationEvent(observation, db);
      if (event && !eventMatches(observation, event))
        throw calendarDiscrepancy();
      if (
        !event &&
        (observation.calendarSyncedAt ||
          observation.calendarStatus === "synced" ||
          observation.calendarStatus === "discrepancy")
      )
        throw calendarDiscrepancy();
      if (!event) {
        if (observation.startTime <= new Date()) throw missedInvitation();
        assertCalendarBooking(observation.calendarProvider!);
        if (!observation.calendarAttemptedAt) {
          const [contact] = await db
            .select()
            .from(s.tutorContacts)
            .where(
              and(
                eq(s.tutorContacts.canonicalKey, assignment.canonicalKey),
                eq(s.tutorContacts.active, true),
              ),
            );
          const tutorEmail = tutorInvitationEmail(
            contact,
            observation.lesson.modality,
          );
          observation.lesson = { ...observation.lesson, tutorEmail };
        }
        const tutorEmail = observation.lesson.tutorEmail;
        if (!tutorEmail)
          throw new SitInError(
            409,
            "The tutor's invitation email needs administrator review.",
            "CALENDAR_RECIPIENT",
          );
        assertDeliveryRecipients([connection.accountEmail, tutorEmail]);
        await assertLease();
        const [sending] = await db
          .update(s.tutorSitInObservations)
          .set({
            lesson: observation.lesson,
            calendarAttemptedAt: observation.calendarAttemptedAt || new Date(),
          })
          .where(
            and(
              eq(s.tutorSitInObservations.id, observation.id),
              eq(s.tutorSitInObservations.current, true),
            ),
          )
          .returning();
        if (!sending) return;
        observation = sending;
        if (observation.startTime <= new Date()) throw missedInvitation();
        const { provider } = await calendarProvider(
          observation.observerEmail,
          db,
          observation,
        );
        event = await rememberEventId(
          observation,
          await provider.createEvent({
            observationId: observation.id,
            eventId: observation.eventId,
            calendarId: observation.calendarId!,
            summary:
              "BeGifted Sit-in · " +
              observation.lesson.title +
              " · " +
              observation.lesson.tutorName,
            description:
              "Quarterly tutor observation. Details: " +
              appOrigin() +
              "/tutor-sit-ins/" +
              assignment.id,
            location: observation.lesson.location || "",
            start: observation.startTime,
            end: observation.endTime,
            tutorEmail,
          }),
          db,
        );
      }
      if (!event || !eventMatches(observation, event))
        throw calendarDiscrepancy();
      const verified = event;
      await withDatabaseTransaction(db, async (tx) => {
        const [fresh] = await tx
          .select()
          .from(s.tutorSitInObservations)
          .where(eq(s.tutorSitInObservations.id, observation.id))
          .for("update");
        if (!fresh.current) {
          await queueJob(
            tx,
            observation.id + ":delete",
            "calendar_delete",
            observation.id,
          );
          return;
        }
        await tx
          .update(s.tutorSitInObservations)
          .set({
            calendarStatus: "synced",
            calendarError: null,
            calendarSyncedAt: fresh.calendarSyncedAt || new Date(),
            eventEtag: verified.etag || null,
            eventUrl: verified.htmlLink || null,
          })
          .where(eq(s.tutorSitInObservations.id, observation.id));
      });
    },
  );
}
export function observationEmail(
  observation: Observation,
  kind: string,
  reason?: string,
) {
  const when =
    formatInTimeZone(observation.startTime, ZONE, "EEE d MMM yyyy, HH:mm") +
    "–" +
    formatInTimeZone(observation.endTime, ZONE, "HH:mm") +
    " Bangkok";
  const cancelled = kind === "cancelled";
  const title = cancelled
    ? "Observation needs rescheduling"
    : "A tutor observation is confirmed";
  return renderTeacherEmail({
    subject: "[BeGifted] " + title + " · " + observation.lesson.tutorName,
    preheader: when,
    category: "Tutor quality assurance",
    title,
    greeting: "Hello,",
    paragraphs: [
      cancelled
        ? "Please inform the affected families that this observation has been withdrawn. A replacement needs to be confirmed in Tutor Sit-ins."
        : "Please inform the parent and student about this sit-in and record both acknowledgements in Tutor Sit-ins.",
    ],
    sections: [
      {
        heading: "Observation details",
        details: [
          { label: "Tutor", value: observation.lesson.tutorName },
          { label: "Observer", value: observation.observerEmail },
          { label: "Class", value: observation.lesson.title },
          { label: "When", value: when },
          {
            label: "Location",
            value:
              observation.lesson.location ||
              observation.lesson.modality ||
              "Needs review",
          },
        ],
        ...(reason ? { paragraphs: [reason] } : {}),
      },
      {
        heading: "Affected students",
        bullets: observation.lesson.participants.map(
          (p) =>
            p.studentName + " · Parent: " + (p.parentName || "Needs review"),
        ),
      },
      {
        heading: "Staff coordination",
        action: {
          label: "Open observation",
          url: appOrigin() + "/tutor-sit-ins/" + observation.assignmentId,
        },
      },
    ],
    logoUrl: teacherEmailLogoUrl(appOrigin()),
  });
}
async function digestEmail(email: string, quarter: string, db: Database) {
  const rows = await db
    .select()
    .from(s.tutorSitInAssignments)
    .where(
      and(
        eq(s.tutorSitInAssignments.observerEmail, email),
        eq(s.tutorSitInAssignments.quarter, quarter),
      ),
    );
  const observations = await db
    .select()
    .from(s.tutorSitInObservations)
    .where(
      and(
        eq(s.tutorSitInObservations.observerEmail, email),
        eq(s.tutorSitInObservations.current, true),
      ),
    );
  const actionable = rows.filter(
    (a) => !["completed", "exempt", "superseded"].includes(a.status),
  );
  if (!actionable.length) return null;
  return renderTeacherEmail({
    subject: "[BeGifted] Tutor sit-ins · " + actionable.length + " outstanding",
    preheader: quarter + " observations and report deadlines",
    category: "Tutor quality assurance",
    title: "Your observation worklist",
    greeting: "Hello,",
    paragraphs: [
      "Review suitable lessons, upcoming observations and reports due within 48 hours of the lesson.",
    ],
    sections: [
      {
        heading: quarter,
        bullets: actionable.slice(0, 40).map((a) => {
          const observation = observations.find((o) => o.assignmentId === a.id);
          return (
            a.tutorName +
            " · " +
            scopeLabel(a) +
            " · " +
            (observation
              ? "Lesson " +
                formatInTimeZone(observation.startTime, ZONE, "d MMM HH:mm") +
                "; report due " +
                formatInTimeZone(
                  new Date(observation.endTime.getTime() + REPORT_WINDOW_MS),
                  ZONE,
                  "d MMM HH:mm",
                )
              : a.suggestions.length
                ? a.suggestions.length + " suitable lessons"
                : a.suggestionError || "Awaiting a suitable lesson")
          );
        }),
        action: {
          label: "Open Tutor Sit-ins",
          url: appOrigin() + "/tutor-sit-ins?quarter=" + quarter,
        },
      },
    ],
    logoUrl: teacherEmailLogoUrl(appOrigin()),
  });
}
export async function processJobs(
  db: Database = getDb(),
  options: {
    limit?: number;
    observationId?: string;
    sender?: ScheduleEmailSender;
    deadlineAt?: number;
  } = {},
) {
  const canDeliver = deliveryEnabled();
  const now = new Date(),
    owner = randomUUID(),
    result = { sent: 0, failed: 0 };
  const jobs = await db
    .select()
    .from(s.tutorSitInJobs)
    .where(
      and(
        inArray(s.tutorSitInJobs.status, ["pending", "failed", "running"]),
        canDeliver
          ? undefined
          : sql`EXISTS (
          SELECT 1 FROM tutor_sit_in_observations o
          WHERE o.id = ${s.tutorSitInJobs.observationId}
          AND o.calendar_attempted_at IS NULL AND o.calendar_synced_at IS NULL
          AND o.event_etag IS NULL AND o.event_url IS NULL
          AND (${s.tutorSitInJobs.kind} = 'calendar_delete'
            OR (${s.tutorSitInJobs.kind} = 'calendar_upsert' AND o.start_time <= ${now}))
        )`,
        lt(s.tutorSitInJobs.retryAt, new Date(now.getTime() + 1)),
        options.observationId
          ? eq(s.tutorSitInJobs.observationId, options.observationId)
          : undefined,
      ),
    )
    .orderBy(s.tutorSitInJobs.createdAt)
    .limit(options.limit || 30);
  for (const candidate of jobs) {
    if (Date.now() > (options.deadlineAt || Infinity) - 90_000) break;
    let observation: Observation | undefined;
    if (candidate.observationId)
      [observation] = await db
        .select()
        .from(s.tutorSitInObservations)
        .where(eq(s.tutorSitInObservations.id, candidate.observationId));
    const neverSent =
      observation &&
      !observation.calendarAttemptedAt &&
      !observation.calendarSyncedAt &&
      !observation.eventEtag &&
      !observation.eventUrl;
    const localOnly =
      neverSent &&
      (candidate.kind === "calendar_delete" ||
        (candidate.kind === "calendar_upsert" &&
          observation &&
          observation.startTime <= now));
    if (!canDeliver && !localOnly) continue;
    const job = await claimJob(db, candidate.id, owner);
    if (!job) continue;
    try {
      let skipped = false;
      if (job.kind === "calendar_upsert") {
        if (observation?.current) await publishObservation(observation.id, db);
        else skipped = true;
      } else if (job.kind === "calendar_delete") {
        if (observation)
          await withObserverOperation(
            db,
            observation.observerEmail,
            async (assertLease) => {
              const [obsolete] = await db
                .select()
                .from(s.tutorSitInObservations)
                .where(eq(s.tutorSitInObservations.id, observation!.id));
              if (obsolete.current)
                throw new SitInError(
                  409,
                  "The current observation cannot be withdrawn.",
                );
              const mayHaveEvent =
                obsolete.calendarAttemptedAt ||
                obsolete.calendarSyncedAt ||
                obsolete.eventEtag ||
                obsolete.eventUrl;
              if (
                obsolete.calendarProvider &&
                obsolete.calendarId &&
                mayHaveEvent
              ) {
                const connection = await calendarConnection(
                  obsolete.observerEmail,
                  db,
                );
                assertDeliveryRecipients([
                  connection.accountEmail,
                  obsolete.lesson.tutorEmail || "",
                ]);
                const event = await observationEvent(obsolete, db);
                if (event && event.status !== "cancelled") {
                  assertDeliveryRecipients([
                    connection.accountEmail,
                    ...(event.attendees || []).map((a) => a.email || ""),
                  ]);
                  if (
                    event.extendedProperties?.private?.sitInObservationId !==
                    obsolete.id
                  )
                    throw new SitInError(
                      409,
                      "Calendar event ownership could not be verified.",
                    );
                  await assertLease();
                  const { provider } = await calendarProvider(
                    obsolete.observerEmail,
                    db,
                    obsolete,
                  );
                  await provider.cancelEvent({
                    calendarId: obsolete.calendarId,
                    eventId: obsolete.eventId,
                    observationId: obsolete.id,
                  });
                }
              }
              await assertLease();
              await db
                .update(s.tutorSitInObservations)
                .set({ calendarStatus: "cancelled", calendarError: null })
                .where(eq(s.tutorSitInObservations.id, obsolete.id));
            },
            { cleanup: true },
          );
      } else if (job.recipient) {
        let recipientAccess;
        try {
          recipientAccess = await accessForEmail(job.recipient, db);
        } catch {
          skipped = true;
        }
        const kind = String(
          job.payload.kind ||
            (job.kind === "head_alert" ? "cancelled" : "confirmed"),
        );
        if (observation && recipientAccess) {
          const [assignment] = await db
            .select()
            .from(s.tutorSitInAssignments)
            .where(eq(s.tutorSitInAssignments.id, observation.assignmentId));
          try {
            assertScope(recipientAccess, scopeOf(assignment));
          } catch {
            skipped = true;
          }
          if (
            kind === "confirmed" &&
            (!observation.current || !!observation.invalidReason)
          )
            skipped = true;
        }
        if (job.kind === "digest" && job.key.split(":")[1] !== localDate())
          skipped = true;
        if (!skipped) {
          const content =
            job.kind === "digest"
              ? await digestEmail(
                  job.recipient,
                  String(job.payload.quarter),
                  db,
                )
              : observation
                ? observationEmail(
                    observation,
                    kind,
                    typeof job.payload.reason === "string"
                      ? job.payload.reason
                      : observation.invalidReason || undefined,
                  )
                : null;
          if (content) {
            assertDeliveryRecipients([job.recipient]);
            await (
              options.sender || createAppsScriptScheduleEmailSender()
            ).sendEmail({
              to: job.recipient,
              ...content,
              idempotencyKey: "tutor-sit-ins:" + job.key,
            });
          } else skipped = true;
        }
      }
      await db
        .update(s.tutorSitInJobs)
        .set({
          status: skipped ? "superseded" : "sent",
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(s.tutorSitInJobs.id, job.id),
            eq(s.tutorSitInJobs.leaseOwner, owner),
          ),
        );
      result.sent++;
    } catch (e) {
      const message =
        e instanceof SitInError
          ? e.message
          : "Delivery failed. The next worker run will retry.";
      await db
        .update(s.tutorSitInJobs)
        .set({
          status:
            e instanceof SitInError &&
            ["CALENDAR_DISCREPANCY", "CALENDAR_MISSED"].includes(e.code)
              ? "superseded"
              : "failed",
          lastError: message,
          retryAt: new Date(
            Date.now() + Math.min(60, 2 ** Math.min(job.attempts, 6)) * 60_000,
          ),
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(s.tutorSitInJobs.id, job.id),
            eq(s.tutorSitInJobs.leaseOwner, owner),
          ),
        );
      if (observation && job.kind.startsWith("calendar_")) {
        await db
          .update(s.tutorSitInObservations)
          .set({
            calendarError: message,
            ...(job.kind === "calendar_upsert"
              ? {
                  calendarStatus:
                    e instanceof SitInError && e.code === "CALENDAR_RECONNECT"
                      ? "connection_required"
                      : e instanceof SitInError &&
                          e.code === "CALENDAR_DISCREPANCY"
                        ? "discrepancy"
                        : e instanceof SitInError &&
                            e.code === "CALENDAR_MISSED"
                          ? "missed"
                          : "error",
                }
              : {}),
          })
          .where(eq(s.tutorSitInObservations.id, observation.id));
        if (
          observation.current &&
          e instanceof SitInError &&
          ["LESSON_CHANGED", "HEAD_UNAVAILABLE"].includes(e.code)
        )
          await invalidateObservation(
            db,
            observation,
            message,
            "system:calendar",
          );
      }
      result.failed++;
    }
  }
  return result;
}
export async function runSitInWorker(db: Database = getDb(), now = new Date()) {
  if (!enabled()) return { ok: true, skipped: true, reason: "disabled" };
  const owner = randomUUID(),
    deadlineAt = Date.now() + 270_000;
  await db
    .insert(s.tutorSitInWorkerState)
    .values({ key: "worker" })
    .onConflictDoNothing();
  const [claim] = await db
    .update(s.tutorSitInWorkerState)
    .set({ owner, leaseUntil: new Date(now.getTime() + 300_000) })
    .where(
      and(
        eq(s.tutorSitInWorkerState.key, "worker"),
        or(
          isNull(s.tutorSitInWorkerState.owner),
          lt(s.tutorSitInWorkerState.leaseUntil, now),
        ),
      ),
    )
    .returning();
  if (!claim) return { ok: true, skipped: true, reason: "running" };
  let checked = 0,
    failures = 0;
  try {
    const initialDeliveries = await processJobs(db, { deadlineAt, limit: 15 });
    const quarter = defaultQuarter(now);
    const quarters = new Set([quarter]);
    const outstanding = await db
      .select()
      .from(s.tutorSitInAssignments)
      .where(
        inArray(s.tutorSitInAssignments.status, [
          "pending",
          "scheduled",
          "needs_rescheduling",
        ]),
      );
    outstanding.forEach((a) => quarters.add(a.quarter));
    for (const q of quarters) {
      if (Date.now() > deadlineAt - 90_000) break;
      let sources;
      try {
        sources = await loadSources(q, db, now);
      } catch {
        failures++;
        continue;
      }
      await generateAssignments(q, sources, db);
      const assignments = await db
        .select()
        .from(s.tutorSitInAssignments)
        .where(eq(s.tutorSitInAssignments.quarter, q));
      assignments.sort(
        (a, b) => (a.checkedAt?.getTime() || 0) - (b.checkedAt?.getTime() || 0),
      );
      for (const assignment of assignments) {
        if (Date.now() > deadlineAt - 90_000) break;
        if (["pending", "needs_rescheduling"].includes(assignment.status)) {
          let suggestions: typeof assignment.suggestions = [],
            error: string | null = null;
          let readinessIssues: ReadinessIssue[] = [];
          try {
            suggestions = await suggestionsFor(assignment, sources, db, now);
          } catch (e) {
            readinessIssues = [issueFromError(e)];
            error =
              e instanceof SitInError
                ? e.message
                : "Availability could not be refreshed.";
          }
          await db
            .update(s.tutorSitInAssignments)
            .set({
              suggestions,
              suggestionError: error,
              readinessIssues,
              checkedAt: now,
            })
            .where(
              and(
                eq(s.tutorSitInAssignments.id, assignment.id),
                eq(s.tutorSitInAssignments.revision, assignment.revision),
              ),
            );
        } else if (assignment.status === "scheduled") {
          const [observation] = await db
            .select()
            .from(s.tutorSitInObservations)
            .where(
              and(
                eq(s.tutorSitInObservations.assignmentId, assignment.id),
                eq(s.tutorSitInObservations.current, true),
                gt(s.tutorSitInObservations.startTime, now),
              ),
            );
          if (observation) {
            if (
              !(await reconcileObservation(
                db,
                assignment,
                observation,
                sources,
                now,
              ))
            )
              failures++;
          }
        }
        await db
          .update(s.tutorSitInAssignments)
          .set({ checkedAt: now })
          .where(eq(s.tutorSitInAssignments.id, assignment.id));
        checked++;
      }
    }
    await queueDailyDigests(db, now);
    const deliveries = await processJobs(db, { deadlineAt });
    return {
      ok:
        failures === 0 &&
        deliveries.failed === 0 &&
        initialDeliveries.failed === 0,
      checked,
      failures,
      deliveries,
    };
  } finally {
    await db
      .update(s.tutorSitInWorkerState)
      .set({ owner: null, leaseUntil: null, finishedAt: new Date() })
      .where(
        and(
          eq(s.tutorSitInWorkerState.key, "worker"),
          eq(s.tutorSitInWorkerState.owner, owner),
        ),
      );
  }
}

export async function queueDailyDigests(
  db: Database = getDb(),
  now = new Date(),
) {
  if (!enabled() || Number(formatInTimeZone(now, ZONE, "H")) < 8) return;
  const rows = await db
    .select({
      quarter: s.tutorSitInAssignments.quarter,
      email: s.tutorSitInAssignments.observerEmail,
    })
    .from(s.tutorSitInAssignments)
    .where(
      inArray(s.tutorSitInAssignments.status, [
        "pending",
        "scheduled",
        "needs_rescheduling",
      ]),
    );
  for (const row of rows)
    if (row.email)
      await queueJob(
        db,
        "digest:" + localDate(now) + ":" + row.quarter + ":" + row.email,
        "digest",
        null,
        row.email,
        { quarter: row.quarter },
      );
}

export async function reconcileObservation(
  db: Database,
  assignment: typeof s.tutorSitInAssignments.$inferSelect,
  observation: Observation,
  sources: Awaited<ReturnType<typeof loadSources>>,
  now = new Date(),
) {
  try {
    await verifyLiveLesson(assignment, observation.lesson, sources, db, {
      observation,
      now,
      requireAdvance: false,
    });
    await db
      .update(s.tutorSitInAssignments)
      .set({ readinessIssues: [] })
      .where(
        and(
          eq(s.tutorSitInAssignments.id, assignment.id),
          eq(s.tutorSitInAssignments.revision, assignment.revision),
        ),
      );
  } catch (e) {
    if (
      e instanceof SitInError &&
      ["LESSON_CHANGED", "HEAD_UNAVAILABLE"].includes(e.code)
    ) {
      await invalidateObservation(
        db,
        observation,
        e.message,
        "system:reconcile",
      );
    } else {
      await db
        .update(s.tutorSitInAssignments)
        .set({ readinessIssues: [issueFromError(e)] })
        .where(
          and(
            eq(s.tutorSitInAssignments.id, assignment.id),
            eq(s.tutorSitInAssignments.revision, assignment.revision),
          ),
        );
      return false;
    }
    return true;
  }
  // Calendar verification is independent and reads only the exported event.
  if (observation.calendarSyncedAt || observation.calendarStatus === "synced") {
    try {
      const event = await observationEvent(observation, db);
      if (!event || !eventMatches(observation, event))
        throw calendarDiscrepancy();
      await db
        .update(s.tutorSitInObservations)
        .set({ calendarStatus: "synced", calendarError: null })
        .where(eq(s.tutorSitInObservations.id, observation.id));
    } catch (e) {
      await db
        .update(s.tutorSitInObservations)
        .set({
          calendarStatus:
            e instanceof SitInError && e.code === "CALENDAR_DISCREPANCY"
              ? "discrepancy"
              : "error",
          calendarError:
            e instanceof SitInError
              ? e.message
              : "Calendar delivery could not be verified. The Wise booking remains confirmed.",
        })
        .where(eq(s.tutorSitInObservations.id, observation.id));
    }
  }
  return true;
}
