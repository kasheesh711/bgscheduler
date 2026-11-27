import { and, asc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { hiringBookings as bookings, hiringCandidates as candidates, hiringOutbox as outbox, hiringRecruitmentDeliveries as deliveries, hiringSettings, progressLineGroups } from "@/lib/db/schema";
import { progressUsesTutorBot } from "@/lib/line/progress-reminders";
import { fetchLineGroupSummary, pushLineTextMessage, replyLineMessage, LinePushError } from "@/lib/line/client";
import { isScheduleBotAdmin } from "@/lib/line/schedule-bot";
import { mentionedTheaText } from "@/lib/line/thea-query";
import { visitClashes } from "./head-schedule";
import { localDate, runtimeWritesAllowed, shiftDate, ZONE } from "./model";
import { storedResume } from "./resume-files";
import { audit, callResumeLink, settings } from "./service";

const GROUP_NAME = "BeGifted Recruitment";
// LINE notices go to staff in Bangkok, so times carry no zone label.
const hm = (date: Date) => date.toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
/** "Thu 5 Nov, 09:00" in Bangkok time. */
export const lineWhen = (date: Date) =>
  `${date.toLocaleDateString("en-GB", { timeZone: ZONE, weekday: "short", day: "numeric", month: "short" })}, ${hm(date)}`;
/** "Thu 5 Nov, 09:00–09:30". */
export const lineSlot = (start: Date, end: Date) => `${lineWhen(start)}–${hm(end)}`;
/** "Jane Doe · Mathematics", the first line after a notice's title. */
export const lineWho = (name: string, subjects: string) => `${name} · ${subjects || "Subject not recorded"}`;
/** One contact line: "jane@example.com · +66812345678". */
export const contactLine = (candidate: { email: string | null; phone: string | null }) =>
  [candidate.email, candidate.phone].filter(Boolean).join(" · ") || "No email or phone recorded";

/** LINE textV2 reads `{name}` as a placeholder: double every other brace (for example in a name), keep `{person}`. */
export const taggedText = (message: string) => message.replace(/[{}]/g, (c) => c + c).replaceAll("{{person}}", "{person}");

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

/**
 * "@Thea print setup": the sender becomes the person Thea tags in the 08:30 print message. Only in the connected
 * recruitment group, which holds staff only, so any member may take it over.
 */
async function receivePrintSetup(db: Database, raw: unknown) {
  const event = raw as { source?: { type?: string; groupId?: string; userId?: string }; replyToken?: string };
  const userId = event.source?.userId ?? "";
  if (event.source?.type !== "group" || !/^U[0-9a-f]{32}$/.test(userId) || !runtimeWritesAllowed()) return;
  const saved = await withDatabaseTransaction(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-settings'))`);
    const current = await settings(tx);
    if (!current.row || !current.config.recruitmentLineGroupId || current.config.recruitmentLineGroupId !== event.source!.groupId) return false;
    if (current.config.printLineUserId === userId) return true;
    await tx.update(hiringSettings).set({
      config: { ...current.config, printLineUserId: userId },
      revision: current.row.revision + 1, updatedBy: `line:${userId}`, updatedAt: new Date(),
    }).where(eq(hiringSettings.id, "default"));
    await audit(tx, `line:${userId}`, "recruitment-print-person", null, { userId });
    return true;
  });
  if (event.replyToken) await replyLineMessage({ tutorBot: true, replyToken: event.replyToken,
    text: saved ? "Done. At 08:30 on each day with paper tests, Thea will tag you here with one link to print all the papers."
      : `Use this command in ${GROUP_NAME} after it is connected.` });
}

export async function receiveRecruitmentSetup(db: Database, raw: unknown): Promise<boolean> {
  const command = mentionedTheaText(raw)?.toLowerCase();
  if (command === "print setup") { await receivePrintSetup(db, raw); return true; }
  if (command !== "recruitment setup") return false;
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
    text: "Connected. Thea will post hiring updates here: bookings, moves, cancellations and results. A summary comes every Monday at 09:00." });
  return true;
}

