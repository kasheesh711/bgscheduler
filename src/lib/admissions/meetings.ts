// Admissions Case Management — meeting log, action-item task creation, last-touch.
//
// Design: docs/casemanagementsystem_design.md §1 (meetings.ts owns the meeting
// log + action-item task creation + last-touch) and §3 (admissions_case_meetings,
// admissions_case_tasks). PRD: CM-30 (first-class meeting log), CM-31 (action
// items create tasks with owners and due dates), CM-32 ("days since last
// touch" feeds caseload triage). Meeting mutations commit atomically with
// their audit row via withAuditedTransaction.

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db";
import { admissionsCaseMeetings, admissionsCaseTasks } from "@/lib/db/schema";
import { BANGKOK_TIME_ZONE } from "@/lib/bangkok-time";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsFieldDiff,
} from "./audit";
import {
  ADMISSIONS_TASK_OWNERS,
  MEETING_ACTION_ITEM_PHASE,
  type AdmissionsTaskOwner,
} from "./shared/meetings";
import type { AdmissionsMeetingDto, CaseRole } from "./types";

// Task-owner and action-item constants live in the client-safe shared module
// (shared/meetings.ts); this module re-exports them so existing consumers
// keep importing from "./meetings".
export { ADMISSIONS_TASK_OWNERS, MEETING_ACTION_ITEM_PHASE } from "./shared/meetings";
export type { AdmissionsTaskOwner } from "./shared/meetings";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const MEETING_DIFF_FIELDS = [
  "meetingDate",
  "mode",
  "attendees",
  "notes",
  "nextMeetingDate",
] as const;

type MeetingRow = typeof admissionsCaseMeetings.$inferSelect;

/** One action item logged during a meeting; becomes a checklist task (CM-31). */
export interface MeetingActionItemInput {
  title: string;
  owner: AdmissionsTaskOwner;
  dueDate: string | null;
}

/** Input for createMeeting; actor fields feed the paired audit row. */
export interface CreateMeetingInput {
  caseId: string;
  actorEmail: string;
  actorRole: CaseRole;
  meetingDate: string;
  mode?: string | null;
  attendees?: string[];
  notes?: string | null;
  nextMeetingDate?: string | null;
  actionItems?: MeetingActionItemInput[];
}

/** createMeeting result: the meeting plus the task ids its action items created. */
export interface CreateMeetingResult {
  meeting: AdmissionsMeetingDto;
  createdTaskIds: string[];
}

/** Partial-update input for updateMeeting; undefined fields are untouched. */
export interface UpdateMeetingInput {
  caseId: string;
  meetingId: string;
  actorEmail: string;
  actorRole: CaseRole;
  meetingDate?: string;
  mode?: string | null;
  attendees?: string[];
  notes?: string | null;
  nextMeetingDate?: string | null;
}

