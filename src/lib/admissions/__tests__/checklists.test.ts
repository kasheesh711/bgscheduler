import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsCaseTasks,
  admissionsChecklistTemplates,
  admissionsTemplateItems,
} from "@/lib/db/schema";
import {
  computeProgress,
  computeProgressCounts,
  computeProgressMap,
  createCustomTask,
  createTemplateVersion,
  DEFAULT_TEMPLATE_NAME,
  getLatestTemplate,
  instantiateChecklist,
  listTemplateVersions,
  publishTemplate,
  pushNewItemsToCohortCases,
  seedDefaultTemplate,
  setTaskVerified,
  softDeleteTask,
  updateTask,
  updateTaskStatus,
  type AdmissionsTaskRecurrence,
} from "@/lib/admissions/checklists";
import {
  ADMISSIONS_CHECKLIST_PHASES,
  DEFAULT_CHECKLIST_ITEMS,
  type AdmissionsTemplateItemSeed,
} from "@/lib/admissions/config";
import type { CaseAccess } from "@/lib/admissions/types";

const COHORT_ID = "44444444-4444-4444-8444-444444444444";
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID_B = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "77777777-7777-4777-8777-777777777777";
const TASK_ID = "88888888-8888-4888-8888-888888888888";

const ACTOR = { email: "staff@example.com", role: "admin" as const };

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "staff@example.com",
  role: "counselor",
  isAdmin: false,
};
const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "ada@example.com",
  role: "student",
  isAdmin: false,
};
const PARENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "mom@example.com",
  role: "parent",
  isAdmin: false,
};

interface InsertCall {
  table: unknown;
  values: Record<string, unknown> | Record<string, unknown>[];
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as cases.test.ts) extended with
 * array-values inserts (bulk inserts synthesize one returning row per value).
 * Each db.select() resolves to the next queued result — the queue order must
 * match the function's query order.
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  let generated = 0;
  const selectCalls: number[] = [];
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  function selectBuilder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "groupBy", "limit"]) {
      b[method] = () => b;
    }
    (b as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return b;
  }

  const tx = {
    select: () => {
      selectCalls.push(i);
      return selectBuilder(queue[i++] ?? []);
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        inserts.push({ table, values });
        const rows = (Array.isArray(values) ? values : [values]).map((value) => ({
          id: `generated-${generated++}`,
          description: null,
          dueDate: null,
          verifiedByEmail: null,
          verifiedAt: null,
          recurrence: null,
          publishedAt: null,
          deletedAt: null,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-01T00:00:00Z"),
          ...value,
        }));
        return {
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        const b: Record<string, unknown> = {};
        b.where = () => b;
        b.returning = () => Promise.resolve([]);
        (b as { then: unknown }).then = (
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown,
        ) => Promise.resolve(undefined).then(resolve, reject);
        return b;
      },
    }),
  };

  const db = {
    ...tx,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  return { db: db as never, selectCalls, inserts, updates };
}

function auditInserts(inserts: InsertCall[]) {
  return inserts
    .filter((call) => call.table === admissionsAuditLog)
    .map((call) => call.values as Record<string, unknown>);
}

function taskInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsCaseTasks);
}

