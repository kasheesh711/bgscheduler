import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { configSchema } from "../model";
import { deliverRecruitment, queueRecruitmentForm, queueRecruitmentMock, queueRecruitmentWeekly, receiveRecruitmentSetup } from "../recruitment";
import { fetchLineGroupSummary, pushLineTextMessage, replyLineMessage } from "@/lib/line/client";
import { deliverOutbox } from "../worker";
import { createOutboundEmailSender } from "@/lib/email/outbound";
import { queueRecruitmentInvitation } from "../recruitment";
import { endVisit } from "../service";

vi.mock("@/lib/email/outbound", () => ({ createOutboundEmailSender: vi.fn() }));
vi.mock("@/lib/line/client", () => ({
  fetchLineGroupSummary: vi.fn(), pushLineTextMessage: vi.fn(), replyLineMessage: vi.fn(),
  LinePushError: class extends Error { status = 500; },
}));
let handle: Awaited<ReturnType<typeof startTestDb>>, db: Database;
const groupId = "C" + "1".repeat(32), userId = "U" + "2".repeat(32);
const now = new Date("2026-11-16T09:00:00+07:00");
const config = configSchema.parse({ enabled: true, deliveryEnabled: true, recruitmentLineGroupId: groupId });
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  vi.stubEnv("HIRING_WRITES_ENABLED", "true"); vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("LINE_SCHEDULE_BOT_ADMIN_IDS", userId); vi.clearAllMocks();
  vi.mocked(fetchLineGroupSummary).mockResolvedValue({ groupId, groupName: "BeGifted Recruitment" });
  vi.mocked(pushLineTextMessage).mockResolvedValue({ retryKey: "key", sentMessageId: "message", response: {} });
  await db.execute(sql`truncate hiring_recruitment_deliveries,hiring_outbox,hiring_bookings,hiring_candidates,hiring_settings,hiring_audit cascade`);
  await db.insert(s.hiringSettings).values({ config, updatedBy: "test" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function candidate(name = "Candidate", email: string | null = `${name.toLowerCase().replace(/\W/g, "")}@example.com`) {
  const [row] = await db.insert(s.hiringCandidates).values({ name, email, subjects: ["Mathematics"] }).returning(); return row;
}
async function mock() {
  const c = await candidate();
  const [row] = await db.insert(s.hiringBookings).values({ candidateId: c.id, kind: "mock", subjects: ["Mathematics"],
    interviewerKey: "Peat", interviewerEmail: "peat@example.com", lineGroupId: groupId, calendarOwner: "owner@example.com", startTime: new Date("2026-11-17T10:00:00+07:00"),
    endTime: new Date("2026-11-17T11:00:00+07:00"), evidence: {} }).returning(); return row;
}
it("requires an admin in the exact group, then binds without changing hiring switches", async () => {
  const event = { type: "message", source: { type: "group", groupId, userId }, message: { type: "text", text: "@Thea recruitment setup" }, replyToken: "reply" };
  await receiveRecruitmentSetup(db, { ...event, source: { ...event.source, userId: "unknown" } });
  expect(fetchLineGroupSummary).not.toHaveBeenCalled();
  vi.mocked(fetchLineGroupSummary).mockResolvedValueOnce({ groupId, groupName: "Family" });
  await receiveRecruitmentSetup(db, event);
  expect((await db.select().from(s.hiringAudit))).toHaveLength(0);
  await db.update(s.hiringSettings).set({ config: { ...config, recruitmentLineGroupId: null, enabled: false } });
  await receiveRecruitmentSetup(db, event);
  const [saved] = await db.select().from(s.hiringSettings);
  expect(saved.config.recruitmentLineGroupId).toBe(groupId); expect(saved.config.enabled).toBe(false);
  expect(replyLineMessage).toHaveBeenLastCalledWith(expect.objectContaining({ tutorBot: true, replyToken: "reply" }));
});
it("queues each mock notice once and suppresses a cancelled booking's old notice", async () => {
  const b = await mock();
  await queueRecruitmentMock(db, b, "booked"); await queueRecruitmentMock(db, b, "booked");
  expect(await deliverRecruitment(db)).toBe(1);
  expect(await deliverRecruitment(db)).toBe(0);
  expect(pushLineTextMessage).toHaveBeenCalledWith(expect.objectContaining({ to: groupId, tutorBot: true, text: expect.stringContaining("Candidate: Candidate\nEmail: candidate@example.com\nPhone: not recorded\nSubject") }));
  await queueRecruitmentMock(db, b, "moved", new Date("2026-11-16T10:00:00+07:00"));
  await endVisit(db, [b], "cancelled", now);
  expect(await deliverRecruitment(db)).toBe(1);
  expect(vi.mocked(pushLineTextMessage).mock.calls.at(-1)?.[0].text).toContain("cancelled");
  const rows = await db.select().from(s.hiringRecruitmentDeliveries);
  expect(rows.find(row => row.notice === "moved")?.status).toBe("cancelled");
});
it("retries with the same key and stops uncertain sends after the retry window", async () => {
  const b = await mock(); await queueRecruitmentMock(db, b, "booked");
  vi.mocked(pushLineTextMessage).mockRejectedValueOnce(new Error("connection lost"));
  expect(await deliverRecruitment(db)).toBe(0);
  const first = vi.mocked(pushLineTextMessage).mock.calls[0][0].retryKey;
  vi.setSystemTime(new Date(now.getTime() + 120000));
  expect(await deliverRecruitment(db, new Date())).toBe(1);
  expect(vi.mocked(pushLineTextMessage).mock.calls[1][0].retryKey).toBe(first);
  await queueRecruitmentMock(db, b, "moved", now);
  await db.update(s.hiringRecruitmentDeliveries).set({ firstAttemptAt: new Date(now.getTime() - 24 * 3600000) }).where(eq(s.hiringRecruitmentDeliveries.notice, "moved"));
  expect(await deliverRecruitment(db, new Date())).toBe(0);
  expect((await db.select().from(s.hiringRecruitmentDeliveries).where(eq(s.hiringRecruitmentDeliveries.notice, "moved")))[0].status).toBe("uncertain");
});
it("reports only initial sent invitations in the prior week and confirmed mocks this week", async () => {
  for (const [name, status, suffix, sentAt] of [
    ["Included", "sent", "pre-screen", "2026-11-09T00:00:00+07:00"],
    ["Reminder", "sent", "pre-screen-reminder", "2026-11-10T10:00:00+07:00"],
    ["Failed", "failed", "pre-screen", "2026-11-10T10:00:00+07:00"],
    ["Uncertain", "uncertain", "pre-screen", "2026-11-10T10:00:00+07:00"],
    ["Too late", "sent", "pre-screen", "2026-11-16T00:00:00+07:00"],
  ] as const) {
    const c = await candidate(name);
    await db.insert(s.hiringOutbox).values({ candidateId: c.id, key: `${c.id}:${suffix}`, kind: "email", payload: {}, status, sentAt: new Date(sentAt) });
  }
  await mock();
  expect(await queueRecruitmentWeekly(db, now)).toBe(true); expect(await queueRecruitmentWeekly(db, now)).toBe(false);
  const [row] = await db.select().from(s.hiringRecruitmentDeliveries);
  expect(row.message).toContain("Included — Mathematics"); expect(row.message).toContain("Mocks this week (1)");
  for (const excluded of ["Reminder", "Failed", "Uncertain", "Too late"]) expect(row.message).not.toContain(excluded);
});
it("shows None for empty sections and sends nothing when paused or the group changes", async () => {
  await queueRecruitmentWeekly(db, now);
  const [row] = await db.select().from(s.hiringRecruitmentDeliveries);
  expect(row.message.match(/None/g)).toHaveLength(2);
  await db.update(s.hiringSettings).set({ config: { ...config, deliveryEnabled: false } });
  expect(await deliverRecruitment(db)).toBe(0);
  await db.update(s.hiringSettings).set({ config: { ...config, recruitmentLineGroupId: "C" + "3".repeat(32) } });
  expect(await deliverRecruitment(db)).toBe(0); expect(pushLineTextMessage).not.toHaveBeenCalled();
});

it("announces an invitation only after Gmail accepts it, once across delivery retries", async () => {
  const c = await candidate();
  await db.update(s.hiringCandidates).set({ stage: "onsite_invited", visitSubject: "Mathematics" }).where(eq(s.hiringCandidates.id, c.id));
  await db.insert(s.hiringOutbox).values({ candidateId: c.id, key: `${c.id}:visit-invite`, kind: "email",
    payload: { workflowStage: "onsite_invited", to: "candidate@example.com", subject: "Onsite invite", text: "Book your visit" } });
  const send = vi.fn().mockRejectedValueOnce(new Error("Connection lost"));
  vi.mocked(createOutboundEmailSender).mockReturnValue({ sendEmail: send });
  await deliverOutbox(db, config);
  expect(await db.select().from(s.hiringRecruitmentDeliveries)).toHaveLength(0);
  const [uncertain] = await db.select().from(s.hiringOutbox);
  expect(uncertain.status).toBe("uncertain");
  // A person confirms it was not sent before allowing a retry.
  await db.update(s.hiringOutbox).set({ status: "pending", nextAttemptAt: null }).where(eq(s.hiringOutbox.id, uncertain.id));
  send.mockResolvedValue({ id: "gmail-receipt" });
  await deliverOutbox(db, config);
  await deliverOutbox(db, config);
  const notices = await db.select().from(s.hiringRecruitmentDeliveries);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ notice: "invite_sent", message: expect.stringContaining("Mock trial invite sent") });
  expect(notices[0].message).toContain("Email: candidate@example.com");
  expect((await db.select().from(s.hiringOutbox))[0].status).toBe("sent");
  expect(send).toHaveBeenCalledTimes(2);
});
it("puts the email and the phone in the form notice, or says that none is recorded", async () => {
  const withPhone = await candidate("With");
  await queueRecruitmentForm(db, { ...withPhone, phone: "+66812345678" }, now);
  await queueRecruitmentForm(db, await candidate("Without", null), now);
  const messages = (await db.select().from(s.hiringRecruitmentDeliveries)).map(row => row.message);
  expect(messages).toContainEqual(expect.stringContaining("Form completed\nWith — Mathematics\nEmail: with@example.com\nPhone: +66812345678\n"));
  expect(messages).toContainEqual(expect.stringContaining("Without — Mathematics\nEmail: not recorded\nPhone: not recorded\n"));
});
it("recognizes old mock invitations but excludes reminders and booking confirmations", async () => {
  const c = await candidate();
  c.paperPassedSubjects = ["Mathematics"];
  for (const [key, workflowStage, bookingId] of [
    ["tracker-mock:hash", "paper_passed", null],
    ["visit-reminder:1", "onsite_invited", null],
    ["booking-confirmation", undefined, "00000000-0000-4000-8000-000000000001"],
    ["pre-screen", "pre_screen", null],
  ] as const) {
    await queueRecruitmentInvitation(db, { id: key, key: `${c.id}:${key}`, kind: "email", payload: { workflowStage }, bookingId }, c, now);
  }
  const notices = await db.select().from(s.hiringRecruitmentDeliveries);
  expect(notices).toHaveLength(1);
  expect(notices[0].message).toContain("Mathematics");
});
