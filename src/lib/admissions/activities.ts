// Admissions Case Management — master activity list (CM-70), Common App
// top-10 ranking (CM-71), and per-platform variant blocks with HARD char
// limits.
//
// Design: docs/casemanagementsystem_design.md §2.4 (activities are a student
// self-report surface; counselor override is attributed via the audit
// actorRole), §3 (admissions_activities: commonApp/uc jsonb blocks — "Char
// limits enforced by Zod + UI counters"), §6 (expectedUpdatedAt optimistic
// concurrency). PRD CM-70..CM-72.
//
// Core rules:
// - CM-70: one master list per case, capped at
//   MAX_ACTIVE_ACTIVITIES_PER_CASE live rows. fullDescription is the
//   unlimited internal write-up; the platform variants are a Common App
//   block (position ≤50 / organization ≤100 / description ≤150 chars,
//   hrs/week 0–168, weeks/year 0–52, grade-level subset, participation
//   timing) and a UC block (description ≤350 chars, official UC category).
//   Limits are HARD — Zod rejects overflow; UI counters mirror the same
//   exported constants.
// - CM-71: setCommonAppRanks persists the student's "Common App top 10"
//   order — at most MAX_COMMON_APP_RANKED_ACTIVITIES ids, all live
//   activities of the case, ranks assigned 1..n in the given order, ranks
//   of unlisted activities cleared. Re-submitting the current order is a
//   no-op (no writes, no audit).
// - CM-72 (per-field copy-to-clipboard) is UI-only — no lib surface here.
// - §2.4 student writes: students OWN this list — create, edit, delete, and
//   rank are all student-writable on their case. Counselor/admin writes are
//   allowed everywhere and attributed via the audit actorRole, never
//   disguised. Parents never write.
//
// Error contract (admissionsErrorResponse maps these): missing rows /
// malformed ids / foreign rank ids → Error("NotFound"); role violations →
// Error("Forbidden"); expectedUpdatedAt mismatch and the cap overflow →
// Error("Conflict"); input-shape violations throw descriptive Errors
// (routes' Zod schemas are the 400 boundary).

import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Database } from "@/lib/db";
import { admissionsActivities } from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsFieldDiff,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { isUuidShaped } from "./members";
import type { CaseAccess } from "./types";

type ActivityRow = typeof admissionsActivities.$inferSelect;

// ── Hard limits (CM-70/71) — UI counters must mirror these ──────────────

/** Max live (non-deleted) activities per case (CM-70 "≤ ~20"). */
export const MAX_ACTIVE_ACTIVITIES_PER_CASE = 20;

/** Max activities in the Common App rank list (CM-71 "top 10"). */
export const MAX_COMMON_APP_RANKED_ACTIVITIES = 10;

/** Common App position/leadership hard char limit. */
export const COMMON_APP_POSITION_MAX_CHARS = 50;

/** Common App organization name hard char limit. */
export const COMMON_APP_ORGANIZATION_MAX_CHARS = 100;

/** Common App activity description hard char limit. */
export const COMMON_APP_DESCRIPTION_MAX_CHARS = 150;

/** Common App hours-per-week upper bound (a week has 168 hours). */
export const COMMON_APP_HOURS_PER_WEEK_MAX = 168;

/** Common App weeks-per-year upper bound. */
export const COMMON_APP_WEEKS_PER_YEAR_MAX = 52;

/** UC activity description hard char limit. */
export const UC_DESCRIPTION_MAX_CHARS = 350;

// ── Closed value lists ──────────────────────────────────────────────────

/** Common App grade-level participation options ("post" = post-graduate). */
export const ADMISSIONS_ACTIVITY_GRADES = ["9", "10", "11", "12", "post"] as const;

/** One Common App grade-level option. */
export type AdmissionsActivityGrade = (typeof ADMISSIONS_ACTIVITY_GRADES)[number];

