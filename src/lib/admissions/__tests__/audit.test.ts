import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoisted shared state for the pg / node-postgres fallback mocks (vi.mock
// factories are hoisted above const declarations, so the state must be too).
const h = vi.hoisted(() => {
  const queryMock = vi.fn<(sql: string) => Promise<Record<string, never>>>(async () => ({}));
  const releaseMock = vi.fn();
  const clientMock = { query: queryMock, release: releaseMock };
  const connectMock = vi.fn(async () => clientMock);
  // `new Pool(...)` needs a constructible function — a plain function whose
  // return value becomes the constructed instance (arrow fns cannot be new-ed).
  const poolCtor = vi.fn(function pool() {
    return { connect: connectMock };
  });
  const nodePostgresTx = { tag: "node-postgres-tx" };
  const drizzleMock = vi.fn(() => nodePostgresTx);
  return { queryMock, releaseMock, connectMock, poolCtor, nodePostgresTx, drizzleMock };
});

vi.mock("pg", () => ({ Pool: h.poolCtor }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: h.drizzleMock }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog } from "@/lib/db/schema";
import {
  AUDIT_LOG_DEFAULT_PAGE_SIZE,
  AUDIT_LOG_MAX_PAGE_SIZE,
  computeFieldDiff,
  listCaseAuditLog,
  withAuditedTransaction,
  writeAuditLog,
} from "@/lib/admissions/audit";
import type { Database } from "@/lib/db";

const NEON_TX_ERROR = new Error("No transactions support in neon-http driver");

function queriedSql(): string[] {
  return h.queryMock.mock.calls.map((call) => call[0]);
}

describe("computeFieldDiff", () => {
  it("captures changed scalar fields as {old, new}", () => {
    const diff = computeFieldDiff(
      { status: "active", driveFolder: "a" },
      { status: "committed", driveFolder: "a" },
      ["status", "driveFolder"],
    );

    expect(diff).toEqual({ status: { old: "active", new: "committed" } });
  });

  it("skips fields outside the allowed list", () => {
    const diff = computeFieldDiff({ a: 1, b: 2 }, { a: 9, b: 9 }, ["a"]);

    expect(diff).toEqual({ a: { old: 1, new: 9 } });
  });

  it("skips fields whose next value is undefined (not part of this update)", () => {
    const diff = computeFieldDiff({ a: 1, b: 2 }, { a: undefined, b: 3 }, ["a", "b"]);

    expect(diff).toEqual({ b: { old: 2, new: 3 } });
  });

  it("treats explicit null as a real change in both directions", () => {
    expect(computeFieldDiff({ a: "x" }, { a: null }, ["a"])).toEqual({ a: { old: "x", new: null } });
    expect(computeFieldDiff({ a: null }, { a: "x" }, ["a"])).toEqual({ a: { old: null, new: "x" } });
  });

  it("records a missing old value as old: null (jsonb-safe)", () => {
    expect(computeFieldDiff({}, { a: "x" }, ["a"])).toEqual({ a: { old: null, new: "x" } });
  });

  it("skips structurally-equal objects and arrays", () => {
    const diff = computeFieldDiff(
      { payload: { gpa: 3.9, tags: ["a"] }, list: [1, 2] },
      { payload: { gpa: 3.9, tags: ["a"] }, list: [1, 2] },
      ["payload", "list"],
    );

    expect(diff).toEqual({});
  });

  it("captures structurally-different objects", () => {
    const diff = computeFieldDiff(
      { payload: { gpa: 3.9 } },
      { payload: { gpa: 4.0 } },
      ["payload"],
    );

    expect(diff).toEqual({ payload: { old: { gpa: 3.9 }, new: { gpa: 4.0 } } });
  });

  it("compares Dates by epoch", () => {
    const at = new Date("2026-07-09T00:00:00Z");
    const same = new Date("2026-07-09T00:00:00Z");
    const later = new Date("2026-07-10T00:00:00Z");

    expect(computeFieldDiff({ at }, { at: same }, ["at"])).toEqual({});
    expect(computeFieldDiff({ at }, { at: later }, ["at"])).toEqual({
      at: { old: at, new: later },
    });
  });

  it("returns an empty object when nothing changed", () => {
    expect(computeFieldDiff({ a: 1 }, { a: 1 }, ["a"])).toEqual({});
  });
});

describe("writeAuditLog", () => {
  it("inserts one append-only row into admissions_audit_log", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));

    await writeAuditLog({ insert } as never, {
      caseId: "11111111-1111-4111-8111-111111111111",
      actorEmail: "Staff@Example.com ",
      actorRole: "counselor",
      entityType: "case",
      entityId: "11111111-1111-4111-8111-111111111111",
      action: "status_change",
      diff: { status: { old: "active", new: "committed" } },
    });

    expect(insert).toHaveBeenCalledWith(admissionsAuditLog);
    expect(values).toHaveBeenCalledWith({
      caseId: "11111111-1111-4111-8111-111111111111",
      actorEmail: "staff@example.com",
      actorRole: "counselor",
      entityType: "case",
      entityId: "11111111-1111-4111-8111-111111111111",
      action: "status_change",
      diff: { status: { old: "active", new: "committed" } },
    });
  });

  it("defaults diff to null when omitted", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));

    await writeAuditLog({ insert } as never, {
      caseId: null,
      actorEmail: "admin@example.com",
      actorRole: "admin",
      entityType: "counselor",
      entityId: "c1",
      action: "create",
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ caseId: null, diff: null }));
  });
});

