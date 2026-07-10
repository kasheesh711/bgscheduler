import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the cohort
// registry can be unit-tested against hand-rolled chainable db fakes.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { createCohort, listCohorts } from "@/lib/admissions/cohorts";

/** Minimal insert(...).values(...).returning() fake for createCohort. */
function makeInsertDb(outcome: { rows?: unknown[]; error?: unknown }) {
  const returning = vi.fn(async () => {
    if (outcome.error) throw outcome.error;
    return outcome.rows ?? [];
  });
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as never, insert, values };
}

/** Minimal select(...).from(...).orderBy() fake for listCohorts. */
function makeSelectDb(rows: unknown[]) {
  const orderBy = vi.fn(async () => rows);
  const from = vi.fn(() => ({ orderBy }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as never, select };
}

const COHORT_ID = "22222222-2222-4222-8222-222222222222";

describe("createCohort", () => {
  it("inserts the trimmed name and returns the created DTO", async () => {
    const { db, values } = makeInsertDb({
      rows: [{
        id: COHORT_ID,
        name: "Class of 2027",
        graduationYear: 2027,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    });

    const cohort = await createCohort("  Class of 2027  ", 2027, db);

    expect(values).toHaveBeenCalledWith({ name: "Class of 2027", graduationYear: 2027 });
    expect(cohort).toEqual({ id: COHORT_ID, name: "Class of 2027", graduationYear: 2027 });
  });

  it("throws Conflict when the insert hits the unique-name index (SQLSTATE code)", async () => {
    const uniqueError = Object.assign(new Error("db error"), { code: "23505" });
    const { db } = makeInsertDb({ error: uniqueError });

    await expect(createCohort("Class of 2027", 2027, db)).rejects.toThrow("Conflict");
  });

  it("throws Conflict when the driver only surfaces the duplicate-key message", async () => {
    const uniqueError = new Error(
      'duplicate key value violates unique constraint "admissions_cohorts_name_idx"',
    );
    const { db } = makeInsertDb({ error: uniqueError });

    await expect(createCohort("Class of 2027", 2027, db)).rejects.toThrow("Conflict");
  });

  it("throws Conflict when the unique violation is nested in a cause chain", async () => {
    const uniqueError = new Error("insert failed");
    (uniqueError as { cause?: unknown }).cause = { code: "23505" };
    const { db } = makeInsertDb({ error: uniqueError });

    await expect(createCohort("Class of 2027", 2027, db)).rejects.toThrow("Conflict");
  });

  it("rethrows non-unique database errors unchanged", async () => {
    const { db } = makeInsertDb({ error: new Error("connection refused") });

    await expect(createCohort("Class of 2027", 2027, db)).rejects.toThrow("connection refused");
  });

  it("rejects an empty name without touching the database", async () => {
    const { db, insert } = makeInsertDb({ rows: [] });

    await expect(createCohort("   ", 2027, db)).rejects.toThrow("Cohort name is required");
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a non-integer graduation year without touching the database", async () => {
    const { db, insert } = makeInsertDb({ rows: [] });

    await expect(createCohort("Class of 2027", 2027.5, db)).rejects.toThrow(
      "Graduation year must be an integer",
    );
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("listCohorts", () => {
  it("returns the selected cohort rows", async () => {
    const rows = [
      { id: COHORT_ID, name: "Class of 2028", graduationYear: 2028 },
      { id: "33333333-3333-4333-8333-333333333333", name: "Class of 2027", graduationYear: 2027 },
    ];
    const { db } = makeSelectDb(rows);

    await expect(listCohorts(db)).resolves.toEqual(rows);
  });
});
