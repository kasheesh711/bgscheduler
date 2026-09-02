import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  CRON_INVOCATION_RETENTION_DAYS,
  cronInvocationRetentionCutoff,
  pruneCronInvocations,
} from "../cron-retention";

const NOW = new Date("2026-09-02T03:07:00.000Z");

interface FakeDb {
  db: Database;
  calls: {
    selectedFrom: unknown[];
    deletedFrom: unknown[];
    whereClauses: unknown[];
  };
}

/**
 * The prune is one statement built from the Drizzle fluent builder, so the
 * fake records which tables were touched rather than replaying SQL.
 */
function makeDb(deletedRowCount: number): FakeDb {
  const calls: FakeDb["calls"] = { selectedFrom: [], deletedFrom: [], whereClauses: [] };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        calls.selectedFrom.push(table);
        return {
          as: vi.fn(() => ({
            id: schema.cronInvocations.id,
            receivedAt: schema.cronInvocations.receivedAt,
            rowNumber: { name: "row_number" },
          })),
          where: vi.fn((clause: unknown) => {
            calls.whereClauses.push(clause);
            return { subquery: true };
          }),
        };
      }),
    })),
    delete: vi.fn((table: unknown) => {
      calls.deletedFrom.push(table);
      return {
        where: vi.fn((clause: unknown) => {
          calls.whereClauses.push(clause);
          return {
            returning: vi.fn(async () =>
              Array.from({ length: deletedRowCount }, (_, index) => ({ id: `row-${index}` })),
            ),
          };
        }),
      };
    }),
  } as unknown as Database;

  return { db, calls };
}

describe("cronInvocationRetentionCutoff", () => {
  it("puts the cutoff 90 days before now", () => {
    expect(CRON_INVOCATION_RETENTION_DAYS).toBe(90);
    expect(cronInvocationRetentionCutoff(NOW).toISOString()).toBe("2026-06-04T03:07:00.000Z");
  });

  it("is well clear of the 45-day window the dashboard reads", () => {
    expect(CRON_INVOCATION_RETENTION_DAYS).toBeGreaterThan(45);
  });
});

describe("pruneCronInvocations", () => {
  it("deletes from cron_invocations against a ranked subquery and returns the count", async () => {
    const { db, calls } = makeDb(37);

    const deleted = await pruneCronInvocations(db, NOW);

    expect(deleted).toBe(37);
    expect(calls.deletedFrom).toEqual([schema.cronInvocations]);
    // Ranking subquery + delete both read the same table.
    expect(calls.selectedFrom).toContain(schema.cronInvocations);
    // Two WHEREs: the eligibility filter inside the subquery, and the
    // `id in (...)` on the DELETE itself. An unbounded DELETE would have one.
    expect(calls.whereClauses).toHaveLength(2);
  });

  it("reports zero when nothing is eligible", async () => {
    const { db } = makeDb(0);

    await expect(pruneCronInvocations(db, NOW)).resolves.toBe(0);
  });
});
