import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withDatabaseTransaction } from "@/lib/db/transaction";
import { TutorOffboardingError } from "../errors";
import type { ReviewedSubjectMapping, WorkforceCompleteness } from "./types";

export interface ClassIdentity { classId: string | null; sourceValue: string | null; }
export interface SubjectResolution {
  subject: string | null;
  curriculum: string | null;
  level: string | null;
  mappingId: string | null;
  completeness: WorkforceCompleteness;
  reasonCodes: string[];
}
export interface SubjectMappingSaveInput {
  id?: string;
  classId: string | null;
  sourceValue: string;
  subject: string;
  curriculum: string | null;
  level: string | null;
  expectedRevision: number;
}

function unreviewed(reason: string): SubjectResolution {
  return { subject: null, curriculum: null, level: null, mappingId: null, completeness: "unknown", reasonCodes: [reason] };
}
function reviewed(mapping: ReviewedSubjectMapping): boolean {
  return mapping.revision > 0 && Boolean(mapping.reviewedBy?.trim()) && Boolean(mapping.reviewedAt && Number.isFinite(Date.parse(mapping.reviewedAt)));
}
function resolved(mapping: ReviewedSubjectMapping): SubjectResolution {
  return { subject: mapping.subject, curriculum: mapping.curriculum, level: mapping.level, mappingId: mapping.id, completeness: "complete", reasonCodes: [] };
}

/** Exact class + exact observed title takes precedence over an exact reviewed global alias. */
export function resolveAcademicSubject(input: ClassIdentity, mappings: ReviewedSubjectMapping[]): SubjectResolution {
  const sourceValue = input.sourceValue;
  if (!sourceValue?.trim()) return unreviewed("SESSION_TITLE_MISSING");
  const scoped = mappings.filter(mapping => mapping.classId === input.classId && mapping.sourceValue === sourceValue);
  if (scoped.length > 1) return unreviewed("SUBJECT_MAPPING_AMBIGUOUS");
  if (scoped.length === 1) return reviewed(scoped[0]) ? resolved(scoped[0]) : unreviewed("SUBJECT_MAPPING_UNREVIEWED");

  const aliases = mappings.filter(mapping => mapping.classId === null && mapping.sourceValue === sourceValue);
  if (aliases.length > 1) return unreviewed("SUBJECT_ALIAS_AMBIGUOUS");
  if (aliases.length === 1) return reviewed(aliases[0]) ? resolved(aliases[0]) : unreviewed("SUBJECT_ALIAS_UNREVIEWED");
  const renamed = mappings.some(mapping => mapping.classId === input.classId && mapping.sourceValue !== sourceValue);
  return unreviewed(renamed ? "CLASS_LABEL_CHANGED_REVIEW_REQUIRED" : "SUBJECT_MAPPING_UNMAPPED");
}

export function assertSubjectMappingRevision(expectedRevision: number, currentRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== currentRevision) {
    throw new TutorOffboardingError("This subject mapping changed. Reload and review it again.", 409);
  }
}

function mappingRow(row: typeof schema.workforceSubjectMappings.$inferSelect): ReviewedSubjectMapping {
  return { ...row, reviewedAt: row.reviewedAt?.toISOString() ?? null };
}
function duplicatePredicate(input: SubjectMappingSaveInput) {
  return input.classId === null
    ? and(isNull(schema.workforceSubjectMappings.classId), eq(schema.workforceSubjectMappings.sourceValue, input.sourceValue))
    : and(eq(schema.workforceSubjectMappings.classId, input.classId), eq(schema.workforceSubjectMappings.sourceValue, input.sourceValue));
}

/** Saves only local academic classification. Creates serialize on exact source identity. */
export async function saveSubjectMapping(
  db: Database,
  input: SubjectMappingSaveInput,
  actorEmail: string,
  now = new Date(),
): Promise<ReviewedSubjectMapping> {
  if (!input.sourceValue.trim() || input.sourceValue !== input.sourceValue.trim()) throw new TutorOffboardingError("Keep the exact Wise source label, including its original spacing.", 400);
  if (!input.subject.trim() || !actorEmail.trim() || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TutorOffboardingError("A reviewed subject and expected revision are required.", 400);
  const reviewer = actorEmail.trim().toLowerCase();
  if (!Number.isFinite(now.getTime())) throw new TutorOffboardingError("Invalid review time.", 400);
  return withDatabaseTransaction(db, async tx => {
    if (input.expectedRevision === 0) {
      const identityLock = JSON.stringify([input.classId, input.sourceValue]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${identityLock}))`);
      const [existing] = await tx.select().from(schema.workforceSubjectMappings).where(duplicatePredicate(input)).limit(1);
      if (existing) throw new TutorOffboardingError("A mapping already exists for this exact class label.", 409);
      const [created] = await tx.insert(schema.workforceSubjectMappings).values({
        classId: input.classId, sourceValue: input.sourceValue, subject: input.subject.trim(),
        curriculum: input.curriculum?.trim() || null, level: input.level?.trim() || null,
        revision: 1, reviewedBy: reviewer, reviewedAt: now,
      }).returning();
      return mappingRow(created);
    }
    if (!input.id) throw new TutorOffboardingError("Mapping id is required when editing.", 400);
    const [current] = await tx.select().from(schema.workforceSubjectMappings).where(eq(schema.workforceSubjectMappings.id, input.id)).limit(1);
    if (!current) throw new TutorOffboardingError("Subject mapping not found.", 404);
    assertSubjectMappingRevision(input.expectedRevision, current.revision);
    const [updated] = await tx.update(schema.workforceSubjectMappings).set({
      classId: input.classId, sourceValue: input.sourceValue, subject: input.subject.trim(),
      curriculum: input.curriculum?.trim() || null, level: input.level?.trim() || null,
      revision: input.expectedRevision + 1, reviewedBy: reviewer, reviewedAt: now,
    }).where(and(eq(schema.workforceSubjectMappings.id, input.id), eq(schema.workforceSubjectMappings.revision, input.expectedRevision))).returning();
    if (!updated) throw new TutorOffboardingError("This subject mapping changed. Reload and review it again.", 409);
    return mappingRow(updated);
  });
}
