// Admissions Case Management — college list items, IPEDS integration,
// decision events, the committed pointer, and ED/REA warnings.
//
// Design: docs/casemanagementsystem_design.md §1 (colleges.ts module map
// row), §3 (admissions_college_list_items / admissions_application_events).
// PRD CM-40..CM-45.
//
// Core rules:
// - CM-40: US rows soft-reference ipeds_institutions by unitId (never an FK)
//   and denormalize instName/city/stateAbbr/country at add time; reads join
//   the LATEST dataYear live and fall back to the denormalized copy with
//   stale: true when the unitId no longer resolves. Non-US/manual rows are
//   free-text name + country with isManual: true.
// - CM-42/44: round/deadline/status/category/aid live on the list item;
//   updates use optimistic concurrency (expectedUpdatedAt mismatch →
//   Error("Conflict")).
// - CM-43: decisions are an append-only dated event chain (deferred →
//   accepted is two rows, both preserved); events are never edited.
// - CM-44: exactly one committed college per case — the
//   admissions_cases.committedListItemId pointer and the "committed" event
//   commit in one transaction; a second commit while another item holds the
//   pointer → Error("Conflict").
// - CM-45: ED/REA validation WARNS, never blocks — computeApplicationWarnings
//   is pure and side-effect free.
//
// Writes are counselor+ (design §2.4: college list / application decisions
// are staff-only). Error contract (admissionsErrorResponse maps these):
// missing rows / malformed ids → Error("NotFound"); role violations →
// Error("Forbidden"); rule violations (duplicate list row, second committed
// college, concurrency mismatch) → Error("Conflict"); input-shape violations
// throw descriptive Errors (routes' Zod schemas are the 400 boundary).

import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsApplicationEvents,
  admissionsCases,
  admissionsCollegeListItems,
  ipedsInstitutions,
} from "@/lib/db/schema";
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
import type { AdmissionsCollegeCompleteness } from "./recommenders";
import type { CaseAccess } from "./types";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AID_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

type CollegeListItemRow = typeof admissionsCollegeListItems.$inferSelect;
type ApplicationEventRow = typeof admissionsApplicationEvents.$inferSelect;

// ── Status unions (mirror pgEnums in schema.ts) ─────────────────────────

/** Application round (mirrors admissions_app_round). */
export type AdmissionsAppRound =
  | "ed"
  | "ed2"
  | "ea"
  | "rea"
  | "rd"
  | "rolling"
  | "priority"
  | "other";

/** All valid application rounds, for boundary validation. */
export const ADMISSIONS_APP_ROUNDS: readonly AdmissionsAppRound[] = [
  "ed",
  "ed2",
  "ea",
  "rea",
  "rd",
  "rolling",
  "priority",
  "other",
];

/** Display labels for application rounds (calendar titles, UI chips). */
export const ADMISSIONS_APP_ROUND_LABELS: Record<AdmissionsAppRound, string> = {
  ed: "ED",
  ed2: "ED II",
  ea: "EA",
  rea: "REA",
  rd: "RD",
  rolling: "Rolling",
  priority: "Priority",
  other: "Other",
};

/** Application progress (mirrors admissions_app_status). */
export type AdmissionsAppStatus = "researching" | "applying" | "submitted" | "complete";

/** All valid application statuses, for boundary validation. */
export const ADMISSIONS_APP_STATUSES: readonly AdmissionsAppStatus[] = [
  "researching",
  "applying",
  "submitted",
  "complete",
];

/** Reach/match/safety category (mirrors admissions_college_category). */
export type AdmissionsCollegeCategory = "reach" | "match" | "safety" | "unset";

/** All valid list categories, for boundary validation. */
export const ADMISSIONS_COLLEGE_CATEGORIES: readonly AdmissionsCollegeCategory[] = [
  "reach",
  "match",
  "safety",
  "unset",
];

/** Decision-chain event (mirrors admissions_decision_event). */
export type AdmissionsDecisionEvent =
  | "submitted"
  | "deferred"
  | "waitlisted"
  | "accepted"
  | "denied"
  | "withdrawn"
  | "committed";

/** All valid decision events, for boundary validation. */
export const ADMISSIONS_DECISION_EVENTS: readonly AdmissionsDecisionEvent[] = [
  "submitted",
  "deferred",
  "waitlisted",
  "accepted",
  "denied",
  "withdrawn",
  "committed",
];

// ── DTOs ────────────────────────────────────────────────────────────────