export async function enqueueRecruitmentLine(db: Database, key: string, groupId: string, text: string, bookingId: string | null, notice: string) {
  await db.insert(deliveries).values(recruitmentParts(text).map((message, index) => ({
    key: `${key}:${String(index).padStart(4, "0")}`, groupId, message, bookingId, notice,
  }))).onConflictDoNothing({ target: deliveries.key });
}

/** Mock and HR call notices. Called inside the booking transaction, so a rolled-back booking cannot send a notice. */
export async function queueRecruitmentMock(db: Database, booking: typeof bookings.$inferSelect,
  notice: "booked" | "moved" | "cancelled", movedFrom?: Date) {
  if (booking.kind !== "mock" && booking.kind !== "call") return;
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  const [candidate] = await db.select({ name: candidates.name, email: candidates.email, phone: candidates.phone,
    resumePath: candidates.resumePath, resumeType: candidates.resumeType }).from(candidates).where(eq(candidates.id, booking.candidateId));
  if (!candidate) throw new Error(`The ${booking.kind} candidate is missing.`);
  const time = lineSlot(booking.startTime, booking.endTime);
  const was = movedFrom ? `\nOld time (cancelled): ${lineWhen(movedFrom)}` : "";
  const who = lineWho(candidate.name, booking.subjects.join(", "));
  if (booking.kind === "call") {
    await enqueueRecruitmentLine(db, `call:${booking.id}:${notice}`, config.recruitmentLineGroupId,
      `${notice === "cancelled" ? "❌" : "📞"} HR call ${notice}\n${who}\n${time} · Google Meet${was}\n${contactLine(candidate)}\nRésumé: ${
        storedResume(booking.candidateId, candidate.resumePath, candidate.resumeType) ? callResumeLink(booking) : "no file. See the Hiring page."}`,
      booking.id, notice);
    return;
  }
  const text = `${notice === "cancelled" ? "❌" : "🧑‍🏫"} Mock teaching ${notice}\n${who}\n${time} · Head: ${booking.interviewerKey ?? "to be confirmed"}${was}\n${contactLine(candidate)}`;
  await enqueueRecruitmentLine(db, `mock:${booking.id}:${notice}`, config.recruitmentLineGroupId, text, booking.id, notice);
}

/** A head's decision after a mock. HR prepares the review for a Yes recommendation. One notice for each recorded decision. */
export async function queueRecruitmentHeadDecision(db: Database, candidate: { id: string; name: string }, input: { decision: "hire" | "reject"; reason: string; head: string; subject: string | null; key: string; offerSent?: boolean }) {
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  await enqueueRecruitmentLine(db, `head-decision:${input.key}`, config.recruitmentLineGroupId,
    `${input.decision === "hire" ? "✅ HIRE" : "❌ DO NOT HIRE"} · ${input.head}\n${lineWho(candidate.name, input.subject ?? "")}${input.reason ? `\nReason: ${input.reason}` : ""}\nNext: ${input.offerSent ? "the offer letter and contract-signing link are emailed." : input.decision === "hire" ? "Kevin adds the assessment and sends the packet to Gift." : "the rejection email is queued."}`,
    null, "head_decision");
}

/** Only a response to a sent application form reaches this hook. One notice per candidate. */
export async function queueRecruitmentForm(db: Database, candidate: Pick<typeof candidates.$inferSelect, "id" | "name" | "email" | "phone" | "subjects">, submittedAt: Date) {
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  await enqueueRecruitmentLine(db, `form-completed:${candidate.id}`, config.recruitmentLineGroupId,
    `📝 Form completed · ${lineWhen(submittedAt)}\n${lineWho(candidate.name, candidate.subjects.join(", "))}\n${contactLine(candidate)}`, null, "form_completed");
}

