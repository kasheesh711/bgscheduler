import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAnnouncements, admissionsAuditLog, admissionsCases } from "@/lib/db/schema";
import {
  createAnnouncement,
  getAnnouncementScope,
  listAnnouncementsForCase,
  listAnnouncementsForCohort,
  softDeleteAnnouncement,
  updateAnnouncement,
} from "@/lib/admissions/announcements";
import type { Database } from "@/lib/db";

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const COHORT_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = new Date("2026-07-01T00:00:00Z");

const ANNOUNCEMENT_DTO_KEYS = [
  "authorEmail",
  "body",
  "caseId",
  "cohortId",
  "createdAt",
  "id",
  "title",
  "updatedAt",
];

function makeAnnouncementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ann-1",
    cohortId: null,
    caseId: CASE_ID,
    title: "Deadline reminder",
    body: "ED applications close soon",
    authorEmail: "counselor@example.com",
    deletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/** Mock write db (transaction + recorded inserts/updates), as in notes tests. */
function makeWriteDb(existingRow?: Record<string, unknown>) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  let idCounter = 0;

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const id = `id-${++idCounter}`;
        return {
          returning: async () => [
            { id, createdAt: CREATED_AT, updatedAt: CREATED_AT, deletedAt: null, ...values },
          ],
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (existingRow ? [existingRow] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return {
          where: () => ({
            returning: async () => [{ ...(existingRow ?? {}), ...set }],
          }),
        };
      },
    }),
  };

  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const db = { transaction } as unknown as Database;
  return { db, inserts, updates, transaction };
}

/**
 * Mock read db that dispatches on the FROM table: admissions_cases lookups
 * resolve `caseRows`; everything else resolves `announcementRows` (ignoring
 * the where clause, so ordering must be proven in process).
 */
function makeReadDb({
  caseRows = [],
  announcementRows = [],
}: {
  caseRows?: Array<Record<string, unknown>>;
  announcementRows?: Array<Record<string, unknown>>;
}) {
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (table === admissionsCases) {
        return { where: () => ({ limit: async () => caseRows }) };
      }
      return { where: () => ({ orderBy: async () => announcementRows }) };
    },
  }));
  const db = { select } as unknown as Database;
  return { db, select };
}

/** Minimal chainable fake for the scope lookup (select → from → where → limit). */
function makeScopeDb(rows: Array<Record<string, unknown>>) {
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  }));
  const db = { select } as unknown as Database;
  return { db, select };
}

const ANNOUNCEMENT_ID = "44444444-4444-4444-8444-444444444444";

