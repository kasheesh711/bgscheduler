import { describe, expect, it, vi } from "vitest";

import {
  hashScheduleToken,
  mintStudentScheduleLink,
  resolveStudentScheduleLink,
  studentScheduleLinkUrl,
} from "@/lib/student-schedule/links";
import type { Database } from "@/lib/db";

const NOW = new Date("2026-08-05T03:00:00Z");

/** Chainable stand-in; `rows` is what the single select chain resolves to. */
function makeDb(rows: unknown[] = []) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];

  function chain(result: unknown[]) {
    const node: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit", "orderBy"]) node[method] = () => node;
    node.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
    return node;
  }

  const db = {
    select: () => chain(rows),
    insert: () => ({
      values: (row: unknown) => {
        inserted.push(row);
        return { returning: () => Promise.resolve([{ id: "link-1" }]) };
      },
    }),
    update: () => ({
      set: (patch: unknown) => {
        updated.push(patch);
        const node: Record<string, unknown> = {};
        node.where = () => node;
        node.then = (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
        node.catch = () => node;
        return node;
      },
    }),
  };

  return { db: db as unknown as Database, inserted, updated };
}

describe("mintStudentScheduleLink", () => {
  const args = {
    studentKey: "aadhiya srisethi::nok srisethi",
    wiseStudentId: "stu_1",
    studentName: "Aadhiya (Aadhu.Sr) Srisethi",
    monthKey: "2026-08",
    now: NOW,
  };

  it("returns a raw token but persists only its hash", async () => {
    const { db, inserted } = makeDb();
    const { token } = await mintStudentScheduleLink(db, args);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.tokenHash).toBe(hashScheduleToken(token));
    // The plaintext token must appear nowhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("mints a distinct token every call", async () => {
    const { db } = makeDb();
    const a = await mintStudentScheduleLink(db, args);
    const b = await mintStudentScheduleLink(db, args);
    expect(a.token).not.toBe(b.token);
  });

  it("applies the TTL in days", async () => {
    const { db } = makeDb();
    const { expiresAt } = await mintStudentScheduleLink(db, { ...args, ttlDays: 30 });
    expect(expiresAt.toISOString()).toBe("2026-09-04T03:00:00.000Z");
  });

  it("rejects a malformed month rather than minting", async () => {
    const { db, inserted } = makeDb();
    await expect(mintStudentScheduleLink(db, { ...args, monthKey: "2026-8" }))
      .rejects.toThrow(/Invalid month key/);
    expect(inserted).toHaveLength(0);
  });
});

describe("resolveStudentScheduleLink", () => {
  const validToken = "a".repeat(43);
  const grantRow = {
    id: "link-1",
    tokenHash: hashScheduleToken(validToken),
    studentKey: "aadhiya srisethi::nok srisethi",
    wiseStudentId: "stu_1",
    studentName: "Aadhiya (Aadhu.Sr) Srisethi",
    monthKey: "2026-08",
    expiresAt: new Date("2026-09-04T03:00:00Z"),
  };

  it("resolves a live token and records the view", async () => {
    const { db, updated } = makeDb([grantRow]);
    const grant = await resolveStudentScheduleLink(db, validToken, NOW);

    expect(grant).toMatchObject({ studentKey: grantRow.studentKey, monthKey: "2026-08" });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ lastViewedAt: NOW });
  });

  it("returns null for a malformed token without querying", async () => {
    const select = vi.fn();
    const db = { select } as unknown as Database;

    for (const bad of ["", "short", "has spaces here", "!!!", "a".repeat(200)]) {
      expect(await resolveStudentScheduleLink(db, bad, NOW)).toBeNull();
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("returns null when the row is gone (expired/revoked are filtered in SQL)", async () => {
    const { db } = makeDb([]);
    expect(await resolveStudentScheduleLink(db, validToken, NOW)).toBeNull();
  });

  it("returns null when the stored hash does not match the presented token", async () => {
    const { db } = makeDb([{ ...grantRow, tokenHash: hashScheduleToken("different") }]);
    expect(await resolveStudentScheduleLink(db, validToken, NOW)).toBeNull();
  });

  it("still serves the parent when view accounting fails", async () => {
    const { db } = makeDb([grantRow]);
    // Force the update chain to reject; resolution must not be denied by it.
    (db as unknown as { update: () => unknown }).update = () => ({
      set: () => ({ where: () => Promise.reject(new Error("db down")) }),
    });
    await expect(resolveStudentScheduleLink(db, validToken, NOW)).resolves.not.toBeNull();
  });
});

describe("studentScheduleLinkUrl", () => {
  it("joins the base and token without a double slash", () => {
    expect(studentScheduleLinkUrl("https://x.test", "tok")).toBe("https://x.test/schedule/tok");
    expect(studentScheduleLinkUrl("https://x.test/", "tok")).toBe("https://x.test/schedule/tok");
    expect(studentScheduleLinkUrl("https://x.test///", "tok")).toBe("https://x.test/schedule/tok");
  });
});
