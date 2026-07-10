import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsCollegeDocs,
  admissionsRecommenderColleges,
  admissionsRecommenders,
} from "@/lib/db/schema";
import {
  ADMISSIONS_RECOMMENDER_ASK_STATUSES,
  computeCollegeCompleteness,
  computeCompletenessEntry,
  createRecommender,
  isValidAskStatusTransition,
  linkRecommenderToCollege,
  listCollegeDocs,
  listRecommenders,
  setCollegeDoc,
  setRecommenderSubmission,
  softDeleteRecommender,
  updateRecommender,
  type AdmissionsRecommenderAskStatus,
} from "@/lib/admissions/recommenders";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID_B = "22222222-2222-4222-8222-222222222222";
const REC_ID = "33333333-3333-4333-8333-333333333333";
const REC_ID_B = "44444444-4444-4444-8444-444444444444";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";
const ITEM_ID_B = "66666666-6666-4666-8666-666666666666";
const ITEM_ID_C = "77777777-7777-4777-8777-777777777777";
const LINK_ID = "88888888-8888-4888-8888-888888888888";
const DOC_ID = "99999999-9999-4999-8999-999999999999";
const SITTING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ACTOR = { email: "staff@example.com", role: "counselor" as const };

interface InsertCall {
  table: unknown;
  values: Record<string, unknown> | Record<string, unknown>[];
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as checklists.test.ts). Each
 * db.select() resolves to the next queued result — the queue order must match
 * the function's query order. `insertError` makes the FIRST non-audit insert
 * reject (simulates a unique-index race).
 */