/** Common App participation-timing options. */
export const ADMISSIONS_ACTIVITY_TIMINGS = ["school_year", "school_break", "all_year"] as const;

/** One Common App participation-timing option. */
export type AdmissionsActivityTiming = (typeof ADMISSIONS_ACTIVITY_TIMINGS)[number];

/**
 * The official UC application activity categories (UC "Activities & awards"
 * section), encoded as stable snake_case keys.
 */
export const UC_ACTIVITY_CATEGORIES = [
  "award_or_honor",
  "educational_prep_program",
  "extracurricular_activity",
  "other_coursework",
  "volunteering_community_service",
  "work_experience",
] as const;

/** One official UC activity category key. */
export type UcActivityCategory = (typeof UC_ACTIVITY_CATEGORIES)[number];

/** Display labels for the official UC categories (UI dropdown source). */
export const UC_ACTIVITY_CATEGORY_LABELS: Record<UcActivityCategory, string> = {
  award_or_honor: "Award or honor",
  educational_prep_program: "Educational preparation program",
  extracurricular_activity: "Extracurricular activity",
  other_coursework: "Other coursework",
  volunteering_community_service: "Volunteering / community service",
  work_experience: "Work experience",
};

// ── Zod blocks (module-scope, .safeParse only) ──────────────────────────

/**
 * Common App variant block stored in admissions_activities.common_app
 * (CM-70). Every field is optional — students fill drafts incrementally —
 * but each present field is HARD-capped; unknown keys are rejected
 * (strictObject). `grades` is a duplicate-free subset of
 * ADMISSIONS_ACTIVITY_GRADES.
 */
export const admissionsCommonAppBlockSchema = z.strictObject({
  position: z.string().max(COMMON_APP_POSITION_MAX_CHARS),
  organization: z.string().max(COMMON_APP_ORGANIZATION_MAX_CHARS),
  description: z.string().max(COMMON_APP_DESCRIPTION_MAX_CHARS),
  hrsWeek: z.number().min(0).max(COMMON_APP_HOURS_PER_WEEK_MAX),
  weeksYear: z.number().int().min(0).max(COMMON_APP_WEEKS_PER_YEAR_MAX),
  grades: z
    .array(z.enum(ADMISSIONS_ACTIVITY_GRADES))
    .refine((grades) => new Set(grades).size === grades.length, {
      message: "duplicate grade levels",
    }),
  timing: z.enum(ADMISSIONS_ACTIVITY_TIMINGS),
}).partial();

/** Parsed Common App block ({ position?, organization?, … }). */
export type AdmissionsCommonAppBlock = z.infer<typeof admissionsCommonAppBlockSchema>;

/**
 * UC variant block stored in admissions_activities.uc (CM-70): description
 * hard-capped at UC_DESCRIPTION_MAX_CHARS, category from the official UC
 * list. Fields optional (draft-friendly); unknown keys rejected.
 */
export const admissionsUcBlockSchema = z.strictObject({
  description: z.string().max(UC_DESCRIPTION_MAX_CHARS),
  category: z.enum(UC_ACTIVITY_CATEGORIES),
}).partial();

/** Parsed UC block ({ description?, category? }). */
export type AdmissionsUcBlock = z.infer<typeof admissionsUcBlockSchema>;

// ── DTO ─────────────────────────────────────────────────────────────────

