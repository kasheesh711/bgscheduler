import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { googleConnectionStatus } from "./google";
import { profileGate } from "./insights";
import {
  bangkokDayStart,
  bangkokWeekStart,
  releaseQueue,
  type Funnel,
  type LimitUsage,
  type QueueEntry,
} from "./limits";
import {
  HiringError,
  normalizeSubjects,
  runtimeWritesAllowed,
  type HiringConfig,
  type Subject,
} from "./model";
import {
  availabilityFraction,
  hardStops,
  preScreenPoints,
  profileScore,
  supportedVisitSubjects,
  visitSubject,
} from "./scoring";
import {
  audit,
  cancelComingCall,
  enqueue,
  inviteToCall,
  inviteToPreScreen,
  inviteToVisit,
  missStartedCall,
  preScreenEmail,
  settings,
  visitInviteEmail,
  visitLink,
  type Candidate,
} from "./service";

const c = s.hiringCandidates,
  o = s.hiringOutbox,
  b = s.hiringBookings;
const DAY = 86400000;
const isForm = sql`${o.key} = ${o.candidateId}::text || ':pre-screen'`;
const isCallInvite = sql`${o.key} = ${o.candidateId}::text || ':call-invite'`;
// A reminder carries the same stage so that a stage change cancels it, but it is not a new invitation.
const isOnsiteInvite = sql`${o.payload}->>'workflowStage' = 'onsite_invited' and ${o.key} not like '%:visit-reminder:%'`;
/** Every release, click and follow-up takes this one lock, so they cannot share out the same place. */
export const lockQueue = (tx: Database) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-queue'))`);
// Rows queued while delivery is paused would all leave in one delivery call, so nothing is queued then.
const allowed = (config: HiringConfig) =>
  config.enabled && config.deliveryEnabled && config.rubricApproved && runtimeWritesAllowed();

/**
 * Reads Postgres directly, never the capped dashboard list. Every outbox status but `cancelled` counts as used, because
 * it may have reached the candidate. Only form and invitation sends count; old-flow candidates use no places.
 */
export async function readLimitUsage(db: Database, funnel: Funnel, now: Date): Promise<LimitUsage> {
  const since = (start: Date) => sql`${o.createdAt} >= ${start.toISOString()}::timestamptz`;
  const [sends] = await db
    .select({
      perDay: sql<number>`(count(*) filter (where ${since(bangkokDayStart(now))}))::int`,
      perWeek: sql<number>`(count(*) filter (where ${since(bangkokWeekStart(now))}))::int`,
    })
    .from(o)
    .where(
      and(
        ne(o.status, "cancelled"),
        funnel === "pre_screen" ? isForm : isOnsiteInvite,
        // A resend goes to someone who already holds a place.
        sql`coalesce(${o.payload}->>'resend', '') <> 'true'`,
      ),
    );
  const usage: LimitUsage = { ...sends, waiting: 0, unbooked: 0, bySubject: {} };
  const place = (subject: Subject | null) => {
    if (subject) usage.bySubject[subject] = (usage.bySubject[subject] ?? 0) + 1;
  };
  if (funnel === "pre_screen") {
    const open = await db
      .select({ subjects: c.subjects })
      .from(c)
      .where(
        and(
          eq(c.stage, "pre_screen"),
          isNull(c.preScreen),
          exists(
            db
              .select({ id: o.id })
              .from(o)
              .where(and(eq(o.candidateId, c.id), isForm, ne(o.status, "cancelled"))),
          ),
        ),
      );
    usage.waiting = open.length;
    // A release puts the queue subject first in `subjects`.
    for (const row of open) place(row.subjects[0] ?? null);
    return usage;
  }
  const rows = await db
    .select({ id: c.id, stage: c.stage, subject: c.visitSubject, end: b.endTime })
    .from(c)
    // A past HR call stays confirmed. It is not a visit, so it must not make an invited person look booked.
    .leftJoin(b, and(eq(b.candidateId, c.id), eq(b.status, "confirmed"), ne(b.kind, "call")))
    .where(inArray(c.stage, ["onsite_invited", "onsite_booked"]));
  for (const id of new Set(rows.map((r) => r.id))) {
    const own = rows.filter((r) => r.id === id);
    const invited = own[0].stage === "onsite_invited";
    if (invited && !own.some((r) => r.end)) usage.unbooked++;
    // A booked place stays open until the visit's end time passes.
    if (invited || own.some((r) => r.end && r.end > now)) place(own[0].subject);
  }
  return usage;
}

