import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import {
  admissionsAcademicRecords,
  admissionsAuditLog,
} from "@/lib/db/schema";
import {
  academicRecordPayloadSchema,
  createAcademicRecord,
  getLegacyAcademicWorksheetForCase,
  listAcademicRecordsForCase,
  softDeleteAcademicRecord,
  updateAcademicRecord,
} from "@/lib/admissions/academics";
import type { CaseAccess } from "@/lib/admissions/types";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = new Date("2026-07-01T00:00:00.000Z");
const COUNSELOR: CaseAccess = {
  caseId: CASE_ID,
  email: "staff@example.com",
  role: "counselor",
  isAdmin: false,
};
const STUDENT: CaseAccess = {
  caseId: CASE_ID,
  email: "student@example.com",
  role: "student",
  isAdmin: false,
};

interface InsertCall { table: unknown; values: Record<string, unknown> }
interface UpdateCall { table: unknown; set: Record<string, unknown> }

function fakeDb(queue: unknown[][]) {
  let i = 0;
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  function chain(rows: unknown[]) {
    const value: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "for"]) value[method] = () => value;
    (value as { then: unknown }).then = (
      resolve: (result: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return value;
  }
  const tx = {
    select: () => chain(queue[i++] ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = {
          id: RECORD_ID,
          deletedAt: null,
          createdAt: UPDATED_AT,
          updatedAt: UPDATED_AT,
          ...values,
        };
        return {
          returning: () => Promise.resolve([row]),
          then: (resolve: (result: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
      },
    }),
    update: (table: unknown) => ({ set: (set: Record<string, unknown>) => {
      updates.push({ table, set });
      const value = chain([]);
      return value;
    } }),
  };
  return {
    db: { ...tx, transaction: async (cb: (value: unknown) => Promise<unknown>) => cb(tx) } as never,
    inserts,
    updates,
  };
}

function usPayload() {
  return {
    system: "us" as const,
    gpaScale: 4,
    unweightedGpa: 3.8,
    weightedGpa: 4.2,
    coreGpa: 3.9,
    classRank: 10,
    classSize: 180,
    courseRigor: "most_demanding" as const,
    fourYearCoursePlan: [
      { gradeLevel: "12" as const, courseTitle: "AP Calculus BC", level: "AP", planned: true },
    ],
    transcriptUrl: "https://drive.google.com/transcript",
    schoolProfileUrl: null,
  };
}

function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD_ID,
    caseId: CASE_ID,
    system: "us",
    payload: usPayload(),
    effectiveDate: "2026-06-01",
    deletedAt: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("academic payload variants", () => {
  it("accepts US, IB, and A-level/IGCSE records", () => {
    expect(academicRecordPayloadSchema.parse(usPayload()).system).toBe("us");
    expect(academicRecordPayloadSchema.parse({
      system: "ib",
      program: "dp",
      subjects: [{ subject: "Economics", level: "HL", predictedGrade: 7 }],
      predictedTotal: 42,
    }).system).toBe("ib");
    expect(academicRecordPayloadSchema.parse({
      system: "a_level_igcse",
      subjects: [{ qualification: "a_level", subject: "Math", board: "Cambridge", predictedGrade: "A*" }],
    }).system).toBe("a_level_igcse");
  });

  it("rejects impossible ranks, IB totals, and unknown fields", () => {
    expect(academicRecordPayloadSchema.safeParse({ ...usPayload(), classRank: 181 }).success).toBe(false);
    expect(academicRecordPayloadSchema.safeParse({
      system: "ib", program: "dp", subjects: [], predictedTotal: 46,
    }).success).toBe(false);
    expect(academicRecordPayloadSchema.safeParse({ ...usPayload(), passportNumber: "secret" }).success).toBe(false);
  });
});

describe("academic record domain", () => {
  it("creates a counselor-owned record atomically with an audit row", async () => {
    const { db, inserts } = fakeDb([[]]);
    const result = await createAcademicRecord({
      access: COUNSELOR,
      payload: usPayload(),
      effectiveDate: "2026-06-01",
    }, db);
    expect(result.system).toBe("us");
    expect(inserts.find((call) => call.table === admissionsAcademicRecords)?.values)
      .toMatchObject({ caseId: CASE_ID, system: "us", effectiveDate: "2026-06-01" });
    expect(inserts.find((call) => call.table === admissionsAuditLog)?.values)
      .toMatchObject({ entityType: "academic_record", action: "create", actorRole: "counselor" });
  });

  it("rejects student writes and duplicate system/date snapshots", async () => {
    const { db, inserts } = fakeDb([[{ id: RECORD_ID }]]);
    await expect(createAcademicRecord({
      access: STUDENT,
      payload: usPayload(),
      effectiveDate: "2026-06-01",
    }, db)).rejects.toThrow("Forbidden");
    expect(inserts).toHaveLength(0);

    await expect(createAcademicRecord({
      access: COUNSELOR,
      payload: usPayload(),
      effectiveDate: "2026-06-01",
    }, db)).rejects.toThrow("Conflict");
  });

  it("updates with optimistic concurrency and audits only changed fields", async () => {
    const { db, inserts, updates } = fakeDb([[recordRow()]]);
    const result = await updateAcademicRecord({
      access: COUNSELOR,
      recordId: RECORD_ID,
      expectedUpdatedAt: UPDATED_AT.toISOString(),
      payload: { ...usPayload(), unweightedGpa: 3.9 },
    }, db);
    expect(result.payload.system === "us" && result.payload.unweightedGpa).toBe(3.9);
    expect(updates[0].table).toBe(admissionsAcademicRecords);
    expect(inserts.find((call) => call.table === admissionsAuditLog)?.values)
      .toMatchObject({ action: "update" });
  });

  it("returns Conflict for a stale record version", async () => {
    const { db, updates } = fakeDb([[recordRow()]]);
    await expect(updateAcademicRecord({
      access: COUNSELOR,
      recordId: RECORD_ID,
      expectedUpdatedAt: "2026-06-01T00:00:00.000Z",
      effectiveDate: "2026-06-02",
    }, db)).rejects.toThrow("Conflict");
    expect(updates).toHaveLength(0);
  });

  it("soft-deletes and filters malformed legacy payloads on read", async () => {
    const deletion = fakeDb([[recordRow()]]);
    await softDeleteAcademicRecord({ access: COUNSELOR, recordId: RECORD_ID }, deletion.db);
    expect(deletion.updates[0]).toMatchObject({ table: admissionsAcademicRecords });
    expect(deletion.updates[0].set.deletedAt).toBeInstanceOf(Date);

    const listing = fakeDb([[recordRow(), recordRow({ id: "bad", payload: { system: "mystery" } })]]);
    const records = await listAcademicRecordsForCase(CASE_ID, listing.db);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(RECORD_ID);
  });

  it("keeps imported worksheet academics visible as a read-only verification bridge", async () => {
    const importedAt = new Date("2026-07-10T00:00:00.000Z");
    const { db } = fakeDb([[
      { payload: { curriculum: "IB", predicted_total: "42" }, updatedAt: importedAt },
    ]]);

    await expect(getLegacyAcademicWorksheetForCase(CASE_ID, db)).resolves.toEqual({
      payload: { curriculum: "IB", predicted_total: "42" },
      importedAt: importedAt.toISOString(),
    });
  });
});
