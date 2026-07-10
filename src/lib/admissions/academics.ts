import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsAcademicRecords,
  admissionsSelfReportSections,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import {
  academicRecordPayloadSchema,
  type AcademicRecordPayload,
  type AdmissionsAcademicSystem,
} from "./shared/academics";
import type { CaseAccess } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
type AcademicRecordRow = typeof admissionsAcademicRecords.$inferSelect;

export {
  ADMISSIONS_ACADEMIC_SYSTEMS,
  academicRecordPayloadSchema,
  admissionsCoursePlanItemSchema,
  admissionsIbAcademicPayloadSchema,
  admissionsIbSubjectSchema,
  admissionsUkAcademicPayloadSchema,
  admissionsUkSubjectSchema,
  admissionsUsAcademicPayloadSchema,
} from "./shared/academics";
export type {
  AcademicRecordPayload,
  AdmissionsAcademicSystem,
  AdmissionsCoursePlanItem,
  AdmissionsIbAcademicPayload,
  AdmissionsIbSubject,
  AdmissionsUkAcademicPayload,
  AdmissionsUkSubject,
  AdmissionsUsAcademicPayload,
} from "./shared/academics";

export interface AdmissionsAcademicRecordDto {
  id: string;
  caseId: string;
  system: AdmissionsAcademicSystem;
  payload: AcademicRecordPayload;
  effectiveDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyAcademicWorksheetDto {
  payload: Record<string, unknown>;
  importedAt: string;
}

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

function parsePayload(value: unknown): AcademicRecordPayload {
  const parsed = academicRecordPayloadSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(
      `Invalid academic payload${path ? ` (${path})` : ""}: ${issue?.message ?? "malformed payload"}`,
    );
  }
  return parsed.data;
}

function toDto(row: AcademicRecordRow): AdmissionsAcademicRecordDto | null {
  const parsed = academicRecordPayloadSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.system !== row.system) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    system: parsed.data.system,
    payload: parsed.data,
    effectiveDate: row.effectiveDate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findLiveRecord(
  db: AdmissionsWriteDb,
  recordId: string,
  caseId: string,
): Promise<AcademicRecordRow> {
  const rows = await db
    .select()
    .from(admissionsAcademicRecords)
    .where(and(
      eq(admissionsAcademicRecords.id, recordId),
      eq(admissionsAcademicRecords.caseId, caseId),
      isNull(admissionsAcademicRecords.deletedAt),
    ))
    .limit(1)
    .for("update");
  if (!rows[0]) throw new Error("NotFound");
  return rows[0];
}

async function assertUniqueRecordKey(
  db: AdmissionsWriteDb,
  caseId: string,
  system: AdmissionsAcademicSystem,
  effectiveDate: string,
  excludeId?: string,
): Promise<void> {
  const conditions = [
    eq(admissionsAcademicRecords.caseId, caseId),
    eq(admissionsAcademicRecords.system, system),
    eq(admissionsAcademicRecords.effectiveDate, effectiveDate),
    isNull(admissionsAcademicRecords.deletedAt),
  ];
  if (excludeId) conditions.push(ne(admissionsAcademicRecords.id, excludeId));
  const rows = await db
    .select({ id: admissionsAcademicRecords.id })
    .from(admissionsAcademicRecords)
    .where(and(...conditions))
    .limit(1);
  if (rows[0]) throw new Error("Conflict");
}

export interface CreateAcademicRecordInput {
  access: CaseAccess;
  payload: AcademicRecordPayload;
  effectiveDate: string;
}

export async function createAcademicRecord(
  input: CreateAcademicRecordInput,
  db: Database = getDb(),
): Promise<AdmissionsAcademicRecordDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  assertDateOnly(input.effectiveDate, "effectiveDate");
  const payload = parsePayload(input.payload);

  return withAuditedTransaction(async (tx) => {
    await assertUniqueRecordKey(
      tx,
      input.access.caseId,
      payload.system,
      input.effectiveDate,
    );
    const rows = await tx
      .insert(admissionsAcademicRecords)
      .values({
        caseId: input.access.caseId,
        system: payload.system,
        payload,
        effectiveDate: input.effectiveDate,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Academic record insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "academic_record",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        { system: payload.system, payload, effectiveDate: input.effectiveDate },
        ["system", "payload", "effectiveDate"],
      ),
    });

    const dto = toDto(row);
    if (!dto) throw new Error("Academic record insert returned invalid payload");
    return dto;
  }, db);
}

