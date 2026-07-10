import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsAwards } from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import {
  admissionsAwardGradeLevelsSchema,
  admissionsAwardRecognitionLevelsSchema,
  MAX_COMMON_APP_RANKED_AWARDS,
  UC_AWARD_ACHIEVEMENT_MAX_CHARS,
  UC_AWARD_ELIGIBILITY_MAX_CHARS,
  type AdmissionsAwardGradeLevel,
  type AdmissionsAwardRecognitionLevel,
} from "./shared/awards";
import type { CaseAccess } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
type AwardRow = typeof admissionsAwards.$inferSelect;

export {
  ADMISSIONS_AWARD_GRADE_LEVELS,
  ADMISSIONS_AWARD_RECOGNITION_LEVELS,
  admissionsAwardGradeLevelsSchema,
  admissionsAwardRecognitionLevelsSchema,
  MAX_COMMON_APP_RANKED_AWARDS,
  UC_AWARD_ACHIEVEMENT_MAX_CHARS,
  UC_AWARD_ELIGIBILITY_MAX_CHARS,
} from "./shared/awards";
export type {
  AdmissionsAwardGradeLevel,
  AdmissionsAwardRecognitionLevel,
} from "./shared/awards";

export interface AwardDto {
  id: string;
  caseId: string;
  title: string;
  organization: string | null;
  gradeLevels: AdmissionsAwardGradeLevel[];
  recognitionLevels: AdmissionsAwardRecognitionLevel[];
  awardDate: string | null;
  commonAppRank: number | null;
  ucEligibilityNarrative: string | null;
  ucAchievementNarrative: string | null;
  /** Null for student/family projections; populated only for counselor/admin reads. */
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

function nullableText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
}

