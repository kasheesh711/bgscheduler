import { randomUUID } from "node:crypto";
import { and, eq, getTableName, gt, inArray, like, or, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb, type Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { HEAD_DECISION } from "./decisions";
import { FINAL_REVIEW_PACKET, reviewPacketDetail } from "./final-review";
import { passRulesFor, RUBRIC_ITEMS, type MockRubric, type PaperMarks } from "./marking-sheet";
import {
  emailSchema, HR_CALENDAR, localDate, normalizeEmail, PAPER_LEVELS,
  PRACTICE_NAME_PREFIX, PRACTICE_SOURCE_PREFIX, practiceMarker, type HiringConfig, type Subject,
} from "./model";
import { validateAssessment } from "./scoring";
import { settings, sourceHash } from "./service";

const ACTOR = "hiring-practice";
const HOUR = 3600000;
const DAY = 24 * HOUR;
const c = s.hiringCandidates;
const b = s.hiringBookings;
const a = s.hiringAudit;
const o = s.hiringOutbox;
const d = s.hiringRecruitmentDeliveries;

type PracticeOptions = { apply?: boolean; remove?: boolean; email?: string };
type PlannedRow = { table: string; keys: object };
type PracticeCase = {
  name: string;
  kind: "score" | "finished-no" | "gift" | "other";
  head: string | null;
  mockEnd: Date | null;
};
type Head = HiringConfig["interviewers"][number];
type Slot = { startTime: Date; endTime: Date };

async function markedCandidates(db: Database, lock: boolean) {
  const query = db.select({ id: c.id, name: c.name, sourceIds: c.sourceIds }).from(c).where(and(
    like(c.name, `${PRACTICE_NAME_PREFIX}%`),
    sql`${c.sourceIds}->>0 like ${`${PRACTICE_SOURCE_PREFIX}%`}`,
  ));
  return (await (lock ? query.for("update") : query)).filter(practiceMarker);
}

function practiceEmail(base: string, tag: string) {
  const [local, domain] = base.split("@");
  const alias = `${local}${local.includes("+") ? "-" : "+"}practice-${tag}`;
  if (alias.length > 64) throw new Error("Use a shorter email address for the practice aliases.");
  return emailSchema.parse(`${alias}@${domain}`);
}

function nextMock(head: Head, now: Date, busy: Map<string, Slot[]>, maxAge: number): Slot {
  const last = Math.floor((now.getTime() - 1) / (HOUR / 2)) * (HOUR / 2);
  const blocks = busy.get(head.canonicalKey) ?? [];
  for (let time = last; time > now.getTime() - maxAge; time -= HOUR / 2) {
    const startTime = new Date(time - HOUR);
    const endTime = new Date(time);
    if (localDate(startTime) !== localDate(endTime) ||
      blocks.some((block) => startTime < block.endTime && block.startTime < endTime)) continue;
    const slot = { startTime, endTime };
    busy.set(head.canonicalKey, [...blocks, slot]);
    return slot;
  }
  throw new Error(`No past practice mock time is available for ${head.canonicalKey}.`);
}

async function seed(db: Database, options: PracticeOptions, now: Date, plan: PlannedRow[], summary: PracticeCase[]) {
  const { config } = await settings(db);
  const heads = config.interviewers;
  if (!heads.length) throw new Error("Hiring settings have no interviewers.");
  const existing = new Set((await markedCandidates(db, false)).map(practiceMarker));
  const giftHead = heads.find((head) => head.subjects[0] === "Mathematics") ?? heads[0];
  const cases = [
    ...heads.flatMap((head) => ([
      { head, kind: "score", label: `Kru ${head.canonicalKey}: score this mock` },
      { head, kind: "finished-no", label: `Kru ${head.canonicalKey}: finished No` },
    ] as const)),
    { head: giftHead, kind: "gift", label: "Gift: review this offer" } as const,
  ];
  const since = new Date(now.getTime() - 3 * DAY - HOUR);
  const [bookings, observations] = await Promise.all([
    db.select({ head: b.interviewerKey, startTime: b.startTime, endTime: b.endTime }).from(b)
      .where(and(eq(b.status, "confirmed"), gt(b.endTime, since), inArray(b.interviewerKey, heads.map((h) => h.canonicalKey)))),
    db.select({
      head: s.tutorSitInObservations.observerCanonicalKey,
      startTime: s.tutorSitInObservations.startTime,
      endTime: s.tutorSitInObservations.endTime,
    }).from(s.tutorSitInObservations).where(and(eq(s.tutorSitInObservations.current, true), gt(s.tutorSitInObservations.endTime, since),
      inArray(s.tutorSitInObservations.observerCanonicalKey, heads.map((h) => h.canonicalKey)))),
  ]);
  const busy = new Map<string, Slot[]>();
  for (const row of [...bookings, ...observations]) {
    if (row.head) busy.set(row.head, [...(busy.get(row.head) ?? []), row]);
  }
  const put = (table: PgTable, keys: object) => plan.push({ table: getTableName(table), keys });
  const hr = normalizeEmail(process.env.HIRING_HR_EMAIL) ?? HR_CALENDAR;
  const baseEmail = options.email ?? "owner@example.invalid";
  for (const { head, kind, label } of cases) {
    const headSlug = head.canonicalKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || "head";
    const suffix = sourceHash(head.canonicalKey).slice(0, 8);
    const slug = kind === "gift" ? "gift" : `${headSlug}-${kind === "score" ? 2 : 1}-${suffix}`;
    const marker = `${PRACTICE_SOURCE_PREFIX}${slug}`;
    if (existing.has(marker)) continue;
    existing.add(marker);
    const subject = head.subjects[0];
    const mockTime = nextMock(head, now, busy, kind === "score" ? DAY : 3 * DAY);
    const id = randomUUID();
    const name = PRACTICE_NAME_PREFIX + label;
    summary.push({ name, kind, head: head.canonicalKey, mockEnd: mockTime.endTime });
    const email = practiceEmail(baseEmail, slug);
    const stage = kind === "finished-no" ? "rejected" : "mock_booked";
    const paper = {
      id: randomUUID(), candidateId: id, kind: "paper", subjects: [subject], visitId: randomUUID(),
      startTime: new Date(mockTime.startTime.getTime() - 2 * DAY),
      endTime: new Date(mockTime.startTime.getTime() - 2 * DAY + HOUR),
      status: "confirmed", calendarOwner: config.connectedEmail, evidence: { practice: true },
    } as const satisfies typeof b.$inferInsert;
    const mock = {
      ...mockTime, id: randomUUID(), candidateId: id, kind: "mock", subjects: [subject], status: "confirmed",
      interviewerKey: head.canonicalKey, interviewerEmail: head.email, calendarOwner: config.connectedEmail,
      // The booking constraint requires a value. This is not a LINE group.
      lineGroupId: ACTOR, evidence: { practice: true },
    } as const satisfies typeof b.$inferInsert;
    const marks = practicePaper(config, subject);
    const paperResult = {
      id: randomUUID(), candidateId: id, bookingId: paper.id, subject, marks,
      source: "person", status: "done", checkedBy: hr, checkedAt: paper.endTime, updatedAt: paper.endTime,
    } as const satisfies typeof s.hiringPaperResults.$inferInsert;
    const seedAudit = { id: randomUUID(), candidateId: id, actor: ACTOR, action: "practice-created", detail: { marker, kind } };
    put(c, { id, name, email, stage, subject, marker, paperPassedAt: paper.endTime, resumePath: null });
    for (const row of [paper, mock]) {
      put(b, { id: row.id, candidateId: id, kind: row.kind, status: row.status, subject,
        ...(row.kind === "mock" ? { interviewerKey: row.interviewerKey } : { visitId: row.visitId }),
        startTime: row.startTime, endTime: row.endTime });
    }
    put(s.hiringPaperResults, { id: paperResult.id, candidateId: id, bookingId: paper.id, subject,
      status: paperResult.status, source: paperResult.source, marks, fileId: null });
    put(a, seedAudit);
    if (options.apply) {
      const callAt = new Date(paper.startTime.getTime() - 3 * DAY).toISOString();
      const repliedAt = new Date(paper.startTime.getTime() - DAY);
      const preScreen = {
        sourceRow: 1, submittedAt: repliedAt.toISOString(), degree: "Bachelor's degree", field: subject,
        subjects: subject, curricula: "IGCSE", yearGroups: "Years 9–11", english: "Advanced (C1)",
        englishEvidence: "Taught small groups in English.", experience: "Two years of small-group tutoring.",
        portfolio: "", availability: "Weekday evenings, Saturday mornings", weeklyHours: "11-20",
        motivation: "I want to help students gain confidence before exams.",
        teachingApproach: "I use a worked example, then ask the student to explain a similar answer.",
      };
      const quotes = {
        degree: `Bachelor's degree in ${subject}, Example Learning College.`,
        subject: `Tutored ${subject} for two years.`,
        curriculum: "Prepared Years 9–11 students for IGCSE.",
        teaching: "Led weekly sessions for groups of three students.",
        english: preScreen.englishEvidence,
      };
      const profileText = Object.values(quotes).join("\n");
      const profileAssessment = validateAssessment({
        criteria: Object.entries(quotes).map(([criterion, evidence]) => ({
          id: criterion, result: "met", evidence, reason: "Recorded in the fictional profile.",
        })),
        subjects: [{ subject, evidence: quotes.subject, relevant: true }],
        universities: [{ name: "Example Learning College", evidence: quotes.degree, completedDegree: true }],
        summary: "Fictional tutor profile for staff practice.",
      }, profileText);
      await db.insert(c).values({
        id, name, email, sourceIds: [marker], stage, subjects: [subject], visitSubject: subject,
        profileText, profileHash: sourceHash(profileText), profileAssessment,
        workRightsAnswer: "I have permanent work rights with no restrictions",
        preScreen, preScreenRepliedAt: repliedAt, paperPassedSubjects: [subject], paperPassedAt: paper.endTime, paperRecordedBy: hr,
        callReview: { good: { at: callAt, by: hr }, tries: [], notes: { text: "Practice call. Explained how they check a student's understanding.", at: callAt, by: hr } },
        createdAt: new Date(paper.startTime.getTime() - 4 * DAY), updatedAt: now,
      });
      await db.insert(b).values([paper, mock]);
      await db.insert(s.hiringPaperResults).values(paperResult);
      await db.insert(a).values(seedAudit);
    }
    if (kind === "score") continue;

    const hire = kind === "gift";
    const score = hire ? 9 : 3;
    const rubric = {
      items: Object.fromEntries(RUBRIC_ITEMS.map((item) => [item, score])),
      comments: hire ? "Checked prior knowledge, then adjusted the second example." : "Gave the answer before the student could explain their method.",
      stressTest: { listens: hire, explains: hire, plan: hire }, checksDone: hire,
    } as MockRubric;
    const mockResult = {
      id: randomUUID(), candidateId: id, bookingId: mock.id, subject, rubric,
      source: "person", status: "done", updatedAt: mock.endTime,
    } as const satisfies typeof s.hiringMockResults.$inferInsert;
    const actor = `interviewer:${head.canonicalKey}`;
    const reason = hire ? "Clear explanations and specific checks for understanding." : "The candidate needs more practice checking for understanding.";
    const recommendation = {
      id: randomUUID(), candidateId: id, actor, action: HEAD_DECISION,
      detail: { decision: hire ? "hire" : "reject", reason, head: head.canonicalKey, bookingId: mock.id, mockResultId: mockResult.id },
      createdAt: mock.endTime,
    };
    put(s.hiringMockResults, { ...mockResult, fileId: null });
    put(a, recommendation);
    if (options.apply) {
      await db.insert(s.hiringMockResults).values(mockResult);
      await db.insert(a).values(recommendation);
    }
    if (hire) {
      const input = {
        behavioral: "Practice assessment. The candidate gave a clear example of how to adapt a lesson after a student made an error.",
        offer: `PRACTICE ONLY. Example offer for a part-time ${subject} tutor. Proposed start: two weeks after signing. Hours to be agreed with HR.`,
      };
      const key = { id: randomUUID(), actor: hr, candidateId: id, action: FINAL_REVIEW_PACKET, createdAt: now };
      put(a, { ...key, ...input, paperResultId: paperResult.id, mockResultId: mockResult.id, recommendationId: recommendation.id });
      if (options.apply) await db.insert(a).values({ ...key, detail: await reviewPacketDetail(db, id, input) });
    } else {
      const decision = {
        id: randomUUID(), candidateId: id, decision: "reject", status: "sent", reason, decidedBy: actor,
        emailSubject: "Practice result", emailBody: "This decision is for practice. No email was sent.", sentAt: mock.endTime,
      } as const satisfies typeof s.hiringDecisions.$inferInsert;
      put(s.hiringDecisions, { ...decision, outboxKey: null });
      if (options.apply) await db.insert(s.hiringDecisions).values(decision);
    }
  }
}

function practicePaper(config: HiringConfig, subject: Subject): PaperMarks {
  // With no pass mark saved for the subject, the sheet says "pass mark missing", as it does for a real candidate.
  const rules = passRulesFor(config, subject);
  const level = rules.has("IGCSE / GCSE") ? "IGCSE / GCSE" : PAPER_LEVELS.find((item) => rules.has(item)) ?? "IGCSE / GCSE";
  const second = Math.max(8, Math.ceil((rules.get(level) ?? 70) / 5) - 10);
  return {
    questions: [
      { id: "1", level, marks: 10, max: 10, reason: "Correct answer with clear working.", attempted: true, readable: true },
      { id: "2", level, marks: second, max: 10, reason: second === 10 ? "Complete explanation." : "Correct method with a small error.", attempted: true, readable: true },
    ],
    comment: "Synthetic marks for staff practice.", missingPages: null,
  };
}

async function remove(db: Database, apply: boolean, plan: PlannedRow[], summary: PracticeCase[]) {
  const candidates = await markedCandidates(db, apply);
  if (!candidates.length) return;
  const ids = candidates.map((row) => row.id);
  const [bookings, auditRows] = await Promise.all([
    db.select({ id: b.id, candidateId: b.candidateId, kind: b.kind, status: b.status, head: b.interviewerKey, endTime: b.endTime })
      .from(b).where(inArray(b.candidateId, ids)).orderBy(b.createdAt),
    db.select({ id: a.id, candidateId: a.candidateId, action: a.action, detail: a.detail }).from(a).where(inArray(a.candidateId, ids)),
  ]);
  const outboxMatch = inArray(o.candidateId, ids);
  const outboxQuery = db.select({ id: o.id, key: o.key, status: o.status, candidateId: o.candidateId, kind: o.kind }).from(o).where(outboxMatch);
  const outbox = await (apply ? outboxQuery.for("update") : outboxQuery);
  for (const candidate of candidates) {
    const active = bookings.find((row) => row.candidateId === candidate.id &&
      row.status === "confirmed" && (row.kind === "contract" || row.kind === "call"));
    if (active) throw new Error(`Cannot remove "${candidate.name}". Cancel the confirmed ${active.kind} booking in the UI first.`);
    if (outbox.some((row) => row.candidateId === candidate.id && row.kind === "calendar" && row.status === "sent"))
      throw new Error(`Cannot remove "${candidate.name}". A calendar event was sent. Cancel it in the UI first.`);
    const kind = auditRows.find((row) => row.candidateId === candidate.id && row.action === "practice-created")?.detail.kind;
    const mock = bookings.find((row) => row.candidateId === candidate.id && row.kind === "mock");
    summary.push({
      name: candidate.name, kind: kind === "score" || kind === "finished-no" || kind === "gift" ? kind : "other",
      head: mock?.head ?? null, mockEnd: mock?.endTime ?? null,
    });
  }
  const prefix = sql<string>`split_part(${d.key}, ':', 1)`;
  const reference = sql<string>`split_part(${d.key}, ':', 2)`;
  const deliveryMatch = or(
    inArray(d.bookingId, bookings.map((row) => row.id)),
    and(eq(prefix, "head-decision"), inArray(reference, auditRows.filter((row) => row.action === HEAD_DECISION).map((row) => row.id))),
    and(eq(prefix, "form-completed"), inArray(reference, ids)),
    and(eq(prefix, "invite-sent"), inArray(reference, outbox.map((row) => row.id))),
  );
  const deliveryQuery = db.select({ id: d.id, key: d.key, status: d.status }).from(d).where(deliveryMatch);
  const deliveries = await (apply ? deliveryQuery.for("update") : deliveryQuery);
  if (apply && (outbox.some((row) => row.status === "processing") || deliveries.some((row) => row.status === "sending")))
    throw new Error("A practice delivery is in progress. Retry when it finishes.");

  const add = (table: PgTable, rows: object[]) => {
    for (const keys of rows) plan.push({ table: getTableName(table), keys });
  };
  add(d, deliveries);
  add(o, outbox.map(({ id, key, status }) => ({ id, key, status })));
  add(a, auditRows.map(({ id, candidateId, action }) => ({ id, candidateId, action })));
  add(b, bookings.map(({ id, candidateId, kind }) => ({ id, candidateId, kind })));
  const cascades = [s.hiringPaperResults, s.hiringMockResults, s.hiringAssessmentFiles, s.hiringDecisions, s.hiringOnboarding];
  for (const table of cascades) {
    const key = "id" in table ? table.id : table.candidateId;
    add(table, await db.select({ id: key, candidateId: table.candidateId }).from(table).where(inArray(table.candidateId, ids)));
  }
  add(c, candidates);
  if (apply) {
    await db.delete(d).where(deliveryMatch);
    await db.delete(o).where(outboxMatch);
    await db.delete(a).where(inArray(a.candidateId, ids));
    await db.delete(b).where(inArray(b.candidateId, ids));
    await db.delete(c).where(inArray(c.id, ids));
  }
}

export async function runHiringPractice(options: PracticeOptions, db: Database = getDb(), now = new Date()) {
  if (!options.remove && (options.apply || options.email !== undefined)) options = { ...options, email: emailSchema.parse(options.email) };
  const plan: PlannedRow[] = [];
  const summary: PracticeCase[] = [];
  const run = async (tx: Database) => {
    if (options.apply) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-practice'))`);
    if (options.remove) await remove(tx, !!options.apply, plan, summary);
    else await seed(tx, options, now, plan, summary);
  };
  if (options.apply) await withDatabaseTransaction(db, run);
  else await run(db);
  return { rows: plan, summary };
}