/** Called with the email's sent receipt in the same database transaction. */
export async function queueRecruitmentInvitation(db: Database, job: Pick<typeof outbox.$inferSelect, "id" | "key" | "kind" | "payload" | "bookingId">,
  candidate: typeof candidates.$inferSelect, sentAt: Date) {
  // Kevin, 25 Nov 2026: no LINE notice for a paper test invite; the mock teaching invite keeps its notice.
  if (job.kind !== "email" || job.bookingId || job.key.includes(":visit-reminder:") || !["paper_passed","mock_invited"].includes(String(job.payload.workflowStage))) return;
  const { config } = await settings(db);
  if (!config.recruitmentLineGroupId) return;
  await enqueueRecruitmentLine(db, `invite-sent:${job.id}`, config.recruitmentLineGroupId,
    `✉️ Mock invite sent · ${lineWhen(sentAt)}\n${lineWho(candidate.name, candidate.paperWaiver?.subject ?? candidate.paperPassedSubjects.join(", "))}\n${contactLine(candidate)}`, null, "invite_sent");
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
      .map(row => `• ${lineWho(row.name, row.subjects[0] ?? "")}`);
    const mockLines = mocks.map(({ name, booking: b }) => `• ${lineWhen(b.startTime)} · ${lineWho(name, b.subjects.join(", "))} · ${b.interviewerKey ?? "head to be confirmed"}`);
    await enqueueRecruitmentLine(tx, key, config.recruitmentLineGroupId,
      `📅 Hiring week of ${lineWhen(week.start).split(",")[0]}\n\nMocks this week (${mockLines.length})\n${mockLines.join("\n") || "None"}\n\nPre-screen invites sent last week (${sentLines.length})\n${sentLines.join("\n") || "None"}`, null, "weekly");
    return true;
  });
}

export async function queueRecruitmentDailyCalls(db: Database, now = new Date()) {
  if (!runtimeWritesAllowed()) return false;
  const date = localDate(now);
  const start = new Date(`${date}T00:00:00+07:00`);
  const end = new Date(`${shiftDate(date, 1)}T00:00:00+07:00`);
  const minute = (now.getTime() - start.getTime()) / 60000;
  // Hiring delivery runs at 08:59 Bangkok, with morning recovery ticks at 09:19, 09:35 and 09:48.
  if (minute < 8 * 60 + 59 || minute >= 9 * 60 + 50) return false;
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-recruitment-daily-calls'))`);
    const { config } = await settings(tx);
    if (!config.enabled || !config.deliveryEnabled || !config.recruitmentLineGroupId) return false;
    const key = `daily-calls:${date}`;
    const [exists] = await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.key, `${key}:0000`));
    if (exists) return false;
    const calls = await tx.select({ name: candidates.name, start: bookings.startTime }).from(bookings)
      .innerJoin(candidates, eq(bookings.candidateId, candidates.id))
      .where(and(eq(bookings.kind, "call"), eq(bookings.status, "confirmed"),
        gte(bookings.startTime, start), lt(bookings.startTime, end), sql`${bookings.endTime} > ${now.toISOString()}::timestamptz`))
      .orderBy(asc(bookings.startTime), asc(candidates.name));
    if (!calls.length) return false;
    const lines = calls.map((call) => `${hm(call.start)} ${call.name}`);
    const url = new URL("/hiring?view=hr", process.env.APP_BASE_URL || "https://bgscheduler.vercel.app");
    await enqueueRecruitmentLine(tx, key, config.recruitmentLineGroupId,
      `📞 HR calls today (${lines.length})\n${lines.join("\n")}\n\nOpen: ${url}`, null, "daily-calls");
    return true;
  });
}

/**
 * Once a day in the morning tick, warns the recruitment group about booked mocks that now overlap the head's Wise
 * class, leave or sit-in (the dashboard's clash rule), or that could not be checked. Nothing is queued on a clean day.
 */