/** One college list row serialized for the Colleges tab (design §5.1). */
export interface AdmissionsCollegeListItemDto {
  id: string;
  caseId: string;
  /** IPEDS soft reference; null for manual (non-US) rows. */
  unitId: number | null;
  instName: string;
  city: string | null;
  stateAbbr: string | null;
  country: string;
  isManual: boolean;
  round: AdmissionsAppRound;
  deadline: string | null;
  appStatus: AdmissionsAppStatus;
  category: AdmissionsCollegeCategory;
  /** Merit/aid offered (CM-44); Postgres numeric serialized as a string. */
  aidOffered: string | null;
  aidNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Live IPEDS stats joined at read time from the latest dataYear (CM-40) —
 * mirrors the columns the us-universities tab exposes (acceptance rate,
 * sticker cost, average net price, 6-year bachelor's grad rate).
 */
export interface AdmissionsCollegeIpedsStats {
  dataYear: string;
  acceptanceRate: number | null;
  totalPriceInState: number | null;
  avgNetPrice: number | null;
  gradRateBach6yr: number | null;
}

// Per-college completeness rollup (CM-46). The recommenders module OWNS the
// shape and the derivation (computeCollegeCompleteness); this module only
// carries the rollup on its read DTO via the `completenessMap` hook and
// re-exports the type so Colleges-tab consumers import one module.
export type { AdmissionsCollegeCompleteness } from "./recommenders";

/** One Colleges-tab row: list item + live IPEDS stats + completeness. */
export interface AdmissionsCollegeListRowDto extends AdmissionsCollegeListItemDto {
  /** Latest-dataYear IPEDS stats; null for manual rows and vanished unitIds. */
  stats: AdmissionsCollegeIpedsStats | null;
  /**
   * True when the row carries a unitId that no longer resolves in
   * ipeds_institutions — the denormalized copy on the row is the fallback.
   */
  stale: boolean;
  /** Completeness rollup from `completenessMap`; null when not supplied. */
  completeness: AdmissionsCollegeCompleteness | null;
}

/** One append-only decision event row (CM-43). */
export interface AdmissionsApplicationEventDto {
  id: string;
  listItemId: string;
  event: AdmissionsDecisionEvent;
  eventDate: string;
  notes: string | null;
  createdAt: string;
}

// ── Internal helpers ────────────────────────────────────────────────────

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

/** Trim + lowercase for manual-name dedupe (never stored — display keeps casing). */
function normalizeInstName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant (mirrors the
 * private helper in calendar.ts / meetings.ts).
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

function toItemDto(row: CollegeListItemRow): AdmissionsCollegeListItemDto {
  return {
    id: row.id,
    caseId: row.caseId,
    unitId: row.unitId,
    instName: row.instName,
    city: row.city,
    stateAbbr: row.stateAbbr,
    country: row.country,
    isManual: row.isManual,
    round: row.round,
    deadline: row.deadline,
    appStatus: row.appStatus,
    category: row.category,
    aidOffered: row.aidOffered,
    aidNotes: row.aidNotes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEventDto(row: ApplicationEventRow): AdmissionsApplicationEventDto {
  return {
    id: row.id,
    listItemId: row.listItemId,
    event: row.event,
    eventDate: row.eventDate,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Loads a live list item scoped to (itemId, caseId, not soft-deleted). The
 * caseId scope stops cross-case itemId probing; a miss throws "NotFound".
 */
async function findLiveItem(
  db: AdmissionsWriteDb,
  itemId: string,
  caseId: string,
): Promise<CollegeListItemRow> {
  const rows = await db
    .select()
    .from(admissionsCollegeListItems)
    .where(and(
      eq(admissionsCollegeListItems.id, itemId),
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

/** Loads the (live) case row for pointer reads/writes; a miss throws "NotFound". */
async function findLiveCase(
  db: AdmissionsWriteDb,
  caseId: string,
): Promise<{ id: string; committedListItemId: string | null; updatedAt: Date }> {
  const rows = await db
    .select({
      id: admissionsCases.id,
      committedListItemId: admissionsCases.committedListItemId,
      updatedAt: admissionsCases.updatedAt,
    })
    .from(admissionsCases)
    .where(and(eq(admissionsCases.id, caseId), isNull(admissionsCases.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

// ── Add (CM-40/41) ──────────────────────────────────────────────────────

/**
 * Add entry modes (CM-40): an IPEDS unitId (US institutions — denormalized
 * from the latest dataYear at add time) or a manual free-text row (non-US /
 * unlisted institutions).
 */
export type AddCollegeEntry =
  | { unitId: number; manual?: undefined }
  | { manual: { instName: string; country: string }; unitId?: undefined };

/** addCollegeListItem input; `access` must come from requireCaseAccess. */
export interface AddCollegeListItemInput {
  access: CaseAccess;
  entry: AddCollegeEntry;
  round: AdmissionsAppRound;
  deadline?: string | null;
  category?: AdmissionsCollegeCategory;
}

/**
 * Adds a college to a case's list (CM-40/41). Counselor+ only; the insert
 * and its audit row commit atomically.
 *
 * 1. Validate round/deadline/category and the entry shape up front.
 * 2. IPEDS mode: resolve the LATEST dataYear row for the unitId in
 *    ipeds_institutions (unknown unitId → NotFound) and denormalize
 *    instName/city/stateAbbr at add time with country "US" — the row stays
 *    readable even if a future IPEDS import drops the unitId. Manual mode:
 *    free-text instName + country, isManual: true.
 * 3. Dedupe against the case's live rows: same unitId (IPEDS mode) or same
 *    normalized manual name (manual mode) → Error("Conflict").
 * 4. Insert with appStatus "researching" and category default "unset";
 *    audit (entityType "college_list_item", action "create").
 *
 * @returns the created list item DTO.
 */
export async function addCollegeListItem(
  input: AddCollegeListItemInput,
  db: Database = getDb(),
): Promise<AdmissionsCollegeListItemDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!ADMISSIONS_APP_ROUNDS.includes(input.round)) {
    throw new Error(`Invalid application round: ${String(input.round)}`);
  }
  if (input.deadline != null) assertDateOnly(input.deadline, "deadline");
  const category = input.category ?? "unset";
  if (!ADMISSIONS_COLLEGE_CATEGORIES.includes(category)) {
    throw new Error(`Invalid college category: ${String(input.category)}`);
  }

  const { entry } = input;
  const isIpedsEntry = entry.unitId !== undefined;
  if (isIpedsEntry && (!Number.isInteger(entry.unitId) || entry.unitId <= 0)) {
    throw new Error("Invalid unitId: expected a positive integer");
  }
  let manualInstName = "";
  let manualCountry = "";
  if (!isIpedsEntry) {
    manualInstName = entry.manual.instName.trim();
    manualCountry = entry.manual.country.trim();
    if (!manualInstName) throw new Error("Manual entry requires a non-empty instName");
    if (!manualCountry) throw new Error("Manual entry requires a non-empty country");
  }

  return withAuditedTransaction(async (tx) => {
    let denormalized: {
      unitId: number | null;
      instName: string;
      city: string | null;
      stateAbbr: string | null;
      country: string;
      isManual: boolean;
    };
    if (isIpedsEntry) {
      const ipedsRows = await tx
        .select({
          unitId: ipedsInstitutions.unitId,
          instName: ipedsInstitutions.instName,
          city: ipedsInstitutions.city,
          stateAbbr: ipedsInstitutions.stateAbbr,
          dataYear: ipedsInstitutions.dataYear,
        })
        .from(ipedsInstitutions)
        .where(eq(ipedsInstitutions.unitId, entry.unitId))
        .orderBy(desc(ipedsInstitutions.dataYear))
        .limit(1);
      const institution = ipedsRows[0];
      if (!institution) throw new Error("NotFound");
      denormalized = {
        unitId: institution.unitId,
        instName: institution.instName,
        city: institution.city,
        stateAbbr: institution.stateAbbr,
        country: "US",
        isManual: false,
      };
    } else {
      denormalized = {
        unitId: null,
        instName: manualInstName,
        city: null,
        stateAbbr: null,
        country: manualCountry,
        isManual: true,
      };
    }

    const existingRows = await tx
      .select({
        id: admissionsCollegeListItems.id,
        unitId: admissionsCollegeListItems.unitId,
        instName: admissionsCollegeListItems.instName,
      })
      .from(admissionsCollegeListItems)
      .where(and(
        eq(admissionsCollegeListItems.caseId, input.access.caseId),
        isNull(admissionsCollegeListItems.deletedAt),
      ));
    const isDuplicate = isIpedsEntry
      ? existingRows.some((row) => row.unitId === entry.unitId)
      : existingRows.some(
          (row) => normalizeInstName(row.instName) === normalizeInstName(manualInstName),
        );
    if (isDuplicate) throw new Error("Conflict");

    const insertedRows = await tx
      .insert(admissionsCollegeListItems)
      .values({
        caseId: input.access.caseId,
        unitId: denormalized.unitId,
        instName: denormalized.instName,
        city: denormalized.city,
        stateAbbr: denormalized.stateAbbr,
        country: denormalized.country,
        isManual: denormalized.isManual,
        round: input.round,
        deadline: input.deadline ?? null,
        appStatus: "researching",
        category,
        aidOffered: null,
        aidNotes: null,
      })
      .returning();
    const row = insertedRows[0];
    if (!row) throw new Error("College list item insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_list_item",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        {
          unitId: denormalized.unitId,
          instName: denormalized.instName,
          country: denormalized.country,
          isManual: denormalized.isManual,
          round: input.round,
          deadline: input.deadline ?? null,
          category,
        },
        ["unitId", "instName", "country", "isManual", "round", "deadline", "category"],
      ),
    });

    return toItemDto(row);
  }, db);
}

// ── Update (CM-42/44) ───────────────────────────────────────────────────

/** updateCollegeListItem input — undefined fields are left untouched. */
export interface UpdateCollegeListItemInput {
  access: CaseAccess;
  itemId: string;
  /** Optimistic-concurrency token (item updatedAt ISO); mismatch → Conflict. */
  expectedUpdatedAt?: string;
  round?: AdmissionsAppRound;
  deadline?: string | null;
  appStatus?: AdmissionsAppStatus;
  category?: AdmissionsCollegeCategory;
  /** Non-negative decimal string (≤2 decimal places) or null to clear. */
  aidOffered?: string | null;
  aidNotes?: string | null;
}

const ITEM_DIFF_FIELDS = [
  "round",
  "deadline",
  "appStatus",
  "category",
  "aidOffered",
  "aidNotes",
] as const;

/**
 * Partially updates a list item's plan fields (CM-42/44): round, deadline,
 * appStatus, category, aidOffered, aidNotes. Counselor+ only; the mutation
 * and its field-level audit diff commit atomically.
 *
 * 1. Validate provided fields up front (known round/status/category,
 *    "YYYY-MM-DD" deadline, non-negative decimal aidOffered).
 * 2. Load the live item scoped to the access's case (miss → NotFound); an
 *    expectedUpdatedAt mismatch → Error("Conflict") (design §3 optimistic
 *    concurrency — routes surface 409 with both versions).
 * 3. Diff only the provided fields; nothing changed → no-op without writes.
 * 4. Apply the changed fields plus a fresh updatedAt and audit the diff.
 *
 * @returns the updated list item DTO.
 */
export async function updateCollegeListItem(
  input: UpdateCollegeListItemInput,
  db: Database = getDb(),
): Promise<AdmissionsCollegeListItemDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.itemId)) throw new Error("NotFound");

  if (input.round !== undefined && !ADMISSIONS_APP_ROUNDS.includes(input.round)) {
    throw new Error(`Invalid application round: ${String(input.round)}`);
  }
  if (input.deadline != null) assertDateOnly(input.deadline, "deadline");
  if (input.appStatus !== undefined && !ADMISSIONS_APP_STATUSES.includes(input.appStatus)) {
    throw new Error(`Invalid application status: ${String(input.appStatus)}`);
  }
  if (input.category !== undefined && !ADMISSIONS_COLLEGE_CATEGORIES.includes(input.category)) {
    throw new Error(`Invalid college category: ${String(input.category)}`);
  }
  if (input.aidOffered != null && !AID_AMOUNT_PATTERN.test(input.aidOffered)) {
    throw new Error("Invalid aidOffered: expected a non-negative decimal amount");
  }

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveItem(tx, input.itemId, input.access.caseId);

    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== row.updatedAt.toISOString()
    ) {
      throw new Error("Conflict");
    }

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      {
        round: input.round,
        deadline: input.deadline,
        appStatus: input.appStatus,
        category: input.category,
        aidOffered: input.aidOffered,
        aidNotes: input.aidNotes,
      },
      ITEM_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toItemDto(row);

    const setValues: Partial<typeof admissionsCollegeListItems.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ("round" in diff) setValues.round = input.round;
    if ("deadline" in diff) setValues.deadline = input.deadline;
    if ("appStatus" in diff) setValues.appStatus = input.appStatus;
    if ("category" in diff) setValues.category = input.category;
    if ("aidOffered" in diff) setValues.aidOffered = input.aidOffered;
    if ("aidNotes" in diff) setValues.aidNotes = input.aidNotes;

    await tx
      .update(admissionsCollegeListItems)
      .set(setValues)
      .where(eq(admissionsCollegeListItems.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_list_item",
      entityId: row.id,
      action: "update",
      diff,
    });

    return toItemDto({ ...row, ...setValues } as CollegeListItemRow);
  }, db);
}

// ── Soft delete ─────────────────────────────────────────────────────────

/** softDeleteCollegeListItem input; `access` must come from requireCaseAccess. */
export interface SoftDeleteCollegeListItemInput {
  access: CaseAccess;
  itemId: string;
}

/**
 * Soft-deletes a college list item (counselor+). When the case's committed
 * pointer references the deleted item, the pointer is cleared in the same
 * transaction (a case must never point at a deleted row — CM-44 integrity).
 * Both writes are audited atomically. Decision events remain in place as the
 * historical record (append-only, CM-43).
 */
export async function softDeleteCollegeListItem(
  input: SoftDeleteCollegeListItemInput,
  db: Database = getDb(),
): Promise<void> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.itemId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveItem(tx, input.itemId, input.access.caseId);
    const caseRow = await findLiveCase(tx, input.access.caseId);

    const now = new Date();
    await tx
      .update(admissionsCollegeListItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsCollegeListItems.id, row.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "college_list_item",
      entityId: row.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });

    if (caseRow.committedListItemId === row.id) {
      await tx
        .update(admissionsCases)
        .set({ committedListItemId: null, updatedAt: now })
        .where(eq(admissionsCases.id, caseRow.id));

      await writeAuditLog(tx, {
        caseId: input.access.caseId,
        actorEmail: input.access.email,
        actorRole: input.access.role,
        entityType: "case",
        entityId: caseRow.id,
        action: "clear_committed_college",
        diff: { committedListItemId: { old: row.id, new: null } },
      });
    }
  }, db);
}

