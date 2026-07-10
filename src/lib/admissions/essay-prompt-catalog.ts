import { and, asc, eq, ilike, isNull, type SQL } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import {
  admissionsCollegeListItems,
  admissionsEssayPromptCatalog,
  admissionsEssays,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import { normalizeAdmissionsUrl } from "./shared/urls";
import type { CaseAccess } from "./types";

type PromptRow = typeof admissionsEssayPromptCatalog.$inferSelect;

export interface EssayPromptCatalogDto {
  id: string;
  unitId: number | null;
  institution: string;
  program: string;
  cycle: string;
  promptKey: string;
  prompt: string;
  wordLimit: number | null;
  required: boolean;
  sourceUrl: string | null;
  verifiedAt: string | null;
  verifiedByEmail: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EssayFromPromptDto {
  id: string;
  caseId: string;
  listItemId: string | null;
  prompt: string;
  status: "not_started";
  deadline: string | null;
  driveUrl: null;
  sharedWithFamily: false;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: PromptRow): EssayPromptCatalogDto {
  return {
    id: row.id,
    unitId: row.unitId,
    institution: row.institution,
    program: row.program,
    cycle: row.cycle,
    promptKey: row.promptKey,
    prompt: row.prompt,
    wordLimit: row.wordLimit,
    required: row.required,
    sourceUrl: row.sourceUrl,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedByEmail: row.verifiedByEmail,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeUrl(value: string | null | undefined): string | null {
  return normalizeAdmissionsUrl(value, "sourceUrl") ?? null;
}

export async function listEssayPromptCatalog(
  filters: { institution?: string; cycle?: string; unitId?: number; activeOnly?: boolean } = {},
  db: Database = getDb(),
): Promise<EssayPromptCatalogDto[]> {
  const clauses: SQL[] = [];
  if (filters.institution?.trim()) {
    clauses.push(ilike(admissionsEssayPromptCatalog.institution, `%${filters.institution.trim()}%`));
  }
  if (filters.cycle?.trim()) clauses.push(eq(admissionsEssayPromptCatalog.cycle, filters.cycle.trim()));
  if (filters.unitId !== undefined) clauses.push(eq(admissionsEssayPromptCatalog.unitId, filters.unitId));
  if (filters.activeOnly !== false) clauses.push(eq(admissionsEssayPromptCatalog.active, true));
  const rows = await db.select().from(admissionsEssayPromptCatalog)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(
      asc(admissionsEssayPromptCatalog.institution),
      asc(admissionsEssayPromptCatalog.program),
      asc(admissionsEssayPromptCatalog.promptKey),
    ).limit(500);
  return rows.map(toDto);
}

export async function createEssayPrompt(input: {
  actorEmail: string;
  actorRole: CaseAccess["role"];
  unitId?: number | null;
  institution: string;
  program?: string;
  cycle: string;
  promptKey: string;
  prompt: string;
  wordLimit?: number | null;
  required?: boolean;
  sourceUrl?: string | null;
  verified?: boolean;
}, db: Database = getDb()): Promise<EssayPromptCatalogDto> {
  if (!roleAtLeast(input.actorRole, "counselor")) throw new Error("Forbidden");
  const institution = input.institution.trim();
  const cycle = input.cycle.trim();
  const promptKey = input.promptKey.trim();
  const prompt = input.prompt.trim();
  if (!institution || !cycle || !promptKey || !prompt) throw new Error("Prompt identity and text are required");
  if (input.wordLimit != null && (!Number.isInteger(input.wordLimit) || input.wordLimit <= 0)) throw new Error("Invalid wordLimit");
  return withAuditedTransaction(async (tx) => {
    const rows = await tx.insert(admissionsEssayPromptCatalog).values({
      unitId: input.unitId ?? null,
      institution,
      program: input.program?.trim() ?? "",
      cycle,
      promptKey,
      prompt,
      wordLimit: input.wordLimit ?? null,
      required: input.required ?? true,
      sourceUrl: normalizeUrl(input.sourceUrl),
      verifiedAt: input.verified ? new Date() : null,
      verifiedByEmail: input.verified ? input.actorEmail : null,
    }).returning();
    if (!rows[0]) throw new Error("Prompt insert returned no row");
    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "essay_prompt_catalog",
      entityId: rows[0].id,
      action: "create",
      diff: computeFieldDiff({}, rows[0] as unknown as Record<string, unknown>, [
        "unitId", "institution", "program", "cycle", "promptKey", "prompt",
        "wordLimit", "required", "sourceUrl", "verifiedAt", "verifiedByEmail",
      ]),
    });
    return toDto(rows[0]);
  }, db);
}

export async function updateEssayPrompt(input: {
  actorEmail: string;
  actorRole: CaseAccess["role"];
  promptId: string;
  expectedUpdatedAt?: string;
  unitId?: number | null;
  institution?: string;
  program?: string;
  cycle?: string;
  promptKey?: string;
  prompt?: string;
  wordLimit?: number | null;
  required?: boolean;
  sourceUrl?: string | null;
  active?: boolean;
  verified?: boolean;
}, db: Database = getDb()): Promise<EssayPromptCatalogDto> {
  if (!roleAtLeast(input.actorRole, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.promptId)) throw new Error("NotFound");
  if (input.wordLimit != null && (!Number.isInteger(input.wordLimit) || input.wordLimit <= 0)) throw new Error("Invalid wordLimit");
  const next = {
    unitId: input.unitId,
    institution: input.institution?.trim(),
    program: input.program?.trim(),
    cycle: input.cycle?.trim(),
    promptKey: input.promptKey?.trim(),
    prompt: input.prompt?.trim(),
    wordLimit: input.wordLimit,
    required: input.required,
    sourceUrl: input.sourceUrl === undefined ? undefined : normalizeUrl(input.sourceUrl),
    active: input.active,
    verifiedAt: input.verified === undefined ? undefined : input.verified ? new Date() : null,
    verifiedByEmail: input.verified === undefined ? undefined : input.verified ? input.actorEmail : null,
    updatedAt: new Date(),
  };
  if ([next.institution, next.cycle, next.promptKey, next.prompt].some((value) => value === "")) {
    throw new Error("Prompt identity and text cannot be blank");
  }
  return withAuditedTransaction(async (tx) => {
    const rows = await tx.select().from(admissionsEssayPromptCatalog)
      .where(eq(admissionsEssayPromptCatalog.id, input.promptId)).limit(1).for("update");
    const row = rows[0];
    if (!row) throw new Error("NotFound");
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");
    const updated = await tx.update(admissionsEssayPromptCatalog).set(next)
      .where(eq(admissionsEssayPromptCatalog.id, input.promptId)).returning();
    const saved = updated[0] ?? ({ ...row, ...next } as PromptRow);
    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "essay_prompt_catalog",
      entityId: input.promptId,
      action: "update",
      diff: computeFieldDiff(row as unknown as Record<string, unknown>, next, [
        "unitId", "institution", "program", "cycle", "promptKey", "prompt",
        "wordLimit", "required", "sourceUrl", "active", "verifiedAt", "verifiedByEmail",
      ]),
    });
    return toDto(saved);
  }, db);
}

