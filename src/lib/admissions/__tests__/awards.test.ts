import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog, admissionsAwards } from "@/lib/db/schema";
import {
  createAward,
  listAwardsForCase,
  setCommonAppAwardRanks,
  softDeleteAward,
  UC_AWARD_ACHIEVEMENT_MAX_CHARS,
  UC_AWARD_ELIGIBILITY_MAX_CHARS,
  updateAward,
} from "@/lib/admissions/awards";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const AWARD_ID = "22222222-2222-4222-8222-222222222222";
const AWARD_B = "33333333-3333-4333-8333-333333333333";
const UPDATED_AT = new Date("2026-07-01T00:00:00.000Z");
const STUDENT: CaseAccess = { caseId: CASE_ID, email: "student@example.com", role: "student", isAdmin: false };
const COUNSELOR: CaseAccess = { caseId: CASE_ID, email: "staff@example.com", role: "counselor", isAdmin: false };
const PARENT: CaseAccess = { caseId: CASE_ID, email: "parent@example.com", role: "parent", isAdmin: false };

interface InsertCall { table: unknown; values: Record<string, unknown> }
interface UpdateCall { table: unknown; set: Record<string, unknown> }
function fakeDb(queue: unknown[][]) {
  let i = 0;
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  function chain(rows: unknown[]) {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "for"]) value[method] = () => value;
    (value as { then: unknown }).then = (
      resolve: (result: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return value;
  }
  const tx = {
    select: () => chain(queue[i++] ?? []),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      const row = { id: AWARD_ID, deletedAt: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT, ...values };
      return { returning: () => Promise.resolve([row]), then: (resolve: (v: unknown) => unknown) => Promise.resolve().then(resolve) };
    } }),
    update: (table: unknown) => ({ set: (set: Record<string, unknown>) => {
      updates.push({ table, set });
      return chain([]);
    } }),
  };
  return { db: { ...tx, transaction: async (cb: (v: unknown) => Promise<unknown>) => cb(tx) } as never, inserts, updates };
}

function awardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AWARD_ID,
    caseId: CASE_ID,
    title: "International Mathematics Olympiad",
    organization: "IMO",
    gradeLevels: ["11"],
    recognitionLevels: ["international"],
    awardDate: "2026-06-15",
    commonAppRank: 1,
    ucEligibilityNarrative: "Qualified through the national selection process.",
    ucAchievementNarrative: "Earned a bronze medal representing Thailand.",
    internalNotes: "Verify certificate.",
    deletedAt: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("awards domain", () => {
  it("lets students create a first-class award and audits it", async () => {
    const { db, inserts } = fakeDb([[]]);
    const award = await createAward({
      access: STUDENT,
      title: "  Math Olympiad  ",
      gradeLevels: ["11"],
      recognitionLevels: ["national"],
      commonAppRank: 1,
      ucEligibilityNarrative: "e".repeat(UC_AWARD_ELIGIBILITY_MAX_CHARS),
      ucAchievementNarrative: "a".repeat(UC_AWARD_ACHIEVEMENT_MAX_CHARS),
    }, db);
    expect(award.title).toBe("Math Olympiad");
    expect(award.internalNotes).toBeNull();
    expect(inserts.find((call) => call.table === admissionsAwards)?.values)
      .toMatchObject({ caseId: CASE_ID, commonAppRank: 1 });
    expect(inserts.find((call) => call.table === admissionsAuditLog)?.values)
      .toMatchObject({ entityType: "award", action: "create", actorRole: "student" });
  });

  it("enforces UC character limits, closed levels, and unique top-five ranks", async () => {
    const invalid = fakeDb([]);
    await expect(createAward({
      access: STUDENT,
      title: "X",
      ucEligibilityNarrative: "x".repeat(UC_AWARD_ELIGIBILITY_MAX_CHARS + 1),
    }, invalid.db)).rejects.toThrow("exceeds 250");
    await expect(createAward({
      access: STUDENT,
      title: "X",
      recognitionLevels: ["planetary" as never],
    }, invalid.db)).rejects.toThrow("Invalid recognitionLevels");

    const duplicate = fakeDb([[{ id: AWARD_B }]]);
    await expect(createAward({ access: STUDENT, title: "X", commonAppRank: 1 }, duplicate.db))
      .rejects.toThrow("Conflict");
  });

  it("keeps internal notes counselor-only", async () => {
    const denied = fakeDb([]);
    await expect(createAward({ access: STUDENT, title: "X", internalNotes: "private" }, denied.db))
      .rejects.toThrow("Forbidden");
    await expect(createAward({ access: PARENT, title: "X" }, denied.db)).rejects.toThrow("Forbidden");

    const allowed = fakeDb([]);
    const result = await createAward({ access: COUNSELOR, title: "X", internalNotes: "private" }, allowed.db);
    expect(result.internalNotes).toBe("private");
  });

  it("updates with optimistic concurrency", async () => {
    const { db, updates } = fakeDb([[awardRow()]]);
    const result = await updateAward({
      access: STUDENT,
      awardId: AWARD_ID,
      expectedUpdatedAt: UPDATED_AT.toISOString(),
      title: "IMO Bronze Medal",
      commonAppRank: null,
    }, db);
    expect(result.title).toBe("IMO Bronze Medal");
    expect(updates[0]).toMatchObject({ table: admissionsAwards });
  });

  it("atomically replaces the Common App top-five order", async () => {
    const { db, updates, inserts } = fakeDb([[
      awardRow({ commonAppRank: 1 }),
      awardRow({ id: AWARD_B, commonAppRank: null }),
    ]]);
    await setCommonAppAwardRanks({ access: STUDENT, orderedIds: [AWARD_B, AWARD_ID] }, db);
    expect(updates).toHaveLength(3);
    expect(updates[0].set.commonAppRank).toBeNull();
    expect(updates[1].set.commonAppRank).toBe(1);
    expect(updates[2].set.commonAppRank).toBe(2);
    expect(inserts.find((call) => call.table === admissionsAuditLog)?.values)
      .toMatchObject({ entityType: "award_rank", action: "update" });
  });

  it("soft-deletes and redacts internal notes by default on reads", async () => {
    const deletion = fakeDb([[awardRow()]]);
    await softDeleteAward({ access: STUDENT, awardId: AWARD_ID }, deletion.db);
    expect(deletion.updates[0].set).toMatchObject({ commonAppRank: null });
    expect(deletion.updates[0].set.deletedAt).toBeInstanceOf(Date);

    const listing = fakeDb([[awardRow()]]);
    const redacted = await listAwardsForCase(CASE_ID, {}, listing.db);
    expect(redacted[0].internalNotes).toBeNull();
    const staffListing = fakeDb([[awardRow()]]);
    const full = await listAwardsForCase(CASE_ID, { includeInternalNotes: true }, staffListing.db);
    expect(full[0].internalNotes).toBe("Verify certificate.");
  });
});
