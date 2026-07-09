import { describe, expect, it, vi } from "vitest";

// `@/lib/db` pulls the Neon driver at import time; stub it so the domain
// functions can be unit-tested against a fake chainable db (no real database).
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAuditLog,
  admissionsCaseMembers,
  admissionsCases,
  admissionsStudents,
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
import type { AdmissionsCaseStatus } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CASE_ID_B = "22222222-2222-4222-8222-222222222222";
const CASE_ID_C = "33333333-3333-4333-8333-333333333333";
const COHORT_ID = "44444444-4444-4444-8444-444444444444";
const STUDENT_ID = "55555555-5555-4555-8555-555555555555";
const ITEM_ID = "66666666-6666-4666-8666-666666666666";

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
        const row = {
          id: `generated-${generated++}`,
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

  it("creates the student, the case, and all membership rows with correct roles/statuses", async () => {
    // Queue: [student lookup -> none]. New student skips the live-case check.
    const { db, inserts } = fakeDb([[]]);

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

    // One audit row for the case + one per membership (CM-05).
    const audits = auditInserts(inserts);
    expect(audits).toHaveLength(5);
    expect(audits[0]).toMatchObject({ entityType: "case", action: "create" });
    expect(audits.slice(1).every((row) => row.entityType === "case_member")).toBe(true);
  });

  it("links an existing student by email instead of creating a new row", async () => {
    // Queue: [student lookup -> hit], [live-case check -> none].
    const { db, inserts } = fakeDb([[{ id: STUDENT_ID }], []]);

    const result = await createCase(INPUT, db);

    expect(result.studentId).toBe(STUDENT_ID);
    expect(inserts.some((call) => call.table === admissionsStudents)).toBe(false);
  });

  it("throws Conflict when the linked student already has a live case", async () => {
    const { db, inserts } = fakeDb([[{ id: STUDENT_ID }], [{ id: CASE_ID }]]);

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
    const { db, inserts } = fakeDb([[]]);

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

  it("assembles the full detail DTO with members sorted oldest-first", async () => {
    // Queue: [case join], [members], [committed item], [meetings].
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
    ]);

    const detail = await getCaseDetail(CASE_ID, db);

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
      progressPercent: 0,
      nextDeadline: null,
      lastMeetingDate: "2026-07-02",
    });
    expect(detail.members.map((member) => member.id)).toEqual(["m1", "m2"]);
    expect(detail.members[0].invitedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("skips the committed-college query when no pointer is set", async () => {
    // Queue: [case join], [members], [meetings].
    const { db, selectCalls } = fakeDb([[detailJoinRow(null)], [], []]);

    const detail = await getCaseDetail(CASE_ID, db);

    expect(detail.committedCollegeName).toBeNull();
    expect(detail.lastMeetingDate).toBeNull();
    expect(selectCalls).toHaveLength(3);
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
