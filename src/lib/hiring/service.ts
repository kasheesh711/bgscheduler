import { createHash, randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { and, asc, desc, eq, gte, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { availableSlots, availableVisitSlots, verifyLiveSlot } from "./availability";
import {
  baseConfigSchema,
  withSeekJobs,
  bookingSchema,
  configRuleErrors,
  configSchema,
  HiringError,
  instant,
  PRE_SCREEN_URL,
  normalizeSubjects,
  overlap,
  runtimeWritesAllowed,
  shiftDate,
  isDecided,
  localDate,
  visitBookingSchema,
  ZONE,
  type HiringConfig,
  type Stage,
  type Subject,
} from "./model";
import {
  availabilityFraction,
  hardStops,
  preScreenPoints,
  profileScore,
  supportedVisitSubjects,
  topHiringSubject,
  workRightsAccepted,
} from "./scoring";
import { googleConnectionStatus } from "./google";
import { visitClashes } from "./head-schedule";
import { bookingToken, readBookingToken, VISIT_LINK_DAYS } from "./tokens";
import { blockingLimit, headWeekMocks, releaseQueue, type Funnel, type LimitName, type QueueHold } from "./limits";
import {
  inviteRows,
  linkSentAt,
  lockQueue,
  callQueue,
  onsiteQueue,
  preScreenQueue,
  preScreenTotal,
  readLimitUsage,
} from "./queue";
import { profileGate } from "./insights";
import { headDayState, weekWith } from "./rules";
import { attendanceAccessForEmail } from "@/lib/tutor-attendance/access";
import { attendanceConfig } from "@/lib/tutor-attendance/data";
import { saveAttendanceSettings } from "@/lib/tutor-attendance/service";
import { applicableSchedule, AttendanceError, weekSchema, type Week } from "@/lib/tutor-attendance/model";
import { formatInTimeZone } from "date-fns-tz";

export type Candidate = typeof s.hiringCandidates.$inferSelect;
export async function settings(db: Database = getDb()) {
  const [row] = await db
    .select()
    .from(s.hiringSettings)
    .where(eq(s.hiringSettings.id, "default"));
  // Reads use the shape without the cross-field rules, so a stored config that breaks one still loads.
  // The dashboard lists the problem, and `saveSettings` refuses to store it again.
  return { row, config: baseConfigSchema.parse(withSeekJobs(row?.config ?? {})) };
}
export async function audit(
  db: Database,
  actor: string,
  action: string,
  candidateId: string | null,
  detail: Record<string, unknown> = {},
) {
  await db.insert(s.hiringAudit).values({ actor, action, candidateId, detail });
}
export async function saveSettings(
  value: unknown,
  revision: number,
  actor: string,
  db: Database = getDb(),
) {
  const config = configSchema.parse(value);
  if (
    (config.enabled || config.deliveryEnabled) &&
    (!config.rubricApproved || !runtimeWritesAllowed())
  )
    throw new HiringError(
      409,
      "Approve the rubric and enable the production write gate before starting automation.",
    );
  if (
    config.enabled &&
    (!config.interviewers.length ||
      new Set(config.interviewers.map((i) => i.canonicalKey)).size !==
        config.interviewers.length)
  )
    throw new HiringError(
      400,
      "Choose distinct interviewers before enabling hiring.",
    );
  if (
    config.deliveryEnabled &&
    !(await googleConnectionStatus(config.connectedEmail, db)).connected
  )
    throw new HiringError(
      409,
      "Connect the organizer's Google Calendar before enabling messages.",
    );
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('hiring-settings'))`,
    );
    const current = await settings(tx);
    if ((current.row?.revision ?? 0) !== revision)
      throw new HiringError(409, "Settings changed. Refresh this page.");
    await tx
      .insert(s.hiringSettings)
      .values({
        id: "default",
        config,
        revision: revision + 1,
        updatedBy: actor,
      })
      .onConflictDoUpdate({
        target: s.hiringSettings.id,
        set: {
          config,
          revision: revision + 1,
          updatedBy: actor,
          updatedAt: new Date(),
        },
      });
    await audit(tx, actor, "settings", null, {
      revision: revision + 1,
      config,
    });
  });
}
const ATTENDANCE_ADMIN_NEEDED =
  "Changing this head's days also changes Tutor Attendance, which needs Tutor Attendance admin access. Ask an attendance admin to make the change.";
/**
 * Confirmed mocks with this head, from `from`, on a weekday the new week removes. The app moves none of them.
 * `iso` weekday: 1 is Monday, which is also the index of Monday in a Tutor Attendance week.
 */
async function visitsOnRemovedDays(db: Database, key: string, before: Week | null, after: Week, from: Date) {
  const removed = [1, 2, 3, 4, 5].filter((i) => before?.[i] && !after[i]);
  if (!removed.length) return 0;
  const rows = await db
    .select({ startTime: s.hiringBookings.startTime })
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.interviewerKey, key),
        eq(s.hiringBookings.kind, "mock"),
        eq(s.hiringBookings.status, "confirmed"),
        sql`${s.hiringBookings.startTime} >= ${from.toISOString()}::timestamptz`,
      ),
    );
  return rows.filter((r) => removed.includes(Number(formatInTimeZone(r.startTime, ZONE, "i")))).length;
}
/**
 * The count runs after the change is saved, so a failure here must not report an error for a change that saved.
 * It logs the error name only and returns null; the screen then asks staff to check Head schedules.
 */
async function countVisits(count: () => Promise<number>): Promise<number | null> {
  try {
    return await count();
  } catch (error) {
    console.error("Counting visits on a removed day failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
/**
 * Saves one head's Monday to Friday days. `days[0]` is Monday. `revision` is the Hiring settings revision the screen
 * loaded, and a stale one gets a 409 on both paths.
 * An enrolled head goes through Tutor Attendance as a new schedule version from the next Bangkok day, with the actor in
 * its audit; that needs attendance admin. The new week is the version in force on that day, and a later version is
 * refused, because it would undo this change. Any other head gets a fallback week in Hiring settings and is not enrolled.
 * `affectedVisits` counts booked visits that now fall on a removed day. The app does not move them. It is null when the count failed.
 */
export async function saveHeadDays(
  key: string,
  days: boolean[],
  revision: number,
  actor: string,
  db: Database = getDb(),
  now = new Date(),
): Promise<{ revision: number; fallbackWeek?: Week; affectedVisits: number | null }> {
  if (days.length !== 5) throw new HiringError(400, "Choose Monday to Friday.");
  const current = await settings(db);
  const stale = () => new HiringError(409, "Settings changed. Refresh this page.");
  if (!current.row) throw new HiringError(409, "Save the rules and setup once before you change head days.");
  if (!current.config.interviewers.some((i) => i.canonicalKey === key)) throw new HiringError(404, "Head not found.");
  if (current.row.revision !== revision) throw stale();
  const [enrollment] = await db
    .select()
    .from(s.tutorAttendanceEnrollments)
    .where(eq(s.tutorAttendanceEnrollments.canonicalKey, key));

  if (!enrollment) {
    const saved = await withDatabaseTransaction(db, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-settings'))`);
      const fresh = await settings(tx);
      if (!fresh.row || fresh.row.revision !== revision) throw stale();
      const head = fresh.config.interviewers.find((i) => i.canonicalKey === key);
      if (!head) throw new HiringError(404, "Head not found.");
      const fallbackWeek = weekSchema.parse(weekWith(days, head.fallbackWeek));
      const config = {
        ...fresh.config,
        interviewers: fresh.config.interviewers.map((i) => (i.canonicalKey === key ? { ...i, fallbackWeek } : i)),
      };
      await tx
        .update(s.hiringSettings)
        .set({ config, revision: revision + 1, updatedBy: actor, updatedAt: new Date() })
        .where(eq(s.hiringSettings.id, "default"));
      await audit(tx, actor, "head-days", null, { key, days, via: "hiring-settings", revision: revision + 1 });
      return { revision: revision + 1, fallbackWeek, before: head.fallbackWeek ?? null };
    });
    // After the commit: a failed read inside the transaction would have aborted it. A fallback week applies at once,
    // so every visit from now is checked.
    const affectedVisits = await countVisits(() => visitsOnRemovedDays(db, key, saved.before, saved.fallbackWeek, now));
    return { revision: saved.revision, fallbackWeek: saved.fallbackWeek, affectedVisits };
  }
  const effectiveFrom = shiftDate(localDate(now), 1);
  // A switched-off or finished enrollment still makes headOfficeWindow return no hours, so a fallback week would be ignored.
  if (!enrollment.active || (enrollment.endDate && enrollment.endDate < effectiveFrom))
    throw new HiringError(
      409,
      "This head's Tutor Attendance enrollment has ended, so Hiring cannot set days for them. Switch the enrollment back on in Tutor Attendance first.",
    );
  let affectedVisits: number | null = 0;
  try {
    const access = await attendanceAccessForEmail(actor, db);
    // Read the revision first: a change made while this runs then fails the revision check instead of passing it.
    const expectedRevision = (await attendanceConfig(db)).revision;
    const schedules = await db
      .select()
      .from(s.tutorAttendanceSchedules)
      .where(eq(s.tutorAttendanceSchedules.canonicalKey, key));
    // A version that starts later would take over from this one, and undo it.
    const later = schedules.find((v) => v.effectiveFrom > effectiveFrom);
    if (later)
      throw new HiringError(409, `Tutor Attendance has a schedule starting ${later.effectiveFrom}. Change it there.`);
    const base = applicableSchedule(effectiveFrom, key, schedules)?.week ?? null;
    const week = weekWith(days, base);
    await saveAttendanceSettings(
      access,
      {
        action: "schedule",
        canonicalKey: key,
        effectiveFrom,
        week,
        reason: `Changed in Hiring by ${actor}.`,
        expectedRevision,
      },
      db,
      now,
    );
    affectedVisits = await countVisits(() => visitsOnRemovedDays(db, key, base, week, instant(effectiveFrom, 0)));
  } catch (error) {
    if (!(error instanceof AttendanceError)) throw error;
    throw new HiringError(
      error.status,
      error.status === 403
        ? ATTENDANCE_ADMIN_NEEDED
        : error.code === "STALE_REVISION"
          ? "Tutor Attendance changed while you were saving. Refresh this page and try again."
          : error.message,
    );
  }
  // The attendance change is committed. A failed Hiring audit row must not turn that into an error.
  await audit(db, actor, "head-days", null, { key, days, via: "tutor-attendance" }).catch((error) =>
    console.error("Hiring audit for a head-days save failed", error instanceof Error ? error.name : "UnknownError"),
  );
  return { revision, affectedVisits };
}
export async function candidateById(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(s.hiringCandidates)
    .where(eq(s.hiringCandidates.id, id));
  if (!row) throw new HiringError(404, "Candidate not found.");
  return row;
}
/** Returns false when the key already exists: nothing new was queued. */
export async function enqueue(
  db: Database,
  value: typeof s.hiringOutbox.$inferInsert,
) {
  const rows = await db
    .insert(s.hiringOutbox)
    .values(value)
    .onConflictDoNothing({ target: s.hiringOutbox.key })
    .returning({ id: s.hiringOutbox.id });
  return rows.length > 0;
}
/** Old flow only: a recorded paper pass. A paper invitation can no longer be sent. */
export async function inviteToMock(
  db: Database,
  candidate: Candidate,
  config: HiringConfig,
  key: string,
) {
  if (!candidate.email)
    throw new HiringError(409, "A verified application email is required.");
  const expiry = new Date(Date.now() + 14 * 86400000);
  const token = bookingToken(candidate.id, "mock", expiry);
  const url = new URL(
    `/hiring/book/${token}`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
  await enqueue(db, {
    key,
    candidateId: candidate.id,
    kind: "email",
    payload: {
      to: candidate.email,
      subject: "BeGifted mock teaching invitation",
      text: `Dear ${candidate.name},\n\nYou have passed the recorded paper assessment for ${candidate.paperPassedSubjects.join(", ")}. Please book your onsite mock teaching session:\n${url}\n\nEach subject has a one-hour session. Prepare one IGCSE topic of your choice. The interviewer will also select a topic, which may be from another level. You may use teaching materials or tools.\n\nLocation: ${config.location}\n\nBeGifted Education`,
      workflowStage: "paper_passed",
    },
  });
  await db
    .update(s.hiringCandidates)
    .set({ inviteExpiresAt: expiry, updatedAt: new Date() })
    .where(eq(s.hiringCandidates.id, candidate.id));
}
export async function inviteToPreScreen(db: Database, candidate: Candidate, now = new Date()) {
  if (!candidate.email)
    throw new HiringError(409, "A verified application email is required.");
  return enqueue(db, {
    key: `${candidate.id}:pre-screen`,
    candidateId: candidate.id,
    kind: "email",
    // Day and week limits read this time, so it comes from the same clock as the limit check.
    createdAt: now,
    payload: {
      to: candidate.email,
      subject: "BeGifted tutor pre-screening questionnaire",
      workflowStage: "pre_screen",
      text: `Dear ${candidate.name},\n\nThank you for your interest in joining BeGifted. Please complete our short pre-screening questionnaire:\n${PRE_SCREEN_URL}\n\nUse this application email: ${candidate.email}. The form takes about 5–7 minutes. We will contact you after reviewing your response.\n\nBeGifted Education`,
    },
  });
}
export const visitLink = (id: string, expires: Date) =>
  new URL(
    `/hiring/book/${bookingToken(id, "visit", expires)}`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
const LINE_URL = "https://lin.ee/OjMHF41";
const onLine = (text: string) => `${text} Contact BeGifted on LINE: ${LINE_URL}`;
const DAY = 86400000;
const LIMIT_TEXT: Record<LimitName, string> = {
  perDay: "per day",
  perWeek: "per week",
  waiting: "waiting for reply",
  unbooked: "invited, not booked",
  perSubject: "open per subject",
};
// A candidate at any other stage already holds an invitation, is stopped, or stays on the old flow.
// `new` here is a response scored by the backfill, which changes no stage.
// `stopped` is an earlier response a person chooses to invite. No queue reads `new` or `stopped`, so only a click reaches them.
const INVITABLE: Stage[] = ["new", "pre_screen", "no_reply", "review", "no_booking", "stopped"];
/**
 * The one gate for every onsite invitation, from a release or a click. It takes the queue lock and reads the limits
 * itself, so the two cannot both use the last place. Call it inside a transaction, before locking the candidate row:
 * the lock order is queue, then candidate.
 */
export async function inviteToVisit(
  tx: Database,
  candidate: Candidate,
  config: HiringConfig,
  key: string,
  now = new Date(),
  // A repeat to someone already invited. They hold a place already, so the limits do not stop it.
  resend = false,
) {
  await lockQueue(tx);
  const [c] = await tx
    .select()
    .from(s.hiringCandidates)
    .where(eq(s.hiringCandidates.id, candidate.id))
    .for("update");
  if (!c) throw new HiringError(404, "Candidate not found.");
  if (!INVITABLE.includes(c.stage) && !(resend && c.stage === "onsite_invited"))
    throw new HiringError(409, "This candidate cannot get an onsite invitation at this stage.");
  if (!c.email)
    throw new HiringError(409, "A verified application email is required.");
  if (!c.preScreen || !c.preScreenAssessment)
    throw new HiringError(409, "The pre-screen response has no score yet.");
  const { stops } = hardStops(
    c.preScreen,
    c.workRightsAnswer,
    normalizeSubjects(c.preScreen.subjects),
    config,
  );
  if (stops.length) throw new HiringError(409, stops.join(" "));
  const supported = supportedVisitSubjects(c.preScreen, c.workRightsAnswer, c.preScreenAssessment, config);
  if (!topHiringSubject(supported, config.subjectPriority))
    throw new HiringError(409, "No supported subject is open for hiring.");
  const subject = topHiringSubject(
    supported.filter((v) => config.interviewers.some((i) => i.subjects.includes(v))),
    config.subjectPriority,
  );
  if (!subject)
    throw new HiringError(409, `No head is set for the subject: ${supported.join(", ")}.`);
  const limit = resend ? null : blockingLimit("onsite", subject, await readLimitUsage(tx, "onsite", now), config);
  if (limit)
    throw new HiringError(409, `The onsite limit "${LIMIT_TEXT[limit]}" is full. Raise the number to send more.`);
  const expires = new Date(
    (Math.floor(now.getTime() / 1000) + VISIT_LINK_DAYS * 86400) * 1000,
  );
  const revision = c.revision + 1;
  const queued = await enqueue(tx, {
    key,
    candidateId: c.id,
    kind: "email",
    createdAt: now,
    payload: {
      to: c.email,
      subject: "BeGifted onsite visit invitation",
      workflowStage: "onsite_invited",
      // The follow-up reminder for this link uses this number, so a later change to the row cannot send a second one.
      revision,
      ...(resend ? { resend: true } : {}),
      text: `Dear ${c.name},\n\nThank you for your pre-screening response. We invite you to one onsite visit for ${subject}. The visit takes 3 hours: a 2-hour exam, then a 1-hour mock teaching session.\n\nPlease book your visit here:\n${visitLink(c.id, expires)}\n\nThis link closes after ${config.onsiteFollowUp.expireDays} days. For the mock teaching session, prepare one IGCSE topic of your choice. The interviewer will also select a topic, which may be from another level. You may use teaching materials or tools.\n\nLocation: ${config.location}\n\nFor questions, add our LINE Official Account at https://lin.ee/OjMHF41.\n\nBeGifted Education`,
    },
  });
  if (!queued)
    throw new HiringError(
      409,
      "This invitation was already queued or sent. Use Send new link after a cancel, a no-show or No booking.",
    );
  await tx
    .update(s.hiringCandidates)
    .set({
      stage: "onsite_invited",
      visitSubject: subject,
      inviteExpiresAt: expires,
      revision,
      updatedAt: now,
    })
    .where(eq(s.hiringCandidates.id, c.id));
  return subject;
}
/** Longer than the route's 300 seconds, so a live run is never taken for a dead one. */
export const MARKING_STUCK_AFTER_MS = 6 * 60_000;
/**
 * Results, the paper library and this month's marking cost. The AI's first answer stays on the server.
 * shortcut: full marks go in every dashboard read. Fetch them on panel open if papers near 400, the 4.5 MB response limit.
 */
async function assessmentData(db: Database, now: Date) {
  const [papers, mocks, decisions, library] = await Promise.all([
    db.select().from(s.hiringPaperResults).orderBy(asc(s.hiringPaperResults.subject)),
    db.select().from(s.hiringMockResults).orderBy(asc(s.hiringMockResults.subject)),
    db.select().from(s.hiringDecisions).orderBy(desc(s.hiringDecisions.createdAt)),
    db
      .select({
        id: s.hiringAssessmentFiles.id,
        kind: s.hiringAssessmentFiles.kind,
        subject: s.hiringAssessmentFiles.subject,
        name: s.hiringAssessmentFiles.name,
        createdAt: s.hiringAssessmentFiles.createdAt,
      })
      .from(s.hiringAssessmentFiles)
      .where(eq(s.hiringAssessmentFiles.active, true)),
  ]);
  const monthStart = fromZonedTime(`${localDate(now).slice(0, 7)}-01T00:00:00`, ZONE);
  // Each model call writes one audit row, so a repeat of a paper still counts.
  const [spent = { usd: 0, unknown: 0 }] = await db
    .select({
      usd: sql<number>`coalesce(sum((${s.hiringAudit.detail}->>'costUsd')::float), 0)::float`,
      unknown: sql<number>`(count(*) filter (where ${s.hiringAudit.detail}->>'costUsd' is null))::int`,
    })
    .from(s.hiringAudit)
    .where(and(eq(s.hiringAudit.action, "assessment-ai-call"), gte(s.hiringAudit.createdAt, monthStart)));
  return {
    papers: papers.map((row) => ({ ...row, aiMarks: undefined, stuck: row.status === "marking" && now.getTime() - row.updatedAt.getTime() > MARKING_STUCK_AFTER_MS })),
    mocks: mocks.map((row) => ({ ...row, aiRubric: undefined, stuck: row.status === "marking" && now.getTime() - row.updatedAt.getTime() > MARKING_STUCK_AFTER_MS })),
    decisions,
    library,
    // A provider can leave the cost out, and then the total is only a floor.
    markingSpend: { usd: spent.usd, complete: spent.unknown === 0 },
  };
}

export async function dashboard(db: Database = getDb()) {
  const [
    { row, config },
    candidates,
    bookings,
    outbox,
    contacts,
    groups,
    auditRows,
  ] = await Promise.all([
    settings(db),
    db
      .select()
      .from(s.hiringCandidates)
      .orderBy(desc(s.hiringCandidates.updatedAt))
      .limit(2000),
    db
      .select()
      .from(s.hiringBookings)
      .orderBy(desc(s.hiringBookings.startTime))
      .limit(2000),
    db
      .select({
        id: s.hiringOutbox.id,
        key: s.hiringOutbox.key,
        candidateId: s.hiringOutbox.candidateId,
        kind: s.hiringOutbox.kind,
        status: s.hiringOutbox.status,
        error: s.hiringOutbox.error,
        sentAt: s.hiringOutbox.sentAt,
        // Never select the payload: it holds the email body.
        workflowStage: sql<string | null>`${s.hiringOutbox.payload}->>'workflowStage'`,
      })
      .from(s.hiringOutbox)
      .orderBy(desc(s.hiringOutbox.createdAt))
      .limit(4000),
    db.select().from(s.tutorContacts).where(eq(s.tutorContacts.active, true)),
    db.select().from(s.progressLineGroups),
    db
      .select()
      .from(s.hiringAudit)
      .orderBy(desc(s.hiringAudit.createdAt))
      .limit(50),
  ]);
  if (!row) {
    const suggested: Record<string, Subject[]> = {
      Peat: ["Mathematics", "Physics"],
      Ek: ["Mathematics", "Physics"],
      Mimi: ["Chemistry"],
      Tito: ["EFL/ESL", "English Language", "English Literature", "IELTS"],
      Gift: [
        "Biology",
        "Computer Science",
        "ICT",
        "Economics",
        "Business Studies",
        "Psychology",
        "Geography",
        "History",
        "Thai",
        "French",
        "Art & Design Technology",
      ],
    };
    config.interviewers = Object.entries(suggested).flatMap(
      ([key, subjects]) => {
        const contact = contacts.find((c) => c.canonicalKey === key);
        const email = contact?.onsiteEmail ?? contact?.primaryEmail;
        return email ? [{ canonicalKey: key, email, subjects }] : [];
      },
    );
  }
  // One shared read for all heads. Never fails the dashboard: a missing index reports stale.
  const clashes = await visitClashes(db, bookings);
  // The meters and the queue notes read the same counts and the same release function the worker uses. Postgres only.
  const now = new Date();
  const usage = {
    preScreen: await readLimitUsage(db, "pre_screen", now),
    onsite: await readLimitUsage(db, "onsite", now),
  };
  const holds: Record<string, QueueHold> = {};
  let preScreenOrder: string[] = [];
  const callOrder = (await callQueue(db, config)).map((entry) => entry.id);
  for (const funnel of ["pre_screen", "onsite"] as const satisfies Funnel[]) {
    const entries = funnel === "pre_screen" ? await preScreenQueue(db, config) : await onsiteQueue(db, config);
    const { release, held, order } = releaseQueue(funnel, entries, funnel === "pre_screen" ? usage.preScreen : usage.onsite, config);
    if (funnel === "pre_screen") preScreenOrder = order;
    for (const e of release) holds[e.id] = { funnel, state: "next", position: 0, limit: null, subject: e.subject };
    for (const e of held) holds[e.id] = { funnel, state: "held", position: e.position, limit: e.limit, subject: e.subject };
  }
  const enrollments = await db.select().from(s.tutorAttendanceEnrollments);
  const schedules = await db.select().from(s.tutorAttendanceSchedules);
  const inviteOutbox = await db
    .select({
      key: s.hiringOutbox.key,
      candidateId: s.hiringOutbox.candidateId,
      status: s.hiringOutbox.status,
      error: s.hiringOutbox.error,
      sentAt: s.hiringOutbox.sentAt,
    })
    .from(s.hiringOutbox)
    .where(
      sql`${s.hiringOutbox.key} = ${s.hiringOutbox.candidateId}::text || ':pre-screen' or ${s.hiringOutbox.key} like ${s.hiringOutbox.candidateId}::text || ':visit-invite%' or ${s.hiringOutbox.key} like ${s.hiringOutbox.candidateId}::text || ':result:%'`,
    )
    .orderBy(desc(s.hiringOutbox.createdAt));
  const assessment = await assessmentData(db, now);
  return {
    config,
    ...assessment,
    // False until the first save: the interviewers shown then are suggestions, not stored heads.
    configSaved: !!row,
    // Rules the stored config breaks. The screen shows them, and a save will not pass until they are fixed.
    configProblems: configRuleErrors(config).map((e) => e.message),
    usage,
    holds,
    preScreenOrder,
    callOrder,
    headMocks: headWeekMocks(bookings, now),
    heads: Object.fromEntries(
      config.interviewers.map((head) => [head.canonicalKey, headDayState(head, enrollments, schedules, localDate(now))]),
    ),
    revision: row?.revision ?? 0,
    workerAt: row?.workerAt ?? null,
    workerSummary: row?.workerSummary ?? null,
    workerError: row?.workerError ?? null,
    writeGate: runtimeWritesAllowed(),
    candidates: candidates.map((c) => {
      const parts =
        c.preScreenAssessment && c.preScreen
          ? preScreenPoints(
              c.preScreenAssessment,
              config.preScreenWeights,
              c.universityAssessment?.fraction ?? 0,
              availabilityFraction(c.preScreen),
            )
          : null;
      return {
        ...c,
        profileText: undefined,
        // The stored list can be long, and the screen only needs to know the row was moved.
        queueManual: !!c.queueManual,
        // The screen reads workRightsAnswer. This old column stays in the database only.
        workRightsConfirmed: undefined,
        // The text itself is read on demand. This tells the screen whether there is any, such as for a person added from the tracker.
        hasSourceText: c.profileText.trim().length > 0,
        // The screen opens a file only through the guarded route, so it never gets the storage path.
        resumePath: undefined,
        resumeSha256: undefined,
        resumeState: (c.resumePath ? "available" : c.resumeStoredAt ? "deleted" : "none") as "available" | "deleted" | "none",
        profileScore: c.profileAssessment
          ? profileScore(
              c.profileAssessment,
              config.profileWeights,
              c.universityAssessment?.fraction ?? 0,
            )
          : null,
        // The pre-screen score is the eight-part total, not the profile formula.
        preScreenScore: parts?.total ?? null,
        preScreenParts: parts,
        workRightsAccepted: workRightsAccepted(
          c.workRightsAnswer,
          config.acceptedWorkRights,
        ),
      };
    }),
    bookings,
    visitClashes: clashes,
    outbox,
    // The capped list above holds every kind of row, so the pre-screen screen reads its proof from this full read.
    inviteOutbox,
    audit: auditRows,
    tutors: contacts.map((c) => ({
      canonicalKey: c.canonicalKey,
      name: c.displayName,
      email: c.onsiteEmail ?? c.primaryEmail ?? null,
      lineReady: groups.some(
        (g) => g.canonicalKey === c.canonicalKey && g.enabled,
      ),
    })),
  };
}
function oldFlowToken(token: string, now: Date) {
  const cap = readBookingToken(token, now);
  if (cap.kind === "visit")
    throw new HiringError(404, "This booking link is no longer active.");
  return { ...cap, kind: cap.kind };
}
export async function bookingView(
  token: string,
  subjects?: Subject[],
  db: Database = getDb(),
  now = new Date(),
) {
  const cap = oldFlowToken(token, now);
  const candidate = await candidateById(db, cap.id);
  const { config } = await settings(db);
  const permitted =
    cap.kind === "paper" ? candidate.subjects : candidate.paperPassedSubjects;
  // A candidate on the visit flow books through the visit link only.
  if (
    candidate.stage === "stopped" ||
    isDecided(candidate.stage) ||
    candidate.visitSubject ||
    !candidate.inviteExpiresAt ||
    candidate.inviteExpiresAt.getTime() < cap.exp * 1000
  )
    throw new HiringError(404, "This booking link is no longer active.");
  if (cap.kind === "mock" && !candidate.paperPassedAt)
    throw new HiringError(409, "The paper result has not been confirmed.");
  if (
    cap.kind === "paper" &&
    !["paper_invited", "paper_booked"].includes(candidate.stage)
  )
    throw new HiringError(409, "This assessment is not ready to book.");
  const chosen = subjects ?? permitted.slice(0, 1);
  if (chosen.some((v) => !permitted.includes(v)) || !chosen.length)
    throw new HiringError(400, "Select a permitted subject.");
  const booked = await db
    .select()
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.candidateId, candidate.id),
        eq(s.hiringBookings.status, "confirmed"),
      ),
    );
  const remaining = chosen.filter(
    (subject) =>
      !booked.some((b) => b.kind === cap.kind && b.subjects.includes(subject)),
  );
  const canBook =
    config.enabled && config.rubricApproved && runtimeWritesAllowed();
  return {
    kind: cap.kind,
    subjects: permitted,
    selectedSubjects: chosen,
    location: config.location,
    enabled: canBook,
    bookings: booked.map((b) => ({
      id: b.id,
      kind: b.kind,
      subjects: b.subjects,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      interviewer: b.interviewerKey,
    })),
    slots:
      canBook && remaining.length === chosen.length
        ? (await availableSlots(db, config, cap.kind, chosen, now)).filter(
            (slot) =>
              !booked.some((b) =>
                overlap(
                  { start: new Date(slot.start), end: new Date(slot.end) },
                  { start: b.startTime, end: b.endTime },
                ),
              ),
          )
        : [],
  };
}
export async function bookInterview(
  token: string,
  value: unknown,
  db: Database = getDb(),
  now = new Date(),
) {
  const input = bookingSchema.parse(value);
  const cap = oldFlowToken(token, now);
  if (new Set(input.subjects).size !== input.subjects.length)
    throw new HiringError(400, "A subject can only be selected once.");
  const { config } = await settings(db);
  if (!config.enabled || !config.rubricApproved || !runtimeWritesAllowed())
    throw new HiringError(503, "Booking is temporarily unavailable.");
  // Retries return the original appointment, even after the candidate has advanced.
  const prior = await db
    .select()
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.candidateId, cap.id),
        eq(s.hiringBookings.kind, cap.kind),
        eq(s.hiringBookings.status, "confirmed"),
      ),
    );
  const same = prior.find(
    (b) =>
      b.startTime.toISOString() === input.start &&
      b.interviewerKey === input.interviewerKey &&
      JSON.stringify([...b.subjects].sort()) ===
        JSON.stringify([...input.subjects].sort()),
  );
  if (same) return same;
  const view = await bookingView(token, input.subjects, db, now);
  const slot = view.slots.find(
    (s) => s.start === input.start && s.interviewerKey === input.interviewerKey,
  );
  if (!slot)
    throw new HiringError(
      409,
      "That appointment is no longer available. Refresh the available times.",
    );
  const evidence = await verifyLiveSlot(db, slot);
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(
      sql`select id from hiring_candidates where id=${cap.id} for update`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + cap.id},0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${slot.interviewerKey ? "sit-in:" + slot.interviewerKey : "hiring:paper"},0))`,
    );
    const candidate = await candidateById(tx, cap.id);
    if (
      candidate.stage === "stopped" ||
      isDecided(candidate.stage) ||
      candidate.visitSubject ||
      !candidate.inviteExpiresAt ||
      candidate.inviteExpiresAt.getTime() < cap.exp * 1000
    )
      throw new HiringError(409, "This invitation changed. Contact BeGifted.");
    const existing = await tx
      .select()
      .from(s.hiringBookings)
      .where(
        and(
          eq(s.hiringBookings.candidateId, candidate.id),
          eq(s.hiringBookings.kind, cap.kind),
          eq(s.hiringBookings.status, "confirmed"),
        ),
      );
    const identical = existing.find(
      (b) =>
        b.startTime.toISOString() === input.start &&
        b.interviewerKey === input.interviewerKey &&
        JSON.stringify([...b.subjects].sort()) ===
          JSON.stringify([...input.subjects].sort()),
    );
    if (identical) return identical;
    if (
      existing.some((b) =>
        b.subjects.some((subject) => input.subjects.includes(subject)),
      )
    )
      throw new HiringError(409, "This subject already has an appointment.");
    if (
      cap.kind === "mock" &&
      (!candidate.paperPassedAt ||
        input.subjects.some(
          (subject) => !candidate.paperPassedSubjects.includes(subject),
        ))
    )
      throw new HiringError(409, "The paper result changed. Contact BeGifted.");
    const latest = await settings(tx);
    if (
      !latest.config.enabled ||
      !latest.config.rubricApproved ||
      !runtimeWritesAllowed()
    )
      throw new HiringError(503, "Booking has been paused.");
    const fresh = (
      await availableSlots(
        tx,
        latest.config,
        cap.kind,
        input.subjects,
        new Date(),
        db,
      )
    ).find(
      (s) =>
        s.start === input.start && s.interviewerKey === input.interviewerKey,
    );
    if (!fresh)
      throw new HiringError(
        409,
        "This appointment was just taken or availability changed. Choose another time.",
      );
    const interviewer = latest.config.interviewers.find(
      (i) => i.canonicalKey === slot.interviewerKey,
    );
    const [group] = slot.interviewerKey
      ? await tx
          .select()
          .from(s.progressLineGroups)
          .where(
            and(
              eq(s.progressLineGroups.canonicalKey, slot.interviewerKey),
              eq(s.progressLineGroups.enabled, true),
            ),
          )
      : [];
    if (cap.kind === "mock" && (!interviewer || !group))
      throw new HiringError(
        409,
        "Interviewer notifications are not configured.",
      );
    const id = randomUUID();
    const [booking] = await tx
      .insert(s.hiringBookings)
      .values({
        id,
        candidateId: cap.id,
        kind: cap.kind,
        subjects: input.subjects,
        interviewerKey: slot.interviewerKey,
        interviewerEmail: interviewer?.email,
        lineGroupId: group?.groupId,
        calendarOwner: latest.config.connectedEmail,
        startTime: new Date(slot.start),
        endTime: new Date(slot.end),
        evidence,
      })
      .returning();
    await tx
      .update(s.hiringCandidates)
      .set({
        stage: cap.kind === "mock" ? "mock_booked" : "paper_booked",
        revision: candidate.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(s.hiringCandidates.id, candidate.id));
    if (candidate.email)
      await enqueue(tx, {
        key: `booking:${id}:email`,
        candidateId: cap.id,
        bookingId: id,
        kind: "email",
        payload: {
          to: candidate.email,
          subject: `BeGifted ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} confirmed`,
          text: `Dear ${candidate.name},\n\nYour ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} appointment is confirmed.\nSubjects: ${input.subjects.join(", ")}\nTime: ${new Date(slot.start).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}–${new Date(slot.end).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" })} (Bangkok)\nLocation: ${latest.config.location}\n${interviewer ? `Interviewer: ${interviewer.canonicalKey}\n` : ""}\nFor changes, contact BeGifted at https://lin.ee/OjMHF41.\n\nBeGifted Education`,
        },
      });
    await enqueue(tx, {
      key: `booking:${id}:calendar`,
      candidateId: cap.id,
      bookingId: id,
      kind: "calendar",
      payload: {},
    });
    if (group)
      await enqueue(tx, {
        key: `booking:${id}:line`,
        candidateId: cap.id,
        bookingId: id,
        kind: "line",
        payload: {},
      });
    await audit(tx, "candidate-link", "booking", cap.id, {
      bookingId: id,
      kind: cap.kind,
      subjects: input.subjects,
      interviewer: slot.interviewerKey,
    });
    return booking;
  });
}
type VisitLink = { id: string; exp: number };
function visitToken(token: string, now: Date): VisitLink {
  const cap = readBookingToken(token, now);
  if (cap.kind !== "visit") throw new HiringError(404, onLine("This booking link is no longer active."));
  return cap;
}
const bookable = (config: HiringConfig, candidateId: string) =>
  (config.enabled || config.bookingTestCandidateId === candidateId) && config.rubricApproved && runtimeWritesAllowed();
