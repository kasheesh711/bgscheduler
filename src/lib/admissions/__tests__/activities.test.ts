import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsActivities, admissionsAuditLog } from "@/lib/db/schema";
import {
  createActivity,
  listActivitiesForCase,
  MAX_ACTIVE_ACTIVITIES_PER_CASE,
  MAX_COMMON_APP_RANKED_ACTIVITIES,
  setCommonAppRanks,
  softDeleteActivity,
  UC_ACTIVITY_CATEGORIES,
  updateActivity,
} from "@/lib/admissions/activities";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVITY_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVITY_ID_B = "33333333-3333-4333-8333-333333333333";
const ACTIVITY_ID_C = "44444444-4444-4444-8444-444444444444";
const FOREIGN_ID = "99999999-9999-4999-8999-999999999999";

const UPDATED_AT = new Date("2026-07-01T00:00:00Z");

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "staff@example.com",
  role: "counselor",
  isAdmin: false,
};

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const PARENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "parent@example.com",
  role: "parent",
  isAdmin: false,
};

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as essays.test.ts) with
 * insert/update recording and a native `transaction` that hands the same
 * fake back to withAuditedTransaction. Each db.select() resolves to the next
 * queued result — the queue order must match the function's query order.
 * Inserts synthesize a returning row from the given values plus defaults.
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  let generated = 0;
  const selectCalls: number[] = [];
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  function selectBuilder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "groupBy", "limit"]) {
      b[method] = () => b;
    }
    (b as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return b;
  }

  const tx = {
    select: () => {
      selectCalls.push(i);
      return selectBuilder(queue[i++] ?? []);
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = {
          id: `00000000-0000-4000-8000-${String(generated++).padStart(12, "0")}`,
          deletedAt: null,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-01T00:00:00Z"),
          ...values,
        };
        return {
          returning: () => Promise.resolve([row]),
          then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        const b: Record<string, unknown> = {};
        b.where = () => b;
        b.returning = () => Promise.resolve([]);
        (b as { then: unknown }).then = (
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve(undefined).then(resolve, reject);
        return b;
      },
    }),
  };

  const db = {
    ...tx,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  return { db: db as never, selectCalls, inserts, updates };
}

function auditInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsAuditLog).map((call) => call.values);
}

function activityInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsActivities).map((call) => call.values);
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVITY_ID,
    caseId: CASE_ID,
    name: "Robotics Club",
    fullDescription: null,
    commonApp: null,
    uc: null,
    commonAppRank: null,
    sortOrder: 0,
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

/** Queue entry for the cap-check count query inside createActivity. */
function liveCount(value: number) {
  return [{ value }];
}

