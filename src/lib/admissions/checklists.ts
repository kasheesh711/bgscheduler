// Admissions Case Management — checklist template versioning, copy-on-
// instantiate, push-new-items, task operations, and progress math.
//
// Design: docs/casemanagementsystem_design.md §1 (checklists.ts module map
// row), §3 (admissions_checklist_templates / admissions_template_items /
// admissions_case_tasks). PRD CM-20..CM-24.
//
// Core rules:
// - CM-20: templates are IMMUTABLE once published — there is no item-edit
//   path at all; "editing" means createTemplateVersion (version = max + 1).
// - CM-21: case creation copies the latest PUBLISHED template's items into
//   admissions_case_tasks (snapshot semantics, stamped with templateId /
//   templateVersion / itemKey). Template edits never mutate existing case
//   tasks; pushNewItemsToCohortCases is the explicit admin append action and
//   only ever inserts rows whose itemKey a case does not already have.
// - CM-22/23: students may update status ONLY on student-owned tasks of
//   their own case; verification and custom tasks (with weekly/biweekly
//   recurrence) are counselor+; template-derived tasks cannot be deleted.
// - CM-24: progress % counts done items; verified is surfaced separately.
//
// Error contract (admissionsErrorResponse maps these): missing rows /
// malformed ids → Error("NotFound"); role violations → Error("Forbidden");
// rule violations (publish twice, delete template-derived task, verify a
// non-student-owned task) → Error("Conflict"); input-shape violations throw
// descriptive Errors (routes' Zod schemas are the 400 boundary).

import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCases,
  admissionsCaseTasks,
  admissionsChecklistTemplates,
  admissionsCohorts,
  admissionsTemplateItems,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import {
  DEFAULT_CHECKLIST_ITEMS,
  isAdmissionsPhaseKey,
  roleAtLeast,
  type AdmissionsTemplateItemSeed,
} from "./config";
import {
  ADMISSIONS_ASSIGNABLE_TASK_OWNERS,
  MEETING_ACTION_ITEM_PHASE,
  type AdmissionsTaskOwner,
} from "./meetings";
import { isUuidShaped, type AdmissionsActor } from "./members";
import type { CaseAccess } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

type TemplateRow = typeof admissionsChecklistTemplates.$inferSelect;
type TemplateItemRow = typeof admissionsTemplateItems.$inferSelect;
type CaseTaskRow = typeof admissionsCaseTasks.$inferSelect;

/** Ensures an optimistic-concurrency token always advances at millisecond precision. */
function nextMutationTimestamp(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

// ── Types & validation schemas ──────────────────────────────────────────

/** Task lifecycle (mirrors admissions_task_status). */
export type AdmissionsTaskStatus = "not_started" | "in_progress" | "done";

/** All valid task statuses, for boundary validation. */
export const ADMISSIONS_TASK_STATUSES: readonly AdmissionsTaskStatus[] = [
  "not_started",
  "in_progress",
  "done",
];

/**
 * Simple recurrence for counselor-created custom tasks (CM-23): weekly or
 * biweekly until an end date. Stored as-is in admissions_case_tasks.recurrence
 * (jsonb); strict — unknown keys are rejected.
 */
export const admissionsTaskRecurrenceSchema = z.strictObject({
  freq: z.enum(["weekly", "biweekly"]),
  until: z.string().regex(DATE_ONLY_PATTERN, 'expected "YYYY-MM-DD"'),
});

/** Parsed recurrence payload ({ freq: "weekly" | "biweekly", until: "YYYY-MM-DD" }). */
export type AdmissionsTaskRecurrence = z.infer<typeof admissionsTaskRecurrenceSchema>;

/** One template item row serialized for the template admin UI. */
export interface AdmissionsTemplateItemDto {
  id: string;
  templateId: string;
  itemKey: string;
  phase: string;
  title: string;
  description: string | null;
  defaultOwner: AdmissionsTaskOwner;
  sortOrder: number;
}

/** One checklist-template version with its items (design §4 cohort routes). */
export interface AdmissionsTemplateDto {
  id: string;
  cohortId: string;
  version: number;
  name: string;
  /** ISO publish instant; null while the version is an editable-by-replacement draft. */
  publishedAt: string | null;
  items: AdmissionsTemplateItemDto[];
  createdAt: string;
  updatedAt: string;
}

/** One case task row serialized for the checklist tab (design §5.1). */
export interface AdmissionsTaskDto {
  id: string;
  caseId: string;
  templateId: string | null;
  templateVersion: number | null;
  itemKey: string | null;
  phase: string;
  title: string;
  description: string | null;
  owner: AdmissionsTaskOwner;
  status: AdmissionsTaskStatus;
  dueDate: string | null;
  verifiedByEmail: string | null;
  verifiedAt: string | null;
  recurrence: AdmissionsTaskRecurrence | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Checklist progress rollup for one case (CM-24). */
export interface AdmissionsChecklistProgress {
  done: number;
  total: number;
  /** 0–100 integer; 0 when the case has no tasks. */
  percent: number;
  /** Tasks carrying a counselor verification stamp — surfaced separately from done. */
  verifiedCount: number;
}

const ZERO_PROGRESS: AdmissionsChecklistProgress = {
  done: 0,
  total: 0,
  percent: 0,
  verifiedCount: 0,
};

// ── Internal helpers ────────────────────────────────────────────────────

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

/**
 * Validates a recurrence input (undefined/null → null). Invalid shapes throw
 * a descriptive Error rather than being stored — recurrence is never guessed.
 */
function parseRecurrenceInput(
  value: AdmissionsTaskRecurrence | null | undefined,
): AdmissionsTaskRecurrence | null {
  if (value == null) return null;
  const parsed = admissionsTaskRecurrenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'Invalid recurrence: expected { freq: "weekly" | "biweekly", until: "YYYY-MM-DD" }',
    );
  }
  return parsed.data;
}