/** One activity row serialized for the Activities tab (CM-70). */
export interface AdmissionsActivityDto {
  id: string;
  caseId: string;
  name: string;
  /** Unlimited internal write-up (never a platform field). */
  fullDescription: string | null;
  /** Common App variant block; null until the student fills it. */
  commonApp: AdmissionsCommonAppBlock | null;
  /** UC variant block; null until the student fills it. */
  uc: AdmissionsUcBlock | null;
  /** 1-based Common App top-10 rank (CM-71); null when unranked. */
  commonAppRank: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Validates a commonApp input block (undefined/null → null). Overflow or
 * unknown shape throws a descriptive Error — limits are hard, never trimmed
 * down silently.
 */
function parseCommonAppInput(
  value: AdmissionsCommonAppBlock | null | undefined,
): AdmissionsCommonAppBlock | null {
  if (value == null) return null;
  const parsed = admissionsCommonAppBlockSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid commonApp block: ${describeFirstIssue(parsed.error)}`);
  }
  return parsed.data;
}

/** Validates a uc input block (undefined/null → null); overflow throws. */
function parseUcInput(value: AdmissionsUcBlock | null | undefined): AdmissionsUcBlock | null {
  if (value == null) return null;
  const parsed = admissionsUcBlockSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid uc block: ${describeFirstIssue(parsed.error)}`);
  }
  return parsed.data;
}

