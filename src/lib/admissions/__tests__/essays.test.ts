import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { admissionsAuditLog, admissionsEssays } from "@/lib/db/schema";
import {
  collectEssayDeadlineEntries,
  collectEssayDeadlines,
  createEssay,
  listEssaysForCase,
  softDeleteEssay,
  updateEssay,
} from "@/lib/admissions/essays";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CASE_ID = "55555555-5555-4555-8555-555555555555";
const ESSAY_ID = "22222222-2222-4222-8222-222222222222";
const ESSAY_ID_B = "33333333-3333-4333-8333-333333333333";
const LIST_ITEM_ID = "44444444-4444-4444-8444-444444444444";

const UPDATED_AT = new Date("2026-07-01T00:00:00Z");

const COUNSELOR_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "staff@example.com",
  role: "counselor",
  isAdmin: false,
};

const STUDENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

const PARENT_ACCESS: CaseAccess = {
  caseId: CASE_ID,
  email: "parent@example.com",
  role: "parent",
  isAdmin: false,
};

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as colleges.test.ts) with
 * insert/update recording and a native `transaction` that hands the same
 * fake back to withAuditedTransaction. Each db.select() resolves to the next
 * queued result — the queue order must match the function's query order.
 * Inserts synthesize a returning row from the given values plus defaults.
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  let generated = 0;
  const selectCalls: number[] = [];
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  function selectBuilder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "groupBy", "limit", "for"]) {
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
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = {
          id: `00000000-0000-4000-8000-${String(generated++).padStart(12, "0")}`,
          deletedAt: null,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-01T00:00:00Z"),
          ...values,
        };
        return {
          returning: () => Promise.resolve([row]),
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
  return inserts.filter((call) => call.table === admissionsAuditLog).map((call) => call.values);
}

function essayInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsEssays).map((call) => call.values);
}

function essayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESSAY_ID,
    caseId: CASE_ID,
    listItemId: null,
    prompt: "Personal statement",
    status: "drafting",
    counselorStage: null,
    deadline: "2026-11-01",
    driveUrl: null,
    sharedWithFamily: false,
    lastStudentUpdateAt: null,
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("createEssay", () => {
  it("lets a student create a row and stamps lastStudentUpdateAt", async () => {
    const { db, inserts } = fakeDb([]);

    const result = await createEssay(
      { access: STUDENT_ACCESS, prompt: "  Why this college?  " },
      db,
    );

    const rows = essayInserts(inserts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: CASE_ID,
      prompt: "Why this college?",
      status: "not_started",
      counselorStage: null,
      deadline: null,
      listItemId: null,
      driveUrl: null,
    });
    expect(rows[0].lastStudentUpdateAt).toBeInstanceOf(Date);
    expect(result.lastStudentUpdateAt).not.toBeNull();
    expect(result.status).toBe("not_started");

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "essay",
      action: "create",
    });
  });

  it("leaves lastStudentUpdateAt null on a counselor creation", async () => {
    const { db, inserts } = fakeDb([]);

    const result = await createEssay(
      { access: COUNSELOR_ACCESS, prompt: "Community essay" },
      db,
    );

    expect(essayInserts(inserts)[0].lastStudentUpdateAt).toBeNull();
    expect(result.lastStudentUpdateAt).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({ actorRole: "counselor" });
  });

  it("verifies a provided listItemId against the case's live list", async () => {
    const { db, inserts, selectCalls } = fakeDb([[{ id: LIST_ITEM_ID }]]);

    const result = await createEssay(
      { access: COUNSELOR_ACCESS, prompt: "Supplement", listItemId: LIST_ITEM_ID },
      db,
    );

    expect(selectCalls).toHaveLength(1);
    expect(essayInserts(inserts)[0].listItemId).toBe(LIST_ITEM_ID);
    expect(result.listItemId).toBe(LIST_ITEM_ID);
  });

  it("throws NotFound for a listItemId outside the case and writes nothing", async () => {
    const { db, inserts } = fakeDb([[]]);

    await expect(
      createEssay(
        { access: COUNSELOR_ACCESS, prompt: "Supplement", listItemId: LIST_ITEM_ID },
        db,
      ),
    ).rejects.toThrow("NotFound");
    expect(inserts).toHaveLength(0);
  });

  it("rejects parent callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      createEssay({ access: PARENT_ACCESS, prompt: "Anything" }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects an empty prompt", async () => {
    const { db } = fakeDb([]);

    await expect(
      createEssay({ access: STUDENT_ACCESS, prompt: "   " }, db),
    ).rejects.toThrow("non-empty prompt");
  });

  it("rejects a malformed deadline", async () => {
    const { db } = fakeDb([]);

    await expect(
      createEssay({ access: COUNSELOR_ACCESS, prompt: "P", deadline: "soon" }, db),
    ).rejects.toThrow("Invalid deadline");
  });

  it("rejects an essay link containing embedded credentials before writing", async () => {
    const { db, inserts } = fakeDb([]);

    await expect(createEssay({
      access: STUDENT_ACCESS,
      prompt: "Personal statement",
      driveUrl: "https://student:secret@docs.google.com/document/d/abc",
    }, db)).rejects.toThrow("Invalid driveUrl");
    expect(inserts).toHaveLength(0);
  });

  it("keeps college linkage and deadlines counselor-owned on creation", async () => {
    const { db } = fakeDb([]);
    await expect(createEssay({
      access: STUDENT_ACCESS,
      prompt: "Supplement",
      listItemId: LIST_ITEM_ID,
    }, db)).rejects.toThrow("Forbidden");
    await expect(createEssay({
      access: STUDENT_ACCESS,
      prompt: "Supplement",
      deadline: "2026-11-01",
    }, db)).rejects.toThrow("Forbidden");
  });
});