/** Stored jsonb → typed recurrence; malformed stored payloads read as null (fail-closed). */
function toRecurrenceDto(value: Record<string, unknown> | null): AdmissionsTaskRecurrence | null {
  if (value === null) return null;
  const parsed = admissionsTaskRecurrenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toTemplateItemDto(row: TemplateItemRow): AdmissionsTemplateItemDto {
  return {
    id: row.id,
    templateId: row.templateId,
    itemKey: row.itemKey,
    phase: row.phase,
    title: row.title,
    description: row.description,
    defaultOwner: row.defaultOwner,
    sortOrder: row.sortOrder,
  };
}

function toTemplateDto(row: TemplateRow, itemRows: readonly TemplateItemRow[]): AdmissionsTemplateDto {
  return {
    id: row.id,
    cohortId: row.cohortId,
    version: row.version,
    name: row.name,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    items: itemRows.map(toTemplateItemDto),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTaskDto(row: CaseTaskRow): AdmissionsTaskDto {
  return {
    id: row.id,
    caseId: row.caseId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    itemKey: row.itemKey,
    phase: row.phase,
    title: row.title,
    description: row.description,
    owner: row.owner,
    status: row.status,
    dueDate: row.dueDate,
    verifiedByEmail: row.verifiedByEmail,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    recurrence: toRecurrenceDto(row.recurrence),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Rejects malformed template items before any write (fail-closed, never guessed). */
function validateTemplateItems(items: readonly AdmissionsTemplateItemSeed[]): void {
  const seenKeys = new Set<string>();
  for (const item of items) {
    if (!ITEM_KEY_PATTERN.test(item.itemKey)) {
      throw new Error(`Invalid template itemKey: "${String(item.itemKey)}" (expected snake_case)`);
    }
    if (seenKeys.has(item.itemKey)) {
      throw new Error(`Duplicate template itemKey: "${item.itemKey}"`);
    }
    seenKeys.add(item.itemKey);
    if (!item.title.trim()) {
      throw new Error(`Template item "${item.itemKey}" requires a title`);
    }
    if (!isAdmissionsPhaseKey(item.phase)) {
      throw new Error(`Invalid template item phase: "${String(item.phase)}"`);
    }
    if (!ADMISSIONS_ASSIGNABLE_TASK_OWNERS.includes(item.defaultOwner as "student" | "counselor")) {
      throw new Error(`Invalid template item owner: "${String(item.defaultOwner)}"`);
    }
    if (!Number.isInteger(item.sortOrder) || item.sortOrder < 0) {
      throw new Error(`Template item "${item.itemKey}" requires a non-negative integer sortOrder`);
    }
  }
}

/**
 * Loads a live task scoped to (taskId, caseId, not soft-deleted). The caseId
 * scope stops cross-case taskId probing; a miss throws "NotFound".
 */
async function findLiveTask(
  db: AdmissionsWriteDb,
  taskId: string,
  caseId: string,
  lockForUpdate = false,
): Promise<CaseTaskRow> {
  const query = db
    .select()
    .from(admissionsCaseTasks)
    .where(and(
      eq(admissionsCaseTasks.id, taskId),
      eq(admissionsCaseTasks.caseId, caseId),
      isNull(admissionsCaseTasks.deletedAt),
    ))
    .limit(1);
  const rows = lockForUpdate ? await query.for("update") : await query;
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

// ── Template versioning (CM-20) ─────────────────────────────────────────

/** Display name stamped on templates created by seedDefaultTemplate. */
export const DEFAULT_TEMPLATE_NAME = "SummitEd default checklist";

/**
 * Creates a new checklist-template version for a cohort (CM-20). This is the
 * ONLY way to change a cohort's checklist: published versions are immutable,
 * so "editing" always lands here and produces version = max + 1. The version
 * write, its items, and the audit row commit atomically.
 *
 * 1. Shape-check cohortId (NotFound on malformed) and validate every item
 *    (snake_case unique itemKey, non-empty title, canonical phase key, valid
 *    owner, non-negative integer sortOrder) before any write.
 * 2. Verify the cohort exists (NotFound), read the current max version, and
 *    insert the template row as version max + 1 — draft by default,
 *    published immediately when `options.publish` is set. A concurrent
 *    same-version insert is rejected by the (cohortId, version) unique index.
 * 3. Bulk-insert the items and write one audit row (entityType
 *    "checklist_template", caseId null — cohort-scoped action).
 *
 * @returns the created template version with its items.
 */
export async function createTemplateVersion(
  cohortId: string,
  items: readonly AdmissionsTemplateItemSeed[],
  actor: AdmissionsActor,
  options: { name?: string; publish?: boolean } = {},
  db: Database = getDb(),
): Promise<AdmissionsTemplateDto> {
  if (!isUuidShaped(cohortId)) throw new Error("NotFound");
  if (items.length === 0) throw new Error("Template requires at least one item");
  validateTemplateItems(items);

  return withAuditedTransaction(async (tx) => {
    const cohortRows = await tx
      .select({ id: admissionsCohorts.id })
      .from(admissionsCohorts)
      .where(eq(admissionsCohorts.id, cohortId))
      .limit(1);
    if (cohortRows.length === 0) throw new Error("NotFound");

    const latestRows = await tx
      .select({ version: admissionsChecklistTemplates.version })
      .from(admissionsChecklistTemplates)
      .where(eq(admissionsChecklistTemplates.cohortId, cohortId))
      .orderBy(desc(admissionsChecklistTemplates.version))
      .limit(1);
    const version = (latestRows[0]?.version ?? 0) + 1;

    const now = new Date();
    const templateRows = await tx
      .insert(admissionsChecklistTemplates)
      .values({
        cohortId,
        version,
        name: options.name?.trim() || `Checklist v${version}`,
        publishedAt: options.publish ? now : null,
      })
      .returning();
    const template = templateRows[0];
    if (!template) throw new Error("Template insert returned no row");

    const itemRows = await tx
      .insert(admissionsTemplateItems)
      .values(items.map((item) => ({
        templateId: template.id,
        itemKey: item.itemKey,
        phase: item.phase,
        title: item.title,
        description: item.description,
        defaultOwner: item.defaultOwner,
        sortOrder: item.sortOrder,
      })))
      .returning();

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "checklist_template",
      entityId: template.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        {
          cohortId,
          version,
          itemCount: items.length,
          publishedAt: template.publishedAt ? template.publishedAt.toISOString() : null,
        },
        ["cohortId", "version", "itemCount", "publishedAt"],
      ),
    });

    return toTemplateDto(template, itemRows);
  }, db);
}

/**
 * Publishes a draft template version, making it immutable and eligible for
 * instantiation (CM-20). Audited.
 *
 * 1. Shape-check templateId; load the template (miss → NotFound).
 * 2. Already published → Error("Conflict") — published versions never change.
 * 3. Stamp publishedAt and write the audit row atomically.
 *
 * @returns the published template with its items.
 */
export async function publishTemplate(
  templateId: string,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsTemplateDto> {
  if (!isUuidShaped(templateId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const templateRows = await tx
      .select()
      .from(admissionsChecklistTemplates)
      .where(eq(admissionsChecklistTemplates.id, templateId))
      .limit(1);
    const template = templateRows[0];
    if (!template) throw new Error("NotFound");
    if (template.publishedAt !== null) throw new Error("Conflict");

    const itemRows = await tx
      .select()
      .from(admissionsTemplateItems)
      .where(eq(admissionsTemplateItems.templateId, templateId))
      .orderBy(asc(admissionsTemplateItems.sortOrder), asc(admissionsTemplateItems.itemKey));

    const now = nextMutationTimestamp(template.updatedAt);
    await tx
      .update(admissionsChecklistTemplates)
      .set({ publishedAt: now, updatedAt: now })
      .where(eq(admissionsChecklistTemplates.id, templateId));

    await writeAuditLog(tx, {
      caseId: null,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "checklist_template",
      entityId: templateId,
      action: "publish",
      diff: computeFieldDiff(
        { publishedAt: null },
        { publishedAt: now.toISOString() },
        ["publishedAt"],
      ),
    });

    return toTemplateDto({ ...template, publishedAt: now, updatedAt: now }, itemRows);
  }, db);
}

/**
 * The latest template version for a cohort (highest version number), with
 * items sorted by sortOrder. `publishedOnly` restricts to published versions
 * — the variant instantiation uses. Null when the cohort has no (matching)
 * template; a malformed cohortId fails closed to null.
 */
export async function getLatestTemplate(
  cohortId: string,
  options: { publishedOnly?: boolean } = {},
  db: Database = getDb(),
): Promise<AdmissionsTemplateDto | null> {
  if (!isUuidShaped(cohortId)) return null;

  const templateRows = await db
    .select()
    .from(admissionsChecklistTemplates)
    .where(and(
      eq(admissionsChecklistTemplates.cohortId, cohortId),
      ...(options.publishedOnly ? [isNotNull(admissionsChecklistTemplates.publishedAt)] : []),
    ))
    .orderBy(desc(admissionsChecklistTemplates.version))
    .limit(1);
  const template = templateRows[0];
  if (!template) return null;

  const itemRows = await db
    .select()
    .from(admissionsTemplateItems)
    .where(eq(admissionsTemplateItems.templateId, template.id))
    .orderBy(asc(admissionsTemplateItems.sortOrder), asc(admissionsTemplateItems.itemKey));

  return toTemplateDto(template, itemRows);
}

/** Lightweight template-version metadata (no items) for the admin version list. */
export interface AdmissionsTemplateVersionDto {
  id: string;
  cohortId: string;
  version: number;
  name: string;
  /** ISO publish instant; null while the version is a draft. */
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * All checklist-template versions for a cohort, newest first, WITHOUT items —
 * the cohort template admin view's version history (design §4). A malformed
 * cohortId fails closed to an empty list.
 */
export async function listTemplateVersions(
  cohortId: string,
  db: Database = getDb(),
): Promise<AdmissionsTemplateVersionDto[]> {
  if (!isUuidShaped(cohortId)) return [];

  const rows = await db
    .select()
    .from(admissionsChecklistTemplates)
    .where(eq(admissionsChecklistTemplates.cohortId, cohortId))
    .orderBy(desc(admissionsChecklistTemplates.version));
  return rows.map((row) => ({
    id: row.id,
    cohortId: row.cohortId,
    version: row.version,
    name: row.name,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Returns true when the cohort has at least one PUBLISHED checklist-template
 * version — the precondition for instantiateChecklist to copy anything.
 * Cheap existence probe (no item fetch) for the case-creation path; a
 * malformed cohortId fails closed to false.
 */
export async function hasPublishedTemplate(
  cohortId: string,
  db: Database = getDb(),
): Promise<boolean> {
  if (!isUuidShaped(cohortId)) return false;

  const rows = await db
    .select({ id: admissionsChecklistTemplates.id })
    .from(admissionsChecklistTemplates)
    .where(and(
      eq(admissionsChecklistTemplates.cohortId, cohortId),
      isNotNull(admissionsChecklistTemplates.publishedAt),
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Seeds a cohort with the default SummitEd 10-phase checklist (CM-20):
 * creates version max + 1 from DEFAULT_CHECKLIST_ITEMS and publishes it
 * immediately (one transaction), so newly created cases instantiate it
 * right away.
 *
 * @returns the published default template with its items.
 */
export async function seedDefaultTemplate(
  cohortId: string,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsTemplateDto> {
  return createTemplateVersion(
    cohortId,
    DEFAULT_CHECKLIST_ITEMS,
    actor,
    { name: DEFAULT_TEMPLATE_NAME, publish: true },
    db,
  );
}

// ── Instantiation & push-new-items (CM-21) ──────────────────────────────

/** instantiateChecklist result — which template was copied and how many tasks. */
export interface InstantiateChecklistResult {
  /** Null when the cohort has no published template (case starts with no tasks). */
  templateId: string | null;
  templateVersion: number | null;
  taskCount: number;
}

/**
 * Copies the cohort's latest PUBLISHED template items into
 * admissions_case_tasks for a case (CM-21 snapshot semantics). Every created
 * task is stamped with (templateId, templateVersion, itemKey) so later
 * template versions never mutate it and push-new-items can diff by itemKey.
 *
 * Designed to run INSIDE the caller's audited transaction (createCase passes
 * its tx); with the default db it executes non-transactionally. When `actor`
 * is provided, one audit row (entityType "checklist", action "instantiate")
 * records the copy; createCase's own audit rows otherwise cover attribution.
 *
 * 1. Shape-check ids (NotFound on malformed).
 * 2. Resolve the latest published template; none → zero-task result (a
 *    cohort without a published template is not an error at case creation).
 * 3. Bulk-insert one task per item: owner = defaultOwner, status
 *    "not_started", phase/title/description/sortOrder copied verbatim.
 *
 * @returns the copied template's id/version and the number of tasks created.
 */
export async function instantiateChecklist(
  caseId: string,
  cohortId: string,
  db: AdmissionsWriteDb = getDb(),
  actor?: AdmissionsActor,
): Promise<InstantiateChecklistResult> {
  if (!isUuidShaped(caseId) || !isUuidShaped(cohortId)) throw new Error("NotFound");

  const templateRows = await db
    .select()
    .from(admissionsChecklistTemplates)
    .where(and(
      eq(admissionsChecklistTemplates.cohortId, cohortId),
      isNotNull(admissionsChecklistTemplates.publishedAt),
    ))
    .orderBy(desc(admissionsChecklistTemplates.version))
    .limit(1);
  const template = templateRows[0];
  if (!template) return { templateId: null, templateVersion: null, taskCount: 0 };

  const itemRows = await db
    .select()
    .from(admissionsTemplateItems)
    .where(eq(admissionsTemplateItems.templateId, template.id))
    .orderBy(asc(admissionsTemplateItems.sortOrder), asc(admissionsTemplateItems.itemKey));
  if (itemRows.length === 0) {
    return { templateId: template.id, templateVersion: template.version, taskCount: 0 };
  }

  await db.insert(admissionsCaseTasks).values(itemRows.map((item) => ({
    caseId,
    templateId: template.id,
    templateVersion: template.version,
    itemKey: item.itemKey,
    phase: item.phase,
    title: item.title,
    description: item.description,
    owner: item.defaultOwner,
    status: "not_started" as const,
    sortOrder: item.sortOrder,
  })));

  if (actor) {
    await writeAuditLog(db, {
      caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "checklist",
      entityId: caseId,
      action: "instantiate",
      diff: {
        templateId: { old: null, new: template.id },
        templateVersion: { old: null, new: template.version },
        taskCount: { old: null, new: itemRows.length },
      },
    });
  }

  return { templateId: template.id, templateVersion: template.version, taskCount: itemRows.length };
}

/** pushNewItemsToCohortCases result — append summary across the cohort. */
export interface PushNewItemsResult {
  templateId: string;
  templateVersion: number;
  casesUpdated: number;
  tasksCreated: number;
}

/**
 * Explicit admin action (CM-21): appends the latest published template's
 * items to every live case in the cohort that is missing them (matched by
 * itemKey). Existing task rows are NEVER mutated or deleted — statuses, due
 * dates, verification, and edits all survive. Audited per updated case.
 *
 * 1. Shape-check cohortId; resolve the latest published template (none →
 *    NotFound — there is nothing to push).
 * 2. Load the cohort's live cases (status active/committed, not
 *    soft-deleted) and every existing task itemKey per case. Soft-deleted
 *    task rows still count as "existing" so a push never resurrects a key.
 * 3. Per case, bulk-insert only the missing items — stamped with the NEW
 *    template id/version — and write one audit row (entityType "checklist",
 *    action "push_new_items") listing the appended itemKeys.
 *
 * @returns the pushed template id/version plus cases-updated/tasks-created counts.
 */
export async function pushNewItemsToCohortCases(
  cohortId: string,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<PushNewItemsResult> {
  if (!isUuidShaped(cohortId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const templateRows = await tx
      .select()
      .from(admissionsChecklistTemplates)
      .where(and(
        eq(admissionsChecklistTemplates.cohortId, cohortId),
        isNotNull(admissionsChecklistTemplates.publishedAt),
      ))
      .orderBy(desc(admissionsChecklistTemplates.version))
      .limit(1);
    const template = templateRows[0];
    if (!template) throw new Error("NotFound");

    const result: PushNewItemsResult = {
      templateId: template.id,
      templateVersion: template.version,
      casesUpdated: 0,
      tasksCreated: 0,
    };

    const itemRows = await tx
      .select()
      .from(admissionsTemplateItems)
      .where(eq(admissionsTemplateItems.templateId, template.id))
      .orderBy(asc(admissionsTemplateItems.sortOrder), asc(admissionsTemplateItems.itemKey));
    if (itemRows.length === 0) return result;

    const caseRows = await tx
      .select({ id: admissionsCases.id })
      .from(admissionsCases)
      .where(and(
        eq(admissionsCases.cohortId, cohortId),
        inArray(admissionsCases.status, ["active", "committed"]),
        isNull(admissionsCases.deletedAt),
      ));
    if (caseRows.length === 0) return result;
    const caseIds = caseRows.map((row) => row.id);

    const existingRows = await tx
      .select({
        caseId: admissionsCaseTasks.caseId,
        itemKey: admissionsCaseTasks.itemKey,
      })
      .from(admissionsCaseTasks)
      .where(and(
        inArray(admissionsCaseTasks.caseId, caseIds),
        isNotNull(admissionsCaseTasks.itemKey),
      ));
    const keysByCase = new Map<string, Set<string>>();
    for (const row of existingRows) {
      if (row.itemKey === null) continue;
      const keys = keysByCase.get(row.caseId);
      if (keys) keys.add(row.itemKey);
      else keysByCase.set(row.caseId, new Set([row.itemKey]));
    }

    for (const caseId of caseIds) {
      const existingKeys = keysByCase.get(caseId);
      const missing = itemRows.filter((item) => !existingKeys?.has(item.itemKey));
      if (missing.length === 0) continue;

      await tx.insert(admissionsCaseTasks).values(missing.map((item) => ({
        caseId,
        templateId: template.id,
        templateVersion: template.version,
        itemKey: item.itemKey,
        phase: item.phase,
        title: item.title,
        description: item.description,
        owner: item.defaultOwner,
        status: "not_started" as const,
        sortOrder: item.sortOrder,
      })));

      await writeAuditLog(tx, {
        caseId,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: "checklist",
        entityId: caseId,
        action: "push_new_items",
        diff: {
          templateVersion: { old: null, new: template.version },
          appendedItemKeys: { old: null, new: missing.map((item) => item.itemKey) },
        },
      });

      result.casesUpdated += 1;
      result.tasksCreated += missing.length;
    }

    return result;
  }, db);
}

// ── Task operations (CM-22 / CM-23) ─────────────────────────────────────

/** updateTaskStatus input; `access` must come from requireCaseAccess. */
export interface UpdateTaskStatusInput {
  access: CaseAccess;
  taskId: string;
  status: AdmissionsTaskStatus;
}

/**
 * Updates a task's status (CM-22 "tick"). Students may update ONLY tasks
 * owned by "student" on their own case (the CaseAccess caseId scopes every
 * query); counselors and admins may update any task; parents are view-only.
 *
 * 1. Validate the status and the caller's role (parent → Forbidden);
 *    shape-check taskId.
 * 2. Load the live task scoped to the access's case (miss → NotFound); a
 *    student caller on a non-student-owned task → Forbidden.
 * 3. Lock the task row and treat same status as a no-op (idempotent toggle,
 *    no writes).
 * 4. Apply the status; leaving "done" clears any counselor verification
 *    (fail-closed — a re-opened task is no longer verified).
 * 5. Persist the status and append its audit entry in one transaction. An
 *    audit failure rolls the status change back.
 *
 * @returns the updated task DTO.
 */
export async function updateTaskStatus(
  input: UpdateTaskStatusInput,
  db: Database = getDb(),
): Promise<AdmissionsTaskDto> {
  if (!ADMISSIONS_TASK_STATUSES.includes(input.status)) {
    throw new Error(`Invalid task status: ${String(input.status)}`);
  }
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.taskId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveTask(tx, input.taskId, input.access.caseId, true);
    if (input.access.role === "student" && row.owner !== "student") {
      throw new Error("Forbidden");
    }
    if (row.status === input.status) return toTaskDto(row);

    const now = nextMutationTimestamp(row.updatedAt);
    const clearsVerification = input.status !== "done" && row.verifiedAt !== null;
    const setValues = {
      status: input.status,
      updatedAt: now,
      ...(clearsVerification ? { verifiedByEmail: null, verifiedAt: null } : {}),
    };
    await tx
      .update(admissionsCaseTasks)
      .set(setValues)
      .where(eq(admissionsCaseTasks.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "task",
      entityId: row.id,
      action: "status_change",
      diff: computeFieldDiff(
        {
          status: row.status,
          verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        },
        {
          status: input.status,
          ...(clearsVerification ? { verifiedAt: null } : {}),
        },
        ["status", "verifiedAt"],
      ),
    });

    return toTaskDto({ ...row, ...setValues });
  }, db);
}

/** setTaskVerified input; `access` must come from requireCaseAccess. */
export interface SetTaskVerifiedInput {
  access: CaseAccess;
  taskId: string;
  verified: boolean;
  /** Optimistic-concurrency token (task updatedAt ISO). */
  expectedUpdatedAt: string;
}

/**
 * Sets or clears the counselor verification stamp on a student-owned task
 * (CM-22). Counselor+ only; verification on a non-student-owned or non-done
 * task is a Conflict (the flag exists only for completed student self-report
 * items). The locked, token-checked write and its audit row commit atomically.
 *
 * @returns the updated task DTO (no-op when already in the requested state).
 */
export async function setTaskVerified(
  input: SetTaskVerifiedInput,
  db: Database = getDb(),
): Promise<AdmissionsTaskDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.taskId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveTask(tx, input.taskId, input.access.caseId, true);
    if (input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");
    if (row.owner !== "student") throw new Error("Conflict");
    if (input.verified && row.status !== "done") throw new Error("Conflict");

    const isVerified = row.verifiedAt !== null;
    if (isVerified === input.verified) return toTaskDto(row);

    const now = nextMutationTimestamp(row.updatedAt);
    const setValues = input.verified
      ? { verifiedByEmail: input.access.email, verifiedAt: now, updatedAt: now }
      : { verifiedByEmail: null, verifiedAt: null, updatedAt: now };
    const updatedRows = await tx
      .update(admissionsCaseTasks)
      .set(setValues)
      .where(and(
        eq(admissionsCaseTasks.id, row.id),
        eq(admissionsCaseTasks.updatedAt, row.updatedAt),
        isNull(admissionsCaseTasks.deletedAt),
        ...(input.verified ? [eq(admissionsCaseTasks.status, "done")] : []),
      ))
      .returning({ id: admissionsCaseTasks.id });
    if (!updatedRows[0]) throw new Error("Conflict");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "task",
      entityId: row.id,
      action: input.verified ? "verify" : "unverify",
      diff: computeFieldDiff(
        {
          verifiedByEmail: row.verifiedByEmail,
          verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        },
        {
          verifiedByEmail: setValues.verifiedByEmail,
          verifiedAt: setValues.verifiedAt ? setValues.verifiedAt.toISOString() : null,
        },
        ["verifiedByEmail", "verifiedAt"],
      ),
    });

    return toTaskDto({ ...row, ...setValues });
  }, db);
}

/** createCustomTask input; `access` must come from requireCaseAccess. */
export interface CreateCustomTaskInput {
  access: CaseAccess;
  title: string;
  description?: string | null;
  owner: AdmissionsTaskOwner;
  /** A canonical phase key or "custom" (default) — never guessed. */
  phase?: string;
  dueDate?: string | null;
  recurrence?: AdmissionsTaskRecurrence | null;
  sortOrder?: number;
}

/**
 * Creates a counselor custom task on a case (CM-23). Custom tasks carry a
 * null itemKey/templateId (no template linkage) so they remain deletable and
 * are ignored by push-new-items. Optional simple recurrence (weekly/biweekly
 * with an end date) is validated strictly and stored on the row. Counselor+
 * only; the insert and its audit row commit atomically.
 *
 * @returns the created task DTO.
 */
export async function createCustomTask(
  input: CreateCustomTaskInput,
  db: Database = getDb(),
): Promise<AdmissionsTaskDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");

  const title = input.title.trim();
  if (!title) throw new Error("Task title must not be empty");
  if (!ADMISSIONS_ASSIGNABLE_TASK_OWNERS.includes(input.owner as "student" | "counselor")) {
    throw new Error(`Invalid task owner: ${String(input.owner)}`);
  }
  const phase = input.phase ?? MEETING_ACTION_ITEM_PHASE;
  if (phase !== MEETING_ACTION_ITEM_PHASE && !isAdmissionsPhaseKey(phase)) {
    throw new Error(`Invalid task phase: "${phase}"`);
  }
  if (input.dueDate != null) assertDateOnly(input.dueDate, "dueDate");
  const recurrence = parseRecurrenceInput(input.recurrence);
  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new Error("Task sortOrder must be a non-negative integer");
  }

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .insert(admissionsCaseTasks)
      .values({
        caseId: input.access.caseId,
        templateId: null,
        templateVersion: null,
        itemKey: null,
        phase,
        title,
        description: input.description ?? null,
        owner: input.owner,
        status: "not_started",
        dueDate: input.dueDate ?? null,
        recurrence,
        sortOrder,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Task insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "task",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        { title, owner: input.owner, phase, dueDate: input.dueDate ?? null, recurrence },
        ["title", "owner", "phase", "dueDate", "recurrence"],
      ),
    });

    return toTaskDto(row);
  }, db);
}

/** updateTask input — undefined fields are left untouched. */
export interface UpdateTaskInput {
  access: CaseAccess;
  taskId: string;
  /** Optimistic-concurrency token (task updatedAt ISO). */
  expectedUpdatedAt: string;
  title?: string;
  description?: string | null;
  owner?: AdmissionsTaskOwner;
  dueDate?: string | null;
  recurrence?: AdmissionsTaskRecurrence | null;
  sortOrder?: number;
}

const TASK_DIFF_FIELDS = [
  "title",
  "description",
  "owner",
  "dueDate",
  "recurrence",
  "sortOrder",
] as const;

/**
 * Partially updates a task's editable fields (CM-22/CM-23): title,
 * description, owner, dueDate, recurrence, sortOrder. Counselor+ only
 * (recurrence stays counselor-only by construction). Status changes go
 * through updateTaskStatus; verification through setTaskVerified. The
 * mutation and its audit diff commit atomically.
 *
 * 1. Validate provided fields up front (non-empty title, known owner,
 *    "YYYY-MM-DD" dueDate, strict recurrence shape, integer sortOrder).
 * 2. Load the live task scoped to the access's case (miss → NotFound).
 * 3. Diff only the provided fields; nothing changed → no-op without writes.
 * 4. Apply the changed fields plus a fresh updatedAt and audit the diff.
 *
 * @returns the updated task DTO.
 */
export async function updateTask(
  input: UpdateTaskInput,
  db: Database = getDb(),
): Promise<AdmissionsTaskDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.taskId)) throw new Error("NotFound");

  let title: string | undefined;
  if (input.title !== undefined) {
    title = input.title.trim();
    if (!title) throw new Error("Task title must not be empty");
  }
  if (input.owner !== undefined && !ADMISSIONS_ASSIGNABLE_TASK_OWNERS.includes(input.owner as "student" | "counselor")) {
    throw new Error(`Invalid task owner: ${String(input.owner)}`);
  }
  if (input.dueDate != null) assertDateOnly(input.dueDate, "dueDate");
  const recurrence = input.recurrence === undefined
    ? undefined
    : parseRecurrenceInput(input.recurrence);
  if (input.sortOrder !== undefined && (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)) {
    throw new Error("Task sortOrder must be a non-negative integer");
  }

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveTask(tx, input.taskId, input.access.caseId, true);
    if (input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      {
        title,
        description: input.description,
        owner: input.owner,
        dueDate: input.dueDate,
        recurrence,
        sortOrder: input.sortOrder,
      },
      TASK_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toTaskDto(row);

    const setValues: Partial<typeof admissionsCaseTasks.$inferInsert> = {
      updatedAt: nextMutationTimestamp(row.updatedAt),
    };
    if ("title" in diff) setValues.title = title;
    if ("description" in diff) setValues.description = input.description;
    if ("owner" in diff) setValues.owner = input.owner;
    if ("dueDate" in diff) setValues.dueDate = input.dueDate;
    if ("recurrence" in diff) setValues.recurrence = recurrence;
    if ("sortOrder" in diff) setValues.sortOrder = input.sortOrder;

    const updatedRows = await tx
      .update(admissionsCaseTasks)
      .set(setValues)
      .where(and(
        eq(admissionsCaseTasks.id, row.id),
        eq(admissionsCaseTasks.updatedAt, row.updatedAt),
        isNull(admissionsCaseTasks.deletedAt),
      ))
      .returning({ id: admissionsCaseTasks.id });
    if (!updatedRows[0]) throw new Error("Conflict");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "task",
      entityId: row.id,
      action: "update",
      diff,
    });

    return toTaskDto({ ...row, ...setValues } as CaseTaskRow);
  }, db);
}