const visitRows = (db: Database, candidateId: string) =>
  db
    .select()
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.candidateId, candidateId),
        eq(s.hiringBookings.status, "confirmed"),
        isNotNull(s.hiringBookings.visitId),
      ),
    );
type VisitRow = Awaited<ReturnType<typeof visitRows>>[number];
const examOf = (rows: VisitRow[]) => rows.find((b) => b.kind === "paper");

/**
 * The link's expiry second must equal the row's, so a new link ends the old one. A booked link stays open until the visit
 * starts. An unbooked link closes at expireDays even when the worker is not running to mark No booking.
 */
async function openVisit(db: Database, cap: VisitLink, config: HiringConfig, now: Date) {
  const candidate = await candidateById(db, cap.id);
  const rows = await visitRows(db, cap.id);
  let open = candidate.inviteExpiresAt?.getTime() === cap.exp * 1000 && !!candidate.visitSubject;
  if (open && candidate.stage === "onsite_booked") {
    const exam = examOf(rows);
    open = !!exam && exam.startTime > now;
  } else if (open && candidate.stage === "onsite_invited") {
    const sentAt = await linkSentAt(db, cap.id);
    open = !sentAt || now.getTime() - sentAt.getTime() < config.onsiteFollowUp.expireDays * DAY;
  } else open = false;
  if (!open) throw new HiringError(404, onLine("This booking link is no longer active."));
  return { candidate, subject: candidate.visitSubject!, rows };
}

