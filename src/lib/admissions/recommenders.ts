// Admissions Case Management — recommender tracking, per-college submission
// status, college-doc sends, and the per-college completeness rollup.
//
// Design: docs/casemanagementsystem_design.md §1 (recommenders.ts module map
// row), §3 (admissions_recommenders / admissions_recommender_colleges /
// admissions_college_docs). PRD CM-46 (per-college completeness tracks
// recommenders, transcript, school report, and test-score sends), CM-50
// (recommenders per case with ask-status planned → asked → agreed → declined),
// CM-51 (per-college submission status per recommender).
//
// Core rules:
// - CM-50: askStatus is a forward-only state machine — planned → asked →
//   agreed | declined. agreed and declined are terminal. An invalid move
//   throws Error("Conflict"); a same-status write is a no-op, not a move.
// - CM-51: one link row per (recommender, college list item) — enforced by
//   the admissions_recommender_colleges_rec_item_idx unique index AND an
//   explicit pre-check; either path surfaces as Error("Conflict").
// - CM-46: college docs are keyed (listItemId, docType, testSittingId|null).
//   "score_send" rows require a testSittingId (one row per sitting sent);
//   "transcript"/"school_report" forbid one. setCollegeDoc is an upsert.
// - Cross-case integrity is fail-closed: a recommender is only ever linked
//   to a list item of the SAME case; a score send only ever references a
//   test sitting of the SAME case. Mismatches read as "NotFound" so callers
//   cannot probe another case's ids.
//
// Error contract (admissionsErrorResponse maps these): missing rows /
// malformed ids / cross-case references → Error("NotFound"); rule violations
// (invalid askStatus transition, duplicate link) → Error("Conflict");
// input-shape violations throw descriptive Errors (routes' Zod schemas are
// the 400 boundary). All mutations commit atomically with their audit row
// via withAuditedTransaction.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import {
  admissionsCollegeDocs,
  admissionsCollegeListItems,
  admissionsRecommenderColleges,
  admissionsRecommenders,
  admissionsTestSittings,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { isUniqueViolation } from "./cohorts";
import { isUuidShaped, type AdmissionsActor } from "./members";

type RecommenderRow = typeof admissionsRecommenders.$inferSelect;
type RecommenderCollegeRow = typeof admissionsRecommenderColleges.$inferSelect;
type CollegeDocRow = typeof admissionsCollegeDocs.$inferSelect;

// ── Types & validation ──────────────────────────────────────────────────

/** Recommender ask lifecycle (mirrors admissions_rec_status, CM-50). */
export type AdmissionsRecommenderAskStatus = "planned" | "asked" | "agreed" | "declined";

/** All valid ask statuses, for boundary validation. */
export const ADMISSIONS_RECOMMENDER_ASK_STATUSES: readonly AdmissionsRecommenderAskStatus[] = [
  "planned",
  "asked",
  "agreed",
  "declined",
];

/**
 * Forward-only ask-status machine (CM-50): planned → asked → agreed|declined.
 * agreed and declined are terminal (no outgoing moves). Keys are the current
 * status; values are the statuses it may move to.
 */
export const RECOMMENDER_ASK_STATUS_TRANSITIONS: Readonly<
  Record<AdmissionsRecommenderAskStatus, readonly AdmissionsRecommenderAskStatus[]>
> = {
  planned: ["asked"],
  asked: ["agreed", "declined"],
  agreed: [],
  declined: [],
};

/**
 * True when `from → to` is a legal ask-status move (CM-50). A same-status
 * "move" returns false — updateRecommender treats it as a no-op, not a
 * transition, so this predicate only answers "is this a real forward move".
 */
export function isValidAskStatusTransition(
  from: AdmissionsRecommenderAskStatus,
  to: AdmissionsRecommenderAskStatus,
): boolean {
  return RECOMMENDER_ASK_STATUS_TRANSITIONS[from].includes(to);
}

/** College-doc kinds tracked for per-college completeness (CM-46). */
export type AdmissionsCollegeDocType = "transcript" | "school_report" | "score_send";