function seedItem(overrides: Partial<AdmissionsTemplateItemSeed> = {}): AdmissionsTemplateItemSeed {
  return {
    itemKey: "draft_activities_list",
    phase: "activities",
    title: "Draft the activities list",
    description: null,
    defaultOwner: "student",
    sortOrder: 0,
    ...overrides,
  };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    cohortId: COHORT_ID,
    version: 1,
    name: "Checklist v1",
    publishedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function templateItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    templateId: TEMPLATE_ID,
    itemKey: "draft_activities_list",
    phase: "activities",
    title: "Draft the activities list",
    description: null,
    defaultOwner: "student",
    sortOrder: 0,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    caseId: CASE_ID,
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    itemKey: "draft_activities_list",
    phase: "activities",
    title: "Draft the activities list",
    description: null,
    owner: "student",
    status: "not_started",
    dueDate: null,
    verifiedByEmail: null,
    verifiedAt: null,
    recurrence: null,
    sortOrder: 3,
    deletedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("DEFAULT_CHECKLIST_ITEMS", () => {
  it("covers every canonical phase with 4-8 items each", () => {
    const countsByPhase = new Map<string, number>();
    for (const item of DEFAULT_CHECKLIST_ITEMS) {
      countsByPhase.set(item.phase, (countsByPhase.get(item.phase) ?? 0) + 1);
    }
    for (const phase of ADMISSIONS_CHECKLIST_PHASES) {
      const count = countsByPhase.get(phase.key) ?? 0;
      expect(count, `phase ${phase.key}`).toBeGreaterThanOrEqual(4);
      expect(count, `phase ${phase.key}`).toBeLessThanOrEqual(8);
    }
    expect(countsByPhase.size).toBe(ADMISSIONS_CHECKLIST_PHASES.length);
  });

  it("uses unique snake_case itemKeys, valid owners, and sequential sortOrder", () => {
    const keys = new Set<string>();
    DEFAULT_CHECKLIST_ITEMS.forEach((item, index) => {
      expect(item.itemKey).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(keys.has(item.itemKey), item.itemKey).toBe(false);
      keys.add(item.itemKey);
      expect(["student", "counselor", "parent"]).toContain(item.defaultOwner);
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.sortOrder).toBe(index);
    });
  });
});

describe("createTemplateVersion", () => {
  it("creates version 1 for a cohort with no templates and audits it", async () => {
    // Queue: [cohort exists], [no prior versions].
    const { db, inserts } = fakeDb([[{ id: COHORT_ID }], []]);

    const result = await createTemplateVersion(COHORT_ID, [seedItem()], ACTOR, {}, db);

    const templateInsert = inserts.find((call) => call.table === admissionsChecklistTemplates);
    expect(templateInsert?.values).toMatchObject({
      cohortId: COHORT_ID,
      version: 1,
      publishedAt: null,
    });

    const itemInsert = inserts.find((call) => call.table === admissionsTemplateItems);
    expect(Array.isArray(itemInsert?.values)).toBe(true);
    expect((itemInsert?.values as Record<string, unknown>[])[0]).toMatchObject({
      itemKey: "draft_activities_list",
      phase: "activities",
      defaultOwner: "student",
      sortOrder: 0,
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: null,
      entityType: "checklist_template",
      action: "create",
    });

    expect(result.version).toBe(1);
    expect(result.publishedAt).toBeNull();
    expect(result.items).toHaveLength(1);
  });

  it("is immutable-by-versioning: editing after a published v3 creates v4 and never updates rows", async () => {
    const { db, inserts, updates } = fakeDb([[{ id: COHORT_ID }], [{ version: 3 }]]);

    const result = await createTemplateVersion(COHORT_ID, [seedItem()], ACTOR, {}, db);

    expect(result.version).toBe(4);
    const templateInsert = inserts.find((call) => call.table === admissionsChecklistTemplates);
    expect(templateInsert?.values).toMatchObject({ version: 4 });
    // No template or item row is ever mutated — a new version is appended.
    expect(updates).toHaveLength(0);
  });

  it("throws NotFound for a missing cohort", async () => {
    const { db } = fakeDb([[]]);

    await expect(createTemplateVersion(COHORT_ID, [seedItem()], ACTOR, {}, db))
      .rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed cohortId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(createTemplateVersion("nope", [seedItem()], ACTOR, {}, db))
      .rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });

  it("rejects an empty item list", async () => {
    const { db } = fakeDb([]);

    await expect(createTemplateVersion(COHORT_ID, [], ACTOR, {}, db))
      .rejects.toThrow(/at least one item/);
  });

  it("rejects duplicate itemKeys before any write", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(createTemplateVersion(
      COHORT_ID,
      [seedItem(), seedItem({ title: "Again" })],
      ACTOR,
      {},
      db,
    )).rejects.toThrow(/Duplicate template itemKey/);
    expect(selectCalls).toHaveLength(0);
  });

  it("rejects a non-canonical phase key (fail-closed)", async () => {
    const { db } = fakeDb([]);

    await expect(createTemplateVersion(
      COHORT_ID,
      [seedItem({ phase: "bogus" as never })],
      ACTOR,
      {},
      db,
    )).rejects.toThrow(/Invalid template item phase/);
  });

  it("rejects an unknown default owner (fail-closed)", async () => {
    const { db } = fakeDb([]);

    await expect(createTemplateVersion(
      COHORT_ID,
      [seedItem({ defaultOwner: "teacher" as never })],
      ACTOR,
      {},
      db,
    )).rejects.toThrow(/Invalid template item owner/);
  });

  it("rejects a non-snake_case itemKey", async () => {
    const { db } = fakeDb([]);

    await expect(createTemplateVersion(
      COHORT_ID,
      [seedItem({ itemKey: "Draft List!" })],
      ACTOR,
      {},
      db,
    )).rejects.toThrow(/Invalid template itemKey/);
  });
});

