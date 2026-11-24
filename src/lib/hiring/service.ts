import { z } from "zod";
import { queueRecruitmentMock } from "./recruitment";
import { PRESTIGE_RULES } from "./prestige";
import { createHash, randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { availableSlots, availableVisitSlots, callSlots, r1Slots, readLiveBusy, verifyLiveSlot, type LiveBusy } from "./availability";
import {
  baseConfigSchema,
  withSeekJobs,
  bookingSchema,
  CALL_DAY_END,
  CALL_DAY_START,
  CALL_LINK_DAYS,
  CALL_MINUTES,
  CONTRACT_MINUTES,
  contractTestAllowed,
  callBookingSchema,
  configRuleErrors,
  configSchema,
  HiringError,
  HR_CALENDAR,
  HR_CALL_KEY,
  instant,
  isVisitBooking,
  PRE_SCREEN_URL,
  normalizeSubjects,
  overlap,
  runtimeWritesAllowed,
  shiftDate,
  isDecided,
  localDate,
  visitBookingSchema,
  ZONE,
  businessDates,
  type HiringConfig,
  type Stage,
  type Subject,
  mockCanFollow,
} from "./model";
import {
  availabilityFraction,
  hardStops,
  preScreenPoints,
  profileScore,
  workRightsPenalty,
  supportedVisitSubjects,
  topHiringSubject,
  visitSubject,
  workRightsAccepted,
} from "./scoring";
import { googleConnectionStatus, readHrBusy } from "./google";
import { visitClashes } from "./head-schedule";
import { bookingToken, readBookingToken, VISIT_LINK_DAYS } from "./tokens";
import { storedResume } from "./resume-files";
import { blockingLimit, headWeekMocks, releaseQueue, type Funnel, type LimitName, type QueueHold } from "./limits";
import {
  callInviteSentAt,
  inviteRows,
  linkSentAt,
  lockQueue,
  callEntries,
  callQueue,
  formCandidates,
  onsiteEntries,
  onsiteRows,
  preScreenEntries,
  preScreenTotal,
  readLimitUsage,
} from "./queue";
import { profileGate } from "./insights";
import { FUNNEL_AUDIT_ACTIONS, windowStart } from "./funnel";
import { headDayState, weekWith } from "./rules";
import { attendanceAccessForEmail } from "@/lib/tutor-attendance/access";
import { attendanceConfig } from "@/lib/tutor-attendance/data";
import { saveAttendanceSettings } from "@/lib/tutor-attendance/service";
import { applicableSchedule, AttendanceError, weekSchema, type Week } from "@/lib/tutor-attendance/model";
import { checkRubric, computeSheet, passRulesFor, RUBRIC_ITEMS, rubricNeedsCheck, rubricTotals, type MockRubric } from "./marking-sheet";
import { formatInTimeZone } from "date-fns-tz";
import { HIRING_LINE_URL, hiringEmail, mockPrep, stepIcon, TWO_DAY_STEPS, VISIT_BRING, VISIT_LENGTH, VISIT_STEPS } from "./email";

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
/** A recorded paper pass opens the mock booking link. */
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
  const prep = mockPrep(candidate.paperPassedSubjects.join(", "));
  await enqueue(db, {
    key,
    candidateId: candidate.id,
    kind: "email",
    payload: {
      to: candidate.email,
      ...hiringEmail({
        subject: "BeGifted mock teaching invitation",
        hero: "visit",
        preheader: "Book your onsite mock teaching session.",
        title: "Book your mock teaching session",
        tone: "ink",
        name: candidate.name,
        paragraphs: [
          `You have passed the recorded paper assessment for ${candidate.paperPassedSubjects.join(", ")}. Please book your onsite mock teaching session.`,
        ],
        details: [
          { label: "Subjects", value: candidate.paperPassedSubjects.join(", ") },
          { label: "Session", value: "1 hour for each subject" },
          { label: "Location", value: config.location },
        ],
        action: { label: "Book your session", url },
        after: prep.paragraphs,
        links: prep.links,
      }),
      workflowStage: "paper_passed",
      ...(candidate.visitSubject ? { closeLoop: true } : {}),
    },
  });
  await db
    .update(s.hiringCandidates)
    .set({ inviteExpiresAt: expiry, updatedAt: new Date() })
    .where(eq(s.hiringCandidates.id, candidate.id));
}
/**
 * The "Next steps" email (Kevin, 22 Nov 2026): the form and the visit link together. The visit link
 * opens booking only after the answers pass the usual checks; until then its page asks for the answers first.
 * `inviteExpiresAt` holds the link's second, and `inviteToVisit` keeps it, so this same link books the visit.
 */
export async function inviteToPreScreen(db: Database, candidate: Candidate, now = new Date()) {
  if (!candidate.email)
    throw new HiringError(409, "A verified application email is required.");
  const expires = new Date((Math.floor(now.getTime() / 1000) + VISIT_LINK_DAYS * 86400) * 1000);
  const queued = await enqueue(db, {
    key: `${candidate.id}:pre-screen`,
    candidateId: candidate.id,
    kind: "email",
    // Day and week limits read this time, so it comes from the same clock as the limit check.
    createdAt: now,
    payload: {
      to: candidate.email,
      workflowStage: "pre_screen",
      ...preScreenEmail(candidate.name, candidate.email, false, visitLink(candidate.id, expires),
        // Not for a candidate whose HR interview took place and went well: for them the sentence would be false.
        !candidate.callReview?.good && !!(await callInviteSentAt(db, candidate.id))),
    },
  });
  if (queued)
    await db.update(s.hiringCandidates).set({ inviteExpiresAt: expires }).where(eq(s.hiringCandidates.id, candidate.id));
  return queued;
}
/**
 * New links are "two-day" (Kevin, 24 Nov 2026): the test, Monday to Sunday, and the final-round mock teaching on a later
 * day, Monday to Friday, booked together. A "visit" link sent earlier still books both on one day, and a "paper-visit"
 * the test only.
 */
