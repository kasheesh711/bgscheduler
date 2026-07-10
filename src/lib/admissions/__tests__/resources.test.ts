import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog, admissionsResources } from "@/lib/db/schema";
import { ADMISSIONS_CHECKLIST_PHASES } from "@/lib/admissions/config";
import {
  ADMISSIONS_RESOURCE_TOPICS,
  admissionsResourceUrlSchema,
  createResource,
  getResourceTopicLabel,
  isAdmissionsResourceTopic,
  listResources,
  softDeleteResource,
  updateResource,
} from "@/lib/admissions/resources";
import type { Database } from "@/lib/db";

const CREATED_AT = new Date("2026-07-01T00:00:00Z");

const RESOURCE_DTO_KEYS = ["createdAt", "id", "sortOrder", "title", "topic", "updatedAt", "url"];

function makeResourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "res-1",
    topic: "essays",
    title: "College Essay Guy",
    url: "https://www.collegeessayguy.com",
    sortOrder: 0,
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

/** Mock write db (transaction + recorded inserts/updates), as in announcements tests. */
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

/** Mock read db resolving `rows` regardless of the where clause. */
function makeReadDb(rows: Array<Record<string, unknown>>) {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({ orderBy: async () => rows }),
    }),
  }));
  const db = { select } as unknown as Database;
  return { db, select };
}

// ── Topic constants ─────────────────────────────────────────────────────

describe("ADMISSIONS_RESOURCE_TOPICS", () => {
  it("is the 10 checklist phase keys in canonical order, then general", () => {
    expect(ADMISSIONS_RESOURCE_TOPICS).toHaveLength(11);
    expect(ADMISSIONS_RESOURCE_TOPICS.map((entry) => entry.key)).toEqual([
      ...ADMISSIONS_CHECKLIST_PHASES.map((phase) => phase.key),
      "general",
    ]);
  });

  it("guards known topic keys and rejects everything else", () => {
    expect(isAdmissionsResourceTopic("essays")).toBe(true);
    expect(isAdmissionsResourceTopic("general")).toBe(true);
    expect(isAdmissionsResourceTopic("bogus")).toBe(false);
    expect(isAdmissionsResourceTopic("")).toBe(false);
    expect(getResourceTopicLabel("general")).toBe("General");
    expect(getResourceTopicLabel("about_you")).toBe("About You");
    expect(getResourceTopicLabel("bogus")).toBeNull();
  });
});

// ── URL schema ──────────────────────────────────────────────────────────

describe("admissionsResourceUrlSchema", () => {
  it("accepts https URLs (trimmed)", () => {
    const parsed = admissionsResourceUrlSchema.safeParse("  https://example.com/guide  ");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("https://example.com/guide");
  });

  it("rejects http, other schemes, and non-URLs", () => {
    expect(admissionsResourceUrlSchema.safeParse("http://example.com").success).toBe(false);
    expect(admissionsResourceUrlSchema.safeParse("ftp://example.com").success).toBe(false);
    expect(admissionsResourceUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(admissionsResourceUrlSchema.safeParse("not a url").success).toBe(false);
    expect(admissionsResourceUrlSchema.safeParse("").success).toBe(false);
  });
});

// ── listResources ───────────────────────────────────────────────────────

describe("listResources", () => {
  it("groups by topic in canonical order (phase keys then general), skipping empty topics", async () => {
    // Deliberately shuffled: general first, then essays, testing, about_you.
    const { db } = makeReadDb([
      makeResourceRow({ id: "res-g", topic: "general", title: "Handbook" }),
      makeResourceRow({ id: "res-e", topic: "essays" }),
      makeResourceRow({ id: "res-t", topic: "testing", title: "SAT dates" }),
      makeResourceRow({ id: "res-a", topic: "about_you", title: "Intake guide" }),
    ]);

    const groups = await listResources(db);

    expect(groups.map((group) => group.topic)).toEqual([
      "about_you",
      "testing",
      "essays",
      "general",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "About You",
      "Testing",
      "Essays",
      "General",
    ]);
    expect(Object.keys(groups[0].resources[0]).sort()).toEqual(RESOURCE_DTO_KEYS);
  });

  it("orders within a topic by sortOrder, then createdAt, then id", async () => {
    const { db } = makeReadDb([
      makeResourceRow({ id: "res-b", sortOrder: 1 }),
      makeResourceRow({ id: "res-c", sortOrder: 0, createdAt: new Date("2026-07-02T00:00:00Z") }),
      makeResourceRow({ id: "res-a", sortOrder: 0 }),
      makeResourceRow({ id: "res-d", sortOrder: 0, createdAt: CREATED_AT }),
    ]);

    const groups = await listResources(db);

    expect(groups).toHaveLength(1);
    expect(groups[0].resources.map((resource) => resource.id)).toEqual([
      "res-a",
      "res-d",
      "res-c",
      "res-b",
    ]);
  });

  it("surfaces unknown topics AFTER general instead of dropping them (fail-closed)", async () => {
    const { db } = makeReadDb([
      makeResourceRow({ id: "res-z", topic: "zzz_legacy" }),
      makeResourceRow({ id: "res-g", topic: "general" }),
      makeResourceRow({ id: "res-x", topic: "aaa_legacy" }),
    ]);

    const groups = await listResources(db);

    expect(groups.map((group) => group.topic)).toEqual(["general", "aaa_legacy", "zzz_legacy"]);
    expect(groups[1].label).toBe("aaa_legacy");
  });

  it("returns an empty list when the library is empty", async () => {
    const { db } = makeReadDb([]);

    await expect(listResources(db)).resolves.toEqual([]);
  });
});

// ── createResource ──────────────────────────────────────────────────────

describe("createResource", () => {
  const baseInput = {
    topic: "essays",
    title: "  College Essay Guy ",
    url: "https://www.collegeessayguy.com",
    actorEmail: "counselor@example.com",
  };

  it("rejects an unknown topic before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createResource({ ...baseInput, topic: "bogus" }, db))
      .rejects.toThrow(/Unknown resource topic/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an empty title before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createResource({ ...baseInput, title: "   " }, db))
      .rejects.toThrow(/title must not be empty/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a non-https URL before any write", async () => {
    const { db, transaction } = makeWriteDb();

    await expect(createResource({ ...baseInput, url: "http://insecure.example.com" }, db))
      .rejects.toThrow(/https/);
    await expect(createResource({ ...baseInput, url: "not a url" }, db))
      .rejects.toThrow(/https/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("inserts the trimmed row and audits with a null case scope (global library)", async () => {
    const { db, inserts } = makeWriteDb();

    const dto = await createResource(baseInput, db);

    const resourceInserts = inserts.filter((call) => call.table === admissionsResources);
    expect(resourceInserts).toHaveLength(1);
    expect(resourceInserts[0].values).toEqual({
      topic: "essays",
      title: "College Essay Guy",
      url: "https://www.collegeessayguy.com",
      sortOrder: 0,
    });

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: null,
      actorEmail: "counselor@example.com",
      actorRole: "counselor",
      entityType: "resource",
      entityId: "id-1",
      action: "create",
    }));
    expect(dto.topic).toBe("essays");
    expect(dto.title).toBe("College Essay Guy");
    expect(Object.keys(dto).sort()).toEqual(RESOURCE_DTO_KEYS);
  });

  it("carries an explicit sortOrder and actorRole through", async () => {
    const { db, inserts } = makeWriteDb();

    await createResource({ ...baseInput, sortOrder: 7, actorRole: "admin" }, db);

    const resourceInserts = inserts.filter((call) => call.table === admissionsResources);
    expect(resourceInserts[0].values.sortOrder).toBe(7);
    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({ actorRole: "admin" }));
  });
});

