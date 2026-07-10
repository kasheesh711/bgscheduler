import { and, asc, eq, isNull } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import {
  admissionsCollegeListItems,
  admissionsCollegeRequirements,
  admissionsCollegeResearch,
  admissionsFinancialAidOffers,
  admissionsInterestEvents,
  admissionsScholarships,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import {
  ADMISSIONS_TASK_STATUSES,
  type AdmissionsTaskStatus,
} from "./checklists";
import { roleAtLeast } from "./config";
import {
  ADMISSIONS_TASK_OWNERS,
  type AdmissionsTaskOwner,
} from "./meetings";
import { isUuidShaped } from "./members";
import { normalizeAdmissionsUrl } from "./shared/urls";
import {
  COLLEGE_REQUIREMENT_KINDS,
  INTEREST_EVENT_TYPES,
  SCHOLARSHIP_STATUSES,
  type CollegeResearchSource,
  type CollegeRequirementKind,
  type InterestEventType,
  type ScholarshipStatus,
} from "./shared/college-details";
import type { CaseAccess } from "./types";

export {
  COLLEGE_REQUIREMENT_KINDS,
  INTEREST_EVENT_TYPES,
  SCHOLARSHIP_STATUSES,
};
export type {
  CollegeResearchSource,
  CollegeRequirementKind,
  InterestEventType,
  ScholarshipStatus,
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

type ResearchRow = typeof admissionsCollegeResearch.$inferSelect;
type InterestRow = typeof admissionsInterestEvents.$inferSelect;
type RequirementRow = typeof admissionsCollegeRequirements.$inferSelect;
type AidRow = typeof admissionsFinancialAidOffers.$inferSelect;
type ScholarshipRow = typeof admissionsScholarships.$inferSelect;

export interface CollegeResearchDto {
  id: string;
  listItemId: string;
  fitRating: number | null;
  sources: CollegeResearchSource[];
  campusVisitDate: string | null;
  campusVisitNotes: string | null;
  academicNotes: string | null;
  opportunities: string | null;
  questions: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InterestEventDto {
  id: string;
  listItemId: string;
  type: InterestEventType;
  eventDate: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollegeRequirementDto {
  id: string;
  listItemId: string;
  kind: CollegeRequirementKind;
  title: string;
  status: AdmissionsTaskStatus;
  owner: AdmissionsTaskOwner;
  dueDate: string | null;
  required: boolean;
  sourceUrl: string | null;
  notes: string | null;
  sortOrder: number;
  verifiedByEmail: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialAidOfferDto {
  id: string;
  listItemId: string;
  currency: string;
  awardYear: number;
  costBreakdown: Record<string, number | null>;
  giftAidBreakdown: Record<string, number | null>;
  loanBreakdown: Record<string, number | null>;
  workStudyAmount: string | null;
  netCost: string | null;
  remainingBalance: string | null;
  totalCost: number;
  totalGiftAid: number;
  totalLoans: number;
  derivedNetCost: number;
  derivedRemainingBalance: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScholarshipDto {
  id: string;
  caseId: string;
  listItemId: string | null;
  name: string;
  provider: string | null;
  url: string | null;
  requirements: string | null;
  deadline: string | null;
  status: ScholarshipStatus;
  outcome: string | null;
  offeredAmount: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function nullableText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function assertDate(value: string | null | undefined, field: string): void {
  if (value != null && !DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

function normalizeMoney(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const normalized = value.trim();
  if (!MONEY_PATTERN.test(normalized)) throw new Error(`Invalid ${field}`);
  return normalized;
}

function sumBreakdown(value: Record<string, number | null>): number {
  return Object.values(value).reduce<number>((sum, part) => {
    return sum + (typeof part === "number" && Number.isFinite(part) ? part : 0);
  }, 0);
}

function numberFromMoney(value: string | null): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeBreakdown(
  value: Record<string, number | null> | undefined,
): Record<string, number | null> | undefined {
  if (value === undefined) return undefined;
  const result: Record<string, number | null> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) throw new Error("Financial-aid breakdown keys cannot be blank");
    if (rawValue !== null && (!Number.isFinite(rawValue) || rawValue < 0)) {
      throw new Error("Financial-aid breakdown values must be non-negative numbers");
    }
    result[key] = rawValue;
  }
  return result;
}

function normalizeSources(value: CollegeResearchSource[] | undefined): CollegeResearchSource[] | undefined {
  if (value === undefined) return undefined;
  return value.map((source) => {
    const label = source.label.trim();
    if (!label) throw new Error("Research source label is required");
    const url = normalizeAdmissionsUrl(source.url, "research source URL");
    return { label, ...(url ? { url } : {}) };
  });
}

function toResearchDto(row: ResearchRow): CollegeResearchDto {
  const sources = Array.isArray(row.sources)
    ? row.sources.flatMap((value) => {
        const label = typeof value.label === "string" ? value.label.trim() : "";
        const url = typeof value.url === "string" ? value.url.trim() : "";
        return label ? [{ label, ...(url ? { url } : {}) }] : [];
      })
    : [];
  return {
    id: row.id,
    listItemId: row.listItemId,
    fitRating: row.fitRating,
    sources,
    campusVisitDate: row.campusVisitDate,
    campusVisitNotes: row.campusVisitNotes,
    academicNotes: row.academicNotes,
    opportunities: row.opportunities,
    questions: row.questions,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInterestDto(row: InterestRow): InterestEventDto {
  return {
    id: row.id,
    listItemId: row.listItemId,
    type: INTEREST_EVENT_TYPES.includes(row.type as InterestEventType)
      ? row.type as InterestEventType
      : "other",
    eventDate: row.eventDate,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRequirementDto(row: RequirementRow): CollegeRequirementDto {
  return {
    id: row.id,
    listItemId: row.listItemId,
    kind: COLLEGE_REQUIREMENT_KINDS.includes(row.kind as CollegeRequirementKind)
      ? row.kind as CollegeRequirementKind
      : "other",
    title: row.title,
    status: row.status,
    owner: row.owner,
    dueDate: row.dueDate,
    required: row.required,
    sourceUrl: row.sourceUrl,
    notes: row.notes,
    sortOrder: row.sortOrder,
    verifiedByEmail: row.verifiedByEmail,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAidDto(row: AidRow): FinancialAidOfferDto {
  const totalCost = sumBreakdown(row.costBreakdown);
  const totalGiftAid = sumBreakdown(row.giftAidBreakdown);
  const totalLoans = sumBreakdown(row.loanBreakdown);
  const derivedNetCost = row.netCost == null
    ? Math.max(0, totalCost - totalGiftAid)
    : numberFromMoney(row.netCost);
  const derivedRemainingBalance = row.remainingBalance == null
    ? Math.max(0, derivedNetCost - totalLoans - numberFromMoney(row.workStudyAmount))
    : numberFromMoney(row.remainingBalance);
  return {
    id: row.id,
    listItemId: row.listItemId,
    currency: row.currency,
    awardYear: row.awardYear,
    costBreakdown: row.costBreakdown,
    giftAidBreakdown: row.giftAidBreakdown,
    loanBreakdown: row.loanBreakdown,
    workStudyAmount: row.workStudyAmount,
    netCost: row.netCost,
    remainingBalance: row.remainingBalance,
    totalCost,
    totalGiftAid,
    totalLoans,
    derivedNetCost,
    derivedRemainingBalance,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toScholarshipDto(row: ScholarshipRow): ScholarshipDto {
  return {
    id: row.id,
    caseId: row.caseId,
    listItemId: row.listItemId,
    name: row.name,
    provider: row.provider,
    url: row.url,
    requirements: row.requirements,
    deadline: row.deadline,
    status: SCHOLARSHIP_STATUSES.includes(row.status as ScholarshipStatus)
      ? row.status as ScholarshipStatus
      : "researching",
    outcome: row.outcome,
    offeredAmount: row.offeredAmount,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertLiveListItem(
  db: AdmissionsWriteDb,
  caseId: string,
  listItemId: string,
  lockForUpdate = false,
): Promise<void> {
  if (!isUuidShaped(listItemId)) throw new Error("NotFound");
  const query = db.select({ id: admissionsCollegeListItems.id })
    .from(admissionsCollegeListItems)
    .where(and(
      eq(admissionsCollegeListItems.id, listItemId),
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    )).limit(1);
  const rows = lockForUpdate ? await query.for("update") : await query;
  if (!rows[0]) throw new Error("NotFound");
}

export async function getCollegeResearch(
  caseId: string,
  listItemId: string,
  db: Database = getDb(),
): Promise<CollegeResearchDto | null> {
  await assertLiveListItem(db, caseId, listItemId);
  const rows = await db.select().from(admissionsCollegeResearch)
    .where(eq(admissionsCollegeResearch.listItemId, listItemId)).limit(1);
  return rows[0] ? toResearchDto(rows[0]) : null;
}

export async function upsertCollegeResearch(input: {
  access: CaseAccess;
  listItemId: string;
  expectedUpdatedAt?: string;
  fitRating?: number | null;
  sources?: CollegeResearchSource[];
  campusVisitDate?: string | null;
  campusVisitNotes?: string | null;
  academicNotes?: string | null;
  opportunities?: string | null;
  questions?: string | null;
  notes?: string | null;
}, db: Database = getDb()): Promise<CollegeResearchDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (input.fitRating != null && (!Number.isInteger(input.fitRating) || input.fitRating < 1 || input.fitRating > 5)) {
    throw new Error("Invalid fitRating");
  }
  assertDate(input.campusVisitDate, "campusVisitDate");
  const next = {
    fitRating: input.fitRating,
    sources: normalizeSources(input.sources),
    campusVisitDate: input.campusVisitDate,
    campusVisitNotes: input.campusVisitNotes === undefined ? undefined : nullableText(input.campusVisitNotes),
    academicNotes: input.academicNotes === undefined ? undefined : nullableText(input.academicNotes),
    opportunities: input.opportunities === undefined ? undefined : nullableText(input.opportunities),
    questions: input.questions === undefined ? undefined : nullableText(input.questions),
    notes: input.notes === undefined ? undefined : nullableText(input.notes),
  };
  return withAuditedTransaction(async (tx) => {
    // Lock the parent before probing the unique child row. PostgreSQL cannot
    // lock a row that does not exist, so this serializes concurrent first
    // creates for the same college list item.
    await assertLiveListItem(tx, input.access.caseId, input.listItemId, true);
    const rows = await tx.select().from(admissionsCollegeResearch)
      .where(eq(admissionsCollegeResearch.listItemId, input.listItemId)).limit(1).for("update");
    const current = rows[0];
    if (current && input.expectedUpdatedAt !== undefined && current.updatedAt.toISOString() !== input.expectedUpdatedAt) {
      throw new Error("Conflict");
    }
    const now = new Date();
    let saved: ResearchRow;
    if (current) {
      const setValues = { ...next, updatedAt: now };
      const updated = await tx.update(admissionsCollegeResearch).set(setValues)
        .where(eq(admissionsCollegeResearch.id, current.id)).returning();
      saved = updated[0] ?? ({ ...current, ...setValues } as ResearchRow);
    } else {
      const inserted = await tx.insert(admissionsCollegeResearch).values({
        listItemId: input.listItemId,
        fitRating: next.fitRating ?? null,
        sources: next.sources ?? [],
        campusVisitDate: next.campusVisitDate ?? null,
        campusVisitNotes: next.campusVisitNotes ?? null,
        academicNotes: next.academicNotes ?? null,
        opportunities: next.opportunities ?? null,
        questions: next.questions ?? null,
        notes: next.notes ?? null,
      }).returning();
      if (!inserted[0]) throw new Error("Research insert returned no row");
      saved = inserted[0];
    }
    const diff = computeFieldDiff(
      (current ?? {}) as unknown as Record<string, unknown>,
      saved as unknown as Record<string, unknown>,
      ["fitRating", "sources", "campusVisitDate", "campusVisitNotes", "academicNotes", "opportunities", "questions", "notes"],
    );
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_research",
      entityId: saved.id,
      action: current ? "update" : "create",
      diff,
    });
    return toResearchDto(saved);
  }, db);
}

export async function listInterestEvents(
  caseId: string,
  listItemId: string,
  db: Database = getDb(),
): Promise<InterestEventDto[]> {
  await assertLiveListItem(db, caseId, listItemId);
  const rows = await db.select().from(admissionsInterestEvents).where(and(
    eq(admissionsInterestEvents.listItemId, listItemId),
    isNull(admissionsInterestEvents.deletedAt),
  )).orderBy(asc(admissionsInterestEvents.eventDate), asc(admissionsInterestEvents.createdAt));
  return rows.map(toInterestDto);
}

export async function createInterestEvent(input: {
  access: CaseAccess;
  listItemId: string;
  type: InterestEventType;
  eventDate: string;
  notes?: string | null;
}, db: Database = getDb()): Promise<InterestEventDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!INTEREST_EVENT_TYPES.includes(input.type)) throw new Error("Invalid interest event type");
  assertDate(input.eventDate, "eventDate");
  return withAuditedTransaction(async (tx) => {
    await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.insert(admissionsInterestEvents).values({
      listItemId: input.listItemId,
      type: input.type,
      eventDate: input.eventDate,
      notes: nullableText(input.notes),
      actorEmail: input.access.email,
    }).returning();
    if (!rows[0]) throw new Error("Interest event insert returned no row");
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "interest_event",
      entityId: rows[0].id,
      action: "create",
      diff: computeFieldDiff({}, rows[0] as unknown as Record<string, unknown>, ["type", "eventDate", "notes"]),
    });
    return toInterestDto(rows[0]);
  }, db);
}

export async function updateInterestEvent(input: {
  access: CaseAccess;
  listItemId: string;
  eventId: string;
  expectedUpdatedAt?: string;
  type?: InterestEventType;
  eventDate?: string;
  notes?: string | null;
}, db: Database = getDb()): Promise<InterestEventDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.eventId)) throw new Error("NotFound");
  if (input.type !== undefined && !INTEREST_EVENT_TYPES.includes(input.type)) throw new Error("Invalid interest event type");
  assertDate(input.eventDate, "eventDate");
  return withAuditedTransaction(async (tx) => {
    await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.select().from(admissionsInterestEvents).where(and(
      eq(admissionsInterestEvents.id, input.eventId),
      eq(admissionsInterestEvents.listItemId, input.listItemId),
      isNull(admissionsInterestEvents.deletedAt),
    )).limit(1).for("update");
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");
    const next = {
      type: input.type,
      eventDate: input.eventDate,
      notes: input.notes === undefined ? undefined : nullableText(input.notes),
      updatedAt: new Date(),
    };
    const updated = await tx.update(admissionsInterestEvents).set(next)
      .where(eq(admissionsInterestEvents.id, row.id)).returning();
    const saved = updated[0] ?? ({ ...row, ...next } as InterestRow);
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "interest_event",
      entityId: row.id,
      action: "update",
      diff: computeFieldDiff(row as unknown as Record<string, unknown>, next, ["type", "eventDate", "notes"]),
    });
    return toInterestDto(saved);
  }, db);
}

export async function deleteInterestEvent(input: {
  access: CaseAccess;
  listItemId: string;
  eventId: string;
}, db: Database = getDb()): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.eventId)) throw new Error("NotFound");
  return withAuditedTransaction(async (tx) => {
    await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.select().from(admissionsInterestEvents).where(and(
      eq(admissionsInterestEvents.id, input.eventId),
      eq(admissionsInterestEvents.listItemId, input.listItemId),
      isNull(admissionsInterestEvents.deletedAt),
    )).limit(1).for("update");
    if (!rows[0]) throw new Error("NotFound");
    const now = new Date();
    await tx.update(admissionsInterestEvents).set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsInterestEvents.id, input.eventId));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "interest_event",
      entityId: input.eventId,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

export async function listCollegeRequirements(
  caseId: string,
  listItemId: string,
  db: Database = getDb(),
): Promise<CollegeRequirementDto[]> {
  await assertLiveListItem(db, caseId, listItemId);
  const rows = await db.select().from(admissionsCollegeRequirements).where(and(
    eq(admissionsCollegeRequirements.listItemId, listItemId),
    isNull(admissionsCollegeRequirements.deletedAt),
  )).orderBy(asc(admissionsCollegeRequirements.sortOrder), asc(admissionsCollegeRequirements.createdAt));
  return rows.map(toRequirementDto);
}

export async function createCollegeRequirement(input: {
  access: CaseAccess;
  listItemId: string;
  kind: CollegeRequirementKind;
  title: string;
  status?: AdmissionsTaskStatus;
  owner?: AdmissionsTaskOwner;
  dueDate?: string | null;
  required?: boolean;
  sourceUrl?: string | null;
  notes?: string | null;
  sortOrder?: number;
}, db: Database = getDb()): Promise<CollegeRequirementDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!COLLEGE_REQUIREMENT_KINDS.includes(input.kind)) throw new Error("Invalid requirement kind");
  if (!input.title.trim()) throw new Error("Requirement title is required");
  const owner = input.owner ?? "student";
  if (!ADMISSIONS_TASK_OWNERS.includes(owner) || owner === "parent") throw new Error("Invalid requirement owner");
  const status = input.status ?? "not_started";
  if (!ADMISSIONS_TASK_STATUSES.includes(status)) throw new Error("Invalid requirement status");
  assertDate(input.dueDate, "dueDate");
  return withAuditedTransaction(async (tx) => {
    await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.insert(admissionsCollegeRequirements).values({
      listItemId: input.listItemId,
      kind: input.kind,
      title: input.title.trim(),
      status,
      owner,
      dueDate: input.dueDate ?? null,
      required: input.required ?? true,
      sourceUrl: normalizeAdmissionsUrl(input.sourceUrl, "sourceUrl") ?? null,
      notes: nullableText(input.notes),
      sortOrder: input.sortOrder ?? 0,
    }).returning();
    if (!rows[0]) throw new Error("Requirement insert returned no row");
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_requirement",
      entityId: rows[0].id,
      action: "create",
      diff: computeFieldDiff({}, rows[0] as unknown as Record<string, unknown>, ["kind", "title", "status", "owner", "dueDate", "required", "sourceUrl", "notes", "sortOrder"]),
    });
    return toRequirementDto(rows[0]);
  }, db);
}