export const visitLink = (id: string, expires: Date, kind: VisitLink["kind"] = "two-day") =>
  new URL(
    `/hiring/book/${bookingToken(id, kind, expires)}`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
export const callLink = (id: string, expires: Date) =>
  new URL(
    `/hiring/book/${bookingToken(id, "call", expires)}`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
/**
 * The invitation to book R1: HR Interview (Kevin, 22 Nov 2026: thank and congratulate the candidate, and show the
 * process). It holds no times: the page reads HR's calendar when it opens.
 */
export const callInviteEmail = (input: { name: string; url: string; reminder?: boolean }) =>
  hiringEmail({
    subject: input.reminder ? "Reminder: book your R1: HR Interview with BeGifted" : "Congratulations! Book your R1: HR Interview with BeGifted",
    preheader: input.reminder
      ? `Your R1 interview is still open to book: a ${CALL_MINUTES}-minute Google Meet with our HR team.`
      : `You are through to R1: a ${CALL_MINUTES}-minute Google Meet with our HR team. Choose a time.`,
    title: input.reminder ? "Your R1 interview is still open to book" : "Congratulations! You are through to R1",
    name: input.name,
    paragraphs: [
      input.reminder
        ? "We invited you to R1: HR Interview for the BeGifted tutor role, and we do not have a booking from you yet. Your place is still open."
        : "Thank you for your application to become a BeGifted tutor. Congratulations: your application stood out, and we invite you to R1: HR Interview.",
      `R1 is a ${CALL_MINUTES}-minute video call on Google Meet with our HR team. Please choose a time that suits you.`,
    ],
    details: [
      { label: "Interview", value: "R1: HR Interview" },
      { label: "Format", value: `${CALL_MINUTES} minutes, Google Meet video call` },
      { label: "Times", value: "Monday to Friday, 13:15–18:00 (Bangkok time)" },
      { label: "Link closes", value: `${CALL_LINK_DAYS} days after this email` },
    ],
    action: { label: "Book your R1 interview", url: input.url },
    hero: "r1",
    process: 1,
    after: [
      "After you book, Google Calendar sends you an invitation with the Google Meet link. The booking page also asks for a phone number, which we use only if the video call fails.",
    ],
  });
/**
 * Queues the call booking link, once per candidate. `workflowStage` cancels it if the candidate leaves `new` before it
 * is sent, and a SEEK contact or a stop cancels it while it waits, like any other invitation.
 */
export async function inviteToCall(db: Database, candidate: Candidate, now = new Date(), reminder = false) {
  if (!candidate.email)
    throw new HiringError(409, "A verified application email is required.");
  // The reminder holds a new link with a full life. The first link stays valid until its own end.
  const expires = new Date((Math.floor(now.getTime() / 1000) + CALL_LINK_DAYS * 86400) * 1000);
  return enqueue(db, {
    key: `${candidate.id}:call-invite${reminder ? "-reminder" : ""}`,
    candidateId: candidate.id,
    kind: "email",
    // The day limit reads this time, so it comes from the same clock as the limit check.
    createdAt: now,
    payload: {
      to: candidate.email,
      workflowStage: "new",
      ...callInviteEmail({ name: candidate.name, url: callLink(candidate.id, expires), reminder }),
    },
  });
}
/**
 * The form invitation and its reminder. With a visit link it is the "Next steps" email: answer the questions, then book
 * the test and the mock teaching on that link. A form sent before 22 Nov 2026 has no visit link.
 * `hrLeft` is for a candidate who got a link to the old R1: HR Interview (Kevin, 24 Nov 2026: say that the HRBP is no
 * longer available, thank the candidate for their patience and apologise).
 */
export const preScreenEmail = (name: string, email: string, reminder: boolean, visitUrl?: string, hrLeft = false) =>
  visitUrl
    ? hiringEmail({
        subject: reminder
          ? "Reminder: answer your BeGifted pre-screening questions"
          : "Next steps: your BeGifted pre-screening questions and onsite visit",
        preheader: "Answer a short questionnaire, then book your test and your mock teaching.",
        title: reminder ? "Your questions are still open" : "Here are your next steps",
        hero: "next",
        name,
        paragraphs: reminder
          ? ["We have not yet received your pre-screening answers. If you are still interested in joining BeGifted, please answer them. Then you can book your test and your mock teaching."]
          : hrLeft
            ? [
                "Thank you for your interest in joining BeGifted, and for your patience.",
                "Our HR Business Partner is no longer available because of emergency circumstances, so there is no HR interview. Your link to book the HR interview is closed. We sincerely apologise for the inconvenience.",
                "The good news is that you go directly to the next steps: a subject test and a final-round mock teaching interview at BeGifted.",
              ]
            : ["Thank you for your interest in joining BeGifted. We invite you to the next steps."],
        details: [
          { label: "Use this email", value: email },
          { label: "Questionnaire", value: "About 5–7 minutes" },
          { label: "Onsite visits", value: VISIT_LENGTH },
        ],
        stepsHeading: "Your next steps",
        steps: [
          {
            heading: "Answer the pre-screening questions",
            paragraphs: [
              "Use this email address on the form. One question asks which subject you want to be tested on at your visit.",
            ],
            action: { label: "Open the questionnaire", url: PRE_SCREEN_URL },
            icon: stepIcon(2),
          },
          {
            heading: "Book your test and your mock teaching",
            paragraphs: [
              "We check your answers first. When booking opens, we email you. Then choose your two times on this link: the test first, and the mock teaching on the same day or a later day.",
            ],
            action: { label: "Book your test and mock teaching", url: visitUrl },
            icon: stepIcon(3),
          },
        ],
      })
    : hiringEmail({
        subject: reminder ? "Reminder: BeGifted tutor pre-screening questionnaire" : "BeGifted tutor pre-screening questionnaire",
        preheader: "A short questionnaire, about 5–7 minutes.",
        title: reminder ? "Your questionnaire is still open" : "Your pre-screening questionnaire",
        name,
        paragraphs: [
          reminder
            ? "We have not yet received your pre-screening questionnaire. If you are still interested in joining BeGifted, please complete it."
            : "Thank you for your interest in joining BeGifted. Please complete our short pre-screening questionnaire.",
        ],
        details: [
          { label: "Use this email", value: email },
          { label: "Time needed", value: "About 5–7 minutes" },
        ],
        action: { label: "Open the questionnaire", url: PRE_SCREEN_URL },
        after: reminder ? [] : ["We will contact you after reviewing your response."],
      });
/** The onsite visit invitation and its reminder. */
export const visitInviteEmail = (input: { name: string; subject: string; url: string; location: string; expireDays?: number }) =>
  hiringEmail({
    subject: input.expireDays === undefined ? "Reminder: book your BeGifted onsite visit" : "BeGifted onsite visit invitation",
    hero: "visit",
    preheader: `Book your test and your mock teaching for ${input.subject}.`,
    title: input.expireDays === undefined ? "Your test and mock teaching are not booked yet" : "Book your test and mock teaching",
    tone: "ink",
    name: input.name,
    paragraphs: [
      input.expireDays === undefined
        ? `You have not yet booked your test and your mock teaching for ${input.subject}.`
        : `Thank you for your pre-screening response. We invite you to the test and the final-round mock teaching for ${input.subject}.`,
    ],
    details: [
      { label: "Subject", value: input.subject },
      { label: "Test and mock teaching", value: VISIT_LENGTH },
      { label: "Location", value: input.location },
      ...(input.expireDays === undefined ? [] : [{ label: "Link closes", value: `${input.expireDays} days after this email` }]),
    ],
    action: { label: "Book your two times", url: input.url },
    stepsHeading: "Your test and mock teaching",
    steps: TWO_DAY_STEPS,
    list: VISIT_BRING,
    after: ["You book both times together: the test first, then the mock teaching on the same day or a later day.", ...mockPrep(input.subject).paragraphs],
    links: mockPrep(input.subject).links,
  });
const onLine = (text: string) => `${text} Contact BeGifted on LINE: ${HIRING_LINE_URL}`;
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
  const supported = supportedVisitSubjects(c.preScreen, c.workRightsAnswer, config);
  if (!topHiringSubject(supported, config.subjectPriority))
    throw new HiringError(409, "No supported subject is open for hiring.");
  const subject = visitSubject(c.preScreen, c.workRightsAnswer, config);
  if (!subject)
    throw new HiringError(409, `No head is set for the subject: ${supported.join(", ")}.`);
  const limit = resend ? null : blockingLimit("onsite", subject, await readLimitUsage(tx, "onsite", now), config);
  if (limit)
    throw new HiringError(409, `The onsite limit "${LIMIT_TEXT[limit]}" is full. Raise the number to send more.`);
  // The "Next steps" email already gave this candidate a visit link. Keep its second, so that link now books the visit,
  // but only while it outlasts the whole onsite window: a shorter link would show few times and expire early.
  const kept =
    !resend &&
    ["pre_screen", "no_reply"].includes(c.stage) &&
    c.inviteExpiresAt &&
    c.inviteExpiresAt.getTime() >= now.getTime() + config.onsiteFollowUp.expireDays * DAY
      ? c.inviteExpiresAt
      : null;
  const expires = kept ?? new Date(
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
      workflowStage: "onsite_invited",
      // The follow-up reminder for this link uses this number, so a later change to the row cannot send a second one.
      revision,
      ...(resend ? { resend: true } : {}),
      ...visitInviteEmail({
        name: c.name,
        subject,
        url: visitLink(c.id, expires),
        location: config.location,
        expireDays: config.onsiteFollowUp.expireDays,
      }),
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
  const monthStart = fromZonedTime(`${localDate(now).slice(0, 7)}-01T00:00:00`, ZONE);
  const [papers, mocks, decisions, library, [spent = { usd: 0, unknown: 0 }]] = await Promise.all([
    db.select().from(s.hiringPaperResults).orderBy(asc(s.hiringPaperResults.subject)),
    db.select().from(s.hiringMockResults).orderBy(asc(s.hiringMockResults.subject)),
    db.select().from(s.hiringDecisions).orderBy(desc(s.hiringDecisions.createdAt)),
    db
      .select({
        id: s.hiringAssessmentFiles.id,
        kind: s.hiringAssessmentFiles.kind,
        subject: s.hiringAssessmentFiles.subject,
        name: s.hiringAssessmentFiles.name,
        // The run sheet offers only a ready paper.
        status: s.hiringAssessmentFiles.status,
        createdAt: s.hiringAssessmentFiles.createdAt,
      })
      .from(s.hiringAssessmentFiles)
      .where(eq(s.hiringAssessmentFiles.active, true)),
    // Each model call writes one audit row, so a repeat of a paper still counts.
    db
      .select({
        usd: sql<number>`coalesce(sum((${s.hiringAudit.detail}->>'costUsd')::float), 0)::float`,
        unknown: sql<number>`(count(*) filter (where ${s.hiringAudit.detail}->>'costUsd' is null))::int`,
      })
      .from(s.hiringAudit)
      .where(and(eq(s.hiringAudit.action, "assessment-ai-call"), gte(s.hiringAudit.createdAt, monthStart))),
  ]);
  return {
    papers: papers.map((row) => ({ ...row, aiMarks: undefined, stuck: row.status === "marking" && now.getTime() - row.updatedAt.getTime() > MARKING_STUCK_AFTER_MS })),
    mocks: mocks.map((row) => ({ ...row, aiRubric: undefined, stuck: row.status === "marking" && now.getTime() - row.updatedAt.getTime() > MARKING_STUCK_AFTER_MS })),
    decisions,
    library,
    // A provider can leave the cost out, and then the total is only a floor.
    markingSpend: { usd: spent.usd, complete: spent.unknown === 0 },
  };
}

// The dashboard never reads the profile text (5.5 MB over all rows). It only needs to know if there is any.
const { profileText, ...candidateColumns } = getTableColumns(s.hiringCandidates);
/** Not-blank text, as JS `.trim()` sees it: ASCII space and the Unicode spaces it also strips (NBSP, U+FEFF, U+3000…). Listed, so the Postgres locale cannot change it. */
export const NOT_BLANK_PATTERN = "[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

/** No link secret means no head links. The dashboard must still load. */
function briefPaths(bookings: { id: string; kind: string; status: string; endTime: Date }[], now: Date): Record<string, string> {
  try {
    return Object.fromEntries(
      bookings
        .filter((b) => b.kind === "mock" && b.status === "confirmed" && b.endTime.getTime() > now.getTime() - BRIEF_DAYS * 86400000)
        .map((b) => [b.id, new URL(briefLink(b)).pathname]),
    );
  } catch (error) {
    if (error instanceof HiringError) return {};
    throw error;
  }
}
export async function dashboard(db: Database = getDb()) {
  const now = new Date();
  // Every read here is independent, so they go in one wave. Only visitClashes and the onsite entries wait for this one.
  const [
    { row, config },
    candidates,
    allBookings,
    outbox,
    contacts,
    groups,
    auditRows,
    preScreenUsage,
    onsiteUsage,
    forms,
    enrollments,
    schedules,
    inviteOutbox,
    assessment,
    funnelAudit,
    onsiteRead,
    headDecisionRows,
  ] = await Promise.all([
    settings(db),
    db
      .select({ ...candidateColumns, hasSourceText: sql<boolean>`${profileText} ~ ${NOT_BLANK_PATTERN}` })
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
      .where(ne(s.hiringAudit.action, "final-review-packet"))
      .orderBy(desc(s.hiringAudit.createdAt))
      .limit(50),
    // The meters and the queue notes read the same counts and the same release function the worker uses. Postgres only.
    readLimitUsage(db, "pre_screen", now),
    readLimitUsage(db, "onsite", now),
    // One read for the call queue and the form queue.
    formCandidates(db),
    db.select().from(s.tutorAttendanceEnrollments),
    db.select().from(s.tutorAttendanceSchedules),
    db
      .select({
        key: s.hiringOutbox.key,
        candidateId: s.hiringOutbox.candidateId,
        status: s.hiringOutbox.status,
        error: s.hiringOutbox.error,
        sentAt: s.hiringOutbox.sentAt,
      })
      .from(s.hiringOutbox)
      .where(
        sql`${s.hiringOutbox.key} = ${s.hiringOutbox.candidateId}::text || ':pre-screen' or ${s.hiringOutbox.key} = ${s.hiringOutbox.candidateId}::text || ':call-invite' or ${s.hiringOutbox.key} like ${s.hiringOutbox.candidateId}::text || ':visit-invite%' or ${s.hiringOutbox.key} like ${s.hiringOutbox.candidateId}::text || ':result:%'`,
      )
      .orderBy(desc(s.hiringOutbox.createdAt)),
    assessmentData(db, now),
    db
      .select({ candidateId: s.hiringAudit.candidateId, action: s.hiringAudit.action, at: s.hiringAudit.createdAt })
      .from(s.hiringAudit)
      // The funnel counts only people first seen in its window, and their events come after that.
      .where(
        and(
          inArray(s.hiringAudit.action, FUNNEL_AUDIT_ACTIONS),
          gte(s.hiringAudit.createdAt, new Date(windowStart(now))),
        ),
      ),
    // The onsite reads need no config; only the gate below does.
    onsiteRows(db),
    // Head decisions, newest first. The role screens show the newest one for each candidate.
    db
      .select({ candidateId: s.hiringAudit.candidateId, detail: s.hiringAudit.detail, at: s.hiringAudit.createdAt })
      .from(s.hiringAudit)
      .where(eq(s.hiringAudit.action, "head-decision"))
      .orderBy(desc(s.hiringAudit.createdAt))
      .limit(200),
  ]);
  // The visit screens never see an HR call. The Calls tab reads `calls`.
  const bookings = allBookings.filter(isVisitBooking);
  const calls = allBookings
    .filter((b) => b.kind === "call" && b.status === "confirmed")
    .map((b) => ({ candidateId: b.candidateId, start: b.startTime, end: b.endTime }));
  const missedCalls = allBookings
    .filter((b) => b.kind === "call" && b.status === "no_show")
    .map((b) => ({ candidateId: b.candidateId, start: b.startTime }));
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
  // visitClashes is one shared read for all heads. It never fails the dashboard: a missing index reports stale.
  // The queue gates below run after the suggested heads above, because they read config.
  const clashes = await visitClashes(db, bookings);
  const usage = { preScreen: preScreenUsage, onsite: onsiteUsage };
  const holds: Record<string, QueueHold> = {};
  let preScreenOrder: string[] = [];
  // Booked calls first, in time order (the newest booking of a candidate decides); then the automatic order.
  const callAt = new Map<string, number>();
  for (const call of [...calls].reverse()) callAt.set(call.candidateId, call.start.getTime());
  const toCall = callEntries(forms, config).map((entry) => entry.id);
  const callOrder = [
    ...toCall.filter((id) => callAt.has(id)).sort((a, b) => callAt.get(a)! - callAt.get(b)!),
    ...toCall.filter((id) => !callAt.has(id)),
  ];
  for (const funnel of ["pre_screen", "onsite"] as const satisfies Funnel[]) {
    const entries = funnel === "pre_screen" ? preScreenEntries(forms, config) : onsiteEntries(onsiteRead, config);
    const { release, held, order } = releaseQueue(funnel, entries, funnel === "pre_screen" ? usage.preScreen : usage.onsite, config);
    if (funnel === "pre_screen") preScreenOrder = order;
    for (const e of release) holds[e.id] = { funnel, state: "next", position: 0, limit: null, subject: e.subject };
    for (const e of held) holds[e.id] = { funnel, state: "held", position: e.position, limit: e.limit, subject: e.subject };
  }
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
        // The stored list can be long, and the screen only needs to know the row was moved.
        queueManual: !!c.queueManual,
        // The screen reads workRightsAnswer. This old column stays in the database only.
        workRightsConfirmed: undefined,
        // The text itself is read on demand. hasSourceText (from SQL) tells the screen whether there is any, such as for a person added from the tracker.
        // The screen opens a file only through the guarded route, so it never gets the storage path.
        resumePath: undefined,
        resumeSha256: undefined,
        resumeState: (c.resumePath ? "available" : c.resumeStoredAt ? "deleted" : "none") as "available" | "deleted" | "none",
        profileScore: c.profileAssessment
          ? profileScore(
              c.profileAssessment,
              config.profileWeights,
              c.universityAssessment?.fraction ?? 0,
              workRightsPenalty(c.workRightsAnswer, config),
            )
          : null,
        // The pre-screen score is the eight-part total, not the profile formula.
        preScreenScore: parts?.total ?? null,
        preScreenParts: parts,
        workRightsPenalty: workRightsPenalty(c.workRightsAnswer, config),
        workRightsAccepted: workRightsAccepted(
          c.workRightsAnswer,
          config.acceptedWorkRights,
        ),
        // The gate on the screen must agree with the worker: a sent call link lifts the earlier-contact hold.
        callInvited: inviteOutbox.some((o) => o.key === `${c.id}:call-invite` && o.status === "sent"),
        callBooked: calls.some((call) => call.candidateId === c.id),
      };
    }),
    bookings,
    calls,
    missedCalls,
    headDecisions: headDecisionRows.map((row) => ({
      candidateId: row.candidateId,
      bookingId: typeof row.detail.bookingId === "string" ? row.detail.bookingId : null,
      decision: row.detail.decision === "hire" ? ("hire" as const) : ("reject" as const),
      reason: String(row.detail.reason ?? ""),
      head: String(row.detail.head ?? ""),
      draftProblem: typeof row.detail.draftProblem === "string" ? row.detail.draftProblem : null,
      at: row.at,
    })),
    // The head's page for each mock (scores and decision), as a path. The same link the head gets in LINE.
    briefPaths: briefPaths(bookings, now),
    visitClashes: clashes,
    outbox,
    // The capped list above holds every kind of row, so the pre-screen screen reads its proof from this full read.
    inviteOutbox,
    audit: auditRows,
    // The funnel dates stages from these. The audit list above holds the newest 50 rows only.
    funnelEvents: [
      ...funnelAudit,
      ...allBookings
        .filter((b) => b.kind === "call")
        .map((b) => ({ candidateId: b.candidateId, action: "call-booked", at: b.createdAt })),
    ],
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
  if (cap.kind !== "paper" && cap.kind !== "mock")
    throw new HiringError(404, "This booking link is no longer active.");
  return { ...cap, kind: cap.kind };
}
/**
 * The live Wise read for a time list. On any failure the list falls back to the 30-minute Wise copy
 * (owner decision, 11 Nov 2026): the confirm step still reads Wise live, so no clash can be booked.
 */
