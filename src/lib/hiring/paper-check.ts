import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import * as s from "@/lib/db/schema";
import { headRecommendation, queueFinalResult, rejectionSendAt } from "./decisions";
import { paperResultEmail } from "./email";
import { computeSheet, passRulesFor, type PaperSheet } from "./marking-sheet";
import { HiringError, PAPER_CHECK_FROM_PERCENT, paperCheckerFor, ZONE, type Subject } from "./model";
import { hiringOrigin } from "./onboarding-config";
import { enqueueRecruitmentLine, lineWhen, lineWho } from "./recruitment";
import { audit, cancelFailedMock, candidateById, countedFail, lockCandidate, settings } from "./service";
import { bookingToken, readBookingToken } from "./tokens";
import { deliverOutbox } from "./worker";

/*
 * Kevin, 24 Nov 2026. A counted paper fail:
 * - best level at or above PAPER_CHECK_FROM_PERCENT: the subject's head checks the marked paper first (a LINE notice in
 *   their own group). The mock stays booked. The head's marks then decide: a pass goes on to the mock, a fail is rejected.
 * - below that, or after the head's check: the mock is cancelled and the styled rejection email is queued at once.
 * The two audit rows below are the check's whole state, so this needs no migration.
 */
export const PAPER_CHECK_REQUESTED = "paper-check-requested";
export const PAPER_CHECK_DONE = "paper-check-done";
const LINK_DAYS = 14;

const p = s.hiringPaperResults;
const when = (date: Date) => date.toLocaleString("en-GB", { timeZone: ZONE, dateStyle: "medium", timeStyle: "short" });
const round = (value: number) => Math.round(value * 10) / 10;

/** The best level the candidate tried, as an exact percent. A pass needs only one level, so a check looks at the best. */
export const bestPercent = (sheet: PaperSheet) =>
  Math.max(0, ...sheet.levels.filter((l) => l.result !== "not_done" && l.max > 0).map((l) => (l.scored / l.max) * 100));
/** The pass mark of that best level, for the notice and the page. */
const bestPassMark = (sheet: PaperSheet) =>
  sheet.levels.filter((l) => l.result !== "not_done" && l.max > 0).sort((a, b) => b.scored / b.max - a.scored / a.max)[0]?.passPercent ?? null;

export const paperCheckPath = (resultId: string, now: Date) =>
  `/hiring/paper-check/${bookingToken(resultId, "paper-check", new Date(now.getTime() + LINK_DAYS * 86400000))}`;

async function checkRows(db: Database, resultIds: string[]) {
  if (!resultIds.length) return [];
  return db.select().from(s.hiringAudit)
    .where(and(inArray(s.hiringAudit.action, [PAPER_CHECK_REQUESTED, PAPER_CHECK_DONE]), inArray(sql`${s.hiringAudit.detail}->>'resultId'`, resultIds)))
    .orderBy(desc(s.hiringAudit.createdAt));
}
/*
 * Kevin, 25 Nov 2026: after the check, a head may still pass a paper from PAPER_CHECK_FROM_PERCENT up to the pass mark,
 * with a written reason. The reason sits on the check's own audit row, and it stands while the marks are the ones the head
 * checked (`marksAt`): a later change of marks lets the marks decide again.
 */
type AuditRow = typeof s.hiringAudit.$inferSelect;
export const overrideStands = (done: AuditRow | undefined, result: { updatedAt: Date }) =>
  typeof done?.detail.override === "string" && done.detail.marksAt === result.updatedAt.toISOString();
/** A head's override that still stands on this result. */
export async function headOverride(db: Database, result: { id: string; updatedAt: Date }) {
  return overrideStands(stateOf(await checkRows(db, [result.id]), result.id).done, result);
}
/** The refusal for an override outside the near-miss band, or null. */
export const overrideRefusal = (sheet: PaperSheet) =>
  sheet.result === "not_passed" && bestPercent(sheet) >= PAPER_CHECK_FROM_PERCENT
    ? null
    : `A head can pass a paper only from ${PAPER_CHECK_FROM_PERCENT}% up to the pass mark. Your marks do not need it.`;

const stateOf = (rows: Awaited<ReturnType<typeof checkRows>>, resultId: string) => ({
  requested: rows.find((row) => row.action === PAPER_CHECK_REQUESTED && row.detail.resultId === resultId),
  done: rows.find((row) => row.action === PAPER_CHECK_DONE && row.detail.resultId === resultId),
});