/** The app has invited this candidate: a live form row, or a visit invitation at any status, which a click can send with no form. */
export async function appInvited(db: Database, candidateId: string) {
  const rows = await db
    .select({ id: o.id })
    .from(o)
    .where(and(eq(o.candidateId, candidateId), or(and(isForm, ne(o.status, "cancelled")), isOnsiteInvite)))
    .limit(1);
  return rows.length > 0;
}

/** When the call booking link was sent. Only a sent row counts: a link that may not have left is not the app's contact. */
export async function callInviteSentAt(db: Database, candidateId: string) {
  const [invite] = await db
    .select({ status: o.status, sentAt: o.sentAt })
    .from(o)
    .where(eq(o.key, `${candidateId}:call-invite`));
  return invite?.status === "sent" ? invite.sentAt : null;
}

/** The form row's send time. A row not yet sent, or not known to be sent, has no time, so no follow-up clock runs. */
export async function formSentAt(db: Database, candidateId: string) {
  const [form] = await db
    .select({ status: o.status, sentAt: o.sentAt })
    .from(o)
    .where(eq(o.key, `${candidateId}:pre-screen`));
  return form?.status === "sent" ? form.sentAt : null;
}

export const inviteRows = (db: Database, candidateId: string) =>
  db
    .select({ key: o.key, status: o.status })
    .from(o)
    .where(and(eq(o.candidateId, candidateId), isOnsiteInvite));

/** The newest invitation's send time. A row not yet sent has no time, so no follow-up clock runs. */
export async function linkSentAt(db: Database, candidateId: string) {
  const [link] = await db
    .select({ status: o.status, sentAt: o.sentAt })
    .from(o)
    .where(and(eq(o.candidateId, candidateId), isOnsiteInvite, ne(o.status, "cancelled")))
    .orderBy(desc(o.createdAt))
    .limit(1);
  return link?.status === "sent" ? link.sentAt : null;
}

export const preScreenTotal = (candidate: Candidate, config: HiringConfig) =>
  preScreenPoints(
    candidate.preScreenAssessment!,
    config.preScreenWeights,
    candidate.universityAssessment?.fraction ?? 0,
    availabilityFraction(candidate.preScreen!),
  ).total;

/**
 * What a reply means for an automatic invitation (design calls 9 and 17).
 * `hold`: a person decides, with the reason. `wait`: a setting can still cure it, so the row keeps its stage and the next
 * cycle looks again. `ready`: it may enter the onsite queue.
 */
export function replyCheck(
  candidate: Candidate,
  sentAt: Date | null,
  config: HiringConfig,
): { kind: "hold"; reason: string } | { kind: "wait" } | { kind: "ready"; subject: Subject; score: number } {
  const hold = (reason: string) => ({ kind: "hold" as const, reason });
  const { preScreen: pre, preScreenAssessment: assessment, workRightsAnswer: answer } = candidate;
  if (!pre || !assessment) return { kind: "wait" };
  // In either direction: after a person changes the score, only the Invite button can send the visit email.
  if (candidate.preScreenOverride) return hold("A person changed this score. A person decides.");
  const { stops } = hardStops(pre, answer, normalizeSubjects(pre.subjects), config);
  if (stops.length) return hold(stops.join(" "));
  if (!supportedVisitSubjects(pre, answer, assessment, config).length)
    return hold("No named subject is supported by the assessment.");
  if (!sentAt) return hold("This response has no matching form send. A person decides.");
  if (!candidate.email) return hold("There is no usable email.");
  // HR's good call is the contact, as in `profileGate`.
  if (candidate.previouslyContacted && !candidate.callReview?.good)
    return hold("There was earlier contact. A person decides.");
  if (candidate.preScreenResubmitted) return hold("This is a changed response. A person decides.");
  if (!candidate.preScreenRepliedAt) return hold("The response time could not be read. A person decides.");
  if (candidate.preScreenRepliedAt < sentAt) return hold("This response is older than the form send. A person decides.");
  if (!["pre_screen", "no_reply"].includes(candidate.stage)) return hold("This stage needs a person to decide.");
  if (config.preScreenThreshold === null) return { kind: "wait" };
  const score = preScreenTotal(candidate, config);
  if (score < config.preScreenThreshold)
    return hold(`The pre-screen score ${score} is below the pass score ${config.preScreenThreshold}.`);
  // Opening the subject or adding a head cures this.
  const subject = visitSubject(pre, answer, assessment, config);
  return subject ? { kind: "ready", subject, score } : { kind: "wait" };
}

