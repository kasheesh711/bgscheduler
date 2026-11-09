import { and, asc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { hiringBookings as bookings, hiringCandidates as candidates, hiringOutbox as outbox, hiringRecruitmentDeliveries as deliveries, hiringSettings } from "@/lib/db/schema";
import { fetchLineGroupSummary, pushLineTextMessage, replyLineMessage, LinePushError } from "@/lib/line/client";
import { isScheduleBotAdmin } from "@/lib/line/schedule-bot";
import { mentionedTheaText } from "@/lib/line/thea-query";
import { runtimeWritesAllowed, ZONE } from "./model";
import { audit, settings } from "./service";

const GROUP_NAME = "BeGifted Recruitment";
const when = (date: Date) => date.toLocaleString("en-GB", { timeZone: ZONE, dateStyle: "medium", timeStyle: "short" });

/** LINE limits each text message to 5,000 UTF-16 units. Leave space for the part number. */
export function recruitmentParts(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  for (const character of text) {
    if (part.length + character.length > 4500) { parts.push(part); part = ""; }
    part += character;
  }
  if (part) parts.push(part);
  return parts.map((value, index) => parts.length > 1 ? `(${index + 1}/${parts.length})\n${value}` : value);
}

export async function receiveRecruitmentSetup(db: Database, raw: unknown): Promise<boolean> {
  if (mentionedTheaText(raw)?.toLowerCase() !== "recruitment setup") return false;
  const event = raw as { source?: { type?: string; groupId?: string; userId?: string }; replyToken?: string };
  if (event.source?.type !== "group" || !/^C[0-9a-f]{32}$/.test(event.source.groupId ?? "")
    || !isScheduleBotAdmin(event.source.userId ?? "") || !runtimeWritesAllowed()) return true;
  const group = await fetchLineGroupSummary(event.source.groupId!, true);
  if (group.groupName !== GROUP_NAME) {
    if (event.replyToken) await replyLineMessage({ tutorBot: true, replyToken: event.replyToken, text: `Use this command in ${GROUP_NAME}.` });
    return true;
  }
  await withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-settings'))`);
    const current = await settings(tx);
    if (!current.row) throw new Error("Hiring settings are missing.");
    if (current.config.recruitmentLineGroupId === group.groupId) return;
    await tx.update(hiringSettings).set({
      config: { ...current.config, recruitmentLineGroupId: group.groupId },
      revision: current.row.revision + 1, updatedBy: `line:${event.source!.userId}`, updatedAt: new Date(),
    }).where(eq(hiringSettings.id, "default"));
    await audit(tx, `line:${event.source!.userId}`, "recruitment-group", null, group);
  });
  if (event.replyToken) await replyLineMessage({ tutorBot: true, replyToken: event.replyToken,
    text: "Thea recruitment notices are connected. Mock bookings, changes and cancellations will appear here. The weekly summary is sent on Mondays at 09:00 Bangkok." });
  return true;
}

async function enqueue(db: Database, key: string, groupId: string, text: string, bookingId: string | null, notice: string) {
  await db.insert(deliveries).values(recruitmentParts(text).map((message, index) => ({
    key: `${key}:${String(index).padStart(4, "0")}`, groupId, message, bookingId, notice,
  }))).onConflictDoNothing({ target: deliveries.key });
}

/** Called inside the booking transaction, so a rolled-back booking cannot send a notice. */
export async function queueRecruitmentMock(db: Database, booking: typeof bookings.$inferSelect,
  notice: "booked" | "moved" | "cancelled", movedFrom?: Date) {
  if (booking.kind !== "mock") return;
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  const [candidate] = await db.select({ name: candidates.name }).from(candidates).where(eq(candidates.id, booking.candidateId));
  if (!candidate) throw new Error("The mock candidate is missing.");
  const text = `Mock teaching ${notice}\nCandidate: ${candidate.name}\nSubject: ${booking.subjects.join(", ")}\nInterviewer: ${booking.interviewerKey ?? "To be confirmed"}\nTime: ${when(booking.startTime)}–${booking.endTime.toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" })} (Bangkok)\nPlace: ${config.location}${movedFrom ? `\nPrevious time: ${when(movedFrom)} (cancelled)` : ""}`;
  await enqueue(db, `mock:${booking.id}:${notice}`, config.recruitmentLineGroupId, text, booking.id, notice);
}

/** Only a response to a sent application form reaches this hook. One notice per candidate. */
export async function queueRecruitmentForm(db: Database, candidate: Pick<typeof candidates.$inferSelect, "id" | "name" | "subjects">, submittedAt: Date) {
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  await enqueue(db, `form-completed:${candidate.id}`, config.recruitmentLineGroupId,
    `Form completed\n${candidate.name} — ${candidate.subjects.join(", ") || "Subject not recorded"}\n${when(submittedAt)} (Bangkok)`, null, "form_completed");
}

/** Called with the email's sent receipt in the same database transaction. */
export async function queueRecruitmentInvitation(db: Database, job: typeof outbox.$inferSelect,
  candidate: typeof candidates.$inferSelect, sentAt: Date) {
  if (job.kind !== "email" || job.bookingId || job.key.includes(":visit-reminder:")
    || !["onsite_invited", "paper_passed"].includes(String(job.payload.workflowStage))) return;
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  const subject = job.payload.workflowStage === "paper_passed" ? candidate.paperPassedSubjects.join(", ")
    : candidate.visitSubject ?? candidate.subjects.join(", ");
  await enqueue(db, `invite-sent:${job.id}`, config.recruitmentLineGroupId,
    `Mock trial invite sent\n${candidate.name} — ${subject || "Subject not recorded"}\n${when(sentAt)} (Bangkok)`, null, "invite_sent");
}

