import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsApplicationEvents,
  admissionsAuditLog,
  admissionsCases,
  admissionsCollegeListItems,
} from "@/lib/db/schema";
import {
  addApplicationEvent,
  addCollegeListItem,
  clearCommittedCollege,
  collectApplicationDeadlineEntries,
  collectCollegeDeadlines,
  computeApplicationWarnings,
  deriveLatestEvents,
  listApplicationEvents,
  listCollegesForCase,
  setCommittedCollege,
  softDeleteCollegeListItem,
  updateCollegeListItem,
  type AdmissionsCollegeCompleteness,
  type ApplicationWarningItem,
} from "@/lib/admissions/colleges";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID_B = "33333333-3333-4333-8333-333333333333";
const OTHER_ITEM_ID = "44444444-4444-4444-8444-444444444444";

const UPDATED_AT = new Date("2026-07-01T00:00:00Z");

const ACCESS: CaseAccess = {
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

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as cases.test.ts) with insert/update
 * recording and a native `transaction` that hands the same fake back to
 * withAuditedTransaction. Each db.select() resolves to the next queued result
 * — the queue order must match the function's query order. Inserts synthesize
 * a returning row from the given values plus defaults.
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

function itemInserts(inserts: InsertCall[]) {
  return inserts
    .filter((call) => call.table === admissionsCollegeListItems)
    .map((call) => call.values);
}

