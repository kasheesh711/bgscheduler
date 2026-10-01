import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import { seedPayoutAssessment } from "@/tests/integration/payout-fixtures";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { runNightlyReminders, resolveNightlyUnknown } from "../nightly-reminders";
import { loadNightlyReminderHealth } from "../nightly-reminder-health";
import { nightlyWindow } from "../nightly-reminder-model";
import { updatePostClassSettings } from "../settings";
import { encryptToken } from "@/lib/sales-dashboard/google-oauth";
import { GmailRejection, GMAIL_SEND_SCOPE, FEEDBACK_MAILBOX } from "../gmail";
import { ScheduleEmailRejection } from "@/lib/classrooms/schedule-email";

let handle: Awaited<ReturnType<typeof startTestDb>>;
const now = new Date("2026-09-29T15:00:00Z");
const db = () => handle.db as unknown as Database;
beforeAll(async () => { handle = await startTestDb(); }, 120_000);
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
  await handle.db.execute(sql`truncate table post_class_notification_runs cascade`);
  await handle.db.delete(schema.postClassReminderWorker);
  await handle.db.delete(schema.postClassSettings);
  await handle.db.insert(schema.postClassSettings).values({ id: "default", enforcementMode: "live", policyEffectiveAt: new Date("2026-08-26"), formMappingValid: true,
    reminderMode: "live", reminderStartedAt: new Date("2026-09-28T16:00:00Z"), reminderActivatedAt: new Date("2026-09-28T16:00:00Z") });
});

async function seed(name = "Buzz", hasEmail = true, wiseId = randomUUID()) {
  await handle.db.insert(schema.tutorContacts).values({ canonicalKey: name, displayName: name,
    primaryEmail: hasEmail ? `${name.toLowerCase()}@example.com` : null, active: true }).onConflictDoNothing();
  const [session] = await handle.db.insert(schema.postClassSessions).values({ wiseSessionId: wiseId, wiseClassId: "class-1",
    canonicalTutorKey: name, canonicalTutorName: name, scheduledStartAt: new Date("2026-09-29T10:00:00Z"),
    scheduledEndAt: new Date("2026-09-29T11:00:00Z"), deadlineAt: new Date("2026-10-01T16:59:59Z"),
    eligible: true, finalStatus: "ENDED", enforcementMode: "live", sourceStatus: "ready", sourceMetadata: { mappingVersion: 1 }, lastObservedAt: now }).returning();
  await seedPayoutAssessment(db(), session.id, { assessedAt: now });
  return session;
}

function dependencies(at = now) {
  const primary = { sendEmail: vi.fn().mockResolvedValue({ id: "accepted-primary" }) };
  const backup = { sendEmail: vi.fn().mockResolvedValue({ id: "accepted-backup" }) };
  return { db: db(), now: at, senders: { primary, backup }, refresh: vi.fn().mockResolvedValue(undefined),
    discover: vi.fn(async (date: string) => ({ items: [], pages: 1, checkedAt: at,
      startDate: nightlyWindow(date).startDate, endDate: nightlyWindow(date).endDate })) };
}