/** Why this booked visit cannot move, or null. send_new_link needs a visit with no confirmed rows, and the next booking has no `reschedule_of`, so that click resets the count. */
function moveRefusal(rows: VisitRow[], now: Date) {
  if (rows.some((b) => b.rescheduleOf)) return onLine("This visit has already moved once.");
  if (examOf(rows)!.startTime.getTime() - now.getTime() < DAY)
    return onLine("A visit cannot move within 24 hours of its start.");
  return null;
}

/** The current time is not a choice, and every time starts inside the link's life, so the link outlasts the wait for any booked visit. */
const offeredSlots = async (db: Database, config: HiringConfig, subject: Subject, cap: VisitLink, rows: VisitRow[], now: Date, indexDb = db) =>
  (await availableVisitSlots(db, config, subject, now, cap.id, indexDb)).filter((slot) => {
    const start = new Date(slot.examStart).getTime();
    return start < cap.exp * 1000 && start !== examOf(rows)?.startTime.getTime();
  });

export async function visitView(token: string, db: Database = getDb(), now = new Date()) {
  const cap = visitToken(token, now);
  const { config } = await settings(db);
  const { subject, rows } = await openVisit(db, cap, config, now);
  const enabled = bookable(config, cap.id);
  const exam = examOf(rows);
  const mock = rows.find((b) => b.kind === "mock");
  const refusal = exam ? moveRefusal(rows, now) : null;
  let slots: Awaited<ReturnType<typeof offeredSlots>> = [];
  let notice: string | null = null;
  if (!enabled) notice = onLine("Booking is temporarily paused.");
  else if (refusal) notice = refusal;
  else {
    try {
      slots = await offeredSlots(db, config, subject, cap, rows, now);
      if (!slots.length) notice = onLine("There are no open visit times at the moment. Please try again later.");
    } catch (error) {
      // A stale Wise snapshot. Anything else is not a state the candidate can act on.
      if (!(error instanceof HiringError)) throw error;
      notice = onLine("Visit times cannot be shown at the moment. Please try again later.");
    }
  }
  return {
    kind: "visit" as const,
    subject,
    location: config.location,
    enabled,
    slots,
    visit:
      exam && mock
        ? {
            examStart: exam.startTime.toISOString(),
            mockStart: mock.startTime.toISOString(),
            mockEnd: mock.endTime.toISOString(),
            head: mock.interviewerKey,
          }
        : null,
    canMove: enabled && !!exam && !refusal,
    notice,
  };
}

