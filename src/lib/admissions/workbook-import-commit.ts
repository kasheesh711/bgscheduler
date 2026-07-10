import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb, type Database } from "@/lib/db";
import {
  admissionsActivities,
  admissionsAcademicRecords,
  admissionsAwards,
  admissionsCases,
  admissionsCaseMeetings,
  admissionsCaseTasks,
  admissionsCohorts,
  admissionsCollegeListItems,
  admissionsCollegeDocs,
  admissionsCollegeRequirements,
  admissionsCollegeResearch,
  admissionsEssays,
  admissionsFinancialAidOffers,
  admissionsImportIssues,
  admissionsImportMappings,
  admissionsImportRuns,
  admissionsInterestEvents,
  admissionsScholarships,
  admissionsSelfReportSections,
  admissionsStudents,
  admissionsTestSittings,
} from "@/lib/db/schema";
import {
  computeFieldDiff,
  withAuditedTransaction,
  writeAuditLog,
  type AdmissionsWriteDb,
} from "./audit";
import { roleAtLeast } from "./config";
import { todayBangkok } from "@/lib/room-capacity/dates";
import {
  ADMISSIONS_ACTIVITY_GRADES,
  COMMON_APP_HOURS_PER_WEEK_MAX,
  COMMON_APP_WEEKS_PER_YEAR_MAX,
  MAX_ACTIVE_ACTIVITIES_PER_CASE,
  UC_ACTIVITY_CATEGORIES,
  type AdmissionsCommonAppBlock,
  type AdmissionsUcBlock,
  type UcActivityCategory,
} from "./shared/activities";
import type { CaseAccess } from "./types";
import type {
  AdmissionsImportIssue,
  AdmissionsWorkbookPreview,
  ImportedApplication,
  ImportedFinancialAidOffer,
} from "./workbook-import";
import {
  ADMISSIONS_WORKBOOK_RANGES,
  deriveCanonicalStudentProfile,
  deriveImportedUsAcademicPayload,
  extractAdmissionsSpreadsheetId,
  normalizeImportedSentStatus,
  normalizeImportedTestScoreDetails,
} from "./workbook-import";
import { getScoreDetailsAggregate } from "./shared/testing";
import { normalizeAdmissionsUrl } from "./shared/urls";

export const ADMISSIONS_IMPORT_CONFLICT_POLICIES = [
  "preserve_existing",
  "overwrite_existing",
] as const;

export type AdmissionsImportConflictPolicy =
  (typeof ADMISSIONS_IMPORT_CONFLICT_POLICIES)[number];

export interface AdmissionsImportCommitResult {
  runId: string;
  status: "committed";
  noOp: boolean;
  sourceFingerprint: string;
  summary: Record<string, number>;
}

export class AdmissionsImportSourceChangedError extends Error {
  constructor() {
    super("The source workbook changed after preview. Generate a fresh preview before committing.");
    this.name = "AdmissionsImportSourceChangedError";
  }
}

export class AdmissionsImportConflictChoiceRequiredError extends Error {
  constructor() {
    super("This workbook has a prior import. Choose whether to preserve or overwrite existing values.");
    this.name = "AdmissionsImportConflictChoiceRequiredError";
  }
}

export class AdmissionsImportValidationError extends Error {
  readonly issues: AdmissionsImportIssue[];

  constructor(issues: AdmissionsImportIssue[]) {
    super("The workbook preview contains blocking errors.");
    this.name = "AdmissionsImportValidationError";
    this.issues = issues;
  }
}

export class AdmissionsImportInProgressError extends Error {
  constructor() {
    super("An import of this workbook version is already in progress.");
    this.name = "AdmissionsImportInProgressError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function mapImportedUcCategory(value: string): UcActivityCategory | null {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const exact = UC_ACTIVITY_CATEGORIES.find(
    (category) => category.replace(/_/g, " ") === normalized,
  );
  if (exact) return exact;
  if (/award|honou?r/.test(normalized)) return "award_or_honor";
  if (/educational.*prep|prep.*program/.test(normalized)) return "educational_prep_program";
  if (/extracurricular/.test(normalized)) return "extracurricular_activity";
  if (/coursework/.test(normalized)) return "other_coursework";
  if (/volunteer|community service/.test(normalized)) return "volunteering_community_service";
  if (/work experience|employment/.test(normalized)) return "work_experience";
  return null;
}

export function joinImportedNotes(...parts: Array<string | null | undefined>): string | null {
  const values = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return values.length ? values.join("\n\n") : null;
}

export function mapImportedTaskStatus(value: string | null | undefined): "not_started" | "in_progress" | "done" {
  const normalized = normalizedKey(value);
  if (/not complete|incomplete|not submitted|missing/.test(normalized)) return "in_progress";
  if (/done|\bcomplete\b|submitted|sent|received|\byes\b|waived|finished|awarded/.test(normalized)) return "done";
  if (/progress|started|draft|working|pending review|registered/.test(normalized)) return "in_progress";
  return "not_started";
}

export function mapImportedRound(value: string | null | undefined):
  "ed" | "ed2" | "ea" | "rea" | "rd" | "rolling" | "priority" | "other" {
  const normalized = normalizedKey(value).replace(/[^a-z0-9]/g, "");
  if (["ed", "ed1", "earlydecision", "earlydecision1"].includes(normalized)) return "ed";
  if (["ed2", "earlydecision2"].includes(normalized)) return "ed2";
  if (["ea", "earlyaction"].includes(normalized)) return "ea";
  if (["rea", "restrictiveearlyaction", "singlechoiceearlyaction"].includes(normalized)) return "rea";
  if (["rd", "regular", "regulardecision"].includes(normalized)) return "rd";
  if (normalized.includes("rolling")) return "rolling";
  if (normalized.includes("priority")) return "priority";
  return "other";
}

export function mapImportedApplicationStatus(value: string | null | undefined):
  "researching" | "applying" | "submitted" | "complete" {
  const normalized = normalizedKey(value);
  if (/not complete|incomplete|missing/.test(normalized)) return "applying";
  if (/\bcomplete\b|ready|verified/.test(normalized)) return "complete";
  if (/submit|sent/.test(normalized)) return "submitted";
  if (/apply|progress|draft|started|working/.test(normalized)) return "applying";
  return "researching";
}

export function mapImportedEssayStatus(value: string | null | undefined):
  "not_started" | "brainstorming" | "drafting" | "feedback" | "final" {
  const normalized = normalizedKey(value);
  if (/not complete|incomplete|not submitted|not done|not final/.test(normalized)) return "drafting";
  if (/final|complete|submitted|done/.test(normalized)) return "final";
  if (/feedback|review|edit|revision/.test(normalized)) return "feedback";
  if (/draft|writing|progress/.test(normalized)) return "drafting";
  if (/brainstorm|idea|outline/.test(normalized)) return "brainstorming";
  return "not_started";
}