describe("durable nightly reminders", () => {
  it("groups a tutor's classes, freezes the exact membership and never appends late discoveries to sent mail", async () => {
    const first = await seed(); const second = await seed();
    const options = dependencies();
    expect((await runNightlyReminders(options)).ok).toBe(true);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
    await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
    const late = await seed();
    await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledTimes(2);
    const mail = await handle.db.select().from(schema.postClassNotificationDeliveries);
    expect(mail.map((m) => m.frozenContent!.sessionIds.length).sort()).toEqual([1, 2]);
    expect(mail.flatMap((m) => m.frozenContent!.sessionIds).sort()).toEqual([first.id, second.id, late.id].sort());
  });
  it("records missing recipients and source failures while other tutors receive their reminders", async () => {
    await seed(); await seed("NoEmail", false);
    const stale = await seed("Stale");
    await handle.db.update(schema.postClassSessions).set({ sourceStatus: "unavailable" }).where(eq(schema.postClassSessions.id, stale.id));
    const options = dependencies();
    expect((await runNightlyReminders(options)).ok).toBe(false);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
    const statuses = (await handle.db.select().from(schema.postClassReminderLedger)).map((r) => r.status).sort();
    expect(statuses).toEqual(["blocked_recipient", "blocked_source", "sent"]);
    expect((await loadNightlyReminderHealth(db(), new Date(now.getTime() + 31 * 60_000))).status).toBe("failing");
  });
  it("distinguishes real zero work from a failed inventory", async () => {
    const options = dependencies();
    expect((await runNightlyReminders(options)).ok).toBe(true);
    expect(options.senders.primary.sendEmail).not.toHaveBeenCalled();
    options.discover.mockRejectedValue(new Error("#REF! source unavailable"));
    expect((await runNightlyReminders(options)).ok).toBe(false);
    expect((await loadNightlyReminderHealth(db(), now)).status).toBe("failing");
  });
  it("refreshes stale feedback and suppresses a completed class", async () => {
    const session = await seed();
    await handle.db.update(schema.postClassSessions).set({ lastObservedAt: new Date("2026-09-28") }).where(eq(schema.postClassSessions.id, session.id));
    const options = dependencies();
    options.refresh.mockImplementation(async () => {
      await handle.db.update(schema.postClassSessions).set({ lastObservedAt: now }).where(eq(schema.postClassSessions.id, session.id));
      await seedPayoutAssessment(db(), session.id, { assessedAt: new Date(now.getTime() + 1), combinedRawCharCount: 350, fieldFailures: [] });
    });
    expect((await runNightlyReminders(options)).ok).toBe(true);
    expect(options.senders.primary.sendEmail).not.toHaveBeenCalled();
    expect((await handle.db.select().from(schema.postClassReminderLedger))[0].status).toBe("excluded");
  });
  it("keeps ambiguous timeouts unknown and blocks all automatic failover", async () => {
    await seed(); const options = dependencies();
    options.senders.primary.sendEmail.mockRejectedValue(new Error("timeout after acceptance"));
    await runNightlyReminders(options); await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
    expect(options.senders.backup.sendEmail).not.toHaveBeenCalled();
    const [delivery] = await handle.db.select().from(schema.postClassNotificationDeliveries);
    expect(delivery.status).toBe("unknown");
    await resolveNightlyUnknown({ deliveryId: delivery.id, expectedAttempt: 1, outcome: "accepted", receipt: "mailbox-message-id", note: "Verified in the sender's Sent mailbox." }, "admin@example.com", db());
    expect((await handle.db.select().from(schema.postClassReminderLedger))[0].status).toBe("sent");
    expect((await handle.db.select().from(schema.postClassConfigAuditLog))[0].action).toBe("resolve_accepted");
  });
  it("uses the backup only after a definite rejection and the retry delay", async () => {
    const session = await seed(); const options = dependencies();
    options.senders.primary.sendEmail.mockRejectedValue(new ScheduleEmailRejection("quota exhausted"));
    await runNightlyReminders(options);
    expect(options.senders.backup.sendEmail).not.toHaveBeenCalled();
    const later = new Date(now.getTime() + 31 * 60_000);
    await handle.db.update(schema.postClassSessions).set({ lastObservedAt: later }).where(eq(schema.postClassSessions.id, session.id));
    const next = dependencies(later); next.senders = options.senders;
    await runNightlyReminders(next);
    expect(options.senders.backup.sendEmail).toHaveBeenCalledOnce();
    expect(options.senders.backup.sendEmail.mock.calls[0][0].idempotencyKey).toBe(options.senders.primary.sendEmail.mock.calls[0][0].idempotencyKey);
  });
  it("keeps shadow and pause independent of enforcement and leaves existing deductions untouched", async () => {
    const session = await seed();
    await handle.db.insert(schema.postClassDeductions).values({ sessionId: session.id, status: "approved", amountMinor: 10000, defaultFinanceMonth: "2026-09-01" });
    const before = await handle.db.select().from(schema.postClassDeductions);
    await updatePostClassSettings({ email: "admin@example.com" }, { reminderMode: "shadow", expectedVersion: 1 }, db());
    const options = dependencies(); await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail).not.toHaveBeenCalled();
    expect((await handle.db.select().from(schema.postClassSettings))[0].enforcementMode).toBe("live");
    expect(await handle.db.select().from(schema.postClassDeductions)).toEqual(before);
    await updatePostClassSettings({ email: "admin@example.com" }, { reminderMode: "off", expectedVersion: 2 }, db());
    expect((await runNightlyReminders(options)).mode).toBe("off");
    expect(await handle.db.select().from(schema.postClassDeductions)).toEqual(before);
  });
  it("serializes concurrent workers", async () => {
    await seed(); const options = dependencies();
    await Promise.all([runNightlyReminders(options), runNightlyReminders(options)]);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
  });
  it("waits for known blocked siblings while unrelated tutors can proceed", async () => {
    await seed(); const blocked = await seed(); await seed("Other");
    await handle.db.update(schema.postClassSessions).set({ eligible: false, sourceStatus: "unavailable" }).where(eq(schema.postClassSessions.id, blocked.id));
    const options = dependencies();
    await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail.mock.calls.map((args) => args[0].to)).toEqual(["other@example.com"]);
    await handle.db.update(schema.postClassSessions).set({ eligible: true, sourceStatus: "ready" }).where(eq(schema.postClassSessions.id, blocked.id));
    await runNightlyReminders(options);
    const mail = await handle.db.select().from(schema.postClassNotificationDeliveries);
    expect(mail.find((m) => m.canonicalTutorKey === "Buzz")?.frozenContent?.sessionIds).toHaveLength(2);
  });
  it("refreshes untouched rows before permanent blockers on the next bounded run", async () => {
    for (let i = 0; i < 51; i++) {
      const row = await seed(`Tutor${i}`);
      await handle.db.update(schema.postClassSessions).set({ lastObservedAt: new Date("2026-09-28") }).where(eq(schema.postClassSessions.id, row.id));
    }
    const first = { ...dependencies(), maxRefreshBatches: 1 };
    await runNightlyReminders(first);
    const initial = new Set(first.refresh.mock.calls.flatMap((args) => (args[0] as Array<{ wiseSessionId: string }>).map((row) => row.wiseSessionId)));
    expect(initial.size).toBe(50);
    const next = { ...dependencies(new Date(now.getTime() + 30 * 60_000)), maxRefreshBatches: 1 };
    await runNightlyReminders(next);
    const nextIds = next.refresh.mock.calls[0][0] as Array<{ wiseSessionId: string }>;
    expect(initial.has(nextIds[0].wiseSessionId)).toBe(false);
  });
  it("keeps uncertain outcomes visible after date rotation and while paused", async () => {
    await seed(); const options = dependencies();
    options.senders.primary.sendEmail.mockRejectedValue(new Error("timeout"));
    await runNightlyReminders(options);
    const later = new Date("2026-10-04T15:31:00Z");
    await runNightlyReminders(dependencies(later));
    expect((await loadNightlyReminderHealth(db(), later)).unresolvedDeliveries).toBe(1);
    expect((await loadNightlyReminderHealth(db(), later)).status).toBe("failing");
    await handle.db.update(schema.postClassSettings).set({ reminderMode: "off" });
    expect((await loadNightlyReminderHealth(db(), later)).status).toBe("failing");
  });
  it("reconciles interrupted sending attempts even when reminders are off", async () => {
    await seed(); const options = dependencies();
    await runNightlyReminders(options);
    const [mail] = await handle.db.select().from(schema.postClassNotificationDeliveries);
    await handle.db.update(schema.postClassNotificationDeliveries).set({ status: "sending", updatedAt: new Date(now.getTime() - 16 * 60_000) }).where(eq(schema.postClassNotificationDeliveries.id, mail.id));
    await handle.db.update(schema.postClassReminderLedger).set({ status: "queued" });
    await handle.db.update(schema.postClassSettings).set({ reminderMode: "off" });
    await runNightlyReminders(options);
    expect((await handle.db.select().from(schema.postClassNotificationDeliveries))[0].status).toBe("unknown");
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
  });
  it("never retries after acceptance persistence fails", async () => {
    await seed(); const options = dependencies();
    await handle.db.execute(sql`create function nightly_fail_receipt() returns trigger language plpgsql as $$ begin if NEW.status = 'sent' then raise exception 'receipt store unavailable'; end if; return NEW; end $$`);
    await handle.db.execute(sql`create trigger nightly_fail_receipt before update on post_class_notification_deliveries for each row execute function nightly_fail_receipt()`);
    try {
      await runNightlyReminders(options); await runNightlyReminders(options);
      expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
      expect(options.senders.backup.sendEmail).not.toHaveBeenCalled();
      expect((await handle.db.select().from(schema.postClassNotificationDeliveries))[0].status).toBe("unknown");
    } finally {
      await handle.db.execute(sql`drop trigger nightly_fail_receipt on post_class_notification_deliveries`);
      await handle.db.execute(sql`drop function nightly_fail_receipt()`);
    }
  });
  it("requires fresh policy versions and rejects shadow preview in live mode", async () => {
    const session = await seed(); const options = dependencies();
    await expect(runNightlyReminders({ ...options, shadowPreview: true })).rejects.toThrow(/shadow mode/);
    await handle.db.update(schema.postClassSettings).set({ formMappingVersion: 2 });
    await runNightlyReminders(options);
    expect(options.refresh).toHaveBeenCalled();
    expect(options.senders.primary.sendEmail).not.toHaveBeenCalled();
    await handle.db.update(schema.postClassSessions).set({ sourceMetadata: { mappingVersion: 2 } }).where(eq(schema.postClassSessions.id, session.id));
    await seedPayoutAssessment(db(), session.id, { mappingVersion: 2, assessedAt: new Date(now.getTime() + 1) });
    await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
  });
  it("reuses the same nightly batch after Bangkok midnight and expires missed deadlines", async () => {
    const session = await seed(); const options = dependencies();
    options.senders.primary.sendEmail.mockRejectedValue(new ScheduleEmailRejection("quota"));
    const first = await runNightlyReminders(options);
    const midnight = new Date("2026-09-29T18:00:00Z");
    await handle.db.update(schema.postClassSessions).set({ lastObservedAt: midnight }).where(eq(schema.postClassSessions.id, session.id));
    const after = dependencies(midnight); after.senders = options.senders;
    const second = await runNightlyReminders(after);
    expect("runId" in second && second.runId).toBe("runId" in first && first.runId);
    expect(options.senders.backup.sendEmail).toHaveBeenCalledOnce();
  });
  it("detects coverage gaps independently of worker completion", async () => {
    const options = dependencies(); await runNightlyReminders(options);
    await seed("Later");
    const health = await loadNightlyReminderHealth(db(), new Date(now.getTime() + 31 * 60_000));
    expect(health.coverageGaps).toBe(1); expect(health.status).toBe("failing");
  });

  it("regroups newly found classes before the first dispatch attempt", async () => {
    await seed(); const options = dependencies(); await runNightlyReminders(options);
    const [queued] = await handle.db.select().from(schema.postClassNotificationDeliveries);
    // Fixture represents a worker interruption after planning, before its first attempt.
    await handle.db.delete(schema.postClassNotificationAttempts);
    await handle.db.update(schema.postClassNotificationDeliveries).set({ status: "pending", attemptCount: 0, sentAt: null,
      providerMessageId: null, nextAttemptAt: now }).where(eq(schema.postClassNotificationDeliveries.id, queued.id));
    await handle.db.update(schema.postClassReminderLedger).set({ status: "queued" });
    options.senders.primary.sendEmail.mockClear();
    await seed(); await runNightlyReminders(options);
    expect(options.senders.primary.sendEmail).toHaveBeenCalledOnce();
    const mail = await handle.db.select().from(schema.postClassNotificationDeliveries);
    expect(mail.find((m) => m.id === queued.id)?.status).toBe("cancelled");
    expect(mail.find((m) => m.status === "sent")?.frozenContent?.sessionIds).toHaveLength(2);
  });
  it("uses Gmail as the production transport and records acceptance separately", async () => {
    vi.stubEnv("AUTH_SECRET", "test-key"); vi.stubEnv("POST_CLASS_GMAIL_CLIENT_ID", "client");
    vi.stubEnv("POST_CLASS_GMAIL_CLIENT_SECRET", "secret"); vi.stubEnv("POST_CLASS_GMAIL_WORKSPACE_TRUSTED", "true");
    const request = vi.fn().mockResolvedValue(Response.json({ id: "gmail-message-id" })); vi.stubGlobal("fetch", request);
    try {
      await seed();
      await handle.db.insert(schema.postClassEmailConnection).values({ id: "gmail", clientId: "client", mailbox: FEEDBACK_MAILBOX,
        googleSubject: "subject", accessTokenCiphertext: encryptToken("token")!, refreshTokenCiphertext: encryptToken("refresh")!,
        expiresAt: new Date(Date.now() + 3600000), scope: GMAIL_SEND_SCOPE, connectedBy: "admin@example.com" });
      const options = dependencies();
      expect((await runNightlyReminders({ ...options, senders: undefined })).ok).toBe(true);
      expect(request).toHaveBeenCalledWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", expect.any(Object));
      expect((await handle.db.select().from(schema.postClassNotificationDeliveries))[0]).toMatchObject({ provider: "gmail", providerMessageId: "gmail-message-id", status: "sent" });
    } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
  });
  it("honors Gmail retry timing and does not retry permanent rejections", async () => {
    await seed(); const options = dependencies();
    const retryAt = new Date(now.getTime() + 2 * 60 * 60_000);
    options.senders.primary.sendEmail.mockRejectedValueOnce(new GmailRejection("quota", false, retryAt));
    await runNightlyReminders(options);
    expect((await handle.db.select().from(schema.postClassNotificationDeliveries))[0].nextAttemptAt).toEqual(retryAt);
  });
  it("does not schedule another attempt after a permanent Gmail rejection", async () => {
    await seed(); const options = dependencies();
    options.senders.primary.sendEmail.mockRejectedValueOnce(new GmailRejection("revoked", true));
    await runNightlyReminders(options);
    expect((await handle.db.select().from(schema.postClassNotificationDeliveries))[0].nextAttemptAt).toBeNull();
  });
  it("requires Gmail renewal, inbox proof and private LINE proof before prospective activation or resume", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    vi.stubEnv("POST_CLASS_GMAIL_CLIENT_ID", "client"); vi.stubEnv("POST_CLASS_GMAIL_CLIENT_SECRET", "secret");
    vi.stubEnv("POST_CLASS_GMAIL_WORKSPACE_TRUSTED", "true"); vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "line-token");
    const recipient = "U" + "a".repeat(32); vi.stubEnv("POST_CLASS_REMINDER_LINE_USER_ID", recipient);
    try {
      await handle.db.update(schema.postClassSettings).set({ reminderMode: "shadow", reminderActivatedAt: null, legacyReminderDisabledAt: null });
      await expect(updatePostClassSettings({ email: "admin@example.com" }, { reminderMode: "live", expectedVersion: 1, legacyReminderDisabled: true }, db())).rejects.toThrow(/shadow batch/);
      const options = dependencies(); await runNightlyReminders({ ...options, shadowPreview: true });
      await handle.db.insert(schema.postClassConfigAuditLog).values(["primary", "backup"].map(senderKey => ({
        entityType: "email_delivery", entityKey: "admin@example.com", action: "test_succeeded", actorEmail: "admin@example.com",
        afterValue: { senderKey, providerMessageId: `receipt-${senderKey}` },
      })));
      await expect(updatePostClassSettings({ email: "admin@example.com" }, { reminderMode: "live", expectedVersion: 1, legacyReminderDisabled: true }, db())).rejects.toThrow(/Gmail/);
      const proof = { hash: "hash", actor: "admin@example.com", binding: "client:subject:1", expiresAt: new Date(now.getTime() + 86400000).toISOString(), attempts: 1, acceptedAt: now.toISOString(), confirmedAt: now.toISOString(), receipt: "id" };
      await handle.db.insert(schema.postClassEmailConnection).values({ id: "gmail", clientId: "client", mailbox: FEEDBACK_MAILBOX, googleSubject: "subject", accessTokenCiphertext: "encrypted", refreshTokenCiphertext: "encrypted", expiresAt: new Date(now.getTime() + 3600000), scope: GMAIL_SEND_SCOPE, connectedBy: proof.actor, refreshedAt: now, testEvidence: proof });
      await expect(updatePostClassSettings({ email: proof.actor }, { reminderMode: "live", expectedVersion: 1, legacyReminderDisabled: true }, db())).rejects.toThrow(/LINE/);
      const binding = createHash("sha256").update(`${recipient}:line-token`).digest("hex");
      await handle.db.insert(schema.postClassReminderLineChannel).values({ id: "private", recipientId: recipient, binding, testEvidence: { ...proof, binding } });
      await updatePostClassSettings({ email: proof.actor }, { reminderMode: "live", expectedVersion: 1, legacyReminderDisabled: true }, db());
      const [config] = await handle.db.select().from(schema.postClassSettings);
      expect(config.reminderMode).toBe("live"); expect(config.reminderActivatedAt!.getTime()).toBeGreaterThanOrEqual(now.getTime());
      await updatePostClassSettings({ email: proof.actor }, { reminderMode: "off", expectedVersion: 2 }, db());
      await handle.db.update(schema.postClassEmailConnection).set({ testEvidence: null });
      await expect(updatePostClassSettings({ email: proof.actor }, { reminderMode: "live", expectedVersion: 3 }, db())).rejects.toThrow(/Gmail/);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
});