export async function queueRecruitmentMockClashes(db: Database, now = new Date()) {
  if (!runtimeWritesAllowed()) return false;
  const date = localDate(now);
  const minute = (now.getTime() - new Date(`${date}T00:00:00+07:00`).getTime()) / 60000;
  if (minute < 8 * 60 + 59 || minute >= 9 * 60 + 50) return false;
  const { config } = await settings(db);
  if (!config.enabled || !config.deliveryEnabled || !config.recruitmentLineGroupId) return false;
  const key = `mock-clashes:${date}`;
  const [done] = await db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.key, `${key}:0000`));
  if (done) return false;
  const mocks = await db.select({ name: candidates.name, booking: bookings }).from(bookings)
    .innerJoin(candidates, eq(bookings.candidateId, candidates.id))
    .where(and(eq(bookings.kind, "mock"), eq(bookings.status, "confirmed"), sql`${bookings.endTime} > ${now.toISOString()}::timestamptz`))
    .orderBy(asc(bookings.startTime), asc(candidates.name));
  // The Wise read runs outside the transaction: it can build the search index, which must not hold the lock.
  const check = await visitClashes(db, mocks.map((m) => ({ ...m.booking, kind: "mock" as const })), now);
  const ids = new Set(check.bookingIds);
  const lines = mocks.filter((m) => ids.has(m.booking.id)).map(({ name, booking: b }) =>
    `• ${lineSlot(b.startTime, b.endTime)} · ${lineWho(name, b.subjects.join(", "))} · Head: ${b.interviewerKey}`);
  if (!lines.length && !check.stale) return false;
  const url = new URL("/hiring?view=heads", process.env.APP_BASE_URL || "https://bgscheduler.vercel.app");
  const text = [
    lines.length ? `⚠️ Mock teaching clashes with Wise (${lines.length})\n${lines.join("\n")}\n\nMove the mock or the Wise class.` : "",
    check.stale ? "⚠️ Some mocks could not be checked against Wise today (old Wise data or a head not found). Check the head calendar." : "",
  ].filter(Boolean).join("\n\n");
  return withDatabaseTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hiring-recruitment-mock-clashes'))`);
    const [exists] = await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.key, `${key}:0000`));
    if (exists) return false;
    await enqueueRecruitmentLine(tx, key, config.recruitmentLineGroupId!, `${text}\n\nOpen: ${url}`, null, "mock-clashes");
    return true;
  });
}

export async function deliverRecruitment(db: Database, now = new Date()) {
  if (!runtimeWritesAllowed()) return 0;
  const { config } = await settings(db);
  // No recruitment group is not a stop: a paper check goes to the head's own group.
  if (!config.enabled || !config.deliveryEnabled) return 0;
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
      const expiredDigest = (row.notice === "daily-calls" || row.notice === "print-pack" || row.notice === "mock-clashes") && !row.key.startsWith(`${row.notice}:${localDate(now)}:`);
      // A paper check goes to the head's own tutor group, so only a group switched off makes it obsolete.
      const [headGroup] = row.notice === "paper_check"
        ? await db.select().from(progressLineGroups).where(and(eq(progressLineGroups.groupId, row.groupId), eq(progressLineGroups.enabled, true)))
        : [];
      const wrongGroup = row.notice === "paper_check" ? !headGroup : row.groupId !== latest.recruitmentLineGroupId;
      const obsolete = expiredDigest || wrongGroup || (row.bookingId && (!booking ||
        (row.notice !== "cancelled" && (booking.status !== "confirmed" || booking.endTime <= now))));
      if (obsolete || (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() >= 23 * 3600000)) {
        await db.update(deliveries).set({ status: obsolete && !(expiredDigest && row.firstAttemptAt) ? "cancelled" : "uncertain", leaseUntil: null,
          error: expiredDigest ? `The date of the ${row.notice === "print-pack" ? "print message" : row.notice === "mock-clashes" ? "clash warning" : "call digest"} passed.` : obsolete ? "The booking or recruitment group changed." : "Retry window expired. Check delivery before resending." }).where(eq(deliveries.id, row.id));
        continue;
      }
      // The print message tags the saved person. Without one, or when LINE refuses the tag (the person left the
      // group), it names Aya in plain text. textV2 reads other braces as placeholders, so they are doubled.
      const tag = row.notice === "print-pack" ? latest.printLineUserId : null;
      const plain = row.notice === "print-pack" ? row.message.replaceAll("{person}", "@Aya") : row.message;
      const tagged = taggedText(row.message);
      const tutorBot = headGroup ? progressUsesTutorBot(headGroup.canonicalKey, headGroup.tutorBot) : true;
      const push = (text: string, mentionUserId?: string) => pushLineTextMessage({ to: row.groupId, text, mentionUserId, retryKey: row.id, tutorBot, signal: AbortSignal.timeout(20000) });
      const receipt = tag
        ? await push(tagged, tag).catch((error) => { if (error instanceof LinePushError && error.status === 400) return push(plain); throw error; })
        : await push(plain);
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