const bangkok = (date: Date) =>
  date.toLocaleString("en-GB", { timeZone: ZONE, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const bangkokTime = (date: Date) =>
  date.toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
const headNotice = (mock: VisitRow, notice?: "moved" | "cancelled", movedFrom?: Date) => ({
  key: `booking:${mock.id}:line${notice === "cancelled" ? "-cancelled" : ""}`,
  candidateId: mock.candidateId,
  bookingId: mock.id,
  kind: "line" as const,
  payload: { ...(notice ? { notice } : {}), ...(movedFrom ? { movedFrom: movedFrom.toISOString() } : {}) },
});

/** Stops a visit's rows blocking anyone. Unsent messages for them go; events still ahead are cancelled. */
export async function endVisit(tx: Database, rows: VisitRow[], status: "cancelled" | "no_show", now: Date) {
  const ids = rows.map((b) => b.id);
  const candidateId = rows[0].candidateId;
  await tx.update(s.hiringBookings).set({ status }).where(inArray(s.hiringBookings.id, ids));
  await tx
    .update(s.hiringOutbox)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(s.hiringOutbox.candidateId, candidateId),
        inArray(s.hiringOutbox.status, ["pending", "failed"]),
        or(inArray(s.hiringOutbox.bookingId, ids), like(s.hiringOutbox.key, `${candidateId}:visit-reminder:%`)),
      ),
    );
  for (const row of rows)
    if (row.startTime > now)
      await enqueue(tx, {
        key: `booking:${row.id}:calendar-cancel`,
        candidateId,
        bookingId: row.id,
        kind: "calendar_cancel",
        payload: {},
      });
}

