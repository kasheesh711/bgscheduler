import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestDb, stopTestDb } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import { classroomAdminEmailRuns as runs, classroomAdminEmailRecipients as recipients } from "@/lib/db/schema";
import { ADMIN_EMAIL_LEASE_MS, claimAdminEmailRun, assertAdminEmailClaim, adminEmailClaimPredicate, sentAdminRecipients } from "../admin-email-claim";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const now = new Date("2026-09-05T00:04:00.000Z");
const input = { assignmentDate: "2026-09-05", assignmentRunId: null, subject: "Test", triggerKind: "failure" as const, now };
beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await handle.db.execute(sql`TRUNCATE classroom_admin_email_recipients, classroom_admin_email_runs CASCADE`); });

describe("admin email delivery claims in Postgres", () => {
  it("elects one sender under concurrent first attempts", async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimAdminEmailRun(db, input)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it("retries failed and partial runs using the same date key and retains sent recipients", async () => {
    const first = (await claimAdminEmailRun(db, input))!;
    await handle.db.insert(recipients).values({ emailRunId: first.id, assignmentDate: input.assignmentDate, recipientEmail: "sent@example.com", status: "sent" });
    for (const status of ["failed", "partial"]) {
      await handle.db.update(runs).set({ status }).where(eq(runs.id, first.id));
      const claims = await Promise.all([1, 2, 3].map(() => claimAdminEmailRun(db, { ...input, now: new Date(now.getTime() + 60_000) })));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.find(Boolean)?.id).toBe(first.id);
      expect(await sentAdminRecipients(db, first.id)).toEqual(new Set(["sent@example.com"]));
    }
    await handle.db.update(runs).set({ status: "sent" }).where(eq(runs.id, first.id));
    expect(await claimAdminEmailRun(db, { ...input, now: new Date(now.getTime() + ADMIN_EMAIL_LEASE_MS * 2) })).toBeNull();
  });
  it("reclaims an abandoned attempt after ten minutes and fences the old owner", async () => {
    const first = (await claimAdminEmailRun(db, input))!;
    expect(await claimAdminEmailRun(db, { ...input, now: new Date(now.getTime() + ADMIN_EMAIL_LEASE_MS - 1) })).toBeNull();
    const later = new Date(now.getTime() + ADMIN_EMAIL_LEASE_MS + 1);
    const second = (await claimAdminEmailRun(db, { ...input, now: later }))!;
    expect(second.id).toBe(first.id);
    await expect(assertAdminEmailClaim(db, first.id, now, new Date(now.getTime() + 1))).rejects.toThrow("no longer owns");
    await expect(assertAdminEmailClaim(db, second.id, later, later)).resolves.toBeUndefined();
    const staleFinalization = await handle.db.update(runs).set({ status: "sent" }).where(adminEmailClaimPredicate(first.id, now)).returning();
    expect(staleFinalization).toEqual([]);
  });
});