export async function updateCollegeRequirement(input: {
  access: CaseAccess;
  listItemId: string;
  requirementId: string;
  expectedUpdatedAt?: string;
  kind?: CollegeRequirementKind;
  title?: string;
  status?: AdmissionsTaskStatus;
  owner?: AdmissionsTaskOwner;
  dueDate?: string | null;
  required?: boolean;
  sourceUrl?: string | null;
  notes?: string | null;
  sortOrder?: number;
  verify?: boolean;
}, db: Database = getDb()): Promise<CollegeRequirementDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.requirementId)) throw new Error("NotFound");
  if (input.kind !== undefined && !COLLEGE_REQUIREMENT_KINDS.includes(input.kind)) throw new Error("Invalid requirement kind");
  if (input.title !== undefined && !input.title.trim()) throw new Error("Requirement title is required");
  if (input.status !== undefined && !ADMISSIONS_TASK_STATUSES.includes(input.status)) throw new Error("Invalid requirement status");
  if (input.owner !== undefined && (!ADMISSIONS_TASK_OWNERS.includes(input.owner) || input.owner === "parent")) throw new Error("Invalid requirement owner");
  assertDate(input.dueDate, "dueDate");
  if (input.access.role === "student") {
    const changesDefinition =
      input.kind !== undefined ||
      input.title !== undefined ||
      input.owner !== undefined ||
      input.dueDate !== undefined ||
      input.required !== undefined ||
      input.sourceUrl !== undefined ||
      input.notes !== undefined ||
      input.sortOrder !== undefined ||
      input.verify !== undefined;
    if (changesDefinition) throw new Error("Forbidden");
  }
  return withAuditedTransaction(async (tx) => {
    await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.select().from(admissionsCollegeRequirements).where(and(
      eq(admissionsCollegeRequirements.id, input.requirementId),
      eq(admissionsCollegeRequirements.listItemId, input.listItemId),
      isNull(admissionsCollegeRequirements.deletedAt),
    )).limit(1).for("update");
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");
    if (input.access.role === "student") {
      if (row.owner !== "student") throw new Error("Forbidden");
    }
    if (input.verify !== undefined && !roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
    const next = {
      kind: input.kind,
      title: input.title?.trim(),
      status: input.status,
      owner: input.owner,
      dueDate: input.dueDate,
      required: input.required,
      sourceUrl: input.sourceUrl === undefined
        ? undefined
        : normalizeAdmissionsUrl(input.sourceUrl, "sourceUrl"),
      notes: input.notes === undefined ? undefined : nullableText(input.notes),
      sortOrder: input.sortOrder,
      verifiedByEmail: input.verify === undefined ? undefined : input.verify ? input.access.email : null,
      verifiedAt: input.verify === undefined ? undefined : input.verify ? new Date() : null,
      updatedAt: new Date(),
    };
    const updated = await tx.update(admissionsCollegeRequirements).set(next)
      .where(eq(admissionsCollegeRequirements.id, row.id)).returning();
    const saved = updated[0] ?? ({ ...row, ...next } as RequirementRow);
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_requirement",
      entityId: row.id,
      action: input.verify === undefined ? "update" : input.verify ? "verify" : "unverify",
      diff: computeFieldDiff(row as unknown as Record<string, unknown>, next, ["kind", "title", "status", "owner", "dueDate", "required", "sourceUrl", "notes", "sortOrder", "verifiedByEmail", "verifiedAt"]),
    });
    return toRequirementDto(saved);
  }, db);
}