describe("updateEssay", () => {
  it("lets counselors explicitly share an essay with family and forbids students", async () => {
    const allowed = fakeDb([[essayRow()]]);
    const result = await updateEssay({
      access: COUNSELOR_ACCESS,
      essayId: ESSAY_ID,
      sharedWithFamily: true,
    }, allowed.db);
    expect(result.sharedWithFamily).toBe(true);
    expect(allowed.updates[0].set).toMatchObject({ sharedWithFamily: true });
    expect(auditInserts(allowed.inserts)[0]).toMatchObject({ action: "update" });

    const denied = fakeDb([]);
    await expect(updateEssay({
      access: STUDENT_ACCESS,
      essayId: ESSAY_ID,
      sharedWithFamily: true,
    }, denied.db)).rejects.toThrow("Forbidden");
  });
  it("stamps lastStudentUpdateAt on a student status write", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow({ status: "drafting" })]]);

    const result = await updateEssay(
      { access: STUDENT_ACCESS, essayId: ESSAY_ID, status: "feedback" },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsEssays);
    expect(updates[0].set.status).toBe("feedback");
    expect(updates[0].set.lastStudentUpdateAt).toBeInstanceOf(Date);
    expect(result.status).toBe("feedback");
    expect(result.lastStudentUpdateAt).not.toBeNull();

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorEmail: "student@example.com",
      actorRole: "student",
      entityType: "essay",
      action: "update",
      diff: { status: { old: "drafting", new: "feedback" } },
    });
  });

  it("stamps lastStudentUpdateAt on student prompt/driveUrl writes too", async () => {
    const { db, updates } = fakeDb([[essayRow()]]);

    await updateEssay(
      {
        access: STUDENT_ACCESS,
        essayId: ESSAY_ID,
        prompt: "Revised prompt",
        driveUrl: "https://docs.google.com/document/d/abc",
      },
      db,
    );

    expect(updates[0].set).toMatchObject({
      prompt: "Revised prompt",
      driveUrl: "https://docs.google.com/document/d/abc",
    });
    expect(updates[0].set.lastStudentUpdateAt).toBeInstanceOf(Date);
  });

  it("lets a counselor set counselorStage and deadline without touching the staleness clock", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow()]]);

    const result = await updateEssay(
      {
        access: COUNSELOR_ACCESS,
        essayId: ESSAY_ID,
        counselorStage: "feedback",
        deadline: "2026-12-15",
      },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({
      counselorStage: "feedback",
      deadline: "2026-12-15",
    });
    expect(updates[0].set.lastStudentUpdateAt).toBeUndefined();
    expect(result.counselorStage).toBe("feedback");
    expect(result.lastStudentUpdateAt).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({ actorRole: "counselor" });
  });

  it("attributes a counselor status override without stamping lastStudentUpdateAt", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow({ status: "drafting" })]]);

    await updateEssay(
      { access: COUNSELOR_ACCESS, essayId: ESSAY_ID, status: "final" },
      db,
    );

    expect(updates[0].set.status).toBe("final");
    expect(updates[0].set.lastStudentUpdateAt).toBeUndefined();
    expect(auditInserts(inserts)[0]).toMatchObject({
      actorRole: "counselor",
      diff: { status: { old: "drafting", new: "final" } },
    });
  });

  it("rejects a student setting counselor-only fields with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      updateEssay(
        { access: STUDENT_ACCESS, essayId: ESSAY_ID, counselorStage: "final" },
        db,
      ),
    ).rejects.toThrow("Forbidden");
    await expect(
      updateEssay(
        { access: STUDENT_ACCESS, essayId: ESSAY_ID, deadline: "2026-12-15" },
        db,
      ),
    ).rejects.toThrow("Forbidden");
    await expect(
      updateEssay(
        { access: STUDENT_ACCESS, essayId: ESSAY_ID, listItemId: LIST_ITEM_ID },
        db,
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("throws Conflict when expectedUpdatedAt mismatches and writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow()]]);

    await expect(
      updateEssay(
        {
          access: STUDENT_ACCESS,
          essayId: ESSAY_ID,
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
          status: "final",
        },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("proceeds when expectedUpdatedAt matches the current token", async () => {
    const { db, updates } = fakeDb([[essayRow()]]);

    await updateEssay(
      {
        access: STUDENT_ACCESS,
        essayId: ESSAY_ID,
        expectedUpdatedAt: UPDATED_AT.toISOString(),
        status: "final",
      },
      db,
    );

    expect(updates).toHaveLength(1);
  });

  it("no-ops without writes (and without a staleness stamp) when nothing changed", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow({ status: "drafting" })]]);

    const result = await updateEssay(
      { access: STUDENT_ACCESS, essayId: ESSAY_ID, status: "drafting" },
      db,
    );

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.lastStudentUpdateAt).toBeNull();
  });

  it("clears counselorStage with an explicit null (audited old→null)", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow({ counselorStage: "feedback" })]]);

    await updateEssay(
      { access: COUNSELOR_ACCESS, essayId: ESSAY_ID, counselorStage: null },
      db,
    );

    expect(updates[0].set.counselorStage).toBeNull();
    expect(auditInserts(inserts)[0]).toMatchObject({
      diff: { counselorStage: { old: "feedback", new: null } },
    });
  });

  it("verifies a relinked listItemId against the case's live list", async () => {
    // Queue: [essay row], [list item check → miss].
    const { db, updates } = fakeDb([[essayRow()], []]);

    await expect(
      updateEssay(
        { access: COUNSELOR_ACCESS, essayId: ESSAY_ID, listItemId: LIST_ITEM_ID },
        db,
      ),
    ).rejects.toThrow("NotFound");
    expect(updates).toHaveLength(0);
  });

  it("throws NotFound for a missing essay", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      updateEssay({ access: STUDENT_ACCESS, essayId: ESSAY_ID, status: "final" }, db),
    ).rejects.toThrow("NotFound");
  });

  it("rejects an unknown status with a descriptive error", async () => {
    const { db } = fakeDb([]);

    await expect(
      updateEssay(
        { access: STUDENT_ACCESS, essayId: ESSAY_ID, status: "polishing" as never },
        db,
      ),
    ).rejects.toThrow("Invalid essay status");
  });
});