/** The candidate chooses a time and the server assigns the head. A move is this with `move: true`, once. */
export async function bookVisit(token: string, value: unknown, db: Database = getDb(), now = new Date()) {
  const input = visitBookingSchema.parse(value);
  const cap = visitToken(token, now);
  const start = new Date(input.start).getTime();
  const { config } = await settings(db);
  if (!bookable(config, cap.id)) throw new HiringError(503, "Booking is temporarily unavailable.");
  // A retry returns the original visit.
  const prior = examOf(await visitRows(db, cap.id));
  if (prior?.startTime.getTime() === start) return prior;
  const open = await openVisit(db, cap, config, now);
  const refuseChange = (rows: VisitRow[]) => {
    if (!rows.length) return;
    if (!input.move) throw new HiringError(409, "You already have a booked visit. Use Move this visit to change it.");
    const refusal = moveRefusal(rows, now);
    if (refusal) throw new HiringError(409, refusal);
  };
  refuseChange(open.rows);
  if (input.subject !== open.subject)
    throw new HiringError(409, onLine("This visit is for another subject."));
  const unavailable = () => new HiringError(409, "That visit time is no longer available. Choose another time.");
  const slot = (await offeredSlots(db, config, open.subject, cap, open.rows, now)).find(
    (v) => new Date(v.examStart).getTime() === start,
  );
  if (!slot) throw unavailable();
  // The head's hour is the only part Wise can block. Office staff supervise the exam.
  const evidence = await verifyLiveSlot(db, {
    date: slot.date,
    start: slot.mockStart,
    end: slot.mockEnd,
    interviewerKey: slot.interviewerKey,
    subjects: [slot.subject],
  });
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${cap.id} for update`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + cap.id},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"hiring:paper"},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"sit-in:" + slot.interviewerKey},0))`);
    const latest = await settings(tx);
    if (!bookable(latest.config, cap.id)) throw new HiringError(503, "Booking has been paused.");
    const { candidate, subject, rows } = await openVisit(tx, cap, latest.config, now);
    if (examOf(rows)?.startTime.getTime() === start) return examOf(rows)!;
    refuseChange(rows);
    if (input.subject !== subject) throw new HiringError(409, onLine("This visit is for another subject."));
    const fresh = (await offeredSlots(tx, latest.config, subject, cap, rows, new Date(), db)).find(
      (v) => new Date(v.examStart).getTime() === start,
    );
    // Only this head's lock is held, and the live read was for this head.
    if (!fresh || fresh.interviewerKey !== slot.interviewerKey) throw unavailable();
    const head = latest.config.interviewers.find((i) => i.canonicalKey === fresh.interviewerKey);
    const [group] = await tx
      .select()
      .from(s.progressLineGroups)
      .where(and(eq(s.progressLineGroups.canonicalKey, fresh.interviewerKey), eq(s.progressLineGroups.enabled, true)));
    if (!head || !group) throw new HiringError(409, onLine("Interviewer notifications are not configured."));
    const oldMock = rows.find((b) => b.kind === "mock");
    if (rows.length) await endVisit(tx, rows, "cancelled", now);
    const visitId = randomUUID();
    const shared = {
      candidateId: cap.id,
      subjects: [subject],
      calendarOwner: latest.config.connectedEmail,
      visitId,
    };
    const examRange = { startTime: new Date(fresh.examStart), endTime: new Date(fresh.mockStart) };
    const mockRange = { startTime: new Date(fresh.mockStart), endTime: new Date(fresh.mockEnd) };
    const [exam, mock] = await tx
      .insert(s.hiringBookings)
      .values([
        {
          ...shared,
          ...examRange,
          kind: "paper" as const,
          rescheduleOf: examOf(rows)?.id,
          evidence: { checkedAt: new Date().toISOString(), source: "office-capacity" },
        },
        {
          ...shared,
          ...mockRange,
          kind: "mock" as const,
          interviewerKey: head.canonicalKey,
          interviewerEmail: head.email,
          lineGroupId: group.groupId,
          rescheduleOf: oldMock?.id,
          evidence,
        },
      ])
      .returning();
    await tx
      .update(s.hiringCandidates)
      .set({ stage: "onsite_booked", revision: candidate.revision + 1, updatedAt: new Date() })
      .where(eq(s.hiringCandidates.id, candidate.id));
    if (candidate.email)
      await enqueue(tx, {
        key: `booking:${exam.id}:email`,
        candidateId: cap.id,
        bookingId: exam.id,
        kind: "email",
        payload: {
          to: candidate.email,
          subject: `BeGifted onsite visit ${rows.length ? "moved" : "confirmed"}`,
          text: `Dear ${candidate.name},\n\nYour onsite visit ${rows.length ? "has moved. The new times are below" : "is confirmed"}.\nSubject: ${subject}\nExam: ${bangkok(exam.startTime)}–${bangkokTime(exam.endTime)} (Bangkok)\nMock teaching: ${bangkok(mock.startTime)}–${bangkokTime(mock.endTime)} (Bangkok), with ${head.canonicalKey}\nLocation: ${latest.config.location}\n\nFor the mock teaching session, prepare one IGCSE topic of your choice. The interviewer will also select a topic, which may be from another level. You may use teaching materials or tools.\n\n${rows.length ? "This visit cannot move again through the link." : `You can move this visit once, up to 24 hours before it starts:\n${visitLink(cap.id, candidate.inviteExpiresAt!)}`}\nFor other changes, contact BeGifted on LINE: ${LINE_URL}\n\nBeGifted Education`,
        },
      });
    for (const row of [exam, mock])
      await enqueue(tx, {
        key: `booking:${row.id}:calendar`,
        candidateId: cap.id,
        bookingId: row.id,
        kind: "calendar",
        payload: {},
      });
    await enqueue(tx, headNotice(mock, rows.length ? "moved" : undefined, oldMock?.startTime));
    // With a new head, the old head still needs to hear that the hour is free.
    if (oldMock && oldMock.interviewerKey !== head.canonicalKey) await enqueue(tx, headNotice(oldMock, "cancelled"));
    await audit(tx, "candidate-link", rows.length ? "visit-move" : "visit-booking", cap.id, {
      visitId,
      subject,
      head: head.canonicalKey,
      examStart: fresh.examStart,
      movedFrom: examOf(rows)?.startTime.toISOString() ?? null,
    });
    return exam;
  });
}
const WAITING_INVITE = ["pending", "failed", "uncertain"] as const;
const isVisitStageRow = sql`${s.hiringOutbox.payload}->>'workflowStage' = 'onsite_invited'`;
/**
 * A new link replaces every unsent invitation and reminder of this candidate. They hold the old link, and the worker would
 * otherwise send them too. A row the worker holds right now may be leaving, so that refuses.
 */