export const autoInviteEligible = (candidate: Candidate, sentAt: Date | null, config: HiringConfig) =>
  replyCheck(candidate, sentAt, config).kind === "ready";

/**
 * Only stage `new` enters, and any earlier form row, even a cancelled one, keeps a candidate out.
 * Reads only the columns the gate and the score use, because profile text and the other large fields are not needed to rank.
 * A release locks and reads the full row before it sends anything.
 */
const formCandidates = (db: Database, id?: string) =>
  db
    .select({
      id: c.id,
      createdAt: c.createdAt,
      email: c.email,
      previouslyContacted: c.previouslyContacted,
      workRightsAnswer: c.workRightsAnswer,
      profileAssessment: c.profileAssessment,
      universityAssessment: c.universityAssessment,
      queueManual: c.queueManual,
      callReview: c.callReview,
      callInvited: sql<boolean>`${exists(
        db
          .select({ id: o.id })
          .from(o)
          .where(and(eq(o.candidateId, c.id), isCallInvite, eq(o.status, "sent"))),
      )}`,
    })
    .from(c)
    .where(
      and(
        id ? eq(c.id, id) : undefined,
        eq(c.stage, "new"),
        isNull(c.preScreen),
        notExists(db.select({ id: o.id }).from(o).where(and(eq(o.candidateId, c.id), isForm))),
      ),
    );

export async function preScreenQueue(db: Database, config: HiringConfig): Promise<QueueEntry[]> {
  const rows = await formCandidates(db);
  return rows.flatMap((row) => {
    const { eligible, subject } = profileGate(row, config);
    return eligible && subject
      ? [
          {
            id: row.id,
            subject,
            score: profileScore(row.profileAssessment!, config.profileWeights, row.universityAssessment?.fraction ?? 0),
            createdAt: row.createdAt,
            manual: row.queueManual,
          },
        ]
      : [];
  });
}

/**
 * Who HR must call: the same rows as the form queue, held only because the score is at or above the call score.
 * Highest score first, then the earlier application. A closed subject or any other gate reason keeps a row out,
 * because the form could not go after the call.
 */