async function liveForList(db: Database, config: HiringConfig, subjects: Subject[], now: Date): Promise<LiveBusy | null> {
  try {
    return await readLiveBusy(
      db,
      config.interviewers.filter((h) => subjects.every((v) => h.subjects.includes(v))).map((h) => h.canonicalKey),
      businessDates(now, config.holidays),
      { cacheMs: 60_000, deadlineMs: 12_000 },
    );
  } catch (error) {
    // A HiringError message is our own text (for example a class with no teacher), so it is safe to log.
    console.error("[hiring] live Wise list read failed", error instanceof HiringError ? error.message : error instanceof Error ? error.name : "unknown");
    return null;
  }
}
async function assertPassingPaper(db: Database, candidateId: string, subject: Subject, config: HiringConfig) {
  const [result] = await db.select().from(s.hiringPaperResults).where(and(
    eq(s.hiringPaperResults.candidateId, candidateId), eq(s.hiringPaperResults.subject, subject),
  ));
  if (result?.status !== "done" || !result.fileId || !result.marks ||
    computeSheet(result.marks, passRulesFor(config, subject)).result !== "passed")
    throw new HiringError(409, "Finish grading and confirm a passing paper before booking mock teaching.");
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
  // The onsite link covers the paper. A separate mock link requires a recorded pass.
  if (
    candidate.stage === "stopped" ||
    isDecided(candidate.stage) ||
    (candidate.visitSubject && (cap.kind !== "mock" || !candidate.paperPassedAt || !["paper_passed", "mock_booked"].includes(candidate.stage))) ||
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
  if (cap.kind === "mock" && candidate.visitSubject) {
    if (!config.deliveryEnabled) throw new HiringError(503, "Mock booking is temporarily unavailable.");
    await assertPassingPaper(db, candidate.id, candidate.visitSubject, config);
  }
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
  const open = canBook && remaining.length === chosen.length;
  const live = open && cap.kind === "mock" ? await liveForList(db, config, chosen, now) : null;
  return {
    kind: cap.kind,
    checkedAt: live?.checkedAt ?? null,
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
      open
        ? (await availableSlots(db, config, cap.kind, chosen, now, db, live ?? undefined)).filter(
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
      (candidate.visitSubject && (cap.kind !== "mock" || !candidate.paperPassedAt || !["paper_passed", "mock_booked"].includes(candidate.stage))) ||
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
    if (cap.kind === "mock" && candidate.visitSubject) {
      if (!latest.config.deliveryEnabled) throw new HiringError(503, "Mock booking is temporarily unavailable.");
      await assertPassingPaper(tx, candidate.id, candidate.visitSubject, latest.config);
    }
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
          ...hiringEmail({
            subject: `BeGifted ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} confirmed`,
            hero: "visit",
            preheader: `Your ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} appointment is confirmed.`,
            title: `Your ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} is confirmed`,
            tone: "ink",
            name: candidate.name,
            paragraphs: [`Your ${cap.kind === "mock" ? "mock teaching" : "paper assessment"} appointment is confirmed.`],
            details: [
              { label: "Subjects", value: input.subjects.join(", ") },
              {
                label: "Time",
                value: `${bangkok(new Date(slot.start))}–${bangkokTime(new Date(slot.end))} (Bangkok)`,
              },
              { label: "Location", value: latest.config.location },
              ...(interviewer ? [{ label: "Interviewer", value: interviewer.canonicalKey }] : []),
            ],
            after: ["For changes, message BeGifted on LINE."],
          }),
        },
      });
    await enqueue(tx, {
      key: `booking:${id}:calendar`,
      candidateId: cap.id,
      bookingId: id,
      kind: "calendar",
      payload: {},
    });
    if (cap.kind === "mock") {
      const [booked] = await tx.select().from(s.hiringBookings).where(eq(s.hiringBookings.id, id));
      await queueRecruitmentMock(tx, booked, "booked");
      if (candidate.visitSubject && interviewer) {
        const brief = briefLink(booked);
        const files = new URL(`/api${new URL(brief).pathname}`, brief).toString();
        await enqueue(tx, {
          key: `booking:${id}:tutor-email`, candidateId: candidate.id, bookingId: id, kind: "email",
          payload: { to: interviewer.email, cc: [], ...hiringEmail({
            subject: `Mock teaching materials for ${candidate.name}`, preheader: bangkok(booking.startTime),
            title: "Prepare for mock teaching", name: interviewer.canonicalKey,
            paragraphs: [`Review the graded paper and résumé before the mock teaching session with ${candidate.name}.`],
            details: [{ label: "Time", value: `${bangkok(booking.startTime)} (Bangkok)` }],
            action: { label: "Open candidate page", url: brief },
            links: [
              { title: "Graded paper", description: "Marked exam PDF", url: `${files}/paper` },
              { title: "Résumé", description: "Original file", url: `${files}/resume` },
            ],
          }) },
        });
      }
    }
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
const BRIEF_DAYS = 7;
/** The interviewer's page for one mock: the form answers and the résumé. The link ends BRIEF_DAYS after the mock. */
export const briefLink = (mock: { id: string; endTime: Date }) =>
  new URL(
    `/hiring/brief/${bookingToken(mock.id, "brief", new Date(mock.endTime.getTime() + BRIEF_DAYS * 86400000))}`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
/** The résumé file alone, for the recruitment group's call notice. It ends BRIEF_DAYS after the call, or when the call does. */
export const callResumeLink = (call: { id: string; endTime: Date }) =>
  new URL(
    `/api/hiring/brief/${bookingToken(call.id, "brief", new Date(call.endTime.getTime() + BRIEF_DAYS * 86400000))}/resume`,
    process.env.APP_BASE_URL || "https://bgscheduler.vercel.app",
  ).toString();
/**
 * The mock (or, for a call notice's résumé link, the HR call) behind a link. Only a confirmed booking opens it, so a cancel, a move or a no-show ends the link at
 * once. A stopped candidate or a sent result ends it too: a past mock stays `confirmed`, and a person who asked BeGifted
 * to stop must not stay readable. Every failure is the same 404, so a link tells nothing about a booking.
 */
export async function briefMock(token: string, db: Database, now: Date, kinds: ("mock" | "call")[] = ["mock"]) {
  const cap = readBookingToken(token, now);
  const [row] =
    cap.kind === "brief"
      ? await db
          .select({ mock: s.hiringBookings, stage: s.hiringCandidates.stage })
          .from(s.hiringBookings)
          .innerJoin(s.hiringCandidates, eq(s.hiringCandidates.id, s.hiringBookings.candidateId))
          .where(
            and(eq(s.hiringBookings.id, cap.id), inArray(s.hiringBookings.kind, kinds), eq(s.hiringBookings.status, "confirmed")),
          )
      : [];
  if (!row || row.stage === "stopped" || isDecided(row.stage))
    throw new HiringError(404, "This link is invalid or has expired.");
  return row.mock;
}
/** The candidate whose stored résumé an interviewer link, or a call notice's résumé link, may open. The brief page stays mock-only. */
export async function briefCandidateId(token: string, db: Database = getDb(), now = new Date()) {
  return (await briefMock(token, db, now, ["mock", "call"])).candidateId;
}
/** What the interviewer sees. No contact details and no scores (Kevin's decision, 12 Nov 2026). */
export async function briefView(token: string, db: Database = getDb(), now = new Date()) {
  const mock = await briefMock(token, db, now);
  const [candidate] = await db
    .select({
      name: s.hiringCandidates.name,
      preScreen: s.hiringCandidates.preScreen,
      resumePath: s.hiringCandidates.resumePath,
      resumeType: s.hiringCandidates.resumeType,
    })
    .from(s.hiringCandidates)
    .where(eq(s.hiringCandidates.id, mock.candidateId));
  if (!candidate) throw new HiringError(404, "This link is invalid or has expired.");
  const [exam] = mock.visitId
    ? await db
        .select({ startTime: s.hiringBookings.startTime, endTime: s.hiringBookings.endTime })
        .from(s.hiringBookings)
        .where(
          and(
            eq(s.hiringBookings.visitId, mock.visitId),
            eq(s.hiringBookings.kind, "paper"),
            eq(s.hiringBookings.status, "confirmed"),
          ),
        )
    : [];
  const { config } = await settings(db);
  // Only the head's own scores and the form's state go to the page, never the stored row.
  const own = await briefRubric(mock, db, now);
  const [decided] = await db
    .select({ detail: s.hiringAudit.detail })
    .from(s.hiringAudit)
    .where(and(eq(s.hiringAudit.candidateId, mock.candidateId), eq(s.hiringAudit.action, "head-decision")))
    .orderBy(desc(s.hiringAudit.createdAt))
    .limit(1);
  const recommendationReady = own.form !== "wait" && !!(await completedBriefResult(db, mock));
  const result = own.replaced;
  const checking = result?.bookingId === mock.id && (result.status === "uploaded" || result.status === "marking");
  return {
    // The last head decision for this candidate, so the page shows what was sent.
    decision: (!decided?.detail.bookingId || decided.detail.bookingId === mock.id) && decided?.detail.decision === "hire" ? ("hire" as const) : decided?.detail.decision === "reject" ? ("reject" as const) : null,
    name: candidate.name,
    subject: mock.subjects.join(", "),
    gradedPaper: !!(await db.select({ id: s.hiringPaperResults.id }).from(s.hiringPaperResults).where(and(eq(s.hiringPaperResults.candidateId, mock.candidateId), eq(s.hiringPaperResults.subject, mock.subjects[0]), eq(s.hiringPaperResults.status, "done"), isNotNull(s.hiringPaperResults.fileId))).limit(1)).length,
    exam: exam ? `${bangkok(exam.startTime)}–${bangkokTime(exam.endTime)}` : null,
    mock: `${bangkok(mock.startTime)}–${bangkokTime(mock.endTime)}`,
    interviewer: mock.interviewerKey,
    location: config.location,
    answers: candidate.preScreen,
    resume: storedResume(mock.candidateId, candidate.resumePath, candidate.resumeType)?.extension ?? null,
    // The interviewer's own scores for this mock, to show again. Never an AI score or another person's.
    rubric: own.rubric,
    form: own.form,
    recommendationReady,
    recommendationBlock: own.form !== "closed" || recommendationReady ? null : checking ? ("checking" as const) : ("admin" as const),
  };
}
/** Read the completed result for this booking, using the same check for the brief and its decision. */
export async function completedBriefResult(db: Database, mock: { id: string; candidateId: string }) {
  const m = s.hiringMockResults;
  const [result] = await db.select({ id: m.id, rubric: m.rubric }).from(m).where(and(eq(m.candidateId, mock.candidateId),
    eq(m.bookingId, mock.id), eq(m.status, "done")));
  return result?.rubric && !checkRubric(result.rubric).length && !rubricNeedsCheck(result.rubric) ? result : null;
}
const briefSubject = (mock: { subjects: Subject[] }) => mock.subjects[0];
type MockResult = typeof s.hiringMockResults.$inferSelect;
/** The head's own sent scores, which no person with Hiring access has changed or confirmed since. */
const ownBriefRubric = (row: MockResult | undefined, mockId: string) =>
  row?.source === "person" && row.bookingId === mockId && !row.changedBy && !row.checkedBy ? row.rubric : null;
/**
 * What the score form shows. `wait`: the lesson has not started. `closed`: a result that is not this head's own untouched
 * scores is recorded, or a decision is drafted, so only a person with Hiring access can change it. The page shows a
 * rubric only when it is the head's own.
 */
async function briefRubric(mock: { id: string; candidateId: string; subjects: Subject[]; endTime: Date }, db: Database, now: Date) {
  const m = s.hiringMockResults;
  const subject = briefSubject(mock);
  const [row] = subject ? await db.select().from(m).where(and(eq(m.candidateId, mock.candidateId), eq(m.subject, subject))) : [];
  const [draft] = await db
    .select({ id: s.hiringDecisions.id })
    .from(s.hiringDecisions)
    .where(and(eq(s.hiringDecisions.candidateId, mock.candidateId), eq(s.hiringDecisions.status, "draft")))
    .limit(1);
  const rubric = ownBriefRubric(row, mock.id);
  const [recommended] = await db.select({ id: s.hiringAudit.id }).from(s.hiringAudit).where(and(
    eq(s.hiringAudit.candidateId, mock.candidateId), eq(s.hiringAudit.action, "head-decision"),
    sql`${s.hiringAudit.detail}->>'bookingId' = ${mock.id}`,
  )).limit(1);
  const closed = !subject || !!draft || !!recommended || (!!row && row.source !== "tracker" && !rubric);
  return { rubric, form: now < mock.endTime ? ("wait" as const) : closed ? ("closed" as const) : ("open" as const), replaced: row };
}
/**
 * The interviewer's scores for one mock, sent from the interviewer link (Kevin's decision, 13 Nov 2026: a score form,
 * not a file). The link is the only access check, as for the page. The result counts at once. It can replace only a
 * past tracker result or this head's own earlier send: never an upload, and never scores a person with Hiring access
 * changed or confirmed. A drafted decision closes it too, so a decision is never sent on scores nobody read. The audit
 * row keeps what it replaced. It changes no stage and queues no message.
 */
export const BRIEF_CLOSED = "Scores for this mock are already recorded. Ask BeGifted admin to change them.";
export async function saveBriefRubric(token: string, rubric: MockRubric, db: Database = getDb(), now = new Date()) {
  if (!runtimeWritesAllowed()) throw new HiringError(503, "Scores can be saved only on the live site.");
  const booking = await briefMock(token, db, now);
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${booking.candidateId} for update`);
    const mock = await briefMock(token, tx, now);
    const subject = briefSubject(mock);
    const { form, replaced: before } = await briefRubric(mock, tx, now);
    if (form === "wait") throw new HiringError(409, "You can send scores after the mock lesson ends.");
    if (form === "closed" || !subject) throw new HiringError(409, BRIEF_CLOSED);
    const problems = checkRubric(rubric);
    // The head's form is always the current one, so a send without an item or the checks answer is refused.
    if (problems.length || rubricNeedsCheck(rubric) || RUBRIC_ITEMS.some((id) => !(id in rubric.items)) || typeof rubric.checksDone !== "boolean")
      throw new HiringError(400, "Give every item a whole score from 1 to 10, and answer the required checks.");
    const m = s.hiringMockResults;
    const fresh = {
      bookingId: mock.id,
      source: "person" as const,
      status: "done" as const,
      fileId: null,
      aiRubric: null,
      rubric,
      history: null,
      model: null,
      promptVersion: null,
      costUsd: null,
      costKnown: true,
      error: null,
      checkedBy: null,
      checkedAt: null,
      changedBy: null,
      changedAt: null,
      updatedAt: now,
    };
    // The same rule again inside the write, so an upload or a change that lands between the read and here is not replaced.
    const saved = await tx
      .insert(m)
      .values({ candidateId: mock.candidateId, subject, ...fresh })
      .onConflictDoUpdate({
        target: [m.candidateId, m.subject],
        set: fresh,
        setWhere: sql`${m.source} = 'tracker' or (${m.source} = 'person' and ${m.bookingId} = ${mock.id} and ${m.changedBy} is null and ${m.checkedBy} is null)`,
      })
      .returning({ id: m.id });
    if (!saved.length) throw new HiringError(409, BRIEF_CLOSED);
    await audit(tx, `interviewer:${mock.interviewerKey ?? "unknown"}`, "mock-rubric-submitted", mock.candidateId, {
      subject,
      bookingId: mock.id,
      replaced: before ? { source: before.source, status: before.status, rubric: before.rubric, history: before.history } : null,
    });
    return rubricTotals(rubric).total;
  });
}
type VisitLink = { id: string; exp: number; kind: "visit" | "paper-visit" | "two-day" };
function visitToken(token: string, now: Date): VisitLink {
  const cap = readBookingToken(token, now);
  if (cap.kind !== "visit" && cap.kind !== "paper-visit" && cap.kind !== "two-day") throw new HiringError(404, onLine("This booking link is no longer active."));
  return { ...cap, kind: cap.kind };
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
/**
 * A "Next steps" link before booking opens: "answers" while the form is unanswered, "checking" while the answers wait
 * for the checks or a person. Null for every other link.
 */
function answersFirst(candidate: Candidate, cap: VisitLink): "answers" | "checking" | null {
  if (!["pre_screen", "no_reply"].includes(candidate.stage) || candidate.inviteExpiresAt?.getTime() !== cap.exp * 1000) return null;
  return candidate.preScreen ? "checking" : "answers";
}
const ANSWERS_FIRST = {
  answers: `Please answer the pre-screening questions first: ${PRE_SCREEN_URL} When booking opens, we email you, and this link lets you book.`,
  checking: "Thank you for your answers. We have them. When booking opens, we email you, and this link lets you book. If we have a question, we contact you.",
};

async function openVisit(db: Database, cap: VisitLink, config: HiringConfig, now: Date) {
  const candidate = await candidateById(db, cap.id);
  const first = answersFirst(candidate, cap);
  if (first) throw new HiringError(409, ANSWERS_FIRST[first]);
  const rows = await visitRows(db, cap.id);
  let open = candidate.inviteExpiresAt?.getTime() === cap.exp * 1000 && !!candidate.visitSubject;
  if (open && candidate.stage === "onsite_booked") {
    const exam = examOf(rows);
    open = !!exam && exam.startTime > now;
  } else if (open && candidate.stage === "onsite_invited") {
    // A "Next steps" candidate already holds this link, so a cancelled invitation (a hold) must close it too.
    const live = await linkSentAt(db, cap.id);
    open = !!live && (!live.sentAt || now.getTime() - live.sentAt.getTime() < config.onsiteFollowUp.expireDays * DAY);
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
const paperVisitSlots = async (db: Database, config: HiringConfig, subject: Subject, cap: VisitLink, rows: VisitRow[], now: Date) =>
  (await availableSlots(db, config, "paper", [subject], now, db, undefined, cap.id))
    .filter((slot) => Date.parse(slot.start) < cap.exp * 1000 && slot.start !== examOf(rows)?.startTime.toISOString())
    .map((slot) => ({ date: slot.date, examStart: slot.start, examEnd: slot.end, mockStart: null, mockEnd: null }));

/**
 * A "two-day" link: every open test time (Monday to Sunday, by the test office hours) and every open mock teaching hour
 * (Monday to Friday, by the head's saved hours, Wise and the weekly limit). The candidate's own booked times stay in the
 * lists, so a move can change one and keep the other.
 * shortcut: with two free heads the first in settings order gets the mock; use `assignHead` if one head fills up first.
 */
const twoDaySlots = async (db: Database, config: HiringConfig, subject: Subject, cap: VisitLink, now: Date, indexDb = db, live?: LiveBusy) => {
  const open = (start: string) => Date.parse(start) < cap.exp * 1000;
  const tests = (await availableSlots(db, config, "paper", [subject], now, db, undefined, cap.id))
    .filter((slot) => open(slot.start))
    .map((slot) => ({ date: slot.date, examStart: slot.start, examEnd: slot.end, mockStart: null, mockEnd: null }));
  const seen = new Set<string>();
  const mocks = (await availableSlots(db, config, "mock", [subject], now, indexDb, live, cap.id))
    .filter((slot) => open(slot.start) && !seen.has(slot.start) && !!seen.add(slot.start))
    .map((slot) => ({ date: slot.date, start: slot.start, end: slot.end, interviewerKey: slot.interviewerKey! }));
  // The mock teaching follows the test (same day after the grading gap, or a later day), so a time with no partner is not a choice.
  return {
    tests: tests.filter((test) => mocks.some((mock) => mockCanFollow(test.examEnd, mock.start))),
    mocks: mocks.filter((mock) => tests.some((test) => mockCanFollow(test.examEnd, mock.start))),
  };
};

const offeredSlots = async (db: Database, config: HiringConfig, subject: Subject, cap: VisitLink, rows: VisitRow[], now: Date, indexDb = db, live?: LiveBusy) =>
  (await availableVisitSlots(db, config, subject, now, cap.id, indexDb, live)).filter((slot) => {
    const start = new Date(slot.examStart).getTime();
    return start < cap.exp * 1000 && start !== examOf(rows)?.startTime.getTime();
  });

export async function visitView(token: string, db: Database = getDb(), now = new Date()) {
  const cap = visitToken(token, now);
  const { config } = await settings(db);
  const waiting = answersFirst(await candidateById(db, cap.id), cap);
  if (waiting)
    return {
      kind: "visit" as const,
      paired: true,
      twoDay: cap.kind === "two-day",
      mockSlots: [] as { date: string; start: string; end: string }[],
      subject: "",
      location: config.location,
      enabled: false,
      slots: [],
      visit: null,
      canMove: false,
      notice: ANSWERS_FIRST[waiting],
      checkedAt: null,
      waiting: waiting as "answers" | "checking" | null,
      formUrl: (waiting === "answers" ? PRE_SCREEN_URL : null) as string | null,
    };
  const { subject, rows } = await openVisit(db, cap, config, now);
  const enabled = bookable(config, cap.id);
  const exam = examOf(rows);
  const mock = rows.find((b) => b.kind === "mock");
  const refusal = exam ? moveRefusal(rows, now) : null;
  const paired = cap.kind === "visit" || !!mock;
  let slots: (Awaited<ReturnType<typeof paperVisitSlots>>[number] | Awaited<ReturnType<typeof offeredSlots>>[number])[] = [];
  let mockSlots: { date: string; start: string; end: string }[] = [];
  const twoDay = cap.kind === "two-day";
  let notice: string | null = null;
  let live: LiveBusy | null = null;
  if (!enabled) notice = onLine("Booking is temporarily paused.");
  else if (refusal) notice = refusal;
  else {
    try {
      if (twoDay) {
        live = await liveForList(db, config, [subject], now);
        const lists = await twoDaySlots(db, config, subject, cap, now, db, live ?? undefined);
        slots = lists.tests;
        // The head is the server's choice, so the page gets no name.
        mockSlots = lists.mocks.map(({ date, start, end }) => ({ date, start, end }));
      } else if (paired) {
        live = await liveForList(db, config, [subject], now);
        slots = await offeredSlots(db, config, subject, cap, rows, now, db, live ?? undefined);
      } else slots = await paperVisitSlots(db, config, subject, cap, rows, now);
      if (!slots.length) notice = onLine("There are no open visit times at the moment. Please try again later.");
    } catch (error) {
      // A stale Wise snapshot. Anything else is not a state the candidate can act on.
      if (!(error instanceof HiringError)) throw error;
      notice = onLine("Visit times cannot be shown at the moment. Please try again later.");
    }
  }
  return {
    kind: "visit" as const,
    paired: paired || twoDay,
    // The test and the mock teaching are two choices on two days. `mockSlots` is empty for every other link.
    twoDay,
    mockSlots,
    subject,
    location: config.location,
    enabled,
    slots,
    visit:
      exam
        ? {
            examStart: exam.startTime.toISOString(),
            examEnd: exam.endTime.toISOString(),
            mockStart: mock?.startTime.toISOString() ?? null,
            mockEnd: mock?.endTime.toISOString() ?? null,
            head: mock?.interviewerKey ?? null,
          }
        : null,
    canMove: enabled && !!exam && !refusal,
    notice,
    // When the times were checked against live Wise. Null means the 30-minute Wise copy was used.
    checkedAt: live?.checkedAt ?? null,
    waiting: null as "answers" | "checking" | null,
    formUrl: null as string | null,
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
export async function endVisit(tx: Database, rows: VisitRow[], status: "cancelled" | "no_show", now: Date, notifyRecruitment = true) {
  if (notifyRecruitment) for (const row of rows) {
    if (row.kind === "mock" && row.startTime > now) await queueRecruitmentMock(tx, row, "cancelled");
  }
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

/**
 * Kevin, 22 Nov 2026: a failed paper cancels the mock of the same visit, and the head hears at once. Fail closed, so a
 * head is never sent away in error: only a counted result ("done") that is "not passed" does it. A missing pass mark, a
 * result that still needs a check, and a mock that has started all leave the mock in place. The stage does not change:
 * a person still sends the Reject result.
 */
export async function cancelMockAfterFail(db: Database, candidateId: string, subject: Subject, actor: string, now = new Date()) {
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + candidateId},0))`);
    // Read under the lock, so a mark changed back to a pass a moment ago is seen.
    const { config } = await settings(tx);
    const [result] = await tx.select().from(s.hiringPaperResults).where(and(
      eq(s.hiringPaperResults.candidateId, candidateId), eq(s.hiringPaperResults.subject, subject),
    ));
    // A sheet with no question tried is more likely the wrong scan than a fail, so a person decides that one.
    if (result?.status !== "done" || !result.marks?.questions.some((q) => q.attempted) ||
      computeSheet(result.marks, passRulesFor(config, subject)).result !== "not_passed") return false;
    const rows = await visitRows(tx, candidateId);
    const mock = rows.find((b) => b.kind === "mock" && b.subjects.includes(subject) && b.startTime > now);
    // The result must be for this visit's paper: that paper has started, and a result tied to another booking is an older one.
    const exam = mock && rows.find((b) => b.kind === "paper" && b.visitId === mock.visitId);
    if (!mock || !exam || exam.startTime > now || (result.bookingId && result.bookingId !== exam.id)) return false;
    await endVisit(tx, [mock], "cancelled", now);
    await enqueue(tx, headNotice(mock, "cancelled"));
    await audit(tx, actor, "mock-cancelled-after-fail", candidateId, { subject, bookingId: mock.id });
    return true;
  });
}