function toMeetingDto(row: MeetingRow): AdmissionsMeetingDto {
  return {
    id: row.id,
    caseId: row.caseId,
    meetingDate: row.meetingDate,
    mode: row.mode,
    attendees: Array.isArray(row.attendees) ? row.attendees : [],
    notes: row.notes,
    nextMeetingDate: row.nextMeetingDate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertDateOnly(value: string, field: string): void {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected "YYYY-MM-DD"`);
  }
}

/** Asia/Bangkok calendar date ("YYYY-MM-DD") for an instant. */
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

/**
 * Logs a meeting and creates one checklist task per action item (CM-30/CM-31).
 *
 * 1. Validate up front, before any write: meetingDate/nextMeetingDate and
 *    action-item due dates must be "YYYY-MM-DD"; action-item titles must be
 *    non-empty; owners must be a known admissions_task_owner (fail-closed —
 *    an unknown owner rejects the whole call, it is never guessed).
 * 2. Inside one audited transaction, insert the admissions_case_meetings row.
 * 3. Insert one admissions_case_tasks row per action item: phase
 *    MEETING_ACTION_ITEM_PHASE ("custom"), null itemKey (no template
 *    linkage), owner/dueDate from the item, sortOrder = item index.
 * 4. Write one append-only audit row (entityType "meeting", action "create");
 *    created task ids are recorded in the diff so the meeting→task linkage
 *    survives in the audit trail.
 *
 * @returns the created meeting DTO plus the created action-item task ids.
 */
export async function createMeeting(
  input: CreateMeetingInput,
  db: Database = getDb(),
): Promise<CreateMeetingResult> {
  assertDateOnly(input.meetingDate, "meetingDate");
  if (input.nextMeetingDate != null) assertDateOnly(input.nextMeetingDate, "nextMeetingDate");
  const actionItems = input.actionItems ?? [];
  for (const item of actionItems) {
    if (!item.title.trim()) throw new Error("Action item title must not be empty");
    if (!ADMISSIONS_TASK_OWNERS.includes(item.owner)) {
      throw new Error(`Invalid action item owner: ${String(item.owner)}`);
    }
    if (item.dueDate != null) assertDateOnly(item.dueDate, "action item dueDate");
  }

  return withAuditedTransaction(async (tx) => {
    const meetingRows = await tx
      .insert(admissionsCaseMeetings)
      .values({
        caseId: input.caseId,
        meetingDate: input.meetingDate,
        mode: input.mode ?? null,
        attendees: input.attendees ?? [],
        notes: input.notes ?? null,
        nextMeetingDate: input.nextMeetingDate ?? null,
      })
      .returning();
    const meetingRow = meetingRows[0];
    if (!meetingRow) throw new Error("Failed to insert meeting");

    const createdTaskIds: string[] = [];
    for (const [index, item] of actionItems.entries()) {
      const taskRows = await tx
        .insert(admissionsCaseTasks)
        .values({
          caseId: input.caseId,
          itemKey: null,
          phase: MEETING_ACTION_ITEM_PHASE,
          title: item.title.trim(),
          owner: item.owner,
          dueDate: item.dueDate,
          sortOrder: index,
        })
        .returning();
      const taskRow = taskRows[0];
      if (!taskRow) throw new Error("Failed to insert action item task");
      createdTaskIds.push(taskRow.id);
    }

    const diff: AdmissionsFieldDiff | null = createdTaskIds.length > 0
      ? { actionItemTaskIds: { old: null, new: createdTaskIds } }
      : null;
    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "meeting",
      entityId: meetingRow.id,
      action: "create",
      diff,
    });

    return { meeting: toMeetingDto(meetingRow), createdTaskIds };
  }, db);
}

/**
 * Lists a case's non-deleted meetings, most recent first (meetingDate desc,
 * then createdAt desc as a same-day tiebreak).
 */
export async function listMeetings(
  caseId: string,
  db: Database = getDb(),
): Promise<AdmissionsMeetingDto[]> {
  const rows = await db
    .select()
    .from(admissionsCaseMeetings)
    .where(and(
      eq(admissionsCaseMeetings.caseId, caseId),
      isNull(admissionsCaseMeetings.deletedAt),
    ))
    .orderBy(desc(admissionsCaseMeetings.meetingDate), desc(admissionsCaseMeetings.createdAt));
  return rows.map(toMeetingDto);
}

/**
 * Partially updates a meeting log row; the mutation and its audit row commit
 * atomically.
 *
 * 1. Validate any provided dates up front ("YYYY-MM-DD").
 * 2. Load the meeting scoped to (meetingId, caseId, not soft-deleted); a miss
 *    throws "NotFound" (routes translate to 404) — the caseId scope stops
 *    cross-case meetingId probing.
 * 3. Diff only the provided fields against the current row; when nothing
 *    actually changed, return the current DTO without writing (no empty
 *    audit rows).
 * 4. Apply the changed fields plus a fresh updatedAt, then write one audit
 *    row (entityType "meeting", action "update") carrying the field diff.
 *
 * @returns the updated meeting DTO.
 */
export async function updateMeeting(
  input: UpdateMeetingInput,
  db: Database = getDb(),
): Promise<AdmissionsMeetingDto> {
  if (input.meetingDate !== undefined) assertDateOnly(input.meetingDate, "meetingDate");
  if (input.nextMeetingDate != null) assertDateOnly(input.nextMeetingDate, "nextMeetingDate");

  return withAuditedTransaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(admissionsCaseMeetings)
      .where(and(
        eq(admissionsCaseMeetings.id, input.meetingId),
        eq(admissionsCaseMeetings.caseId, input.caseId),
        isNull(admissionsCaseMeetings.deletedAt),
      ))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("NotFound");

    const diff = computeFieldDiff(
      existing as unknown as Record<string, unknown>,
      {
        meetingDate: input.meetingDate,
        mode: input.mode,
        attendees: input.attendees,
        notes: input.notes,
        nextMeetingDate: input.nextMeetingDate,
      },
      MEETING_DIFF_FIELDS,
    );
    if (Object.keys(diff).length === 0) return toMeetingDto(existing);

    const setValues: Partial<typeof admissionsCaseMeetings.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ("meetingDate" in diff) setValues.meetingDate = input.meetingDate;
    if ("mode" in diff) setValues.mode = input.mode;
    if ("attendees" in diff) setValues.attendees = input.attendees;
    if ("notes" in diff) setValues.notes = input.notes;
    if ("nextMeetingDate" in diff) setValues.nextMeetingDate = input.nextMeetingDate;

    const updatedRows = await tx
      .update(admissionsCaseMeetings)
      .set(setValues)
      .where(eq(admissionsCaseMeetings.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error("NotFound");

    await writeAuditLog(tx, {
      caseId: input.caseId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      entityType: "meeting",
      entityId: existing.id,
      action: "update",
      diff,
    });

    return toMeetingDto(updated);
  }, db);
}

/**
 * Pure last-touch math (CM-32): whole days between the most recent
 * past-or-today meeting date and "today" on the Asia/Bangkok calendar.
 *
 * 1. Derive today's Bangkok calendar date from `now`.
 * 2. Keep only well-formed "YYYY-MM-DD" dates that are <= today — a logged
 *    future meeting is a plan, not a touch, and malformed dates are skipped
 *    rather than guessed (fail-closed).
 * 3. No eligible date → null; otherwise today minus the latest eligible date
 *    in whole days (0 = touched today).
 */
export function computeDaysSinceLastTouch(
  meetingDates: readonly string[],
  now: Date = new Date(),
): number | null {
  const today = getBangkokDateKey(now);
  let latest: string | null = null;
  for (const value of meetingDates) {
    if (!DATE_ONLY_PATTERN.test(value)) continue;
    if (value > today) continue;
    if (latest === null || value > latest) latest = value;
  }
  if (latest === null) return null;
  const diffMs = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest}T00:00:00Z`);
  return Math.round(diffMs / MS_PER_DAY);
}

/**
 * "Days since last touch" for one case (CM-32): reads the case's non-deleted
 * meeting dates and applies computeDaysSinceLastTouch. Null when the case has
 * no past-or-today meeting.
 */
export async function getDaysSinceLastTouch(
  caseId: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<number | null> {
  const rows = await db
    .select({ meetingDate: admissionsCaseMeetings.meetingDate })
    .from(admissionsCaseMeetings)
    .where(and(
      eq(admissionsCaseMeetings.caseId, caseId),
      isNull(admissionsCaseMeetings.deletedAt),
    ));
  return computeDaysSinceLastTouch(rows.map((row) => row.meetingDate), now);
}

/**
 * Batch last-touch for caseload triage (CM-32): one query across all
 * requested cases.
 *
 * 1. Seed every requested caseId with null so callers can render "never
 *    touched" without a missing-key branch; empty input skips the query.
 * 2. Fetch non-deleted meeting dates for the requested cases in one
 *    inArray query and group them per case.
 * 3. Apply computeDaysSinceLastTouch per case.
 *
 * @returns Map of caseId → days since last touch (null = no past meeting).
 */
export async function getLastTouchMap(
  caseIds: readonly string[],
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<Map<string, number | null>> {
  const lastTouchByCase = new Map<string, number | null>();
  for (const caseId of caseIds) lastTouchByCase.set(caseId, null);
  if (caseIds.length === 0) return lastTouchByCase;

  const rows = await db
    .select({
      caseId: admissionsCaseMeetings.caseId,
      meetingDate: admissionsCaseMeetings.meetingDate,
    })
    .from(admissionsCaseMeetings)
    .where(and(
      inArray(admissionsCaseMeetings.caseId, [...caseIds]),
      isNull(admissionsCaseMeetings.deletedAt),
    ));

  const datesByCase = new Map<string, string[]>();
  for (const row of rows) {
    const dates = datesByCase.get(row.caseId);
    if (dates) dates.push(row.meetingDate);
    else datesByCase.set(row.caseId, [row.meetingDate]);
  }
  for (const [caseId, dates] of datesByCase) {
    lastTouchByCase.set(caseId, computeDaysSinceLastTouch(dates, now));
  }
  return lastTouchByCase;
}