const futureMock = async (tx: Database, candidateId: string, subject: Subject, now: Date) =>
  (await tx.select().from(s.hiringBookings).where(and(eq(s.hiringBookings.candidateId, candidateId), eq(s.hiringBookings.kind, "mock"),
    eq(s.hiringBookings.status, "confirmed")))).find((b) => b.subjects.includes(subject) && b.startTime > now);

async function requestCheck(tx: Database, fail: NonNullable<Awaited<ReturnType<typeof countedFail>>>, actor: string, now: Date) {
  const { result, sheet, config } = fail;
  const subject = result.subject;
  const head = paperCheckerFor(config, subject);
  const [group] = head
    ? await tx.select().from(s.progressLineGroups).where(and(eq(s.progressLineGroups.canonicalKey, head), eq(s.progressLineGroups.enabled, true)))
    : [];
  const candidate = await candidateById(tx, result.candidateId);
  const mock = await futureMock(tx, result.candidateId, subject, now);
  const percent = round(bestPercent(sheet));
  const pass = bestPassMark(sheet);
  await audit(tx, actor, PAPER_CHECK_REQUESTED, result.candidateId, { resultId: result.id, subject, head, percent, line: !!group });
  if (group)
    await enqueueRecruitmentLine(tx, `paper-check:${result.id}`, group.groupId,
      `📝 Paper check needed\n${lineWho(candidate.name, subject)}\nAI score ${percent}%${pass === null ? "" : ` · pass mark ${pass}%`}\nMock: ${mock ? lineWhen(mock.startTime) : "not booked yet"}\n\nMark the paper here:\n${new URL(paperCheckPath(result.id, now), hiringOrigin())}\n\nPass → mock teaching. Fail → rejection email.`,
      null, "paper_check");
}

/** Tells the recruitment group the head's answer and what the tool did. A missing group is not an error. */
async function noticeCheckDone(tx: Database, input: { name: string; subject: Subject; head: string; percent: number; outcome: string; override: string | null; held: string | null; mockAt: Date | null; resultId: string; now: Date; config: { recruitmentLineGroupId: string | null } }) {
  if (!input.config.recruitmentLineGroupId) return;
  const next = input.outcome === "passed"
    ? (input.mockAt ? `Done: the mock stays booked, ${lineWhen(input.mockAt)}.` : "Next: invite the candidate to a mock.")
    : input.outcome === "rejected" ? `Done: the mock is cancelled and the rejection email ${rejectionSendAt(input.now) ? "goes out at 6 pm today" : "is sent now"}.`
      : `Next: Admin, open the Hiring page and send the result. No email was sent.${input.held ? ` (${input.held})` : ""}`;
  await enqueueRecruitmentLine(tx, `paper-check-done:${input.resultId}`, input.config.recruitmentLineGroupId,
    `${input.outcome === "passed" ? "✅ Paper PASS" : "❌ Paper NOT PASSED"} · ${input.percent}% · checked by ${input.head}${input.override ? ` (head override)\nWhy: ${input.override}` : ""}\n${lineWho(input.name, input.subject)}\n${next}`, null, "paper_check_done");
}

/**
 * Runs after a paper result counts or its marks change (AI marking, a person's check or change, a head's check).
 * Never throws for a result that is not a counted fail. `checkedBy` records a head's check before the decision.
 * Returns what happened, for tests and the head's page.
 */