describe("createActivity", () => {
  it("lets a student create an activity with valid platform blocks", async () => {
    const { db, inserts } = fakeDb([liveCount(0)]);

    const result = await createActivity(
      {
        access: STUDENT_ACCESS,
        name: "  Robotics Club  ",
        fullDescription: "Founded the club in grade 10.",
        commonApp: {
          position: "President",
          organization: "School Robotics Club",
          description: "Led a 12-member team to a national final.",
          hrsWeek: 6,
          weeksYear: 30,
          grades: ["10", "11", "12"],
          timing: "school_year",
        },
        uc: { description: "Team captain.", category: "extracurricular_activity" },
      },
      db,
    );

    const rows = activityInserts(inserts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: CASE_ID,
      name: "Robotics Club",
      fullDescription: "Founded the club in grade 10.",
      commonAppRank: null,
      sortOrder: 0,
    });
    expect(result.name).toBe("Robotics Club");
    expect(result.commonApp?.position).toBe("President");
    expect(result.uc?.category).toBe("extracurricular_activity");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "activity",
      action: "create",
    });
  });

  it("attributes a counselor creation via the audit actorRole", async () => {
    const { db, inserts } = fakeDb([liveCount(3)]);

    const result = await createActivity(
      { access: COUNSELOR_ACCESS, name: "Debate Team" },
      db,
    );

    // sortOrder defaults to the live count (append at end).
    expect(activityInserts(inserts)[0].sortOrder).toBe(3);
    expect(result.sortOrder).toBe(3);
    expect(auditInserts(inserts)[0]).toMatchObject({ actorRole: "counselor" });
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      createActivity({ access: PARENT_ACCESS, name: "Anything" }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects an empty name without touching the database", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(
      createActivity({ access: STUDENT_ACCESS, name: "   " }, db),
    ).rejects.toThrow("non-empty name");
    expect(selectCalls).toHaveLength(0);
  });

  // ── Common App char-limit boundaries (CM-70 hard limits) ──────────────

  it("accepts commonApp strings at exactly 50/100/150 chars", async () => {
    const { db, inserts } = fakeDb([liveCount(0)]);

    const result = await createActivity(
      {
        access: STUDENT_ACCESS,
        name: "Boundary",
        commonApp: {
          position: "p".repeat(50),
          organization: "o".repeat(100),
          description: "d".repeat(150),
        },
      },
      db,
    );

    expect(activityInserts(inserts)).toHaveLength(1);
    expect(result.commonApp?.position).toHaveLength(50);
    expect(result.commonApp?.organization).toHaveLength(100);
    expect(result.commonApp?.description).toHaveLength(150);
  });

  it("rejects a 51-char commonApp position (hard stop, no writes)", async () => {
    const { db, inserts } = fakeDb([]);

    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "X", commonApp: { position: "p".repeat(51) } },
        db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
    expect(inserts).toHaveLength(0);
  });

  it("rejects a 101-char commonApp organization", async () => {
    const { db } = fakeDb([]);

    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "X", commonApp: { organization: "o".repeat(101) } },
        db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
  });

  it("rejects a 151-char commonApp description", async () => {
    const { db } = fakeDb([]);

    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "X", commonApp: { description: "d".repeat(151) } },
        db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
  });

  it("accepts a uc description at exactly 350 chars", async () => {
    const { db, inserts } = fakeDb([liveCount(0)]);

    const result = await createActivity(
      { access: STUDENT_ACCESS, name: "X", uc: { description: "u".repeat(350) } },
      db,
    );

    expect(activityInserts(inserts)).toHaveLength(1);
    expect(result.uc?.description).toHaveLength(350);
  });

  it("rejects a 351-char uc description", async () => {
    const { db, inserts } = fakeDb([]);

    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "X", uc: { description: "u".repeat(351) } },
        db,
      ),
    ).rejects.toThrow("Invalid uc block");
    expect(inserts).toHaveLength(0);
  });

  // ── Numeric / enum boundaries ──────────────────────────────────────────

  it("accepts hrsWeek 0 and 168, rejects 169 and negatives", async () => {
    const ok = fakeDb([liveCount(0), liveCount(1)]);
    await createActivity(
      { access: STUDENT_ACCESS, name: "A", commonApp: { hrsWeek: 0 } },
      ok.db,
    );
    await createActivity(
      { access: STUDENT_ACCESS, name: "B", commonApp: { hrsWeek: 168 } },
      ok.db,
    );
    expect(activityInserts(ok.inserts)).toHaveLength(2);

    const bad = fakeDb([]);
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "C", commonApp: { hrsWeek: 169 } },
        bad.db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "D", commonApp: { hrsWeek: -1 } },
        bad.db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
  });

  it("accepts weeksYear 52, rejects 53 and non-integers", async () => {
    const ok = fakeDb([liveCount(0)]);
    await createActivity(
      { access: STUDENT_ACCESS, name: "A", commonApp: { weeksYear: 52 } },
      ok.db,
    );
    expect(activityInserts(ok.inserts)).toHaveLength(1);

    const bad = fakeDb([]);
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "B", commonApp: { weeksYear: 53 } },
        bad.db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "C", commonApp: { weeksYear: 12.5 } },
        bad.db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
  });

  it("accepts a grades subset and rejects unknown or duplicated grades", async () => {
    const ok = fakeDb([liveCount(0)]);
    const result = await createActivity(
      { access: STUDENT_ACCESS, name: "A", commonApp: { grades: ["9", "12", "post"] } },
      ok.db,
    );
    expect(result.commonApp?.grades).toEqual(["9", "12", "post"]);

    const bad = fakeDb([]);
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "B", commonApp: { grades: ["8" as never] } },
        bad.db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "C", commonApp: { grades: ["9", "9"] } },
        bad.db,
      ),
    ).rejects.toThrow("duplicate grade levels");
  });

  it("rejects an unknown timing and unknown block keys (strict shape)", async () => {
    const { db } = fakeDb([]);

    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "A", commonApp: { timing: "sometimes" as never } },
        db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "B", commonApp: { rank: 1 } as never },
        db,
      ),
    ).rejects.toThrow("Invalid commonApp block");
  });

  it("accepts every official UC category and rejects unknown ones", async () => {
    const { db, inserts } = fakeDb(
      UC_ACTIVITY_CATEGORIES.map((_, index) => liveCount(index)),
    );

    for (const category of UC_ACTIVITY_CATEGORIES) {
      await createActivity(
        { access: STUDENT_ACCESS, name: `UC ${category}`, uc: { category } },
        db,
      );
    }
    expect(activityInserts(inserts)).toHaveLength(UC_ACTIVITY_CATEGORIES.length);

    const bad = fakeDb([]);
    await expect(
      createActivity(
        { access: STUDENT_ACCESS, name: "X", uc: { category: "hobby" as never } },
        bad.db,
      ),
    ).rejects.toThrow("Invalid uc block");
  });

  // ── Cap (CM-70 "≤ ~20") ────────────────────────────────────────────────

  it("refuses the 21st live activity with Conflict and writes nothing", async () => {
    const { db, inserts } = fakeDb([liveCount(MAX_ACTIVE_ACTIVITIES_PER_CASE)]);

    await expect(
      createActivity({ access: STUDENT_ACCESS, name: "One too many" }, db),
    ).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("allows the 20th activity (cap is >= at 20 live rows)", async () => {
    const { db, inserts } = fakeDb([liveCount(MAX_ACTIVE_ACTIVITIES_PER_CASE - 1)]);

    await createActivity({ access: STUDENT_ACCESS, name: "Number twenty" }, db);

    expect(activityInserts(inserts)).toHaveLength(1);
  });
});

