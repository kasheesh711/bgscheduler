import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { classroomWeekendChecks as checks, classroomWeekendNotifications as notifications } from "@/lib/db/schema";
import { claimWeekendCheck, assertWeekendClaim, weekendClaimPredicate, runWeekendClassroomCheck, loadWeekendCheck } from "../weekend-check";
import { WEEKEND_CHECK_LEASE_MS } from "../weekend-config";
import type { WeekendReport } from "../weekend-readiness";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const wednesday = new Date("2026-09-09T02:00:00Z");
const thursday = new Date("2026-09-10T02:00:00Z");
const friday = new Date("2026-09-11T02:00:00Z");
function report(readiness: WeekendReport["readiness"] = "attention"): WeekendReport {
  return { checkedAt: wednesday.toISOString(), dates: ["2026-09-12", "2026-09-13"], snapshotId: null, snapshotFinishedAt: null, readiness,
    days: [{ date: "2026-09-12", liveSessions: 23, plannedSessions: 23, noRoomCount: readiness === "clear" ? 0 : 1 }],
    findings: readiness === "clear" ? [] : [{ date: "2026-09-12", kind: "no_room", tutor: "Teacher", message: "No classroom available" }] };
}
const sender = () => ({ sendEmail: vi.fn().mockResolvedValue({ id: "test-provider" }) });
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await handle.db.execute(sql`TRUNCATE classroom_weekend_notifications, classroom_weekend_checks CASCADE`);
  vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "kevhsh7@gmail.com");
  vi.stubEnv("CLASSROOM_WEEKEND_ALERTS_ENABLED_AT", "2026-09-07T05:00:00Z");
});
afterEach(() => vi.unstubAllEnvs());