/** "path: message" for the first Zod issue (descriptive, never bodies). */
function describeFirstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "malformed payload";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** Stored jsonb → typed block; malformed stored payloads read as null (fail-closed). */
function toCommonAppDto(value: unknown): AdmissionsCommonAppBlock | null {
  if (value == null) return null;
  const parsed = admissionsCommonAppBlockSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Stored jsonb → typed block; malformed stored payloads read as null (fail-closed). */
function toUcDto(value: unknown): AdmissionsUcBlock | null {
  if (value == null) return null;
  const parsed = admissionsUcBlockSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Trims fullDescription; empty-after-trim collapses to null. */
function normalizeFullDescription(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Asserts an explicit sortOrder input is a non-negative integer. */
function assertSortOrder(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Invalid sortOrder: expected a non-negative integer");
  }
}

function toActivityDto(row: ActivityRow): AdmissionsActivityDto {
  return {
    id: row.id,
    caseId: row.caseId,
    name: row.name,
    fullDescription: row.fullDescription,
    commonApp: toCommonAppDto(row.commonApp),
    uc: toUcDto(row.uc),
    commonAppRank: row.commonAppRank,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Loads a live activity scoped to (activityId, caseId, not soft-deleted).
 * The caseId scope stops cross-case id probing; a miss throws "NotFound".
 */
async function findLiveActivity(
  db: AdmissionsWriteDb,
  activityId: string,
  caseId: string,
): Promise<ActivityRow> {
  const rows = await db
    .select()
    .from(admissionsActivities)
    .where(and(
      eq(admissionsActivities.id, activityId),
      eq(admissionsActivities.caseId, caseId),
      isNull(admissionsActivities.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

// ── Create (CM-70) ──────────────────────────────────────────────────────

/** createActivity input; `access` must come from requireCaseAccess. */
export interface CreateActivityInput {
  access: CaseAccess;
  name: string;
  /** Unlimited internal description (CM-70). */
  fullDescription?: string | null;
  commonApp?: AdmissionsCommonAppBlock | null;
  uc?: AdmissionsUcBlock | null;
  /** Explicit master-list position; defaults to appending at the end. */
  sortOrder?: number;
}

/**
 * Adds one activity to the case's master list (CM-70). Students own this
 * list (design §2.4 self-report surface), so student AND counselor/admin
 * may add; parents never write. The insert and its audit row commit
 * atomically.
 *
 * 1. Role gate: student+ (parent → Forbidden). Validate name (non-empty
 *    after trim), platform blocks (hard char limits via Zod), and sortOrder
 *    up front — validation failures never touch the database.
 * 2. Count the case's live activities; at MAX_ACTIVE_ACTIVITIES_PER_CASE
 *    the create is refused with Error("Conflict") (CM-70 cap).
 * 3. Insert unranked (commonAppRank null — ranks are assigned only via
 *    setCommonAppRanks, CM-71), sortOrder defaulting to the live count
 *    (append).
 * 4. Audit (entityType "activity", action "create", actorRole = access.role
 *    — the §2.4 attribution).
 *
 * @returns the created activity DTO.
 */
export async function createActivity(
  input: CreateActivityInput,
  db: Database = getDb(),
): Promise<AdmissionsActivityDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");

  const name = input.name.trim();
  if (!name) throw new Error("Activity requires a non-empty name");
  const fullDescription = normalizeFullDescription(input.fullDescription ?? null);
  const commonApp = parseCommonAppInput(input.commonApp);
  const uc = parseUcInput(input.uc);
  if (input.sortOrder !== undefined) assertSortOrder(input.sortOrder);

  return withAuditedTransaction(async (tx) => {
    const countRows = await tx
      .select({ value: count() })
      .from(admissionsActivities)
      .where(and(
        eq(admissionsActivities.caseId, input.access.caseId),
        isNull(admissionsActivities.deletedAt),
      ));
    const liveCount = countRows[0]?.value ?? 0;
    if (liveCount >= MAX_ACTIVE_ACTIVITIES_PER_CASE) throw new Error("Conflict");

    const insertedRows = await tx
      .insert(admissionsActivities)
      .values({
        caseId: input.access.caseId,
        name,
        fullDescription,
        commonApp,
        uc,
        commonAppRank: null,
        sortOrder: input.sortOrder ?? liveCount,
      })
      .returning();
    const row = insertedRows[0];
    if (!row) throw new Error("Activity insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "activity",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        { name, fullDescription, commonApp, uc, sortOrder: row.sortOrder },
        ["name", "fullDescription", "commonApp", "uc", "sortOrder"],
      ),
    });

    return toActivityDto(row);
  }, db);
}

// ── Update (CM-70, design §2.4/§6) ──────────────────────────────────────

/** updateActivity input — undefined fields are left untouched. */
export interface UpdateActivityInput {
  access: CaseAccess;
  activityId: string;
  /** Optimistic-concurrency token (row updatedAt ISO); mismatch → Conflict. */
  expectedUpdatedAt?: string;
  name?: string;
  /** null clears. */
  fullDescription?: string | null;
  /** Whole-block replace; null clears the block. */
  commonApp?: AdmissionsCommonAppBlock | null;
  /** Whole-block replace; null clears the block. */
  uc?: AdmissionsUcBlock | null;
  sortOrder?: number;
}

const ACTIVITY_DIFF_FIELDS = [
  "name",
  "fullDescription",
  "commonApp",
  "uc",
  "sortOrder",
] as const;

/**
 * Partially updates an activity (CM-70). Every field here is
 * student-writable (design §2.4 — students own the activities list); a
 * counselor/admin edit is an attributed override via the audit actorRole,
 * never disguised. commonAppRank is deliberately NOT editable here — ranks
 * change only through setCommonAppRanks (CM-71). The mutation and its
 * field-level audit diff commit atomically.
 *
 * 1. Role gate (student+) + up-front validation (non-empty name when
 *    provided, hard-capped blocks, non-negative integer sortOrder).
 * 2. Load the live activity scoped to the access's case (miss → NotFound);
 *    an expectedUpdatedAt mismatch → Error("Conflict") (design §6 — routes
 *    surface 409 with both versions).
 * 3. Diff only the provided fields (blocks compare structurally); nothing
 *    changed → no-op without writes.
 * 4. Apply the changed fields plus a fresh updatedAt; audit the diff.
 *
 * @returns the updated activity DTO.
 */
export async function updateActivity(
  input: UpdateActivityInput,
  db: Database = getDb(),
): Promise<AdmissionsActivityDto> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.activityId)) throw new Error("NotFound");

  const name = input.name === undefined ? undefined : input.name.trim();
  if (name !== undefined && !name) throw new Error("Activity requires a non-empty name");
  const fullDescription = input.fullDescription === undefined
    ? undefined
    : normalizeFullDescription(input.fullDescription);
  const commonApp = input.commonApp === undefined
    ? undefined
    : parseCommonAppInput(input.commonApp);
  const uc = input.uc === undefined ? undefined : parseUcInput(input.uc);
  if (input.sortOrder !== undefined) assertSortOrder(input.sortOrder);

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveActivity(tx, input.activityId, input.access.caseId);

    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== row.updatedAt.toISOString()
    ) {
      throw new Error("Conflict");
    }

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      { name, fullDescription, commonApp, uc, sortOrder: input.sortOrder },
      ACTIVITY_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toActivityDto(row);

    const now = new Date();
    const setValues: Partial<typeof admissionsActivities.$inferInsert> = {
      updatedAt: now,
    };
    if ("name" in diff) setValues.name = name;
    if ("fullDescription" in diff) setValues.fullDescription = fullDescription;
    if ("commonApp" in diff) setValues.commonApp = commonApp;
    if ("uc" in diff) setValues.uc = uc;
    if ("sortOrder" in diff) setValues.sortOrder = input.sortOrder;

    await tx
      .update(admissionsActivities)
      .set(setValues)
      .where(eq(admissionsActivities.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "activity",
      entityId: row.id,
      action: "update",
      diff,
    });

    return toActivityDto({ ...row, ...setValues } as ActivityRow);
  }, db);
}