// ---- The HR pre-screen call that a candidate books (Kevin's decisions, 12 Nov 2026) ----

type CallLink = { id: string; exp: number };
function callToken(token: string, now: Date): CallLink {
  const cap = readBookingToken(token, now);
  if (cap.kind !== "call") throw new HiringError(404, onLine("This booking link is no longer active."));
  return cap;
}
const callRows = (db: Database, candidateId: string) =>
  db
    .select()
    .from(s.hiringBookings)
    .where(
      and(
        eq(s.hiringBookings.candidateId, candidateId),
        eq(s.hiringBookings.kind, "call"),
        eq(s.hiringBookings.status, "confirmed"),
      ),
    );
type CallRow = Awaited<ReturnType<typeof callRows>>[number];
/** A confirmed HR call exists, ahead or started with no result yet: the `callBooked` that `profileGate` reads. */
export const hasBookedCall = async (db: Database, candidateId: string) => (await callRows(db, candidateId)).length > 0;
/** A booking or a good call answers the reminder, so one that still waits must not leave. */
export const cancelCallReminder = (tx: Database, candidateId: string) =>
  tx
    .update(s.hiringOutbox)
    .set({ status: "cancelled" })
    .where(and(eq(s.hiringOutbox.key, `${candidateId}:call-invite-reminder`), inArray(s.hiringOutbox.status, ["pending", "failed"])));
