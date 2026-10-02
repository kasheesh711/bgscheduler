import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { startTestDb, stopTestDb, truncateAll } from "@/tests/integration/db-helper";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listDecisions, recordStillWithUs, revokeDecision } from "../decisions";
import { changeGrant, hasRemovalGrant } from "../grants";

let handle: Awaited<ReturnType<typeof startTestDb>>;
let db: Database;
const NOW = new Date("2026-10-01T05:00:00.000Z");
const SCORE = { likelihood: 96, band: "very_likely_gone" as const, reasons: ["Last class 120 days ago (3 Jun)"] };

beforeAll(async () => { handle = await startTestDb(); db = handle.db as unknown as Database; });
afterAll(async () => { if (handle) await stopTestDb(handle); });
beforeEach(async () => { await truncateAll(handle.db); });

describe("still-with-us decisions", () => {
  it("records the score it overrode and refuses a second open decision for the same person", async () => {
    const decision = await recordStillWithUs(db, { canonicalKey: "Aria", note: "On a term break", snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW });
    expect(decision).toMatchObject({
      canonicalKey: "Aria", note: "On a term break", likelihoodAtDecision: 96, bandAtDecision: "very_likely_gone",
      reasons: ["Last class 120 days ago (3 Jun)"], decidedByEmail: "admin@example.com",
      decidedAt: NOW.toISOString(), snoozeUntil: "2026-12-30T05:00:00.000Z", revokedAt: null,
    });
    await expect(recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 365, actorEmail: "other@example.com", score: SCORE, now: NOW }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("undoes a decision once, after which a new one is allowed", async () => {
    const decision = await recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW });
    expect(await revokeDecision(db, { decisionId: decision.id, actorEmail: "other@example.com", now: NOW }))
      .toMatchObject({ revokedAt: NOW.toISOString(), revokedByEmail: "other@example.com" });
    await expect(revokeDecision(db, { decisionId: decision.id, actorEmail: "other@example.com", now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW }))
      .resolves.toMatchObject({ canonicalKey: "Aria" });
  });

  it("always lists open decisions, even beyond the log limit", async () => {
    const aria = await recordStillWithUs(db, { canonicalKey: "Aria", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE, now: NOW });
    const bodhi = await recordStillWithUs(db, { canonicalKey: "Bodhi", note: null, snoozeDays: 90, actorEmail: "admin@example.com", score: SCORE,
      now: new Date(NOW.getTime() + 60_000) });
    const listed = await listDecisions(db, new Date(NOW.getTime() + 120_000), 1);
    expect(listed.map((decision) => decision.id)).toEqual([bodhi.id, aria.id]);
  });
});

describe("removal grants (OFF-11)", () => {
  beforeEach(async () => {
    await handle.db.insert(schema.adminUsers).values([{ email: "Ops@Example.com" }, { email: "off@example.com", disabled: true }]);
  });

  it("grants only enabled admins, refuses duplicates, and audits every change", async () => {
    expect(await changeGrant(db, { action: "grant", email: " ops@example.com ", actorEmail: "owner@example.com" }))
      .toEqual([{ email: "ops@example.com", grantedByEmail: "owner@example.com", grantedAt: expect.any(String) }]);
    await expect(changeGrant(db, { action: "grant", email: "ops@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 409 });
    await expect(changeGrant(db, { action: "grant", email: "off@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 422 });
    await expect(changeGrant(db, { action: "grant", email: "stranger@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 422 });
    expect(await hasRemovalGrant("OPS@example.com", db)).toBe(true);
    expect(await changeGrant(db, { action: "revoke", email: "ops@example.com", actorEmail: "owner@example.com" })).toEqual([]);
    await expect(changeGrant(db, { action: "revoke", email: "ops@example.com", actorEmail: "owner@example.com" })).rejects.toMatchObject({ status: 404 });
    expect(await hasRemovalGrant("ops@example.com", db)).toBe(false);
    const audit = await handle.db.select().from(schema.tutorOffboardingAccessAuditLog).orderBy(asc(schema.tutorOffboardingAccessAuditLog.createdAt));
    expect(audit.map((row) => [row.action, row.email, row.actorEmail])).toEqual([
      ["grant", "ops@example.com", "owner@example.com"],
      ["revoke", "ops@example.com", "owner@example.com"],
    ]);
  });

  it("stops honouring a grant once the admin is disabled", async () => {
    await changeGrant(db, { action: "grant", email: "ops@example.com", actorEmail: "owner@example.com" });
    await handle.db.update(schema.adminUsers).set({ disabled: true }).where(eq(schema.adminUsers.email, "Ops@Example.com"));
    expect(await hasRemovalGrant("ops@example.com", db)).toBe(false);
  });
});