// ── Read (CM-40 live join + CM-46 completeness hook) ────────────────────

/** listCollegesForCase options — the completeness hook for the recommenders module. */
export interface ListCollegesOptions {
  /**
   * Per-item completeness rollups keyed by list item id (CM-46). Supplied by
   * the recommenders module; rows without an entry read completeness: null.
   */
  completenessMap?: ReadonlyMap<string, AdmissionsCollegeCompleteness>;
}

/**
 * A case's live college list with live IPEDS stats joined at read time
 * (CM-40): one batched query resolves the LATEST dataYear row per unitId.
 * When a unitId no longer resolves (dropped by a re-import), the row falls
 * back to its denormalized copy and is flagged stale: true (fail-closed —
 * never guessed from another institution). Manual rows carry stats: null,
 * stale: false. Rows sort deadline ascending (nulls last), then by creation.
 * Malformed caseId fails closed to an empty list.
 *
 * @returns Colleges-tab rows: item + stats + stale flag + completeness.
 */
export async function listCollegesForCase(
  caseId: string,
  options: ListCollegesOptions = {},
  db: Database = getDb(),
): Promise<AdmissionsCollegeListRowDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const itemRows = await db
    .select()
    .from(admissionsCollegeListItems)
    .where(and(
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    ))
    .orderBy(asc(admissionsCollegeListItems.deadline), asc(admissionsCollegeListItems.createdAt));

  const unitIds = [...new Set(
    itemRows
      .map((row) => row.unitId)
      .filter((unitId): unitId is number => unitId !== null),
  )];

  // Latest dataYear per unitId: ordered (unitId asc, dataYear desc) so the
  // first row seen per unitId is the newest ("YYYY-YY" sorts lexicographically).
  const statsByUnit = new Map<number, AdmissionsCollegeIpedsStats>();
  if (unitIds.length > 0) {
    const statRows = await db
      .select({
        unitId: ipedsInstitutions.unitId,
        dataYear: ipedsInstitutions.dataYear,
        acceptanceRate: ipedsInstitutions.acceptanceRate,
        totalPriceInState: ipedsInstitutions.totalPriceInState,
        avgNetPrice: ipedsInstitutions.avgNetPrice,
        gradRateBach6yr: ipedsInstitutions.gradRateBach6yr,
      })
      .from(ipedsInstitutions)
      .where(inArray(ipedsInstitutions.unitId, unitIds))
      .orderBy(asc(ipedsInstitutions.unitId), desc(ipedsInstitutions.dataYear));
    for (const statRow of statRows) {
      if (statsByUnit.has(statRow.unitId)) continue;
      statsByUnit.set(statRow.unitId, {
        dataYear: statRow.dataYear,
        acceptanceRate: statRow.acceptanceRate,
        totalPriceInState: statRow.totalPriceInState,
        avgNetPrice: statRow.avgNetPrice,
        gradRateBach6yr: statRow.gradRateBach6yr,
      });
    }
  }

  return itemRows.map((row) => {
    const stats = row.unitId !== null ? statsByUnit.get(row.unitId) ?? null : null;
    return {
      ...toItemDto(row),
      stats,
      stale: row.unitId !== null && stats === null,
      completeness: options.completenessMap?.get(row.id) ?? null,
    };
  });
}