export async function deleteCollegeRequirement(input: {
  access: CaseAccess;
  listItemId: string;
  requirementId: string;
}, db: Database = getDb()): Promise<void> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.requirementId)) throw new Error("NotFound");
  return withAuditedTransaction(async (tx) => {
    await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.select({ id: admissionsCollegeRequirements.id }).from(admissionsCollegeRequirements).where(and(
      eq(admissionsCollegeRequirements.id, input.requirementId),
      eq(admissionsCollegeRequirements.listItemId, input.listItemId),
      isNull(admissionsCollegeRequirements.deletedAt),
    )).limit(1);
    if (!rows[0]) throw new Error("NotFound");
    const now = new Date();
    await tx.update(admissionsCollegeRequirements).set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsCollegeRequirements.id, input.requirementId));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_requirement",
      entityId: input.requirementId,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

export async function getFinancialAidOffer(
  caseId: string,
  listItemId: string,
  db: Database = getDb(),
): Promise<FinancialAidOfferDto | null> {
  await assertLiveListItem(db, caseId, listItemId);
  const rows = await db.select().from(admissionsFinancialAidOffers)
    .where(eq(admissionsFinancialAidOffers.listItemId, listItemId)).limit(1);
  return rows[0] ? toAidDto(rows[0]) : null;
}