/** The candidate's call that has not ended. A call that ended with no result stays in the past and does not stop a new one. */
const comingCall = async (db: Database, candidateId: string, now: Date) =>
  (await callRows(db, candidateId)).find((b) => b.endTime > now);
/** After a good call, a stop or a hand invite, HR will not make a call that is still ahead. */
export async function cancelComingCall(tx: Database, candidateId: string, now: Date) {
  const rows = (await callRows(tx, candidateId)).filter((b) => b.startTime > now);
  if (rows.length) await endVisit(tx, rows, "cancelled", now, false);
}
/** HR's "No answer" for a call that has started. The slot is closed as a no-show, and the link lets the candidate book again. */
export async function missStartedCall(tx: Database, candidateId: string, now: Date) {
  const rows = (await callRows(tx, candidateId)).filter((b) => b.startTime <= now);
  if (rows.length) await endVisit(tx, rows, "no_show", now, false);
}
/**
 * The link works only while HR must still call this candidate: the same rule as the Calls tab. A good call, a stop, a
 * move to review or a closed subject ends it. Returns the subject the form would go for.
 */
async function openCall(db: Database, cap: CallLink, config: HiringConfig) {
  const [entry] = await callQueue(db, config, cap.id);
  if (!entry) throw new HiringError(404, onLine("This booking link is no longer active."));
  return entry.subject;
}
function callMoveRefusal(call: CallRow, now: Date) {
  if (call.rescheduleOf) return onLine("This R1 interview has already moved once.");
  if (call.startTime <= now) return onLine("This R1 interview has started and cannot move.");
  return null;
}
type HrBusyRead = { at: number; key: string; read: ReturnType<typeof readHrBusy> };
const hrBusyCache = globalThis as { __bgscheduler_hiringHrBusy?: HrBusyRead };
/**
 * HR's calendar for the dates on offer. It throws when Google gives no complete answer, so no time is shown.
 * A page read keeps one answer for 60 seconds on this server instance: every candidate reads the same calendar, and a
 * link must not be able to flood Google. A failed read stays cached too. `fresh` is the confirm step: it always reads
 * live, and it drops the kept answer so a refusal is not followed by a list that still shows the same time.
 */