function fakeDb(queue: unknown[][], options: { insertError?: unknown } = {}) {
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
        if (options.insertError !== undefined && table !== admissionsAuditLog) {
          return {
            returning: () => Promise.reject(options.insertError),
            then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
              Promise.reject(options.insertError).then(resolve, reject),
          };
        }
        inserts.push({ table, values });
        const rows = (Array.isArray(values) ? values : [values]).map((value) => ({
          id: `generated-${generated++}`,
          roleSubject: null,
          contact: null,
          submittedAt: null,
          sentAt: null,
          testSittingId: null,
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

function recommenderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REC_ID,
    caseId: CASE_ID,
    name: "Dr. Ada Lovelace",
    roleSubject: "Math teacher",
    contact: "ada@school.example",
    askStatus: "planned",
    deletedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    recommenderId: REC_ID,
    listItemId: ITEM_ID,
    submitted: false,
    submittedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    listItemId: ITEM_ID,
    docType: "transcript",
    testSittingId: null,
    sent: false,
    sentAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

const LIVE_ITEM = { id: ITEM_ID, caseId: CASE_ID };

describe("createRecommender", () => {
  it("creates a planned recommender with trimmed fields and audits it", async () => {
    const { db, inserts } = fakeDb([]);

    const result = await createRecommender(
      CASE_ID,
      { name: "  Dr. Ada Lovelace  ", roleSubject: "  Math teacher ", contact: "   " },
      ACTOR,
      db,
    );

    const recInsert = inserts.find((call) => call.table === admissionsRecommenders);
    expect(recInsert?.values).toMatchObject({
      caseId: CASE_ID,
      name: "Dr. Ada Lovelace",
      roleSubject: "Math teacher",
      contact: null,
      askStatus: "planned",
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "staff@example.com",
      actorRole: "counselor",
      entityType: "recommender",
      action: "create",
    });

    expect(result.askStatus).toBe("planned");
    expect(result.name).toBe("Dr. Ada Lovelace");
    expect(result.contact).toBeNull();
  });

  it("rejects an empty name before any write", async () => {
    const { db, inserts } = fakeDb([]);

    await expect(createRecommender(CASE_ID, { name: "   " }, ACTOR, db))
      .rejects.toThrow(/name must not be empty/);
    expect(inserts).toHaveLength(0);
  });

  it("throws NotFound for a malformed caseId without writing", async () => {
    const { db, inserts, selectCalls } = fakeDb([]);

    await expect(createRecommender("nope", { name: "X" }, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(inserts).toHaveLength(0);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("updateRecommender askStatus transition matrix (CM-50)", () => {
  const VALID: Array<[AdmissionsRecommenderAskStatus, AdmissionsRecommenderAskStatus]> = [
    ["planned", "asked"],
    ["asked", "agreed"],
    ["asked", "declined"],
  ];
  const INVALID: Array<[AdmissionsRecommenderAskStatus, AdmissionsRecommenderAskStatus]> = [
    ["planned", "agreed"],
    ["planned", "declined"],
    ["asked", "planned"],
    ["agreed", "planned"],
    ["agreed", "asked"],
    ["agreed", "declined"],
    ["declined", "planned"],
    ["declined", "asked"],
    ["declined", "agreed"],
  ];

  it.each(VALID)("allows %s -> %s and audits the move", async (from, to) => {
    const { db, inserts, updates } = fakeDb([[recommenderRow({ askStatus: from })]]);

    const result = await updateRecommender(CASE_ID, REC_ID, { askStatus: to }, ACTOR, db);

    expect(result.askStatus).toBe(to);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsRecommenders);
    expect(updates[0].set).toMatchObject({ askStatus: to });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "recommender",
      action: "update",
      diff: { askStatus: { old: from, new: to } },
    });
  });

  it.each(INVALID)("rejects %s -> %s with Conflict and writes nothing", async (from, to) => {
    const { db, inserts, updates } = fakeDb([[recommenderRow({ askStatus: from })]]);

    await expect(updateRecommender(CASE_ID, REC_ID, { askStatus: to }, ACTOR, db))
      .rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it.each(ADMISSIONS_RECOMMENDER_ASK_STATUSES.map((status) => [status] as const))(
    "treats %s -> same status as a no-op, not a transition",
    async (status) => {
      const { db, inserts, updates } = fakeDb([[recommenderRow({ askStatus: status })]]);

      const result = await updateRecommender(
        CASE_ID,
        REC_ID,
        { askStatus: status },
        ACTOR,
        db,
      );

      expect(result.askStatus).toBe(status);
      expect(updates).toHaveLength(0);
      expect(inserts).toHaveLength(0);
    },
  );

  it("isValidAskStatusTransition mirrors the machine (same-status is not a move)", () => {
    for (const [from, to] of VALID) {
      expect(isValidAskStatusTransition(from, to), `${from}->${to}`).toBe(true);
    }
    for (const [from, to] of INVALID) {
      expect(isValidAskStatusTransition(from, to), `${from}->${to}`).toBe(false);
    }
    for (const status of ADMISSIONS_RECOMMENDER_ASK_STATUSES) {
      expect(isValidAskStatusTransition(status, status), `${status}->${status}`).toBe(false);
    }
  });
});

describe("updateRecommender field updates", () => {
  it("updates name and contact with an audited field diff", async () => {
    const { db, inserts, updates } = fakeDb([[recommenderRow()]]);

    const result = await updateRecommender(
      CASE_ID,
      REC_ID,
      { name: "Dr. Grace Hopper", contact: "grace@school.example" },
      ACTOR,
      db,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({
      name: "Dr. Grace Hopper",
      contact: "grace@school.example",
    });
    expect(auditInserts(inserts)[0]).toMatchObject({
      action: "update",
      diff: {
        name: { old: "Dr. Ada Lovelace", new: "Dr. Grace Hopper" },
        contact: { old: "ada@school.example", new: "grace@school.example" },
      },
    });
    expect(result.name).toBe("Dr. Grace Hopper");
  });

  it("rejects an unknown askStatus before any query (fail-closed)", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateRecommender(
      CASE_ID,
      REC_ID,
      { askStatus: "ghosted" as never },
      ACTOR,
      db,
    )).rejects.toThrow(/Invalid askStatus/);
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound for a missing or soft-deleted recommender", async () => {
    const { db } = fakeDb([[]]);

    await expect(updateRecommender(CASE_ID, REC_ID, { name: "X" }, ACTOR, db))
      .rejects.toThrow("NotFound");
  });

  it("throws NotFound for malformed ids without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateRecommender(CASE_ID, "nope", { name: "X" }, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});

describe("softDeleteRecommender", () => {
  it("soft-deletes and audits", async () => {
    const { db, inserts, updates } = fakeDb([[recommenderRow()]]);

    await softDeleteRecommender(CASE_ID, REC_ID, ACTOR, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsRecommenders);
    expect(updates[0].set.deletedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "recommender",
      entityId: REC_ID,
      action: "delete",
    });
  });

  it("throws NotFound for a missing or already-deleted recommender", async () => {
    const { db, updates } = fakeDb([[]]);

    await expect(softDeleteRecommender(CASE_ID, REC_ID, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(updates).toHaveLength(0);
  });
});

describe("listRecommenders", () => {
  it("returns live recommenders with their per-college links", async () => {
    const { db } = fakeDb([
      [recommenderRow(), recommenderRow({ id: REC_ID_B, name: "Mr. Alan Turing" })],
      [linkRow({ submitted: true, submittedAt: new Date("2026-07-02T00:00:00Z") })],
    ]);

    const result = await listRecommenders(CASE_ID, db);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: REC_ID, name: "Dr. Ada Lovelace" });
    expect(result[0].colleges).toEqual([{
      id: LINK_ID,
      recommenderId: REC_ID,
      listItemId: ITEM_ID,
      submitted: true,
      submittedAt: "2026-07-02T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }]);
    expect(result[1].colleges).toEqual([]);
  });

  it("skips the link query when the case has no recommenders", async () => {
    const { db, selectCalls } = fakeDb([[]]);

    await expect(listRecommenders(CASE_ID, db)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(1);
  });

  it("returns an empty list for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(listRecommenders("nope", db)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("linkRecommenderToCollege (CM-51)", () => {
  it("links a recommender to a same-case college (submitted=false) and audits", async () => {
    // Queue: [recommender], [list item], [no existing link].
    const { db, inserts } = fakeDb([[recommenderRow()], [LIVE_ITEM], []]);

    const result = await linkRecommenderToCollege(REC_ID, ITEM_ID, ACTOR, db);

    const linkInsert = inserts.find((call) => call.table === admissionsRecommenderColleges);
    expect(linkInsert?.values).toMatchObject({
      recommenderId: REC_ID,
      listItemId: ITEM_ID,
      submitted: false,
      submittedAt: null,
    });

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "recommender_college",
      action: "link",
      diff: {
        recommenderId: { old: null, new: REC_ID },
        listItemId: { old: null, new: ITEM_ID },
      },
    });

    expect(result.submitted).toBe(false);
    expect(result.submittedAt).toBeNull();
  });

  it("throws Conflict for a duplicate link and writes nothing", async () => {
    const { db, inserts } = fakeDb([[recommenderRow()], [LIVE_ITEM], [{ id: LINK_ID }]]);

    await expect(linkRecommenderToCollege(REC_ID, ITEM_ID, ACTOR, db))
      .rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("maps a unique-index race on insert to Conflict", async () => {
    const { db } = fakeDb(
      [[recommenderRow()], [LIVE_ITEM], []],
      { insertError: { code: "23505" } },
    );

    await expect(linkRecommenderToCollege(REC_ID, ITEM_ID, ACTOR, db))
      .rejects.toThrow("Conflict");
  });

  it("throws NotFound when the list item belongs to a different case", async () => {
    const { db, inserts } = fakeDb([
      [recommenderRow()],
      [{ id: ITEM_ID, caseId: CASE_ID_B }],
    ]);

    await expect(linkRecommenderToCollege(REC_ID, ITEM_ID, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(inserts).toHaveLength(0);
  });

  it("throws NotFound for a missing recommender or list item", async () => {
    const missingRec = fakeDb([[]]);
    await expect(linkRecommenderToCollege(REC_ID, ITEM_ID, ACTOR, missingRec.db))
      .rejects.toThrow("NotFound");

    const missingItem = fakeDb([[recommenderRow()], []]);
    await expect(linkRecommenderToCollege(REC_ID, ITEM_ID, ACTOR, missingItem.db))
      .rejects.toThrow("NotFound");
  });

  it("throws NotFound for malformed ids without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(linkRecommenderToCollege("nope", ITEM_ID, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});

describe("setRecommenderSubmission (CM-51)", () => {
  it("marks a link submitted with a timestamp and audits", async () => {
    // Queue: [recommender], [list item], [link].
    const { db, inserts, updates } = fakeDb([[recommenderRow()], [LIVE_ITEM], [linkRow()]]);

    const result = await setRecommenderSubmission(REC_ID, ITEM_ID, true, ACTOR, db);

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsRecommenderColleges);
    expect(updates[0].set).toMatchObject({ submitted: true });
    expect(updates[0].set.submittedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "recommender_college",
      entityId: LINK_ID,
      action: "submit",
    });

    expect(result.submitted).toBe(true);
    expect(result.submittedAt).not.toBeNull();
  });

  it("clears the timestamp when unmarking", async () => {
    const { db, inserts, updates } = fakeDb([
      [recommenderRow()],
      [LIVE_ITEM],
      [linkRow({ submitted: true, submittedAt: new Date("2026-07-02T00:00:00Z") })],
    ]);

    const result = await setRecommenderSubmission(REC_ID, ITEM_ID, false, ACTOR, db);

    expect(updates[0].set).toMatchObject({ submitted: false, submittedAt: null });
    expect(auditInserts(inserts)[0]).toMatchObject({ action: "unsubmit" });
    expect(result.submittedAt).toBeNull();
  });

  it("is a no-op when already in the requested state", async () => {
    const { db, inserts, updates } = fakeDb([
      [recommenderRow()],
      [LIVE_ITEM],
      [linkRow({ submitted: true, submittedAt: new Date("2026-07-02T00:00:00Z") })],
    ]);

    const result = await setRecommenderSubmission(REC_ID, ITEM_ID, true, ACTOR, db);

    expect(result.submitted).toBe(true);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws NotFound when the pair was never linked", async () => {
    const { db, updates } = fakeDb([[recommenderRow()], [LIVE_ITEM], []]);

    await expect(setRecommenderSubmission(REC_ID, ITEM_ID, true, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(updates).toHaveLength(0);
  });
});

describe("setCollegeDoc (CM-46)", () => {
  it("creates a sent transcript row and audits the create", async () => {
    // Queue: [list item], [no existing doc].
    const { db, inserts } = fakeDb([[LIVE_ITEM], []]);

    const result = await setCollegeDoc(ITEM_ID, "transcript", { sent: true }, ACTOR, db);

    const docInsert = inserts.find((call) => call.table === admissionsCollegeDocs);
    expect(docInsert?.values).toMatchObject({
      listItemId: ITEM_ID,
      docType: "transcript",
      testSittingId: null,
      sent: true,
    });
    expect((docInsert?.values as Record<string, unknown>).sentAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "college_doc",
      action: "create",
    });

    expect(result.docType).toBe("transcript");
    expect(result.sent).toBe(true);
    expect(result.sentAt).not.toBeNull();
  });

  it("upserts: updates the existing row instead of inserting a second one", async () => {
    const { db, inserts, updates } = fakeDb([[LIVE_ITEM], [docRow({ sent: false })]]);

    const result = await setCollegeDoc(ITEM_ID, "transcript", { sent: true }, ACTOR, db);

    expect(inserts.filter((call) => call.table === admissionsCollegeDocs)).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCollegeDocs);
    expect(updates[0].set).toMatchObject({ sent: true });
    expect(updates[0].set.sentAt).toBeInstanceOf(Date);
    expect(auditInserts(inserts)[0]).toMatchObject({
      action: "update",
      diff: { sent: { old: false, new: true } },
    });
    expect(result.sent).toBe(true);
  });

  it("clears sentAt when unmarking a sent doc", async () => {
    const { db, updates } = fakeDb([
      [LIVE_ITEM],
      [docRow({ sent: true, sentAt: new Date("2026-07-02T00:00:00Z") })],
    ]);

    const result = await setCollegeDoc(ITEM_ID, "transcript", { sent: false }, ACTOR, db);

    expect(updates[0].set).toMatchObject({ sent: false, sentAt: null });
    expect(result.sentAt).toBeNull();
  });

  it("is a no-op when the row is already in the requested state", async () => {
    const { db, inserts, updates } = fakeDb([
      [LIVE_ITEM],
      [docRow({ sent: true, sentAt: new Date("2026-07-02T00:00:00Z") })],
    ]);

    const result = await setCollegeDoc(ITEM_ID, "transcript", { sent: true }, ACTOR, db);

    expect(result.sent).toBe(true);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("creates a score_send row keyed by test sitting (same case verified)", async () => {
    // Queue: [list item], [sitting], [no existing doc].
    const { db, inserts } = fakeDb([
      [LIVE_ITEM],
      [{ id: SITTING_ID, caseId: CASE_ID }],
      [],
    ]);

    const result = await setCollegeDoc(
      ITEM_ID,
      "score_send",
      { sent: false, testSittingId: SITTING_ID },
      ACTOR,
      db,
    );

    const docInsert = inserts.find((call) => call.table === admissionsCollegeDocs);
    expect(docInsert?.values).toMatchObject({
      docType: "score_send",
      testSittingId: SITTING_ID,
      sent: false,
      sentAt: null,
    });
    expect(result.testSittingId).toBe(SITTING_ID);
  });

  it("requires a testSittingId for score_send before any query", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(setCollegeDoc(ITEM_ID, "score_send", { sent: true }, ACTOR, db))
      .rejects.toThrow(/requires a testSittingId/);
    expect(selectCalls).toHaveLength(0);
  });

  it("forbids a testSittingId for transcript/school_report before any query", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(setCollegeDoc(
      ITEM_ID,
      "transcript",
      { sent: true, testSittingId: SITTING_ID },
      ACTOR,
      db,
    )).rejects.toThrow(/only valid for score_send/);
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound when the sitting belongs to a different case", async () => {
    const { db, inserts } = fakeDb([
      [LIVE_ITEM],
      [{ id: SITTING_ID, caseId: CASE_ID_B }],
    ]);

    await expect(setCollegeDoc(
      ITEM_ID,
      "score_send",
      { sent: true, testSittingId: SITTING_ID },
      ACTOR,
      db,
    )).rejects.toThrow("NotFound");
    expect(inserts).toHaveLength(0);
  });

  it("rejects an unknown docType before any query (fail-closed)", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(setCollegeDoc(ITEM_ID, "counselor_letter" as never, { sent: true }, ACTOR, db))
      .rejects.toThrow(/Invalid docType/);
    expect(selectCalls).toHaveLength(0);
  });

  it("throws NotFound for a missing or soft-deleted list item", async () => {
    const { db, inserts } = fakeDb([[]]);

    await expect(setCollegeDoc(ITEM_ID, "transcript", { sent: true }, ACTOR, db))
      .rejects.toThrow("NotFound");
    expect(inserts).toHaveLength(0);
  });
});

describe("listCollegeDocs", () => {
  it("returns serialized docs and skips unknown stored doc types (fail-closed)", async () => {
    const { db } = fakeDb([[
      { doc: docRow({ sent: true, sentAt: new Date("2026-07-02T00:00:00Z") }) },
      { doc: docRow({ id: "doc-2", docType: "counselor_letter" }) },
    ]]);

    const result = await listCollegeDocs(CASE_ID, db);

    expect(result).toEqual([{
      id: DOC_ID,
      listItemId: ITEM_ID,
      docType: "transcript",
      testSittingId: null,
      sent: true,
      sentAt: "2026-07-02T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }]);
  });

  it("returns an empty list for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(listCollegeDocs("nope", db)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("completeness math (CM-46)", () => {
  const BASE = {
    recsAgreed: 0,
    recsSubmitted: 0,
    recsTotal: 0,
    transcriptSent: true,
    schoolReportSent: true,
    scoreSendsSent: 0,
    scoreSendsTotal: 0,
  };

  it("zero linked recommenders + both docs sent + no score sends -> complete", () => {
    expect(computeCompletenessEntry({ ...BASE }).complete).toBe(true);
  });

  it("missing transcript or school report -> incomplete", () => {
    expect(computeCompletenessEntry({ ...BASE, transcriptSent: false }).complete).toBe(false);
    expect(computeCompletenessEntry({ ...BASE, schoolReportSent: false }).complete).toBe(false);
  });

  it("partially submitted recommenders -> incomplete; all submitted -> complete", () => {
    expect(computeCompletenessEntry({
      ...BASE,
      recsAgreed: 2,
      recsSubmitted: 1,
      recsTotal: 2,
    }).complete).toBe(false);
    expect(computeCompletenessEntry({
      ...BASE,
      recsAgreed: 2,
      recsSubmitted: 2,
      recsTotal: 2,
    }).complete).toBe(true);
  });

  it("agreed-but-unsubmitted recommenders do not satisfy completeness", () => {
    expect(computeCompletenessEntry({
      ...BASE,
      recsAgreed: 1,
      recsSubmitted: 0,
      recsTotal: 1,
    }).complete).toBe(false);
  });

  it("score sends gate completeness only when at least one exists", () => {
    // No score-send rows: ignored.
    expect(computeCompletenessEntry({ ...BASE }).complete).toBe(true);
    // Rows exist but not all sent: incomplete.
    expect(computeCompletenessEntry({
      ...BASE,
      scoreSendsSent: 1,
      scoreSendsTotal: 2,
    }).complete).toBe(false);
    // All existing rows sent: complete.
    expect(computeCompletenessEntry({
      ...BASE,
      scoreSendsSent: 2,
      scoreSendsTotal: 2,
    }).complete).toBe(true);
  });
});

describe("computeCollegeCompleteness (CM-46)", () => {
  it("rolls up recommenders + docs per live list item", async () => {
    // Queue: [items], [links joined to live recommenders], [docs].
    const { db } = fakeDb([
      [{ id: ITEM_ID }, { id: ITEM_ID_B }, { id: ITEM_ID_C }],
      [
        { listItemId: ITEM_ID, submitted: true, askStatus: "agreed" },
        { listItemId: ITEM_ID, submitted: false, askStatus: "asked" },
        { listItemId: ITEM_ID_B, submitted: true, askStatus: "agreed" },
      ],
      [
        { listItemId: ITEM_ID, docType: "transcript", sent: true },
        { listItemId: ITEM_ID, docType: "school_report", sent: true },
        { listItemId: ITEM_ID, docType: "score_send", sent: true },
        { listItemId: ITEM_ID, docType: "score_send", sent: false },
        { listItemId: ITEM_ID_B, docType: "transcript", sent: true },
        { listItemId: ITEM_ID_B, docType: "school_report", sent: true },
      ],
    ]);

    const map = await computeCollegeCompleteness(CASE_ID, db);

    // Item A: one of two recs submitted + one of two score sends pending.
    expect(map.get(ITEM_ID)).toEqual({
      recsAgreed: 1,
      recsSubmitted: 1,
      recsTotal: 2,
      transcriptSent: true,
      schoolReportSent: true,
      scoreSendsSent: 1,
      complete: false,
    });
    // Item B: all recs submitted, docs sent, no score sends -> complete.
    expect(map.get(ITEM_ID_B)).toEqual({
      recsAgreed: 1,
      recsSubmitted: 1,
      recsTotal: 1,
      transcriptSent: true,
      schoolReportSent: true,
      scoreSendsSent: 0,
      complete: true,
    });
    // Item C: nothing tracked yet -> seeded zeros, incomplete.
    expect(map.get(ITEM_ID_C)).toEqual({
      recsAgreed: 0,
      recsSubmitted: 0,
      recsTotal: 0,
      transcriptSent: false,
      schoolReportSent: false,
      scoreSendsSent: 0,
      complete: false,
    });
  });

  it("marks a zero-recommender college complete once transcript + school report are sent", async () => {
    const { db } = fakeDb([
      [{ id: ITEM_ID }],
      [],
      [
        { listItemId: ITEM_ID, docType: "transcript", sent: true },
        { listItemId: ITEM_ID, docType: "school_report", sent: true },
      ],
    ]);

    const map = await computeCollegeCompleteness(CASE_ID, db);

    expect(map.get(ITEM_ID)).toMatchObject({ recsTotal: 0, complete: true });
  });

  it("does not complete a college whose only score send is unsent", async () => {
    const { db } = fakeDb([
      [{ id: ITEM_ID }],
      [],
      [
        { listItemId: ITEM_ID, docType: "transcript", sent: true },
        { listItemId: ITEM_ID, docType: "school_report", sent: true },
        { listItemId: ITEM_ID, docType: "score_send", sent: false },
      ],
    ]);

    const map = await computeCollegeCompleteness(CASE_ID, db);

    expect(map.get(ITEM_ID)).toMatchObject({ scoreSendsSent: 0, complete: false });
  });

  it("returns an empty map when the case has no live list items (one query only)", async () => {
    const { db, selectCalls } = fakeDb([[]]);

    const map = await computeCollegeCompleteness(CASE_ID, db);

    expect(map.size).toBe(0);
    expect(selectCalls).toHaveLength(1);
  });

  it("fails closed to an empty map for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    const map = await computeCollegeCompleteness("nope", db);

    expect(map.size).toBe(0);
    expect(selectCalls).toHaveLength(0);
  });
});
