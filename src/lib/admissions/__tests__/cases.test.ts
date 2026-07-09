import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsCaseMembers,
  admissionsCases,
  admissionsCaseTasks,
  admissionsChecklistTemplates,
  admissionsStudents,
  admissionsTemplateItems,
} from "@/lib/db/schema";
import {
  CASE_LIFECYCLE_TRANSITIONS,
  createCase,
  getCaseDetail,
  getCaseloadForUser,
  isValidCaseTransition,
  updateCaseLifecycle,
  updateCaseProfile,
} from "@/lib/admissions/cases";
import { DEFAULT_TEMPLATE_NAME } from "@/lib/admissions/checklists";
import { DEFAULT_CHECKLIST_ITEMS } from "@/lib/admissions/config";
import type { AdmissionsCaseStatus } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID_B = "22222222-2222-4222-8222-222222222222";
const CASE_ID_C = "33333333-3333-4333-8333-333333333333";
const COHORT_ID = "44444444-4444-4444-8444-444444444444";
const STUDENT_ID = "55555555-5555-4555-8555-555555555555";
const ITEM_ID = "66666666-6666-4666-8666-666666666666";
const TEMPLATE_ID = "77777777-7777-4777-8777-777777777777";

const ACTOR = { email: "staff@example.com", role: "counselor" as const };

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Chainable Drizzle stand-in (same style as access.test.ts) extended with
 * insert/update recording and a native `transaction` that hands the same fake
 * back to withAuditedTransaction. Each db.select() resolves to the next
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
        // Generated ids are uuid-shaped so downstream shape checks
        // (e.g. instantiateChecklist on the new case id) pass.
        const row = {
          id: `00000000-0000-4000-8000-${String(generated++).padStart(12, "0")}`,
          invitedAt: null,
          activatedAt: null,
          revokedAt: null,
          addedByEmail: null,
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

function memberInserts(inserts: InsertCall[]) {
  return inserts.filter((call) => call.table === admissionsCaseMembers).map((call) => call.values);
}

describe("case lifecycle transition matrix", () => {
  const ALL_STATUSES: AdmissionsCaseStatus[] = [
    "active",
    "committed",
    "completed",
    "withdrawn",
    "archived",
  ];
  const VALID: Array<[AdmissionsCaseStatus, AdmissionsCaseStatus]> = [
    ["active", "committed"],
    ["active", "withdrawn"],
    ["committed", "completed"],
    ["completed", "archived"],
    ["withdrawn", "archived"],
  ];

  it("allows exactly the design §8 transitions and nothing else", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = VALID.some(([f, t]) => f === from && t === to);
        expect(isValidCaseTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("declares no outbound transitions from archived (terminal)", () => {
    expect(CASE_LIFECYCLE_TRANSITIONS.archived).toEqual([]);
  });
});

describe("updateCaseLifecycle", () => {
  it("applies active -> committed with an audited status diff", async () => {
    const { db, inserts, updates } = fakeDb([[{ id: CASE_ID, status: "active" }]]);

    const result = await updateCaseLifecycle(CASE_ID, "committed", ACTOR, db);

    expect(result).toMatchObject({
      caseId: CASE_ID,
      previousStatus: "active",
      status: "committed",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(admissionsCases);
    expect(updates[0].set).toMatchObject({ status: "committed" });
    expect(updates[0].set.statusChangedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      actorEmail: "staff@example.com",
      actorRole: "counselor",
      entityType: "case",
      action: "status_change",
      diff: { status: { old: "active", new: "committed" } },
    });
  });

  it("rejects an invalid transition (active -> archived) with Conflict and writes nothing", async () => {
    const { db, inserts, updates } = fakeDb([[{ id: CASE_ID, status: "active" }]]);

    await expect(updateCaseLifecycle(CASE_ID, "archived", ACTOR, db)).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("rejects a same-status write (active -> active) with Conflict", async () => {
    const { db } = fakeDb([[{ id: CASE_ID, status: "active" }]]);

    await expect(updateCaseLifecycle(CASE_ID, "active", ACTOR, db)).rejects.toThrow("Conflict");
  });

  it("rejects any transition out of archived with Conflict", async () => {
    const { db } = fakeDb([[{ id: CASE_ID, status: "archived" }]]);

    await expect(updateCaseLifecycle(CASE_ID, "active", ACTOR, db)).rejects.toThrow("Conflict");
  });

  it("rejects committed -> withdrawn (only completed is reachable) with Conflict", async () => {
    const { db } = fakeDb([[{ id: CASE_ID, status: "committed" }]]);

    await expect(updateCaseLifecycle(CASE_ID, "withdrawn", ACTOR, db)).rejects.toThrow("Conflict");
  });

  it("throws NotFound for a missing case", async () => {
    const { db } = fakeDb([[]]);

    await expect(updateCaseLifecycle(CASE_ID, "committed", ACTOR, db)).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateCaseLifecycle("nope", "committed", ACTOR, db)).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});

describe("updateCaseProfile", () => {
  const UPDATED_AT = new Date("2026-07-08T00:00:00Z");

  function profileJoinRow(overrides: { driveFolder?: string | null } = {}) {
    return {
      caseRow: {
        id: CASE_ID,
        studentId: STUDENT_ID,
        cohortId: COHORT_ID,
        status: "active",
        statusChangedAt: new Date("2026-06-01T00:00:00Z"),
        committedListItemId: null,
        driveFolder: overrides.driveFolder ?? null,
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: UPDATED_AT,
      },
      studentRow: {
        id: STUDENT_ID,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        studentEmail: "ada@example.com",
        phone: null,
        school: null,
        schoolCounselor: null,
        cohortId: COHORT_ID,
        wiseStudentKey: null,
        externalLinks: {},
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
    };
  }

  it("updates driveFolder and student fields with paired audit diffs", async () => {
    const { db, inserts, updates } = fakeDb([[profileJoinRow()]]);

    const result = await updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      driveFolder: "https://drive.example.com/x",
      student: { preferredName: "Lady A", school: "Bangkok Prep" },
    }, db);

    expect(result.caseId).toBe(CASE_ID);
    expect(result.updatedAt).not.toBe(UPDATED_AT.toISOString());

    const studentUpdate = updates.find((call) => call.table === admissionsStudents);
    expect(studentUpdate?.set).toMatchObject({ preferredName: "Lady A", school: "Bangkok Prep" });
    const caseUpdate = updates.find((call) => call.table === admissionsCases);
    expect(caseUpdate?.set).toMatchObject({ driveFolder: "https://drive.example.com/x" });
    expect(caseUpdate?.set.updatedAt).toBeInstanceOf(Date);

    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      caseId: CASE_ID,
      entityType: "student",
      entityId: STUDENT_ID,
      action: "update",
      diff: {
        preferredName: { old: "Ada", new: "Lady A" },
        school: { old: null, new: "Bangkok Prep" },
      },
    });
    expect(audits[1]).toMatchObject({
      caseId: CASE_ID,
      entityType: "case",
      entityId: CASE_ID,
      action: "update",
      diff: { driveFolder: { old: null, new: "https://drive.example.com/x" } },
    });
  });

  it("bumps the case updatedAt (token) even when only student fields change", async () => {
    const { db, inserts, updates } = fakeDb([[profileJoinRow()]]);

    await updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      student: { fullName: "  Ada King  " },
    }, db);

    const studentUpdate = updates.find((call) => call.table === admissionsStudents);
    expect(studentUpdate?.set).toMatchObject({ fullName: "Ada King" });
    const caseUpdate = updates.find((call) => call.table === admissionsCases);
    expect(caseUpdate?.set.updatedAt).toBeInstanceOf(Date);
    expect(caseUpdate?.set.driveFolder).toBeUndefined();

    // Only the student diff is audited — the case bump is not a field change.
    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "student", action: "update" });
  });

  it("is a no-op returning the current token when nothing changed", async () => {
    const { db, inserts, updates } = fakeDb([[profileJoinRow()]]);

    const result = await updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      student: { preferredName: "Ada" },
    }, db);

    expect(result).toEqual({ caseId: CASE_ID, updatedAt: UPDATED_AT.toISOString() });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("throws Conflict when expectedUpdatedAt does not match and writes nothing", async () => {
    const { db, updates } = fakeDb([[profileJoinRow()]]);

    await expect(updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      driveFolder: "https://drive.example.com/x",
    }, db)).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
  });

  it("proceeds when expectedUpdatedAt matches the current token", async () => {
    const { db, updates } = fakeDb([[profileJoinRow()]]);

    await updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      expectedUpdatedAt: UPDATED_AT.toISOString(),
      driveFolder: "https://drive.example.com/x",
    }, db);

    expect(updates.some((call) => call.table === admissionsCases)).toBe(true);
  });

  it("throws NotFound for a missing case", async () => {
    const { db } = fakeDb([[]]);

    await expect(updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      driveFolder: "x",
    }, db)).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(updateCaseProfile({
      caseId: "nope",
      actor: ACTOR,
      driveFolder: "x",
    }, db)).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });

  it("rejects an empty fullName", async () => {
    const { db, updates } = fakeDb([[profileJoinRow()]]);

    await expect(updateCaseProfile({
      caseId: CASE_ID,
      actor: ACTOR,
      student: { fullName: "   " },
    }, db)).rejects.toThrow(/non-empty fullName/);
    expect(updates).toHaveLength(0);
  });
});