// ── Decision events (CM-43) ─────────────────────────────────────────────

/** addApplicationEvent input; `access` must come from requireCaseAccess. */
export interface AddApplicationEventInput {
  access: CaseAccess;
  listItemId: string;
  event: AdmissionsDecisionEvent;
  eventDate: string;
  notes?: string | null;
}

/**
 * Appends one dated decision event to a list item's chain (CM-43).
 * Append-only: events are never edited or deleted, so chains like
 * deferred → accepted are preserved verbatim. Counselor+ only; the insert
 * and its audit row commit atomically.
 *
 * Sane-chain rule: a "committed" event while ANOTHER item already holds the
 * case's committed pointer → Error("Conflict") (CM-44: exactly one committed
 * college per case). setCommittedCollege is the canonical commit path — it
 * moves the pointer and appends this event in one transaction.
 *
 * @returns the created event DTO.
 */
export async function addApplicationEvent(
  input: AddApplicationEventInput,
  db: Database = getDb(),
): Promise<AdmissionsApplicationEventDto> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.listItemId)) throw new Error("NotFound");
  if (!ADMISSIONS_DECISION_EVENTS.includes(input.event)) {
    throw new Error(`Invalid decision event: ${String(input.event)}`);
  }
  assertDateOnly(input.eventDate, "eventDate");

  return withAuditedTransaction(async (tx) => {
    const item = await findLiveItem(tx, input.listItemId, input.access.caseId);

    if (input.event === "committed") {
      const caseRow = await findLiveCase(tx, input.access.caseId);
      if (
        caseRow.committedListItemId !== null &&
        caseRow.committedListItemId !== item.id
      ) {
        throw new Error("Conflict");
      }

      // CM-44 race safety: the read above is check-then-write, so two
      // concurrent commits could both see a null pointer. This conditional
      // self-referential UPDATE takes the case row lock and re-evaluates the
      // pointer under it — a concurrent winner makes the WHERE miss, and the
      // zero-row result surfaces as Conflict before any event is appended.
      const guardRows = await tx
        .update(admissionsCases)
        .set({ updatedAt: new Date() })
        .where(and(
          eq(admissionsCases.id, input.access.caseId),
          isNull(admissionsCases.deletedAt),
          or(
            isNull(admissionsCases.committedListItemId),
            eq(admissionsCases.committedListItemId, item.id),
          ),
        ))
        .returning({ id: admissionsCases.id });
      if (guardRows.length === 0) throw new Error("Conflict");
    }

    const insertedRows = await tx
      .insert(admissionsApplicationEvents)
      .values({
        listItemId: item.id,
        event: input.event,
        eventDate: input.eventDate,
        notes: input.notes ?? null,
      })
      .returning();
    const row = insertedRows[0];
    if (!row) throw new Error("Application event insert returned no row");

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "application_event",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        {
          listItemId: item.id,
          event: input.event,
          eventDate: input.eventDate,
          notes: input.notes ?? null,
        },
        ["listItemId", "event", "eventDate", "notes"],
      ),
    });

    return toEventDto(row);
  }, db);
}

