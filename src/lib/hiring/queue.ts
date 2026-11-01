import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import { type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
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
  normalizeSubjects,
  PRE_SCREEN_URL,
  runtimeWritesAllowed,
  type HiringConfig,
  type Subject,
} from "./model";
import {
  availabilityFraction,
  hardStops,
  preScreenPoints,
  profileScore,
  visitSubject,
} from "./scoring";
import {
  audit,
  enqueue,
  inviteToPreScreen,
  inviteToVisit,
  settings,
  visitLink,
  type Candidate,
} from "./service";

const c = s.hiringCandidates,
  o = s.hiringOutbox,
  b = s.hiringBookings;
const DAY = 86400000;
const isForm = sql`${o.key} = ${o.candidateId}::text || ':pre-screen'`;
// A reminder carries the same stage so that a stage change cancels it, but it is not a new invitation.
const isOnsiteInvite = sql`${o.payload}->>'workflowStage' = 'onsite_invited' and ${o.key} not like '%:visit-reminder:%'`;
const lockQueue = (tx: Database) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-queue'))`);
const allowed = (config: HiringConfig) =>
  config.enabled && config.rubricApproved && runtimeWritesAllowed();

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
    .where(and(ne(o.status, "cancelled"), funnel === "pre_screen" ? isForm : isOnsiteInvite));
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
    .leftJoin(b, and(eq(b.candidateId, c.id), eq(b.status, "confirmed")))
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

/** The form row's send time. A row not yet sent, or not known to be sent, has no time, so no follow-up clock runs. */
export async function formSentAt(db: Database, candidateId: string) {
  const [form] = await db
    .select({ status: o.status, sentAt: o.sentAt })
    .from(o)
    .where(eq(o.key, `${candidateId}:pre-screen`));
  return form?.status === "sent" ? form.sentAt : null;
}

const preScreenTotal = (candidate: Candidate, config: HiringConfig) =>
  preScreenPoints(
    candidate.preScreenAssessment!,
    config.preScreenWeights,
    candidate.universityAssessment?.fraction ?? 0,
    availabilityFraction(candidate.preScreen!),
  ).total;

/**
 * What a reply means for an automatic invitation (design calls 9 and 17).
 * `hold`: a person decides, with the reason. `wait`: nothing decides yet. `ready`: it may enter the onsite queue.
 */
export function replyCheck(
  candidate: Candidate,
  sentAt: Date | null,
  config: HiringConfig,
): { kind: "hold"; reason: string } | { kind: "wait" } | { kind: "ready"; subject: Subject; score: number } {
  const hold = (reason: string) => ({ kind: "hold" as const, reason });
  const { preScreen: pre, preScreenAssessment: assessment, workRightsAnswer: answer } = candidate;
  if (!pre || !assessment) return { kind: "wait" };
  const { stops } = hardStops(pre, answer, normalizeSubjects(pre.subjects), config);
  if (stops.length) return hold(stops.join(" "));
  const subject = visitSubject(pre, answer, assessment, config);
  if (!subject) return hold("No named subject is supported and open for hiring.");
  if (!sentAt) return hold("This response has no matching form send. A person decides.");
  if (!candidate.email) return hold("There is no usable email.");
  if (candidate.previouslyContacted) return hold("There was earlier contact. A person decides.");
  if (candidate.preScreenResubmitted) return hold("This is a changed response. A person decides.");
  if (!candidate.preScreenRepliedAt) return hold("The response time could not be read. A person decides.");
  if (candidate.preScreenRepliedAt < sentAt) return hold("This response is older than the form send. A person decides.");
  if (!["pre_screen", "no_reply"].includes(candidate.stage)) return hold("This stage needs a person to decide.");
  if (config.preScreenThreshold === null) return { kind: "wait" };
  const score = preScreenTotal(candidate, config);
  if (score < config.preScreenThreshold)
    return hold(`The pre-screen score ${score} is below the pass score ${config.preScreenThreshold}.`);
  return { kind: "ready", subject, score };
}

export const autoInviteEligible = (candidate: Candidate, sentAt: Date | null, config: HiringConfig) =>
  replyCheck(candidate, sentAt, config).kind === "ready";