function parseGradeLevels(value: readonly AdmissionsAwardGradeLevel[] | undefined) {
  const parsed = admissionsAwardGradeLevelsSchema.safeParse(value ?? []);
  if (!parsed.success) throw new Error(`Invalid gradeLevels: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function parseRecognitionLevels(value: readonly AdmissionsAwardRecognitionLevel[] | undefined) {
  const parsed = admissionsAwardRecognitionLevelsSchema.safeParse(value ?? []);
  if (!parsed.success) throw new Error(`Invalid recognitionLevels: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function validateNarratives(eligibility: string | null, achievement: string | null): void {
  if ((eligibility?.length ?? 0) > UC_AWARD_ELIGIBILITY_MAX_CHARS) {
    throw new Error(`UC eligibility narrative exceeds ${UC_AWARD_ELIGIBILITY_MAX_CHARS} characters`);
  }
  if ((achievement?.length ?? 0) > UC_AWARD_ACHIEVEMENT_MAX_CHARS) {
    throw new Error(`UC achievement narrative exceeds ${UC_AWARD_ACHIEVEMENT_MAX_CHARS} characters`);
  }
}

function assertRank(rank: number | null): void {
  if (rank !== null && (!Number.isInteger(rank) || rank < 1 || rank > MAX_COMMON_APP_RANKED_AWARDS)) {
    throw new Error(`Invalid commonAppRank: expected 1-${MAX_COMMON_APP_RANKED_AWARDS}`);
  }
}

function toDto(row: AwardRow, includeInternalNotes: boolean): AwardDto {
  const grades = admissionsAwardGradeLevelsSchema.safeParse(row.gradeLevels);
  const levels = admissionsAwardRecognitionLevelsSchema.safeParse(row.recognitionLevels);
  return {
    id: row.id,
    caseId: row.caseId,
    title: row.title,
    organization: row.organization,
    gradeLevels: grades.success ? grades.data : [],
    recognitionLevels: levels.success ? levels.data : [],
    awardDate: row.awardDate,
    commonAppRank: row.commonAppRank,
    ucEligibilityNarrative: row.ucEligibilityNarrative,
    ucAchievementNarrative: row.ucAchievementNarrative,
    internalNotes: includeInternalNotes ? row.internalNotes : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findLiveAward(
  db: AdmissionsWriteDb,
  awardId: string,
  caseId: string,
): Promise<AwardRow> {
  const rows = await db.select().from(admissionsAwards).where(and(
    eq(admissionsAwards.id, awardId),
    eq(admissionsAwards.caseId, caseId),
    isNull(admissionsAwards.deletedAt),
  )).limit(1).for("update");
  if (!rows[0]) throw new Error("NotFound");
  return rows[0];
}

export interface CreateAwardInput {
  access: CaseAccess;
  title: string;
  organization?: string | null;
  gradeLevels?: AdmissionsAwardGradeLevel[];
  recognitionLevels?: AdmissionsAwardRecognitionLevel[];
  awardDate?: string | null;
  commonAppRank?: number | null;
  ucEligibilityNarrative?: string | null;
  ucAchievementNarrative?: string | null;
  internalNotes?: string | null;
}

export async function createAward(
  input: CreateAwardInput,
  db: Database = getDb(),
): Promise<AwardDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (input.internalNotes !== undefined && !roleAtLeast(input.access.role, "counselor")) {
    throw new Error("Forbidden");
  }
  const title = input.title.trim();
  if (!title) throw new Error("Award requires a non-empty title");
  const organization = nullableText(input.organization);
  const gradeLevels = parseGradeLevels(input.gradeLevels);
  const recognitionLevels = parseRecognitionLevels(input.recognitionLevels);
  if (input.awardDate != null) assertDateOnly(input.awardDate, "awardDate");
  const commonAppRank = input.commonAppRank ?? null;
  assertRank(commonAppRank);
  const ucEligibilityNarrative = nullableText(input.ucEligibilityNarrative);
  const ucAchievementNarrative = nullableText(input.ucAchievementNarrative);
  validateNarratives(ucEligibilityNarrative, ucAchievementNarrative);
  const internalNotes = nullableText(input.internalNotes);

  return withAuditedTransaction(async (tx) => {
    if (commonAppRank !== null) {
      const conflicts = await tx.select({ id: admissionsAwards.id }).from(admissionsAwards).where(and(
        eq(admissionsAwards.caseId, input.access.caseId),
        eq(admissionsAwards.commonAppRank, commonAppRank),
        isNull(admissionsAwards.deletedAt),
      )).limit(1);
      if (conflicts[0]) throw new Error("Conflict");
    }
    const rows = await tx.insert(admissionsAwards).values({
      caseId: input.access.caseId,
      title,
      organization,
      gradeLevels,
      recognitionLevels,
      awardDate: input.awardDate ?? null,
      commonAppRank,
      ucEligibilityNarrative,
      ucAchievementNarrative,
      internalNotes,
    }).returning();
    const row = rows[0];
    if (!row) throw new Error("Award insert returned no row");
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "award",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff({}, row as unknown as Record<string, unknown>, [
        "title", "organization", "gradeLevels", "recognitionLevels", "awardDate",
        "commonAppRank", "ucEligibilityNarrative", "ucAchievementNarrative", "internalNotes",
      ]),
    });
    return toDto(row, roleAtLeast(input.access.role, "counselor"));
  }, db);
}

export interface UpdateAwardInput extends Omit<Partial<CreateAwardInput>, "access"> {
  access: CaseAccess;
  awardId: string;
  expectedUpdatedAt?: string;
}

export async function updateAward(
  input: UpdateAwardInput,
  db: Database = getDb(),
): Promise<AwardDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.awardId)) throw new Error("NotFound");
  if (input.internalNotes !== undefined && !roleAtLeast(input.access.role, "counselor")) {
    throw new Error("Forbidden");
  }
  if (input.title !== undefined && !input.title.trim()) throw new Error("Award requires a non-empty title");
  if (input.awardDate != null) assertDateOnly(input.awardDate, "awardDate");
  if (input.commonAppRank !== undefined) assertRank(input.commonAppRank);
  const gradeLevels = input.gradeLevels === undefined ? undefined : parseGradeLevels(input.gradeLevels);
  const recognitionLevels = input.recognitionLevels === undefined
    ? undefined : parseRecognitionLevels(input.recognitionLevels);
  const normalized = {
    title: input.title?.trim(),
    organization: input.organization === undefined ? undefined : nullableText(input.organization),
    gradeLevels,
    recognitionLevels,
    awardDate: input.awardDate,
    commonAppRank: input.commonAppRank,
    ucEligibilityNarrative: input.ucEligibilityNarrative === undefined
      ? undefined : nullableText(input.ucEligibilityNarrative),
    ucAchievementNarrative: input.ucAchievementNarrative === undefined
      ? undefined : nullableText(input.ucAchievementNarrative),
    internalNotes: input.internalNotes === undefined ? undefined : nullableText(input.internalNotes),
  };
  validateNarratives(normalized.ucEligibilityNarrative ?? null, normalized.ucAchievementNarrative ?? null);

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveAward(tx, input.awardId, input.access.caseId);
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt.toISOString()) {
      throw new Error("Conflict");
    }
    const diff = computeFieldDiff(row as unknown as Record<string, unknown>, normalized, [
      "title", "organization", "gradeLevels", "recognitionLevels", "awardDate",
      "commonAppRank", "ucEligibilityNarrative", "ucAchievementNarrative", "internalNotes",
    ]);
    if (Object.keys(diff).length === 0) return toDto(row, roleAtLeast(input.access.role, "counselor"));
    if ("commonAppRank" in diff && normalized.commonAppRank !== null) {
      const conflicts = await tx.select({ id: admissionsAwards.id }).from(admissionsAwards).where(and(
        eq(admissionsAwards.caseId, input.access.caseId),
        eq(admissionsAwards.commonAppRank, normalized.commonAppRank as number),
        isNull(admissionsAwards.deletedAt),
      )).limit(1);
      if (conflicts.some(({ id }) => id !== row.id)) throw new Error("Conflict");
    }
    const now = new Date();
    const setValues: Partial<typeof admissionsAwards.$inferInsert> = { updatedAt: now };
    if ("title" in diff) setValues.title = normalized.title;
    if ("organization" in diff) setValues.organization = normalized.organization;
    if ("gradeLevels" in diff) setValues.gradeLevels = normalized.gradeLevels;
    if ("recognitionLevels" in diff) setValues.recognitionLevels = normalized.recognitionLevels;
    if ("awardDate" in diff) setValues.awardDate = normalized.awardDate;
    if ("commonAppRank" in diff) setValues.commonAppRank = normalized.commonAppRank;
    if ("ucEligibilityNarrative" in diff) {
      setValues.ucEligibilityNarrative = normalized.ucEligibilityNarrative;
    }
    if ("ucAchievementNarrative" in diff) {
      setValues.ucAchievementNarrative = normalized.ucAchievementNarrative;
    }
    if ("internalNotes" in diff) setValues.internalNotes = normalized.internalNotes;
    await tx.update(admissionsAwards).set(setValues).where(eq(admissionsAwards.id, row.id));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "award",
      entityId: row.id,
      action: "update",
      diff,
    });
    return toDto({ ...row, ...setValues } as AwardRow, roleAtLeast(input.access.role, "counselor"));
  }, db);
}