export function mapImportedScholarshipStatus(value: string | null | undefined, submittedDate: string | null): string {
  const normalized = normalizedKey(value);
  if (/not selected|not awarded|unawarded|denied|rejected|lost/.test(normalized)) return "not_selected";
  if (/award|won|selected/.test(normalized)) return "awarded";
  if (/declin/.test(normalized)) return "declined";
  if (submittedDate || /submit/.test(normalized)) return "submitted";
  if (/progress|started|working/.test(normalized)) return "in_progress";
  return "researching";
}

export function sumImportedValues(value: Record<string, number>): number {
  return Object.values(value).reduce((sum, part) => sum + (Number.isFinite(part) ? part : 0), 0);
}

/** Same non-negative money invariant enforced by the live financial-aid API. */
export function validateImportedFinancialAidOffer(
  offer: ImportedFinancialAidOffer,
): string[] {
  const errors: string[] = [];
  for (const [group, breakdown] of [
    ["cost", offer.cost],
    ["gift aid", offer.giftAid],
    ["loans/work study", offer.loans],
  ] as const) {
    for (const [key, value] of Object.entries(breakdown)) {
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`${group} ${key} must be a non-negative number`);
      }
    }
  }
  if (
    offer.remainingBalance !== null &&
    (!Number.isFinite(offer.remainingBalance) || offer.remainingBalance < 0)
  ) {
    errors.push("remaining balance must be a non-negative number");
  }
  return errors;
}

function numericSummary(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    typeof item === "number" ? [[key, item]] : []));
}

type ImportMappingInsert = typeof admissionsImportMappings.$inferInsert;

interface CommitContext {
  tx: AdmissionsWriteDb;
  runId: string;
  caseId: string;
  actorEmail: string;
  actorRole: CaseAccess["role"];
  policy: AdmissionsImportConflictPolicy;
  /** Existing non-blank values are mutable only under the explicit overwrite policy. */
  allowOverwriteExisting: boolean;
  /** Latest committed source-to-target mappings for this case/workbook. */
  priorTargets: Map<string, { targetType: string; targetId: string }>;
  mappings: ImportMappingInsert[];
  summary: Record<string, number>;
}

function sourceIdentity(
  value: { sourceRef?: string },
  fallback: string,
): string {
  return value.sourceRef?.trim() || fallback;
}

function mappingLookupKey(sourceType: string, sourceKey: string): string {
  return `${sourceType}\u0000${sourceKey}`;
}

function priorTargetId(
  context: CommitContext,
  sourceType: string,
  sourceKey: string,
  targetType: string,
): string | null {
  const mapped = context.priorTargets.get(mappingLookupKey(sourceType, sourceKey));
  return mapped?.targetType === targetType ? mapped.targetId : null;
}

function addMapping(
  context: CommitContext,
  sourceType: string,
  sourceKey: string,
  targetType: string,
  targetId: string,
  sourceValue: unknown,
  incrementSummary = true,
): void {
  context.mappings.push({
    runId: context.runId,
    sourceType,
    sourceKey,
    targetType,
    targetId,
    sourceValueFingerprint: fingerprint(sourceValue),
  });
  if (incrementSummary) {
    context.summary[targetType] = (context.summary[targetType] ?? 0) + 1;
  }
}

async function insertReturningId(
  promise: Promise<Array<{ id: string }>>,
  label: string,
): Promise<string> {
  const rows = await promise;
  if (!rows[0]?.id) throw new Error(`${label} insert returned no row`);
  return rows[0].id;
}

async function persistCanonicalStudentProfile(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
): Promise<void> {
  const imported = deriveCanonicalStudentProfile(preview.profile);
  const importedEntries = Object.entries(imported);
  if (!importedEntries.length) return;

  const caseRows = await context.tx.select({ studentId: admissionsCases.studentId })
    .from(admissionsCases)
    .where(eq(admissionsCases.id, context.caseId))
    .limit(1);
  const studentId = caseRows[0]?.studentId;
  if (!studentId) throw new Error("Import case student was not found");
  const studentRows = await context.tx.select().from(admissionsStudents)
    .where(eq(admissionsStudents.id, studentId))
    .limit(1);
  const student = studentRows[0];
  if (!student) throw new Error("Import student was not found");

  const setValues: Partial<typeof admissionsStudents.$inferInsert> = {};
  for (const [field, value] of importedEntries) {
    const current = student[field as keyof typeof student];
    if (current === value) continue;
    const currentIsBlank = current === null || current === undefined ||
      (typeof current === "string" && current.trim() === "");
    if (context.allowOverwriteExisting || currentIsBlank) {
      (setValues as Record<string, unknown>)[field] = value;
    }
  }

  const fields = ["fullName", "preferredName", "phone", "school", "schoolCounselor"] as const;
  const diff = computeFieldDiff(
    student as unknown as Record<string, unknown>,
    setValues as Record<string, unknown>,
    fields,
  );
  if (Object.keys(diff).length) {
    const now = new Date();
    await context.tx.update(admissionsStudents)
      .set({ ...setValues, updatedAt: now })
      .where(eq(admissionsStudents.id, student.id));
    await writeAuditLog(context.tx, {
      caseId: context.caseId,
      actorEmail: context.actorEmail,
      actorRole: context.actorRole,
      entityType: "student",
      entityId: student.id,
      action: "workbook_import_update",
      diff,
    });
  }

  importedEntries.forEach(([field, value], index) => {
    addMapping(
      context,
      "about_you_field",
      field,
      "student_profile",
      student.id,
      value,
      index === 0,
    );
  });
}

async function persistCanonicalAcademicRecords(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
): Promise<void> {
  const fallbackUsPayload = deriveImportedUsAcademicPayload(preview.profile).payload;
  const payloads = preview.canonicalAcademicRecords?.length
    ? preview.canonicalAcademicRecords
    : fallbackUsPayload
      ? [fallbackUsPayload]
      : [];
  if (!payloads.length) return;
  const effectiveDate = todayBangkok();
  const rows = await context.tx.select().from(admissionsAcademicRecords).where(and(
    eq(admissionsAcademicRecords.caseId, context.caseId),
    inArray(admissionsAcademicRecords.system, payloads.map((payload) => payload.system)),
    isNull(admissionsAcademicRecords.deletedAt),
  )).orderBy(desc(admissionsAcademicRecords.effectiveDate)).for("update");
  const existingBySystem = new Map<string, (typeof rows)[number]>();
  const existingById = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (!existingBySystem.has(row.system)) existingBySystem.set(row.system, row);
  }
  for (const payload of payloads) {
    // Academic records are inserted as JSONB, bypassing the live academics
    // domain function, so enforce its URL invariant here as well.
    normalizeAdmissionsUrl(payload.transcriptUrl, "imported transcriptUrl");
    normalizeAdmissionsUrl(payload.schoolProfileUrl, "imported schoolProfileUrl");
    const mappedId = priorTargetId(
      context,
      "academics_record",
      payload.system,
      "academic_record",
    );
    const existing = (mappedId ? existingById.get(mappedId) : undefined) ??
      existingBySystem.get(payload.system);
    let targetId: string;
    if (!existing) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsAcademicRecords).values({
          caseId: context.caseId,
          system: payload.system,
          payload,
          effectiveDate,
        }).returning(),
        "Academic record",
      );
      await writeAuditLog(context.tx, {
        caseId: context.caseId,
        actorEmail: context.actorEmail,
        actorRole: context.actorRole,
        entityType: "academic_record",
        entityId: targetId,
        action: "workbook_import_create",
        diff: computeFieldDiff(
          {},
          { system: payload.system, payload, effectiveDate },
          ["system", "payload", "effectiveDate"],
        ),
      });
    } else {
      targetId = existing.id;
      if (context.allowOverwriteExisting) {
        const diff = computeFieldDiff(
          existing as unknown as Record<string, unknown>,
          { payload },
          ["payload"],
        );
        if (Object.keys(diff).length) {
          await context.tx.update(admissionsAcademicRecords)
            .set({ payload, updatedAt: new Date() })
            .where(eq(admissionsAcademicRecords.id, existing.id));
          await writeAuditLog(context.tx, {
            caseId: context.caseId,
            actorEmail: context.actorEmail,
            actorRole: context.actorRole,
            entityType: "academic_record",
            entityId: existing.id,
            action: "workbook_import_update",
            diff,
          });
        }
      }
    }
    addMapping(
      context,
      "academics_record",
      payload.system,
      "academic_record",
      targetId,
      payload,
    );
  }
}