async function hrBusy(db: Database, config: HiringConfig, now: Date, fresh = false) {
  const dates = businessDates(now, config.holidays);
  const from = instant(dates[0], CALL_DAY_START),
    to = instant(dates.at(-1)!, CALL_DAY_END);
  const key = `${config.connectedEmail}|${from.toISOString()}|${to.toISOString()}`;
  const hit = hrBusyCache.__bgscheduler_hiringHrBusy;
  if (!fresh && hit?.key === key && Date.now() - hit.at < 60_000) return { dates, busy: await hit.read };
  const read = readHrBusy(config.connectedEmail, from, to, db);
  hrBusyCache.__bgscheduler_hiringHrBusy = fresh ? undefined : { at: Date.now(), key, read };
  // The kept promise must not become an unhandled rejection when no later page read awaits it.
  if (!fresh) read.catch(() => {});
  return { dates, busy: await read };
}
/**
 * A call whose time has passed with no result from HR. The candidate waits for HR: a "No answer" closes it and opens the
 * link again. Without this a link could book a new call every time the last one ended.
 */
const CALL_PASSED = "Your R1 interview time has passed. BeGifted will contact you about a new time.";
/**
 * Can the call page show times now? Rules and setup shows this, and no call link leaves unless it says `readable`.
 * It shares the page's 60-second read, so it reports what a candidate would get.
 */
export async function callCalendarState(db: Database, config: HiringConfig, now = new Date()) {
  if (!(await googleConnectionStatus(config.connectedEmail, db)).freeBusy) return "reconnect" as const;
  try {
    await hrBusy(db, config, now);
    return "readable" as const;
  } catch (error) {
    if (!(error instanceof HiringError)) throw error;
    return "unreadable" as const;
  }
}
const passedCall = (rows: CallRow[], now: Date) => rows.some((b) => b.endTime <= now);
/** The calls other candidates hold. HR's calendar shows them too once the event exists; this covers the time before that. */
const otherCalls = async (db: Database, candidateId: string, now: Date) =>
  (
    await db
      .select({ candidateId: s.hiringBookings.candidateId, start: s.hiringBookings.startTime, end: s.hiringBookings.endTime })
      .from(s.hiringBookings)
      .where(and(inArray(s.hiringBookings.kind, ["call", "contract"]), eq(s.hiringBookings.status, "confirmed"), gte(s.hiringBookings.endTime, now)))
  ).filter((b) => b.candidateId !== candidateId);

export async function callView(token: string, db: Database = getDb(), now = new Date()) {
  const cap = callToken(token, now);
  const { config } = await settings(db);
  await openCall(db, cap, config);
  const enabled = bookable(config, cap.id);
  const rows = await callRows(db, cap.id);
  const own = rows.find((b) => b.endTime > now);
  const refusal = own ? callMoveRefusal(own, now) : passedCall(rows, now) ? onLine(CALL_PASSED) : null;
  let slots: ReturnType<typeof callSlots> = [];
  let notice: string | null = null;
  if (!enabled) notice = onLine("Booking is temporarily paused.");
  else if (refusal) notice = refusal;
  else {
    try {
      const { dates, busy } = await hrBusy(db, config, now);
      slots = r1Slots(dates, [...busy, ...(await otherCalls(db, cap.id, now))], now).filter(
        (slot) => new Date(slot.start).getTime() < cap.exp * 1000 && slot.start !== own?.startTime.toISOString(),
      );
      if (!slots.length) notice = onLine("There are no open R1 interview times at the moment. Please try again later.");
    } catch (error) {
      // The calendar could not be read. A time that cannot be proved free is not shown.
      if (!(error instanceof HiringError)) throw error;
      notice = onLine("R1 interview times cannot be shown at the moment. Please try again later.");
    }
  }
  // The stored phone number is never returned: the link is the only check, and a link can be forwarded.
  return {
    kind: "call" as const,
    // A call booked before 22 Nov 2026 lasts 15 minutes.
    minutes: own ? Math.round((own.endTime.getTime() - own.startTime.getTime()) / 60000) : CALL_MINUTES,
    enabled,
    slots,
    call: own ? { start: own.startTime.toISOString(), end: own.endTime.toISOString() } : null,
    canMove: enabled && !!own && !refusal,
    notice,
  };
}

/** The HR call email's résumé line. The worker changes it when the file cannot be attached at send time. */
export const RESUME_ATTACHED = "Attached to this email";
export const RESUME_NOT_ATTACHED = "Could not be attached. See the Hiring page.";