/** softDeleteTask input; `access` must come from requireCaseAccess. */
export interface SoftDeleteTaskInput {
  access: CaseAccess;
  taskId: string;
  /** Optimistic-concurrency token (task updatedAt ISO). */
  expectedUpdatedAt: string;
}

/**
 * Soft-deletes a CUSTOM task (null itemKey). Template-derived tasks are part
 * of the cohort's snapshot contract and can never be deleted —
 * Error("Conflict") (CM-21 snapshot semantics; progress % stays comparable
 * across a cohort). Counselor+ only; audited atomically.
 */
export async function softDeleteTask(
  input: SoftDeleteTaskInput,
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.taskId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveTask(tx, input.taskId, input.access.caseId, true);
    if (input.expectedUpdatedAt !== row.updatedAt.toISOString()) throw new Error("Conflict");
    if (row.itemKey !== null) throw new Error("Conflict");

    const now = nextMutationTimestamp(row.updatedAt);
    const updatedRows = await tx
      .update(admissionsCaseTasks)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(
        eq(admissionsCaseTasks.id, row.id),
        eq(admissionsCaseTasks.updatedAt, row.updatedAt),
        isNull(admissionsCaseTasks.deletedAt),
      ))
      .returning({ id: admissionsCaseTasks.id });
    if (!updatedRows[0]) throw new Error("Conflict");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "task",
      entityId: row.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