describe("publishTemplate", () => {
  it("publishes a draft and audits the publish", async () => {
    // Queue: [template draft], [items].
    const { db, inserts, updates } = fakeDb([[templateRow()], [templateItemRow()]]);

    const result = await publishTemplate(TEMPLATE_ID, ACTOR, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsChecklistTemplates);
    expect(updates[0].set.publishedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: null,
      entityType: "checklist_template",
      entityId: TEMPLATE_ID,
      action: "publish",
    });

    expect(result.publishedAt).not.toBeNull();
    expect(result.items).toHaveLength(1);
  });

  it("throws Conflict for an already-published template and writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([
      [templateRow({ publishedAt: new Date("2026-07-01T00:00:00Z") })],
    ]);

    await expect(publishTemplate(TEMPLATE_ID, ACTOR, db)).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws NotFound for a missing template", async () => {
    const { db } = fakeDb([[]]);

    await expect(publishTemplate(TEMPLATE_ID, ACTOR, db)).rejects.toThrow("NotFound");
  });
});

describe("getLatestTemplate", () => {
  it("returns the latest version with serialized items", async () => {
    const { db } = fakeDb([
      [templateRow({ version: 2, publishedAt: new Date("2026-07-02T00:00:00Z") })],
      [templateItemRow(), templateItemRow({ id: "item-2", itemKey: "plan_summer_activities", sortOrder: 1 })],
    ]);

    const result = await getLatestTemplate(COHORT_ID, {}, db);

    expect(result).toMatchObject({
      id: TEMPLATE_ID,
      cohortId: COHORT_ID,
      version: 2,
      publishedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(result?.items.map((item) => item.itemKey)).toEqual([
      "draft_activities_list",
      "plan_summer_activities",
    ]);
  });

  it("returns null when the cohort has no template", async () => {
    const { db } = fakeDb([[]]);

    await expect(getLatestTemplate(COHORT_ID, {}, db)).resolves.toBeNull();
  });

  it("returns null for a malformed cohortId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(getLatestTemplate("nope", {}, db)).resolves.toBeNull();
    expect(selectCalls).toHaveLength(0);
  });
});

describe("listTemplateVersions", () => {
  it("returns serialized version metadata without items", async () => {
    const { db } = fakeDb([
      [
        templateRow({
          id: "template-2",
          version: 2,
          name: "Checklist v2",
          publishedAt: new Date("2026-07-02T00:00:00Z"),
        }),
        templateRow(),
      ],
    ]);

    const result = await listTemplateVersions(COHORT_ID, db);

    expect(result).toEqual([
      {
        id: "template-2",
        cohortId: COHORT_ID,
        version: 2,
        name: "Checklist v2",
        publishedAt: "2026-07-02T00:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: TEMPLATE_ID,
        cohortId: COHORT_ID,
        version: 1,
        name: "Checklist v1",
        publishedAt: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(result.some((version) => "items" in version)).toBe(false);
  });

  it("returns an empty list when the cohort has no templates", async () => {
    const { db } = fakeDb([[]]);

    await expect(listTemplateVersions(COHORT_ID, db)).resolves.toEqual([]);
  });

  it("returns an empty list for a malformed cohortId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(listTemplateVersions("nope", db)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("seedDefaultTemplate", () => {
  it("creates a PUBLISHED template from DEFAULT_CHECKLIST_ITEMS", async () => {
    const { db, inserts } = fakeDb([[{ id: COHORT_ID }], []]);

    const result = await seedDefaultTemplate(COHORT_ID, ACTOR, db);

    const templateInsert = inserts.find((call) => call.table === admissionsChecklistTemplates);
    expect(templateInsert?.values).toMatchObject({ version: 1, name: DEFAULT_TEMPLATE_NAME });
    expect((templateInsert?.values as Record<string, unknown>).publishedAt).toBeInstanceOf(Date);

    const itemInsert = inserts.find((call) => call.table === admissionsTemplateItems);
    expect((itemInsert?.values as Record<string, unknown>[]).length)
      .toBe(DEFAULT_CHECKLIST_ITEMS.length);

    expect(result.publishedAt).not.toBeNull();
    expect(result.items).toHaveLength(DEFAULT_CHECKLIST_ITEMS.length);
  });
});

describe("instantiateChecklist", () => {
  it("copies published template items into case tasks stamped with template identity", async () => {
    // Queue: [latest published template], [items].
    const { db, inserts } = fakeDb([
      [templateRow({ version: 2, publishedAt: new Date("2026-07-02T00:00:00Z") })],
      [
        templateItemRow(),
        templateItemRow({
          id: "item-2",
          itemKey: "review_activities_with_counselor",
          title: "Review the activities list with your counselor",
          defaultOwner: "counselor",
          sortOrder: 1,
        }),
      ],
    ]);

    const result = await instantiateChecklist(CASE_ID, COHORT_ID, db);

    expect(result).toEqual({ templateId: TEMPLATE_ID, templateVersion: 2, taskCount: 2 });

    const tasks = taskInserts(inserts);
    expect(tasks).toHaveLength(1);
    const values = tasks[0].values as Record<string, unknown>[];
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({
      caseId: CASE_ID,
      templateId: TEMPLATE_ID,
      templateVersion: 2,
      itemKey: "draft_activities_list",
      phase: "activities",
      owner: "student",
      status: "not_started",
      sortOrder: 0,
    });
    expect(values[1]).toMatchObject({
      itemKey: "review_activities_with_counselor",
      owner: "counselor",
      sortOrder: 1,
    });

    // No actor passed -> no audit row (createCase's audit rows cover it).
    expect(auditInserts(inserts)).toHaveLength(0);
  });

  it("writes an audit row when an actor is provided", async () => {
    const { db, inserts } = fakeDb([
      [templateRow({ version: 1, publishedAt: new Date("2026-07-02T00:00:00Z") })],
      [templateItemRow()],
    ]);

    await instantiateChecklist(CASE_ID, COHORT_ID, db, { email: "staff@example.com", role: "counselor" });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "checklist",
      action: "instantiate",
    });
  });

  it("creates no tasks when the cohort has no published template", async () => {
    const { db, inserts } = fakeDb([[]]);

    const result = await instantiateChecklist(CASE_ID, COHORT_ID, db);

    expect(result).toEqual({ templateId: null, templateVersion: null, taskCount: 0 });
    expect(inserts).toHaveLength(0);
  });

  it("throws NotFound for malformed ids without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(instantiateChecklist("nope", COHORT_ID, db)).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});

describe("pushNewItemsToCohortCases", () => {
  const PUSH_ITEMS = [
    templateItemRow({ id: "item-a", itemKey: "a_item", sortOrder: 0 }),
    templateItemRow({ id: "item-b", itemKey: "b_item", sortOrder: 1 }),
    templateItemRow({ id: "item-c", itemKey: "c_item", sortOrder: 2, defaultOwner: "counselor" }),
  ];

  it("appends only missing itemKeys per case and never mutates existing rows", async () => {
    // Queue: [template v2], [items a/b/c], [cases A+B],
    // [existing keys: A has a+b, B has all three].
    const { db, inserts, updates } = fakeDb([
      [templateRow({ version: 2, publishedAt: new Date("2026-07-02T00:00:00Z") })],
      PUSH_ITEMS,
      [{ id: CASE_ID }, { id: CASE_ID_B }],
      [
        { caseId: CASE_ID, itemKey: "a_item" },
        { caseId: CASE_ID, itemKey: "b_item" },
        { caseId: CASE_ID_B, itemKey: "a_item" },
        { caseId: CASE_ID_B, itemKey: "b_item" },
        { caseId: CASE_ID_B, itemKey: "c_item" },
      ],
    ]);

    const result = await pushNewItemsToCohortCases(COHORT_ID, ACTOR, db);

    expect(result).toEqual({
      templateId: TEMPLATE_ID,
      templateVersion: 2,
      casesUpdated: 1,
      tasksCreated: 1,
    });

    // Only case A gets the missing "c_item", stamped with the NEW version.
    const tasks = taskInserts(inserts);
    expect(tasks).toHaveLength(1);
    const values = tasks[0].values as Record<string, unknown>[];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      caseId: CASE_ID,
      templateId: TEMPLATE_ID,
      templateVersion: 2,
      itemKey: "c_item",
      owner: "counselor",
      status: "not_started",
    });

    // Never mutates or deletes existing task rows.
    expect(updates).toHaveLength(0);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "checklist",
      action: "push_new_items",
      diff: {
        appendedItemKeys: { old: null, new: ["c_item"] },
        templateVersion: { old: null, new: 2 },
      },
    });
  });

  it("is a no-op when every case already has every itemKey", async () => {
    const { db, inserts, updates } = fakeDb([
      [templateRow({ version: 2, publishedAt: new Date("2026-07-02T00:00:00Z") })],
      PUSH_ITEMS,
      [{ id: CASE_ID }],
      [
        { caseId: CASE_ID, itemKey: "a_item" },
        { caseId: CASE_ID, itemKey: "b_item" },
        { caseId: CASE_ID, itemKey: "c_item" },
      ],
    ]);

    const result = await pushNewItemsToCohortCases(COHORT_ID, ACTOR, db);

    expect(result).toMatchObject({ casesUpdated: 0, tasksCreated: 0 });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("throws NotFound when the cohort has no published template", async () => {
    const { db } = fakeDb([[]]);

    await expect(pushNewItemsToCohortCases(COHORT_ID, ACTOR, db)).rejects.toThrow("NotFound");
  });
});

describe("updateTaskStatus", () => {
  it("lets a student tick a student-owned task on their own case (audited)", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow({ owner: "student" })]]);

    const result = await updateTaskStatus(
      { access: STUDENT_ACCESS, taskId: TASK_ID, status: "done" },
      db,
    );

    expect(result.status).toBe("done");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCaseTasks);
    expect(updates[0].set).toMatchObject({ status: "done" });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "ada@example.com",
      actorRole: "student",
      entityType: "task",
      action: "status_change",
      diff: { status: { old: "not_started", new: "done" } },
    });
  });

  it("forbids a student from ticking a counselor-owned task", async () => {
    const { db, updates } = fakeDb([[taskRow({ owner: "counselor" })]]);

    await expect(updateTaskStatus(
      { access: STUDENT_ACCESS, taskId: TASK_ID, status: "done" },
      db,
    )).rejects.toThrow("Forbidden");
    expect(updates).toHaveLength(0);
  });

  it("forbids a parent without querying (view-only role)", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateTaskStatus(
      { access: PARENT_ACCESS, taskId: TASK_ID, status: "done" },
      db,
    )).rejects.toThrow("Forbidden");
    expect(selectCalls).toHaveLength(0);
  });

  it("lets a counselor tick any task regardless of owner", async () => {
    const { db, updates } = fakeDb([[taskRow({ owner: "counselor" })]]);

    const result = await updateTaskStatus(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, status: "in_progress" },
      db,
    );

    expect(result.status).toBe("in_progress");
    expect(updates).toHaveLength(1);
  });

  it("clears counselor verification when a task leaves done (fail-closed)", async () => {
    const { db, updates } = fakeDb([[taskRow({
      owner: "student",
      status: "done",
      verifiedByEmail: "staff@example.com",
      verifiedAt: new Date("2026-07-05T00:00:00Z"),
    })]]);

    const result = await updateTaskStatus(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, status: "in_progress" },
      db,
    );

    expect(updates[0].set).toMatchObject({
      status: "in_progress",
      verifiedByEmail: null,
      verifiedAt: null,
    });
    expect(result.verifiedByEmail).toBeNull();
    expect(result.verifiedAt).toBeNull();
  });

  it("is a no-op for a same-status write", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow({ status: "done" })]]);

    const result = await updateTaskStatus(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, status: "done" },
      db,
    );

    expect(result.status).toBe("done");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("rejects an unknown status before any query (fail-closed)", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateTaskStatus(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, status: "finished" as never },
      db,
    )).rejects.toThrow(/Invalid task status/);
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound for a missing task", async () => {
    const { db } = fakeDb([[]]);

    await expect(updateTaskStatus(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, status: "done" },
      db,
    )).rejects.toThrow("NotFound");
  });
});