/**
 * A list item's decision chain, oldest first (eventDate asc, then insertion
 * order for same-day events). Malformed listItemId fails closed to an empty
 * list. Routes must scope the item to the case (requireCaseAccess +
 * item-ownership check) before calling.
 */
export async function listApplicationEvents(
  listItemId: string,
  db: Database = getDb(),
): Promise<AdmissionsApplicationEventDto[]> {
  if (!isUuidShaped(listItemId)) return [];

  const rows = await db
    .select()
    .from(admissionsApplicationEvents)
    .where(eq(admissionsApplicationEvents.listItemId, listItemId))
    .orderBy(asc(admissionsApplicationEvents.eventDate), asc(admissionsApplicationEvents.createdAt));
  return rows.map(toEventDto);
}

/**
 * Latest decision event per list item (by eventDate, then createdAt) — the
 * "current decision state" feeding computeApplicationWarnings and the
 * Colleges-tab decision chips. Pure.
 *
 * @returns Map of listItemId → latest event type.
 */
export function deriveLatestEvents(
  events: ReadonlyArray<{
    listItemId: string;
    event: AdmissionsDecisionEvent;
    eventDate: string;
    createdAt: string | Date;
  }>,
): Map<string, AdmissionsDecisionEvent> {
  const latestByItem = new Map<string, { event: AdmissionsDecisionEvent; sortKey: string }>();
  for (const event of events) {
    const createdKey =
      event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt;
    const sortKey = `${event.eventDate}|${createdKey}`;
    const current = latestByItem.get(event.listItemId);
    if (!current || sortKey >= current.sortKey) {
      latestByItem.set(event.listItemId, { event: event.event, sortKey });
    }
  }
  return new Map([...latestByItem].map(([id, value]) => [id, value.event]));
}