export interface UpdateAcademicRecordInput {
  access: CaseAccess;
  recordId: string;
  expectedUpdatedAt?: string;
  payload?: AcademicRecordPayload;
  effectiveDate?: string;
}

export async function updateAcademicRecord(
  input: UpdateAcademicRecordInput,
  db: Database = getDb(),
): Promise<AdmissionsAcademicRecordDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.recordId)) throw new Error("NotFound");
  if (input.effectiveDate !== undefined) assertDateOnly(input.effectiveDate, "effectiveDate");
  const payload = input.payload === undefined ? undefined : parsePayload(input.payload);

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveRecord(tx, input.recordId, input.access.caseId);
    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== row.updatedAt.toISOString()
    ) throw new Error("Conflict");

    const nextSystem = payload?.system ?? row.system as AdmissionsAcademicSystem;
    const nextEffectiveDate = input.effectiveDate ?? row.effectiveDate;
    if (nextSystem !== row.system || nextEffectiveDate !== row.effectiveDate) {
      await assertUniqueRecordKey(
        tx,
        input.access.caseId,
        nextSystem,
        nextEffectiveDate,
        row.id,
      );
    }

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      { system: payload?.system, payload, effectiveDate: input.effectiveDate },
      ["system", "payload", "effectiveDate"],
    );
    if (Object.keys(diff).length === 0) {
      const dto = toDto(row);
      if (!dto) throw new Error("Invalid stored academic payload");
      return dto;
    }

    const now = new Date();
    const setValues: Partial<typeof admissionsAcademicRecords.$inferInsert> = { updatedAt: now };
    if (payload !== undefined) {
      setValues.system = payload.system;
      setValues.payload = payload;
    }
    if (input.effectiveDate !== undefined) setValues.effectiveDate = input.effectiveDate;
    await tx.update(admissionsAcademicRecords).set(setValues).where(eq(admissionsAcademicRecords.id, row.id));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "academic_record",
      entityId: row.id,
      action: "update",
      diff,
    });

    const dto = toDto({ ...row, ...setValues } as AcademicRecordRow);
    if (!dto) throw new Error("Invalid stored academic payload");
    return dto;
  }, db);
}

export async function softDeleteAcademicRecord(
  input: { access: CaseAccess; recordId: string },
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.recordId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveRecord(tx, input.recordId, input.access.caseId);
    const now = new Date();
    await tx.update(admissionsAcademicRecords)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsAcademicRecords.id, row.id));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "academic_record",
      entityId: row.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

export async function listAcademicRecordsForCase(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsAcademicRecordDto[]> {
  if (!isUuidShaped(caseId)) return [];
  const rows = await db.select().from(admissionsAcademicRecords)
    .where(and(
      eq(admissionsAcademicRecords.caseId, caseId),
      isNull(admissionsAcademicRecords.deletedAt),
    ))
    .orderBy(desc(admissionsAcademicRecords.effectiveDate), admissionsAcademicRecords.system);
  return rows.flatMap((row) => {
    const dto = toDto(row);
    return dto ? [dto] : [];
  });
}

/**
 * Read-only bridge for one-time workbook imports whose source labels cannot be
 * safely coerced into the validated US/IB/UK discriminated record. Keeping the
 * raw imported labels visible lets a counselor verify and convert them in the
 * Academic Record form without reopening the archived workbook.
 */
export async function getLegacyAcademicWorksheetForCase(
  caseId: string,
  db: Database = getDb(),
): Promise<LegacyAcademicWorksheetDto | null> {
  if (!isUuidShaped(caseId)) return null;
  const rows = await db.select({
    payload: admissionsSelfReportSections.payload,
    updatedAt: admissionsSelfReportSections.updatedAt,
  }).from(admissionsSelfReportSections).where(and(
    eq(admissionsSelfReportSections.caseId, caseId),
    eq(admissionsSelfReportSections.sectionKey, "legacy_academics"),
  )).limit(1);
  const row = rows[0];
  if (!row || Object.keys(row.payload).length === 0) return null;
  return {
    payload: row.payload,
    importedAt: row.updatedAt.toISOString(),
  };
}
