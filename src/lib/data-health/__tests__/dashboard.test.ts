import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/post-class-feedback/nightly-reminder-health", () => ({
  applyNightlyReminderHealth: vi.fn(async (jobs: unknown) => jobs),
}));

import { getDb, type Database } from "@/lib/db";
import { CRON_JOBS } from "../cron-registry";
import { getCronJobsHealth } from "../dashboard";

const NOW = new Date("2026-09-29T08:00:00.000Z");

/**
 * What drizzle-orm 0.45 throws for ANY failed query: a DrizzleQueryError-shaped
 * wrapper whose message is the SQL text — so it always names cron_invocations —
 * with the driver error, and its SQLSTATE, on `cause`.
 */
function drizzleError(code: string): Error {
  return Object.assign(
    new Error(
      'Failed query: select * from (select "job_key", "received_at", row_number() over (partition by "cron_invocations"."job_key" order by "cron_invocations"."received_at" desc) as "row_number" from "cron_invocations" where "cron_invocations"."received_at" >= $1) "ranked" where "ranked"."row_number" <= $2\nparams: 2026-08-15T08:00:00.000Z,8',
    ),
    { cause: { code } },
  );
}

interface FakeQuery {
  from(source: unknown): FakeQuery;
  where(): FakeQuery;
  orderBy(): FakeQuery;
  limit(): FakeQuery;
  as(): unknown;
  then(resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown): Promise<unknown>;
}

/**
 * Minimal drizzle stand-in: the ranked cron_invocations read (a select from the
 * `.as("ranked")` subquery) rejects with `invocationsError`; every run-table
 * read resolves to no rows.
 */
function makeDb(invocationsError: unknown): Database {
  const ranked = { rowNumber: {}, receivedAt: {} };
  const select = () => {
    let source: unknown;
    const query: FakeQuery = {
      from(nextSource) {
        source = nextSource;
        return query;
      },
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      as: () => ranked,
      then: (resolve, reject) =>
        (source === ranked ? Promise.reject(invocationsError) : Promise.resolve([])).then(resolve, reject),
    };
    return query;
  };
  return { select } as unknown as Database;
}

describe("getCronJobsHealth cron_invocations read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rethrows a timeout even though the drizzle message names cron_invocations", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const timeout = drizzleError("57014");
    vi.mocked(getDb).mockReturnValue(makeDb(timeout));

    await expect(getCronJobsHealth(NOW)).rejects.toBe(timeout);
    expect(info).not.toHaveBeenCalled();
  });

  it("rethrows a missing column — schema drift, not a pending migration", async () => {
    const missingColumn = drizzleError("42703");
    vi.mocked(getDb).mockReturnValue(makeDb(missingColumn));

    await expect(getCronJobsHealth(NOW)).rejects.toBe(missingColumn);
  });

  it("falls back to inferred run-table proof when cron_invocations does not exist yet", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(getDb).mockReturnValue(makeDb(drizzleError("42P01")));

    const jobs = await getCronJobsHealth(NOW);

    expect(jobs).toHaveLength(CRON_JOBS.length);
    expect(jobs.every((job) => job.latestInvocation === null)).toBe(true);
    expect(info).toHaveBeenCalledWith(
      "cron_invocations table is unavailable; Data Health will use inferred run-table proof.",
    );
  });

  it("also recognises an unwrapped driver error carrying 42P01 itself", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(getDb).mockReturnValue(makeDb(
      Object.assign(new Error('relation "cron_invocations" does not exist'), { code: "42P01" }),
    ));

    await expect(getCronJobsHealth(NOW)).resolves.toHaveLength(CRON_JOBS.length);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