function eventInserts(inserts: InsertCall[]) {
  return inserts
    .filter((call) => call.table === admissionsApplicationEvents)
    .map((call) => call.values);
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    caseId: CASE_ID,
    unitId: 100654,
    instName: "Harvard University",
    city: "Cambridge",
    stateAbbr: "MA",
    country: "US",
    isManual: false,
    round: "rd",
    deadline: "2027-01-01",
    appStatus: "researching",
    category: "unset",
    aidOffered: null,
    aidNotes: null,
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function caseRow(committedListItemId: string | null) {
  return { id: CASE_ID, committedListItemId, updatedAt: UPDATED_AT };
}

describe("addCollegeListItem", () => {
  const IPEDS_ROW = {
    unitId: 100654,
    instName: "Harvard University",
    city: "Cambridge",
    stateAbbr: "MA",
    dataYear: "2024-25",
  };

  it("adds an IPEDS row denormalizing name/city/state with country US", async () => {
    // Queue: [latest ipeds row], [existing live items].
    const { db, inserts } = fakeDb([[IPEDS_ROW], []]);

    const result = await addCollegeListItem(
      { access: ACCESS, entry: { unitId: 100654 }, round: "rd", deadline: "2027-01-01" },
      db,
    );

    const items = itemInserts(inserts);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      caseId: CASE_ID,
      unitId: 100654,
      instName: "Harvard University",
      city: "Cambridge",
      stateAbbr: "MA",
      country: "US",
      isManual: false,
      round: "rd",
      deadline: "2027-01-01",
      appStatus: "researching",
      category: "unset",
    });
    expect(result).toMatchObject({
      unitId: 100654,
      instName: "Harvard University",
      country: "US",
      isManual: false,
      round: "rd",
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "staff@example.com",
      entityType: "college_list_item",
      action: "create",
    });
  });

  it("throws NotFound for an unknown unitId and writes nothing", async () => {
    const { db, inserts } = fakeDb([[]]);

    await expect(
      addCollegeListItem({ access: ACCESS, entry: { unitId: 999999 }, round: "rd" }, db),
    ).rejects.toThrow("NotFound");
    expect(inserts).toHaveLength(0);
  });

  it("throws Conflict when the case already lists the unitId", async () => {
    const { db, inserts } = fakeDb([
      [IPEDS_ROW],
      [{ id: OTHER_ITEM_ID, unitId: 100654, instName: "Harvard University" }],
    ]);

    await expect(
      addCollegeListItem({ access: ACCESS, entry: { unitId: 100654 }, round: "ed" }, db),
    ).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("adds a manual row with isManual true and no IPEDS lookup", async () => {
    // Queue: [existing live items] only — manual mode never queries IPEDS.
    const { db, inserts, selectCalls } = fakeDb([[]]);

    const result = await addCollegeListItem(
      {
        access: ACCESS,
        entry: { manual: { instName: "University of Oxford", country: "United Kingdom" } },
        round: "other",
      },
      db,
    );

    expect(selectCalls).toHaveLength(1);
    const items = itemInserts(inserts);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      unitId: null,
      instName: "University of Oxford",
      city: null,
      stateAbbr: null,
      country: "United Kingdom",
      isManual: true,
    });
    expect(result.isManual).toBe(true);
    expect(result.unitId).toBeNull();
  });

  it("throws Conflict on a duplicate manual name (case/whitespace-insensitive)", async () => {
    const { db, inserts } = fakeDb([
      [{ id: OTHER_ITEM_ID, unitId: null, instName: "University of Oxford" }],
    ]);

    await expect(
      addCollegeListItem(
        {
          access: ACCESS,
          entry: { manual: { instName: "  university of oxford  ", country: "United Kingdom" } },
          round: "other",
        },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("rejects student callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      addCollegeListItem({ access: STUDENT_ACCESS, entry: { unitId: 100654 }, round: "rd" }, db),
    ).rejects.toThrow("Forbidden");
  });

  it("rejects an unknown round with a descriptive error", async () => {
    const { db } = fakeDb([]);

    await expect(
      addCollegeListItem(
        { access: ACCESS, entry: { unitId: 100654 }, round: "early" as never },
        db,
      ),
    ).rejects.toThrow("Invalid application round");
  });
});

describe("updateCollegeListItem", () => {
  it("applies round/deadline/aid updates with an audited field diff", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()]]);

    const result = await updateCollegeListItem(
      {
        access: ACCESS,
        itemId: ITEM_ID,
        round: "ed",
        deadline: "2026-11-01",
        appStatus: "applying",
        category: "reach",
        aidOffered: "25000",
      },
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCollegeListItems);
    expect(updates[0].set).toMatchObject({
      round: "ed",
      deadline: "2026-11-01",
      appStatus: "applying",
      category: "reach",
      aidOffered: "25000",
    });
    expect(result).toMatchObject({ round: "ed", deadline: "2026-11-01", aidOffered: "25000" });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "college_list_item",
      action: "update",
      diff: {
        round: { old: "rd", new: "ed" },
        deadline: { old: "2027-01-01", new: "2026-11-01" },
        aidOffered: { old: null, new: "25000" },
      },
    });
  });

  it("throws Conflict when expectedUpdatedAt mismatches and writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()]]);

    await expect(
      updateCollegeListItem(
        {
          access: ACCESS,
          itemId: ITEM_ID,
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
          round: "ed",
        },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("proceeds when expectedUpdatedAt matches the current token", async () => {
    const { db, updates } = fakeDb([[itemRow()]]);

    await updateCollegeListItem(
      {
        access: ACCESS,
        itemId: ITEM_ID,
        expectedUpdatedAt: UPDATED_AT.toISOString(),
        round: "ed",
      },
      db,
    );

    expect(updates).toHaveLength(1);
  });

  it("no-ops without writes when nothing changed", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()]]);

    const result = await updateCollegeListItem(
      { access: ACCESS, itemId: ITEM_ID, round: "rd", deadline: "2027-01-01" },
      db,
    );

    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(result.round).toBe("rd");
  });

  it("throws NotFound for a missing item", async () => {
    const { db } = fakeDb([[]]);

    await expect(
      updateCollegeListItem({ access: ACCESS, itemId: ITEM_ID, round: "ed" }, db),
    ).rejects.toThrow("NotFound");
  });

  it("rejects a malformed aidOffered amount", async () => {
    const { db } = fakeDb([]);

    await expect(
      updateCollegeListItem({ access: ACCESS, itemId: ITEM_ID, aidOffered: "-500" }, db),
    ).rejects.toThrow("Invalid aidOffered");
  });
});

