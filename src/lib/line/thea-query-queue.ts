import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { theaTeacherQueries as jobs } from "@/lib/db/schema";
import { pushLineTextMessage, replyLineMessage } from "./client";
import { mentionedTheaText, parseTheaQuery, theaQueriesEnabled, THEA_QUERY_MONTHLY_USD,
  THEA_QUERY_RESERVATION_USD, validateTheaQuery } from "./thea-query";
import { answerTheaQuery, readTheaRoster, TheaWiseReader } from "./thea-query-data";

export async function receiveTheaQuery(db: Database, raw: unknown): Promise<{ handled: boolean; queued?: boolean }> {
  const text = mentionedTheaText(raw);
  if (text === null) return { handled: false };
  const event = raw as { webhookEventId?: string; replyToken?: string; source?: { type?: string; groupId?: string; userId?: string } };
  if (!theaQueriesEnabled() || event.source?.type !== "group" || event.source.groupId !== process.env.THEA_LINE_GROUP_ID
    || typeof event.source.userId !== "string" || !event.source.userId || event.source.userId.length > 128
    || typeof event.webhookEventId !== "string" || !event.webhookEventId || event.webhookEventId.length > 128) return { handled: true };
  let queued = false;
  let message = "Please mention Thea with a teacher question, date and time (maximum 1,000 characters).";
  if (text && text.length <= 1000) {
    const inserted = await withDatabaseTransaction(db, async tx => {
      // One lock also prevents parallel duplicate/rate-limit checks from admitting a burst.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('thea-query-ingress'))`);
      const [duplicate] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.eventId, event.webhookEventId!));
      if (duplicate) return "duplicate" as const;
      const [recent] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.groupId, event.source!.groupId!),
        eq(jobs.userId, event.source!.userId!), gt(jobs.createdAt, new Date(Date.now() - 10_000))));
      if (recent) return "rate" as const;
      await tx.insert(jobs).values({ eventId: event.webhookEventId!, groupId: event.source!.groupId!, userId: event.source!.userId!, question: text });
      return "queued" as const;
    });
    if (inserted === "duplicate") return { handled: true };
    queued = inserted === "queued";
    message = queued ? "Thea is checking Wise. I will post the result here. A cold lookup can take a few minutes.\nกำลังตรวจสอบข้อมูล Wise แล้วจะส่งผลในกลุ่มนี้ค่ะ"
      : "Please wait ten seconds before asking Thea again.\nกรุณารอสิบวินาทีก่อนถามอีกครั้งค่ะ";
  }
  if (typeof event.replyToken === "string" && event.replyToken) await replyLineMessage({ tutorBot: true, replyToken: event.replyToken, text: message }).catch(() => undefined);
  return { handled: true, queued };
}

export function theaBudgetMonthStart(now: Date) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${day.slice(0, 7)}-01T00:00:00+07:00`);
}

/** Returns false without a paid call when the approved monthly reservation is exhausted. */
export async function reserveTheaBudget(db: Database, id: string, claimToken: string, now = new Date()) {
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('thea-query-budget'))`);
    const [total] = await tx.select({ usd: sql<number>`coalesce(sum(greatest(${jobs.reservedUsd}, coalesce(${jobs.costUsd}, 0))), 0)` })
      .from(jobs).where(gte(jobs.createdAt, theaBudgetMonthStart(now)));
    if (Number(total.usd) + THEA_QUERY_RESERVATION_USD > THEA_QUERY_MONTHLY_USD + 1e-9) return false;
    const [reserved] = await tx.update(jobs).set({ reservedUsd: sql`${jobs.reservedUsd} + ${THEA_QUERY_RESERVATION_USD}` })
      .where(and(eq(jobs.id, id), eq(jobs.claimToken, claimToken), eq(jobs.status, "running"), gt(jobs.leaseExpiresAt, now), gte(jobs.createdAt, theaBudgetMonthStart(now))))
      .returning({ id: jobs.id });
    return Boolean(reserved);
  });
}

function isUniqueViolation(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "23505";
}