// ── Committed college (CM-44) ───────────────────────────────────────────

/** setCommittedCollege input; `access` must come from requireCaseAccess. */
export interface SetCommittedCollegeInput {
  access: CaseAccess;
  listItemId: string;
  /** Event date for the appended "committed" event; defaults to today (Bangkok). */
  eventDate?: string;
}

/** Committed-pointer mutation result (fresh case concurrency token). */
export interface CommittedCollegeResult {
  caseId: string;
  committedListItemId: string | null;
  updatedAt: string;
}

/**
 * Marks exactly one college as committed for a case (CM-44): sets
 * admissions_cases.committedListItemId and appends the "committed" decision
 * event in ONE transaction, audited. Counselor+ only.
 *
 * 1. Load the live item scoped to the case (miss → NotFound) and the case row.
 * 2. Already committed to this item → idempotent no-op (no writes). Committed
 *    to a DIFFERENT item → Error("Conflict") — clearCommittedCollege first.
 * 3. Point the case at the item with a conditional UPDATE (`WHERE
 *    committed_list_item_id IS NULL`, zero rows → Conflict — so a concurrent
 *    commit race can never produce two committed items), append the
 *    "committed" event (eventDate defaults to today's Bangkok date), and
 *    audit the pointer diff.
 *
 * @returns the caseId, the committed item id, and the new case updatedAt.
 */
