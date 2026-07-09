// Admissions Case Management — essay tracker rows, staleness, effective
// stage, and essay-deadline calendar collection.
//
// Design: docs/casemanagementsystem_design.md §1 (essays.ts module map row),
// §2.4 (write matrix: essay status is student self-report; counselor override
// is attributed via the audit actorRole), §3 (admissions_essays: staleness =
// now − lastStudentUpdateAt), §6 (expectedUpdatedAt optimistic concurrency).
// PRD CM-60..CM-63.
//
// Core rules:
// - CM-60: a row is prompt + optional linked college (listItemId soft-scoped
//   to the case's live college list) + status + deadline + Drive link.
//   Writing stays in Google Docs — driveUrl is a pointer, never content.
// - CM-61: staleness is derived at read time (whole days since
//   lastStudentUpdateAt; null when the student never touched the row).
// - CM-62: counselorStage is a SEPARATE counselor-confirmed field; staff
//   views read effectiveStage = counselorStage ?? status.
// - CM-63: the list sorts by deadline proximity × staleness (see the
//   listEssaysForCase JSDoc for the exact deterministic key).
// - §2.4 student writes: students may create rows and edit status / prompt /
//   driveUrl on any essay of their case; every student mutation stamps
//   lastStudentUpdateAt. counselorStage / deadline / listItemId are
//   counselor+ only. Parents never write. Counselor edits (including status
//   overrides) are attributed by audit actorRole and never stamp
//   lastStudentUpdateAt.
//
// Error contract (admissionsErrorResponse maps these): missing rows /
// malformed ids → Error("NotFound"); role violations → Error("Forbidden");
// expectedUpdatedAt mismatch → Error("Conflict"); input-shape violations
// throw descriptive Errors (routes' Zod schemas are the 400 boundary).

import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsCollegeListItems, admissionsEssays } from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import type { CalendarItem, CalendarWindow } from "./calendar";
import type { AdmissionsTaskOwner } from "./meetings";
import type { CaseAccess } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MS = 86_400_000;

/** Max prompt characters kept in a calendar title before "…" truncation. */
const ESSAY_TITLE_MAX_PROMPT_LENGTH = 80;

type EssayRow = typeof admissionsEssays.$inferSelect;

// ── Status union (mirrors pgEnum in schema.ts) ──────────────────────────

/** Essay progress stage (mirrors admissions_essay_status). */
export type AdmissionsEssayStatus =
  | "not_started"
  | "brainstorming"
  | "drafting"
  | "feedback"
  | "final";

/** All valid essay stages, for boundary validation. */
export const ADMISSIONS_ESSAY_STATUSES: readonly AdmissionsEssayStatus[] = [
  "not_started",
  "brainstorming",
  "drafting",
  "feedback",
  "final",
];

// ── DTOs ────────────────────────────────────────────────────────────────

/** One essay tracker row serialized for the Essays tab (CM-60). */
export interface AdmissionsEssayDto {
  id: string;
  caseId: string;
  /** Linked college list item (Common App/personal statement rows use null). */
  listItemId: string | null;
  prompt: string;
  /** Student-set stage (self-report surface, design §2.4). */
  status: AdmissionsEssayStatus;
  /** Counselor-confirmed stage; overrides `status` in staff views (CM-62). */
  counselorStage: AdmissionsEssayStatus | null;
  deadline: string | null;
  driveUrl: string | null;
  /** Last student mutation instant; null when the student never touched the row. */
  lastStudentUpdateAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One Essays-tab list row: DTO + derived staleness and effective stage. */
export interface AdmissionsEssayListRowDto extends AdmissionsEssayDto {
  /**
   * Whole days since lastStudentUpdateAt (CM-61 "updated N days ago");
   * null when the student never updated the row. Clamped at 0 for skew.
   */
  stalenessDays: number | null;
  /** counselorStage ?? status — the stage staff views trust (CM-62). */
  effectiveStage: AdmissionsEssayStatus;
}

// ── Internal helpers ────────────────────────────────────────────────────

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

function assertEssayStatus(value: string, field: string): void {
  if (!ADMISSIONS_ESSAY_STATUSES.includes(value as AdmissionsEssayStatus)) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
}

/** Trims a driveUrl input; empty-after-trim collapses to null. */
function normalizeDriveUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in calendar.ts / colleges.ts).
 */
function getBangkokDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function toEssayDto(row: EssayRow): AdmissionsEssayDto {
  return {
    id: row.id,
    caseId: row.caseId,
    listItemId: row.listItemId,
    prompt: row.prompt,
    status: row.status,
    counselorStage: row.counselorStage,
    deadline: row.deadline,
    driveUrl: row.driveUrl,
    lastStudentUpdateAt: row.lastStudentUpdateAt ? row.lastStudentUpdateAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Loads a live essay scoped to (essayId, caseId, not soft-deleted). The
 * caseId scope stops cross-case essayId probing; a miss throws "NotFound".
 */
async function findLiveEssay(
  db: AdmissionsWriteDb,
  essayId: string,
  caseId: string,
): Promise<EssayRow> {
  const rows = await db
    .select()
    .from(admissionsEssays)
    .where(and(
      eq(admissionsEssays.id, essayId),
      eq(admissionsEssays.caseId, caseId),
      isNull(admissionsEssays.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

/**
 * Asserts a listItemId references a live college list item of THIS case
 * (admissions_essays.listItemId is a soft reference — no FK — so the lib
 * layer enforces case scoping). A miss throws "NotFound".
 */
async function assertLiveListItem(
  db: AdmissionsWriteDb,
  listItemId: string,
  caseId: string,
): Promise<void> {
  const rows = await db
    .select({ id: admissionsCollegeListItems.id })
    .from(admissionsCollegeListItems)
    .where(and(
      eq(admissionsCollegeListItems.id, listItemId),
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    ))
    .limit(1);
  if (!rows[0]) throw new Error("NotFound");
}

// ── Create (CM-60) ──────────────────────────────────────────────────────

/** createEssay input; `access` must come from requireCaseAccess. */
export interface CreateEssayInput {
  access: CaseAccess;
  prompt: string;
  /** Optional linked college list item (must be a live item of the case). */
  listItemId?: string | null;
  deadline?: string | null;
  driveUrl?: string | null;
}

/**
 * Adds one essay tracker row (CM-60). Student AND counselor/admin may add
 * (design §2.4: essays are a self-report surface); parents never write. The
 * insert and its audit row commit atomically.
 *
 * 1. Role gate: student+ (parent → Forbidden). Validate prompt (non-empty
 *    after trim), deadline shape, and listItemId shape up front.
 * 2. When listItemId is provided, verify it references a live college list
 *    item of THIS case (soft reference — a miss throws NotFound).
 * 3. Insert with status "not_started" and no counselorStage. A STUDENT
 *    creation stamps lastStudentUpdateAt = now (it is a student touch, so a
 *    fresh row reads staleness 0); staff creations leave it null (staleness
 *    reads null until the student first touches the row).
 * 4. Audit (entityType "essay", action "create", actorRole = access.role —
 *    the §2.4 attribution).
 *
 * @returns the created essay DTO.
 */
export async function createEssay(
  input: CreateEssayInput,
  db: Database = getDb(),
): Promise<AdmissionsEssayDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Essay requires a non-empty prompt");
  if (input.deadline != null) assertDateOnly(input.deadline, "deadline");
  const listItemId = input.listItemId ?? null;
  if (listItemId !== null && !isUuidShaped(listItemId)) throw new Error("NotFound");
  const driveUrl = normalizeDriveUrl(input.driveUrl ?? null);

  return withAuditedTransaction(async (tx) => {
    if (listItemId !== null) {
      await assertLiveListItem(tx, listItemId, input.access.caseId);
    }

    const now = new Date();
    const insertedRows = await tx
      .insert(admissionsEssays)
      .values({
        caseId: input.access.caseId,
        listItemId,
        prompt,
        status: "not_started",
        counselorStage: null,
        deadline: input.deadline ?? null,
        driveUrl,
        lastStudentUpdateAt: input.access.role === "student" ? now : null,
      })
      .returning();
    const row = insertedRows[0];
    if (!row) throw new Error("Essay insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "essay",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        {
          prompt,
          listItemId,
          status: "not_started",
          deadline: input.deadline ?? null,
          driveUrl,
        },
        ["prompt", "listItemId", "status", "deadline", "driveUrl"],
      ),
    });

    return toEssayDto(row);
  }, db);
}

// ── Update (CM-60/62, design §2.4/§6) ───────────────────────────────────

/** updateEssay input — undefined fields are left untouched. */
export interface UpdateEssayInput {
  access: CaseAccess;
  essayId: string;
  /** Optimistic-concurrency token (essay updatedAt ISO); mismatch → Conflict. */
  expectedUpdatedAt?: string;
  /** Student-writable (design §2.4 self-report surface). */
  prompt?: string;
  /** Student-writable stage (CM-60). */
  status?: AdmissionsEssayStatus;
  /** Student-writable Drive link; null clears. */
  driveUrl?: string | null;
  /** Counselor+ only: confirmed stage override (CM-62); null clears. */
  counselorStage?: AdmissionsEssayStatus | null;
  /** Counselor+ only; null clears. */
  deadline?: string | null;
  /** Counselor+ only: relink to a live list item of the case; null unlinks. */
  listItemId?: string | null;
}

const ESSAY_DIFF_FIELDS = [
  "prompt",
  "status",
  "driveUrl",
  "counselorStage",
  "deadline",
  "listItemId",
] as const;

/**
 * Partially updates an essay row (CM-60/62). Write split per design §2.4:
 * students may set status / prompt / driveUrl on any essay of their case;
 * counselorStage / deadline / listItemId are counselor+ (a student providing
 * one → Forbidden). Counselors may set every field — an override of a
 * student field is attributed via the audit actorRole, never disguised. The
 * mutation and its field-level audit diff commit atomically.
 *
 * 1. Role gates + up-front validation (known stages, "YYYY-MM-DD" deadline,
 *    uuid-shaped listItemId, non-empty prompt when provided).
 * 2. Load the live essay scoped to the access's case (miss → NotFound); an
 *    expectedUpdatedAt mismatch → Error("Conflict") (design §6 — routes
 *    surface 409).
 * 3. Diff only the provided fields; nothing changed → no-op without writes
 *    (no lastStudentUpdateAt stamp either). A relink target is verified as a
 *    live list item of the case before writing.
 * 4. Apply the changed fields plus a fresh updatedAt. EVERY effective
 *    student write also stamps lastStudentUpdateAt = now (the CM-61
 *    staleness clock); staff writes never touch it. Audit the diff
 *    (lastStudentUpdateAt is derived bookkeeping and is not audited).
 *
 * @returns the updated essay DTO.
 */
export async function updateEssay(
  input: UpdateEssayInput,
  db: Database = getDb(),
): Promise<AdmissionsEssayDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.essayId)) throw new Error("NotFound");

  const isStaff = roleAtLeast(input.access.role, "counselor");
  if (
    !isStaff &&
    (input.counselorStage !== undefined ||
      input.deadline !== undefined ||
      input.listItemId !== undefined)
  ) {
    throw new Error("Forbidden");
  }

  if (input.status !== undefined) assertEssayStatus(input.status, "essay status");
  if (input.counselorStage != null) assertEssayStatus(input.counselorStage, "counselorStage");
  if (input.deadline != null) assertDateOnly(input.deadline, "deadline");
  if (input.listItemId != null && !isUuidShaped(input.listItemId)) throw new Error("NotFound");
  const prompt = input.prompt === undefined ? undefined : input.prompt.trim();
  if (prompt !== undefined && !prompt) throw new Error("Essay requires a non-empty prompt");
  const driveUrl = input.driveUrl === undefined ? undefined : normalizeDriveUrl(input.driveUrl);

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveEssay(tx, input.essayId, input.access.caseId);

    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== row.updatedAt.toISOString()
    ) {
      throw new Error("Conflict");
    }

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      {
        prompt,
        status: input.status,
        driveUrl,
        counselorStage: input.counselorStage,
        deadline: input.deadline,
        listItemId: input.listItemId,
      },
      ESSAY_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toEssayDto(row);

    if ("listItemId" in diff && input.listItemId != null) {
      await assertLiveListItem(tx, input.listItemId, input.access.caseId);
    }

    const now = new Date();
    const setValues: Partial<typeof admissionsEssays.$inferInsert> = {
      updatedAt: now,
    };
    if ("prompt" in diff) setValues.prompt = prompt;
    if ("status" in diff) setValues.status = input.status;
    if ("driveUrl" in diff) setValues.driveUrl = driveUrl;
    if ("counselorStage" in diff) setValues.counselorStage = input.counselorStage;
    if ("deadline" in diff) setValues.deadline = input.deadline;
    if ("listItemId" in diff) setValues.listItemId = input.listItemId;
    if (input.access.role === "student") setValues.lastStudentUpdateAt = now;

    await tx
      .update(admissionsEssays)
      .set(setValues)
      .where(eq(admissionsEssays.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "essay",
      entityId: row.id,
      action: "update",
      diff,
    });

    return toEssayDto({ ...row, ...setValues } as EssayRow);
  }, db);
}