describe("softDeleteCollegeListItem", () => {
  it("soft-deletes and clears the committed pointer when it references the item", async () => {
    // Queue: [item row], [case row].
    const { db, inserts, updates } = fakeDb([[itemRow()], [caseRow(ITEM_ID)]]);

    await softDeleteCollegeListItem({ access: ACCESS, itemId: ITEM_ID }, db);

    expect(updates).toHaveLength(2);
    expect(updates[0].table).toBe(admissionsCollegeListItems);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);
    expect(updates[1].table).toBe(admissionsCases);
    expect(updates[1].set).toMatchObject({ committedListItemId: null });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ entityType: "college_list_item", action: "delete" });
    expect(audits[1]).toMatchObject({
      entityType: "case",
      action: "clear_committed_college",
      diff: { committedListItemId: { old: ITEM_ID, new: null } },
    });
  });

  it("leaves the committed pointer when it references another item", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()], [caseRow(OTHER_ITEM_ID)]]);

    await softDeleteCollegeListItem({ access: ACCESS, itemId: ITEM_ID }, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCollegeListItems);
    expect(auditInserts(inserts)).toHaveLength(1);
  });

  it("rejects student callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      softDeleteCollegeListItem({ access: STUDENT_ACCESS, itemId: ITEM_ID }, db),
    ).rejects.toThrow("Forbidden");
  });
});