export async function callQueue(db: Database, config: HiringConfig, id?: string): Promise<QueueEntry[]> {
  const rows = await formCandidates(db, id);
  return rows
    .flatMap((row) => {
      const gate = profileGate(row, config);
      return gate.awaitingCall && gate.reasons.length === 1 && gate.subject
        ? [
            {
              id: row.id,
              subject: gate.subject,
              score: profileScore(row.profileAssessment!, config.profileWeights, row.universityAssessment?.fraction ?? 0),
              createdAt: row.createdAt,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * HR's call result. A good call lets the candidate into the form queue; a no answer adds a try. It sends nothing and
 * changes no stage or `revision`. A bad call is the Stop action, so its rules stay in one place.
 */
export async function recordCall(
  id: string,
  result: "good" | "no_answer",
  actor: string,
  db: Database,
  now = new Date(),
) {
  await withDatabaseTransaction(db, async (tx) => {
    await lockQueue(tx);
    // The row lock comes before the check: a SEEK sync takes only the row lock, so it cannot move the row in between.
    const [row] = await tx.select({ callReview: c.callReview }).from(c).where(eq(c.id, id)).for("update");
    const { config } = await settings(tx);
    if (!row || !(await callQueue(tx, config)).some((entry) => entry.id === id))
      throw new HiringError(409, "This candidate has left the call queue. Refresh the page.");
    const at = now.toISOString();
    const review = row.callReview ?? { good: null, tries: [] };
    // After a good call HR will not make a call that is still ahead. A no answer closes the call that has started, and
    // the candidate's link then lets them book again.
    if (result === "good") await cancelComingCall(tx, id, now);
    else await missStartedCall(tx, id, now);
    await tx
      .update(c)
      .set({
        callReview:
          result === "good" ? { ...review, good: { at, by: actor } } : { ...review, tries: [...review.tries, { at, by: actor }] },
      })
      .where(eq(c.id, id));
    await audit(tx, actor, result === "good" ? "call-good" : "call-no-answer", id, { tries: review.tries.length + (result === "good" ? 0 : 1) });
  });
}

/**
 * Sends the call booking link to the people HR must call, in the Calls tab's order. One link per candidate, ever: any
 * earlier row, even a cancelled one, keeps a candidate out. The day's number is the pre-screen per-day limit, counted
 * apart from the forms, so a go-live cannot become a mass email. Nothing goes while the Google grant cannot read HR's
 * calendar: the link would open a page with no times.
 */
export async function releaseCallInvites(db: Database, now = new Date()) {
  return withDatabaseTransaction(db, async (tx) => {
    await lockQueue(tx);
    const { config } = await settings(tx);
    if (!allowed(config) || !(await googleConnectionStatus(config.connectedEmail, tx)).freeBusy) return 0;
    const earlier = await tx.select({ candidateId: o.candidateId, status: o.status, createdAt: o.createdAt }).from(o).where(isCallInvite);
    const invited = new Set(earlier.map((row) => row.candidateId));
    const dayStart = bangkokDayStart(now);
    // Every status but `cancelled` counts as used, as for the form limits.
    let room = config.preScreenLimits.perDay - earlier.filter((row) => row.status !== "cancelled" && row.createdAt >= dayStart).length;
    let sent = 0;
    for (const entry of await callQueue(tx, config)) {
      if (room <= 0) break;
      if (invited.has(entry.id)) continue;
      const row = await lockCandidate(tx, entry.id);
      // A person or a SEEK read can act between the queue read and this row lock.
      if (!(await callQueue(tx, config, entry.id)).length) continue;
      if (!(await inviteToCall(tx, row, now))) continue;
      await audit(tx, "hiring-queue", "call-invite-release", row.id, { subject: entry.subject, score: entry.score });
      room--;
      sent++;
    }
    return sent;
  });
}

/**
 * A drag sends nothing and changes no stage. It leaves `revision` alone, because a new revision would void a running AI
 * score and an open panel's next click.
 */
export async function moveInQueue(id: string, ahead: string[], actor: string, db: Database, now = new Date()) {
  if (ahead.includes(id)) throw new HiringError(400, "A candidate cannot stand ahead of themselves.");
  await withDatabaseTransaction(db, async (tx) => {
    await lockQueue(tx);
    const { config } = await settings(tx);
    if (!(await preScreenQueue(tx, config)).some((entry) => entry.id === id))
      throw new HiringError(409, "This candidate has left the queue. Refresh the page.");
    await tx.update(c).set({ queueManual: { ahead, movedAt: now.toISOString() } }).where(eq(c.id, id));
    await audit(tx, actor, "queue-move", id, { ahead: ahead.length, after: ahead.at(-1) ?? null });
  });
}

export async function resetQueueOrder(actor: string, db: Database) {
  await withDatabaseTransaction(db, async (tx) => {
    await lockQueue(tx);
    const cleared = await tx.update(c).set({ queueManual: null }).where(isNotNull(c.queueManual)).returning({ id: c.id });
    await audit(tx, actor, "queue-reset", null, { cleared: cleared.length });
  });
}

/** Any earlier invitation row keeps a candidate out: only a click can send another. */
export async function onsiteQueue(db: Database, config: HiringConfig): Promise<QueueEntry[]> {
  const rows = await db
    .select()
    .from(c)
    .where(
      and(
        inArray(c.stage, ["pre_screen", "no_reply"]),
        isNotNull(c.preScreenAssessment),
        notExists(db.select({ id: o.id }).from(o).where(and(eq(o.candidateId, c.id), isOnsiteInvite))),
      ),
    );
  if (!rows.length) return [];
  // One read for every form row, not one per candidate. Same rule as formSentAt: only a sent row has a time.
  const forms = await db
    .select({ key: o.key, status: o.status, sentAt: o.sentAt })
    .from(o)
    .where(inArray(o.key, rows.map((row) => `${row.id}:pre-screen`)));
  const sentAt = new Map(forms.map((f) => [f.key, f.status === "sent" ? f.sentAt : null]));
  const entries: QueueEntry[] = [];
  for (const row of rows) {
    const check = replyCheck(row, sentAt.get(`${row.id}:pre-screen`) ?? null, config);
    if (check.kind === "ready")
      entries.push({ id: row.id, subject: check.subject, score: check.score, createdAt: row.createdAt });
  }
  return entries;
}

const lockCandidate = async (tx: Database, id: string) =>
  (await tx.select().from(c).where(eq(c.id, id)).for("update"))[0];

/** The one path by which the worker sends a first invitation. It sends nothing itself: delivery reads the outbox. */
export async function releaseQueues(db: Database, now = new Date()) {
  return withDatabaseTransaction(db, async (tx) => {
    await lockQueue(tx);
    const { config } = await settings(tx);
    if (!allowed(config)) return { preScreen: 0, onsite: 0 };
    let preScreen = 0,
      onsite = 0;
    const forms = releaseQueue(
      "pre_screen",
      await preScreenQueue(tx, config),
      await readLimitUsage(tx, "pre_screen", now),
      config,
    );
    for (const entry of forms.release) {
      const row = await lockCandidate(tx, entry.id);
      // A person can act between the queue read and this row lock.
      if (row.stage !== "new" || row.preScreen || !profileGate(row, config).eligible) continue;
      if (!(await inviteToPreScreen(tx, row, now))) continue;
      const subjects = row.profileAssessment!.subjects.filter((v) => v.relevant).map((v) => v.subject);
      await tx
        .update(c)
        .set({
          stage: "pre_screen",
          subjects: [entry.subject, ...subjects.filter((v) => v !== entry.subject)],
          queueManual: null,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(eq(c.id, row.id));
      await audit(tx, "hiring-queue", "pre-screen-release", row.id, { subject: entry.subject, score: entry.score, manual: !!entry.manual });
      preScreen++;
    }
    const visits = releaseQueue(
      "onsite",
      await onsiteQueue(tx, config),
      await readLimitUsage(tx, "onsite", now),
      config,
    );
    for (const entry of visits.release) {
      const row = await lockCandidate(tx, entry.id);
      if (!autoInviteEligible(row, await formSentAt(tx, row.id), config)) continue;
      const subject = await inviteToVisit(tx, row, config, `${row.id}:visit-invite`, now);
      await audit(tx, "hiring-queue", "onsite-release", row.id, { subject, score: entry.score });
      onsite++;
    }
    return { preScreen, onsite };
  });
}

/**
 * One reminder and one expiry per send. The clock starts at `sentAt`, so while delivery is paused, or a row is unsent,
 * nothing happens. A reminder carries `workflowStage`, so a stage change cancels it before it leaves.
 */
export async function runFollowUps(db: Database, now = new Date()) {
  return withDatabaseTransaction(db, async (tx) => {
    await lockQueue(tx);
    const { config } = await settings(tx);
    let reminded = 0,
      expired = 0;
    if (!allowed(config)) return { reminded, expired };
    const passed = (sentAt: Date, days: number) => now.getTime() - sentAt.getTime() >= days * DAY;

    const forms = await tx
      .select({ id: c.id, status: o.status, sentAt: o.sentAt, firstAttemptAt: o.firstAttemptAt })
      .from(c)
      .innerJoin(o, and(eq(o.candidateId, c.id), isForm))
      .where(and(eq(c.stage, "pre_screen"), isNull(c.preScreen), inArray(o.status, ["sent", "failed", "uncertain"])));
    for (const { id, status, sentAt, firstAttemptAt } of forms) {
      const { remindDays, expireDays } = config.preScreenFollowUp;
      // The same rule as onsite: these can never start the normal clock, so they would hold a place for good. `pending` holds no clock.
      const stuck = status !== "sent" && !!firstAttemptAt && passed(firstAttemptAt, expireDays);
      if (!stuck && (status !== "sent" || !sentAt)) continue;
      const ended = stuck || passed(sentAt!, expireDays);
      if (!ended && !passed(sentAt!, remindDays)) continue;
      const row = await lockCandidate(tx, id);
      if (row.stage !== "pre_screen" || row.preScreen) continue;
      if (ended) {
        await tx.update(c).set({ stage: "no_reply", revision: row.revision + 1, updatedAt: now }).where(eq(c.id, id));
        await audit(tx, "hiring-follow-up", "no-reply", id, { sentAt, status });
        expired++;
      } else if (
        row.email &&
        // A person contacted them in SEEK, which also cancels unsent invitations: the form reminder must not follow.
        !row.previouslyContacted &&
        (await enqueue(tx, {
          key: `${id}:pre-screen-reminder`,
          candidateId: id,
          kind: "email",
          createdAt: now,
          payload: {
            to: row.email,
            workflowStage: "pre_screen",
            ...preScreenEmail(row.name, row.email, true),
          },
        }))
      ) {
        await audit(tx, "hiring-follow-up", "pre-screen-reminder", id, { sentAt });
        reminded++;
      }
    }

    // Newest invitation first: only the current link has a clock, and one not yet sent has none.
    const links = await tx
      .select({
        id: c.id,
        status: o.status,
        sentAt: o.sentAt,
        firstAttemptAt: o.firstAttemptAt,
        payload: o.payload,
        expires: c.inviteExpiresAt,
      })
      .from(c)
      .leftJoin(o, and(eq(o.candidateId, c.id), isOnsiteInvite, ne(o.status, "cancelled")))
      .where(eq(c.stage, "onsite_invited"))
      .orderBy(asc(c.id), desc(o.createdAt));
    const latest = new Map<string, (typeof links)[number]>();
    for (const link of links) if (!latest.has(link.id)) latest.set(link.id, link);
    for (const { id, status, sentAt, firstAttemptAt, payload, expires } of latest.values()) {
      const { remindDays, expireDays } = config.onsiteFollowUp;
      // These can never start the normal clock, so they would hold a place for good. `pending` is left alone: a pause starts no clock.
      const noInvite = status === null;
      const stuck = (status === "failed" || status === "uncertain") && !!firstAttemptAt && passed(firstAttemptAt, expireDays);
      if (!noInvite && !stuck && (status !== "sent" || !sentAt)) continue;
      // expireDays can pass the token's 30 days. A dead link must not hold a place or go out in a reminder.
      const dead = !!expires && expires <= now;
      const ended = noInvite || stuck || dead || passed(sentAt!, expireDays);
      if (!ended && !passed(sentAt!, remindDays)) continue;
      const row = await lockCandidate(tx, id);
      if (row.stage !== "onsite_invited") continue;
      if (ended) {
        await tx
          .update(c)
          .set({ stage: "no_booking", inviteExpiresAt: null, revision: row.revision + 1, updatedAt: now })
          .where(eq(c.id, id));
        await audit(tx, "hiring-follow-up", "no-booking", id, { sentAt, status });
        expired++;
      } else if (
        row.email &&
        row.inviteExpiresAt &&
        (await enqueue(tx, {
          key: `${id}:visit-reminder:${payload!.revision}`,
          candidateId: id,
          kind: "email",
          createdAt: now,
          payload: {
            to: row.email,
            workflowStage: "onsite_invited",
            ...visitInviteEmail({
              name: row.name,
              subject: row.visitSubject ?? "your subject",
              url: visitLink(id, row.inviteExpiresAt),
              location: config.location,
            }),
          },
        }))
      ) {
        await audit(tx, "hiring-follow-up", "visit-reminder", id, { sentAt });
        reminded++;
      }
    }
    return { reminded, expired };
  });
}
