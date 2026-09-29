import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sales-dashboard/sheets", () => ({
  fetchGoogleSheetRange: vi.fn(),
  listGoogleSheetProperties: vi.fn(),
  quoteGoogleSheetName: vi.fn((name: string) => name),
}));

import type { Database } from "@/lib/db";
import { fetchGoogleSheetRange, listGoogleSheetProperties } from "@/lib/sales-dashboard/sheets";
import { runUnearnedRevenueSync } from "@/lib/unearned-revenue/sync";

// drizzle-orm 0.45 wraps every driver error in DrizzleQueryError: the SQLSTATE
// lives on `.cause`, `.code` is undefined and `.message` is "Failed query: ...".
// Raw `.code` errors (a driver error that reaches the guard unwrapped) stay
// supported as a defensive fallback, so both shapes must work.
const rawUnique = () =>
  Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
const wrappedUnique = () =>
  Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
const realWrappedUnique = () =>
  new DrizzleQueryError(
    'insert into "unearned_revenue_sync_runs" ("status") values ($1)',
    ["running"],
    rawUnique(),
  );

function makeDb(insertError: unknown): Database {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockRejectedValue(insertError) })),
    })),
  } as unknown as Database;
}

const SKIPPED_RESULT = {
  ok: true,
  skipped: true,
  idempotent: false,
  syncRunId: null,
  snapshotId: null,
  cutoff: null,
  counts: null,
};

describe("runUnearnedRevenueSync single-flight insert guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["raw driver error", rawUnique],
    ["DrizzleQueryError-wrapped driver error", wrappedUnique],
    ["real DrizzleQueryError", realWrappedUnique],
  ])("skips without reading the workbook when the run insert hits a unique violation (%s)", async (_label, makeError) => {
    const result = await runUnearnedRevenueSync({ triggerType: "cron", db: makeDb(makeError()) });

    expect(result).toEqual(SKIPPED_RESULT);
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
    expect(fetchGoogleSheetRange).not.toHaveBeenCalled();
  });

  it.each([
    ["wrapped non-unique error (cause.code 23503)", () => Object.assign(new Error("Failed query"), { cause: { code: "23503" } })],
    ["raw non-unique error (code 23503)", () => Object.assign(new Error("fk violation"), { code: "23503" })],
    ["wrapper with no cause", () => new Error("Failed query")],
  ])("rethrows a non-unique failure instead of skipping (%s)", async (_label, makeError) => {
    const error = makeError();

    await expect(runUnearnedRevenueSync({ triggerType: "cron", db: makeDb(error) })).rejects.toBe(error);
    expect(listGoogleSheetProperties).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a string", "boom"],
  ])("rethrows %s rejection verbatim (the guard tolerates non-object rejections)", async (_label, rejection) => {
    await expect(runUnearnedRevenueSync({ triggerType: "cron", db: makeDb(rejection) })).rejects.toBe(rejection);
  });
});