export async function setCommittedCollege(
  input: SetCommittedCollegeInput,
  db: Database = getDb(),
): Promise<CommittedCollegeResult> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (!isUuidShaped(input.listItemId)) throw new Error("NotFound");
  if (input.eventDate !== undefined) assertDateOnly(input.eventDate, "eventDate");

  return withAuditedTransaction(async (tx) => {
    const item = await findLiveItem(tx, input.listItemId, input.access.caseId);
    const caseRow = await findLiveCase(tx, input.access.caseId);

    if (caseRow.committedListItemId === item.id) {
      return {
        caseId: caseRow.id,
        committedListItemId: item.id,
        updatedAt: caseRow.updatedAt.toISOString(),
      };
    }
    if (caseRow.committedListItemId !== null) throw new Error("Conflict");

    // CM-44 race safety: the pointer write itself carries the "still
    // uncommitted" condition, so two concurrent commits can never both win —
    // the loser's UPDATE matches zero rows (the row lock forces it to see the
    // winner's pointer) and rolls back before appending its event.
    const now = new Date();
    const updatedRows = await tx
      .update(admissionsCases)
      .set({ committedListItemId: item.id, updatedAt: now })
      .where(and(
        eq(admissionsCases.id, caseRow.id),
        isNull(admissionsCases.committedListItemId),
      ))
      .returning({ id: admissionsCases.id });
    if (updatedRows.length === 0) throw new Error("Conflict");

    const eventDate = input.eventDate ?? getBangkokDateKey(now);
    await tx.insert(admissionsApplicationEvents).values({
      listItemId: item.id,
      event: "committed",
      eventDate,
      notes: null,
    });

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "case",
      entityId: caseRow.id,
      action: "commit_college",
      diff: {
        committedListItemId: { old: null, new: item.id },
        eventDate: { old: null, new: eventDate },
      },
    });

    return { caseId: caseRow.id, committedListItemId: item.id, updatedAt: now.toISOString() };
  }, db);
}

/** clearCommittedCollege input; `access` must come from requireCaseAccess. */
export interface ClearCommittedCollegeInput {
  access: CaseAccess;
}

/**
 * Clears a case's committed pointer (CM-44), e.g. before committing to a
 * different college. Counselor+ only; audited atomically. Idempotent no-op
 * when nothing is committed. The historical "committed" event stays in the
 * chain (append-only, CM-43).
 *
 * @returns the caseId, a null committed pointer, and the case updatedAt.
 */
export async function clearCommittedCollege(
  input: ClearCommittedCollegeInput,
  db: Database = getDb(),
): Promise<CommittedCollegeResult> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");

  return withAuditedTransaction(async (tx) => {
    const caseRow = await findLiveCase(tx, input.access.caseId);

    if (caseRow.committedListItemId === null) {
      return {
        caseId: caseRow.id,
        committedListItemId: null,
        updatedAt: caseRow.updatedAt.toISOString(),
      };
    }

    const now = new Date();
    await tx
      .update(admissionsCases)
      .set({ committedListItemId: null, updatedAt: now })
      .where(eq(admissionsCases.id, caseRow.id));

    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "case",
      entityId: caseRow.id,
      action: "clear_committed_college",
      diff: { committedListItemId: { old: caseRow.committedListItemId, new: null } },
    });

    return { caseId: caseRow.id, committedListItemId: null, updatedAt: now.toISOString() };
  }, db);
}

// ── Warnings (CM-45) ────────────────────────────────────────────────────

/** Warning codes for application-plan conflicts (CM-45). */
export type ApplicationWarningCode = "multiple_early_decision" | "rea_with_early_decision";

/** One WARN-only application-plan validation result (never blocks). */
export interface ApplicationWarning {
  code: ApplicationWarningCode;
  message: string;
  listItemIds: string[];
}

/**
 * Minimal item shape for computeApplicationWarnings. `latestEvent` is the
 * item's newest decision event (see deriveLatestEvents); "denied" and
 * "withdrawn" deactivate an item for warning purposes.
 */
export interface ApplicationWarningItem {
  id: string;
  round: AdmissionsAppRound;
  latestEvent?: AdmissionsDecisionEvent | null;
}

/**
 * WARN-only application-plan validation (CM-45) — pure, never throws, never
 * blocks a write. An item is ACTIVE unless its latest decision event is
 * "denied" or "withdrawn" (so ED-denied → ED2 is a legal, warning-free plan):
 *
 * - multiple_early_decision: more than one active ED/ED2 item.
 * - rea_with_early_decision: any active REA alongside any active ED/ED2
 *   (REA programs prohibit concurrent binding early applications).
 *
 * @returns zero or more warnings, each listing the offending item ids.
 */
export function computeApplicationWarnings(
  items: readonly ApplicationWarningItem[],
): ApplicationWarning[] {
  const active = items.filter(
    (item) => item.latestEvent !== "denied" && item.latestEvent !== "withdrawn",
  );
  const edItems = active.filter((item) => item.round === "ed" || item.round === "ed2");
  const reaItems = active.filter((item) => item.round === "rea");

  const warnings: ApplicationWarning[] = [];
  if (edItems.length > 1) {
    warnings.push({
      code: "multiple_early_decision",
      message:
        "More than one active Early Decision application (ED/ED2) — only one binding ED commitment is allowed at a time.",
      listItemIds: edItems.map((item) => item.id),
    });
  }
  if (reaItems.length > 0 && edItems.length > 0) {
    warnings.push({
      code: "rea_with_early_decision",
      message:
        "Restrictive Early Action alongside an Early Decision application — REA programs prohibit concurrent ED applications.",
      listItemIds: [...reaItems, ...edItems].map((item) => item.id),
    });
  }
  return warnings;
}