describe("setTaskVerified", () => {
  it("stamps counselor verification on a student-owned task (audited)", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow({ owner: "student", status: "done" })]]);

    const result = await setTaskVerified(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, verified: true },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ verifiedByEmail: "staff@example.com" });
    expect(updates[0].set.verifiedAt).toBeInstanceOf(Date);
    expect(result.verifiedByEmail).toBe("staff@example.com");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "task", action: "verify" });
  });

  it("forbids a student from verifying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(setTaskVerified(
      { access: STUDENT_ACCESS, taskId: TASK_ID, verified: true },
      db,
    )).rejects.toThrow("Forbidden");
    expect(selectCalls).toHaveLength(0);
  });

  it("rejects verification on a non-student-owned task with Conflict", async () => {
    const { db, updates } = fakeDb([[taskRow({ owner: "counselor" })]]);

    await expect(setTaskVerified(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, verified: true },
      db,
    )).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
  });

  it("clears the stamp on unverify", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow({
      owner: "student",
      verifiedByEmail: "staff@example.com",
      verifiedAt: new Date("2026-07-05T00:00:00Z"),
    })]]);

    const result = await setTaskVerified(
      { access: COUNSELOR_ACCESS, taskId: TASK_ID, verified: false },
      db,
    );

    expect(updates[0].set).toMatchObject({ verifiedByEmail: null, verifiedAt: null });
    expect(result.verifiedAt).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({ action: "unverify" });
  });

  it("is a no-op when already in the requested state", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow({ owner: "student" })]]);

    await setTaskVerified({ access: COUNSELOR_ACCESS, taskId: TASK_ID, verified: false }, db);

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe("createCustomTask", () => {
  const VALID_RECURRENCE: AdmissionsTaskRecurrence = { freq: "weekly", until: "2026-12-31" };

  it("creates a custom task with recurrence and no template linkage (audited)", async () => {
    const { db, inserts } = fakeDb([]);

    const result = await createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "  Weekly essay check-in  ",
      owner: "student",
      dueDate: "2026-08-01",
      recurrence: VALID_RECURRENCE,
    }, db);

    const tasks = taskInserts(inserts);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].values).toMatchObject({
      caseId: CASE_ID,
      templateId: null,
      templateVersion: null,
      itemKey: null,
      phase: "custom",
      title: "Weekly essay check-in",
      owner: "student",
      status: "not_started",
      dueDate: "2026-08-01",
      recurrence: VALID_RECURRENCE,
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "task", action: "create" });

    expect(result.recurrence).toEqual(VALID_RECURRENCE);
    expect(result.itemKey).toBeNull();
  });

  it("accepts a canonical phase key", async () => {
    const { db, inserts } = fakeDb([]);

    await createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "Extra essay",
      owner: "student",
      phase: "essays",
    }, db);

    expect(taskInserts(inserts)[0].values).toMatchObject({ phase: "essays" });
  });

  it("rejects an unknown phase", async () => {
    const { db } = fakeDb([]);

    await expect(createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "X",
      owner: "student",
      phase: "bogus",
    }, db)).rejects.toThrow(/Invalid task phase/);
  });

  it("rejects an invalid recurrence freq", async () => {
    const { db, inserts } = fakeDb([]);

    await expect(createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "X",
      owner: "student",
      recurrence: { freq: "daily", until: "2026-12-31" } as never,
    }, db)).rejects.toThrow(/Invalid recurrence/);
    expect(inserts).toHaveLength(0);
  });

  it("rejects a malformed recurrence end date", async () => {
    const { db } = fakeDb([]);

    await expect(createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "X",
      owner: "student",
      recurrence: { freq: "weekly", until: "12/31/2026" },
    }, db)).rejects.toThrow(/Invalid recurrence/);
  });

  it("rejects extra recurrence keys (strict shape)", async () => {
    const { db } = fakeDb([]);

    await expect(createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "X",
      owner: "student",
      recurrence: { freq: "weekly", until: "2026-12-31", count: 3 } as never,
    }, db)).rejects.toThrow(/Invalid recurrence/);
  });

  it("forbids students and parents", async () => {
    const { db } = fakeDb([]);

    await expect(createCustomTask({
      access: STUDENT_ACCESS,
      title: "X",
      owner: "student",
    }, db)).rejects.toThrow("Forbidden");
    await expect(createCustomTask({
      access: PARENT_ACCESS,
      title: "X",
      owner: "student",
    }, db)).rejects.toThrow("Forbidden");
  });

  it("rejects an empty title and an unknown owner", async () => {
    const { db } = fakeDb([]);

    await expect(createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "   ",
      owner: "student",
    }, db)).rejects.toThrow(/title must not be empty/);
    await expect(createCustomTask({
      access: COUNSELOR_ACCESS,
      title: "X",
      owner: "teacher" as never,
    }, db)).rejects.toThrow(/Invalid task owner/);
  });
});