export async function upsertFinancialAidOffer(input: {
  access: CaseAccess;
  listItemId: string;
  expectedUpdatedAt?: string;
  currency?: string;
  awardYear?: number;
  costBreakdown?: Record<string, number | null>;
  giftAidBreakdown?: Record<string, number | null>;
  loanBreakdown?: Record<string, number | null>;
  workStudyAmount?: string | null;
  netCost?: string | null;
  remainingBalance?: string | null;
  notes?: string | null;
}, db: Database = getDb()): Promise<FinancialAidOfferDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (input.awardYear !== undefined && (!Number.isInteger(input.awardYear) || input.awardYear < 2000 || input.awardYear > 2200)) {
    throw new Error("Invalid awardYear");
  }
  const currency = input.currency?.trim().toUpperCase();
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new Error("Invalid currency");
  const next = {
    currency,
    awardYear: input.awardYear,
    costBreakdown: normalizeBreakdown(input.costBreakdown),
    giftAidBreakdown: normalizeBreakdown(input.giftAidBreakdown),
    loanBreakdown: normalizeBreakdown(input.loanBreakdown),
    workStudyAmount: normalizeMoney(input.workStudyAmount, "workStudyAmount"),
    netCost: normalizeMoney(input.netCost, "netCost"),
    remainingBalance: normalizeMoney(input.remainingBalance, "remainingBalance"),
    notes: input.notes === undefined ? undefined : nullableText(input.notes),
  };
  return withAuditedTransaction(async (tx) => {
    // See upsertCollegeResearch: the parent lock closes the absent-child race
    // before the unique financial-aid row is selected/inserted.
    await assertLiveListItem(tx, input.access.caseId, input.listItemId, true);
    const rows = await tx.select().from(admissionsFinancialAidOffers)
      .where(eq(admissionsFinancialAidOffers.listItemId, input.listItemId)).limit(1).for("update");
    const current = rows[0];
    if (current && input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt.toISOString()) throw new Error("Conflict");
    let saved: AidRow;
    if (current) {
      const setValues = { ...next, updatedAt: new Date() };
      const updated = await tx.update(admissionsFinancialAidOffers).set(setValues)
        .where(eq(admissionsFinancialAidOffers.id, current.id)).returning();
      saved = updated[0] ?? ({ ...current, ...setValues } as AidRow);
    } else {
      if (next.awardYear === undefined) throw new Error("awardYear is required");
      const inserted = await tx.insert(admissionsFinancialAidOffers).values({
        listItemId: input.listItemId,
        currency: next.currency ?? "USD",
        awardYear: next.awardYear,
        costBreakdown: next.costBreakdown ?? {},
        giftAidBreakdown: next.giftAidBreakdown ?? {},
        loanBreakdown: next.loanBreakdown ?? {},
        workStudyAmount: next.workStudyAmount ?? null,
        netCost: next.netCost ?? null,
        remainingBalance: next.remainingBalance ?? null,
        notes: next.notes ?? null,
      }).returning();
      if (!inserted[0]) throw new Error("Financial aid insert returned no row");
      saved = inserted[0];
    }
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "financial_aid_offer",
      entityId: saved.id,
      action: current ? "update" : "create",
      diff: computeFieldDiff((current ?? {}) as unknown as Record<string, unknown>, saved as unknown as Record<string, unknown>, ["currency", "awardYear", "costBreakdown", "giftAidBreakdown", "loanBreakdown", "workStudyAmount", "netCost", "remainingBalance", "notes"]),
    });
    return toAidDto(saved);
  }, db);
}