/** All valid college-doc types, for boundary validation. */
export const ADMISSIONS_COLLEGE_DOC_TYPES: readonly AdmissionsCollegeDocType[] = [
  "transcript",
  "school_report",
  "score_send",
];

/** Type predicate for stored doc_type text (fail-closed reads skip unknowns). */
export function isAdmissionsCollegeDocType(value: string): value is AdmissionsCollegeDocType {
  return (ADMISSIONS_COLLEGE_DOC_TYPES as readonly string[]).includes(value);
}

/** One recommender row serialized for the recommenders tab (design §5.1). */
export interface AdmissionsRecommenderDto {
  id: string;
  caseId: string;
  name: string;
  roleSubject: string | null;
  contact: string | null;
  askStatus: AdmissionsRecommenderAskStatus;
  createdAt: string;
  updatedAt: string;
}

/** One recommender↔college link row with its submission state (CM-51). */
export interface AdmissionsRecommenderCollegeDto {
  id: string;
  recommenderId: string;
  listItemId: string;
  submitted: boolean;
  /** ISO instant of the submitted stamp; null while pending. */
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A recommender plus its per-college submission links (GET route payload). */
export interface AdmissionsRecommenderWithCollegesDto extends AdmissionsRecommenderDto {
  colleges: AdmissionsRecommenderCollegeDto[];
}

/** One college-doc row (transcript / school report / score send, CM-46). */
export interface AdmissionsCollegeDocDto {
  id: string;
  listItemId: string;
  docType: AdmissionsCollegeDocType;
  /** Set only for "score_send" rows — the sitting whose scores were sent. */
  testSittingId: string | null;
  sent: boolean;
  /** ISO instant of the sent stamp; null while pending. */
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-college completeness rollup entry (CM-46). */
export interface AdmissionsCollegeCompleteness {
  /** Linked live recommenders whose askStatus is "agreed". */
  recsAgreed: number;
  /** Linked live recommenders whose letter is submitted for this college. */
  recsSubmitted: number;
  /** All linked live recommenders for this college. */
  recsTotal: number;
  transcriptSent: boolean;
  schoolReportSent: boolean;
  /** Score-send doc rows marked sent for this college. */
  scoreSendsSent: number;
  complete: boolean;
}

// ── Internal helpers ────────────────────────────────────────────────────

function toRecommenderDto(row: RecommenderRow): AdmissionsRecommenderDto {
  return {
    id: row.id,
    caseId: row.caseId,
    name: row.name,
    roleSubject: row.roleSubject,
    contact: row.contact,
    askStatus: row.askStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRecommenderCollegeDto(row: RecommenderCollegeRow): AdmissionsRecommenderCollegeDto {
  return {
    id: row.id,
    recommenderId: row.recommenderId,
    listItemId: row.listItemId,
    submitted: row.submitted,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCollegeDocDto(row: CollegeDocRow, docType: AdmissionsCollegeDocType): AdmissionsCollegeDocDto {
  return {
    id: row.id,
    listItemId: row.listItemId,
    docType,
    testSittingId: row.testSittingId,
    sent: row.sent,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Trims optional free-text; empty/whitespace-only collapses to null. */
function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Loads a live recommender scoped to (recommenderId, caseId, not
 * soft-deleted). The caseId scope stops cross-case id probing; a miss throws
 * "NotFound".
 */
async function findLiveRecommender(
  db: AdmissionsWriteDb,
  recommenderId: string,
  caseId: string,
): Promise<RecommenderRow> {
  const rows = await db
    .select()
    .from(admissionsRecommenders)
    .where(and(
      eq(admissionsRecommenders.id, recommenderId),
      eq(admissionsRecommenders.caseId, caseId),
      isNull(admissionsRecommenders.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

/** Loads a live recommender by id alone (caseId is derived FROM the row). */
async function findLiveRecommenderById(
  db: AdmissionsWriteDb,
  recommenderId: string,
): Promise<RecommenderRow> {
  const rows = await db
    .select()
    .from(admissionsRecommenders)
    .where(and(
      eq(admissionsRecommenders.id, recommenderId),
      isNull(admissionsRecommenders.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

/** Loads a live college list item's (id, caseId); a miss throws "NotFound". */
async function findLiveListItem(
  db: AdmissionsWriteDb,
  listItemId: string,
): Promise<{ id: string; caseId: string }> {
  const rows = await db
    .select({
      id: admissionsCollegeListItems.id,
      caseId: admissionsCollegeListItems.caseId,
    })
    .from(admissionsCollegeListItems)
    .where(and(
      eq(admissionsCollegeListItems.id, listItemId),
      isNull(admissionsCollegeListItems.deletedAt),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("NotFound");
  return row;
}

// ── Recommender CRUD (CM-50) ────────────────────────────────────────────

/** createRecommender input (CM-50 fields). */
export interface CreateRecommenderInput {
  name: string;
  roleSubject?: string | null;
  contact?: string | null;
}

/**
 * Creates a recommender on a case (CM-50) with askStatus "planned". The
 * insert and its audit row commit atomically.
 *
 * 1. Shape-check caseId (NotFound on malformed); require a non-empty name.
 *    roleSubject/contact are trimmed; empty collapses to null.
 * 2. Insert the row (askStatus "planned" — every recommender starts at the
 *    head of the ask machine) and write one audit row (entityType
 *    "recommender", action "create").
 *
 * @returns the created recommender DTO.
 */
export async function createRecommender(
  caseId: string,
  input: CreateRecommenderInput,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsRecommenderDto> {
  if (!isUuidShaped(caseId)) throw new Error("NotFound");
  const name = input.name.trim();
  if (!name) throw new Error("Recommender name must not be empty");
  const roleSubject = normalizeOptionalText(input.roleSubject);
  const contact = normalizeOptionalText(input.contact);

  return withAuditedTransaction(async (tx) => {
    const rows = await tx
      .insert(admissionsRecommenders)
      .values({ caseId, name, roleSubject, contact, askStatus: "planned" })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Recommender insert returned no row");

    await writeAuditLog(tx, {
      caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "recommender",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        { name, roleSubject, contact, askStatus: "planned" },
        ["name", "roleSubject", "contact", "askStatus"],
      ),
    });

    return toRecommenderDto(row);
  }, db);
}

/** updateRecommender input — undefined fields are left untouched. */
export interface UpdateRecommenderInput {
  name?: string;
  roleSubject?: string | null;
  contact?: string | null;
  askStatus?: AdmissionsRecommenderAskStatus;
}

const RECOMMENDER_DIFF_FIELDS = ["name", "roleSubject", "contact", "askStatus"] as const;

/**
 * Partially updates a recommender (CM-50): name, roleSubject, contact, and
 * askStatus. The mutation and its audit diff commit atomically.
 *
 * askStatus follows the forward-only machine planned → asked →
 * agreed|declined: an illegal move (skipping "asked", leaving a terminal
 * state, or moving backwards) throws Error("Conflict") and writes nothing.
 * Re-sending the current status is a no-op, not a transition.
 *
 * 1. Shape-check ids; validate provided fields up front (non-empty name,
 *    known askStatus) — fail-closed, before any query.
 * 2. Load the live recommender scoped to (recommenderId, caseId) — a miss
 *    throws "NotFound".
 * 3. Enforce the askStatus machine; diff only the provided fields; nothing
 *    changed → no-op without writes.
 * 4. Apply the changed fields plus a fresh updatedAt and audit the diff
 *    (entityType "recommender", action "update").
 *
 * @returns the updated recommender DTO.
 */
export async function updateRecommender(
  caseId: string,
  recommenderId: string,
  input: UpdateRecommenderInput,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsRecommenderDto> {
  if (!isUuidShaped(caseId) || !isUuidShaped(recommenderId)) throw new Error("NotFound");

  let name: string | undefined;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (!name) throw new Error("Recommender name must not be empty");
  }
  if (
    input.askStatus !== undefined &&
    !ADMISSIONS_RECOMMENDER_ASK_STATUSES.includes(input.askStatus)
  ) {
    throw new Error(`Invalid askStatus: ${String(input.askStatus)}`);
  }
  const roleSubject = input.roleSubject === undefined
    ? undefined
    : normalizeOptionalText(input.roleSubject);
  const contact = input.contact === undefined
    ? undefined
    : normalizeOptionalText(input.contact);

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveRecommender(tx, recommenderId, caseId);

    if (
      input.askStatus !== undefined &&
      input.askStatus !== row.askStatus &&
      !isValidAskStatusTransition(row.askStatus, input.askStatus)
    ) {
      throw new Error("Conflict");
    }

    const diff = computeFieldDiff(
      row as unknown as Record<string, unknown>,
      { name, roleSubject, contact, askStatus: input.askStatus },
      RECOMMENDER_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toRecommenderDto(row);

    const setValues: Partial<typeof admissionsRecommenders.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ("name" in diff) setValues.name = name;
    if ("roleSubject" in diff) setValues.roleSubject = roleSubject;
    if ("contact" in diff) setValues.contact = contact;
    if ("askStatus" in diff) setValues.askStatus = input.askStatus;

    await tx
      .update(admissionsRecommenders)
      .set(setValues)
      .where(eq(admissionsRecommenders.id, row.id));

    await writeAuditLog(tx, {
      caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "recommender",
      entityId: row.id,
      action: "update",
      diff,
    });

    return toRecommenderDto({ ...row, ...setValues } as RecommenderRow);
  }, db);
}

/**
 * Soft-deletes a recommender (CM-50). Its per-college link rows are kept for
 * the audit trail but stop counting toward completeness — the rollup joins
 * on live recommenders only (fail-closed). The write and its audit row
 * commit atomically.
 */
export async function softDeleteRecommender(
  caseId: string,
  recommenderId: string,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<void> {
  if (!isUuidShaped(caseId) || !isUuidShaped(recommenderId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const row = await findLiveRecommender(tx, recommenderId, caseId);

    const now = new Date();
    await tx
      .update(admissionsRecommenders)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(admissionsRecommenders.id, row.id));

    await writeAuditLog(tx, {
      caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "recommender",
      entityId: row.id,
      action: "delete",
      diff: { deletedAt: { old: null, new: now.toISOString() } },
    });
  }, db);
}

/**
 * A case's live recommenders (createdAt order) with their per-college
 * submission links — the recommenders tab read (design §4
 * `/cases/[caseId]/recommenders` GET). Links pointing at any college are
 * included verbatim; malformed caseId fails closed to an empty list.
 */
export async function listRecommenders(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsRecommenderWithCollegesDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const recommenderRows = await db
    .select()
    .from(admissionsRecommenders)
    .where(and(
      eq(admissionsRecommenders.caseId, caseId),
      isNull(admissionsRecommenders.deletedAt),
    ))
    .orderBy(asc(admissionsRecommenders.createdAt), asc(admissionsRecommenders.name));
  if (recommenderRows.length === 0) return [];

  const linkRows = await db
    .select()
    .from(admissionsRecommenderColleges)
    .where(inArray(
      admissionsRecommenderColleges.recommenderId,
      recommenderRows.map((row) => row.id),
    ))
    .orderBy(asc(admissionsRecommenderColleges.createdAt));

  const linksByRecommender = new Map<string, AdmissionsRecommenderCollegeDto[]>();
  for (const link of linkRows) {
    const dto = toRecommenderCollegeDto(link);
    const list = linksByRecommender.get(link.recommenderId);
    if (list) list.push(dto);
    else linksByRecommender.set(link.recommenderId, [dto]);
  }

  return recommenderRows.map((row) => ({
    ...toRecommenderDto(row),
    colleges: linksByRecommender.get(row.id) ?? [],
  }));
}

// ── Per-college submissions (CM-51) ─────────────────────────────────────

/**
 * Links a recommender to a college list item (CM-51) — "this recommender
 * writes for this college". One link per pair: a duplicate throws
 * Error("Conflict") via the explicit pre-check, and a concurrent duplicate
 * insert is caught by the (recommenderId, listItemId) unique index and
 * mapped to the same "Conflict". The insert and its audit row commit
 * atomically.
 *
 * 1. Shape-check ids (NotFound on malformed).
 * 2. Load the live recommender and the live list item; either miss — or a
 *    list item belonging to a DIFFERENT case than the recommender — throws
 *    "NotFound" (cross-case links are never created, and foreign ids are
 *    not confirmed to exist).
 * 3. An existing (recommenderId, listItemId) link → Error("Conflict").
 * 4. Insert the link (submitted false) and audit it (entityType
 *    "recommender_college", action "link") under the recommender's case.
 *
 * @returns the created link DTO (submitted = false).
 */
export async function linkRecommenderToCollege(
  recommenderId: string,
  listItemId: string,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsRecommenderCollegeDto> {
  if (!isUuidShaped(recommenderId) || !isUuidShaped(listItemId)) throw new Error("NotFound");

  try {
    return await withAuditedTransaction(async (tx) => {
      const recommender = await findLiveRecommenderById(tx, recommenderId);
      const listItem = await findLiveListItem(tx, listItemId);
      if (listItem.caseId !== recommender.caseId) throw new Error("NotFound");

      const existingRows = await tx
        .select({ id: admissionsRecommenderColleges.id })
        .from(admissionsRecommenderColleges)
        .where(and(
          eq(admissionsRecommenderColleges.recommenderId, recommenderId),
          eq(admissionsRecommenderColleges.listItemId, listItemId),
        ))
        .limit(1);
      if (existingRows.length > 0) throw new Error("Conflict");

      const rows = await tx
        .insert(admissionsRecommenderColleges)
        .values({ recommenderId, listItemId, submitted: false, submittedAt: null })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("Recommender link insert returned no row");

      await writeAuditLog(tx, {
        caseId: recommender.caseId,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: "recommender_college",
        entityId: row.id,
        action: "link",
        diff: computeFieldDiff(
          {},
          { recommenderId, listItemId },
          ["recommenderId", "listItemId"],
        ),
      });

      return toRecommenderCollegeDto(row);
    }, db);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("Conflict");
    throw error;
  }
}

/**
 * Sets a recommender's submission state for one college (CM-51
 * pending/submitted). The write and its audit row commit atomically.
 *
 * 1. Shape-check ids; load the live recommender, the live list item (a
 *    soft-deleted item's submissions are frozen — fail-closed "NotFound";
 *    the caseId scope stops cross-case probing), then the link row (miss →
 *    "NotFound" — submission state exists only on linked pairs).
 * 2. Same state → no-op without writes.
 * 3. Marking submitted stamps submittedAt; unmarking clears it. Audited
 *    (entityType "recommender_college", action "submit"/"unsubmit").
 *
 * @returns the updated link DTO.
 */
export async function setRecommenderSubmission(
  recommenderId: string,
  listItemId: string,
  submitted: boolean,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsRecommenderCollegeDto> {
  if (!isUuidShaped(recommenderId) || !isUuidShaped(listItemId)) throw new Error("NotFound");

  return withAuditedTransaction(async (tx) => {
    const recommender = await findLiveRecommenderById(tx, recommenderId);
    const listItem = await findLiveListItem(tx, listItemId);
    if (listItem.caseId !== recommender.caseId) throw new Error("NotFound");

    const linkRows = await tx
      .select()
      .from(admissionsRecommenderColleges)
      .where(and(
        eq(admissionsRecommenderColleges.recommenderId, recommenderId),
        eq(admissionsRecommenderColleges.listItemId, listItemId),
      ))
      .limit(1);
    const link = linkRows[0];
    if (!link) throw new Error("NotFound");

    if (link.submitted === submitted) return toRecommenderCollegeDto(link);

    const now = new Date();
    const setValues = {
      submitted,
      submittedAt: submitted ? now : null,
      updatedAt: now,
    };
    await tx
      .update(admissionsRecommenderColleges)
      .set(setValues)
      .where(eq(admissionsRecommenderColleges.id, link.id));

    await writeAuditLog(tx, {
      caseId: recommender.caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "recommender_college",
      entityId: link.id,
      action: submitted ? "submit" : "unsubmit",
      diff: computeFieldDiff(
        {
          submitted: link.submitted,
          submittedAt: link.submittedAt ? link.submittedAt.toISOString() : null,
        },
        {
          submitted,
          submittedAt: setValues.submittedAt ? setValues.submittedAt.toISOString() : null,
        },
        ["submitted", "submittedAt"],
      ),
    });

    return toRecommenderCollegeDto({ ...link, ...setValues });
  }, db);
}

// ── College docs (CM-46) ────────────────────────────────────────────────

/** setCollegeDoc input: the sent flag plus the sitting for score sends. */
export interface SetCollegeDocInput {
  sent: boolean;
  /** Required for docType "score_send"; forbidden for the other doc types. */
  testSittingId?: string | null;
}

/**
 * Upserts one college-doc row (CM-46): the send state of a transcript,
 * school report, or per-sitting score send for one college list item. The
 * upsert key is (listItemId, docType, testSittingId|null) — transcript and
 * school report have at most one row per college; score sends have one row
 * per test sitting. The write and its audit row commit atomically.
 *
 * 1. Validate docType (fail-closed, never guessed) and shape-check ids.
 *    "score_send" REQUIRES a testSittingId (a score send is meaningless
 *    without the sitting whose scores were sent); "transcript" and
 *    "school_report" FORBID one.
 * 2. Load the live list item (miss → "NotFound"). For score sends, the
 *    referenced test sitting must exist and belong to the SAME case as the
 *    list item (miss or mismatch → "NotFound").
 * 3. Existing row for the key → update sent/sentAt (no-op when unchanged);
 *    no row → insert. Marking sent stamps sentAt; unmarking clears it.
 * 4. Audit under the list item's case (entityType "college_doc", action
 *    "create"/"update").
 *
 * @returns the upserted doc DTO.
 */
export async function setCollegeDoc(
  listItemId: string,
  docType: AdmissionsCollegeDocType,
  input: SetCollegeDocInput,
  actor: AdmissionsActor,
  db: Database = getDb(),
): Promise<AdmissionsCollegeDocDto> {
  if (!isAdmissionsCollegeDocType(docType)) {
    throw new Error(`Invalid docType: ${String(docType)}`);
  }
  if (!isUuidShaped(listItemId)) throw new Error("NotFound");
  const testSittingId = input.testSittingId ?? null;
  if (docType === "score_send") {
    if (testSittingId === null) throw new Error("score_send requires a testSittingId");
    if (!isUuidShaped(testSittingId)) throw new Error("NotFound");
  } else if (testSittingId !== null) {
    throw new Error(`testSittingId is only valid for score_send (got docType "${docType}")`);
  }

  return withAuditedTransaction(async (tx) => {
    const listItem = await findLiveListItem(tx, listItemId);

    if (testSittingId !== null) {
      const sittingRows = await tx
        .select({
          id: admissionsTestSittings.id,
          caseId: admissionsTestSittings.caseId,
        })
        .from(admissionsTestSittings)
        .where(eq(admissionsTestSittings.id, testSittingId))
        .limit(1);
      const sitting = sittingRows[0];
      if (!sitting || sitting.caseId !== listItem.caseId) throw new Error("NotFound");
    }

    const existingRows = await tx
      .select()
      .from(admissionsCollegeDocs)
      .where(and(
        eq(admissionsCollegeDocs.listItemId, listItemId),
        eq(admissionsCollegeDocs.docType, docType),
        testSittingId === null
          ? isNull(admissionsCollegeDocs.testSittingId)
          : eq(admissionsCollegeDocs.testSittingId, testSittingId),
      ))
      .limit(1);
    const existing = existingRows[0];

    const now = new Date();
    if (existing) {
      if (existing.sent === input.sent) return toCollegeDocDto(existing, docType);

      const setValues = {
        sent: input.sent,
        sentAt: input.sent ? now : null,
        updatedAt: now,
      };
      await tx
        .update(admissionsCollegeDocs)
        .set(setValues)
        .where(eq(admissionsCollegeDocs.id, existing.id));

      await writeAuditLog(tx, {
        caseId: listItem.caseId,
        actorEmail: actor.email,
        actorRole: actor.role,
        entityType: "college_doc",
        entityId: existing.id,
        action: "update",
        diff: computeFieldDiff(
          { sent: existing.sent },
          { sent: input.sent },
          ["sent"],
        ),
      });

      return toCollegeDocDto({ ...existing, ...setValues }, docType);
    }

    const rows = await tx
      .insert(admissionsCollegeDocs)
      .values({
        listItemId,
        docType,
        testSittingId,
        sent: input.sent,
        sentAt: input.sent ? now : null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("College doc insert returned no row");

    await writeAuditLog(tx, {
      caseId: listItem.caseId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entityType: "college_doc",
      entityId: row.id,
      action: "create",
      diff: computeFieldDiff(
        {},
        { docType, testSittingId, sent: input.sent },
        ["docType", "testSittingId", "sent"],
      ),
    });

    return toCollegeDocDto(row, docType);
  }, db);
}

/**
 * All college-doc rows across a case's live list items (CM-46) — the
 * documents column of the college list tab. Rows whose stored doc_type is
 * not a known type are skipped (fail-closed) rather than guessed. Malformed
 * caseId fails closed to an empty list.
 */
export async function listCollegeDocs(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsCollegeDocDto[]> {
  if (!isUuidShaped(caseId)) return [];

  const rows = await db
    .select({ doc: admissionsCollegeDocs })
    .from(admissionsCollegeDocs)
    .innerJoin(
      admissionsCollegeListItems,
      eq(admissionsCollegeDocs.listItemId, admissionsCollegeListItems.id),
    )
    .where(and(
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    ))
    .orderBy(asc(admissionsCollegeDocs.createdAt));

  const docs: AdmissionsCollegeDocDto[] = [];
  for (const { doc } of rows) {
    if (!isAdmissionsCollegeDocType(doc.docType)) continue;
    docs.push(toCollegeDocDto(doc, doc.docType));
  }
  return docs;
}

// ── Completeness rollup (CM-46) ─────────────────────────────────────────

/** Raw per-college tallies feeding the completeness rule. */
export interface CollegeCompletenessCounts {
  recsAgreed: number;
  recsSubmitted: number;
  recsTotal: number;
  transcriptSent: boolean;
  schoolReportSent: boolean;
  /** Score-send doc rows marked sent. */
  scoreSendsSent: number;
  /** ALL score-send doc rows (sent or not) — drives the conditional rule. */
  scoreSendsTotal: number;
}

/**
 * Pure completeness rule (CM-46). A college is complete when ALL of:
 *
 * 1. every linked recommender has submitted — vacuously satisfied when the
 *    college has ZERO linked recommenders (no recommenders required means
 *    nothing is outstanding);
 * 2. the transcript has been sent;
 * 3. the school report has been sent;
 * 4. every score-send row is sent — score sends count ONLY when at least
 *    one score_send doc row exists for the college. A college with no
 *    score-send rows can still be complete (test-optional applications
 *    never create one); once any score send is recorded, all of them must
 *    be sent.
 *
 * Ask-status (recsAgreed) is surfaced for the UI but does NOT gate
 * completeness — submission is the ground truth of a delivered letter.
 */
export function computeCompletenessEntry(
  counts: CollegeCompletenessCounts,
): AdmissionsCollegeCompleteness {
  const recsDone = counts.recsTotal === 0 || counts.recsSubmitted >= counts.recsTotal;
  const scoreSendsDone =
    counts.scoreSendsTotal === 0 || counts.scoreSendsSent >= counts.scoreSendsTotal;
  return {
    recsAgreed: counts.recsAgreed,
    recsSubmitted: counts.recsSubmitted,
    recsTotal: counts.recsTotal,
    transcriptSent: counts.transcriptSent,
    schoolReportSent: counts.schoolReportSent,
    scoreSendsSent: counts.scoreSendsSent,
    complete: recsDone && counts.transcriptSent && counts.schoolReportSent && scoreSendsDone,
  };
}

/**
 * Per-college completeness rollup for one case (CM-46): recommender
 * submissions + transcript/school-report/score sends per live list item.
 * Every live list item is seeded with a zero entry so callers never hit a
 * missing key; the completeness rule itself lives in
 * computeCompletenessEntry (see its JSDoc for the zero-recommender and
 * no-score-send edge rules). Only LIVE recommenders count — soft-deleted
 * recommenders' link rows are excluded (fail-closed). Malformed caseId
 * fails closed to an empty Map.
 *
 * @returns Map of listItemId → completeness entry.
 */
export async function computeCollegeCompleteness(
  caseId: string,
  db: Database = getDb(),
): Promise<Map<string, AdmissionsCollegeCompleteness>> {
  const completenessByItem = new Map<string, AdmissionsCollegeCompleteness>();
  if (!isUuidShaped(caseId)) return completenessByItem;

  const itemRows = await db
    .select({ id: admissionsCollegeListItems.id })
    .from(admissionsCollegeListItems)
    .where(and(
      eq(admissionsCollegeListItems.caseId, caseId),
      isNull(admissionsCollegeListItems.deletedAt),
    ));
  if (itemRows.length === 0) return completenessByItem;
  const itemIds = itemRows.map((row) => row.id);

  const countsByItem = new Map<string, CollegeCompletenessCounts>();
  for (const id of itemIds) {
    countsByItem.set(id, {
      recsAgreed: 0,
      recsSubmitted: 0,
      recsTotal: 0,
      transcriptSent: false,
      schoolReportSent: false,
      scoreSendsSent: 0,
      scoreSendsTotal: 0,
    });
  }

  const linkRows = await db
    .select({
      listItemId: admissionsRecommenderColleges.listItemId,
      submitted: admissionsRecommenderColleges.submitted,
      askStatus: admissionsRecommenders.askStatus,
    })
    .from(admissionsRecommenderColleges)
    .innerJoin(
      admissionsRecommenders,
      eq(admissionsRecommenderColleges.recommenderId, admissionsRecommenders.id),
    )
    .where(and(
      eq(admissionsRecommenders.caseId, caseId),
      isNull(admissionsRecommenders.deletedAt),
      inArray(admissionsRecommenderColleges.listItemId, itemIds),
    ));
  for (const link of linkRows) {
    const counts = countsByItem.get(link.listItemId);
    if (!counts) continue;
    counts.recsTotal += 1;
    if (link.submitted) counts.recsSubmitted += 1;
    if (link.askStatus === "agreed") counts.recsAgreed += 1;
  }

  const docRows = await db
    .select({
      listItemId: admissionsCollegeDocs.listItemId,
      docType: admissionsCollegeDocs.docType,
      sent: admissionsCollegeDocs.sent,
    })
    .from(admissionsCollegeDocs)
    .where(inArray(admissionsCollegeDocs.listItemId, itemIds));
  for (const doc of docRows) {
    const counts = countsByItem.get(doc.listItemId);
    if (!counts) continue;
    if (doc.docType === "transcript") {
      if (doc.sent) counts.transcriptSent = true;
    } else if (doc.docType === "school_report") {
      if (doc.sent) counts.schoolReportSent = true;
    } else if (doc.docType === "score_send") {
      counts.scoreSendsTotal += 1;
      if (doc.sent) counts.scoreSendsSent += 1;
    }
    // Unknown stored docType: ignored (fail-closed — never guessed).
  }

  for (const [itemId, counts] of countsByItem) {
    completenessByItem.set(itemId, computeCompletenessEntry(counts));
  }
  return completenessByItem;
}