export async function runTheaQueryWorker(db: Database) {
  if (!theaQueriesEnabled()) return { handled: false };
  const deadline = Date.now() + 700_000;
  let handled = false;
  while (theaQueriesEnabled() && Date.now() + 60_000 < deadline) {
    const now = new Date(), claimToken = randomUUID();
    let job: typeof jobs.$inferSelect | undefined;
    try {
      job = await withDatabaseTransaction(db, async tx => {
        await tx.update(jobs).set({ status: "pending", claimToken: null, leaseExpiresAt: null })
          .where(and(eq(jobs.status, "running"), lte(jobs.leaseExpiresAt, now)));
        const [running] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "running"));
        if (running) return undefined;
        const [next] = await tx.select().from(jobs).where(and(eq(jobs.status, "pending"), eq(jobs.groupId, process.env.THEA_LINE_GROUP_ID!)))
          .orderBy(asc(jobs.createdAt)).limit(1).for("update", { skipLocked: true });
        if (!next) return undefined;
        const [claimed] = await tx.update(jobs).set({ status: "running", claimToken,
          leaseExpiresAt: new Date(now.getTime() + 12 * 60_000) }).where(eq(jobs.id, next.id)).returning();
        return claimed;
      });
    } catch (error) { if (isUniqueViolation(error)) return { handled }; throw error; }
    if (!job) return { handled };
    handled = true;
    const fence = () => and(eq(jobs.id, job!.id), eq(jobs.status, "running"), eq(jobs.claimToken, claimToken), gt(jobs.leaseExpiresAt, new Date()));
    let answer = job.answer;
    if (!answer) {
      try {
        if (job.createdAt < new Date(Date.now() - 30 * 60_000) || job.createdAt < theaBudgetMonthStart(new Date())) throw new Error("This request expired. Please mention Thea again.");
        const reader = new TheaWiseReader(db, Math.min(deadline - 15_000, Date.now() + 540_000));
        const roster = await readTheaRoster(db, reader);
        const [previous] = await db.select({ criteria: jobs.criteria }).from(jobs).where(and(eq(jobs.groupId, job.groupId),
          eq(jobs.userId, job.userId), eq(jobs.status, "done"), gt(jobs.createdAt, new Date(Date.now() - 15 * 60_000))))
          .orderBy(desc(jobs.createdAt)).limit(1);
        if (!await reserveTheaBudget(db, job.id, claimToken)) throw new Error("Thea has reached its approved $5 monthly AI budget. Please ask Kevin to review it.");
        const parsed = await parseTheaQuery(job.question, roster.options, previous?.criteria ?? null);
        await db.update(jobs).set({ criteria: parsed.query, costUsd: parsed.costUsd }).where(fence());
        const query = validateTheaQuery(parsed.query, roster.options);
        answer = typeof query === "string" ? query : await answerTheaQuery(reader, roster, query);
      } catch (error) {
        const known = error instanceof Error ? error.message : "";
        console.warn("THEA_QUERY_FAILED", { id: job.id, type: error instanceof Error ? error.name : "Error" });
        const safe = /^(Thea has reached|This request expired|Please |Wise changed|This query is too broad|Wise is rate-limiting)/.test(known) ? known
          : "I could not verify the Wise data for this question. Please try again later; I will not guess availability.";
        answer = `${safe}\nยังยืนยันข้อมูลไม่ได้ กรุณาลองใหม่ค่ะ`;
      }
      // LINE text limit is 5,000 characters. Truncation is explicit, never an exhaustive claim.
      if (answer.length > 4500) answer = `${answer.slice(0, 3600)}\n…More results were omitted. Please narrow the subject, level or teacher.\n${answer.split("\n").slice(-2).join("\n").slice(-500)}`;
      const [saved] = await db.update(jobs).set({ answer }).where(fence()).returning({ id: jobs.id });
      if (!saved) return { handled };
    }
    if (!theaQueriesEnabled() || job.groupId !== process.env.THEA_LINE_GROUP_ID) return { handled };
    try {
      const [active] = await db.select({ id: jobs.id }).from(jobs).where(fence());
      if (!active) return { handled };
      await pushLineTextMessage({ tutorBot: true, to: job.groupId, retryKey: job.id,
        text: `Thea (BOT)\n${answer}`, signal: AbortSignal.timeout(15_000) });
      await db.update(jobs).set({ status: "done", deliveredAt: new Date(), claimToken: null, leaseExpiresAt: null }).where(fence());
    } catch {
      await db.update(jobs).set({ status: "pending", claimToken: null, leaseExpiresAt: null }).where(fence());
      return { handled };
    }
  }
  return { handled };
}