export async function listScholarships(caseId: string, db: Database = getDb()): Promise<ScholarshipDto[]> {
  const rows = await db.select().from(admissionsScholarships).where(and(
    eq(admissionsScholarships.caseId, caseId),
    isNull(admissionsScholarships.deletedAt),
  )).orderBy(asc(admissionsScholarships.deadline), asc(admissionsScholarships.name));
  return rows.map(toScholarshipDto);
}

export async function createScholarship(input: {
  access: CaseAccess;
  listItemId?: string | null;
  name: string;
  provider?: string | null;
  url?: string | null;
  requirements?: string | null;
  deadline?: string | null;
  status?: ScholarshipStatus;
  outcome?: string | null;
  offeredAmount?: string | null;
  notes?: string | null;
}, db: Database = getDb()): Promise<ScholarshipDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!input.name.trim()) throw new Error("Scholarship name is required");
  const status = input.status ?? "researching";
  if (!SCHOLARSHIP_STATUSES.includes(status)) throw new Error("Invalid scholarship status");
  assertDate(input.deadline, "deadline");
  if ((input.outcome !== undefined || input.offeredAmount !== undefined) && !roleAtLeast(input.access.role, "counselor")) {
    throw new Error("Forbidden");
  }
  const offeredAmount = normalizeMoney(input.offeredAmount, "offeredAmount");
  return withAuditedTransaction(async (tx) => {
    if (input.listItemId) await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const rows = await tx.insert(admissionsScholarships).values({
      caseId: input.access.caseId,
      listItemId: input.listItemId ?? null,
      name: input.name.trim(),
      provider: nullableText(input.provider),
      url: normalizeAdmissionsUrl(input.url, "scholarship URL") ?? null,
      requirements: nullableText(input.requirements),
      deadline: input.deadline ?? null,
      status,
      outcome: nullableText(input.outcome),
      offeredAmount: offeredAmount ?? null,
      notes: nullableText(input.notes),
    }).returning();
    if (!rows[0]) throw new Error("Scholarship insert returned no row");
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "scholarship",
      entityId: rows[0].id,
      action: "create",
      diff: computeFieldDiff({}, rows[0] as unknown as Record<string, unknown>, ["listItemId", "name", "provider", "url", "requirements", "deadline", "status", "outcome", "offeredAmount", "notes"]),
    });
    return toScholarshipDto(rows[0]);
  }, db);
}