describe("updateTask", () => {
  it("updates title and dueDate with an audited field diff", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow()]]);

    const result = await updateTask({
      access: COUNSELOR_ACCESS,
      taskId: TASK_ID,
      title: "Draft the FULL activities list",
      dueDate: "2026-09-01",
    }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({
      title: "Draft the FULL activities list",
      dueDate: "2026-09-01",
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "task",
      action: "update",
      diff: {
        title: { old: "Draft the activities list", new: "Draft the FULL activities list" },
        dueDate: { old: null, new: "2026-09-01" },
      },
    });
    expect(result.dueDate).toBe("2026-09-01");
  });

  it("is a no-op when nothing changed", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow()]]);

    await updateTask({
      access: COUNSELOR_ACCESS,
      taskId: TASK_ID,
      title: "Draft the activities list",
    }, db);

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("forbids students", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateTask({
      access: STUDENT_ACCESS,
      taskId: TASK_ID,
      title: "X",
    }, db)).rejects.toThrow("Forbidden");
    expect(selectCalls).toHaveLength(0);
  });

  it("rejects an invalid recurrence before querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateTask({
      access: COUNSELOR_ACCESS,
      taskId: TASK_ID,
      recurrence: { freq: "monthly", until: "2026-12-31" } as never,
    }, db)).rejects.toThrow(/Invalid recurrence/);
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound for a missing task", async () => {
    const { db } = fakeDb([[]]);

    await expect(updateTask({
      access: COUNSELOR_ACCESS,
      taskId: TASK_ID,
      title: "X",
    }, db)).rejects.toThrow("NotFound");
  });
});