// ── Soft delete ─────────────────────────────────────────────────────────

/** softDeleteEssay input; `access` must come from requireCaseAccess. */
export interface SoftDeleteEssayInput {
  access: CaseAccess;
  essayId: string;
}

/**
 * Soft-deletes an essay row (counselor+ — deleting tracker rows is staff
 * work, not self-report). The mutation and its audit row commit atomically;
 * the row stays queryable for the audit trail via deletedAt.
 */
export async function softDeleteEssay(
  input: SoftDeleteEssayInput,
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.essayId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveEssay(tx, input.essayId, input.access.caseId);

    const now = new Date();
    await tx
      .update(admissionsEssays)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsEssays.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "essay",
      entityId: row.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

// ── Read (CM-61/62/63) ──────────────────────────────────────────────────

/** listEssaysForCase options. */
export interface ListEssaysOptions {
  /** Staleness reference instant; defaults to the current time. */
  now?: Date;
}

/**
 * A case's live essay rows with derived staleness and effective stage,
 * sorted by CM-63's "deadline proximity × staleness" urgency.
 *
 * Derivations:
 * - stalenessDays = whole days between lastStudentUpdateAt and `now`
 *   (floored, clamped at 0); null when the student never updated the row
 *   (CM-61).
 * - effectiveStage = counselorStage ?? status (CM-62 — the counselor's
 *   confirmed stage overrides the student-set status in staff views).
 *
 * Sort key (most urgent first — the deterministic realization of CM-63,
 * "overdue/soonest-with-stale first"):
 * 1. Dated rows before undated rows (a deadline always outranks no deadline).
 * 2. Deadline ascending — overdue dates sort first automatically
 *    (longest-overdue at the top), then today, then the soonest future
 *    deadlines.
 * 3. Same-deadline (and undated) ties break by staleness DESCENDING, where
 *    a null stalenessDays (never student-updated) counts as most stale.
 * 4. Final tiebreak: id ascending (stable render).
 *
 * Malformed caseId fails closed to an empty list.
 *
 * @returns Essays-tab rows, most urgent first.
 */
export async function listEssaysForCase(
  caseId: string,
  options: ListEssaysOptions = {},
  db: Database = getDb(),
): Promise<AdmissionsEssayListRowDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const now = options.now ?? new Date();
  const rows = await db
    .select()
    .from(admissionsEssays)
    .where(and(
      eq(admissionsEssays.caseId, caseId),
      isNull(admissionsEssays.deletedAt),
    ))
    .orderBy(asc(admissionsEssays.deadline), asc(admissionsEssays.createdAt));

  return rows
    .map((row) => ({
      ...toEssayDto(row),
      stalenessDays: computeStalenessDays(row.lastStudentUpdateAt, now),
      effectiveStage: row.counselorStage ?? row.status,
    }))
    .sort(compareByDeadlineAndStaleness);
}