// ── updateResource ──────────────────────────────────────────────────────

describe("updateResource", () => {
  const actor = { actorEmail: "counselor@example.com", actorRole: "counselor" as const };

  it("throws NotFound when the resource does not exist", async () => {
    const { db } = makeWriteDb();

    await expect(updateResource({ resourceId: "res-x", ...actor, title: "New" }, db))
      .rejects.toThrow("NotFound");
  });

  it("rejects an unknown topic, empty title, or non-https url before any write", async () => {
    const { db, transaction } = makeWriteDb(makeResourceRow());

    await expect(updateResource({ resourceId: "res-1", ...actor, topic: "bogus" }, db))
      .rejects.toThrow(/Unknown resource topic/);
    await expect(updateResource({ resourceId: "res-1", ...actor, title: " " }, db))
      .rejects.toThrow(/title must not be empty/);
    await expect(updateResource({ resourceId: "res-1", ...actor, url: "http://x.example.com" }, db))
      .rejects.toThrow(/https/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("updates the changed fields and audits the diff atomically", async () => {
    const { db, inserts, updates } = makeWriteDb(makeResourceRow());

    const dto = await updateResource({
      resourceId: "res-1",
      ...actor,
      title: "Essay Guy (updated)",
      sortOrder: 3,
    }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsResources);
    expect(updates[0].set.title).toBe("Essay Guy (updated)");
    expect(updates[0].set.sortOrder).toBe(3);
    expect(updates[0].set.updatedAt).toBeInstanceOf(Date);
    expect(dto.title).toBe("Essay Guy (updated)");

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: null,
      entityType: "resource",
      entityId: "res-1",
      action: "update",
      diff: {
        title: { old: "College Essay Guy", new: "Essay Guy (updated)" },
        sortOrder: { old: 0, new: 3 },
      },
    }));
  });

  it("is a no-op (no update, no audit) when nothing changed", async () => {
    const { db, inserts, updates } = makeWriteDb(makeResourceRow());

    const dto = await updateResource({
      resourceId: "res-1",
      ...actor,
      title: "College Essay Guy",
    }, db);

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(dto.title).toBe("College Essay Guy");
  });
});

// ── softDeleteResource ──────────────────────────────────────────────────

describe("softDeleteResource", () => {
  const actor = { actorEmail: "counselor@example.com", actorRole: "counselor" as const };

  it("throws NotFound when the resource is missing or already deleted", async () => {
    const { db } = makeWriteDb();

    await expect(softDeleteResource({ resourceId: "res-x", ...actor }, db))
      .rejects.toThrow("NotFound");
  });

  it("stamps deletedAt (not a hard delete) and audits the deletion", async () => {
    const { db, inserts, updates } = makeWriteDb(makeResourceRow());

    await softDeleteResource({ resourceId: "res-1", ...actor }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsResources);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);
    expect(updates[0].set.updatedAt).toBe(updates[0].set.deletedAt);

    const auditInserts = inserts.filter((call) => call.table === admissionsAuditLog);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].values).toEqual(expect.objectContaining({
      caseId: null,
      entityType: "resource",
      entityId: "res-1",
      action: "delete",
    }));
  });
});