describe("softDeleteTask", () => {
  it("rejects deleting a template-derived task with Conflict and writes nothing", async () => {
    // Default taskRow carries an itemKey (template-derived).
    const { db, inserts, updates } = fakeDb([[taskRow()]]);

    await expect(softDeleteTask({ access: COUNSELOR_ACCESS, taskId: TASK_ID }, db))
      .rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("soft-deletes a custom task (null itemKey) with an audit row", async () => {
    const { db, inserts, updates } = fakeDb([[taskRow({
      itemKey: null,
      templateId: null,
      templateVersion: null,
      phase: "custom",
    })]]);

    await softDeleteTask({ access: COUNSELOR_ACCESS, taskId: TASK_ID }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "task", action: "delete" });
  });

  it("forbids students", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(softDeleteTask({ access: STUDENT_ACCESS, taskId: TASK_ID }, db))
      .rejects.toThrow("Forbidden");
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound for a missing or already-deleted task", async () => {
    const { db } = fakeDb([[]]);

    await expect(softDeleteTask({ access: COUNSELOR_ACCESS, taskId: TASK_ID }, db))
      .rejects.toThrow("NotFound");
  });
});

describe("progress math (CM-24)", () => {
  it("computes done/total/percent/verifiedCount", () => {
    const verifiedAt = new Date("2026-07-05T00:00:00Z");
    expect(computeProgressCounts([
      { status: "done", verifiedAt },
      { status: "done", verifiedAt: null },
      { status: "in_progress", verifiedAt: null },
      { status: "not_started", verifiedAt: null },
    ])).toEqual({ done: 2, total: 4, percent: 50, verifiedCount: 1 });
  });

  it("returns the zero rollup for an empty checklist (no divide-by-zero)", () => {
    expect(computeProgressCounts([])).toEqual({ done: 0, total: 0, percent: 0, verifiedCount: 0 });
  });

  it("rounds percent to the nearest integer", () => {
    expect(computeProgressCounts([
      { status: "done", verifiedAt: null },
      { status: "not_started", verifiedAt: null },
      { status: "not_started", verifiedAt: null },
    ]).percent).toBe(33);
    expect(computeProgressCounts([
      { status: "done", verifiedAt: null },
      { status: "done", verifiedAt: null },
      { status: "not_started", verifiedAt: null },
    ]).percent).toBe(67);
  });

  it("computeProgress reads one case's live tasks", async () => {
    const { db } = fakeDb([[
      { status: "done", verifiedAt: new Date("2026-07-05T00:00:00Z") },
      { status: "not_started", verifiedAt: null },
    ]]);

    await expect(computeProgress(CASE_ID, db)).resolves.toEqual({
      done: 1,
      total: 2,
      percent: 50,
      verifiedCount: 1,
    });
  });

  it("computeProgress fails closed to zeros for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(computeProgress("nope", db)).resolves.toEqual({
      done: 0,
      total: 0,
      percent: 0,
      verifiedCount: 0,
    });
    expect(selectCalls).toHaveLength(0);
  });

  it("computeProgressMap seeds every requested case and groups rows per case", async () => {
    const { db } = fakeDb([[
      { caseId: CASE_ID, status: "done", verifiedAt: null },
      { caseId: CASE_ID, status: "not_started", verifiedAt: null },
    ]]);

    const map = await computeProgressMap([CASE_ID, CASE_ID_B], db);

    expect(map.get(CASE_ID)).toEqual({ done: 1, total: 2, percent: 50, verifiedCount: 0 });
    expect(map.get(CASE_ID_B)).toEqual({ done: 0, total: 0, percent: 0, verifiedCount: 0 });
  });

  it("computeProgressMap skips the query for empty input", async () => {
    const { db, selectCalls } = fakeDb([]);

    const map = await computeProgressMap([], db);

    expect(map.size).toBe(0);
    expect(selectCalls).toHaveLength(0);
  });
});