async function persistSelfReportSections(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
): Promise<void> {
  const desired = [
    ["about_you", preview.profile],
    ["legacy_academics", preview.academics],
    ["college_criteria", preview.collegeCriteria],
    ["majors_careers", preview.majorsCareers],
  ] as const;
  const nonEmpty = desired.filter(([, payload]) => Object.keys(payload).length > 0);
  if (!nonEmpty.length) return;
  const existing = await context.tx.select().from(admissionsSelfReportSections)
    .where(eq(admissionsSelfReportSections.caseId, context.caseId));
  const byKey = new Map(existing.map((row) => [row.sectionKey, row]));
  for (const [sectionKey, payload] of nonEmpty) {
    const row = byKey.get(sectionKey);
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsSelfReportSections).values({
          caseId: context.caseId,
          sectionKey,
          payload,
          state: "draft",
          sharedWithFamily: false,
        }).returning(),
        "Self-report section",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsSelfReportSections)
        .set({ payload, state: "draft", updatedAt: new Date() })
        .where(eq(admissionsSelfReportSections.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else {
      targetId = row.id;
    }
    addMapping(context, "worksheet_section", sectionKey, "self_report_section", targetId, payload);
  }
}

async function persistMeetings(context: CommitContext, preview: AdmissionsWorkbookPreview): Promise<void> {
  const desired = preview.meetings.filter((meeting) => meeting.meetingDate);
  if (!desired.length) return;
  const existing = await context.tx.select().from(admissionsCaseMeetings).where(and(
    eq(admissionsCaseMeetings.caseId, context.caseId),
    isNull(admissionsCaseMeetings.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [
    `${row.meetingDate}|${normalizedKey(row.notes)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, meeting] of desired.entries()) {
    const notes = joinImportedNotes(
      meeting.notes,
      meeting.nextSteps ? `Next steps: ${meeting.nextSteps}` : null,
    );
    const key = `${meeting.meetingDate}|${normalizedKey(notes)}`;
    const sourceKey = sourceIdentity(meeting, `${index}:${key}`);
    const row = byId.get(priorTargetId(context, "meeting", sourceKey, "meeting") ?? "") ??
      byKey.get(key);
    const values = {
      meetingDate: meeting.meetingDate!,
      mode: joinImportedNotes(meeting.status, meeting.time),
      attendees: [] as string[],
      notes,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsCaseMeetings).values({ caseId: context.caseId, ...values }).returning(),
        "Meeting",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsCaseMeetings).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsCaseMeetings.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "meeting", sourceKey, "meeting", targetId, meeting);
  }
}

async function persistTasks(context: CommitContext, preview: AdmissionsWorkbookPreview): Promise<void> {
  if (!preview.tasks.length) return;
  const existing = await context.tx.select().from(admissionsCaseTasks).where(and(
    eq(admissionsCaseTasks.caseId, context.caseId),
    isNull(admissionsCaseTasks.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [
    `${normalizedKey(row.title)}|${row.dueDate ?? ""}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, task] of preview.tasks.entries()) {
    const resourceUrl = normalizeAdmissionsUrl(task.resourceUrl, "imported task resourceUrl");
    const key = `${normalizedKey(task.title)}|${task.dueDate ?? ""}`;
    const sourceKey = sourceIdentity(task, `${index}:${key}`);
    const row = byId.get(priorTargetId(context, "task", sourceKey, "task") ?? "") ??
      byKey.get(key);
    const values = {
      phase: "about_you",
      title: task.title,
      description: joinImportedNotes(
        task.instructions,
        resourceUrl ? `Resource: ${resourceUrl}` : null,
        task.notes,
        task.startDate ? `Legacy start date: ${task.startDate}` : null,
      ),
      owner: "student" as const,
      status: mapImportedTaskStatus(task.status),
      dueDate: task.dueDate,
      sortOrder: index,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsCaseTasks).values({ caseId: context.caseId, ...values }).returning(),
        "Task",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsCaseTasks).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsCaseTasks.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "task", sourceKey, "task", targetId, task);
  }
}