describe("createCase", () => {
  const INPUT = {
    student: { fullName: "Ada Lovelace", studentEmail: "Ada@Example.com" },
    cohortId: COHORT_ID,
    parentEmails: ["Mom@Example.com", "dad@example.com"],
    counselorEmails: ["staff@example.com"],
    createdBy: ACTOR,
  };

  const TEMPLATE_HIT = [{ id: TEMPLATE_ID }];

  function templateRow(version: number) {
    return {
      id: TEMPLATE_ID,
      cohortId: COHORT_ID,
      version,
      name: `Checklist v${version}`,
      publishedAt: new Date("2026-06-15T00:00:00Z"),
      createdAt: new Date("2026-06-15T00:00:00Z"),
      updatedAt: new Date("2026-06-15T00:00:00Z"),
    };
  }

  function templateItemRow(overrides: Record<string, unknown>) {
    return {
      id: "i1",
      templateId: TEMPLATE_ID,
      itemKey: "complete_intake_questionnaire",
      phase: "about_you",
      title: "Complete the intake questionnaire",
      description: null,
      defaultOwner: "student",
      sortOrder: 0,
      createdAt: new Date("2026-06-15T00:00:00Z"),
      updatedAt: new Date("2026-06-15T00:00:00Z"),
      ...overrides,
    };
  }

  function taskInsertValues(inserts: InsertCall[]) {
    const call = inserts.find((entry) => entry.table === admissionsCaseTasks);
    return call ? (call.values as unknown as Array<Record<string, unknown>>) : null;
  }

  it("creates the student, the case, and all membership rows with correct roles/statuses", async () => {
    // Queue: [published-template probe -> hit], [student lookup -> none]
    // (new student skips the live-case check), [instantiate: template],
    // [instantiate: items].
    const { db, inserts } = fakeDb([
      TEMPLATE_HIT,
      [],
      [templateRow(2)],
      [templateItemRow({})],
    ]);

    const result = await createCase(INPUT, db);

    const studentInsert = inserts.find((call) => call.table === admissionsStudents);
    expect(studentInsert?.values).toMatchObject({
      fullName: "Ada Lovelace",
      studentEmail: "ada@example.com",
      cohortId: COHORT_ID,
    });

    const caseInsert = inserts.find((call) => call.table === admissionsCases);
    expect(caseInsert?.values).toMatchObject({ status: "active", cohortId: COHORT_ID });

    const members = memberInserts(inserts);
    expect(members).toHaveLength(4);
    expect(members[0]).toMatchObject({ email: "ada@example.com", role: "student", status: "invited" });
    expect(members[0].invitedAt).toBeInstanceOf(Date);
    expect(members[1]).toMatchObject({ email: "mom@example.com", role: "parent", status: "invited" });
    expect(members[2]).toMatchObject({ email: "dad@example.com", role: "parent", status: "invited" });
    expect(members[3]).toMatchObject({ email: "staff@example.com", role: "counselor", status: "active" });
    expect(members[3].activatedAt).toBeInstanceOf(Date);
    expect(members[3].invitedAt).toBeNull();
    expect(members.every((values) => values.addedByEmail === "staff@example.com")).toBe(true);

    expect(result.members).toHaveLength(4);
    expect(result.members.map((member) => member.role)).toEqual([
      "student",
      "parent",
      "parent",
      "counselor",
    ]);

    // One audit row for the case + one per membership (CM-05) + one for the
    // checklist instantiation (CM-21).
    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(6);
    expect(audits[0]).toMatchObject({ entityType: "case", action: "create" });
    expect(audits.slice(1, 5).every((row) => row.entityType === "case_member")).toBe(true);
    expect(audits[5]).toMatchObject({ entityType: "checklist", action: "instantiate" });
  });

  it("copies the cohort's latest published template into case tasks (CM-21)", async () => {
    // Queue: [published-template probe -> hit], [student lookup -> none],
    // [instantiate: template v3], [instantiate: 2 items].
    const { db, inserts } = fakeDb([
      TEMPLATE_HIT,
      [],
      [templateRow(3)],
      [
        templateItemRow({}),
        templateItemRow({
          id: "i2",
          itemKey: "confirm_profile_details",
          title: "Confirm profile and contact details",
          defaultOwner: "counselor",
          sortOrder: 1,
        }),
      ],
    ]);

    const result = await createCase(INPUT, db);

    // No seeding happened — the cohort already had a published template.
    expect(inserts.some((call) => call.table === admissionsChecklistTemplates)).toBe(false);

    const tasks = taskInsertValues(inserts);
    expect(tasks).toHaveLength(2);
    expect(tasks?.[0]).toMatchObject({
      caseId: result.caseId,
      templateId: TEMPLATE_ID,
      templateVersion: 3,
      itemKey: "complete_intake_questionnaire",
      phase: "about_you",
      owner: "student",
      status: "not_started",
      sortOrder: 0,
    });
    expect(tasks?.[1]).toMatchObject({
      caseId: result.caseId,
      itemKey: "confirm_profile_details",
      owner: "counselor",
      status: "not_started",
      sortOrder: 1,
    });

    expect(result.checklist).toEqual({
      templateId: TEMPLATE_ID,
      templateVersion: 3,
      taskCount: 2,
    });

    const instantiateAudit = auditInserts(inserts).find(
      (row) => row.entityType === "checklist",
    );
    expect(instantiateAudit).toMatchObject({
      caseId: result.caseId,
      action: "instantiate",
      diff: {
        templateId: { old: null, new: TEMPLATE_ID },
        templateVersion: { old: null, new: 3 },
        taskCount: { old: null, new: 2 },
      },
    });
  });

  it("seeds and publishes the default template when the cohort has none, then instantiates it", async () => {
    // Queue: [published-template probe -> none], [seed: cohort exists],
    // [seed: max version -> none], [student lookup -> none],
    // [instantiate: seeded template], [instantiate: items].
    const { db, inserts } = fakeDb([
      [],
      [{ id: COHORT_ID }],
      [],
      [],
      [templateRow(1)],
      [templateItemRow({})],
    ]);

    const result = await createCase(INPUT, db);

    const seedInsert = inserts.find((call) => call.table === admissionsChecklistTemplates);
    expect(seedInsert?.values).toMatchObject({
      cohortId: COHORT_ID,
      version: 1,
      name: DEFAULT_TEMPLATE_NAME,
    });
    expect(seedInsert?.values.publishedAt).toBeInstanceOf(Date);

    const itemInsert = inserts.find((call) => call.table === admissionsTemplateItems);
    const seededItems = itemInsert?.values as unknown as Array<Record<string, unknown>>;
    expect(seededItems).toHaveLength(DEFAULT_CHECKLIST_ITEMS.length);

    const tasks = taskInsertValues(inserts);
    expect(tasks).toHaveLength(1);
    expect(tasks?.[0]).toMatchObject({
      caseId: result.caseId,
      templateId: TEMPLATE_ID,
      templateVersion: 1,
      status: "not_started",
    });
    expect(result.checklist).toEqual({
      templateId: TEMPLATE_ID,
      templateVersion: 1,
      taskCount: 1,
    });

    const audits = auditInserts(inserts);
    expect(audits.some(
      (row) => row.entityType === "checklist_template" && row.action === "create",
    )).toBe(true);
    expect(audits.some(
      (row) => row.entityType === "checklist" && row.action === "instantiate",
    )).toBe(true);
  });

  it("links an existing student by email instead of creating a new row", async () => {
    // Queue: [published-template probe -> hit], [student lookup -> hit],
    // [live-case check -> none], [instantiate: template], [instantiate: no items].
    const { db, inserts } = fakeDb([
      TEMPLATE_HIT,
      [{ id: STUDENT_ID }],
      [],
      [templateRow(2)],
      [],
    ]);

    const result = await createCase(INPUT, db);

    expect(result.studentId).toBe(STUDENT_ID);
    expect(inserts.some((call) => call.table === admissionsStudents)).toBe(false);
  });

  it("throws Conflict when the linked student already has a live case", async () => {
    const { db, inserts } = fakeDb([TEMPLATE_HIT, [{ id: STUDENT_ID }], [{ id: CASE_ID }]]);

    await expect(createCase(INPUT, db)).rejects.toThrow("Conflict");
    expect(inserts).toHaveLength(0);
  });

  it("rejects a parent email equal to the student email with Conflict before any query", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(
      createCase({ ...INPUT, parentEmails: ["ADA@example.com"] }, db),
    ).rejects.toThrow("Conflict");
    expect(selectCalls).toHaveLength(0);
  });

  it("rejects a counselor email that overlaps the family with Conflict", async () => {
    const { db } = fakeDb([]);

    await expect(
      createCase({ ...INPUT, counselorEmails: ["mom@example.com"] }, db),
    ).rejects.toThrow("Conflict");
  });

  it("requires at least one counselor email", async () => {
    const { db } = fakeDb([]);

    await expect(createCase({ ...INPUT, counselorEmails: [] }, db)).rejects.toThrow(
      /at least one counselor/,
    );
  });

  it("dedupes repeated parent emails after normalization", async () => {
    const { db, inserts } = fakeDb([TEMPLATE_HIT, [], [templateRow(2)], []]);

    await createCase(
      { ...INPUT, parentEmails: ["Mom@Example.com", " mom@example.com "] },
      db,
    );

    const parents = memberInserts(inserts).filter((values) => values.role === "parent");
    expect(parents).toHaveLength(1);
    expect(parents[0].email).toBe("mom@example.com");
  });
});