/** The candidate chooses a call time and gives the number to call. A move is this with `move: true`, once. */
export async function bookCall(token: string, value: unknown, db: Database = getDb(), now = new Date()) {
  const input = callBookingSchema.parse(value);
  const cap = callToken(token, now);
  const start = new Date(input.start).getTime();
  const { config } = await settings(db);
  if (!bookable(config, cap.id)) throw new HiringError(503, "Booking is temporarily unavailable.");
  await openCall(db, cap, config);
  // A retry returns the original call. It still saves the number, so a corrected number is not lost.
  const prior = await comingCall(db, cap.id, now);
  if (prior?.startTime.getTime() === start) {
    await db.update(s.hiringCandidates).set({ phone: input.phone }).where(eq(s.hiringCandidates.id, cap.id));
    return prior;
  }
  const refuseChange = (own: CallRow | undefined, rows: CallRow[]) => {
    if (!own) {
      if (passedCall(rows, now)) throw new HiringError(409, onLine(CALL_PASSED));
      return;
    }
    if (!input.move) throw new HiringError(409, "You already have a booked R1 interview. Use Move this R1 interview to change it.");
    const refusal = callMoveRefusal(own, now);
    if (refusal) throw new HiringError(409, refusal);
  };
  refuseChange(prior, await callRows(db, cap.id));
  // One live read of HR's calendar, just before the transaction: a Google call inside it would hold HR's lock for seconds.
  const calendar = await hrBusy(db, config, now, true).catch((error) => {
    if (!(error instanceof HiringError)) throw error;
    throw new HiringError(503, onLine("R1 interview times cannot be checked at the moment. Please try again later."));
  });
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${cap.id} for update`);
    // The booking trigger takes these two locks as well. Taking them here, in its order, serialises every call booking.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + cap.id},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"sit-in:" + HR_CALL_KEY},0))`);
    const latest = await settings(tx);
    if (!bookable(latest.config, cap.id)) throw new HiringError(503, "Booking has been paused.");
    const subject = await openCall(tx, cap, latest.config);
    const rows = await callRows(tx, cap.id);
    const own = rows.find((b) => b.endTime > now);
    if (own?.startTime.getTime() === start) return own;
    refuseChange(own, rows);
    const slot = r1Slots(calendar.dates, [...calendar.busy, ...(await otherCalls(tx, cap.id, now))], new Date()).find(
      (v) => new Date(v.start).getTime() === start && start < cap.exp * 1000,
    );
    if (!slot) throw new HiringError(409, "That R1 interview time is no longer available. Choose another time.");
    const candidate = await candidateById(tx, cap.id);
    if (own) await endVisit(tx, [own], "cancelled", now, false);
    const [call] = await tx
      .insert(s.hiringBookings)
      .values({
        candidateId: cap.id,
        kind: "call",
        subjects: [subject],
        interviewerKey: HR_CALL_KEY,
        interviewerEmail: HR_CALENDAR,
        calendarOwner: latest.config.connectedEmail,
        startTime: new Date(slot.start),
        endTime: new Date(slot.end),
        rescheduleOf: own?.id,
        evidence: { checkedAt: new Date().toISOString(), source: "google-freebusy" },
      })
      .returning();
    // No revision change: HR's next click on an open Calls tab sends the revision it loaded.
    await tx.update(s.hiringCandidates).set({ phone: input.phone }).where(eq(s.hiringCandidates.id, cap.id));
    if (candidate.email)
      await enqueue(tx, {
        key: `booking:${call.id}:email`,
        candidateId: cap.id,
        bookingId: call.id,
        kind: "email",
        payload: {
          to: candidate.email,
          // HR gets its own email below, with the résumé. The candidate's copy must not carry the file.
          cc: [],
          ...hiringEmail({
            subject: `BeGifted R1: HR Interview ${own ? "moved" : "confirmed"}`,
            hero: "r1",
            process: 1,
            preheader: `${bangkok(call.startTime)} (Bangkok). Google Meet video call.`,
            title: own ? "Your R1 interview has moved" : "Your R1 interview is confirmed",
            name: candidate.name,
            paragraphs: [`Your R1: HR Interview with BeGifted ${own ? "has moved. The new time is below" : "is confirmed"}.`],
            details: [
              { label: "Time", value: `${bangkok(call.startTime)}–${bangkokTime(call.endTime)} (Bangkok)` },
              { label: "Where", value: "Google Meet. The link is in your Google Calendar invitation." },
              { label: "Backup phone", value: input.phone },
            ],
            ...(own ? {} : { action: { label: "Move your R1 interview", url: callLink(cap.id, new Date(cap.exp * 1000)) } }),
            after: [
              own ? "This interview cannot move again through the link." : "You can move this interview once, before it starts.",
              "Please join from a quiet place, with your camera and microphone on.",
              "For other changes, message BeGifted on LINE.",
            ],
          }),
        },
      });
    const resume = !!storedResume(cap.id, candidate.resumePath, candidate.resumeType);
    await enqueue(tx, {
      key: `booking:${call.id}:hr-email`,
      candidateId: cap.id,
      bookingId: call.id,
      kind: "email",
      payload: {
        to: HR_CALENDAR,
        cc: [],
        attachResume: resume,
        ...hiringEmail({
          subject: `R1 ${own ? "moved" : "booked"}: ${candidate.name}`,
          preheader: `${bangkok(call.startTime)} (Bangkok). Google Meet. Backup phone ${input.phone}.`,
          title: `R1: HR Interview ${own ? "moved" : "booked"}`,
          name: "HR team",
          paragraphs: [`${candidate.name} ${own ? "moved" : "booked"} R1: HR Interview. Join with the Google Meet link in the calendar event. Phone the backup number only if the video call fails.`],
          details: [
            { label: "Candidate", value: candidate.name },
            { label: "Subject", value: subject },
            { label: "Time", value: `${bangkok(call.startTime)}–${bangkokTime(call.endTime)} (Bangkok)` },
            { label: "Backup phone", value: input.phone },
            { label: "Email", value: candidate.email ?? "Not recorded" },
            { label: "Résumé", value: resume ? RESUME_ATTACHED : "No file stored. See the Hiring page." },
          ],
          ...(own ? { after: [`The old time, ${bangkok(own.startTime)} (Bangkok), is cancelled.`] } : {}),
        }),
      },
    });
    await enqueue(tx, {
      key: `booking:${call.id}:calendar`,
      candidateId: cap.id,
      bookingId: call.id,
      kind: "calendar",
      payload: {},
    });
    // After the phone update, so the notice carries the number HR will call.
    await queueRecruitmentMock(tx, call, own ? "moved" : "booked", own?.startTime);
    await cancelCallReminder(tx, cap.id);
    // The phone number stays out of the audit row.
    await audit(tx, "candidate", own ? "call-moved" : "call-booked", cap.id, { start: slot.start });
    return call;
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
  const twoDay = cap.kind === "two-day";
  const mockStart = input.mockStart ? new Date(input.mockStart).getTime() : null;
  /** The booked visit already has these times: a retry, which returns the original. */
  const same = (rows: VisitRow[]) =>
    examOf(rows)?.startTime.getTime() === start && (!twoDay || rows.find((b) => b.kind === "mock")?.startTime.getTime() === mockStart);
  const priorRows = await visitRows(db, cap.id);
  if (same(priorRows)) return examOf(priorRows)!;
  const open = await openVisit(db, cap, config, now);
  // After `openVisit`, so a link that still waits for the answers says that first.
  if (twoDay && mockStart === null) throw new HiringError(400, "Choose a mock teaching time too.");
  if (cap.kind === "paper-visit" && !open.rows.some((row) => row.kind === "mock")) {
    return withDatabaseTransaction(db, async (tx) => {
      await tx.execute(sql`select id from hiring_candidates where id=${cap.id} for update`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + cap.id},0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('hiring:paper',0))`);
      const { config: current } = await settings(tx);
      if (!bookable(current, cap.id)) throw new HiringError(503, "Booking has been paused.");
      const { candidate, subject, rows } = await openVisit(tx, cap, current, now);
      const previous = examOf(rows);
      if (previous?.startTime.getTime() === start) return previous;
      if (previous && (!input.move || moveRefusal(rows, now)))
        throw new HiringError(409, moveRefusal(rows, now) ?? "Use Move this visit to choose another time.");
      if (input.subject !== subject) throw new HiringError(409, "This assessment is for another subject.");
      const slot = (await paperVisitSlots(tx, current, subject, cap, rows, new Date())).find((v) => Date.parse(v.examStart) === start);
      if (!slot) throw new HiringError(409, "That paper assessment time is no longer available. Choose another time.");
      if (previous) await endVisit(tx, rows, "cancelled", now, false);
      const [paper] = await tx.insert(s.hiringBookings).values({
        candidateId: cap.id, kind: "paper", subjects: [subject], visitId: randomUUID(),
        calendarOwner: current.connectedEmail, startTime: new Date(slot.examStart), endTime: new Date(slot.examEnd),
        rescheduleOf: previous?.id, evidence: { checkedAt: now.toISOString(), source: "office-capacity" },
      }).returning();
      await tx.update(s.hiringCandidates).set({ stage: "onsite_booked", revision: candidate.revision + 1, updatedAt: now }).where(eq(s.hiringCandidates.id, cap.id));
      if (candidate.email) await enqueue(tx, {
        key: `booking:${paper.id}:email`, candidateId: cap.id, bookingId: paper.id, kind: "email",
        payload: { to: candidate.email, ...hiringEmail({
          subject: "BeGifted paper assessment confirmed", preheader: bangkok(paper.startTime),
          hero: "visit",
          title: "Your paper assessment is confirmed", name: candidate.name,
          paragraphs: ["We will contact you after we grade your paper."],
          details: [
            { label: "Subject", value: subject },
            { label: "Time", value: `${bangkok(paper.startTime)}–${bangkokTime(paper.endTime)} (Bangkok)` },
            { label: "Location", value: current.location },
          ],
          ...(previous ? {} : { action: { label: "Move your visit", url: visitLink(cap.id, candidate.inviteExpiresAt!, "paper-visit") } }),
        }) },
      });
      await enqueue(tx, { key: `booking:${paper.id}:calendar`, candidateId: cap.id, bookingId: paper.id, kind: "calendar", payload: {} });
      await audit(tx, "candidate-link", previous ? "visit-move" : "visit-booking", cap.id, { visitId: paper.visitId, subject, examStart: slot.examStart });
      return paper;
    });
  }
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
  // The same live read as the list, so the head assigned here is the head the candidate's list was built on.
  const live = (await liveForList(db, config, [open.subject], now)) ?? undefined;
  /** The chosen times, if still open. A two-day visit joins a test time and a mock teaching hour that follows it (`mockCanFollow`). */
  const pick = async (d: Database, c: HiringConfig, subject: Subject, rows: VisitRow[], at: Date) => {
    if (!twoDay) return (await offeredSlots(d, c, subject, cap, rows, at, db, live)).find((v) => new Date(v.examStart).getTime() === start);
    const { tests, mocks } = await twoDaySlots(d, c, subject, cap, at, db, live);
    const test = tests.find((v) => Date.parse(v.examStart) === start);
    const mock = mocks.find((v) => Date.parse(v.start) === mockStart);
    // `date` is the day of the head's hour: the live Wise check reads it.
    return test && mock && mockCanFollow(test.examEnd, mock.start)
      ? { date: mock.date, examStart: test.examStart, examEnd: test.examEnd, mockStart: mock.start, mockEnd: mock.end, interviewerKey: mock.interviewerKey, subject }
      : undefined;
  };
  const slot = await pick(db, config, open.subject, open.rows, now);
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
    if (same(rows)) return examOf(rows)!;
    refuseChange(rows);
    if (input.subject !== subject) throw new HiringError(409, onLine("This visit is for another subject."));
    const fresh = await pick(tx, latest.config, subject, rows, new Date());
    // Only this head's lock is held, and the live read was for this head.
    if (!fresh || fresh.interviewerKey !== slot.interviewerKey) throw unavailable();
    const head = latest.config.interviewers.find((i) => i.canonicalKey === fresh.interviewerKey);
    const [group] = await tx
      .select()
      .from(s.progressLineGroups)
      .where(and(eq(s.progressLineGroups.canonicalKey, fresh.interviewerKey), eq(s.progressLineGroups.enabled, true)));
    if (!head || !group) throw new HiringError(409, onLine("Interviewer notifications are not configured."));
    const oldMock = rows.find((b) => b.kind === "mock");
    if (rows.length) await endVisit(tx, rows, "cancelled", now, false);
    const visitId = randomUUID();
    const shared = {
      candidateId: cap.id,
      subjects: [subject],
      calendarOwner: latest.config.connectedEmail,
      visitId,
    };
    const examRange = { startTime: new Date(fresh.examStart), endTime: new Date(fresh.examEnd) };
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
          ...hiringEmail({
            subject: `BeGifted onsite visit ${rows.length ? "moved" : "confirmed"}`,
            hero: "visit",
            preheader: `Test ${bangkok(exam.startTime)} (Bangkok). If you pass, mock teaching follows ${twoDay ? `on ${bangkok(mock.startTime)}` : "on the same day"}.`,
            title: rows.length ? "Your visit has moved" : "Your visit is confirmed",
            tone: "ink",
            name: candidate.name,
            paragraphs: [`Your ${twoDay ? "test and your mock teaching are" : "onsite visit is"} ${rows.length ? "moved. The new times are below" : "confirmed"}.`],
            details: [
              { label: "Subject", value: subject },
              { label: "Test", value: `${bangkok(exam.startTime)}–${bangkokTime(exam.endTime)} (Bangkok)` },
              { label: twoDay ? "Final round: mock teaching, if you pass" : "Mock teaching, if you pass", value: `${bangkok(mock.startTime)}–${bangkokTime(mock.endTime)} (Bangkok), with ${head.canonicalKey}` },
              { label: "Location", value: latest.config.location },
            ],
            ...(rows.length
              ? {}
              : { action: { label: twoDay ? "Move your times" : "Move your visit", url: visitLink(cap.id, candidate.inviteExpiresAt!, twoDay ? "two-day" : "visit") } }),
            stepsHeading: twoDay ? "Your test and mock teaching" : "Your visit day",
            steps: twoDay ? TWO_DAY_STEPS : VISIT_STEPS,
            list: VISIT_BRING,
            after: [
              rows.length
                ? "This booking cannot move again through the link."
                : twoDay ? "You can move your times once, up to 24 hours before the test starts." : "You can move this visit once, up to 24 hours before it starts.",
              "For other changes, message BeGifted on LINE.",
              ...mockPrep(subject).paragraphs,
            ],
            links: mockPrep(subject).links,
          }),
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
    // A paper-only booking that moves to a paired link has no old mock, so its mock is new to the head.
    await queueRecruitmentMock(tx, mock, oldMock ? "moved" : "booked", oldMock?.startTime);
    await enqueue(tx, headNotice(mock, oldMock ? "moved" : undefined, oldMock?.startTime));
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
      // HR's bad call is this action, so a booked call never refuses it: one still ahead is cancelled first.
      await cancelComingCall(tx, id, now);
      const appointments = await tx
        .select()
        .from(s.hiringBookings)
        .where(
          and(
            eq(s.hiringBookings.candidateId, id),
            eq(s.hiringBookings.status, "confirmed"),
          ),
        );
      if (appointments.some((b) => b.kind !== "call" && b.endTime > new Date()))
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
            "onsite_booked",
            "paper_booked",
            "paper_invited",
            "paper_passed",
            "mock_booked",
          ].includes(c.stage) ||
          input.subjects.some((subject) => !(c.visitSubject ? [c.visitSubject] : c.subjects).includes(subject))
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
        if (c.visitSubject) {
          if (!papers.some((paper) => paper.subjects.includes(c.visitSubject!)))
            throw new HiringError(409, "A completed paper assessment is required.");
          await assertPassingPaper(tx, id, c.visitSubject, config);
          if (!storedResume(c.id, c.resumePath, c.resumeType))
            throw new HiringError(409, "Import the original résumé before inviting the candidate to mock teaching.");
          const [existing] = await tx.select({ id: s.hiringBookings.id }).from(s.hiringBookings)
            .where(and(eq(s.hiringBookings.candidateId, id), eq(s.hiringBookings.kind, "mock"), eq(s.hiringBookings.status, "confirmed")));
          if (existing) throw new HiringError(409, "This candidate already has a mock appointment.");
        }
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
        const skippedCall = profileGate({ ...c, callBooked: await hasBookedCall(tx, id) }, config).awaitingCall;
        if (skippedCall) detail = { goodCall: "manual" };
        await cancelComingCall(tx, id, now);
        await tx
          .update(s.hiringCandidates)
          .set({
            ...(skippedCall && {
              callReview: { ...c.callReview, good: { at: now.toISOString(), by: actor, manual: true as const }, tries: c.callReview?.tries ?? [] },
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
/** The hash a stored university result carries: the catalog and the version of the match rules. */
export const prestigeCatalogHash = (universities: HiringConfig["universities"]) =>
  sourceHash([PRESTIGE_RULES, universities]);
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

const contractBookingSchema = z.object({ start: z.iso.datetime({ offset: true }) }).strict();

async function openContract(db: Database, decisionId: string) {
  const [row] = await db.select({ candidate: s.hiringCandidates }).from(s.hiringDecisions)
    .innerJoin(s.hiringCandidates, eq(s.hiringCandidates.id, s.hiringDecisions.candidateId))
    .where(and(eq(s.hiringDecisions.id, decisionId), eq(s.hiringDecisions.status, "sent"),
      eq(s.hiringDecisions.decision, "hire"), eq(s.hiringCandidates.stage, "hired")));
  if (!row?.candidate.email) throw new HiringError(404, "This contract signing link is no longer active.");
  return row.candidate;
}

const contractBooking = async (db: Database, id: string) =>
  (await db.select().from(s.hiringBookings).where(and(eq(s.hiringBookings.candidateId, id),
    eq(s.hiringBookings.kind, "contract"), eq(s.hiringBookings.status, "confirmed"))))[0];

async function contractSlots(db: Database, id: string, calendar: Awaited<ReturnType<typeof hrBusy>>, now: Date, exp: number) {
  return callSlots(calendar.dates, [...calendar.busy, ...await otherCalls(db, id, now)], now, CONTRACT_MINUTES)
    .filter((slot) => Date.parse(slot.end) <= exp * 1000);
}

export async function contractView(token: string, db: Database = getDb(), now = new Date()) {
  const cap = readBookingToken(token, now);
  if (cap.kind !== "contract") throw new HiringError(404, "This contract signing link is no longer active.");
  const candidate = await openContract(db, cap.id);
  const { config } = await settings(db);
  const booking = await contractBooking(db, candidate.id);
  const enabled = (config.enabled && config.deliveryEnabled || contractTestAllowed(config, candidate.id)) && runtimeWritesAllowed();
  let slots: Awaited<ReturnType<typeof contractSlots>> = [];
  if (enabled && !booking) {
    try {
      slots = await contractSlots(db, candidate.id, await hrBusy(db, config, now), now, cap.exp);
    } catch (error) {
      if (!(error instanceof HiringError)) throw error;
    }
  }
  return {
    kind: "contract" as const, location: config.location, minutes: CONTRACT_MINUTES, enabled, slots,
    call: booking ? { start: booking.startTime.toISOString(), end: booking.endTime.toISOString() } : null,
    canMove: false,
    notice: booking || slots.length ? null : onLine("No contract signing times are available now. Please try again later."),
  };
}

export async function bookContract(token: string, value: unknown, db: Database = getDb(), now = new Date()) {
  const { start } = contractBookingSchema.parse(value);
  const cap = readBookingToken(token, now);
  if (cap.kind !== "contract") throw new HiringError(404, "This contract signing link is no longer active.");
  const candidate = await openContract(db, cap.id);
  const { config } = await settings(db);
  if ((!config.enabled || !config.deliveryEnabled) && !contractTestAllowed(config, candidate.id) || !runtimeWritesAllowed())
    throw new HiringError(503, "Booking is temporarily unavailable.");
  const prior = await contractBooking(db, candidate.id);
  if (prior) {
    if (prior.startTime.getTime() === Date.parse(start)) return prior;
    throw new HiringError(409, "Your contract signing is already booked.");
  }
  const calendar = await hrBusy(db, config, now, true);
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select id from hiring_candidates where id=${candidate.id} for update`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"hiring-candidate:" + candidate.id},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"sit-in:" + HR_CALL_KEY},0))`);
    const latest = await settings(tx);
    if ((!latest.config.enabled || !latest.config.deliveryEnabled) && !contractTestAllowed(latest.config, candidate.id) || latest.config.connectedEmail !== config.connectedEmail)
      throw new HiringError(503, "Booking has been paused or the calendar changed. Refresh the page.");
    const current = await openContract(tx, cap.id);
    const existing = await contractBooking(tx, candidate.id);
    if (existing) {
      if (existing.startTime.getTime() === Date.parse(start)) return existing;
      throw new HiringError(409, "Your contract signing is already booked.");
    }
    const slot = (await contractSlots(tx, candidate.id, calendar, new Date(), cap.exp)).find((item) => Date.parse(item.start) === Date.parse(start));
    if (!slot || !businessDates(now, latest.config.holidays).includes(slot.date))
      throw new HiringError(409, "That time is no longer available. Choose another time.");
    const [booking] = await tx.insert(s.hiringBookings).values({
      candidateId: candidate.id, kind: "contract", subjects: current.visitSubject ? [current.visitSubject] : current.subjects,
      interviewerKey: HR_CALL_KEY, interviewerEmail: HR_CALENDAR, calendarOwner: latest.config.connectedEmail,
      startTime: new Date(slot.start), endTime: new Date(slot.end), evidence: { checkedAt: now.toISOString(), source: "google-freebusy" },
    }).returning();
    const mail = hiringEmail({
      subject: "BeGifted contract signing confirmed", preheader: bangkok(booking.startTime),
      hero: "offer",
      title: "Your contract signing is confirmed", name: current.name,
      paragraphs: ["Please meet our HR team at the location below."],
      details: [
        { label: "Time", value: `${bangkok(booking.startTime)}–${bangkokTime(booking.endTime)} (Bangkok)` },
        { label: "Location", value: latest.config.location },
      ],
    });
    await enqueue(tx, { key: `booking:${booking.id}:email`, candidateId: candidate.id, bookingId: booking.id,
      kind: "email", payload: { to: current.email, ...mail, workflowStage: "hired", closeLoop: true } });
    await enqueue(tx, { key: `booking:${booking.id}:calendar`, candidateId: candidate.id, bookingId: booking.id,
      kind: "calendar", payload: { workflowStage: "hired", closeLoop: true } });
    await audit(tx, "candidate-link", "contract-booked", candidate.id, { bookingId: booking.id, start: slot.start });
    return booking;
  });
}
