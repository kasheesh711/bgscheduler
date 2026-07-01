import { describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { CRON_JOBS } from "../cron-registry";
import {
  ABANDONED_CRON_INVOCATION_ERROR,
  markAbandonedCronInvocations,
} from "../cron-audit";

interface UpdateCall {
  table: unknown;
  values: Record<string, unknown>;
  condition: unknown;
}

function fakeDb(rowsByCall: Array<Array<{ id: string }> | Error>) {
  const calls: UpdateCall[] = [];
  let index = 0;
  const db = {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          const call: UpdateCall = { table, values, condition: null };
          calls.push(call);
          return {
            where(condition: unknown) {
              call.condition = condition;
              return {
                returning() {
                  const result = rowsByCall[index++] ?? [];
                  if (result instanceof Error) {
                    return Promise.reject(result);
                  }
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, calls };
}

describe("markAbandonedCronInvocations", () => {
  it("marks stale running cron invocation rows as failed and returns the count", async () => {
    const now = new Date("2026-07-01T02:00:00.000Z");
    const rowsByCall = CRON_JOBS.map((job) => (
      job.key === "credit_control"
        ? [{ id: "credit-1" }, { id: "credit-2" }]
        : job.key === "competitor_intelligence"
          ? [{ id: "competitor-1" }]
          : []
    ));
    const { db, calls } = fakeDb(rowsByCall);

    const marked = await markAbandonedCronInvocations(db, now);

    expect(marked).toBe(3);
    expect(calls).toHaveLength(CRON_JOBS.length);
    expect(calls.every((call) => call.table === schema.cronInvocations)).toBe(true);
    const creditCall = calls[CRON_JOBS.findIndex((job) => job.key === "credit_control")];
    expect(creditCall.values).toMatchObject({
      durationMs: 360_000,
      outcome: "failed",
    });
    expect(String(creditCall.values.errorSummary)).toContain(ABANDONED_CRON_INVOCATION_ERROR);
    expect(String(creditCall.values.errorSummary)).toContain("300s maxDuration + 60s buffer");
    expect(creditCall.values.finishedAt).toBeTruthy();
    expect(creditCall.values.metadata).toBeTruthy();
    expect(creditCall.condition).toBeTruthy();
  });

  it("is idempotent when no running invocations match the abandoned cutoff", async () => {
    const { db } = fakeDb(CRON_JOBS.map(() => []));

    await expect(markAbandonedCronInvocations(db, new Date("2026-07-01T02:00:00.000Z")))
      .resolves.toBe(0);
  });

  it("skips cleanup when the cron_invocations table is not available yet", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { db } = fakeDb([new Error('relation "cron_invocations" does not exist')]);

    try {
      await expect(markAbandonedCronInvocations(db, new Date("2026-07-01T02:00:00.000Z")))
        .resolves.toBe(0);
      expect(infoSpy).toHaveBeenCalledWith(
        "cron_invocations table is unavailable; abandoned invocation cleanup skipped.",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