describe("listCollegesForCase", () => {
  const STATS_2024 = {
    unitId: 100654,
    dataYear: "2024-25",
    acceptanceRate: 3.2,
    totalPriceInState: 82000,
    avgNetPrice: 19500,
    gradRateBach6yr: 96,
  };
  const STATS_2023 = { ...STATS_2024, dataYear: "2023-24", acceptanceRate: 3.4 };

  it("joins live IPEDS stats from the latest dataYear", async () => {
    // Stats queue ordered (unitId asc, dataYear desc) as the SQL would return.
    const { db } = fakeDb([[itemRow()], [STATS_2024, STATS_2023]]);

    const rows = await listCollegesForCase(CASE_ID, {}, db);

    expect(rows).toHaveLength(1);
    expect(rows[0].stats).toEqual({
      dataYear: "2024-25",
      acceptanceRate: 3.2,
      totalPriceInState: 82000,
      avgNetPrice: 19500,
      gradRateBach6yr: 96,
    });
    expect(rows[0].stale).toBe(false);
  });

  it("falls back to the denormalized copy with stale:true when the unitId vanished", async () => {
    const { db } = fakeDb([[itemRow()], []]);

    const rows = await listCollegesForCase(CASE_ID, {}, db);

    expect(rows[0].stats).toBeNull();
    expect(rows[0].stale).toBe(true);
    expect(rows[0].instName).toBe("Harvard University");
    expect(rows[0].city).toBe("Cambridge");
  });

  it("skips the IPEDS query entirely for manual-only lists", async () => {
    const { db, selectCalls } = fakeDb([
      [itemRow({ unitId: null, isManual: true, instName: "University of Oxford", country: "GB" })],
    ]);

    const rows = await listCollegesForCase(CASE_ID, {}, db);

    expect(selectCalls).toHaveLength(1);
    expect(rows[0].stats).toBeNull();
    expect(rows[0].stale).toBe(false);
  });

  it("attaches completeness from the completenessMap hook", async () => {
    const completeness: AdmissionsCollegeCompleteness = {
      recsAgreed: 1,
      recsSubmitted: 1,
      recsTotal: 2,
      transcriptSent: true,
      schoolReportSent: false,
      scoreSendsSent: 0,
      complete: false,
    };
    const { db } = fakeDb([[itemRow()], [STATS_2024]]);

    const rows = await listCollegesForCase(
      CASE_ID,
      { completenessMap: new Map([[ITEM_ID, completeness]]) },
      db,
    );

    expect(rows[0].completeness).toEqual(completeness);
  });

  it("fails closed to an empty list for a malformed caseId", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await listCollegesForCase("not-a-uuid", {}, db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("addApplicationEvent", () => {
  it("appends events so deferred → accepted chains persist", async () => {
    // Non-committed events never read the case row: one select per call.
    const first = fakeDb([[itemRow()]]);
    const deferred = await addApplicationEvent(
      { access: ACCESS, listItemId: ITEM_ID, event: "deferred", eventDate: "2026-12-15" },
      first.db,
    );

    const second = fakeDb([[itemRow()]]);
    const accepted = await addApplicationEvent(
      { access: ACCESS, listItemId: ITEM_ID, event: "accepted", eventDate: "2027-03-30" },
      second.db,
    );

    expect(deferred).toMatchObject({ listItemId: ITEM_ID, event: "deferred", eventDate: "2026-12-15" });
    expect(accepted).toMatchObject({ listItemId: ITEM_ID, event: "accepted", eventDate: "2027-03-30" });
    expect(eventInserts(second.inserts)).toHaveLength(1);
    expect(auditInserts(second.inserts)).toHaveLength(1);
    expect(auditInserts(second.inserts)[0]).toMatchObject({
      entityType: "application_event",
      action: "create",
    });
  });

  it("throws Conflict for a committed event while another item is committed", async () => {
    const { db, inserts } = fakeDb([[itemRow()], [caseRow(OTHER_ITEM_ID)]]);

    await expect(
      addApplicationEvent(
        { access: ACCESS, listItemId: ITEM_ID, event: "committed", eventDate: "2027-05-01" },
        db,
      ),
    ).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("allows a committed event when the pointer already references this item", async () => {
    const { db, inserts } = fakeDb([[itemRow()], [caseRow(ITEM_ID)]]);

    await addApplicationEvent(
      { access: ACCESS, listItemId: ITEM_ID, event: "committed", eventDate: "2027-05-01" },
      db,
    );

    expect(eventInserts(inserts)).toHaveLength(1);
  });

  it("rejects a malformed eventDate", async () => {
    const { db } = fakeDb([]);

    await expect(
      addApplicationEvent(
        { access: ACCESS, listItemId: ITEM_ID, event: "accepted", eventDate: "next week" },
        db,
      ),
    ).rejects.toThrow("Invalid eventDate");
  });
});

describe("listApplicationEvents", () => {
  it("maps rows to DTOs preserving ascending order", async () => {
    const { db } = fakeDb([[
      {
        id: "00000000-0000-4000-8000-000000000001",
        listItemId: ITEM_ID,
        event: "deferred",
        eventDate: "2026-12-15",
        notes: "Deferred to RD",
        createdAt: new Date("2026-12-15T02:00:00Z"),
        updatedAt: new Date("2026-12-15T02:00:00Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        listItemId: ITEM_ID,
        event: "accepted",
        eventDate: "2027-03-30",
        notes: null,
        createdAt: new Date("2027-03-30T02:00:00Z"),
        updatedAt: new Date("2027-03-30T02:00:00Z"),
      },
    ]]);

    const events = await listApplicationEvents(ITEM_ID, db);

    expect(events.map((event) => event.event)).toEqual(["deferred", "accepted"]);
    expect(events[0]).toMatchObject({
      listItemId: ITEM_ID,
      eventDate: "2026-12-15",
      notes: "Deferred to RD",
      createdAt: "2026-12-15T02:00:00.000Z",
    });
  });

  it("fails closed to an empty list for a malformed id", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await listApplicationEvents("nope", db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("deriveLatestEvents", () => {
  it("picks the newest event per item by eventDate then createdAt", () => {
    const latest = deriveLatestEvents([
      {
        listItemId: ITEM_ID,
        event: "deferred",
        eventDate: "2026-12-15",
        createdAt: "2026-12-15T02:00:00.000Z",
      },
      {
        listItemId: ITEM_ID,
        event: "accepted",
        eventDate: "2027-03-30",
        createdAt: "2027-03-30T02:00:00.000Z",
      },
      {
        listItemId: ITEM_ID_B,
        event: "denied",
        eventDate: "2026-12-15",
        createdAt: new Date("2026-12-15T03:00:00Z"),
      },
    ]);

    expect(latest.get(ITEM_ID)).toBe("accepted");
    expect(latest.get(ITEM_ID_B)).toBe("denied");
  });
});

describe("setCommittedCollege", () => {
  it("sets the pointer and appends the committed event in one audited transaction", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()], [caseRow(null)]]);

    const result = await setCommittedCollege(
      { access: ACCESS, listItemId: ITEM_ID, eventDate: "2027-05-01" },
      db,
    );

    expect(result).toMatchObject({ caseId: CASE_ID, committedListItemId: ITEM_ID });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCases);
    expect(updates[0].set).toMatchObject({ committedListItemId: ITEM_ID });

    const events = eventInserts(inserts);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      listItemId: ITEM_ID,
      event: "committed",
      eventDate: "2027-05-01",
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "case",
      action: "commit_college",
      diff: {
        committedListItemId: { old: null, new: ITEM_ID },
        eventDate: { old: null, new: "2027-05-01" },
      },
    });
  });

  it("throws Conflict when another item is already committed", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()], [caseRow(OTHER_ITEM_ID)]]);

    await expect(
      setCommittedCollege({ access: ACCESS, listItemId: ITEM_ID }, db),
    ).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("no-ops idempotently when the same item is already committed", async () => {
    const { db, inserts, updates } = fakeDb([[itemRow()], [caseRow(ITEM_ID)]]);

    const result = await setCommittedCollege({ access: ACCESS, listItemId: ITEM_ID }, db);

    expect(result).toMatchObject({ caseId: CASE_ID, committedListItemId: ITEM_ID });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("rejects student callers with Forbidden", async () => {
    const { db } = fakeDb([]);

    await expect(
      setCommittedCollege({ access: STUDENT_ACCESS, listItemId: ITEM_ID }, db),
    ).rejects.toThrow("Forbidden");
  });
});

describe("clearCommittedCollege", () => {
  it("clears the pointer with an audited diff", async () => {
    const { db, inserts, updates } = fakeDb([[caseRow(ITEM_ID)]]);

    const result = await clearCommittedCollege({ access: ACCESS }, db);

    expect(result).toMatchObject({ caseId: CASE_ID, committedListItemId: null });
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ committedListItemId: null });
    expect(auditInserts(inserts)[0]).toMatchObject({
      entityType: "case",
      action: "clear_committed_college",
      diff: { committedListItemId: { old: ITEM_ID, new: null } },
    });
  });

  it("no-ops when nothing is committed", async () => {
    const { db, inserts, updates } = fakeDb([[caseRow(null)]]);

    const result = await clearCommittedCollege({ access: ACCESS }, db);

    expect(result.committedListItemId).toBeNull();
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

describe("computeApplicationWarnings", () => {
  const ed = (id: string, latestEvent?: ApplicationWarningItem["latestEvent"]) =>
    ({ id, round: "ed", latestEvent }) as ApplicationWarningItem;
  const ed2 = (id: string, latestEvent?: ApplicationWarningItem["latestEvent"]) =>
    ({ id, round: "ed2", latestEvent }) as ApplicationWarningItem;
  const rea = (id: string, latestEvent?: ApplicationWarningItem["latestEvent"]) =>
    ({ id, round: "rea", latestEvent }) as ApplicationWarningItem;

  it("warns on two active ED/ED2 items", () => {
    const warnings = computeApplicationWarnings([ed("a"), ed2("b")]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "multiple_early_decision",
      listItemIds: ["a", "b"],
    });
  });

  it("does not warn when one ED is denied (deactivated)", () => {
    expect(computeApplicationWarnings([ed("a", "denied"), ed2("b")])).toEqual([]);
  });

  it("does not warn when one ED is withdrawn", () => {
    expect(computeApplicationWarnings([ed("a", "withdrawn"), rea("b")])).toEqual([]);
  });

  it("warns on REA alongside an active ED", () => {
    const warnings = computeApplicationWarnings([rea("a"), ed("b")]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "rea_with_early_decision",
      listItemIds: ["a", "b"],
    });
  });

  it("warns on REA alongside an active ED2", () => {
    const warnings = computeApplicationWarnings([rea("a"), ed2("b")]);

    expect(warnings.map((warning) => warning.code)).toEqual(["rea_with_early_decision"]);
  });

  it("emits both warnings for ED + ED2 + REA", () => {
    const warnings = computeApplicationWarnings([ed("a"), ed2("b"), rea("c")]);

    expect(warnings.map((warning) => warning.code)).toEqual([
      "multiple_early_decision",
      "rea_with_early_decision",
    ]);
  });

  it("stays silent on safe combinations (single ED, EA, RD, rolling)", () => {
    expect(
      computeApplicationWarnings([
        ed("a"),
        { id: "b", round: "ea" },
        { id: "c", round: "rd" },
        { id: "d", round: "rolling" },
      ]),
    ).toEqual([]);
  });

  it("returns [] for an empty list", () => {
    expect(computeApplicationWarnings([])).toEqual([]);
  });
});

describe("collectApplicationDeadlineEntries", () => {
  const OTHER_CASE_ID = "55555555-5555-4555-8555-555555555555";

  it("returns unstamped calendar entries across a batch of cases in one query", async () => {
    const { db, selectCalls } = fakeDb([[
      {
        id: ITEM_ID,
        caseId: CASE_ID,
        instName: "Harvard University",
        round: "ed",
        deadline: "2026-11-01",
        appStatus: "submitted",
      },
      {
        id: ITEM_ID_B,
        caseId: OTHER_CASE_ID,
        instName: "Cornell University",
        round: "rd",
        deadline: "2027-01-02",
        appStatus: "researching",
      },
    ]]);

    const entries = await collectApplicationDeadlineEntries([CASE_ID, OTHER_CASE_ID], db);

    expect(selectCalls).toHaveLength(1);
    expect(entries).toEqual([
      {
        id: ITEM_ID,
        caseId: CASE_ID,
        source: "application",
        title: "Harvard University — ED deadline",
        date: "2026-11-01",
        ownerRole: null,
        completed: true,
      },
      {
        id: ITEM_ID_B,
        caseId: OTHER_CASE_ID,
        source: "application",
        title: "Cornell University — RD deadline",
        date: "2027-01-02",
        ownerRole: null,
        completed: false,
      },
    ]);
  });

  it("skips rows with malformed stored deadlines (fail-closed)", async () => {
    const { db } = fakeDb([[
      {
        id: ITEM_ID,
        caseId: CASE_ID,
        instName: "Harvard University",
        round: "ed",
        deadline: "soon",
        appStatus: "applying",
      },
    ]]);

    expect(await collectApplicationDeadlineEntries([CASE_ID], db)).toEqual([]);
  });

  it("drops malformed caseIds and returns [] without querying when none remain", async () => {
    const { db, selectCalls } = fakeDb([]);

    expect(await collectApplicationDeadlineEntries(["nope"], db)).toEqual([]);
    expect(await collectApplicationDeadlineEntries([], db)).toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("collectCollegeDeadlines", () => {
  // 2026-12-01 00:00 UTC = 2026-12-01 07:00 Asia/Bangkok → today is 2026-12-01.
  const NOW = new Date("2026-12-01T00:00:00Z");
  const WINDOW = { from: "2026-11-01", to: "2027-01-31" };

  it("returns application-source rows in the window with overdue stamped", async () => {
    const { db } = fakeDb([[
      {
        id: ITEM_ID,
        caseId: CASE_ID,
        instName: "Harvard University",
        round: "ed",
        deadline: "2026-11-01",
        appStatus: "applying",
      },
      {
        id: ITEM_ID_B,
        caseId: CASE_ID,
        instName: "Yale University",
        round: "ea",
        deadline: "2026-11-15",
        appStatus: "submitted",
      },
      {
        id: OTHER_ITEM_ID,
        caseId: CASE_ID,
        instName: "Cornell University",
        round: "rd",
        deadline: "2027-01-02",
        appStatus: "researching",
      },
    ]]);

    const items = await collectCollegeDeadlines(CASE_ID, WINDOW, NOW, db);

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.date)).toEqual(["2026-11-01", "2026-11-15", "2027-01-02"]);
    expect(items[0]).toMatchObject({
      id: ITEM_ID,
      caseId: CASE_ID,
      source: "application",
      title: "Harvard University — ED deadline",
      overdue: true,
      completed: false,
      ownerRole: null,
    });
    // Submitted application: past deadline but completed, never overdue.
    expect(items[1]).toMatchObject({ overdue: false, completed: true });
    // Future deadline: open but not overdue.
    expect(items[2]).toMatchObject({ overdue: false, completed: false });
  });

  it("filters rows outside the window", async () => {
    const { db } = fakeDb([[
      {
        id: ITEM_ID,
        caseId: CASE_ID,
        instName: "Harvard University",
        round: "ed",
        deadline: "2026-10-31",
        appStatus: "applying",
      },
    ]]);

    expect(await collectCollegeDeadlines(CASE_ID, WINDOW, NOW, db)).toEqual([]);
  });

  it("throws on an inverted window", async () => {
    const { db } = fakeDb([]);

    await expect(
      collectCollegeDeadlines(CASE_ID, { from: "2027-01-01", to: "2026-01-01" }, NOW, db),
    ).rejects.toThrow("from must be on or before to");
  });

  it("throws NotFound for a malformed caseId", async () => {
    const { db } = fakeDb([]);

    await expect(
      collectCollegeDeadlines("nope", WINDOW, NOW, db),
    ).rejects.toThrow("NotFound");
  });
});