/**
 * A case's live (non-deleted) tasks sorted by sortOrder then creation time —
 * the checklist tab's read. Malformed caseId fails closed to an empty list.
 */
export async function listCaseTasks(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsTaskDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const rows = await db
    .select()
    .from(admissionsCaseTasks)
    .where(and(
      eq(admissionsCaseTasks.caseId, caseId),
      isNull(admissionsCaseTasks.deletedAt),
    ))
    .orderBy(asc(admissionsCaseTasks.sortOrder), asc(admissionsCaseTasks.createdAt));
  return rows.map(toTaskDto);
}

// ── Progress (CM-24) ────────────────────────────────────────────────────

/**
 * Pure progress math (CM-24): done counts status "done"; percent is a 0–100
 * integer (0 for an empty checklist); verifiedCount counts counselor
 * verification stamps and is surfaced separately from done.
 */
export function computeProgressCounts(
  rows: ReadonlyArray<{ status: string; verifiedAt: Date | null }>,
): AdmissionsChecklistProgress {
  const total = rows.length;
  let done = 0;
  let verifiedCount = 0;
  for (const row of rows) {
    if (row.status === "done") done += 1;
    if (row.verifiedAt !== null) verifiedCount += 1;
  }
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    verifiedCount,
  };
}

/**
 * Checklist progress for one case (CM-24), over live (non-deleted) tasks.
 * Malformed caseId fails closed to the zero rollup.
 */