// ── Soft delete (student-owned list, design §2.4) ───────────────────────

/** softDeleteActivity input; `access` must come from requireCaseAccess. */
export interface SoftDeleteActivityInput {
  access: CaseAccess;
  activityId: string;
}

/**
 * Soft-deletes an activity. Unlike essays, students may delete activities
 * of their own case — the master list is theirs (design §2.4); counselor
 * deletes are attributed via the audit actorRole. A held Common App rank is
 * cleared so the top-10 never counts a deleted row (CM-71). The mutation
 * and its audit row commit atomically; the row stays queryable for the
 * audit trail via deletedAt.
 */
export async function softDeleteActivity(
  input: SoftDeleteActivityInput,
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");
  if (!isUuidShaped(input.activityId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveActivity(tx, input.activityId, input.access.caseId);

    const now = new Date();
    await tx
      .update(admissionsActivities)
      .set({ deletedAt: now, updatedAt: now, commonAppRank: null })
      .where(eq(admissionsActivities.id, row.id));

    const diff: AdmissionsFieldDiff = {
      deletedAt: { old: null, new: now.toISOString() },
    };
    if (row.commonAppRank !== null) {
      diff.commonAppRank = { old: row.commonAppRank, new: null };
    }

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "activity",
      entityId: row.id,
      action: "delete",
      diff,
    });
  }, db);
}

// ── Common App top-10 ranking (CM-71) ───────────────────────────────────

/** setCommonAppRanks input; `access` must come from requireCaseAccess. */
export interface SetCommonAppRanksInput {
  access: CaseAccess;
  /**
   * The full ranked selection, best first — position i gets rank i+1.
   * Activities of the case NOT listed here get their rank cleared. An empty
   * array clears every rank.
   */
  orderedIds: readonly string[];
}

/**
 * Persists the student's "Common App top 10" drag-rank order (CM-71) for
 * access.caseId. Student-writable (the list is theirs, design §2.4);
 * counselor/admin reorders are attributed via the audit actorRole; parents
 * never write.
 *
 * 1. Validate the selection up front: at most
 *    MAX_COMMON_APP_RANKED_ACTIVITIES ids, no duplicates, every id
 *    uuid-shaped (a malformed id → NotFound) — failures never touch the
 *    database.
 * 2. Load the case's live activities; every ordered id must be one of them
 *    (a foreign or deleted id → NotFound, nothing written).
 * 3. Compute the target ranks (orderedIds[i] → i+1; unlisted live rows →
 *    null). When every rank already matches, return without writes or an
 *    audit row — reordering is idempotent.
 * 4. Apply: one update per re-ranked activity (in rank order), one batched
 *    clear for the de-listed rows, all stamped with a fresh updatedAt; then
 *    ONE audit row (entityType "activity_ranks", entityId = caseId) whose
 *    diff maps each changed activityId → { old, new } rank. Mutation and
 *    audit commit atomically.
 */