export async function afterPaperCounted(db: Database, candidateId: string, subject: Subject, actor: string, now = new Date(), checkedBy?: string, override?: string) {
  let outboxKey: string | null = null;
  let heldFor: string | null = null;
  const outcome = await withDatabaseTransaction(db, async (tx): Promise<"none" | "check" | "rejected" | "held" | "passed"> => {
    await lockCandidate(tx, candidateId);
    // The same row lock as sendDecision and saveBriefDecision take first.
    await tx.select({ id: s.hiringCandidates.id }).from(s.hiringCandidates).where(eq(s.hiringCandidates.id, candidateId)).for("update");
    const candidate = await candidateById(tx, candidateId);
    if (["stopped", "hired", "rejected"].includes(candidate.stage)) return "none";
    let check: { resultId: string; percent: number; passed: boolean; override?: string; marksAt?: string } | null = null;
    if (checkedBy) {
      const { config } = await settings(tx);
      const [result] = await tx.select().from(p).where(and(eq(p.candidateId, candidateId), eq(p.subject, subject)));
      if (!result?.marks) throw new HiringError(409, "This paper has no marks. Refresh the page.");
      const sheet = computeSheet(result.marks, passRulesFor(config, subject));
      const refused = override ? overrideRefusal(sheet) : null;
      if (refused) throw new HiringError(400, refused);
      check = {
        resultId: result.id, percent: round(bestPercent(sheet)), passed: sheet.result === "passed" || !!override,
        ...(override ? { override, marksAt: result.updatedAt.toISOString() } : {}),
      };
      await audit(tx, actor, PAPER_CHECK_DONE, candidateId, { ...check, subject, head: checkedBy });
    }
    const decide = async () => {
      if (check?.passed) return "passed" as const;
      const fail = await countedFail(tx, candidateId, subject);
      if (!fail) return "none" as const;
      const { result, sheet, config } = fail;
      const state = stateOf(await checkRows(tx, [result.id]), result.id);
      if (!state.done && bestPercent(sheet) >= PAPER_CHECK_FROM_PERCENT) {
        if (!state.requested) await requestCheck(tx, fail, actor, now);
        return "check" as const;
      }
      const cancelled = await cancelFailedMock(tx, result, actor, now);
      const hold = async (message: string) => {
        heldFor = message;
        await audit(tx, actor, "paper-reject-held", candidateId, { subject, resultId: result.id, message });
        return "held" as const;
      };
      // Another subject that is not a clear, counted fail keeps the application open: a check that waits, a pass, a
      // blank scan or a result that is not counted yet. A person decides.
      const others = await tx.select().from(p).where(and(eq(p.candidateId, candidateId), ne(p.id, result.id)));
      const otherChecks = await checkRows(tx, others.map((o) => o.id));
      const open = others.find((o) => {
        const waiting = stateOf(otherChecks, o.id);
        return o.status !== "done" || !o.marks?.questions.some((q) => q.attempted) || (waiting.requested && !waiting.done) || overrideStands(waiting.done, o)
          || computeSheet(o.marks, passRulesFor(config, o.subject)).result !== "not_passed";
      });
      if (open) return hold(`The ${open.subject} paper is not a clear fail, so a person sends the result.`);
      // A head who has seen a mock lesson has a say: an unattended email must not overrule it.
      const mocks = await tx.select({ id: s.hiringBookings.id }).from(s.hiringBookings).where(and(eq(s.hiringBookings.candidateId, candidateId),
        eq(s.hiringBookings.kind, "mock"), eq(s.hiringBookings.status, "confirmed"), lte(s.hiringBookings.startTime, now)));
      if (mocks.length || (await headRecommendation(tx, candidateId))) return hold("A mock lesson has taken place, so a person sends the result.");
      // The paper that was just marked may still be booked until its end time.
      const papers = await tx.select({ id: s.hiringBookings.id }).from(s.hiringBookings).where(and(eq(s.hiringBookings.candidateId, candidateId),
        eq(s.hiringBookings.kind, "paper"), eq(s.hiringBookings.status, "confirmed"), lte(s.hiringBookings.startTime, now)));
      const reason = `Paper below the pass mark: ${round(bestPercent(sheet))}%${state.done ? ` after ${String(state.done.detail.head)}'s check` : ""}.`;
      try {
        outboxKey = await queueFinalResult(tx, candidate, "reject", reason, actor, null, now, {
          styled: paperResultEmail({ name: candidate.name, subject, checkedByHead: !!state.done, mockCancelled: !!cancelled }),
          ignore: papers.map((b) => b.id),
        });
      } catch (error) {
        if (error instanceof HiringError) return hold(error.message);
        throw error;
      }
      return "rejected" as const;
    };
    const outcome = await decide();
    if (check && checkedBy) {
      const { config } = await settings(tx);
      const mock = await futureMock(tx, candidateId, subject, now);
      await noticeCheckDone(tx, { name: candidate.name, subject, head: checkedBy, percent: check.percent, outcome, override: check.override ?? null, held: heldFor, mockAt: mock?.startTime ?? null, resultId: check.resultId, now, config });
    }
    return outcome;
  });
  return { outcome, outboxKey };
}