describe("getAnnouncementScope", () => {
  it("returns the stored row's case scope", async () => {
    const { db } = makeScopeDb([{ caseId: CASE_ID, cohortId: null }]);

    await expect(getAnnouncementScope(ANNOUNCEMENT_ID, db)).resolves.toEqual({
      caseId: CASE_ID,
      cohortId: null,
    });
  });

  it("returns the stored row's cohort scope", async () => {
    const { db } = makeScopeDb([{ caseId: null, cohortId: COHORT_ID }]);

    await expect(getAnnouncementScope(ANNOUNCEMENT_ID, db)).resolves.toEqual({
      caseId: null,
      cohortId: COHORT_ID,
    });
  });

  it("throws NotFound for a missing or soft-deleted announcement", async () => {
    const { db } = makeScopeDb([]);

    await expect(getAnnouncementScope(ANNOUNCEMENT_ID, db)).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed id without querying", async () => {
    const { db, select } = makeScopeDb([]);

    await expect(getAnnouncementScope("not-a-uuid", db)).rejects.toThrow("NotFound");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("createAnnouncement", () => {
  const baseInput = {
    title: "  Deadline reminder ",
    body: "ED applications close soon",
    authorEmail: "Counselor@Example.com ",
  };

  it("rejects when BOTH cohortId and caseId are set (exactly-one scope)", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createAnnouncement(
      { ...baseInput, cohortId: COHORT_ID, caseId: CASE_ID },
      db,
    )).rejects.toThrow(/exactly one of cohortId or caseId/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects when NEITHER cohortId nor caseId is set", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createAnnouncement(baseInput, db))
      .rejects.toThrow(/exactly one of cohortId or caseId/);
    expect(transaction).not.toHaveBeenCalled();

    await expect(createAnnouncement(
      { ...baseInput, cohortId: null, caseId: null },
      db,
    )).rejects.toThrow(/exactly one of cohortId or caseId/);
  });

  it("rejects a non-uuid scope id before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createAnnouncement({ ...baseInput, cohortId: "not-a-uuid" }, db))
      .rejects.toThrow(/valid cohortId/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an empty title or body before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createAnnouncement({ ...baseInput, caseId: CASE_ID, title: "   " }, db))
      .rejects.toThrow(/title must not be empty/);
    await expect(createAnnouncement({ ...baseInput, caseId: CASE_ID, body: "" }, db))
      .rejects.toThrow(/body must not be empty/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("creates a cohort broadcast (caseId null) and audits with a null case scope", async () => {
    const { db, inserts } = makeWriteDb();

    const dto = await createAnnouncement({ ...baseInput, cohortId: COHORT_ID }, db);

    const announcementInserts = inserts.filter((call) => call.table === admissionsAnnouncements);
    expect(announcementInserts).toHaveLength(1);
    expect(announcementInserts[0].values).toEqual({
      cohortId: COHORT_ID,
      caseId: null,
      title: "Deadline reminder",
      body: "ED applications close soon",
      authorEmail: "counselor@example.com",
    });

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: null,
      actorEmail: "counselor@example.com",
      actorRole: "counselor",
      entityType: "announcement",
      entityId: "id-1",
      action: "create",
      diff: { cohortId: { old: null, new: COHORT_ID } },
    }));
    expect(dto.cohortId).toBe(COHORT_ID);
    expect(dto.caseId).toBeNull();
    expect(Object.keys(dto).sort()).toEqual(ANNOUNCEMENT_DTO_KEYS);
  });

  it("creates a case-scoped announcement and audits against that case", async () => {
    const { db, inserts } = makeWriteDb();

    const dto = await createAnnouncement(
      { ...baseInput, caseId: CASE_ID, actorRole: "admin" },
      db,
    );

    const announcementInserts = inserts.filter((call) => call.table === admissionsAnnouncements);
    expect(announcementInserts[0].values).toEqual(expect.objectContaining({
      cohortId: null,
      caseId: CASE_ID,
    }));

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: CASE_ID,
      actorRole: "admin",
      action: "create",
    }));
    expect(dto.caseId).toBe(CASE_ID);
    expect(dto.cohortId).toBeNull();
  });
});