/**
 * Whole days elapsed since the student's last update (CM-61), floored and
 * clamped at 0 (clock skew never yields a negative badge); null when the
 * student never updated the row.
 */
function computeStalenessDays(lastStudentUpdateAt: Date | null, now: Date): number | null {
  if (lastStudentUpdateAt === null) return null;
  return Math.max(0, Math.floor((now.getTime() - lastStudentUpdateAt.getTime()) / DAY_IN_MS));
}

/** CM-63 comparator — see the listEssaysForCase JSDoc for the full key. */
function compareByDeadlineAndStaleness(
  a: Pick<AdmissionsEssayListRowDto, "id" | "deadline" | "stalenessDays">,
  b: Pick<AdmissionsEssayListRowDto, "id" | "deadline" | "stalenessDays">,
): number {
  const aDated = a.deadline !== null;
  const bDated = b.deadline !== null;
  if (aDated !== bDated) return aDated ? -1 : 1;
  if (a.deadline !== null && b.deadline !== null && a.deadline !== b.deadline) {
    return a.deadline < b.deadline ? -1 : 1;
  }
  const aStale = a.stalenessDays ?? Number.POSITIVE_INFINITY;
  const bStale = b.stalenessDays ?? Number.POSITIVE_INFINITY;
  if (aStale !== bStale) return aStale > bStale ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── Calendar collector (essay deadlines) ────────────────────────────────

/**
 * One essay-deadline entry in the calendar aggregator's collector contract
 * (design §8: one collector per dated-item source): a CalendarItem WITHOUT
 * `overdue` (the aggregator stamps it against today centrally) plus the
 * `completed` flag the aggregator uses to drop finished items from the
 * deadlines panel. This source is registered in calendar.ts's
 * CALENDAR_COLLECTORS (Phase 4).
 */
export interface EssayDeadlineEntry {
  /** Source row id (the admissions_essays id). */
  id: string;
  caseId: string;
  source: "essay";
  title: string;
  /** The essay deadline, "YYYY-MM-DD". */
  date: string;
  /** Essays are the student's work (design §2.4 self-report surface). */
  ownerRole: AdmissionsTaskOwner;
  /** True when the essay no longer needs the deadline (effective stage "final"). */
  completed: boolean;
}

/**
 * Batch collector for essay deadlines (the calendar aggregator's collector
 * contract): every live essay with a deadline across the requested cases,
 * one query for the whole batch (keeps the cross-case caseload view at one
 * query per source, CM-101).
 *
 * Non-uuid-shaped caseIds are dropped (fail-closed skip); empty input
 * returns [] without a query. Rows with malformed stored deadlines are
 * skipped, never guessed. Entries are titled "Essay: {prompt}" (prompt
 * truncated to 80 chars with "…"), completed = effective stage
 * (counselorStage ?? status, CM-62) is "final", ownerRole "student". Entries
 * are NOT sorted or window-filtered — the aggregator owns both.
 */
export async function collectEssayDeadlineEntries(
  caseIds: readonly string[],
  db: Database = getDb(),
): Promise<EssayDeadlineEntry[]> {
  const validCaseIds = caseIds.filter((id) => isUuidShaped(id));
  if (validCaseIds.length === 0) return [];

  const rows = await db
    .select({
      id: admissionsEssays.id,
      caseId: admissionsEssays.caseId,
      prompt: admissionsEssays.prompt,
      status: admissionsEssays.status,
      counselorStage: admissionsEssays.counselorStage,
      deadline: admissionsEssays.deadline,
    })
    .from(admissionsEssays)
    .where(and(
      inArray(admissionsEssays.caseId, validCaseIds),
      isNull(admissionsEssays.deletedAt),
      isNotNull(admissionsEssays.deadline),
    ));

  const entries: EssayDeadlineEntry[] = [];
  for (const row of rows) {
    if (row.deadline === null || !DATE_ONLY_PATTERN.test(row.deadline)) continue;
    entries.push({
      id: row.id,
      caseId: row.caseId,
      source: "essay",
      title: buildEssayDeadlineTitle(row.prompt),
      date: row.deadline,
      ownerRole: "student",
      completed: (row.counselorStage ?? row.status) === "final",
    });
  }
  return entries;
}

/** "Essay: {prompt}", prompt truncated to 80 chars with a trailing "…". */
function buildEssayDeadlineTitle(prompt: string): string {
  const trimmed = prompt.trim();
  const clipped =
    trimmed.length > ESSAY_TITLE_MAX_PROMPT_LENGTH
      ? `${trimmed.slice(0, ESSAY_TITLE_MAX_PROMPT_LENGTH - 1)}…`
      : trimmed;
  return `Essay: ${clipped}`;
}

/**
 * CalendarItem-shaped row for essay deadlines (source "essay"). `completed`
 * mirrors the calendar module's internal collector contract (the aggregator
 * drops completed rows from the deadlines panel); `overdue` is pre-stamped
 * here.
 */
export interface EssayDeadlineItem extends Omit<CalendarItem, "source"> {
  source: "essay";
  /** True when the essay is past needing the deadline (effective stage "final"). */
  completed: boolean;
}

/**
 * Collects ONE case's essay deadlines for an inclusive window —
 * CalendarItem-shaped rows with source "essay" (mirrors
 * collectCollegeDeadlines).
 *
 * 1. Validate the window ("YYYY-MM-DD" bounds, from <= to); malformed caseId
 *    → NotFound. Rows with malformed stored deadlines are skipped
 *    (fail-closed).
 * 2. Live essays with a deadline inside [from, to] become one row each,
 *    titled "Essay: {prompt}" (truncated).
 * 3. completed = effective stage (counselorStage ?? status) is "final";
 *    overdue = open AND the deadline is strictly before today (Bangkok).
 *    ownerRole is "student" (essays are the student's work).
 *
 * @returns the window's deadline rows, earliest first (stable id tiebreak).
 */
export async function collectEssayDeadlines(
  caseId: string,
  window: CalendarWindow,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<EssayDeadlineItem[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  assertDateOnly(window.from, "from");
  assertDateOnly(window.to, "to");
  if (window.from > window.to) {
    throw new Error("Invalid calendar window: from must be on or before to");
  }

  const todayKey = getBangkokDateKey(now);
  const entries = await collectEssayDeadlineEntries([caseId], db);
  return entries
    .filter((entry) => entry.date >= window.from && entry.date <= window.to)
    .map((entry) => ({
      ...entry,
      overdue: !entry.completed && entry.date < todayKey,
    }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