export async function setCommonAppRanks(
  input: SetCommonAppRanksInput,
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "student")) throw new Error("Forbidden");

  if (input.orderedIds.length > MAX_COMMON_APP_RANKED_ACTIVITIES) {
    throw new Error(
      `Common App rank list accepts at most ${MAX_COMMON_APP_RANKED_ACTIVITIES} activities`,
    );
  }
  if (new Set(input.orderedIds).size !== input.orderedIds.length) {
    throw new Error("Duplicate activity ids in the Common App rank list");
  }
  if (input.orderedIds.some((id) => !isUuidShaped(id))) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const liveRows = await tx
      .select({
        id: admissionsActivities.id,
        commonAppRank: admissionsActivities.commonAppRank,
      })
      .from(admissionsActivities)
      .where(and(
        eq(admissionsActivities.caseId, input.access.caseId),
        isNull(admissionsActivities.deletedAt),
      ));

    const currentRankById = new Map(liveRows.map((row) => [row.id, row.commonAppRank]));
    for (const id of input.orderedIds) {
      if (!currentRankById.has(id)) throw new Error("NotFound");
    }

    const targetRankById = new Map<string, number>(
      input.orderedIds.map((id, index) => [id, index + 1]),
    );

    const diff: AdmissionsFieldDiff = {};
    const rankUpdates: Array<{ id: string; rank: number }> = [];
    for (const id of input.orderedIds) {
      const target = targetRankById.get(id) as number;
      const current = currentRankById.get(id) ?? null;
      if (current === target) continue;
      rankUpdates.push({ id, rank: target });
      diff[id] = { old: current, new: target };
    }
    const clearedIds = liveRows
      .filter((row) => row.commonAppRank !== null && !targetRankById.has(row.id))
      .map((row) => row.id)
      .sort();
    for (const id of clearedIds) {
      diff[id] = { old: currentRankById.get(id) ?? null, new: null };
    }

    if (rankUpdates.length === 0 && clearedIds.length === 0) return;

    const now = new Date();
    for (const { id, rank } of rankUpdates) {
      await tx
        .update(admissionsActivities)
        .set({ commonAppRank: rank, updatedAt: now })
        .where(eq(admissionsActivities.id, id));
    }
    if (clearedIds.length > 0) {
      await tx
        .update(admissionsActivities)
        .set({ commonAppRank: null, updatedAt: now })
        .where(inArray(admissionsActivities.id, clearedIds));
    }

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "activity_ranks",
      entityId: input.access.caseId,
      action: "update",
      diff,
    });
  }, db);
}

// ── Read (CM-70/71) ─────────────────────────────────────────────────────

/**
 * A case's live activities, ranked rows first (CM-71 top-10 by ascending
 * commonAppRank), then the rest of the master list by sortOrder (id
 * tiebreak for a stable render). Stored platform blocks are re-validated on
 * read — a malformed stored block reads as null, never guessed
 * (fail-closed). Malformed caseId fails closed to an empty list.
 *
 * @returns Activities-tab rows, ranked first.
 */
export async function listActivitiesForCase(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsActivityDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const rows = await db
    .select()
    .from(admissionsActivities)
    .where(and(
      eq(admissionsActivities.caseId, caseId),
      isNull(admissionsActivities.deletedAt),
    ));

  return rows.map(toActivityDto).sort(compareActivities);
}

/** Rank-first comparator — see the listActivitiesForCase JSDoc. */
function compareActivities(
  a: Pick<AdmissionsActivityDto, "id" | "commonAppRank" | "sortOrder">,
  b: Pick<AdmissionsActivityDto, "id" | "commonAppRank" | "sortOrder">,
): number {
  if (a.commonAppRank !== null || b.commonAppRank !== null) {
    if (a.commonAppRank === null) return 1;
    if (b.commonAppRank === null) return -1;
    if (a.commonAppRank !== b.commonAppRank) return a.commonAppRank - b.commonAppRank;
  }
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
