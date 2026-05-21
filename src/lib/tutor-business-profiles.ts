import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getActiveSnapshotIdOrThrow } from "@/lib/data/active-snapshot";

export const englishProficiencySchema = z.enum([
  "native",
  "near-native",
  "fluent",
  "conversational",
  "basic",
  "unknown",
]);

export const youngLearnerFitSchema = z.enum([
  "comfortable",
  "not_comfortable",
  "conditional",
  "unknown",
]);

export const educationEntrySchema = z.object({
  institution: z.string().trim().max(160),
  country: z.string().trim().max(80).optional(),
  program: z.string().trim().max(240).optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

export const languageEntrySchema = z.object({
  language: z.string().trim().max(80),
  proficiency: z.string().trim().max(80),
  verificationSource: z.string().trim().max(160).optional(),
}).strict();

export const tutorBusinessProfilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  parentSafeSummary: z.string().max(1200).optional(),
  internalNotes: z.string().max(3000).optional(),
  education: z.array(educationEntrySchema).max(12).optional(),
  languages: z.array(languageEntrySchema).max(12).optional(),
  englishProficiency: englishProficiencySchema.optional(),
  youngLearnerFit: youngLearnerFitSchema.optional(),
  youngestComfortableAge: z.number().int().min(3).max(20).nullable().optional(),
  youngLearnerNotes: z.string().max(2000).optional(),
  teachingStyleTags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  teachingStyleNotes: z.string().max(2000).optional(),
  strengthTags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  curriculumExperience: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  studentFitNotes: z.string().max(2000).optional(),
  doNotUseForNotes: z.string().max(2000).optional(),
  verifiedBy: z.string().trim().max(160).nullable().optional(),
  lastReviewedAt: z.string().datetime().nullable().optional(),
  active: z.boolean().optional(),
}).strict();

export type EnglishProficiency = z.infer<typeof englishProficiencySchema>;
export type YoungLearnerFit = z.infer<typeof youngLearnerFitSchema>;
export type TutorBusinessProfilePatch = z.infer<typeof tutorBusinessProfilePatchSchema>;

export interface TutorBusinessProfile {
  canonicalKey: string;
  displayName: string;
  parentSafeSummary: string;
  internalNotes: string;
  education: Array<{
    institution: string;
    country?: string;
    program?: string;
    notes?: string;
  }>;
  languages: Array<{
    language: string;
    proficiency: string;
    verificationSource?: string;
  }>;
  englishProficiency: EnglishProficiency;
  youngLearnerFit: YoungLearnerFit;
  youngestComfortableAge: number | null;
  youngLearnerNotes: string;
  teachingStyleTags: string[];
  teachingStyleNotes: string;
  strengthTags: string[];
  curriculumExperience: string[];
  studentFitNotes: string;
  doNotUseForNotes: string;
  verifiedBy: string | null;
  lastReviewedAt: string | null;
  active: boolean;
  updatedAt: string;
}

export interface TutorBusinessProfileListItem extends TutorBusinessProfile {
  tutorGroupId: string;
  supportedModes: string[];
  subjects: string[];
}

export interface TutorProfileImportIdentity {
  canonicalKey: string;
  displayName: string;
  wiseDisplayNames: string[];
}

export interface TutorProfileImportAliasRow {
  fromKey: string;
  toKey: string;
}

type ProfileRow = typeof schema.tutorBusinessProfiles.$inferSelect;