// ── Calendar collector (application deadlines) ──────────────────────────

/**
 * One application-deadline entry in the calendar aggregator's collector
 * contract (design §8: one collector per dated-item source): a CalendarItem
 * WITHOUT `overdue` (the aggregator stamps it against today centrally) plus
 * the `completed` flag the aggregator uses to drop finished items from the
 * deadlines panel.
 */
export interface ApplicationDeadlineEntry {
  /** Source row id (the admissions_college_list_items id). */
  id: string;
  caseId: string;
  source: "application";
  title: string;
  /** The application-round deadline, "YYYY-MM-DD". */
  date: string;
  /** Application deadlines are not owner-assigned tasks. */
  ownerRole: null;
  /** True when the application no longer needs the deadline (submitted/complete). */
  completed: boolean;
}

/**
 * Batch collector feeding the calendar aggregator (calendar.ts registers it
 * as the "application" source): every live list item with a deadline across
 * the requested cases, one query for the whole batch (keeps the cross-case
 * caseload view at one query per source, CM-101).
 *
 * Non-uuid-shaped caseIds are dropped (fail-closed skip); empty input returns
 * [] without a query. Rows with malformed stored deadlines are skipped, never
 * guessed. Entries are titled "{instName} — {round label} deadline" and are
 * NOT sorted or window-filtered — the aggregator owns both.
 */
export async function collectApplicationDeadlineEntries(
  caseIds: readonly string[],
  db: Database = getDb(),
): Promise<ApplicationDeadlineEntry[]> {
  const validCaseIds = caseIds.filter((id) => isUuidShaped(id));
  if (validCaseIds.length === 0) return [];

  const rows = await db
    .select({
      id: admissionsCollegeListItems.id,
      caseId: admissionsCollegeListItems.caseId,
      instName: admissionsCollegeListItems.instName,
      round: admissionsCollegeListItems.round,
      deadline: admissionsCollegeListItems.deadline,
      appStatus: admissionsCollegeListItems.appStatus,
    })
    .from(admissionsCollegeListItems)
    .where(and(
      inArray(admissionsCollegeListItems.caseId, validCaseIds),
      isNull(admissionsCollegeListItems.deletedAt),
      isNotNull(admissionsCollegeListItems.deadline),
    ));

  const entries: ApplicationDeadlineEntry[] = [];
  for (const row of rows) {
    if (row.deadline === null || !DATE_ONLY_PATTERN.test(row.deadline)) continue;
    entries.push({
      id: row.id,
      caseId: row.caseId,
      source: "application",
      title: `${row.instName} — ${ADMISSIONS_APP_ROUND_LABELS[row.round]} deadline`,
      date: row.deadline,
      ownerRole: null,
      completed: row.appStatus === "submitted" || row.appStatus === "complete",
    });
  }
  return entries;
}

/**
 * CalendarItem-shaped row for application deadlines (source "application").
 * `completed` mirrors the calendar module's internal collector contract so
 * the integration that registers this source in calendar.ts can drop
 * completed rows from the deadlines panel; `overdue` is pre-stamped here.
 */
export interface CollegeDeadlineItem extends Omit<CalendarItem, "source"> {
  source: "application";
  /** True when the application is past needing the deadline (submitted/complete). */
  completed: boolean;
}

/**
 * Collects ONE case's application deadlines for an inclusive window —
 * CalendarItem-shaped rows with source "application". The calendar aggregator
 * uses the batch collectApplicationDeadlineEntries instead; this single-case
 * variant wraps it for direct window-scoped reads.
 *
 * 1. Validate the window ("YYYY-MM-DD" bounds, from <= to); malformed caseId
 *    → NotFound. Rows with malformed stored deadlines are skipped (fail-closed).
 * 2. Live list items with a deadline inside [from, to] become one row each,
 *    titled "{instName} — {round label} deadline".
 * 3. completed = appStatus submitted/complete; overdue = open AND the
 *    deadline is strictly before today (Bangkok). ownerRole is null
 *    (application deadlines are not owner-assigned tasks).
 *
 * @returns the window's deadline rows, earliest first (stable id tiebreak).
 */
export async function collectCollegeDeadlines(
  caseId: string,
  window: CalendarWindow,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<CollegeDeadlineItem[]> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  assertDateOnly(window.from, "from");
  assertDateOnly(window.to, "to");
  if (window.from > window.to) {
    throw new Error("Invalid calendar window: from must be on or before to");
  }

  const todayKey = getBangkokDateKey(now);
  const entries = await collectApplicationDeadlineEntries([caseId], db);
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
