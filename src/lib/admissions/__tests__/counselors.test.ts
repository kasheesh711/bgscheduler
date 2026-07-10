import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it. The audit module
// is partially mocked: withAuditedTransaction runs the callback against the
// caller-supplied db (so the tx fake below stands in for the transaction) and
// writeAuditLog becomes a spy — computeFieldDiff stays real.
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admissions/audit")>();
  return {
    ...actual,
    withAuditedTransaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>, db: unknown) => fn(db),
    ),
    writeAuditLog: vi.fn(async () => undefined),
  };
});

import { withAuditedTransaction, writeAuditLog } from "@/lib/admissions/audit";
import {
  deactivateCounselor,
  listCounselors,
  upsertCounselor,
} from "@/lib/admissions/counselors";

const withAuditedTransactionMock = withAuditedTransaction as unknown as Mock;
const writeAuditLogMock = writeAuditLog as unknown as Mock;

const NOW = new Date("2026-07-09T00:00:00Z");
const ADMIN = { email: "admin@example.com", role: "admin" as const };

function makeCounselorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    email: "staff@example.com",
    name: "Staff",
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Chainable tx fake covering the three query shapes counselors.ts issues:
 * select().from().where().limit() → `selected`,
 * insert().values().onConflictDoUpdate().returning() → [`upserted`],
 * update().set().where().returning() → [`updated`],
 * delete().where() → token revocation result.
 */
function makeTx(outcome: { selected?: unknown[]; upserted?: unknown; updated?: unknown } = {}) {
  const execute = vi.fn(async () => []);
  const limit = vi.fn(async () => outcome.selected ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  const insertReturning = vi.fn(async () => [outcome.upserted]);
  const onConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const updateReturning = vi.fn(async () => [outcome.updated]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const deleteWhere = vi.fn(async () => []);
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));

  return {
    tx: { execute, select, insert, update, delete: deleteFrom } as never,
    spies: {
      select,
      insert,
      values,
      onConflictDoUpdate,
      update,
      set,
      deleteFrom,
      deleteWhere,
      execute,
    },
  };
}

beforeEach(() => {
  withAuditedTransactionMock.mockClear();
  writeAuditLogMock.mockClear();
});

describe("listCounselors", () => {
  it("maps registry rows (active and inactive) to DTOs with ISO timestamps", async () => {
    const rows = [
      makeCounselorRow(),
      makeCounselorRow({ id: "c2", email: "former@example.com", name: "Former", active: false }),
    ];
    const orderBy = vi.fn(async () => rows);
    const from = vi.fn(() => ({ orderBy }));
    const db = { select: vi.fn(() => ({ from })) } as never;

    await expect(listCounselors(db)).resolves.toEqual([
      {
        id: "c1",
        email: "staff@example.com",
        name: "Staff",
        active: true,
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
      {
        id: "c2",
        email: "former@example.com",
        name: "Former",
        active: false,
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
  });
});

describe("upsertCounselor", () => {
  it("creates a new registry row with normalized email and audits action create", async () => {
    const { tx, spies } = makeTx({ selected: [], upserted: makeCounselorRow() });

    const dto = await upsertCounselor("  Staff@Example.com ", " Staff ", true, ADMIN, tx);

    expect(spies.values).toHaveBeenCalledWith({
      email: "staff@example.com",
      name: "Staff",
      active: true,
    });
    expect(writeAuditLogMock).toHaveBeenCalledWith(tx, {
      caseId: null,
      actorEmail: "admin@example.com",
      actorRole: "admin",
      entityType: "counselor",
      entityId: "c1",
      action: "create",
      diff: {
        name: { old: null, new: "Staff" },
        active: { old: null, new: true },
      },
    });
    expect(dto).toEqual({
      id: "c1",
      email: "staff@example.com",
      name: "Staff",
      active: true,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
  });

  it("updates an existing row and audits only the changed fields", async () => {
    const { tx } = makeTx({
      selected: [makeCounselorRow({ name: "Old Name" })],
      upserted: makeCounselorRow({ name: "New Name" }),
    });

    const dto = await upsertCounselor("staff@example.com", "New Name", true, ADMIN, tx);

    expect(writeAuditLogMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "update",
      diff: { name: { old: "Old Name", new: "New Name" } },
    }));
    expect(dto.name).toBe("New Name");
  });

  it("audits an active flip when deactivating through the upsert path", async () => {
    const { tx, spies } = makeTx({
      selected: [makeCounselorRow()],
      upserted: makeCounselorRow({ active: false }),
    });

    await upsertCounselor("staff@example.com", "Staff", false, ADMIN, tx);

    expect(writeAuditLogMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "update",
      diff: { active: { old: true, new: false } },
    }));
    expect(spies.deleteFrom).toHaveBeenCalledTimes(1);
  });

  it("short-circuits with no write and no audit row when nothing changed", async () => {
    const { tx, spies } = makeTx({ selected: [makeCounselorRow()] });

    const dto = await upsertCounselor("staff@example.com", "Staff", true, ADMIN, tx);

    expect(spies.insert).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(dto.id).toBe("c1");
  });

  it("rejects an empty email without opening a transaction", async () => {
    const { tx } = makeTx();

    await expect(upsertCounselor("   ", "Staff", true, ADMIN, tx)).rejects.toThrow(
      "Counselor email is required",
    );
    expect(withAuditedTransactionMock).not.toHaveBeenCalled();
  });
});

describe("deactivateCounselor", () => {
  it("flips active to false and writes the deactivate audit row in the same transaction", async () => {
    const { tx, spies } = makeTx({
      selected: [makeCounselorRow()],
      updated: makeCounselorRow({ active: false }),
    });

    const dto = await deactivateCounselor("Staff@Example.com", ADMIN, tx);

    expect(withAuditedTransactionMock).toHaveBeenCalledTimes(1);
    expect(spies.set).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(spies.deleteFrom).toHaveBeenCalledTimes(1);
    expect(spies.deleteWhere).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock).toHaveBeenCalledWith(tx, {
      caseId: null,
      actorEmail: "admin@example.com",
      actorRole: "admin",
      entityType: "counselor",
      entityId: "c1",
      action: "deactivate",
      diff: { active: { old: true, new: false } },
    });
    expect(dto.active).toBe(false);
  });

  it("throws NotFound for an unknown email and writes no audit row", async () => {
    const { tx, spies } = makeTx({ selected: [] });

    await expect(deactivateCounselor("ghost@example.com", ADMIN, tx)).rejects.toThrow("NotFound");
    expect(spies.update).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it("is idempotent for an already-inactive counselor (no update, no audit row)", async () => {
    const { tx, spies } = makeTx({ selected: [makeCounselorRow({ active: false })] });

    const dto = await deactivateCounselor("staff@example.com", ADMIN, tx);

    expect(dto.active).toBe(false);
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.deleteFrom).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it("rejects an empty email without opening a transaction", async () => {
    const { tx } = makeTx();

    await expect(deactivateCounselor("  ", ADMIN, tx)).rejects.toThrow(
      "Counselor email is required",
    );
    expect(withAuditedTransactionMock).not.toHaveBeenCalled();
  });
});