async function persistActivities(context: CommitContext, preview: AdmissionsWorkbookPreview): Promise<void> {
  if (!preview.activities.length) return;
  const seenSourceNames = new Set<string>();
  for (const activity of preview.activities) {
    const key = normalizedKey(activity.name);
    if (seenSourceNames.has(key)) {
      throw new AdmissionsImportValidationError([{
        severity: "error",
        code: "duplicate_activity_name",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
        range: activity.sourceRef ?? activity.name,
        message: `More than one imported activity is named "${activity.name}". Rename the rows so each source activity is unambiguous.`,
      }]);
    }
    seenSourceNames.add(key);
  }
  const existing = await context.tx.select().from(admissionsActivities).where(and(
    eq(admissionsActivities.caseId, context.caseId),
    isNull(admissionsActivities.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [normalizedKey(row.name), row]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const newActivityKeys = new Set(
    preview.activities
      .flatMap((activity, index) => {
        const key = normalizedKey(activity.name);
        const sourceKey = sourceIdentity(activity, `${index}:${key}`);
        const mappedId = priorTargetId(context, "activity", sourceKey, "activity");
        return key && !byKey.has(key) && !(mappedId && byId.has(mappedId)) ? [key] : [];
      }),
  );
  if (existing.length + newActivityKeys.size > MAX_ACTIVE_ACTIVITIES_PER_CASE) {
    throw new AdmissionsImportValidationError([{
      severity: "error",
      code: "activity_limit_exceeded",
      sheetName: ADMISSIONS_WORKBOOK_RANGES.activities.sheetName,
      range: ADMISSIONS_WORKBOOK_RANGES.activities.range,
      message: `Import would create ${existing.length + newActivityKeys.size} live activities; the case limit is ${MAX_ACTIVE_ACTIVITIES_PER_CASE}.`,
    }]);
  }
  const importedTargets = new Map<string, string>();
  for (const [index, activity] of preview.activities.entries()) {
    const key = normalizedKey(activity.name);
    const sourceKey = sourceIdentity(activity, `${index}:${key}`);
    const alreadyImportedTarget = importedTargets.get(key);
    if (alreadyImportedTarget) {
      addMapping(
        context,
        "activity",
        sourceKey,
        "activity",
        alreadyImportedTarget,
        activity,
        false,
      );
      continue;
    }
    const row = byId.get(priorTargetId(context, "activity", sourceKey, "activity") ?? "") ??
      byKey.get(key);
    const commonApp: AdmissionsCommonAppBlock = {
      ...(activity.commonApp?.position
        ? { position: activity.commonApp.position }
        : {}),
      ...(activity.commonApp?.organization
        ? { organization: activity.commonApp.organization }
        : {}),
      ...(activity.commonApp?.description
        ? { description: activity.commonApp.description }
        : {}),
      grades: activity.gradeLevels.filter((grade): grade is (typeof ADMISSIONS_ACTIVITY_GRADES)[number] =>
        ADMISSIONS_ACTIVITY_GRADES.includes(grade as (typeof ADMISSIONS_ACTIVITY_GRADES)[number])),
      ...(activity.hoursPerWeek !== null &&
      activity.hoursPerWeek >= 0 &&
      activity.hoursPerWeek <= COMMON_APP_HOURS_PER_WEEK_MAX
        ? { hrsWeek: activity.hoursPerWeek }
        : {}),
      ...(activity.weeksPerYear !== null &&
      Number.isInteger(activity.weeksPerYear) &&
      activity.weeksPerYear >= 0 &&
      activity.weeksPerYear <= COMMON_APP_WEEKS_PER_YEAR_MAX
        ? { weeksYear: activity.weeksPerYear }
        : {}),
    };
    const ucCategory = activity.uc?.category
      ? mapImportedUcCategory(activity.uc.category)
      : null;
    const uc: AdmissionsUcBlock | null = activity.uc
      ? {
          ...(ucCategory ? { category: ucCategory } : {}),
          ...(activity.uc.description ? { description: activity.uc.description } : {}),
        }
      : null;
    const values = {
      name: activity.name,
      fullDescription: joinImportedNotes(
        activity.fullDescription,
        activity.uc?.category && !ucCategory
          ? `Legacy UC category: ${activity.uc.category}`
          : null,
      ),
      commonApp,
      uc,
      sortOrder: index,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsActivities).values({ caseId: context.caseId, ...values }).returning(),
        "Activity",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsActivities).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsActivities.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    importedTargets.set(key, targetId);
    addMapping(context, "activity", sourceKey, "activity", targetId, activity);
  }
}

async function persistAwards(context: CommitContext, preview: AdmissionsWorkbookPreview): Promise<void> {
  if (!preview.awards.length) return;
  const existing = await context.tx.select().from(admissionsAwards).where(and(
    eq(admissionsAwards.caseId, context.caseId),
    isNull(admissionsAwards.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [
    `${normalizedKey(row.title)}|${normalizedKey(row.organization)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, award] of preview.awards.entries()) {
    const key = `${normalizedKey(award.title)}|${normalizedKey(award.organization)}`;
    const sourceKey = sourceIdentity(award, `${index}:${key}`);
    const row = byId.get(priorTargetId(context, "award", sourceKey, "award") ?? "") ??
      byKey.get(key);
    const values = {
      title: award.title,
      organization: award.organization,
      gradeLevels: award.gradeLevels,
      recognitionLevels: award.recognitionLevels,
      ucEligibilityNarrative: award.eligibilityNarrative,
      ucAchievementNarrative: award.achievementNarrative,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsAwards).values({ caseId: context.caseId, ...values }).returning(),
        "Award",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsAwards).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsAwards.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "award", sourceKey, "award", targetId, award);
  }
}

async function persistTests(context: CommitContext, preview: AdmissionsWorkbookPreview): Promise<void> {
  const desired = preview.tests.filter((sitting) => sitting.testDate);
  if (!desired.length) return;
  const existing = await context.tx.select().from(admissionsTestSittings).where(and(
    eq(admissionsTestSittings.caseId, context.caseId),
    isNull(admissionsTestSittings.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [
    `${row.testType}|${row.testDate}|${normalizedKey(row.subject)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, sitting] of desired.entries()) {
    const testType = ["sat", "act", "ap", "ib", "toefl", "ielts"].includes(sitting.testType)
      ? sitting.testType as "sat" | "act" | "ap" | "ib" | "toefl" | "ielts"
      : "other" as const;
    const key = `${testType}|${sitting.testDate}|${normalizedKey(sitting.subject)}`;
    const sourceKey = sourceIdentity(sitting, `${index}:${key}`);
    const row = byId.get(
      priorTargetId(context, "test_sitting", sourceKey, "test_sitting") ?? "",
    ) ?? byKey.get(key);
    const details = normalizeImportedTestScoreDetails({ ...sitting, testType });
    const workbookValues = {
      testType,
      testDate: sitting.testDate!,
      subject: sitting.subject,
      actualScore: details ? getScoreDetailsAggregate(details) : null,
      scoreDetails: details,
      status: details ? "score_received" as const : "taken" as const,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsTestSittings).values({
          caseId: context.caseId,
          ...workbookValues,
          targetScore: "",
          scoreReleasedToParent: false,
        }).returning(),
        "Test sitting",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsTestSittings).set({
        ...workbookValues,
        updatedAt: new Date(),
      })
        .where(eq(admissionsTestSittings.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "test_sitting", sourceKey, "test_sitting", targetId, sitting);
  }
}

interface CollegeSourceIdentity {
  collegeName: string;
  sourceType: string;
  sourceKey: string;
  sourceValue: unknown;
  application: ImportedApplication | null;
}

function collegeSources(preview: AdmissionsWorkbookPreview): CollegeSourceIdentity[] {
  return [
    ...preview.applications.map((item, index) => ({
      collegeName: item.collegeName,
      sourceType: "application",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
      sourceValue: item,
      application: item,
    })),
    ...preview.research.map((item, index) => ({
      collegeName: item.collegeName,
      sourceType: "college_research_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
      sourceValue: item,
      application: null,
    })),
    ...preview.interestEvents.map((item, index) => ({
      collegeName: item.collegeName,
      sourceType: "interest_event_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
      sourceValue: item,
      application: null,
    })),
    ...preview.essayPrompts.map((item, index) => ({
      collegeName: item.collegeName,
      sourceType: "essay_prompt_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
      sourceValue: item,
      application: null,
    })),
    ...preview.financialAid.map((item, index) => ({
      collegeName: item.collegeName,
      sourceType: "financial_aid_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
      sourceValue: item,
      application: null,
    })),
    ...preview.scholarships.flatMap((item, index) => item.collegeName ? [{
      collegeName: item.collegeName,
      sourceType: "scholarship_list_item",
      sourceKey: sourceIdentity(item, `${index}:${normalizedKey(item.collegeName)}`),
      sourceValue: item,
      application: null,
    }] : []),
  ].filter((item) => normalizedKey(item.collegeName));
}

async function persistColleges(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
): Promise<Map<string, string>> {
  const sources = collegeSources(preview);
  const result = new Map<string, string>();
  if (!sources.length) return result;
  const existing = await context.tx.select().from(admissionsCollegeListItems).where(and(
    eq(admissionsCollegeListItems.caseId, context.caseId),
    isNull(admissionsCollegeListItems.deletedAt),
  ));
  const byName = new Map(existing.map((row) => [normalizedKey(row.instName), row]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const sourcesByName = new Map<string, CollegeSourceIdentity[]>();
  for (const source of sources) {
    const key = normalizedKey(source.collegeName);
    sourcesByName.set(key, [...(sourcesByName.get(key) ?? []), source]);
  }
  for (const [key, matchingSources] of sourcesByName) {
    const name = matchingSources[0]!.collegeName;
    const app = matchingSources.find((source) => source.application)?.application ?? null;
    const mappedId = matchingSources.flatMap((source) => {
      const targetId = priorTargetId(
        context,
        source.sourceType,
        source.sourceKey,
        "college_list_item",
      );
      return targetId ? [targetId] : [];
    })[0];
    const row = (mappedId ? byId.get(mappedId) : undefined) ?? byName.get(key);
    const values = {
      instName: name.trim(),
      country: "United States",
      isManual: true,
      round: mapImportedRound(app?.round),
      deadline: app?.deadline ?? null,
      appStatus: mapImportedApplicationStatus(app?.overallStatus),
      firstChoiceMajor: app?.firstChoiceMajor ?? null,
      secondChoiceMajor: app?.secondChoiceMajor ?? null,
      admissionsUrl: normalizeAdmissionsUrl(app?.admissionsUrl, "imported admissionsUrl") ?? null,
      portalUrl: normalizeAdmissionsUrl(app?.portalUrl, "imported portalUrl") ?? null,
      aidOffered: app?.scholarshipAmount == null ? null : String(app.scholarshipAmount),
      aidNotes: joinImportedNotes(
        app?.scholarshipType ? `Scholarship type: ${app.scholarshipType}` : null,
        app?.notes,
      ),
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsCollegeListItems).values({ caseId: context.caseId, ...values }).returning(),
        "College",
      );
    } else if (app && context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsCollegeListItems).set({
        instName: values.instName,
        round: values.round,
        deadline: values.deadline,
        appStatus: values.appStatus,
        firstChoiceMajor: values.firstChoiceMajor,
        secondChoiceMajor: values.secondChoiceMajor,
        admissionsUrl: values.admissionsUrl,
        portalUrl: values.portalUrl,
        aidOffered: values.aidOffered,
        aidNotes: values.aidNotes,
        updatedAt: new Date(),
      }).where(eq(admissionsCollegeListItems.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    result.set(key, targetId);
    for (const source of matchingSources) {
      addMapping(
        context,
        source.sourceType,
        source.sourceKey,
        "college_list_item",
        targetId,
        source.sourceValue,
        source.application !== null,
      );
    }
  }
  return result;
}

async function persistTranscriptDocuments(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  const desired = preview.applications.flatMap((application) => {
    const sent = normalizeImportedSentStatus(application.transcriptStatus);
    const listItemId = colleges.get(normalizedKey(application.collegeName));
    return sent === null || !listItemId ? [] : [{ application, listItemId, sent }];
  });
  if (!desired.length) return;

  const listItemIds = [...new Set(desired.map((item) => item.listItemId))];
  const existing = await context.tx.select().from(admissionsCollegeDocs).where(and(
    inArray(admissionsCollegeDocs.listItemId, listItemIds),
    eq(admissionsCollegeDocs.docType, "transcript"),
    isNull(admissionsCollegeDocs.testSittingId),
  ));
  const byListItem = new Map(existing.map((row) => [row.listItemId, row]));

  for (const { application, listItemId, sent } of desired) {
    const row = byListItem.get(listItemId);
    const now = new Date();
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsCollegeDocs).values({
          listItemId,
          docType: "transcript",
          testSittingId: null,
          sent,
          sentAt: sent ? now : null,
        }).returning(),
        "Transcript document",
      );
    } else if (context.policy === "overwrite_existing" && row.sent !== sent) {
      await context.tx.update(admissionsCollegeDocs).set({
        sent,
        sentAt: sent ? now : null,
        updatedAt: now,
      }).where(eq(admissionsCollegeDocs.id, row.id));
      targetId = row.id;
    } else {
      targetId = row.id;
    }
    addMapping(
      context,
      "application_transcript_status",
      sourceIdentity(application, normalizedKey(application.collegeName)),
      "college_doc",
      targetId,
      application.transcriptStatus,
    );
  }
}

async function persistResearch(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  if (!preview.research.length) return;
  const ids = [...new Set(colleges.values())];
  const existing = ids.length
    ? await context.tx.select().from(admissionsCollegeResearch)
      .where(inArray(admissionsCollegeResearch.listItemId, ids))
    : [];
  const byItem = new Map(existing.map((row) => [row.listItemId, row]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, research] of preview.research.entries()) {
    const listItemId = colleges.get(normalizedKey(research.collegeName));
    if (!listItemId) continue;
    const sourceKey = sourceIdentity(
      research,
      `${index}:${normalizedKey(research.collegeName)}`,
    );
    const row = byId.get(
      priorTargetId(context, "college_research", sourceKey, "college_research") ?? "",
    ) ?? byItem.get(listItemId);
    const values = {
      sources: research.sources.map((label) => ({ label })),
      campusVisitNotes: research.campusVisitNotes,
      academicNotes: research.academicNotes,
      questions: research.questions,
      notes: joinImportedNotes(
        research.fitAssessment ? `Fit assessment: ${research.fitAssessment}` : null,
        research.generalNotes,
      ),
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsCollegeResearch).values({ listItemId, ...values }).returning(),
        "College research",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsCollegeResearch).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsCollegeResearch.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "college_research", sourceKey, "college_research", targetId, research);
  }
}

async function persistInterestEvents(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  const desired = preview.interestEvents.filter((event) => event.eventDate);
  if (!desired.length) return;
  const ids = [...new Set(colleges.values())];
  const existing = ids.length
    ? await context.tx.select().from(admissionsInterestEvents).where(and(
      inArray(admissionsInterestEvents.listItemId, ids),
      isNull(admissionsInterestEvents.deletedAt),
    ))
    : [];
  const byKey = new Map(existing.map((row) => [
    `${row.listItemId}|${row.eventDate}|${normalizedKey(row.notes)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, event] of desired.entries()) {
    const listItemId = colleges.get(normalizedKey(event.collegeName));
    if (!listItemId) continue;
    const key = `${listItemId}|${event.eventDate}|${normalizedKey(event.notes)}`;
    const sourceKey = sourceIdentity(
      event,
      `${index}:${normalizedKey(event.collegeName)}:${event.eventDate}`,
    );
    const row = byId.get(
      priorTargetId(context, "interest_event", sourceKey, "interest_event") ?? "",
    ) ?? byKey.get(key);
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsInterestEvents).values({
          listItemId,
          type: "other",
          eventDate: event.eventDate!,
          notes: event.notes,
          actorEmail: context.actorEmail,
        }).returning(),
        "Interest event",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsInterestEvents).set({
        listItemId,
        type: "other",
        eventDate: event.eventDate!,
        notes: event.notes,
        updatedAt: new Date(),
      }).where(eq(admissionsInterestEvents.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "interest_event", sourceKey, "interest_event", targetId, event);
  }
}

export interface LegacyRequirement {
  kind: string;
  title: string;
  status: string | null;
  dueDate: string | null;
  sourceUrl: string | null;
  notes: string | null;
}

export function importedApplicationRequirements(application: ImportedApplication): LegacyRequirement[] {
  const candidates: Array<LegacyRequirement & { present: boolean }> = [
    { present: Boolean(application.collegeQuestionsStatus), kind: "college_questions", title: "College questions", status: application.collegeQuestionsStatus, dueDate: application.deadline, sourceUrl: application.admissionsUrl, notes: null },
    { present: Boolean(application.honorsProgramStatus), kind: "honors_program", title: "Honors program", status: application.honorsProgramStatus, dueDate: application.deadline, sourceUrl: application.admissionsUrl, notes: null },
    { present: Boolean(application.interviewStatus), kind: "interview", title: "Interview", status: application.interviewStatus, dueDate: application.deadline, sourceUrl: null, notes: null },
    { present: Boolean(application.portfolioStatus), kind: "portfolio", title: "Portfolio", status: application.portfolioStatus, dueDate: application.deadline, sourceUrl: null, notes: null },
    { present: Boolean(application.scholarshipStatus), kind: "scholarship", title: "Institutional scholarships", status: application.scholarshipStatus, dueDate: application.financialAidDeadline, sourceUrl: null, notes: application.scholarshipType },
    { present: Boolean(application.financialAidStatus), kind: "other", title: "Financial aid application", status: application.financialAidStatus, dueDate: application.financialAidDeadline, sourceUrl: null, notes: null },
    { present: Boolean(application.fafsaStatus), kind: "fafsa", title: "FAFSA", status: application.fafsaStatus, dueDate: application.financialAidDeadline, sourceUrl: null, notes: null },
  ];
  return candidates.filter(({ present }) => present).map((candidate) => ({
    kind: candidate.kind,
    title: candidate.title,
    status: candidate.status,
    dueDate: candidate.dueDate,
    sourceUrl: candidate.sourceUrl,
    notes: candidate.notes,
  }));
}

async function persistRequirements(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  const desired = preview.applications.flatMap((application) => importedApplicationRequirements(application)
    .map((requirement) => ({ application, requirement })));
  if (!desired.length) return;
  const ids = [...new Set(colleges.values())];
  const existing = ids.length
    ? await context.tx.select().from(admissionsCollegeRequirements).where(and(
      inArray(admissionsCollegeRequirements.listItemId, ids),
      isNull(admissionsCollegeRequirements.deletedAt),
    ))
    : [];
  const byKey = new Map(existing.map((row) => [
    `${row.listItemId}|${row.kind}|${normalizedKey(row.title)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, { application, requirement }] of desired.entries()) {
    const listItemId = colleges.get(normalizedKey(application.collegeName));
    if (!listItemId) continue;
    const key = `${listItemId}|${requirement.kind}|${normalizedKey(requirement.title)}`;
    const sourceKey = `${sourceIdentity(
      application,
      normalizedKey(application.collegeName),
    )}:${requirement.kind}`;
    const row = byId.get(priorTargetId(
      context,
      "college_requirement",
      sourceKey,
      "college_requirement",
    ) ?? "") ?? byKey.get(key);
    const values = {
      kind: requirement.kind,
      title: requirement.title,
      status: mapImportedTaskStatus(requirement.status),
      owner: "student" as const,
      dueDate: requirement.dueDate,
      required: true,
      sourceUrl: normalizeAdmissionsUrl(requirement.sourceUrl, "imported requirement sourceUrl") ?? null,
      notes: requirement.notes,
      sortOrder: index,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsCollegeRequirements).values({ listItemId, ...values }).returning(),
        "College requirement",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsCollegeRequirements).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsCollegeRequirements.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "college_requirement", sourceKey, "college_requirement", targetId, requirement);
  }
}

async function persistEssays(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  if (!preview.essayPrompts.length) return;
  const existing = await context.tx.select().from(admissionsEssays).where(and(
    eq(admissionsEssays.caseId, context.caseId),
    isNull(admissionsEssays.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [
    `${row.listItemId ?? ""}|${normalizedKey(row.prompt)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const appByName = new Map(preview.applications.map((application) => [normalizedKey(application.collegeName), application]));
  for (const [index, essay] of preview.essayPrompts.entries()) {
    normalizeAdmissionsUrl(essay.sourceUrl, "imported essay prompt sourceUrl");
    const listItemId = colleges.get(normalizedKey(essay.collegeName)) ?? null;
    const key = `${listItemId ?? ""}|${normalizedKey(essay.prompt)}`;
    const sourceKey = sourceIdentity(
      essay,
      `${index}:${normalizedKey(essay.collegeName)}:${fingerprint(essay.prompt).slice(0, 12)}`,
    );
    const row = byId.get(priorTargetId(context, "essay_prompt", sourceKey, "essay") ?? "") ??
      byKey.get(key);
    const values = {
      listItemId,
      prompt: essay.prompt,
      status: mapImportedEssayStatus(essay.status),
      deadline: appByName.get(normalizedKey(essay.collegeName))?.deadline ?? null,
      driveUrl: null,
      sharedWithFamily: false,
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsEssays).values({ caseId: context.caseId, ...values }).returning(),
        "Essay",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsEssays).set({
        listItemId: values.listItemId,
        prompt: values.prompt,
        status: values.status,
        deadline: values.deadline,
        updatedAt: new Date(),
      }).where(eq(admissionsEssays.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "essay_prompt", sourceKey, "essay", targetId, essay);
  }
}

async function persistFinancialAid(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  if (!preview.financialAid.length) return;
  for (const offer of preview.financialAid) {
    const errors = validateImportedFinancialAidOffer(offer);
    if (errors.length) {
      throw new AdmissionsImportValidationError(errors.map((message) => ({
        severity: "error" as const,
        code: "invalid_financial_aid_value",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.financialAid.sheetName,
        range: offer.sourceRef ?? offer.collegeName,
        message: `${offer.collegeName}: ${message}.`,
      })));
    }
  }
  const awardYearRows = await context.tx.select({
    awardYear: admissionsCohorts.graduationYear,
  }).from(admissionsCases)
    .innerJoin(admissionsCohorts, eq(admissionsCases.cohortId, admissionsCohorts.id))
    .where(eq(admissionsCases.id, context.caseId))
    .limit(1);
  const awardYear = awardYearRows[0]?.awardYear;
  if (!Number.isInteger(awardYear) || awardYear! < 2000 || awardYear! > 2200) {
    throw new AdmissionsImportValidationError([{
      severity: "error",
      code: "missing_financial_aid_award_year",
      sheetName: ADMISSIONS_WORKBOOK_RANGES.financialAid.sheetName,
      range: ADMISSIONS_WORKBOOK_RANGES.financialAid.range,
      message: "The case cohort must have a valid graduation year before financial aid can be imported.",
    }]);
  }
  const ids = [...new Set(colleges.values())];
  const existing = ids.length
    ? await context.tx.select().from(admissionsFinancialAidOffers)
      .where(inArray(admissionsFinancialAidOffers.listItemId, ids))
    : [];
  const byItem = new Map(existing.map((row) => [row.listItemId, row]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, offer] of preview.financialAid.entries()) {
    const listItemId = colleges.get(normalizedKey(offer.collegeName));
    if (!listItemId) continue;
    const sourceKey = sourceIdentity(
      offer,
      `${index}:${normalizedKey(offer.collegeName)}`,
    );
    const row = byId.get(priorTargetId(
      context,
      "financial_aid",
      sourceKey,
      "financial_aid_offer",
    ) ?? "") ?? byItem.get(listItemId);
    const { workStudy = 0, ...loanBreakdown } = offer.loans;
    const totalCost = sumImportedValues(offer.cost);
    const totalGiftAid = sumImportedValues(offer.giftAid);
    const offerAwardYear = offer.awardYear ?? awardYear;
    if (!Number.isInteger(offerAwardYear) || offerAwardYear! < 2000 || offerAwardYear! > 2200) {
      throw new AdmissionsImportValidationError([{
        severity: "error",
        code: "missing_financial_aid_award_year",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.financialAid.sheetName,
        range: offer.sourceRef ?? offer.collegeName,
        message: `${offer.collegeName}: a valid award year is required.`,
      }]);
    }
    const values = {
      currency: "USD",
      awardYear: offerAwardYear,
      costBreakdown: offer.cost,
      giftAidBreakdown: offer.giftAid,
      loanBreakdown,
      workStudyAmount: String(workStudy),
      netCost: String(Math.max(0, totalCost - totalGiftAid)),
      remainingBalance: offer.remainingBalance == null ? null : String(offer.remainingBalance),
      notes: "Imported from the archived student workbook.",
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsFinancialAidOffers).values({ listItemId, ...values }).returning(),
        "Financial-aid offer",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsFinancialAidOffers).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsFinancialAidOffers.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "financial_aid", sourceKey, "financial_aid_offer", targetId, offer);
  }
}

async function persistScholarships(
  context: CommitContext,
  preview: AdmissionsWorkbookPreview,
  colleges: Map<string, string>,
): Promise<void> {
  if (!preview.scholarships.length) return;
  const existing = await context.tx.select().from(admissionsScholarships).where(and(
    eq(admissionsScholarships.caseId, context.caseId),
    isNull(admissionsScholarships.deletedAt),
  ));
  const byKey = new Map(existing.map((row) => [
    `${normalizedKey(row.name)}|${normalizedKey(row.provider)}`,
    row,
  ]));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const [index, scholarship] of preview.scholarships.entries()) {
    if (
      scholarship.offeredAmount != null &&
      (!Number.isFinite(scholarship.offeredAmount) || scholarship.offeredAmount < 0)
    ) {
      throw new AdmissionsImportValidationError([{
        severity: "error",
        code: "invalid_scholarship_amount",
        sheetName: ADMISSIONS_WORKBOOK_RANGES.scholarships.sheetName,
        range: scholarship.sourceRef ?? scholarship.name,
        message: `${scholarship.name}: offered amount must be a non-negative number.`,
      }]);
    }
    const key = `${normalizedKey(scholarship.name)}|${normalizedKey(scholarship.provider)}`;
    const sourceKey = sourceIdentity(scholarship, `${index}:${key}`);
    const row = byId.get(
      priorTargetId(context, "scholarship", sourceKey, "scholarship") ?? "",
    ) ?? byKey.get(key);
    const values = {
      listItemId: scholarship.collegeName
        ? colleges.get(normalizedKey(scholarship.collegeName)) ?? null
        : null,
      name: scholarship.name,
      provider: scholarship.provider,
      url: normalizeAdmissionsUrl(scholarship.url, "imported scholarship URL") ?? null,
      requirements: joinImportedNotes(
        scholarship.requirements,
        scholarship.providerAddress ? `Provider address: ${scholarship.providerAddress}` : null,
        scholarship.contact ? `Contact: ${scholarship.contact}` : null,
      ),
      deadline: scholarship.deadline,
      status: mapImportedScholarshipStatus(scholarship.outcome, scholarship.submittedDate),
      outcome: scholarship.outcome,
      offeredAmount: scholarship.offeredAmount == null
        ? null
        : String(scholarship.offeredAmount),
      notes: joinImportedNotes(
        scholarship.submittedDate ? `Submitted: ${scholarship.submittedDate}` : null,
        scholarship.notes,
      ),
    };
    let targetId: string;
    if (!row) {
      targetId = await insertReturningId(
        context.tx.insert(admissionsScholarships).values({ caseId: context.caseId, ...values }).returning(),
        "Scholarship",
      );
    } else if (context.policy === "overwrite_existing") {
      const updated = await context.tx.update(admissionsScholarships).set({ ...values, updatedAt: new Date() })
        .where(eq(admissionsScholarships.id, row.id)).returning();
      targetId = updated[0]?.id ?? row.id;
    } else targetId = row.id;
    addMapping(context, "scholarship", sourceKey, "scholarship", targetId, scholarship);
  }
}

export interface CommitAdmissionsWorkbookPreviewInput {
  access: CaseAccess;
  spreadsheetUrl: string;
  expectedFingerprint: string;
  conflictPolicy?: AdmissionsImportConflictPolicy;
  preview: AdmissionsWorkbookPreview;
}

/**
 * Atomically commits a freshly re-read workbook preview. The caller must
 * obtain the preview from Google immediately before this call; this function
 * verifies the expected fingerprint again before touching Postgres.
 */
export async function commitAdmissionsWorkbookPreview(
  input: CommitAdmissionsWorkbookPreviewInput,
  db: Database = getDb(),
): Promise<AdmissionsImportCommitResult> {
  if (!roleAtLeast(input.access.role, "counselor")) throw new Error("Forbidden");
  if (input.preview.sourceFingerprint !== input.expectedFingerprint) {
    throw new AdmissionsImportSourceChangedError();
  }
  const blockingIssues = input.preview.issues.filter((issue) => issue.severity === "error");
  if (blockingIssues.length) throw new AdmissionsImportValidationError(blockingIssues);
  const submittedSpreadsheetId = extractAdmissionsSpreadsheetId(input.spreadsheetUrl);
  if (submittedSpreadsheetId !== input.preview.spreadsheetId) {
    throw new Error("Spreadsheet URL does not match the preview source");
  }
  // Store only a canonical, credential-free archive pointer. Query strings,
  // fragments, and any user-supplied presentation of the source URL are not
  // persisted or later rendered back into an href.
  const normalizedUrl = `https://docs.google.com/spreadsheets/d/${submittedSpreadsheetId}/edit`;

  return withAuditedTransaction(async (tx) => {
    // Serialize every version of one case/workbook inside PostgreSQL. The
    // fingerprint is deliberately excluded: two changed copies must observe
    // each other's committed run before deciding whether a conflict policy is
    // required. `hashtextextended` keeps the lock key parameterized and the
    // transaction-scoped lock is released automatically on commit/rollback.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${input.access.caseId}:${input.preview.spreadsheetId}`}, 0)
      )
    `);
    const priorRuns = await tx.select().from(admissionsImportRuns).where(and(
      eq(admissionsImportRuns.caseId, input.access.caseId),
      eq(admissionsImportRuns.spreadsheetId, input.preview.spreadsheetId),
    ));
    const identical = priorRuns.find((run) => run.sourceFingerprint === input.preview.sourceFingerprint);
    if (identical?.status === "committed") {
      return {
        runId: identical.id,
        status: "committed",
        noOp: true,
        sourceFingerprint: identical.sourceFingerprint,
        summary: numericSummary(identical.summary),
      };
    }
    if (identical) throw new AdmissionsImportInProgressError();
    const hasPriorCommit = priorRuns.some((run) => run.status === "committed");
    if (hasPriorCommit && !input.conflictPolicy) {
      throw new AdmissionsImportConflictChoiceRequiredError();
    }
    const committedRunsNewestFirst = priorRuns
      .filter((run) => run.status === "committed")
      .sort((left, right) => {
        const leftTime = (left.committedAt ?? left.createdAt)?.getTime?.() ?? 0;
        const rightTime = (right.committedAt ?? right.createdAt)?.getTime?.() ?? 0;
        return rightTime - leftTime;
      });
    const priorTargets = new Map<string, { targetType: string; targetId: string }>();
    if (committedRunsNewestFirst.length) {
      const priorMappings = await tx.select({
        runId: admissionsImportMappings.runId,
        sourceType: admissionsImportMappings.sourceType,
        sourceKey: admissionsImportMappings.sourceKey,
        targetType: admissionsImportMappings.targetType,
        targetId: admissionsImportMappings.targetId,
      }).from(admissionsImportMappings).where(inArray(
        admissionsImportMappings.runId,
        committedRunsNewestFirst.map((run) => run.id),
      ));
      const runPriority = new Map(
        committedRunsNewestFirst.map((run, index) => [run.id, index]),
      );
      priorMappings.sort((left, right) =>
        (runPriority.get(left.runId) ?? Number.MAX_SAFE_INTEGER) -
        (runPriority.get(right.runId) ?? Number.MAX_SAFE_INTEGER));
      for (const mapping of priorMappings) {
        const key = mappingLookupKey(mapping.sourceType, mapping.sourceKey);
        if (!priorTargets.has(key)) {
          priorTargets.set(key, {
            targetType: mapping.targetType,
            targetId: mapping.targetId,
          });
        }
      }
    }
    const policy = input.conflictPolicy ?? "preserve_existing";
    const runRows = await tx.insert(admissionsImportRuns).values({
      caseId: input.access.caseId,
      spreadsheetId: input.preview.spreadsheetId,
      spreadsheetUrl: normalizedUrl,
      sourceFingerprint: input.preview.sourceFingerprint,
      status: "committing",
      conflictPolicy: input.conflictPolicy ?? null,
      sourceMetadata: {
        sourceTitle: input.preview.sourceTitle,
        archiveMode: "read_only",
        synchronization: "none",
        previewCounts: input.preview.counts,
        previewChanges: input.preview.changes,
        legacyWorksheetSections: {
          aboutYou: input.preview.profile,
          academics: input.preview.academics,
          collegeCriteria: input.preview.collegeCriteria,
          majorsCareers: input.preview.majorsCareers,
        },
      },
      summary: {},
      createdByEmail: input.access.email,
    }).onConflictDoNothing({
      target: [
        admissionsImportRuns.caseId,
        admissionsImportRuns.spreadsheetId,
        admissionsImportRuns.sourceFingerprint,
      ],
    }).returning();
    const run = runRows[0];
    if (!run) {
      const racedRows = await tx.select().from(admissionsImportRuns).where(and(
        eq(admissionsImportRuns.caseId, input.access.caseId),
        eq(admissionsImportRuns.spreadsheetId, input.preview.spreadsheetId),
        eq(admissionsImportRuns.sourceFingerprint, input.preview.sourceFingerprint),
      ));
      const raced = racedRows[0];
      if (raced?.status === "committed") {
        return {
          runId: raced.id,
          status: "committed",
          noOp: true,
          sourceFingerprint: raced.sourceFingerprint,
          summary: numericSummary(raced.summary),
        };
      }
      throw new AdmissionsImportInProgressError();
    }

    if (input.preview.issues.length) {
      await tx.insert(admissionsImportIssues).values(input.preview.issues.map((issue) => ({
        runId: run.id,
        severity: issue.severity,
        code: issue.code,
        sheetName: issue.sheetName,
        sourceRef: issue.range,
        message: issue.message,
        details: {},
      })));
    }

    const context: CommitContext = {
      tx,
      runId: run.id,
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      policy,
      allowOverwriteExisting: policy === "overwrite_existing",
      priorTargets,
      mappings: [],
      summary: {},
    };
    await persistCanonicalStudentProfile(context, input.preview);
    await persistCanonicalAcademicRecords(context, input.preview);
    await persistSelfReportSections(context, input.preview);
    await persistMeetings(context, input.preview);
    await persistTasks(context, input.preview);
    await persistActivities(context, input.preview);
    await persistAwards(context, input.preview);
    await persistTests(context, input.preview);
    const colleges = await persistColleges(context, input.preview);
    await persistTranscriptDocuments(context, input.preview, colleges);
    await persistResearch(context, input.preview, colleges);
    await persistInterestEvents(context, input.preview, colleges);
    await persistRequirements(context, input.preview, colleges);
    await persistEssays(context, input.preview, colleges);
    await persistFinancialAid(context, input.preview, colleges);
    await persistScholarships(context, input.preview, colleges);

    if (context.mappings.length) {
      await tx.insert(admissionsImportMappings).values(context.mappings);
    }
    await writeAuditLog(tx, {
      caseId: input.access.caseId,
      actorEmail: input.access.email,
      actorRole: input.access.role,
      entityType: "workbook_import",
      entityId: run.id,
      action: "commit",
      diff: {
        spreadsheetId: { old: null, new: input.preview.spreadsheetId },
        sourceFingerprint: { old: null, new: input.preview.sourceFingerprint },
        conflictPolicy: { old: null, new: policy },
        summary: { old: null, new: context.summary },
      },
    });
    const committedAt = new Date();
    await tx.update(admissionsImportRuns).set({
      status: "committed",
      summary: context.summary,
      committedAt,
      updatedAt: committedAt,
    }).where(eq(admissionsImportRuns.id, run.id));
    return {
      runId: run.id,
      status: "committed",
      noOp: false,
      sourceFingerprint: input.preview.sourceFingerprint,
      summary: context.summary,
    };
  }, db);
}