describe("getCaseloadForUser", () => {
  // 2026-07-09 12:00 Bangkok.
  const NOW = new Date("2026-07-09T05:00:00Z");

  function caseJoinRow(overrides: {
    caseId?: string;
    status?: string;
    committedListItemId?: string | null;
    updatedAt?: Date;
  } = {}) {
    return {
      caseRow: {
        id: overrides.caseId ?? CASE_ID,
        studentId: STUDENT_ID,
        cohortId: COHORT_ID,
        status: overrides.status ?? "active",
        statusChangedAt: new Date("2026-06-01T00:00:00Z"),
        committedListItemId: overrides.committedListItemId ?? null,
        driveFolder: null,
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: overrides.updatedAt ?? new Date("2026-07-08T00:00:00Z"),
      },
      studentRow: {
        id: STUDENT_ID,
        fullName: "Ada Lovelace",
        preferredName: "Ada",
        studentEmail: "ada@example.com",
        phone: null,
        school: null,
        schoolCounselor: null,
        cohortId: COHORT_ID,
        wiseStudentKey: null,
        externalLinks: {},
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
      cohortRow: {
        id: COHORT_ID,
        name: "Class of 2027",
        graduationYear: 2027,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
    };
  }

  it("assembles admin caseload rows with counselors, last touch, and committed college", async () => {
    // Queue: [admin hit], [cases], [members], [registry names], [meetings], [committed items].
    const { db } = fakeDb([
      [{ id: "a1" }],
      [caseJoinRow({ committedListItemId: ITEM_ID })],
      [
        { caseId: CASE_ID, email: "zoe@example.com", role: "counselor", status: "active" },
        { caseId: CASE_ID, email: "amy@example.com", role: "counselor", status: "active" },
        { caseId: CASE_ID, email: "gone@example.com", role: "counselor", status: "revoked" },
        { caseId: CASE_ID, email: "mom@example.com", role: "parent", status: "active" },
      ],
      [{ email: "amy@example.com", name: "Amy Chen" }],
      [
        { caseId: CASE_ID, meetingDate: "2026-06-01" },
        { caseId: CASE_ID, meetingDate: "2026-07-01" },
      ],
      [{ id: ITEM_ID, instName: "Stanford University" }],
    ]);

    const rows = await getCaseloadForUser("admin@example.com", db, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: CASE_ID,
      studentName: "Ada Lovelace",
      preferredName: "Ada",
      cohortName: "Class of 2027",
      graduationYear: 2027,
      status: "active",
      // Revoked counselor and parent excluded; emails sorted; name fallback.
      counselorEmails: ["amy@example.com", "zoe@example.com"],
      counselorNames: ["Amy Chen", "zoe@example.com"],
      progressPercent: 0,
      nextDeadline: null,
      daysSinceLastTouch: 8,
      committedCollegeName: "Stanford University",
    });
  });

  it("carries real checklist progress and each case's nearest open deadline", async () => {
    // Queue: [admin hit], [cases A+B], [members -> none] (registry-name query
    // skipped), [meetings -> none] (committed-college query skipped),
    // [progress rows], [deadline task rows].
    const { db } = fakeDb([
      [{ id: "a1" }],
      [
        caseJoinRow({ caseId: CASE_ID, updatedAt: new Date("2026-07-08T00:00:00Z") }),
        caseJoinRow({ caseId: CASE_ID_B, updatedAt: new Date("2026-07-07T00:00:00Z") }),
      ],
      [],
      [],
      [
        { caseId: CASE_ID, status: "done", verifiedAt: new Date("2026-07-01T00:00:00Z") },
        { caseId: CASE_ID, status: "in_progress", verifiedAt: null },
        { caseId: CASE_ID_B, status: "not_started", verifiedAt: null },
      ],
      [
        // A: the earlier task is done -> excluded; the open ones pick 2026-08-01.
        { id: "t1", caseId: CASE_ID, title: "Done early", owner: "student", status: "done", dueDate: "2026-07-01" },
        { id: "t2", caseId: CASE_ID, title: "Essay draft", owner: "student", status: "not_started", dueDate: "2026-08-01" },
        { id: "t3", caseId: CASE_ID, title: "Later task", owner: "counselor", status: "in_progress", dueDate: "2026-09-01" },
        // B: an overdue open task still counts as the nearest deadline.
        { id: "t4", caseId: CASE_ID_B, title: "Overdue", owner: "student", status: "not_started", dueDate: "2026-07-01" },
      ],
    ]);

    const rows = await getCaseloadForUser("admin@example.com", db, NOW);

    const rowA = rows.find((row) => row.caseId === CASE_ID);
    expect(rowA).toMatchObject({ progressPercent: 50, nextDeadline: "2026-08-01" });
    const rowB = rows.find((row) => row.caseId === CASE_ID_B);
    expect(rowB).toMatchObject({ progressPercent: 0, nextDeadline: "2026-07-01" });
  });

  it("reports null daysSinceLastTouch when no meeting exists and clamps future meetings to 0", async () => {
    const { db } = fakeDb([
      [{ id: "a1" }],
      [
        caseJoinRow({ caseId: CASE_ID, updatedAt: new Date("2026-07-08T00:00:00Z") }),
        caseJoinRow({ caseId: CASE_ID_B, updatedAt: new Date("2026-07-07T00:00:00Z") }),
      ],
      [],
      [
        { caseId: CASE_ID_B, meetingDate: "2026-07-15" },
      ],
    ]);

    const rows = await getCaseloadForUser("admin@example.com", db, NOW);

    expect(rows.find((row) => row.caseId === CASE_ID)?.daysSinceLastTouch).toBeNull();
    expect(rows.find((row) => row.caseId === CASE_ID_B)?.daysSinceLastTouch).toBe(0);
  });

  it("sorts the caseload by updatedAt descending", async () => {
    const { db } = fakeDb([
      [{ id: "a1" }],
      [
        caseJoinRow({ caseId: CASE_ID, updatedAt: new Date("2026-07-01T00:00:00Z") }),
        caseJoinRow({ caseId: CASE_ID_B, updatedAt: new Date("2026-07-08T00:00:00Z") }),
      ],
      [],
      [],
    ]);

    const rows = await getCaseloadForUser("admin@example.com", db, NOW);

    expect(rows.map((row) => row.caseId)).toEqual([CASE_ID_B, CASE_ID]);
  });

  it("scopes a counselor to cases with an ACTIVE counselor membership only (caseload wall)", async () => {
    // Memberships: active counselor on A, revoked counselor on B, student on C
    // -> only case A may be queried and returned.
    const { db } = fakeDb([
      [],
      [{ id: "reg1" }],
      [
        { caseId: CASE_ID, role: "counselor", status: "active" },
        { caseId: CASE_ID_B, role: "counselor", status: "revoked" },
        { caseId: CASE_ID_C, role: "student", status: "active" },
      ],
      [caseJoinRow({ caseId: CASE_ID })],
      [{ caseId: CASE_ID, email: "me@example.com", role: "counselor", status: "active" }],
      [{ email: "me@example.com", name: "Me" }],
      [],
    ]);

    const rows = await getCaseloadForUser("me@example.com", db, NOW);

    expect(rows.map((row) => row.caseId)).toEqual([CASE_ID]);
  });

  it("returns [] for a counselor whose only membership is revoked, without querying cases", async () => {
    const { db, selectCalls } = fakeDb([
      [],
      [{ id: "reg1" }],
      [{ caseId: CASE_ID, role: "counselor", status: "revoked" }],
    ]);

    await expect(getCaseloadForUser("me@example.com", db, NOW)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(3);
  });

  it("returns [] for a counselor email missing from the active registry (fail-closed)", async () => {
    const { db, selectCalls } = fakeDb([[], []]);

    await expect(getCaseloadForUser("ghost@example.com", db, NOW)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(2);
  });

  it("returns [] for an empty email without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(getCaseloadForUser("   ", db, NOW)).resolves.toEqual([]);
    expect(selectCalls).toHaveLength(0);
  });
});

describe("getCaseDetail", () => {
  function detailJoinRow(committedListItemId: string | null) {
    return {
      caseRow: {
        id: CASE_ID,
        studentId: STUDENT_ID,
        cohortId: COHORT_ID,
        status: "active",
        statusChangedAt: new Date("2026-06-15T00:00:00Z"),
        committedListItemId,
        driveFolder: "https://drive.example.com/folder",
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
      studentRow: {
        id: STUDENT_ID,
        fullName: "Ada Lovelace",
        preferredName: null,
        studentEmail: "ada@example.com",
        phone: "0812345678",
        school: "BKK Prep",
        schoolCounselor: null,
        cohortId: COHORT_ID,
        wiseStudentKey: null,
        externalLinks: { drive: "x" },
        deletedAt: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
      cohortRow: {
        id: COHORT_ID,
        name: "Class of 2027",
        graduationYear: 2027,
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
    };
  }

  function memberRow(overrides: Record<string, unknown>) {
    return {
      id: "m1",
      caseId: CASE_ID,
      email: "ada@example.com",
      role: "student",
      status: "invited",
      invitedAt: new Date("2026-06-01T00:00:00Z"),
      activatedAt: null,
      revokedAt: null,
      addedByEmail: "staff@example.com",
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
      ...overrides,
    };
  }

  // 2026-07-09 12:00 Bangkok — makes the 2026-07-01 deadline overdue.
  const NOW = new Date("2026-07-09T05:00:00Z");

  function announcementRow(id: string, createdAt: Date) {
    return {
      id,
      cohortId: COHORT_ID,
      caseId: null,
      title: `Update ${id}`,
      body: "Body",
      authorEmail: "staff@example.com",
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  it("assembles the full detail DTO with members sorted oldest-first", async () => {
    // Queue: [case join], [members], [committed item], [meetings],
    // [progress task rows], [deadline task rows],
    // [announcements: cohort lookup], [announcement rows].
    const { db } = fakeDb([
      [detailJoinRow(ITEM_ID)],
      [
        memberRow({ id: "m2", email: "staff@example.com", role: "counselor", status: "active", createdAt: new Date("2026-06-02T00:00:00Z") }),
        memberRow({ id: "m1" }),
      ],
      [{ instName: "Stanford University" }],
      [
        { meetingDate: "2026-06-20" },
        { meetingDate: "2026-07-02" },
      ],
      [
        { status: "done", verifiedAt: new Date("2026-07-01T00:00:00Z") },
        { status: "not_started", verifiedAt: null },
      ],
      [
        { id: "t2", caseId: CASE_ID, title: "Essay draft", owner: "student", status: "not_started", dueDate: "2026-08-01" },
        { id: "t1", caseId: CASE_ID, title: "Send transcripts", owner: "counselor", status: "in_progress", dueDate: "2026-07-01" },
      ],
      [{ cohortId: COHORT_ID }],
      [
        announcementRow("a1", new Date("2026-07-01T00:00:00Z")),
        announcementRow("a2", new Date("2026-07-02T00:00:00Z")),
        announcementRow("a3", new Date("2026-07-03T00:00:00Z")),
        announcementRow("a4", new Date("2026-07-04T00:00:00Z")),
        announcementRow("a5", new Date("2026-07-05T00:00:00Z")),
        announcementRow("a6", new Date("2026-07-06T00:00:00Z")),
      ],
    ]);

    const detail = await getCaseDetail(CASE_ID, db, NOW);

    expect(detail).toMatchObject({
      caseId: CASE_ID,
      status: "active",
      statusChangedAt: "2026-06-15T00:00:00.000Z",
      committedListItemId: ITEM_ID,
      committedCollegeName: "Stanford University",
      driveFolder: "https://drive.example.com/folder",
      student: {
        id: STUDENT_ID,
        fullName: "Ada Lovelace",
        studentEmail: "ada@example.com",
        externalLinks: { drive: "x" },
      },
      cohort: { id: COHORT_ID, name: "Class of 2027", graduationYear: 2027 },
      progress: { done: 1, total: 2, percent: 50, verifiedCount: 1 },
      progressPercent: 50,
      nextDeadline: "2026-07-01",
      lastMeetingDate: "2026-07-02",
    });
    expect(detail.members.map((member) => member.id)).toEqual(["m1", "m2"]);
    expect(detail.members[0].invitedAt).toBe("2026-06-01T00:00:00.000Z");

    // Deadlines: urgency order (overdue 2026-07-01 first), overdue stamped.
    expect(detail.upcomingDeadlines.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(detail.upcomingDeadlines[0]).toMatchObject({
      date: "2026-07-01",
      overdue: true,
      source: "task",
    });
    expect(detail.upcomingDeadlines[1]).toMatchObject({ date: "2026-08-01", overdue: false });

    // Announcements: newest first, capped at 5 (a1, the oldest, drops off).
    expect(detail.announcements.map((row) => row.id)).toEqual([
      "a6", "a5", "a4", "a3", "a2",
    ]);
  });

  it("skips the committed-college query when no pointer is set", async () => {
    // Queue: [case join], [members], [meetings], [progress], [deadlines],
    // [announcements: cohort lookup], [announcement rows].
    const { db, selectCalls } = fakeDb([
      [detailJoinRow(null)],
      [],
      [],
      [],
      [],
      [{ cohortId: COHORT_ID }],
      [],
    ]);

    const detail = await getCaseDetail(CASE_ID, db, NOW);

    expect(detail.committedCollegeName).toBeNull();
    expect(detail.lastMeetingDate).toBeNull();
    expect(detail.progress).toEqual({ done: 0, total: 0, percent: 0, verifiedCount: 0 });
    expect(detail.nextDeadline).toBeNull();
    expect(detail.upcomingDeadlines).toEqual([]);
    expect(detail.announcements).toEqual([]);
    expect(selectCalls).toHaveLength(7);
  });

  it("throws NotFound when the case is missing or soft-deleted", async () => {
    const { db } = fakeDb([[]]);

    await expect(getCaseDetail(CASE_ID, db)).rejects.toThrow("NotFound");
  });

  it("throws NotFound for a malformed caseId without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(getCaseDetail("nope", db)).rejects.toThrow("NotFound");
    expect(selectCalls).toHaveLength(0);
  });
});