/** Only stage `new` enters, and any earlier form row, even a cancelled one, keeps a candidate out. */
export async function preScreenQueue(db: Database, config: HiringConfig): Promise<QueueEntry[]> {
  const rows = await db
    .select()
    .from(c)
    .where(
      and(
        eq(c.stage, "new"),
        isNull(c.preScreen),
        notExists(db.select({ id: o.id }).from(o).where(and(eq(o.candidateId, c.id), isForm))),
      ),
    );
  return rows.flatMap((row) => {
    const { eligible, subject } = profileGate(row, config);
    return eligible && subject
      ? [
          {
            id: row.id,
            subject,
            score: profileScore(row.profileAssessment!, config.profileWeights, row.universityAssessment?.fraction ?? 0),
            createdAt: row.createdAt,
          },
        ]
      : [];
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
  const entries: QueueEntry[] = [];
  for (const row of rows) {
    const check = replyCheck(row, await formSentAt(db, row.id), config);
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
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(eq(c.id, row.id));
      await audit(tx, "hiring-queue", "pre-screen-release", row.id, { subject: entry.subject, score: entry.score });
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
    if (!allowed(config) || !config.deliveryEnabled) return { reminded, expired };
    const passed = (sentAt: Date, days: number) => now.getTime() - sentAt.getTime() >= days * DAY;

    const forms = await tx
      .select({ id: c.id, sentAt: o.sentAt })
      .from(c)
      .innerJoin(o, and(eq(o.candidateId, c.id), isForm))
      .where(and(eq(c.stage, "pre_screen"), isNull(c.preScreen), eq(o.status, "sent"), isNotNull(o.sentAt)));
    for (const { id, sentAt } of forms) {
      const { remindDays, expireDays } = config.preScreenFollowUp;
      if (!passed(sentAt!, remindDays) && !passed(sentAt!, expireDays)) continue;
      const row = await lockCandidate(tx, id);
      if (row.stage !== "pre_screen" || row.preScreen) continue;
      if (passed(sentAt!, expireDays)) {
        await tx.update(c).set({ stage: "no_reply", revision: row.revision + 1, updatedAt: now }).where(eq(c.id, id));
        await audit(tx, "hiring-follow-up", "no-reply", id, { sentAt });
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
            subject: "Reminder: BeGifted tutor pre-screening questionnaire",
            workflowStage: "pre_screen",
            text: `Dear ${row.name},\n\nWe have not yet received your pre-screening questionnaire. If you are still interested in joining BeGifted, please complete it here:\n${PRE_SCREEN_URL}\n\nUse this application email: ${row.email}. The form takes about 5–7 minutes.\n\nBeGifted Education`,
          },
        }))
      ) {
        await audit(tx, "hiring-follow-up", "pre-screen-reminder", id, { sentAt });
        reminded++;
      }
    }

    // Newest invitation first: only the current link has a clock, and one not yet sent has none.
    const links = await tx
      .select({ id: c.id, status: o.status, sentAt: o.sentAt, payload: o.payload })
      .from(c)
      .innerJoin(o, and(eq(o.candidateId, c.id), isOnsiteInvite, ne(o.status, "cancelled")))
      .where(eq(c.stage, "onsite_invited"))
      .orderBy(asc(c.id), desc(o.createdAt));
    const latest = new Map<string, (typeof links)[number]>();
    for (const link of links) if (!latest.has(link.id)) latest.set(link.id, link);
    for (const { id, status, sentAt, payload } of latest.values()) {
      if (status !== "sent" || !sentAt) continue;
      const { remindDays, expireDays } = config.onsiteFollowUp;
      if (!passed(sentAt, remindDays) && !passed(sentAt, expireDays)) continue;
      const row = await lockCandidate(tx, id);
      if (row.stage !== "onsite_invited") continue;
      if (passed(sentAt, expireDays)) {
        await tx
          .update(c)
          .set({ stage: "no_booking", inviteExpiresAt: null, revision: row.revision + 1, updatedAt: now })
          .where(eq(c.id, id));
        await audit(tx, "hiring-follow-up", "no-booking", id, { sentAt });
        expired++;
      } else if (
        row.email &&
        row.inviteExpiresAt &&
        (await enqueue(tx, {
          key: `${id}:visit-reminder:${payload.revision}`,
          candidateId: id,
          kind: "email",
          createdAt: now,
          payload: {
            to: row.email,
            subject: "Reminder: book your BeGifted onsite visit",
            workflowStage: "onsite_invited",
            text: `Dear ${row.name},\n\nYou have not yet booked your onsite visit for ${row.visitSubject}. The visit takes 3 hours: a 2-hour exam, then a 1-hour mock teaching session. Please book here:\n${visitLink(id, row.inviteExpiresAt)}\n\nFor questions, add our LINE Official Account at https://lin.ee/OjMHF41.\n\nBeGifted Education`,
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