export async function createEssayFromCatalogPrompt(input: {
  access: CaseAccess;
  promptId: string;
  listItemId?: string | null;
  deadline?: string | null;
}, db: Database = getDb()): Promise<EssayFromPromptDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (
    input.access.role === "student" &&
    (input.listItemId !== undefined || input.deadline !== undefined)
  ) throw new Error("Forbidden");
  if (!isUuidShaped(input.promptId)) throw new Error("NotFound");
  if (input.deadline != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.deadline)) throw new Error("Invalid deadline");
  return withAuditedTransaction(async (tx) => {
    const promptRows = await tx.select().from(admissionsEssayPromptCatalog).where(and(
      eq(admissionsEssayPromptCatalog.id, input.promptId),
      eq(admissionsEssayPromptCatalog.active, true),
    )).limit(1);
    const catalog = promptRows[0];
    if (!catalog) throw new Error("NotFound");
    if (input.listItemId) {
      const itemRows = await tx.select({ id: admissionsCollegeListItems.id })
        .from(admissionsCollegeListItems).where(and(
          eq(admissionsCollegeListItems.id, input.listItemId),
          eq(admissionsCollegeListItems.caseId, input.access.caseId),
          isNull(admissionsCollegeListItems.deletedAt),
        )).limit(1);
      if (!itemRows[0]) throw new Error("NotFound");
    }
    const duplicates = await tx.select({ id: admissionsEssays.id }).from(admissionsEssays).where(and(
      eq(admissionsEssays.caseId, input.access.caseId),
      input.listItemId
        ? eq(admissionsEssays.listItemId, input.listItemId)
        : isNull(admissionsEssays.listItemId),
      eq(admissionsEssays.prompt, catalog.prompt),
      isNull(admissionsEssays.deletedAt),
    )).limit(1);
    if (duplicates[0]) throw new Error("Conflict");
    const rows = await tx.insert(admissionsEssays).values({
      caseId: input.access.caseId,
      listItemId: input.listItemId ?? null,
      prompt: catalog.prompt,
      deadline: input.deadline ?? null,
      sharedWithFamily: false,
    }).returning();
    const row = rows[0];
    if (!row) throw new Error("Essay insert returned no row");
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "essay",
      entityId: row.id,
      action: "create_from_catalog",
      diff: {
        promptCatalogId: { old: null, new: catalog.id },
        prompt: { old: null, new: catalog.prompt },
        listItemId: { old: null, new: input.listItemId ?? null },
      },
    });
    return {
      id: row.id,
      caseId: row.caseId,
      listItemId: row.listItemId,
      prompt: row.prompt,
      status: "not_started",
      deadline: row.deadline,
      driveUrl: null,
      sharedWithFamily: false,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }, db);
}
