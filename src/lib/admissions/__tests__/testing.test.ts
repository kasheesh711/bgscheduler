import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsCollegeDocs,
  admissionsTestSittings,
} from "@/lib/db/schema";
import {
  collectTestingDeadlineEntries,
  collectTestingDeadlines,
  createSitting,
  deriveRegistrationDeadline,
  getBestScores,
  listSittingsForCase,
  parseScoreValue,
  REGISTRATION_LEAD_DAYS,
  softDeleteSitting,
  updateSitting,
} from "@/lib/admissions/testing";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CASE_ID = "55555555-5555-4555-8555-555555555555";
const SITTING_ID = "22222222-2222-4222-8222-222222222222";
const SITTING_ID_B = "33333333-3333-4333-8333-333333333333";
const SITTING_ID_C = "44444444-4444-4444-8444-444444444444";
const DOC_ID = "66666666-6666-4666-8666-666666666666";

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

interface DeleteCall {
  table: unknown;
}

/**
 * Chainable Drizzle stand-in (same style as essays.test.ts) with
 * insert/update/delete recording and a native `transaction` that hands the
 * same fake back to withAuditedTransaction. Each db.select() resolves to the
 * next queued result — the queue order must match the function's query order.
 * Inserts synthesize a returning row from the given values plus defaults.
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  let generated = 0;
  const selectCalls: number[] = [];
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  const deletes: DeleteCall[] = [];

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
    delete: (table: unknown) => {
      deletes.push({ table });
      const b: Record<string, unknown> = {};
      b.where = () => b;
      (b as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(undefined).then(resolve, reject);
      return b;
    },
  };

  const db = {
    ...tx,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  return { db: db as never, selectCalls, inserts, updates, deletes };
}

function auditInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsAuditLog).map((call) => call.values);
}

function sittingInserts(inserts: InsertCall[]) {
  return inserts
    .filter((call) => call.table === admissionsTestSittings)
    .map((call) => call.values);
}

function sittingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SITTING_ID,
    caseId: CASE_ID,
    testType: "sat",
    testDate: "2026-11-07",
    // The still-auto value for (sat, 2026-11-07): 35 days earlier.
    registrationDeadline: "2026-10-03",
    targetScore: "1500",
    actualScore: null,
    scoreReleasedToParent: false,
    accommodations: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("deriveRegistrationDeadline", () => {
  it("derives SAT/ACT deadlines 35 days before the test date", async () => {
    expect(REGISTRATION_LEAD_DAYS.sat).toBe(35);
    expect(REGISTRATION_LEAD_DAYS.act).toBe(35);
    expect(deriveRegistrationDeadline("sat", "2026-11-07")).toBe("2026-10-03");
    expect(deriveRegistrationDeadline("act", "2026-11-07")).toBe("2026-10-03");
  });

  it("derives TOEFL/IELTS deadlines 14 days before the test date", async () => {
    expect(REGISTRATION_LEAD_DAYS.toefl).toBe(14);
    expect(REGISTRATION_LEAD_DAYS.ielts).toBe(14);
    expect(deriveRegistrationDeadline("toefl", "2026-08-15")).toBe("2026-08-01");
    expect(deriveRegistrationDeadline("ielts", "2026-08-15")).toBe("2026-08-01");
  });

  it("derives null for school-managed AP/IB and unknown 'other'", async () => {
    expect(REGISTRATION_LEAD_DAYS.ap).toBeNull();
    expect(REGISTRATION_LEAD_DAYS.ib).toBeNull();
    expect(REGISTRATION_LEAD_DAYS.other).toBeNull();
    expect(deriveRegistrationDeadline("ap", "2027-05-06")).toBeNull();
    expect(deriveRegistrationDeadline("ib", "2027-05-06")).toBeNull();
    expect(deriveRegistrationDeadline("other", "2027-05-06")).toBeNull();
  });

  it("crosses month and year boundaries correctly", async () => {
    expect(deriveRegistrationDeadline("sat", "2027-01-10")).toBe("2026-12-06");
  });

  it("throws on a malformed test date", async () => {
    expect(() => deriveRegistrationDeadline("sat", "soon")).toThrow("Invalid testDate");
  });
});

describe("createSitting", () => {
  it("lets a student create a sitting with an auto-derived deadline", async () => {
    const { db, inserts } = fakeDb([]);

    const result = await createSitting(
      {
        access: STUDENT_ACCESS,
        testType: "sat",
        testDate: "2026-11-07",
        targetScore: " 1500 ",
        accommodations: "  extra time  ",
      },
      db,
    );

    const rows = sittingInserts(inserts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: CASE_ID,
      testType: "sat",
      testDate: "2026-11-07",
      registrationDeadline: "2026-10-03",
      targetScore: "1500",
      actualScore: null,
      scoreReleasedToParent: false,
      accommodations: "extra time",
    });
    expect(result.registrationDeadline).toBe("2026-10-03");
    expect(result.scoreReleasedToParent).toBe(false);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "test_sitting",
      action: "create",
    });
  });

  it("derives a null deadline for school-managed AP sittings", async () => {
    const { db, inserts } = fakeDb([]);

    const result = await createSitting(
      { access: COUNSELOR_ACCESS, testType: "ap", testDate: "2027-05-06" },
      db,
    );

    expect(sittingInserts(inserts)[0].registrationDeadline).toBeNull();
    expect(result.registrationDeadline).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({ actorRole: "counselor" });
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db, inserts } = fakeDb([]);

    await expect(
      createSitting({ access: PARENT_ACCESS, testType: "sat", testDate: "2026-11-07" }, db),
    ).rejects.toThrow("Forbidden");
    expect(inserts).toHaveLength(0);
  });

  it("rejects an unknown test type and a malformed test date", async () => {
    const { db } = fakeDb([]);

    await expect(
      createSitting(
        { access: STUDENT_ACCESS, testType: "gre" as never, testDate: "2026-11-07" },
        db,
      ),
    ).rejects.toThrow("Invalid testType");
    await expect(
      createSitting({ access: STUDENT_ACCESS, testType: "sat", testDate: "November" }, db),
    ).rejects.toThrow("Invalid testDate");
  });
});

describe("updateSitting", () => {
  it("lets a student edit dates, target, and actual scores (audited)", async () => {
    const { db, inserts, updates } = fakeDb([[sittingRow({ registrationDeadline: null })]]);

    const result = await updateSitting(
      {
        access: STUDENT_ACCESS,
        sittingId: SITTING_ID,
        targetScore: "1550",
        actualScore: "1490",
      },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsTestSittings);
    expect(updates[0].set).toMatchObject({ targetScore: "1550", actualScore: "1490" });
    expect(result.actualScore).toBe("1490");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "test_sitting",
      action: "update",
      diff: {
        targetScore: { old: "1500", new: "1550" },
        actualScore: { old: null, new: "1490" },
      },
    });
  });

  it("rejects a student setting the release flag with Forbidden (CM-83)", async () => {
    const { db, inserts, updates } = fakeDb([]);

    await expect(
      updateSitting(
        { access: STUDENT_ACCESS, sittingId: SITTING_ID, scoreReleasedToParent: true },
        db,
      ),
    ).rejects.toThrow("Forbidden");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("rejects a parent setting the release flag with Forbidden (CM-83)", async () => {
    const { db } = fakeDb([]);

    await expect(
      updateSitting(
        { access: PARENT_ACCESS, sittingId: SITTING_ID, scoreReleasedToParent: true },
        db,
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("lets a counselor set the release flag (audited attribution)", async () => {
    const { db, inserts, updates } = fakeDb([[sittingRow()]]);

    const result = await updateSitting(
      { access: COUNSELOR_ACCESS, sittingId: SITTING_ID, scoreReleasedToParent: true },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set.scoreReleasedToParent).toBe(true);
    expect(result.scoreReleasedToParent).toBe(true);
    expect(auditInserts(inserts)[0]).toMatchObject({
      actorRole: "counselor",
      diff: { scoreReleasedToParent: { old: false, new: true } },
    });
  });

  it("re-derives a still-auto deadline when the test date moves", async () => {
    // Stored deadline equals derive(sat, 2026-11-07) → still auto.
    const { db, updates } = fakeDb([[sittingRow()]]);

    const result = await updateSitting(
      { access: STUDENT_ACCESS, sittingId: SITTING_ID, testDate: "2026-12-05" },
      db,
    );

    expect(updates[0].set).toMatchObject({
      testDate: "2026-12-05",
      registrationDeadline: "2026-10-31",
    });
    expect(result.registrationDeadline).toBe("2026-10-31");
  });

  it("never clobbers a manually edited deadline on a date move", async () => {
    // Stored deadline differs from derive(sat, 2026-11-07) → manual edit.
    const { db, updates } = fakeDb([[sittingRow({ registrationDeadline: "2026-09-01" })]]);

    const result = await updateSitting(
      { access: STUDENT_ACCESS, sittingId: SITTING_ID, testDate: "2026-12-05" },
      db,
    );

    expect(updates[0].set.testDate).toBe("2026-12-05");
    expect("registrationDeadline" in updates[0].set).toBe(false);
    expect(result.registrationDeadline).toBe("2026-09-01");
  });

  it("lets an explicit registrationDeadline always win", async () => {
    const { db, updates } = fakeDb([[sittingRow()]]);

    await updateSitting(
      {
        access: STUDENT_ACCESS,
        sittingId: SITTING_ID,
        testDate: "2026-12-05",
        registrationDeadline: "2026-11-20",
      },
      db,
    );

    expect(updates[0].set).toMatchObject({
      testDate: "2026-12-05",
      registrationDeadline: "2026-11-20",
    });
  });

  it("throws Conflict when expectedUpdatedAt mismatches and writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([[sittingRow()]]);

    await expect(
      updateSitting(
        {
          access: STUDENT_ACCESS,
          sittingId: SITTING_ID,
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
          targetScore: "1600",
        },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("proceeds when expectedUpdatedAt matches the current token", async () => {
    const { db, updates } = fakeDb([[sittingRow()]]);

    await updateSitting(
      {
        access: STUDENT_ACCESS,
        sittingId: SITTING_ID,
        expectedUpdatedAt: UPDATED_AT.toISOString(),
        targetScore: "1600",
      },
      db,
    );

    expect(updates).toHaveLength(1);
  });

  it("no-ops without writes when nothing changed", async () => {
    const { db, inserts, updates } = fakeDb([[sittingRow()]]);

    await updateSitting(
      { access: STUDENT_ACCESS, sittingId: SITTING_ID, targetScore: "1500" },
      db,
    );

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws NotFound for a missing sitting", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      updateSitting({ access: STUDENT_ACCESS, sittingId: SITTING_ID, targetScore: "1" }, db),
    ).rejects.toThrow("NotFound");
  });
});

describe("softDeleteSitting", () => {
  it("deletes the sitting plus dependent score-send docs, audited", async () => {
    // Queue: [sitting row], [score-send doc ids].
    const { db, inserts, deletes } = fakeDb([[sittingRow()], [{ id: DOC_ID }]]);

    await softDeleteSitting({ access: STUDENT_ACCESS, sittingId: SITTING_ID }, db);

    expect(deletes.map((call) => call.table)).toEqual([
      admissionsCollegeDocs,
      admissionsTestSittings,
    ]);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "test_sitting",
      action: "delete",
      actorRole: "student",
    });
    const diff = audits[0].diff as Record<string, { old: unknown; new: unknown }>;
    expect(diff.deleted.old).toMatchObject({ id: SITTING_ID, testType: "sat" });
    expect(diff.removedScoreSendDocIds.old).toEqual([DOC_ID]);
  });

  it("skips the doc delete when no score sends reference the sitting", async () => {
    const { db, inserts, deletes } = fakeDb([[sittingRow()], []]);

    await softDeleteSitting({ access: COUNSELOR_ACCESS, sittingId: SITTING_ID }, db);

    expect(deletes.map((call) => call.table)).toEqual([admissionsTestSittings]);
    const diff = auditInserts(inserts)[0].diff as Record<string, unknown>;
    expect("removedScoreSendDocIds" in diff).toBe(false);
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteSitting({ access: PARENT_ACCESS, sittingId: SITTING_ID }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("throws NotFound for a malformed sittingId", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteSitting({ access: STUDENT_ACCESS, sittingId: "nope" }, db),
    ).rejects.toThrow("NotFound");
  });
});

describe("listSittingsForCase", () => {
  // 2026-12-01 00:00 UTC = 2026-12-01 07:00 Asia/Bangkok → today is 2026-12-01.
  const NOW = new Date("2026-12-01T00:00:00Z");

  it("orders upcoming sittings first (soonest first), then past (recent first)", async () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const d = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const e = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const { db } = fakeDb([[
      sittingRow({ id: a, testDate: "2026-10-01" }),
      sittingRow({ id: b, testDate: "2026-11-20" }),
      sittingRow({ id: c, testDate: "2026-12-01" }),
      sittingRow({ id: d, testDate: "2027-01-10" }),
      sittingRow({ id: e, testDate: "2026-12-15" }),
    ]]);

    const rows = await listSittingsForCase(CASE_ID, { now: NOW }, db);

    expect(rows.map((row) => row.testDate)).toEqual([
      "2026-12-01",
      "2026-12-15",
      "2027-01-10",
      "2026-11-20",
      "2026-10-01",
    ]);
    expect(rows.map((row) => row.id)).toEqual([c, e, d, b, a]);
  });

  it("fails closed to an empty list for a malformed caseId", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await listSittingsForCase("not-a-uuid", { now: NOW }, db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("parseScoreValue", () => {
  it("parses plain numeric scores and rejects annotated strings", async () => {
    expect(parseScoreValue(" 1450 ")).toBe(1450);
    expect(parseScoreValue("7.5")).toBe(7.5);
    expect(parseScoreValue("1450 (superscore)")).toBeNull();
    expect(parseScoreValue("pending")).toBeNull();
    expect(parseScoreValue("")).toBeNull();
  });
});

describe("getBestScores", () => {
  it("returns the max numeric score per test type in canonical order", async () => {
    const { db } = fakeDb([[
      { id: SITTING_ID, testType: "act", testDate: "2026-09-12", actualScore: "31", scoreReleasedToParent: false },
      { id: SITTING_ID_B, testType: "sat", testDate: "2026-08-22", actualScore: "1380", scoreReleasedToParent: false },
      { id: SITTING_ID_C, testType: "sat", testDate: "2026-11-07", actualScore: "1450", scoreReleasedToParent: true },
      { id: DOC_ID, testType: "ielts", testDate: "2026-10-03", actualScore: "7.5", scoreReleasedToParent: false },
    ]]);

    const best = await getBestScores(CASE_ID, db);

    expect(best.map((entry) => entry.testType)).toEqual(["sat", "act", "ielts"]);
    expect(best[0]).toEqual({
      testType: "sat",
      sittingId: SITTING_ID_C,
      testDate: "2026-11-07",
      actualScore: "1450",
      numericScore: 1450,
      scoreReleasedToParent: true,
    });
    expect(best[1].numericScore).toBe(31);
    expect(best[2].numericScore).toBe(7.5);
  });

  it("skips non-numeric scores (fail-closed) instead of comparing strings", async () => {
    const { db } = fakeDb([[
      // Lexically "999" > "1450" — numeric parsing must win.
      { id: SITTING_ID, testType: "sat", testDate: "2026-08-22", actualScore: "999", scoreReleasedToParent: false },
      { id: SITTING_ID_B, testType: "sat", testDate: "2026-11-07", actualScore: "1450", scoreReleasedToParent: false },
      { id: SITTING_ID_C, testType: "act", testDate: "2026-09-12", actualScore: "TBD", scoreReleasedToParent: false },
    ]]);

    const best = await getBestScores(CASE_ID, db);

    expect(best).toHaveLength(1);
    expect(best[0]).toMatchObject({ testType: "sat", numericScore: 1450 });
  });

  it("breaks score ties by the later test date", async () => {
    const { db } = fakeDb([[
      { id: SITTING_ID, testType: "sat", testDate: "2026-08-22", actualScore: "1450", scoreReleasedToParent: false },
      { id: SITTING_ID_B, testType: "sat", testDate: "2026-11-07", actualScore: "1450", scoreReleasedToParent: true },
    ]]);

    const best = await getBestScores(CASE_ID, db);

    expect(best[0]).toMatchObject({ sittingId: SITTING_ID_B, testDate: "2026-11-07" });
  });

  it("fails closed to an empty list for a malformed caseId", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await getBestScores("nope", db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("collectTestingDeadlineEntries", () => {
  it("emits registration + sitting entries across a batch in one query", async () => {
    const { db, selectCalls } = fakeDb([[
      {
        id: SITTING_ID,
        caseId: CASE_ID,
        testType: "sat",
        testDate: "2026-11-07",
        registrationDeadline: "2026-10-03",
        actualScore: null,
      },
      {
        id: SITTING_ID_B,
        caseId: OTHER_CASE_ID,
        testType: "ap",
        testDate: "2027-05-06",
        registrationDeadline: null,
        actualScore: "5",
      },
    ]]);

    const entries = await collectTestingDeadlineEntries([CASE_ID, OTHER_CASE_ID], db);

    expect(selectCalls).toHaveLength(1);
    expect(entries).toEqual([
      {
        id: `${SITTING_ID}:registration`,
        caseId: CASE_ID,
        source: "testing",
        title: "SAT registration deadline",
        date: "2026-10-03",
        ownerRole: "student",
        completed: false,
      },
      {
        id: `${SITTING_ID}:sitting`,
        caseId: CASE_ID,
        source: "testing",
        title: "SAT sitting",
        date: "2026-11-07",
        ownerRole: "student",
        completed: false,
      },
      {
        // No registration entry: AP has no deadline. Scored → completed.
        id: `${SITTING_ID_B}:sitting`,
        caseId: OTHER_CASE_ID,
        source: "testing",
        title: "AP sitting",
        date: "2027-05-06",
        ownerRole: "student",
        completed: true,
      },
    ]);
  });

  it("drops malformed caseIds and returns [] without querying when none remain", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await collectTestingDeadlineEntries(["nope"], db)).toEqual([]);
    expect(await collectTestingDeadlineEntries([], db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("collectTestingDeadlines", () => {
  // 2026-12-01 00:00 UTC = 2026-12-01 07:00 Asia/Bangkok → today is 2026-12-01.
  const NOW = new Date("2026-12-01T00:00:00Z");
  const WINDOW = { from: "2026-11-01", to: "2027-01-31" };

  it("windows registration deadlines and test dates, stamping overdue", async () => {
    const { db } = fakeDb([[
      {
        // Registration deadline (2026-10-31) falls BEFORE the window → only
        // the sitting entry survives the window filter.
        id: SITTING_ID,
        caseId: CASE_ID,
        testType: "sat",
        testDate: "2026-12-05",
        registrationDeadline: "2026-10-31",
        actualScore: null,
      },
      {
        // Past test date inside the window, unscored → overdue.
        id: SITTING_ID_B,
        caseId: CASE_ID,
        testType: "toefl",
        testDate: "2026-11-10",
        registrationDeadline: "2026-10-27",
        actualScore: null,
      },
      {
        // Both dates inside the window, in the future.
        id: SITTING_ID_C,
        caseId: CASE_ID,
        testType: "act",
        testDate: "2027-01-20",
        registrationDeadline: "2026-12-16",
        actualScore: null,
      },
    ]]);

    const items = await collectTestingDeadlines(CASE_ID, WINDOW, NOW, db);

    expect(items.map((item) => [item.id, item.date])).toEqual([
      [`${SITTING_ID_B}:sitting`, "2026-11-10"],
      [`${SITTING_ID}:sitting`, "2026-12-05"],
      [`${SITTING_ID_C}:registration`, "2026-12-16"],
      [`${SITTING_ID_C}:sitting`, "2027-01-20"],
    ]);
    expect(items[0]).toMatchObject({
      source: "testing",
      title: "TOEFL sitting",
      overdue: true,
      completed: false,
      ownerRole: "student",
    });
    expect(items[1]).toMatchObject({ overdue: false });
    expect(items[2]).toMatchObject({ title: "ACT registration deadline", overdue: false });
  });

  it("marks scored sittings completed and never overdue", async () => {
    const { db } = fakeDb([[
      {
        id: SITTING_ID,
        caseId: CASE_ID,
        testType: "ielts",
        testDate: "2026-11-15",
        registrationDeadline: "2026-11-01",
        actualScore: "7.5",
      },
    ]]);

    const items = await collectTestingDeadlines(CASE_ID, WINDOW, NOW, db);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.completed)).toBe(true);
    expect(items.every((item) => !item.overdue)).toBe(true);
  });

  it("filters rows outside the window", async () => {
    const { db } = fakeDb([[
      {
        id: SITTING_ID,
        caseId: CASE_ID,
        testType: "sat",
        testDate: "2026-10-03",
        registrationDeadline: "2026-08-29",
        actualScore: null,
      },
    ]]);

    expect(await collectTestingDeadlines(CASE_ID, WINDOW, NOW, db)).toEqual([]);
  });

  it("throws on an inverted window", async () => {
    const { db } = fakeDb([]);

    await expect(
      collectTestingDeadlines(CASE_ID, { from: "2027-01-01", to: "2026-01-01" }, NOW, db),
    ).rejects.toThrow("from must be on or before to");
  });

  it("throws NotFound for a malformed caseId", async () => {
    const { db } = fakeDb([]);

    await expect(collectTestingDeadlines("nope", WINDOW, NOW, db)).rejects.toThrow("NotFound");
  });
});