describe("listAnnouncementsForCase", () => {
  it("throws NotFound when the case does not exist", async () => {
    const { db } = makeReadDb({ caseRows: [] });

    await expect(listAnnouncementsForCase(CASE_ID, db)).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, select } = makeReadDb({});

    await expect(listAnnouncementsForCase("nope", db)).rejects.toThrow("NotFound");
    expect(select).not.toHaveBeenCalled();
  });

  it("merges case-scoped and cohort-scoped rows, newest first", async () => {
    const older = makeAnnouncementRow({
      id: "ann-cohort",
      cohortId: COHORT_ID,
      caseId: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    const newer = makeAnnouncementRow({
      id: "ann-case",
      createdAt: new Date("2026-07-05T00:00:00Z"),
    });
    const newest = makeAnnouncementRow({
      id: "ann-cohort-2",
      cohortId: COHORT_ID,
      caseId: null,
      createdAt: new Date("2026-07-08T00:00:00Z"),
    });
    // Deliberately unsorted: the merged ordering must be proven in process.
    const { db } = makeReadDb({
      caseRows: [{ cohortId: COHORT_ID }],
      announcementRows: [older, newest, newer],
    });

    const announcements = await listAnnouncementsForCase(CASE_ID, db);

    expect(announcements.map((a) => a.id)).toEqual(["ann-cohort-2", "ann-case", "ann-cohort"]);
    expect(Object.keys(announcements[0]).sort()).toEqual(ANNOUNCEMENT_DTO_KEYS);
  });

  it("breaks same-instant ties by id descending for a stable order", async () => {
    const a = makeAnnouncementRow({ id: "ann-a" });
    const b = makeAnnouncementRow({ id: "ann-b", cohortId: COHORT_ID, caseId: null });
    const { db } = makeReadDb({
      caseRows: [{ cohortId: COHORT_ID }],
      announcementRows: [a, b],
    });

    const announcements = await listAnnouncementsForCase(CASE_ID, db);

    expect(announcements.map((row) => row.id)).toEqual(["ann-b", "ann-a"]);
  });
});

describe("listAnnouncementsForCohort", () => {
  it("returns the cohort's announcements newest first", async () => {
    const older = makeAnnouncementRow({
      id: "ann-1",
      cohortId: COHORT_ID,
      caseId: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    const newer = makeAnnouncementRow({
      id: "ann-2",
      cohortId: COHORT_ID,
      caseId: null,
      createdAt: new Date("2026-07-06T00:00:00Z"),
    });
    const { db } = makeReadDb({ announcementRows: [older, newer] });

    const announcements = await listAnnouncementsForCohort(COHORT_ID, db);

    expect(announcements.map((row) => row.id)).toEqual(["ann-2", "ann-1"]);
  });

  it("throws NotFound for a malformed cohortId without querying", async () => {
    const { db, select } = makeReadDb({});

    await expect(listAnnouncementsForCohort("nope", db)).rejects.toThrow("NotFound");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("updateAnnouncement", () => {
  const actor = { actorEmail: "counselor@example.com", actorRole: "counselor" as const };

  it("throws NotFound when the announcement does not exist", async () => {
    const { db } = makeWriteDb();

    await expect(updateAnnouncement({
      announcementId: "ann-x",
      ...actor,
      title: "New title",
    }, db)).rejects.toThrow("NotFound");
  });

  it("rejects an empty title/body before any write", async () => {
    const { db, transaction } = makeWriteDb(makeAnnouncementRow());

    await expect(updateAnnouncement({ announcementId: "ann-1", ...actor, title: " " }, db))
      .rejects.toThrow(/title must not be empty/);
    await expect(updateAnnouncement({ announcementId: "ann-1", ...actor, body: "" }, db))
      .rejects.toThrow(/body must not be empty/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("updates the changed fields and audits the diff atomically", async () => {
    const { db, inserts, updates } = makeWriteDb(makeAnnouncementRow());

    const dto = await updateAnnouncement({
      announcementId: "ann-1",
      ...actor,
      title: "Updated title",
    }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsAnnouncements);
    expect(updates[0].set.title).toBe("Updated title");
    expect(updates[0].set.updatedAt).toBeInstanceOf(Date);
    expect(dto.title).toBe("Updated title");

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: CASE_ID,
      entityType: "announcement",
      entityId: "ann-1",
      action: "update",
      diff: { title: { old: "Deadline reminder", new: "Updated title" } },
    }));
  });

  it("is a no-op (no update, no audit) when nothing changed", async () => {
    const { db, inserts, updates } = makeWriteDb(makeAnnouncementRow());

    const dto = await updateAnnouncement({
      announcementId: "ann-1",
      ...actor,
      title: "Deadline reminder",
    }, db);

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(dto.title).toBe("Deadline reminder");
  });
});

describe("softDeleteAnnouncement", () => {
  const actor = { actorEmail: "counselor@example.com", actorRole: "counselor" as const };

  it("throws NotFound when the announcement is missing or already deleted", async () => {
    const { db } = makeWriteDb();

    await expect(softDeleteAnnouncement({ announcementId: "ann-x", ...actor }, db))
      .rejects.toThrow("NotFound");
  });

  it("stamps deletedAt (not a hard delete) and audits the deletion", async () => {
    const { db, inserts, updates } = makeWriteDb(makeAnnouncementRow());

    await softDeleteAnnouncement({ announcementId: "ann-1", ...actor }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsAnnouncements);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);
    expect(updates[0].set.updatedAt).toBe(updates[0].set.deletedAt);

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: CASE_ID,
      entityType: "announcement",
      entityId: "ann-1",
      action: "delete",
    }));
  });
});