describe("listCaseAuditLog", () => {
  const CASE_ID = "11111111-1111-4111-8111-111111111111";

  /**
   * Chainable select fake with a result queue. Query order must match the
   * function's query order: [count rows, page rows]. Captures limit/offset
   * arguments so clamping is observable.
   */
  function makeAuditReadDb(queue: unknown[][]) {
    let i = 0;
    const limit = vi.fn();
    const offset = vi.fn();
    function builder(rows: unknown[]) {
      const b: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy"]) {
        b[method] = () => b;
      }
      b.limit = (value: number) => {
        limit(value);
        return b;
      };
      b.offset = (value: number) => {
        offset(value);
        return b;
      };
      (b as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return b;
    }
    const db = { select: () => builder(queue[i++] ?? []) };
    return { db: db as unknown as Database, limit, offset };
  }

  const auditRow = {
    id: "44444444-4444-4444-8444-444444444444",
    caseId: CASE_ID,
    actorEmail: "counselor@example.com",
    actorRole: "counselor",
    entityType: "case",
    entityId: CASE_ID,
    action: "status_change",
    diff: { status: { old: "active", new: "committed" } },
    createdAt: new Date("2026-07-09T00:00:00Z"),
  };

  it("serializes rows to DTOs (ISO createdAt) with the pager total", async () => {
    const { db } = makeAuditReadDb([[{ value: 7 }], [auditRow]]);

    const result = await listCaseAuditLog(CASE_ID, { page: 1, pageSize: 50 }, db);

    expect(result).toEqual({
      entries: [
        {
          id: auditRow.id,
          caseId: CASE_ID,
          actorEmail: "counselor@example.com",
          actorRole: "counselor",
          entityType: "case",
          entityId: CASE_ID,
          action: "status_change",
          diff: { status: { old: "active", new: "committed" } },
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 50,
      totalCount: 7,
    });
  });

  it("defaults a missing diff to null", async () => {
    const { db } = makeAuditReadDb([[{ value: 1 }], [{ ...auditRow, diff: null }]]);

    const result = await listCaseAuditLog(CASE_ID, {}, db);

    expect(result.entries[0].diff).toBeNull();
  });

  it("applies default pagination (page 1, pageSize 50 → offset 0)", async () => {
    const { db, limit, offset } = makeAuditReadDb([[{ value: 0 }], []]);

    const result = await listCaseAuditLog(CASE_ID, {}, db);

    expect(limit).toHaveBeenCalledWith(AUDIT_LOG_DEFAULT_PAGE_SIZE);
    expect(offset).toHaveBeenCalledWith(0);
    expect(result).toMatchObject({ page: 1, pageSize: AUDIT_LOG_DEFAULT_PAGE_SIZE, totalCount: 0 });
  });

  it("computes the offset from the requested page", async () => {
    const { db, limit, offset } = makeAuditReadDb([[{ value: 100 }], []]);

    await listCaseAuditLog(CASE_ID, { page: 3, pageSize: 25 }, db);

    expect(limit).toHaveBeenCalledWith(25);
    expect(offset).toHaveBeenCalledWith(50);
  });

  it("clamps a zero/negative page to 1 and caps pageSize at the maximum", async () => {
    const { db, limit, offset } = makeAuditReadDb([[{ value: 0 }], []]);

    const result = await listCaseAuditLog(CASE_ID, { page: 0, pageSize: 9999 }, db);

    expect(limit).toHaveBeenCalledWith(AUDIT_LOG_MAX_PAGE_SIZE);
    expect(offset).toHaveBeenCalledWith(0);
    expect(result).toMatchObject({ page: 1, pageSize: AUDIT_LOG_MAX_PAGE_SIZE });
  });

  it("clamps a zero/negative pageSize up to 1", async () => {
    const { db, limit } = makeAuditReadDb([[{ value: 0 }], []]);

    const result = await listCaseAuditLog(CASE_ID, { pageSize: -5 }, db);

    expect(limit).toHaveBeenCalledWith(1);
    expect(result.pageSize).toBe(1);
  });

  it("returns totalCount 0 when the count query yields no row", async () => {
    const { db } = makeAuditReadDb([[], []]);

    const result = await listCaseAuditLog(CASE_ID, {}, db);

    expect(result.totalCount).toBe(0);
    expect(result.entries).toEqual([]);
  });
});

describe("withAuditedTransaction", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://unit-test";
    h.queryMock.mockClear();
    h.releaseMock.mockClear();
    h.connectMock.mockClear();
    h.drizzleMock.mockClear();
  });

  it("uses the driver transaction when supported and never touches pg", async () => {
    const nativeTx = { tag: "native-tx" };
    const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(nativeTx));
    const db = { transaction } as unknown as Database;

    const result = await withAuditedTransaction(async (tx) => {
      expect(tx).toBe(nativeTx);
      return "ok";
    }, db);

    expect(result).toBe("ok");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(h.connectMock).not.toHaveBeenCalled();
  });

  it("propagates non-neon transaction errors without falling back to pg", async () => {
    const transaction = vi.fn(async () => {
      throw new Error("deadlock detected");
    });
    const db = { transaction } as unknown as Database;

    await expect(withAuditedTransaction(async () => "never", db)).rejects.toThrow("deadlock detected");
    expect(h.connectMock).not.toHaveBeenCalled();
  });

  it("falls back to a pg BEGIN/COMMIT transaction when neon-http rejects transactions", async () => {
    const transaction = vi.fn(async () => {
      throw NEON_TX_ERROR;
    });
    const db = { transaction } as unknown as Database;

    const result = await withAuditedTransaction(async (tx) => {
      expect(tx).toBe(h.nodePostgresTx);
      return 42;
    }, db);

    expect(result).toBe(42);
    expect(h.connectMock).toHaveBeenCalledTimes(1);
    expect(queriedSql()).toEqual(["BEGIN", "COMMIT"]);
    expect(h.releaseMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back, releases the client, and rethrows when the callback fails on the pg path", async () => {
    const transaction = vi.fn(async () => {
      throw NEON_TX_ERROR;
    });
    const db = { transaction } as unknown as Database;

    await expect(
      withAuditedTransaction(async () => {
        throw new Error("mutation failed");
      }, db),
    ).rejects.toThrow("mutation failed");

    expect(queriedSql()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(queriedSql()).not.toContain("COMMIT");
    expect(h.releaseMock).toHaveBeenCalledTimes(1);
  });
});