describe("softDeleteEssay", () => {
  it("soft-deletes with an audited diff (counselor+)", async () => {
    const { db, inserts, updates } = fakeDb([[essayRow()]]);

    await softDeleteEssay({ access: COUNSELOR_ACCESS, essayId: ESSAY_ID }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsEssays);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "essay", action: "delete" });
  });

  it("rejects student callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteEssay({ access: STUDENT_ACCESS, essayId: ESSAY_ID }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("throws NotFound for a malformed essayId", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteEssay({ access: COUNSELOR_ACCESS, essayId: "nope" }, db),
    ).rejects.toThrow("NotFound");
  });
});

describe("listEssaysForCase", () => {
  const NOW = new Date("2026-12-01T00:00:00Z");

  it("computes stalenessDays as whole days, null when never student-updated", async () => {
    const { db } = fakeDb([[
      essayRow({ id: ESSAY_ID, lastStudentUpdateAt: null }),
      essayRow({
        id: ESSAY_ID_B,
        lastStudentUpdateAt: new Date("2026-11-28T00:00:00Z"),
      }),
      essayRow({
        id: LIST_ITEM_ID,
        lastStudentUpdateAt: new Date("2026-11-30T23:00:00Z"),
      }),
    ]]);

    const rows = await listEssaysForCase(CASE_ID, { now: NOW }, db);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(ESSAY_ID)?.stalenessDays).toBeNull();
    expect(byId.get(ESSAY_ID_B)?.stalenessDays).toBe(3);
    expect(byId.get(LIST_ITEM_ID)?.stalenessDays).toBe(0);
  });

  it("derives effectiveStage as counselorStage ?? status (CM-62 override)", async () => {
    const { db } = fakeDb([[
      essayRow({ id: ESSAY_ID, status: "drafting", counselorStage: "feedback" }),
      essayRow({ id: ESSAY_ID_B, status: "brainstorming", counselorStage: null }),
    ]]);

    const rows = await listEssaysForCase(CASE_ID, { now: NOW }, db);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(ESSAY_ID)?.effectiveStage).toBe("feedback");
    expect(byId.get(ESSAY_ID_B)?.effectiveStage).toBe("brainstorming");
  });

  it("sorts by the CM-63 key: overdue first, then soonest, stale-est on ties, undated last", async () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const d = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const e = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const { db } = fakeDb([[
      // A: soon deadline, updated 10 days ago.
      essayRow({ id: a, deadline: "2026-12-10", lastStudentUpdateAt: new Date("2026-11-21T00:00:00Z") }),
      // B: overdue deadline, updated today (fresh but overdue → first).
      essayRow({ id: b, deadline: "2026-11-01", lastStudentUpdateAt: NOW }),
      // C: same deadline as A, never student-updated (most stale → before A).
      essayRow({ id: c, deadline: "2026-12-10", lastStudentUpdateAt: null }),
      // D: no deadline, updated 50 days ago.
      essayRow({ id: d, deadline: null, lastStudentUpdateAt: new Date("2026-10-12T00:00:00Z") }),
      // E: no deadline, never student-updated (most stale of the undated).
      essayRow({ id: e, deadline: null, lastStudentUpdateAt: null }),
    ]]);

    const rows = await listEssaysForCase(CASE_ID, { now: NOW }, db);

    expect(rows.map((row) => row.id)).toEqual([b, c, a, e, d]);
  });

  it("fails closed to an empty list for a malformed caseId", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await listEssaysForCase("not-a-uuid", { now: NOW }, db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("collectEssayDeadlineEntries", () => {
  it("returns unstamped calendar entries across a batch of cases in one query", async () => {
    const { db, selectCalls } = fakeDb([[
      {
        id: ESSAY_ID,
        caseId: CASE_ID,
        prompt: "Why us?",
        status: "drafting",
        counselorStage: null,
        deadline: "2026-11-01",
      },
      {
        id: ESSAY_ID_B,
        caseId: OTHER_CASE_ID,
        prompt: "Leadership",
        status: "drafting",
        counselorStage: "final",
        deadline: "2027-01-02",
      },
    ]]);

    const entries = await collectEssayDeadlineEntries([CASE_ID, OTHER_CASE_ID], db);

    expect(selectCalls).toHaveLength(1);
    expect(entries).toEqual([
      {
        id: ESSAY_ID,
        caseId: CASE_ID,
        source: "essay",
        title: "Essay: Why us?",
        date: "2026-11-01",
        ownerRole: "student",
        completed: false,
      },
      {
        id: ESSAY_ID_B,
        caseId: OTHER_CASE_ID,
        source: "essay",
        title: "Essay: Leadership",
        date: "2027-01-02",
        ownerRole: "student",
        // counselorStage "final" overrides the student status (CM-62).
        completed: true,
      },
    ]);
  });

  it("truncates long prompts in the title at 80 chars with an ellipsis", async () => {
    const { db } = fakeDb([[
      {
        id: ESSAY_ID,
        caseId: CASE_ID,
        prompt: "x".repeat(100),
        status: "drafting",
        counselorStage: null,
        deadline: "2026-11-01",
      },
    ]]);

    const entries = await collectEssayDeadlineEntries([CASE_ID], db);

    expect(entries[0].title).toBe(`Essay: ${"x".repeat(79)}…`);
  });

  it("skips rows with malformed stored deadlines (fail-closed)", async () => {
    const { db } = fakeDb([[
      {
        id: ESSAY_ID,
        caseId: CASE_ID,
        prompt: "Why us?",
        status: "drafting",
        counselorStage: null,
        deadline: "soon",
      },
    ]]);

    expect(await collectEssayDeadlineEntries([CASE_ID], db)).toEqual([]);
  });

  it("drops malformed caseIds and returns [] without querying when none remain", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await collectEssayDeadlineEntries(["nope"], db)).toEqual([]);
    expect(await collectEssayDeadlineEntries([], db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("collectEssayDeadlines", () => {
  // 2026-12-01 00:00 UTC = 2026-12-01 07:00 Asia/Bangkok → today is 2026-12-01.
  const NOW = new Date("2026-12-01T00:00:00Z");
  const WINDOW = { from: "2026-11-01", to: "2027-01-31" };

  it("returns essay-source rows in the window with overdue stamped", async () => {
    const { db } = fakeDb([[
      {
        id: ESSAY_ID,
        caseId: CASE_ID,
        prompt: "Why us?",
        status: "drafting",
        counselorStage: null,
        deadline: "2026-11-01",
      },
      {
        id: ESSAY_ID_B,
        caseId: CASE_ID,
        prompt: "Community",
        status: "drafting",
        counselorStage: "final",
        deadline: "2026-11-15",
      },
      {
        id: LIST_ITEM_ID,
        caseId: CASE_ID,
        prompt: "Leadership",
        status: "final",
        counselorStage: null,
        deadline: "2027-01-02",
      },
    ]]);

    const items = await collectEssayDeadlines(CASE_ID, WINDOW, NOW, db);

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.date)).toEqual(["2026-11-01", "2026-11-15", "2027-01-02"]);
    expect(items[0]).toMatchObject({
      id: ESSAY_ID,
      caseId: CASE_ID,
      source: "essay",
      title: "Essay: Why us?",
      overdue: true,
      completed: false,
      ownerRole: "student",
    });
    // Past deadline but effective stage "final": completed, never overdue.
    expect(items[1]).toMatchObject({ overdue: false, completed: true });
    // Future deadline, student-set "final": completed and not overdue.
    expect(items[2]).toMatchObject({ overdue: false, completed: true });
  });

  it("filters rows outside the window", async () => {
    const { db } = fakeDb([[
      {
        id: ESSAY_ID,
        caseId: CASE_ID,
        prompt: "Why us?",
        status: "drafting",
        counselorStage: null,
        deadline: "2026-10-31",
      },
    ]]);

    expect(await collectEssayDeadlines(CASE_ID, WINDOW, NOW, db)).toEqual([]);
  });

  it("throws on an inverted window", async () => {
    const { db } = fakeDb([]);

    await expect(
      collectEssayDeadlines(CASE_ID, { from: "2027-01-01", to: "2026-01-01" }, NOW, db),
    ).rejects.toThrow("from must be on or before to");
  });

  it("throws NotFound for a malformed caseId", async () => {
    const { db } = fakeDb([]);

    await expect(
      collectEssayDeadlines("nope", WINDOW, NOW, db),
    ).rejects.toThrow("NotFound");
  });
});