async function cancelWaitingInvites(tx: Database, id: string) {
  const rows = await tx
    .select({ status: s.hiringOutbox.status })
    .from(s.hiringOutbox)
    .where(and(eq(s.hiringOutbox.candidateId, id), isVisitStageRow));
  if (rows.some((row) => row.status === "processing"))
    throw new HiringError(409, "The invitation is being sent right now. Wait a minute and check before sending a new link.");
  await tx
    .update(s.hiringOutbox)
    .set({ status: "cancelled" })
    .where(and(eq(s.hiringOutbox.candidateId, id), isVisitStageRow, inArray(s.hiringOutbox.status, [...WAITING_INVITE])));
}
/**
 * A person's score beside the AI's. It sends nothing and changes no stage. The queue then holds the reply for a person.
 * It raises the revision, so another open panel cannot invite on the old score.
 */
export async function changePreScreenScore(
  id: string,
  input: { revision: number; score: number; reason: string },
  actor: string,
  db: Database = getDb(),
  now = new Date(),
) {
  if (input.reason.trim().length < 5) throw new HiringError(400, "Write a reason of at least 5 characters.");
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${id} for update`);
    const c = await candidateById(tx, id);
    if (c.revision !== input.revision) throw new HiringError(409, "This candidate changed. Refresh the page.");
    if (!c.preScreen || !c.preScreenAssessment)
      throw new HiringError(409, "This candidate has no scored pre-screen response.");
    const waiting = await tx
      .select({ id: s.hiringOutbox.id })
      .from(s.hiringOutbox)
      .where(and(eq(s.hiringOutbox.candidateId, id), isVisitStageRow, inArray(s.hiringOutbox.status, [...WAITING_INVITE, "processing"])));
    // The score change promises no email follows, and this one would. Stop cancels it.
    if (waiting.length) throw new HiringError(409, "A visit email is waiting to send. Stop this candidate first if it must not go.");
    const before = c.preScreenOverride?.score ?? null;
    const reason = input.reason.trim();
    await tx
      .update(s.hiringCandidates)
      .set({ preScreenOverride: { score: input.score, reason, by: actor, at: now.toISOString() }, revision: c.revision + 1 })
      .where(eq(s.hiringCandidates.id, id));
    await audit(tx, actor, "pre-screen-score", id, { score: input.score, before, reason });
  });
}
export async function reviewCandidate(
  id: string,
  input: {
    revision: number;
    action: "advance" | "paper_pass" | "stop" | "invite_onsite" | "send_new_link" | "cancel_visit" | "mark_no_show";
    subjects: Subject[];
    reason: string;
  },
  actor: string,
  db: Database = getDb(),
  now = new Date(),
) {
  if (input.reason.trim().length < 5)
    throw new HiringError(400, "Write a reason of at least 5 characters.");
  return withDatabaseTransaction(db, async (tx) => {
    // Queue, then candidate, like a release: the other way round can deadlock against one. Settings come after the lock,
    // so a click uses the limits in force when it runs.
    await lockQueue(tx);
    await tx.execute(
      sql`select id from hiring_candidates where id=${id} for update`,
    );
    const c = await candidateById(tx, id),
      { config } = await settings(tx);
    if (c.revision !== input.revision)
      throw new HiringError(409, "This candidate changed. Refresh the page.");
    let detail: Record<string, unknown> = {};
    if (
      input.action === "invite_onsite" ||
      input.action === "send_new_link" ||
      (input.action === "advance" && c.preScreen)
    ) {
      const resend = input.action === "send_new_link" && c.stage === "onsite_invited";
      if (input.action === "send_new_link" && c.stage !== "no_booking" && !resend)
        throw new HiringError(409, "A new link can be sent only to someone invited and not booked, or after a cancel, a no-show or No booking.");
      if (resend && !config.deliveryEnabled)
        throw new HiringError(409, "Messages are off, so a new link cannot leave. The old link stays valid.");
      if (input.action === "send_new_link") await cancelWaitingInvites(tx, id);
      // A first invitation has one key, shared with the queue, so only send_new_link can ever send another.
      // A stopped candidate's invitation that was cancelled before it left is not a repeat. One that may have left still refuses.
      const earlier = c.stage === "stopped" ? await inviteRows(tx, id) : [];
      const unsent = earlier.length > 0 && earlier.every((r) => r.status === "cancelled");
      const key =
        input.action === "send_new_link" || unsent ? `${id}:visit-invite:${c.revision + 1}` : `${id}:visit-invite`;
      const subject = await inviteToVisit(tx, c, config, key, now, resend);
      await tx.update(s.hiringCandidates).set({ reviewNote: input.reason }).where(eq(s.hiringCandidates.id, id));
      detail = { subject, score: preScreenTotal(c, config), passScore: config.preScreenThreshold };
    } else if (input.action === "cancel_visit" || input.action === "mark_no_show") {
      const rows = await visitRows(tx, id);
      const exam = examOf(rows);
      if (!exam) throw new HiringError(409, "This candidate has no booked visit.");
      if (input.action === "cancel_visit" && exam.startTime <= now)
        throw new HiringError(409, "This visit has started. Mark a no-show instead.");
      if (input.action === "mark_no_show" && exam.startTime > now)
        throw new HiringError(409, "This visit has not started. Cancel it instead.");
      await endVisit(tx, rows, input.action === "cancel_visit" ? "cancelled" : "no_show", now);
      const mock = rows.find((b) => b.kind === "mock");
      if (mock && mock.startTime > now) await enqueue(tx, headNotice(mock, "cancelled"));
      await tx
        .update(s.hiringCandidates)
        .set({
          // A SEEK stop can leave a future visit behind, and that candidate stays stopped. A sent decision stands too.
          stage: c.stage === "stopped" || isDecided(c.stage) ? c.stage : "no_booking",
          inviteExpiresAt: null,
          reviewNote: input.reason,
          revision: c.revision + 1,
          updatedAt: now,
        })
        .where(eq(s.hiringCandidates.id, id));
      detail = { visitId: exam.visitId, examStart: exam.startTime.toISOString() };
    } else if (input.action === "stop") {
      if (isDecided(c.stage)) throw new HiringError(409, "A result was already sent to this candidate. Send a new decision to change it.");
      const appointments = await tx
        .select()
        .from(s.hiringBookings)
        .where(
          and(
            eq(s.hiringBookings.candidateId, id),
            eq(s.hiringBookings.status, "confirmed"),
          ),
        );
      if (appointments.some((b) => b.endTime > new Date()))
        throw new HiringError(
          409,
          "This candidate has a future appointment. Resolve it with the hiring coordinator before stopping processing.",
        );
      await tx
        .update(s.hiringCandidates)
        .set({
          stage: "stopped",
          reviewNote: input.reason,
          revision: c.revision + 1,
          inviteExpiresAt: null,
        })
        .where(eq(s.hiringCandidates.id, id));
      await tx
        .update(s.hiringOutbox)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(s.hiringOutbox.candidateId, id),
            inArray(s.hiringOutbox.status, ["pending", "failed"]),
            // A visit cancelled just before this stop must still leave the calendars.
            sql`${s.hiringOutbox.kind} <> 'calendar_cancel' and coalesce(${s.hiringOutbox.payload}->>'notice','') <> 'cancelled'`,
          ),
        );
    } else {
      if (
        !input.subjects.length ||
        new Set(input.subjects).size !== input.subjects.length
      )
        throw new HiringError(400, "Select at least one distinct subject.");
      if (input.action === "paper_pass") {
        if (
          ![
            "paper_booked",
            "paper_invited",
            "paper_passed",
            "mock_booked",
          ].includes(c.stage) ||
          input.subjects.some((subject) => !c.subjects.includes(subject))
        )
          throw new HiringError(
            409,
            "Record a pass only for subjects selected for the paper assessment.",
          );
        const papers = await tx
          .select()
          .from(s.hiringBookings)
          .where(
            and(
              eq(s.hiringBookings.candidateId, id),
              eq(s.hiringBookings.kind, "paper"),
              eq(s.hiringBookings.status, "confirmed"),
            ),
          );
        if (papers.some((p) => p.endTime > new Date()))
          throw new HiringError(
            409,
            "The booked paper assessment has not finished.",
          );
        const [updated] = await tx
          .update(s.hiringCandidates)
          .set({
            stage: "paper_passed",
            paperPassedSubjects: input.subjects,
            paperPassedAt: new Date(),
            paperRecordedBy: actor,
            reviewNote: input.reason,
            revision: c.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(s.hiringCandidates.id, id))
          .returning();
        await inviteToMock(
          tx,
          updated,
          config,
          `${id}:mock-invite:${updated.revision}`,
        );
      } else {
        // The form. A response went to the visit branch above, so this path can never send a paper invitation.
        if (!["new", "review"].includes(c.stage))
          throw new HiringError(
            409,
            "This candidate already had the pre-screen form. Do not send another.",
          );
        if (!workRightsAccepted(c.workRightsAnswer, config.acceptedWorkRights))
          throw new HiringError(409, "The work-rights answer is missing or not accepted.");
        const subject = topHiringSubject(input.subjects, config.subjectPriority);
        if (!subject)
          throw new HiringError(409, "None of the selected subjects is open for hiring.");
        const limit = blockingLimit("pre_screen", subject, await readLimitUsage(tx, "pre_screen", now), config);
        if (limit)
          throw new HiringError(409, `The pre-screen limit "${LIMIT_TEXT[limit]}" is full. Raise the number to send more.`);
        if (!(await inviteToPreScreen(tx, c, now)))
          throw new HiringError(409, "A pre-screen form was already queued for this candidate. No new form can be sent.");
        // Kevin's rule: a click past the call queue counts as HR's good call.
        const skippedCall = profileGate(c, config).awaitingCall;
        if (skippedCall) detail = { goodCall: "manual" };
        await tx
          .update(s.hiringCandidates)
          .set({
            ...(skippedCall && {
              callReview: { good: { at: now.toISOString(), by: actor, manual: true as const }, tries: c.callReview?.tries ?? [] },
            }),
            stage: "pre_screen",
            // The limits read the first subject as the queue subject.
            subjects: [subject, ...input.subjects.filter((v) => v !== subject)],
            reviewNote: input.reason,
            revision: c.revision + 1,
            updatedAt: now,
          })
          .where(eq(s.hiringCandidates.id, id));
      }
    }
    await audit(tx, actor, input.action, id, {
      subjects: input.subjects,
      reason: input.reason,
      ...detail,
    });
  });
}
// Postgres JSONB reorders keys; evidence hashes must survive that round trip.
export const sourceHash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      ),
    )
    .digest("hex");