export async function setCommonAppAwardRanks(
  input: { access: CaseAccess; orderedIds: string[] },
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (input.orderedIds.length > MAX_COMMON_APP_RANKED_AWARDS ||
      new Set(input.orderedIds).size !== input.orderedIds.length ||
      input.orderedIds.some((id) => !isUuidShaped(id))) {
    throw new Error("Invalid Common App award ranking");
  }
  return withAuditedTransaction(async (tx) => {
    const rows = await tx.select().from(admissionsAwards).where(and(
      eq(admissionsAwards.caseId, input.access.caseId),
      isNull(admissionsAwards.deletedAt),
    )).for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (input.orderedIds.some((id) => !byId.has(id))) throw new Error("NotFound");
    const oldOrder = rows.filter((row) => row.commonAppRank !== null)
      .sort((a, b) => (a.commonAppRank ?? 99) - (b.commonAppRank ?? 99)).map((row) => row.id);
    if (oldOrder.length === input.orderedIds.length && oldOrder.every((id, i) => id === input.orderedIds[i])) return;
    const now = new Date();
    await tx.update(admissionsAwards).set({ commonAppRank: null, updatedAt: now }).where(and(
      eq(admissionsAwards.caseId, input.access.caseId),
      isNull(admissionsAwards.deletedAt),
    ));
    for (const [index, id] of input.orderedIds.entries()) {
      await tx.update(admissionsAwards).set({ commonAppRank: index + 1, updatedAt: now })
        .where(eq(admissionsAwards.id, id));
    }
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "award_rank",
      entityId: input.access.caseId,
      action: "update",
      diff: { orderedIds: { old: oldOrder, new: input.orderedIds } },
    });
  }, db);
}

export async function softDeleteAward(
  input: { access: CaseAccess; awardId: string },
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.awardId)) throw new Error("NotFound");
  return withAuditedTransaction(async (tx) => {
    const row = await findLiveAward(tx, input.awardId, input.access.caseId);
    const now = new Date();
    await tx.update(admissionsAwards).set({ deletedAt: now, commonAppRank: null, updatedAt: now })
      .where(eq(admissionsAwards.id, row.id));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "award",
      entityId: row.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

export async function listAwardsForCase(
  caseId: string,
  options: { includeInternalNotes?: boolean } = {},
  db: Database = getDb(),
): Promise<AwardDto[]> {
  if (!isUuidShaped(caseId)) return [];
  const rows = await db.select().from(admissionsAwards).where(and(
    eq(admissionsAwards.caseId, caseId),
    isNull(admissionsAwards.deletedAt),
  )).orderBy(asc(admissionsAwards.commonAppRank), asc(admissionsAwards.awardDate), asc(admissionsAwards.id));
  return rows
    .slice()
    .sort((a, b) => {
      const ar = a.commonAppRank ?? Number.MAX_SAFE_INTEGER;
      const br = b.commonAppRank ?? Number.MAX_SAFE_INTEGER;
      return ar - br || (b.awardDate ?? "").localeCompare(a.awardDate ?? "") || a.id.localeCompare(b.id);
    })
    .map((row) => toDto(row, options.includeInternalNotes === true));
}