export async function updateScholarship(input: {
  access: CaseAccess;
  scholarshipId: string;
  expectedUpdatedAt?: string;
  listItemId?: string | null;
  name?: string;
  provider?: string | null;
  url?: string | null;
  requirements?: string | null;
  deadline?: string | null;
  status?: ScholarshipStatus;
  outcome?: string | null;
  offeredAmount?: string | null;
  notes?: string | null;
}, db: Database = getDb()): Promise<ScholarshipDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.scholarshipId)) throw new Error("NotFound");
  if (input.name !== undefined && !input.name.trim()) throw new Error("Scholarship name is required");
  if (input.status !== undefined && !SCHOLARSHIP_STATUSES.includes(input.status)) throw new Error("Invalid scholarship status");
  assertDate(input.deadline, "deadline");
  if ((input.outcome !== undefined || input.offeredAmount !== undefined) && !roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  const next = {
    listItemId: input.listItemId,
    name: input.name?.trim(),
    provider: input.provider === undefined ? undefined : nullableText(input.provider),
    url: input.url === undefined
      ? undefined
      : normalizeAdmissionsUrl(input.url, "scholarship URL"),
    requirements: input.requirements === undefined ? undefined : nullableText(input.requirements),
    deadline: input.deadline,
    status: input.status,
    outcome: input.outcome === undefined ? undefined : nullableText(input.outcome),
    offeredAmount: normalizeMoney(input.offeredAmount, "offeredAmount"),
    notes: input.notes === undefined ? undefined : nullableText(input.notes),
    updatedAt: new Date(),
  };
  return withAuditedTransaction(async (tx) => {
    const rows = await tx.select().from(admissionsScholarships).where(and(
      eq(admissionsScholarships.id, input.scholarshipId),
      eq(admissionsScholarships.caseId, input.access.caseId),
      isNull(admissionsScholarships.deletedAt),
    )).limit(1).for("update");
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");
    if (input.listItemId) await assertLiveListItem(tx, input.access.caseId, input.listItemId);
    const updated = await tx.update(admissionsScholarships).set(next)
      .where(eq(admissionsScholarships.id, row.id)).returning();
    const saved = updated[0] ?? ({ ...row, ...next } as ScholarshipRow);
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "scholarship",
      entityId: row.id,
      action: "update",
      diff: computeFieldDiff(row as unknown as Record<string, unknown>, next, ["listItemId", "name", "provider", "url", "requirements", "deadline", "status", "outcome", "offeredAmount", "notes"]),
    });
    return toScholarshipDto(saved);
  }, db);
}

export async function deleteScholarship(input: {
  access: CaseAccess;
  scholarshipId: string;
}, db: Database = getDb()): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.scholarshipId)) throw new Error("NotFound");
  return withAuditedTransaction(async (tx) => {
    const rows = await tx.select({ id: admissionsScholarships.id }).from(admissionsScholarships).where(and(
      eq(admissionsScholarships.id, input.scholarshipId),
      eq(admissionsScholarships.caseId, input.access.caseId),
      isNull(admissionsScholarships.deletedAt),
    )).limit(1);
    if (!rows[0]) throw new Error("NotFound");
    const now = new Date();
    await tx.update(admissionsScholarships).set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsScholarships.id, input.scholarshipId));
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "scholarship",
      entityId: input.scholarshipId,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}