export function recruitmentWeek(now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = new Date(`${date}T00:00:00+07:00`);
  if (start.getUTCDay() !== 0 || date < "2026-11-16" || now.getTime() < start.getTime() + 9 * 3600000) return null;
  return { date, start, previous: new Date(start.getTime() - 7 * 86400000), end: new Date(start.getTime() + 7 * 86400000) };
}

export async function queueRecruitmentWeekly(db: Database, now = new Date()) {
  const week = recruitmentWeek(now);
  if (!week || !runtimeWritesAllowed()) return false;
  return withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-recruitment-weekly'))`);
    const { config } = await settings(tx);
    if (!config.enabled || !config.deliveryEnabled || !config.recruitmentLineGroupId) return false;
    const key = `weekly:${week.date}`;
    const [exists] = await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.key, `${key}:0000`));
    if (exists) return false;
    const sent = await tx.select({ id: candidates.id, name: candidates.name, subjects: candidates.subjects, sentAt: outbox.sentAt })
      .from(outbox).innerJoin(candidates, eq(outbox.candidateId, candidates.id))
      .where(and(eq(outbox.kind, "email"), eq(outbox.status, "sent"), sql`${outbox.key} = ${candidates.id}::text || ':pre-screen'`,
        gte(outbox.sentAt, week.previous), lt(outbox.sentAt, week.start))).orderBy(asc(outbox.sentAt), asc(candidates.name));
    const mocks = await tx.select({ name: candidates.name, booking: bookings }).from(bookings)
      .innerJoin(candidates, eq(bookings.candidateId, candidates.id))
      .where(and(eq(bookings.kind, "mock"), eq(bookings.status, "confirmed"), gte(bookings.startTime, week.start), lt(bookings.startTime, week.end)))
      .orderBy(asc(bookings.startTime));
    const seen = new Set<string>();
    const sentLines = sent.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; })
      .map(row => `${row.name} — ${row.subjects[0] ?? "Subject not recorded"} — sent ${when(row.sentAt!)}`);
    const mockLines = mocks.map(({ name, booking: b }) => `${name} — ${b.subjects.join(", ")} — ${b.interviewerKey ?? "To be confirmed"} — ${when(b.startTime)}–${b.endTime.toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" })}`);
    await enqueue(tx, key, config.recruitmentLineGroupId,
      `Recruitment summary — week of ${week.date} (Bangkok)\n\nPre-screen invitations sent in the previous week (${sentLines.length})\n${sentLines.join("\n") || "None"}\n\nMocks this week (${mockLines.length})\n${mockLines.join("\n") || "None"}`, null, "weekly");
    return true;
  });
}

export async function deliverRecruitment(db: Database, now = new Date()) {
  if (!runtimeWritesAllowed()) return 0;
  const { config } = await settings(db);
  if (!config.enabled || !config.deliveryEnabled || !config.recruitmentLineGroupId) return 0;
  // Expired leases retain their retry key. LINE only remembers retry keys for 24 hours.
  await db.update(deliveries).set({ status: "retry", leaseUntil: null })
    .where(and(eq(deliveries.status, "sending"), lte(deliveries.leaseUntil, now)));
  const rows = await db.select().from(deliveries).where(and(or(eq(deliveries.status, "pending"), eq(deliveries.status, "retry")),
    lte(deliveries.nextAttemptAt, now))).orderBy(asc(deliveries.createdAt), asc(deliveries.key)).limit(20);
  let sent = 0;
  for (const row of rows) {
    const [claimed] = await db.update(deliveries).set({ status: "sending", leaseUntil: new Date(now.getTime() + 120000),
      firstAttemptAt: row.firstAttemptAt ?? now, attempts: row.attempts + 1 }).where(and(eq(deliveries.id, row.id), eq(deliveries.status, row.status))).returning();
    if (!claimed) continue;
    try {
      const latest = (await settings(db)).config;
      if (!runtimeWritesAllowed() || !latest.enabled || !latest.deliveryEnabled) {
        await db.update(deliveries).set({ status: "pending", leaseUntil: null }).where(eq(deliveries.id, row.id));
        break;
      }
      const [booking] = row.bookingId ? await db.select().from(bookings).where(eq(bookings.id, row.bookingId)) : [];
      const obsolete = row.groupId !== latest.recruitmentLineGroupId || (row.bookingId && (!booking ||
        (row.notice !== "cancelled" && (booking.status !== "confirmed" || booking.endTime <= now))));
      if (obsolete || (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() >= 23 * 3600000)) {
        await db.update(deliveries).set({ status: obsolete ? "cancelled" : "uncertain", leaseUntil: null,
          error: obsolete ? "The booking or recruitment group changed." : "Retry window expired. Check delivery before resending." }).where(eq(deliveries.id, row.id));
        continue;
      }
      const receipt = await pushLineTextMessage({ to: row.groupId, text: row.message, retryKey: row.id, tutorBot: true, signal: AbortSignal.timeout(20000) });
      await db.update(deliveries).set({ status: "sent", receipt: { ...receipt }, sentAt: new Date(), leaseUntil: null, error: null }).where(eq(deliveries.id, row.id));
      sent++;
    } catch (error) {
      const permanent = error instanceof LinePushError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      await db.update(deliveries).set({ status: permanent ? "failed" : "retry", leaseUntil: null,
        nextAttemptAt: new Date(now.getTime() + Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)) * 1000),
        error: error instanceof Error ? error.message.slice(0, 300) : "Recruitment delivery failed." }).where(eq(deliveries.id, row.id));
    }
  }
  return sent;
}