export async function computeProgress(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsChecklistProgress> {
  if (!isUuidShaped(caseId)) return { ...ZERO_PROGRESS };

  const rows = await db
    .select({
      status: admissionsCaseTasks.status,
      verifiedAt: admissionsCaseTasks.verifiedAt,
    })
    .from(admissionsCaseTasks)
    .where(and(
      eq(admissionsCaseTasks.caseId, caseId),
      isNull(admissionsCaseTasks.deletedAt),
    ));
  return computeProgressCounts(rows);
}

/**
 * Batch progress for caseload views (CM-24): one query across all requested
 * cases. Every requested caseId is seeded with the zero rollup so callers
 * never hit a missing key; empty input skips the query.
 *
 * @returns Map of caseId → progress rollup.
 */
export async function computeProgressMap(
  caseIds: readonly string[],
  db: Database = getDb(),
): Promise<Map<string, AdmissionsChecklistProgress>> {
  const progressByCase = new Map<string, AdmissionsChecklistProgress>();
  for (const caseId of caseIds) progressByCase.set(caseId, { ...ZERO_PROGRESS });
  if (caseIds.length === 0) return progressByCase;

  const rows = await db
    .select({
      caseId: admissionsCaseTasks.caseId,
      status: admissionsCaseTasks.status,
      verifiedAt: admissionsCaseTasks.verifiedAt,
    })
    .from(admissionsCaseTasks)
    .where(and(
      inArray(admissionsCaseTasks.caseId, [...caseIds]),
      isNull(admissionsCaseTasks.deletedAt),
    ));

  const rowsByCase = new Map<string, Array<{ status: string; verifiedAt: Date | null }>>();
  for (const row of rows) {
    const list = rowsByCase.get(row.caseId);
    if (list) list.push(row);
    else rowsByCase.set(row.caseId, [row]);
  }
  for (const [caseId, caseRows] of rowsByCase) {
    progressByCase.set(caseId, computeProgressCounts(caseRows));
  }
  return progressByCase;
}