describe("durable private weekend delivery", () => {
  it("elects one assessment and sender under concurrent cron invocations", async () => {
    const mail = sender(), evaluate = vi.fn(async () => report());
    const results = await Promise.all(Array.from({ length: 8 }, () => runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate })));
    expect(results.filter(result => "checkId" in result)).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail.mock.calls[0][0].to).toBe("kevhsh7@gmail.com");
    expect((await handle.db.select().from(checks))[0].status).toBe("completed");
  });
  it("retries failed delivery with the same report and relay key, then skips further ticks", async () => {
    const mail = sender(), evaluate = vi.fn(async () => report());
    mail.sendEmail.mockRejectedValueOnce(new Error("relay unavailable"));
    expect((await runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate })).ok).toBe(false);
    const retry = new Date(wednesday.getTime() + 16 * 60_000);
    expect((await runWeekendClassroomCheck(db, { now: retry, sender: mail, evaluate })).ok).toBe(true);
    await runWeekendClassroomCheck(db, { now: new Date(wednesday.getTime() + 31 * 60_000), sender: mail, evaluate });
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendEmail.mock.calls[0][0].idempotencyKey).toBe(mail.sendEmail.mock.calls[1][0].idempotencyKey);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((await handle.db.select().from(notifications))[0]).toMatchObject({ status: "sent", attempts: 2 });
  });
  it("reminds on all three check days without suppressing unchanged problems", async () => {
    const mail = sender();
    for (const now of [wednesday, thursday, friday]) await runWeekendClassroomCheck(db, { now, sender: mail, evaluate: async () => report() });
    expect(mail.sendEmail).toHaveBeenCalledTimes(3);
    expect(new Set(mail.sendEmail.mock.calls.map(call => call[0].idempotencyKey)).size).toBe(3);
  });
  it("sends one recovery after an alert and keeps subsequent healthy checks quiet", async () => {
    const mail = sender();
    await runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate: async () => report() });
    await runWeekendClassroomCheck(db, { now: thursday, sender: mail, evaluate: async () => report("clear") });
    await runWeekendClassroomCheck(db, { now: friday, sender: mail, evaluate: async () => report("clear") });
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendEmail.mock.calls[1][0].subject).toContain("RESOLVED");
  });
  it("keeps an ordinary healthy weekend quiet", async () => {
    const mail = sender();
    for (const now of [wednesday, thursday, friday]) await runWeekendClassroomCheck(db, { now, sender: mail, evaluate: async () => report("clear") });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(await handle.db.select().from(checks)).toHaveLength(3);
  });
  it("emails verification failures instead of recording an all-clear", async () => {
    const mail = sender();
    const result = await runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate: async () => { throw new Error("Wise pagination incomplete"); } });
    expect(result).toMatchObject({ ok: true, readiness: "unverified", notification: "warning" });
    expect(mail.sendEmail.mock.calls[0][0].subject).toContain("could not be fully verified");
    expect(mail.sendEmail.mock.calls[0][0].text).toContain("Wise pagination incomplete");
    const saved = await loadWeekendCheck(db, { now: wednesday });
    expect(saved?.report?.readiness).toBe("unverified");
    expect(JSON.stringify(saved)).not.toContain("kevhsh7@gmail.com");
  });
  it("recovers an abandoned lease and fences the previous worker", async () => {
    const first = (await claimWeekendCheck(db, wednesday))!;
    expect(await claimWeekendCheck(db, new Date(wednesday.getTime() + WEEKEND_CHECK_LEASE_MS - 1))).toBeNull();
    const later = new Date(wednesday.getTime() + WEEKEND_CHECK_LEASE_MS + 1);
    const second = (await claimWeekendCheck(db, later))!;
    expect(second.id).toBe(first.id);
    await expect(assertWeekendClaim(db, first.id, wednesday, new Date(wednesday.getTime() + 1))).rejects.toThrow("no longer owns");
    expect(await handle.db.update(checks).set({ status: "completed" }).where(weekendClaimPredicate(first.id, wednesday)).returning()).toEqual([]);
  });
  it("rechecks unverifiable data on a retry without duplicating the warning", async () => {
    const mail = sender();
    await runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate: async () => { throw new Error("Snapshot not fresh yet"); } });
    expect((await handle.db.select().from(checks))[0].status).toBe("retry_pending");
    const result = await runWeekendClassroomCheck(db, { now: new Date(wednesday.getTime() + 16 * 60_000), sender: mail, evaluate: async () => report("clear") });
    expect(result).toMatchObject({ ok: true, readiness: "clear" });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    // Recovery is confirmed at the next primary check day, after the actual warning.
    await runWeekendClassroomCheck(db, { now: thursday, sender: mail, evaluate: async () => report("clear") });
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mail.sendEmail.mock.calls[1][0].subject).toContain("RESOLVED");
  });
  it("does not resend accepted mail after a crash before checkpoint finalization", async () => {
    const mail = sender();
    await runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate: async () => report() });
    const [check] = await handle.db.select().from(checks);
    await handle.db.update(checks).set({ status: "running", finishedAt: null }).where(eq(checks.id, check.id));
    await runWeekendClassroomCheck(db, { now: new Date(wednesday.getTime() + WEEKEND_CHECK_LEASE_MS + 1), sender: mail });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });
  it("cannot divert a pending notification when recipient configuration changes", async () => {
    const mail = sender();
    mail.sendEmail.mockRejectedValueOnce(new Error("unavailable"));
    await runWeekendClassroomCheck(db, { now: wednesday, sender: mail, evaluate: async () => report() });
    vi.stubEnv("CLASSROOM_WEEKEND_ALERT_EMAIL", "someoneelse@example.com");
    const result = await runWeekendClassroomCheck(db, { now: new Date(wednesday.getTime() + 16 * 60_000), sender: mail });
    expect(result.ok).toBe(false);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });
  it("does not run or send outside the enabled check days", async () => {
    const mail = sender(), evaluate = vi.fn(async () => report());
    await runWeekendClassroomCheck(db, { now: new Date("2026-09-12T02:00:00Z"), sender: mail, evaluate });
    expect(evaluate).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(await handle.db.select().from(checks)).toEqual([]);
  });
});