/** Kevin chose "at once": the email leaves now, not at the Mac worker's next run. A failed send stays queued for it. */
export async function deliverNow(db: Database, outboxKey: string | null) {
  if (!outboxKey) return;
  const { config } = await settings(db);
  await deliverOutbox(db, config, 1, false, outboxKey);
}

/** For the AI run and a person's change: saved marks must not be lost to an error here, so this never throws. */
export const afterPaperCountedQuietly = (db: Database, candidateId: string, subject: Subject, actor: string, now: Date) =>
  afterPaperCounted(db, candidateId, subject, actor, now)
    .then(({ outboxKey }) => deliverNow(db, outboxKey))
    .catch((error) => console.error("Hiring paper follow-up failed", error instanceof Error ? error.name : "UnknownError"));

/** The checks for the dashboard: open ones first. The path is the head's link, so an admin can open it too. */
export async function paperChecks(db: Database, now: Date) {
  const rows = await db.select().from(s.hiringAudit).where(inArray(s.hiringAudit.action, [PAPER_CHECK_REQUESTED, PAPER_CHECK_DONE]))
    .orderBy(desc(s.hiringAudit.createdAt)).limit(500);
  const requested = rows.filter((row) => row.action === PAPER_CHECK_REQUESTED);
  return requested.flatMap((row) => {
    const resultId = String(row.detail.resultId);
    const done = rows.find((r) => r.action === PAPER_CHECK_DONE && r.detail.resultId === resultId);
    let path: string | null = null;
    try {
      path = done ? null : paperCheckPath(resultId, now);
    } catch (error) {
      // No link secret: the dashboard must still load.
      if (!(error instanceof HiringError)) throw error;
    }
    return [{
      candidateId: row.candidateId!,
      resultId,
      subject: String(row.detail.subject) as Subject,
      head: typeof row.detail.head === "string" ? row.detail.head : null,
      percent: Number(row.detail.percent),
      line: row.detail.line === true,
      requestedAt: row.createdAt.toISOString(),
      path,
      done: done ? { passed: done.detail.passed === true, percent: Number(done.detail.percent), head: String(done.detail.head), at: done.createdAt.toISOString(), override: typeof done.detail.override === "string" ? done.detail.override : null } : null,
    }];
  });
}

/** The head's page. Access is the token and nothing else. */
export async function paperCheckView(token: string, db: Database = getDb(), now = new Date()) {
  const cap = readBookingToken(token, now);
  if (cap.kind !== "paper-check") throw new HiringError(404, "This link is invalid or has expired.");
  const [result] = await db.select().from(p).where(eq(p.id, cap.id));
  const state = result && stateOf(await checkRows(db, [result.id]), result.id);
  if (!result?.marks || !state?.requested) throw new HiringError(404, "This link is invalid or has expired.");
  const { config } = await settings(db);
  const candidate = await candidateById(db, result.candidateId);
  // A stopped or decided candidate's paper must not stay readable from the link (as briefMock). A head who has just
  // checked sees the answer on the page from the submit response.
  if (["stopped", "hired", "rejected"].includes(candidate.stage)) throw new HiringError(404, "This link is invalid or has expired.");
  const sheet = computeSheet(result.marks, passRulesFor(config, result.subject));
  const mock = await futureMock(db, result.candidateId, result.subject, now);
  return {
    id: result.id,
    name: candidate.name,
    subject: result.subject,
    head: typeof state.requested.detail.head === "string" ? state.requested.detail.head : null,
    aiPercent: Number(state.requested.detail.percent),
    passMark: bestPassMark(sheet),
    overrideFrom: PAPER_CHECK_FROM_PERCENT,
    mock: mock ? `${when(mock.startTime)} (Bangkok)` : null,
    updatedAt: result.updatedAt.toISOString(),
    questions: result.marks.questions.map((q) => ({ id: q.id, level: q.level, max: q.max, marks: q.marks, reason: q.reason })),
    comment: result.marks.comment,
    done: state.done ? { passed: state.done.detail.passed === true, percent: Number(state.done.detail.percent), head: String(state.done.detail.head), override: typeof state.done.detail.override === "string" ? state.done.detail.override : null } : null,
    // A person's change since the request can already pass the paper, or the application can close.
    open: !state.done && result.status === "done" && sheet.result === "not_passed",
  };
}
