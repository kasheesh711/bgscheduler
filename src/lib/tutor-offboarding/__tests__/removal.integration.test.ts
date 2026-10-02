import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as s from "@/lib/db/schema";
import type { WiseTeacher } from "@/lib/wise/types";
import type { OffboardingPersonRow } from "../types";
import { applyRemovalRun, getRemovalRun, previewRemovalRun, type RemovalOptions } from "../removal";
import { reconcileRemovalRuns } from "../reconcile";
import type { RemovalRequestResult } from "../removal-wise";

let handle: Awaited<ReturnType<typeof startTestDb>>; let db: Database;
const NOW = new Date("2026-10-01T05:00:00Z");
const viewer = { email: "ops@example.com", isOwner: false, canRemove: true };
const teacher: WiseTeacher = { _id: "t1", userId: { _id: "u1", name: "Aria", email: "aria@example.com" }, relation: "TEACHER", classes: [], tags: [] };
const other: WiseTeacher = { _id: "other", userId: { _id: "other-user", name: "Other" }, relation: "TEACHER", classes: [] };
let roster: WiseTeacher[]; let row: OffboardingPersonRow; let options: RemovalOptions;
let remove: ReturnType<typeof vi.fn<(userId: string) => Promise<RemovalRequestResult>>>;
const input = (run: Awaited<ReturnType<typeof previewRemovalRun>>) => ({ previewToken: run.previewToken, confirmed: true as const, reason: "Confirmed departure by owner", accountCount: run.accountCount });
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => {
  await truncateAll(handle.db);
  await db.delete(s.tutorBusinessProfiles);
  await db.insert(s.adminUsers).values({ email: viewer.email });
  await db.insert(s.tutorOffboardingAccessGrants).values({ email: viewer.email, grantedByEmail: "owner@example.com" });
  await db.insert(s.tutorWiseAccounts).values({ wiseTeacherId: "t1", wiseUserId: "u1", canonicalKey: "Aria", displayName: "Aria", isOnlineVariant: false, status: "active", lastSnapshotId: "00000000-0000-0000-0000-000000000001" });
  await db.insert(s.tutorContacts).values({ canonicalKey: "Aria", displayName: "Aria", active: true });
  await db.insert(s.tutorBusinessProfiles).values({ canonicalKey: "Aria", displayName: "Aria", active: false });
  roster = [structuredClone(teacher), structuredClone(other)];
  row = { signals: { canonicalKey: "Aria", displayName: "Aria", accounts: [{ wiseTeacherId: "t1", wiseUserId: "u1", displayName: "Aria", isOnlineVariant: false, email: "aria@example.com", status: "active", relation: "TEACHER", joinedOn: null, courseCount: 0, activated: true, availabilityKnown: true, workingHourWindows: 0 }], lastTaughtAt: null, lastTaughtBySource: { ledger: null, pastBlocks: null, postClass: null }, upcomingSessions: 0, nextSessionAt: null, upcomingLeaveUntil: null, lastTeacherActionAt: null, lastAdminActionAt: null, fullTime: false }, score: { likelihood: 98, band: "very_likely_gone", idleDays: 120, neverTaught: false, reasons: [], exclusion: null, removable: true, removableBlockedBy: null }, openDecision: null };
  remove = vi.fn(async () => { roster = [other]; return { status: "sent" as const, errorMessage: null, responsePayload: { status: 200 } }; });
  options = { db, now: () => NOW, env: { VERCEL_ENV: "production", WISE_TEACHER_REMOVAL_VERIFIED: "true" }, readWise: async () => ({ roster, sessions: [] }), readRoster: async () => roster, removeParticipant: remove, loadRows: async () => [row] };
});
describe("removal lifecycle", () => {
  it("binds a 15 minute preview, validates confirmation, and expires without a POST", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    expect(run.previewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(run.previewExpiresAt).toBe("2026-10-01T05:15:00.000Z");
    await expect(applyRemovalRun(viewer, run.id, { ...input(run), accountCount: 2 }, options)).rejects.toMatchObject({ status: 422 });
    await expect(applyRemovalRun(viewer, run.id, { ...input(run), previewToken: "wrong" }, options)).rejects.toMatchObject({ status: 422 });
    await expect(applyRemovalRun(viewer, run.id, { ...input(run), reason: "tiny" }, options)).rejects.toMatchObject({ status: 422 });
    await expect(applyRemovalRun(viewer, run.id, input(run), { ...options, now: () => new Date("2026-10-01T05:15:00Z") })).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
    expect((await getRemovalRun(run.id, db))?.status).toBe("expired");
  });
  it("allows one concurrent apply, records the request, and cleans/restores exact local flags", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    const applied = await Promise.allSettled([applyRemovalRun(viewer, run.id, input(run), options), applyRemovalRun(viewer, run.id, input(run), options)]);
    expect(applied.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith("u1");
    const result = (await getRemovalRun(run.id, db))!;
    expect(result.status).toBe("applied"); expect(result.accounts[0].status).toBe("verified");
    expect(result.accounts[0].localStateBefore).toEqual({ contactActive: true, profileActive: false });
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(false);
    roster = [teacher, other]; await reconcileRemovalRuns(db, roster, NOW);
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(true);
    expect((await db.select().from(s.tutorBusinessProfiles))[0].active).toBe(false);
    expect((await getRemovalRun(run.id, db))!.accounts[0]).toMatchObject({ status: "restored", localStateBefore: { contactActive: true, profileActive: false } });
  });
  it("manual mode keeps checklist and local flags until removal is seen", async () => {
    options.env = {};
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    const applied = await applyRemovalRun(viewer, run.id, input(run), options);
    expect(applied.accounts[0].status).toBe("manual_required"); expect(remove).not.toHaveBeenCalled();
    await reconcileRemovalRuns(db, roster, NOW);
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("manual_required");
    await reconcileRemovalRuns(db, [other], NOW);
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("removed_manually");
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(false);
  });
  it("requires a fresh grant and refuses mode changes", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    await expect(applyRemovalRun(viewer, run.id, input(run), { ...options, env: {} })).rejects.toMatchObject({ status: 409 });
    await db.delete(s.tutorOffboardingAccessGrants);
    await expect(applyRemovalRun(viewer, run.id, input(run), options)).rejects.toMatchObject({ status: 403 });
    expect(remove).not.toHaveBeenCalled();
  });
  it("blocks fresh unsafe scores, user drift and newly added variants for the whole person", async () => {
    const stale = { ...teacher, userId: { _id: "changed", name: "Aria", email: "aria@example.com" } };
    roster = [stale, other];
    expect((await previewRemovalRun(viewer, ["Aria"], options)).accounts[0].plan).toBe("skip");
    roster = [teacher, other]; const run = await previewRemovalRun(viewer, ["Aria"], options);
    roster = [teacher, { ...teacher, _id: "t2", userId: { _id: "u2", name: "Aria Online" } }, other];
    expect((await applyRemovalRun(viewer, run.id, input(run), options)).accounts[0].status).toBe("skipped");
    expect(remove).not.toHaveBeenCalled();
    roster = [teacher, other]; row.score.removable = false;
    expect((await previewRemovalRun(viewer, ["Aria"], options)).accounts[0].plan).toBe("skip");
  });
  it("checks live sessions again at apply", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    options.readWise = async () => ({ roster, sessions: [{ _id: "session", userId: "u1", scheduledStartTime: "2026-10-01T04:30:00Z", scheduledEndTime: "2026-10-01T05:30:00Z" }] });
    expect((await applyRemovalRun(viewer, run.id, input(run), options)).accounts[0].status).toBe("skipped");
    expect(remove).not.toHaveBeenCalled();
  });
  it("persists sending through a crash and reconciles without ever resending", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    remove.mockImplementationOnce(async () => { roster = [other]; throw new Error("synthetic crash after POST"); });
    await expect(applyRemovalRun(viewer, run.id, input(run), options)).rejects.toThrow("synthetic crash");
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("sending");
    await reconcileRemovalRuns(db, roster, new Date(NOW.getTime() + 21 * 60_000));
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("verified");
    expect((await getRemovalRun(run.id, db))!.status).toBe("applied");
    await expect(applyRemovalRun(viewer, run.id, input(run), options)).rejects.toMatchObject({ status: 409 });
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("does not clean up on incomplete readback or allow unresolved requests in new previews", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    remove.mockImplementationOnce(async () => ({ status: "unknown", errorMessage: "unknown", responsePayload: null }));
    options.readRoster = async () => { if (remove.mock.calls.length) throw new Error("unavailable"); return roster; };
    await expect(applyRemovalRun(viewer, run.id, input(run), options)).rejects.toThrow("unavailable");
    expect(remove).toHaveBeenCalledTimes(1);
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("unknown");
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(true);
    expect((await previewRemovalRun(viewer, ["Aria"], { ...options, readRoster: async () => roster })).accounts[0].plan).toBe("skip");
    await expect(reconcileRemovalRuns(db, [], NOW)).rejects.toThrow();
  });
  it("holds the global applying lock across different previews", async () => {
    const first = await previewRemovalRun(viewer, ["Aria"], options);
    const second = await previewRemovalRun(viewer, ["Aria"], options);
    await db.update(s.tutorOffboardingRuns).set({ status: "applying", appliedAt: NOW }).where(eq(s.tutorOffboardingRuns.id, first.id));
    await expect(applyRemovalRun(viewer, second.id, input(second), options)).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not deactivate a partially removed person, and rechecks the grant for the next account", async () => {
    const online = { ...teacher, _id: "t2", userId: { _id: "u2", name: "Aria Online", email: "aria-online@example.com" } };
    await db.insert(s.tutorWiseAccounts).values({ wiseTeacherId: "t2", wiseUserId: "u2", canonicalKey: "Aria", displayName: "Aria Online", isOnlineVariant: true, status: "active", lastSnapshotId: "00000000-0000-0000-0000-000000000001" });
    row.signals.accounts.push({ ...row.signals.accounts[0], wiseTeacherId: "t2", wiseUserId: "u2", displayName: "Aria Online", isOnlineVariant: true });
    roster = [teacher, online, other];
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    expect(run.accountCount).toBe(2);
    remove.mockImplementationOnce(async () => { roster = [online, other]; await db.delete(s.tutorOffboardingAccessGrants); return { status: "sent", errorMessage: null, responsePayload: { status: 200 } }; });
    const applied = await applyRemovalRun(viewer, run.id, input(run), options);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(applied.accounts.map(a => a.status)).toEqual(["verified", "skipped"]);
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(true);
    expect(applied.accounts[0].localStateBefore).toBeNull();
  });
  it("restores saved flags for a reappearing person under a new account ID and retains completion time", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    const applied = await applyRemovalRun(viewer, run.id, input(run), options);
    await db.insert(s.tutorWiseAccounts).values({ wiseTeacherId: "new-t1", wiseUserId: "new-u1", canonicalKey: "Aria", displayName: "Aria", isOnlineVariant: false, status: "active", lastSnapshotId: "00000000-0000-0000-0000-000000000001" });
    const reappeared = { ...teacher, _id: "new-t1", userId: { _id: "new-u1", name: "Aria" } };
    await reconcileRemovalRuns(db, [reappeared, other], new Date(NOW.getTime() + 30 * 60_000));
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(true);
    const after = (await getRemovalRun(run.id, db))!;
    expect(after.finishedAt).toBe(applied.finishedAt);
    expect(after.accounts[0]).toMatchObject({ status: "restored", localStateBefore: { contactActive: true, profileActive: false } });
  });
  it("blocks unresolved requests by stable user ID after a teacher row is replaced", async () => {
    const old = await previewRemovalRun(viewer, ["Aria"], options);
    await db.update(s.tutorOffboardingRuns).set({ status: "applied_with_errors", appliedAt: NOW, finishedAt: NOW }).where(eq(s.tutorOffboardingRuns.id, old.id));
    await db.update(s.tutorOffboardingRunAccounts).set({ status: "unknown", sentAt: NOW }).where(eq(s.tutorOffboardingRunAccounts.runId, old.id));
    await db.insert(s.tutorWiseAccounts).values({ wiseTeacherId: "replacement", wiseUserId: "u1", canonicalKey: "Aria", displayName: "Aria", isOnlineVariant: false, status: "active", lastSnapshotId: "00000000-0000-0000-0000-000000000001" });
    row.signals.accounts[0].wiseTeacherId = "replacement";
    roster = [{ ...teacher, _id: "replacement" }, other];
    expect((await previewRemovalRun(viewer, ["Aria"], options)).accounts[0].plan).toBe("skip");
    expect(remove).not.toHaveBeenCalled();
  });
  it("rechecks unresolved requests when an older saved preview is applied", async () => {
    const first = await previewRemovalRun(viewer, ["Aria"], options);
    const second = await previewRemovalRun(viewer, ["Aria"], options);
    await db.update(s.tutorOffboardingRuns).set({ status: "applied_with_errors", appliedAt: NOW, finishedAt: NOW }).where(eq(s.tutorOffboardingRuns.id, first.id));
    await db.update(s.tutorOffboardingRunAccounts).set({ status: "unknown", sentAt: NOW }).where(eq(s.tutorOffboardingRunAccounts.runId, first.id));
    expect((await applyRemovalRun(viewer, second.id, input(second), options)).accounts[0].status).toBe("skipped");
    expect(remove).not.toHaveBeenCalled();
  });
  it("reconciles a rejected request after owner manual removal without a POST", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    await db.update(s.tutorOffboardingRuns).set({ status: "applied_with_errors", appliedAt: NOW, finishedAt: NOW }).where(eq(s.tutorOffboardingRuns.id, run.id));
    await db.update(s.tutorOffboardingRunAccounts).set({ status: "rejected", sentAt: NOW }).where(eq(s.tutorOffboardingRunAccounts.runId, run.id));
    await reconcileRemovalRuns(db, roster, NOW);
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("rejected");
    await reconcileRemovalRuns(db, [other], NOW);
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("removed_manually");
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not restore local flags using roster evidence predating account updates", async () => {
    const run = await previewRemovalRun(viewer, ["Aria"], options);
    await applyRemovalRun(viewer, run.id, input(run), options);
    await db.update(s.tutorOffboardingRunAccounts).set({ updatedAt: new Date(NOW.getTime() + 60_000) }).where(eq(s.tutorOffboardingRunAccounts.runId, run.id));
    await reconcileRemovalRuns(db, [teacher, other], NOW);
    expect((await getRemovalRun(run.id, db))!.accounts[0].status).toBe("verified");
    expect((await db.select().from(s.tutorContacts))[0].active).toBe(false);
  });
});