function normalizeList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function profileFromRow(row: ProfileRow): TutorBusinessProfile {
  return {
    canonicalKey: row.canonicalKey,
    displayName: row.displayName,
    parentSafeSummary: row.parentSafeSummary,
    internalNotes: row.internalNotes,
    education: row.education,
    languages: row.languages,
    englishProficiency: englishProficiencySchema.catch("unknown").parse(row.englishProficiency),
    youngLearnerFit: youngLearnerFitSchema.catch("unknown").parse(row.youngLearnerFit),
    youngestComfortableAge: row.youngestComfortableAge,
    youngLearnerNotes: row.youngLearnerNotes,
    teachingStyleTags: row.teachingStyleTags,
    teachingStyleNotes: row.teachingStyleNotes,
    strengthTags: row.strengthTags,
    curriculumExperience: row.curriculumExperience,
    studentFitNotes: row.studentFitNotes,
    doNotUseForNotes: row.doNotUseForNotes,
    verifiedBy: row.verifiedBy,
    lastReviewedAt: row.lastReviewedAt ? row.lastReviewedAt.toISOString() : null,
    active: row.active,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function emptyProfile(input: {
  canonicalKey: string;
  displayName: string;
}): TutorBusinessProfile {
  return {
    canonicalKey: input.canonicalKey,
    displayName: input.displayName,
    parentSafeSummary: "",
    internalNotes: "",
    education: [],
    languages: [],
    englishProficiency: "unknown",
    youngLearnerFit: "unknown",
    youngestComfortableAge: null,
    youngLearnerNotes: "",
    teachingStyleTags: [],
    teachingStyleNotes: "",
    strengthTags: [],
    curriculumExperience: [],
    studentFitNotes: "",
    doNotUseForNotes: "",
    verifiedBy: null,
    lastReviewedAt: null,
    active: true,
    updatedAt: new Date(0).toISOString(),
  };
}

function supportedModesFromModality(modality: string): string[] {
  if (modality === "both") return ["online", "onsite"];
  if (modality === "unresolved") return [];
  return [modality];
}

function isMissingTutorProfileTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = typeof error === "object" && error && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
  const causeCode = typeof cause === "object" && cause && "code" in cause
    ? String((cause as { code?: unknown }).code)
    : "";
  return (
    message.includes("tutor_business_profiles") ||
    causeMessage.includes("tutor_business_profiles")
  ) && (
    message.includes("does not exist") ||
    causeMessage.includes("does not exist") ||
    message.includes("column") ||
    causeMessage.includes("column") ||
    message.includes("42P01") ||
    message.includes("42703") ||
    causeCode === "42703" ||
    causeCode === "42P01"
  );
}

async function selectAllTutorBusinessProfiles(db: Database): Promise<ProfileRow[]> {
  try {
    return await db.select().from(schema.tutorBusinessProfiles);
  } catch (error) {
    if (isMissingTutorProfileTable(error)) return [];
    throw error;
  }
}

async function selectActiveTutorBusinessProfiles(db: Database): Promise<ProfileRow[]> {
  try {
    return await db
      .select()
      .from(schema.tutorBusinessProfiles)
      .where(eq(schema.tutorBusinessProfiles.active, true));
  } catch (error) {
    if (isMissingTutorProfileTable(error)) return [];
    throw error;
  }
}

export async function listTutorBusinessProfiles(db: Database): Promise<TutorBusinessProfileListItem[]> {
  const snapshotId = await getActiveSnapshotIdOrThrow(db);

  const [groups, qualifications, profiles] = await Promise.all([
    db
      .select({
        id: schema.tutorIdentityGroups.id,
        canonicalKey: schema.tutorIdentityGroups.canonicalKey,
        displayName: schema.tutorIdentityGroups.displayName,
        supportedModality: schema.tutorIdentityGroups.supportedModality,
      })
      .from(schema.tutorIdentityGroups)
      .where(eq(schema.tutorIdentityGroups.snapshotId, snapshotId)),
    db
      .select({
        groupId: schema.subjectLevelQualifications.groupId,
        subject: schema.subjectLevelQualifications.subject,
      })
      .from(schema.subjectLevelQualifications)
      .where(eq(schema.subjectLevelQualifications.snapshotId, snapshotId)),
    selectAllTutorBusinessProfiles(db),
  ]);

  const profileByKey = new Map(profiles.map((profile) => [profile.canonicalKey, profileFromRow(profile)]));
  const subjectsByGroup = new Map<string, Set<string>>();
  for (const qualification of qualifications) {
    if (!subjectsByGroup.has(qualification.groupId)) {
      subjectsByGroup.set(qualification.groupId, new Set());
    }
    subjectsByGroup.get(qualification.groupId)!.add(qualification.subject);
  }

  return groups
    .map((group) => {
      const profile = profileByKey.get(group.canonicalKey) ?? emptyProfile({
        canonicalKey: group.canonicalKey,
        displayName: group.displayName,
      });
      return {
        ...profile,
        tutorGroupId: group.id,
        displayName: profile.displayName || group.displayName,
        supportedModes: supportedModesFromModality(group.supportedModality),
        subjects: [...(subjectsByGroup.get(group.id) ?? new Set<string>())].sort(),
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listTutorProfileImportIdentities(db: Database): Promise<TutorProfileImportIdentity[]> {
  const snapshotId = await getActiveSnapshotIdOrThrow(db);
  const [groups, members] = await Promise.all([
    db
      .select({
        id: schema.tutorIdentityGroups.id,
        canonicalKey: schema.tutorIdentityGroups.canonicalKey,
        displayName: schema.tutorIdentityGroups.displayName,
      })
      .from(schema.tutorIdentityGroups)
      .where(eq(schema.tutorIdentityGroups.snapshotId, snapshotId)),
    db
      .select({
        groupId: schema.tutorIdentityGroupMembers.groupId,
        wiseDisplayName: schema.tutorIdentityGroupMembers.wiseDisplayName,
      })
      .from(schema.tutorIdentityGroupMembers)
      .where(eq(schema.tutorIdentityGroupMembers.snapshotId, snapshotId)),
  ]);

  const membersByGroup = new Map<string, string[]>();
  for (const member of members) {
    membersByGroup.set(member.groupId, [
      ...(membersByGroup.get(member.groupId) ?? []),
      member.wiseDisplayName,
    ]);
  }

  return groups.map((group) => ({
    canonicalKey: group.canonicalKey,
    displayName: group.displayName,
    wiseDisplayNames: membersByGroup.get(group.id) ?? [],
  }));
}

export async function listTutorProfileImportAliases(db: Database): Promise<TutorProfileImportAliasRow[]> {
  return db
    .select({
      fromKey: schema.tutorAliases.fromKey,
      toKey: schema.tutorAliases.toKey,
    })
    .from(schema.tutorAliases);
}

export async function loadTutorBusinessProfileMap(db: Database): Promise<Map<string, TutorBusinessProfile>> {
  const rows = await selectActiveTutorBusinessProfiles(db);
  return new Map(rows.map((row) => [row.canonicalKey, profileFromRow(row)]));
}

export async function upsertTutorBusinessProfile(
  db: Database,
  canonicalKey: string,
  fallbackDisplayName: string,
  patch: TutorBusinessProfilePatch,
): Promise<TutorBusinessProfile> {
  const [existing] = await db
    .select()
    .from(schema.tutorBusinessProfiles)
    .where(eq(schema.tutorBusinessProfiles.canonicalKey, canonicalKey))
    .limit(1);
  const existingProfile = existing ? profileFromRow(existing) : emptyProfile({ canonicalKey, displayName: fallbackDisplayName });
  const values = {
    canonicalKey,
    displayName: patch.displayName?.trim() || existingProfile.displayName || fallbackDisplayName,
    parentSafeSummary: patch.parentSafeSummary ?? existingProfile.parentSafeSummary,
    internalNotes: patch.internalNotes ?? existingProfile.internalNotes,
    education: patch.education ?? existingProfile.education,
    languages: patch.languages ?? existingProfile.languages,
    englishProficiency: patch.englishProficiency ?? existingProfile.englishProficiency,
    youngLearnerFit: patch.youngLearnerFit ?? existingProfile.youngLearnerFit,
    youngestComfortableAge: patch.youngestComfortableAge === undefined
      ? existingProfile.youngestComfortableAge
      : patch.youngestComfortableAge,
    youngLearnerNotes: patch.youngLearnerNotes ?? existingProfile.youngLearnerNotes,
    teachingStyleTags: patch.teachingStyleTags ? normalizeList(patch.teachingStyleTags) : existingProfile.teachingStyleTags,
    teachingStyleNotes: patch.teachingStyleNotes ?? existingProfile.teachingStyleNotes,
    strengthTags: patch.strengthTags ? normalizeList(patch.strengthTags) : existingProfile.strengthTags,
    curriculumExperience: patch.curriculumExperience ? normalizeList(patch.curriculumExperience) : existingProfile.curriculumExperience,
    studentFitNotes: patch.studentFitNotes ?? existingProfile.studentFitNotes,
    doNotUseForNotes: patch.doNotUseForNotes ?? existingProfile.doNotUseForNotes,
    verifiedBy: patch.verifiedBy === undefined ? existingProfile.verifiedBy : patch.verifiedBy?.trim() || null,
    lastReviewedAt: patch.lastReviewedAt === undefined
      ? existing?.lastReviewedAt ?? null
      : patch.lastReviewedAt
        ? new Date(patch.lastReviewedAt)
        : null,
    active: patch.active ?? existingProfile.active,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(schema.tutorBusinessProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: schema.tutorBusinessProfiles.canonicalKey,
      set: {
        displayName: values.displayName,
        parentSafeSummary: values.parentSafeSummary,
        internalNotes: values.internalNotes,
        education: values.education,
        languages: values.languages,
        englishProficiency: values.englishProficiency,
        youngLearnerFit: values.youngLearnerFit,
        youngestComfortableAge: values.youngestComfortableAge,
        youngLearnerNotes: values.youngLearnerNotes,
        teachingStyleTags: values.teachingStyleTags,
        teachingStyleNotes: values.teachingStyleNotes,
        strengthTags: values.strengthTags,
        curriculumExperience: values.curriculumExperience,
        studentFitNotes: values.studentFitNotes,
        doNotUseForNotes: values.doNotUseForNotes,
        verifiedBy: values.verifiedBy,
        lastReviewedAt: values.lastReviewedAt,
        active: values.active,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  return profileFromRow(row);
}

export async function getActiveTutorDisplayNameByCanonicalKey(
  db: Database,
  canonicalKey: string,
): Promise<string | null> {
  const snapshotId = await getActiveSnapshotIdOrThrow(db);
  const [group] = await db
    .select({ displayName: schema.tutorIdentityGroups.displayName })
    .from(schema.tutorIdentityGroups)
    .where(and(
      eq(schema.tutorIdentityGroups.snapshotId, snapshotId),
      eq(schema.tutorIdentityGroups.canonicalKey, canonicalKey),
    ))
    .limit(1);
  return group?.displayName ?? null;
}