describe("updateActivity", () => {
  it("lets a student edit name and blocks with an audited diff", async () => {
    const { db, inserts, updates } = fakeDb([[activityRow()]]);

    const result = await updateActivity(
      {
        access: STUDENT_ACCESS,
        activityId: ACTIVITY_ID,
        name: "Robotics Team",
        commonApp: { position: "Captain" },
      },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsActivities);
    expect(updates[0].set).toMatchObject({
      name: "Robotics Team",
      commonApp: { position: "Captain" },
    });
    expect(result.name).toBe("Robotics Team");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "activity",
      action: "update",
      diff: {
        name: { old: "Robotics Club", new: "Robotics Team" },
        commonApp: { old: null, new: { position: "Captain" } },
      },
    });
  });

  it("attributes a counselor override via the audit actorRole", async () => {
    const { db, inserts } = fakeDb([[activityRow()]]);

    await updateActivity(
      { access: COUNSELOR_ACCESS, activityId: ACTIVITY_ID, name: "Renamed by staff" },
      db,
    );

    expect(auditInserts(inserts)[0]).toMatchObject({ actorRole: "counselor" });
  });

  it("enforces hard char limits on update too (351-char uc rejected)", async () => {
    const { db, updates } = fakeDb([]);

    await expect(
      updateActivity(
        { access: STUDENT_ACCESS, activityId: ACTIVITY_ID, uc: { description: "u".repeat(351) } },
        db,
      ),
    ).rejects.toThrow("Invalid uc block");
    expect(updates).toHaveLength(0);
  });

  it("throws Conflict when expectedUpdatedAt mismatches and writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([[activityRow()]]);

    await expect(
      updateActivity(
        {
          access: STUDENT_ACCESS,
          activityId: ACTIVITY_ID,
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
          name: "New name",
        },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("proceeds when expectedUpdatedAt matches the current token", async () => {
    const { db, updates } = fakeDb([[activityRow()]]);

    await updateActivity(
      {
        access: STUDENT_ACCESS,
        activityId: ACTIVITY_ID,
        expectedUpdatedAt: UPDATED_AT.toISOString(),
        name: "New name",
      },
      db,
    );

    expect(updates).toHaveLength(1);
  });

  it("no-ops without writes when nothing changed (idempotent save)", async () => {
    const { db, inserts, updates } = fakeDb([
      [activityRow({ commonApp: { position: "President" } })],
    ]);

    await updateActivity(
      {
        access: STUDENT_ACCESS,
        activityId: ACTIVITY_ID,
        name: "Robotics Club",
        commonApp: { position: "President" },
      },
      db,
    );

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("clears a block with an explicit null (audited old→null)", async () => {
    const { db, inserts, updates } = fakeDb([
      [activityRow({ uc: { description: "Old", category: "work_experience" } })],
    ]);

    await updateActivity(
      { access: STUDENT_ACCESS, activityId: ACTIVITY_ID, uc: null },
      db,
    );

    expect(updates[0].set.uc).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({
      diff: { uc: { old: { description: "Old", category: "work_experience" }, new: null } },
    });
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      updateActivity({ access: PARENT_ACCESS, activityId: ACTIVITY_ID, name: "X" }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("throws NotFound for a missing or malformed activityId", async () => {
    const missing = fakeDb([[]]);
    await expect(
      updateActivity({ access: STUDENT_ACCESS, activityId: ACTIVITY_ID, name: "X" }, missing.db),
    ).rejects.toThrow("NotFound");

    const malformed = fakeDb([]);
    await expect(
      updateActivity({ access: STUDENT_ACCESS, activityId: "nope", name: "X" }, malformed.db),
    ).rejects.toThrow("NotFound");
  });
});

describe("softDeleteActivity", () => {
  it("lets a student delete an own-case activity (they own the list)", async () => {
    const { db, inserts, updates } = fakeDb([[activityRow({ commonAppRank: 3 })]]);

    await softDeleteActivity({ access: STUDENT_ACCESS, activityId: ACTIVITY_ID }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsActivities);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);
    // The held Common App rank is released so the top-10 never counts a
    // deleted row (CM-71).
    expect(updates[0].set.commonAppRank).toBeNull();

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "activity",
      action: "delete",
      actorRole: "student",
      diff: { commonAppRank: { old: 3, new: null } },
    });
  });

  it("attributes a counselor delete via the audit actorRole", async () => {
    const { db, inserts } = fakeDb([[activityRow()]]);

    await softDeleteActivity({ access: COUNSELOR_ACCESS, activityId: ACTIVITY_ID }, db);

    expect(auditInserts(inserts)[0]).toMatchObject({ actorRole: "counselor" });
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteActivity({ access: PARENT_ACCESS, activityId: ACTIVITY_ID }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("throws NotFound for a malformed activityId", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteActivity({ access: STUDENT_ACCESS, activityId: "nope" }, db),
    ).rejects.toThrow("NotFound");
  });
});

describe("setCommonAppRanks", () => {
  function rankRow(id: string, commonAppRank: number | null) {
    return { id, commonAppRank };
  }

  it("assigns rank 1..n in order and clears unlisted ranks (CM-71)", async () => {
    const { db, inserts, updates } = fakeDb([[
      rankRow(ACTIVITY_ID, null),
      rankRow(ACTIVITY_ID_B, 1),
      rankRow(ACTIVITY_ID_C, 2),
    ]]);

    await setCommonAppRanks(
      { access: STUDENT_ACCESS, orderedIds: [ACTIVITY_ID_C, ACTIVITY_ID] },
      db,
    );

    // Two re-ranks (in rank order) + one batched clear for the de-listed row.
    expect(updates).toHaveLength(3);
    expect(updates[0].set.commonAppRank).toBe(1);
    expect(updates[1].set.commonAppRank).toBe(2);
    expect(updates[2].set.commonAppRank).toBeNull();

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorRole: "student",
      entityType: "activity_ranks",
      entityId: CASE_ID,
      action: "update",
      diff: {
        [ACTIVITY_ID_C]: { old: 2, new: 1 },
        [ACTIVITY_ID]: { old: null, new: 2 },
        [ACTIVITY_ID_B]: { old: 1, new: null },
      },
    });
  });

  it("rejects 11 ids before touching the database", async () => {
    const { db, selectCalls } = fakeDb([]);
    const eleven = Array.from(
      { length: MAX_COMMON_APP_RANKED_ACTIVITIES + 1 },
      (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    );

    await expect(
      setCommonAppRanks({ access: STUDENT_ACCESS, orderedIds: eleven }, db),
    ).rejects.toThrow("at most 10");
    expect(selectCalls).toHaveLength(0);
  });

  it("accepts exactly 10 ids", async () => {
    const ten = Array.from(
      { length: MAX_COMMON_APP_RANKED_ACTIVITIES },
      (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    );
    const { db, updates } = fakeDb([ten.map((id) => rankRow(id, null))]);

    await setCommonAppRanks({ access: STUDENT_ACCESS, orderedIds: ten }, db);

    expect(updates).toHaveLength(10);
    expect(updates.map((call) => call.set.commonAppRank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("rejects an id that is not a live activity of the case (NotFound, no writes)", async () => {
    const { db, updates, inserts } = fakeDb([[rankRow(ACTIVITY_ID, null)]]);

    await expect(
      setCommonAppRanks({ access: STUDENT_ACCESS, orderedIds: [FOREIGN_ID] }, db),
    ).rejects.toThrow("NotFound");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("rejects duplicate and non-uuid-shaped ids up front", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(
      setCommonAppRanks(
        { access: STUDENT_ACCESS, orderedIds: [ACTIVITY_ID, ACTIVITY_ID] },
        db,
      ),
    ).rejects.toThrow("Duplicate activity ids");
    await expect(
      setCommonAppRanks({ access: STUDENT_ACCESS, orderedIds: ["nope"] }, db),
    ).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });

  it("is idempotent: re-submitting the current order writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([[
      rankRow(ACTIVITY_ID, 1),
      rankRow(ACTIVITY_ID_B, 2),
      rankRow(ACTIVITY_ID_C, null),
    ]]);

    await setCommonAppRanks(
      { access: STUDENT_ACCESS, orderedIds: [ACTIVITY_ID, ACTIVITY_ID_B] },
      db,
    );

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("clears every rank when given an empty list", async () => {
    const { db, inserts, updates } = fakeDb([[
      rankRow(ACTIVITY_ID, 1),
      rankRow(ACTIVITY_ID_B, 2),
    ]]);

    await setCommonAppRanks({ access: STUDENT_ACCESS, orderedIds: [] }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set.commonAppRank).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({
      diff: {
        [ACTIVITY_ID]: { old: 1, new: null },
        [ACTIVITY_ID_B]: { old: 2, new: null },
      },
    });
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      setCommonAppRanks({ access: PARENT_ACCESS, orderedIds: [ACTIVITY_ID] }, db),
    ).rejects.toThrow("Forbidden");
  });
});

describe("listActivitiesForCase", () => {
  it("sorts ranked rows first by rank, then the rest by sortOrder", async () => {
    const { db } = fakeDb([[
      activityRow({ id: ACTIVITY_ID, commonAppRank: 2, sortOrder: 0 }),
      activityRow({ id: ACTIVITY_ID_B, commonAppRank: 1, sortOrder: 5 }),
      activityRow({ id: ACTIVITY_ID_C, commonAppRank: null, sortOrder: 1 }),
      activityRow({ id: FOREIGN_ID, commonAppRank: null, sortOrder: 0 }),
    ]]);

    const rows = await listActivitiesForCase(CASE_ID, db);

    expect(rows.map((row) => row.id)).toEqual([
      ACTIVITY_ID_B,
      ACTIVITY_ID,
      FOREIGN_ID,
      ACTIVITY_ID_C,
    ]);
  });

  it("reads a malformed stored block as null (fail-closed), keeping valid ones", async () => {
    const { db } = fakeDb([[
      activityRow({
        commonApp: { position: 123 },
        uc: { description: "Fine", category: "work_experience" },
      }),
    ]]);

    const rows = await listActivitiesForCase(CASE_ID, db);

    expect(rows[0].commonApp).toBeNull();
    expect(rows[0].uc).toEqual({ description: "Fine", category: "work_experience" });
  });

  it("fails closed to an empty list for a malformed caseId", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await listActivitiesForCase("not-a-uuid", db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});
