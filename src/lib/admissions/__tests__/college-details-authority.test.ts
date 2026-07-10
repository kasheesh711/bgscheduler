import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  createCollegeRequirement,
  upsertCollegeResearch,
  upsertFinancialAidOffer,
  updateCollegeRequirement,
} from "@/lib/admissions/college-details";
import {
  admissionsCollegeListItems,
  admissionsCollegeRequirements,
  admissionsCollegeResearch,
  admissionsFinancialAidOffers,
} from "@/lib/db/schema";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const REQUIREMENT_ID = "33333333-3333-4333-8333-333333333333";
const RESEARCH_ID = "44444444-4444-4444-8444-444444444444";
const AID_ID = "55555555-5555-4555-8555-555555555555";
const STUDENT_ACCESS = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student" as const,
  isAdmin: false,
};
const COUNSELOR_ACCESS = {
  caseId: CASE_ID,
  email: "counselor@example.com",
  role: "counselor" as const,
  isAdmin: false,
};

function lockingDb(queue: unknown[][]) {
  let index = 0;
  const locks: Array<{ table: unknown; strength: string }> = [];

  const tx = {
    select: () => {
      const rows = queue[index++] ?? [];
      let table: unknown;
      const builder: Record<string, unknown> = {};
      builder.from = (selectedTable: unknown) => {
        table = selectedTable;
        return builder;
      };
      for (const method of ["where", "limit", "orderBy"]) {
        builder[method] = () => builder;
      }
      builder.for = (strength: string) => {
        locks.push({ table, strength });
        return builder;
      };
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        let rows: unknown[] = [];
        const timestamps = {
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-01T00:00:00Z"),
        };
        if (table === admissionsCollegeResearch) {
          rows = [{ id: RESEARCH_ID, ...timestamps, ...values }];
        } else if (table === admissionsFinancialAidOffers) {
          rows = [{ id: AID_ID, ...timestamps, ...values }];
        }
        return {
          returning: () => Promise.resolve(rows),
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (error: unknown) => unknown,
          ) => Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    }),
    delete: vi.fn(),
  };
  const db = {
    ...tx,
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
  };
  return { db: db as never, locks };
}

describe("college requirement mutation authority", () => {
  it("does not let a student define a new requirement", async () => {
    await expect(createCollegeRequirement({
      access: STUDENT_ACCESS,
      listItemId: ITEM_ID,
      kind: "portfolio",
      title: "Submit portfolio",
      owner: "student",
    }, {} as never)).rejects.toThrow("Forbidden");
  });

  it.each([
    { title: "Changed title" },
    { dueDate: "2026-11-01" },
    { sourceUrl: "https://example.edu" },
    { notes: "Changed notes" },
    { sortOrder: 2 },
  ])("lets a student change only status, not requirement definition fields: %j", async (change) => {
    await expect(updateCollegeRequirement({
      access: STUDENT_ACCESS,
      listItemId: ITEM_ID,
      requirementId: REQUIREMENT_ID,
      ...change,
    }, {} as never)).rejects.toThrow("Forbidden");
  });

  it("locks the requirement row before applying a shared status update", async () => {
    const requirement = {
      id: REQUIREMENT_ID,
      listItemId: ITEM_ID,
      kind: "portfolio",
      title: "Submit portfolio",
      status: "not_started",
      owner: "student",
      dueDate: null,
      required: true,
      sourceUrl: null,
      notes: null,
      sortOrder: 0,
      verifiedByEmail: null,
      verifiedAt: null,
      deletedAt: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:00:00Z"),
    };
    const { db, locks } = lockingDb([[{ id: ITEM_ID }], [requirement]]);

    await updateCollegeRequirement({
      access: STUDENT_ACCESS,
      listItemId: ITEM_ID,
      requirementId: REQUIREMENT_ID,
      status: "done",
    }, db);

    expect(locks).toEqual([{ table: admissionsCollegeRequirements, strength: "update" }]);
  });
});

describe("single-record college-detail upsert locking", () => {
  it("locks the parent list item before creating absent research", async () => {
    const { db, locks } = lockingDb([[{ id: ITEM_ID }], []]);

    await upsertCollegeResearch({
      access: STUDENT_ACCESS,
      listItemId: ITEM_ID,
      fitRating: 4,
    }, db);

    expect(locks).toEqual([
      { table: admissionsCollegeListItems, strength: "update" },
      { table: admissionsCollegeResearch, strength: "update" },
    ]);
  });

  it("locks the parent list item before creating absent financial aid", async () => {
    const { db, locks } = lockingDb([[{ id: ITEM_ID }], []]);

    await upsertFinancialAidOffer({
      access: COUNSELOR_ACCESS,
      listItemId: ITEM_ID,
      awardYear: 2027,
    }, db);

    expect(locks).toEqual([
      { table: admissionsCollegeListItems, strength: "update" },
      { table: admissionsFinancialAidOffers, strength: "update" },
    ]);
  });
});
