import * as XLSX from "xlsx";
import type {
  EnglishProficiency,
  TutorBusinessProfileListItem,
  TutorBusinessProfilePatch,
  YoungLearnerFit,
} from "@/lib/tutor-business-profiles";
import {
  CURRICULUM_EXPERIENCE_VOCABULARY,
  TEACHING_STYLE_VOCABULARY,
} from "@/lib/tutor-profile-vocabulary";

export interface TutorProfileImportSourceRow {
  canonicalKey?: string;
  nickname?: string;
  firstName?: string;
  lastName?: string;
  rowNumber: number;
}

export interface TutorEducationImportRow extends TutorProfileImportSourceRow {
  undergraduateDegree?: string;
  undergraduateUniversity?: string;
  undergraduateLocation?: string;
  mastersDegree?: string;
  mastersUniversity?: string;
  mastersLocation?: string;
  doctorateDegree?: string;
  doctorateUniversity?: string;
  doctorateLocation?: string;
  otherQualifications?: string;
  fluentInEnglish?: string;
}

export interface TutorAvailabilityImportRow extends TutorProfileImportSourceRow {
  tier?: string;
  academicBackground?: string;
  academicAchievement?: string;
  highlights?: string;
  profilePicture?: string;
  youngLearnerFit?: YoungLearnerFit;
  youngestComfortableAge?: number | null;
  youngLearnerNotes?: string;
  teachingStyleTags?: string[];
  teachingStyleNotes?: string;
}

export interface TutorProfileImportMatchedRow {
  canonicalKey: string;
  displayName: string;
  matchedBy: "canonicalKey" | "nickname" | "fullName";
  sourceName: string;
  patch: TutorBusinessProfilePatch;
  warnings: string[];
  sources: string[];
}

export interface TutorProfileImportUnmatchedRow {
  source: "education" | "availability";
  rowNumber: number;
  sourceName: string;
  reason: string;
}

export interface TutorProfileImportPreview {
  summary: {
    educationRows: number;
    availabilityRows: number;
    matchedRows: number;
    unmatchedRows: number;
    duplicateSourceRows: number;
    availabilityOnlyRows: number;
    invalidRows: number;
  };
  rows: TutorProfileImportMatchedRow[];
  unmatchedRows: TutorProfileImportUnmatchedRow[];
  duplicateSourceRows: string[];
  availabilityOnlyRows: string[];
  invalidRows: string[];
  vocabulary: {
    teachingStyleTags: typeof TEACHING_STYLE_VOCABULARY;
    curriculumExperience: typeof CURRICULUM_EXPERIENCE_VOCABULARY;
  };
}

interface BuildPreviewInput {
  educationRows: TutorEducationImportRow[];
  availabilityRows: TutorAvailabilityImportRow[];
  activeProfiles: TutorBusinessProfileListItem[];
  verifiedBy?: string | null;
  lastReviewedAt?: string | null;
}

interface CombinedSource {
  sourceKey: string;
  sourceName: string;
  education?: TutorEducationImportRow;
  availability?: TutorAvailabilityImportRow;
  sources: string[];
  warnings: string[];
}

const ENGLISH_RANK: Record<EnglishProficiency, number> = {
  unknown: 0,
  basic: 1,
  conversational: 2,
  fluent: 3,
  "near-native": 4,
  native: 5,
};

const MAX_INTERNAL_NOTES = 3000;
const MAX_PARENT_SUMMARY = 1200;
const MAX_NOTES = 2000;

function clean(value: unknown): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function compactSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return compactSpaces(value).toLowerCase();
}

function sourceName(row: TutorProfileImportSourceRow): string {
  return compactSpaces([
    row.nickname ? `${row.nickname} |` : "",
    row.firstName,
    row.lastName,
  ].filter(Boolean).join(" ")) || row.canonicalKey || `row ${row.rowNumber}`;
}

function fullName(row: TutorProfileImportSourceRow): string {
  return compactSpaces([row.firstName, row.lastName].filter(Boolean).join(" "));
}

function sourceKey(row: TutorProfileImportSourceRow): string {
  if (row.canonicalKey) return `canonical:${normalizeKey(row.canonicalKey)}`;
  const name = fullName(row);
  if (name) return `name:${normalizeKey(name)}`;
  if (row.nickname) return `nickname:${normalizeKey(row.nickname)}`;
  return `row:${row.rowNumber}`;
}

function headerKey(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findHeaderIndex(headers: unknown[], aliases: string[]): number {
  const wanted = new Set(aliases.map(headerKey));
  return headers.findIndex((header) => wanted.has(headerKey(header)));
}

function getByIndex(row: unknown[], index: number): string | undefined {
  if (index < 0) return undefined;
  const value = clean(row[index]);
  return value || undefined;
}

function getByHeader(row: unknown[], headers: unknown[], aliases: string[]): string | undefined {
  return getByIndex(row, findHeaderIndex(headers, aliases));
}

function worksheetRows(buffer: Buffer): unknown[][] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
}

export function parseEducationWorkbook(buffer: Buffer): TutorEducationImportRow[] {
  const rows = worksheetRows(buffer);
  const headers = rows[0] ?? [];
  return rows
    .slice(1)
    .map((row, index): TutorEducationImportRow => ({
      canonicalKey: getByHeader(row, headers, ["canonicalKey", "canonical_key"]),
      firstName: getByHeader(row, headers, ["firstName", "first name"]),
      lastName: getByHeader(row, headers, ["lastName", "last name"]),
      undergraduateDegree: getByHeader(row, headers, ["undergraduate degree", "undergrad degree"]),
      undergraduateUniversity: getByHeader(row, headers, ["undergrad university", "undergraduate university"]),
      undergraduateLocation: getByHeader(row, headers, ["undergrad location", "undergraduate location"]),
      mastersDegree: getByHeader(row, headers, ["masters degree", "master degree"]),
      mastersUniversity: getByHeader(row, headers, ["masters university", "master university"]),
      mastersLocation: getByHeader(row, headers, ["masters location", "master location"]),
      doctorateDegree: getByHeader(row, headers, ["doctorate+ degree", "doctorate degree", "phd degree"]),
      doctorateUniversity: getByHeader(row, headers, ["doctorate+ university", "doctorate university", "phd university"]),
      doctorateLocation: getByHeader(row, headers, ["doctorate+ location", "doctorate location", "phd location"]),
      otherQualifications: getByHeader(row, headers, ["other qualifications", "other qualification"]),
      fluentInEnglish: getByHeader(row, headers, ["fluent in english", "english proficiency", "english"]),
      rowNumber: index + 2,
    }))
    .filter((row) => row.canonicalKey || row.firstName || row.lastName);
}

export function parseAvailabilityWorkbook(buffer: Buffer): TutorAvailabilityImportRow[] {
  const rows = worksheetRows(buffer);
  const firstRow = rows[0] ?? [];
  const secondRow = rows[1] ?? [];
  const hasSingleHeader = findHeaderIndex(firstRow, ["canonicalKey", "canonical_key"]) >= 0;
  const headers = hasSingleHeader ? firstRow : secondRow;
  const offset = hasSingleHeader ? 1 : 2;

  return rows
    .slice(offset)
    .map((row, index): TutorAvailabilityImportRow => {
      const oneBasedRow = index + offset + 1;
      if (hasSingleHeader) {
        return {
          canonicalKey: getByHeader(row, headers, ["canonicalKey", "canonical_key"]),
          nickname: getByHeader(row, headers, ["nickname", "nick name"]),
          firstName: getByHeader(row, headers, ["firstName", "first name"]),
          lastName: getByHeader(row, headers, ["lastName", "last name"]),
          tier: getByHeader(row, headers, ["tier"]),
          academicBackground: getByHeader(row, headers, ["academic background"]),
          academicAchievement: getByHeader(row, headers, ["academic achievement"]),
          highlights: getByHeader(row, headers, ["highlights", "profile highlights"]),
          profilePicture: getByHeader(row, headers, ["profile picture", "profile photo"]),
          youngLearnerFit: parseYoungLearnerFit(getByHeader(row, headers, ["youngLearnerFit", "young learner fit", "comfortable younger kids"])),
          youngestComfortableAge: parseAge(getByHeader(row, headers, ["youngestComfortableAge", "youngest comfortable age", "youngest age"])),
          youngLearnerNotes: getByHeader(row, headers, ["youngLearnerNotes", "young learner notes"]),
          teachingStyleTags: splitTags(getByHeader(row, headers, ["teachingStyleTags", "teaching style tags"])),
          teachingStyleNotes: getByHeader(row, headers, ["teachingStyleNotes", "teaching style notes", "teaching style"]),
          rowNumber: oneBasedRow,
        };
      }

      return {
        tier: getByIndex(row, 0),
        nickname: getByIndex(row, 1),
        firstName: getByIndex(row, 2),
        lastName: getByIndex(row, 3),
        academicBackground: getByIndex(row, 18),
        academicAchievement: getByIndex(row, 19),
        highlights: getByIndex(row, 20),
        profilePicture: getByIndex(row, 21),
        rowNumber: oneBasedRow,
      };
    })
    .filter((row) => row.canonicalKey || row.nickname || row.firstName || row.lastName);
}

function splitTags(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\n]/)
    .map((item) => compactSpaces(item))
    .filter(Boolean);
}

function parseYoungLearnerFit(value: string | undefined): YoungLearnerFit | undefined {
  const normalized = normalizeKey(value ?? "");
  if (!normalized) return undefined;
  if (["yes", "comfortable", "true", "ok", "okay"].includes(normalized)) return "comfortable";
  if (["no", "notcomfortable", "false"].includes(normalized)) return "not_comfortable";
  if (["conditional", "depends"].includes(normalized)) return "conditional";
  if (normalized === "unknown") return "unknown";
  return undefined;
}

function parseAge(value: string | undefined): number | null | undefined {
  const normalized = clean(value);
  if (!normalized) return undefined;
  const numeric = Number(normalized);
  if (!Number.isInteger(numeric) || numeric < 3 || numeric > 20) return null;
  return numeric;
}

function englishFromSource(value: string | undefined): EnglishProficiency {
  const normalized = normalizeKey(value ?? "");
  if (["yes", "y", "true", "fluent"].includes(normalized)) return "fluent";
  if (["native", "near-native", "nearnative", "conversational", "basic"].includes(normalized)) {
    return normalized === "nearnative" ? "near-native" : normalized as EnglishProficiency;
  }
  return "unknown";
}

function addEducationEntry(
  entries: NonNullable<TutorBusinessProfilePatch["education"]>,
  institution: string | undefined,
  program: string | undefined,
  country: string | undefined,
  notes?: string,
) {
  if (!institution && !program && !notes) return;
  entries.push({
    institution: compactSpaces(institution || "Other qualifications").slice(0, 160),
    program: program ? compactSpaces(program).slice(0, 240) : undefined,
    country: country ? compactSpaces(country).slice(0, 80) : undefined,
    notes: notes ? notes.trim().slice(0, 500) : undefined,
  });
}

function inferCurriculumExperience(text: string): string[] {
  const lower = text.toLowerCase();
  return CURRICULUM_EXPERIENCE_VOCABULARY.filter((tag) => {
    const normalized = tag.toLowerCase();
    if (normalized === "a-level") return /\ba[\s-]?levels?\b|\bial\b/.test(lower);
    if (normalized === "international") return /international|ib|igcse|a-level|ap|sat|ielts/.test(lower);
    return lower.includes(normalized.toLowerCase());
  });
}

function inferTeachingStyleTags(text: string): string[] {
  const lower = text.toLowerCase();
  return TEACHING_STYLE_VOCABULARY
    .filter((entry) => entry.synonyms.some((synonym) => lower.includes(synonym.toLowerCase())))
    .map((entry) => entry.tag);
}

function inferYoungLearnerFields(text: string): Pick<TutorBusinessProfilePatch, "youngLearnerFit" | "youngestComfortableAge" | "youngLearnerNotes"> {
  const lower = text.toLowerCase();
  if (!/(young|kid|child|children|primary|elementary|younger)/.test(lower)) return {};
  const youngestComfortableAge = /primary|elementary/.test(lower) ? 6 : undefined;
  return {
    youngLearnerFit: "comfortable",
    youngestComfortableAge,
    youngLearnerNotes: "Imported text mentions experience with younger, primary, elementary, or child learners.",
  };
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildCandidatePatch(
  combined: CombinedSource,
  verifiedBy?: string | null,
  lastReviewedAt?: string | null,
): TutorBusinessProfilePatch {
  const education: NonNullable<TutorBusinessProfilePatch["education"]> = [];
  const internalNotes: string[] = [];
  const curriculumExperience = new Set<string>();
  const teachingStyleTags = new Set<string>();
  const strengthTags = new Set<string>();
  let parentSafeSummary = "";
  let englishProficiency: EnglishProficiency = "unknown";
  let youngLearnerFit: YoungLearnerFit = "unknown";
  let youngestComfortableAge: number | null | undefined;
  let youngLearnerNotes = "";
  let teachingStyleNotes = "";
  let studentFitNotes = "";

  if (combined.education) {
    const row = combined.education;
    addEducationEntry(education, row.undergraduateUniversity, row.undergraduateDegree, row.undergraduateLocation);
    addEducationEntry(education, row.mastersUniversity, row.mastersDegree, row.mastersLocation);
    addEducationEntry(education, row.doctorateUniversity, row.doctorateDegree, row.doctorateLocation);
    addEducationEntry(education, "Other qualifications", undefined, undefined, row.otherQualifications);
    englishProficiency = englishFromSource(row.fluentInEnglish);
    if (row.fluentInEnglish) {
      internalNotes.push(`BeGifted Tutors-3.xlsx English fluency value: ${row.fluentInEnglish}.`);
    }
  }

  if (combined.availability) {
    const row = combined.availability;
    const text = [
      row.academicBackground,
      row.academicAchievement,
      row.highlights,
      row.youngLearnerNotes,
      row.teachingStyleNotes,
    ].filter(Boolean).join("\n");
    parentSafeSummary = row.highlights ?? "";
    teachingStyleNotes = row.teachingStyleNotes ?? "";
    studentFitNotes = row.highlights ?? "";
    if (row.tier) internalNotes.push(`Availability.xlsx tier: ${row.tier}.`);
    if (row.profilePicture) internalNotes.push(`Profile picture reference: ${row.profilePicture}.`);
    if (row.academicBackground) internalNotes.push(`Academic background: ${row.academicBackground}`);
    if (row.academicAchievement) internalNotes.push(`Academic achievement: ${row.academicAchievement}`);
    if (row.highlights) internalNotes.push(`Highlights: ${row.highlights}`);
    internalNotes.push("Availability.xlsx weekly availability columns were ignored; Wise remains the scheduling source of truth.");

    for (const tag of inferCurriculumExperience(text)) curriculumExperience.add(tag);
    for (const tag of inferTeachingStyleTags(text)) teachingStyleTags.add(tag);
    for (const tag of row.teachingStyleTags ?? []) teachingStyleTags.add(tag);
    if (/writing|essay|paragraph|report/i.test(text)) strengthTags.add("writing");
    if (/exam|sat|ielts|igcse|a-level|ap/i.test(text)) strengthTags.add("exam prep");

    const inferredYoungLearner = inferYoungLearnerFields(text);
    youngLearnerFit = row.youngLearnerFit ?? inferredYoungLearner.youngLearnerFit ?? "unknown";
    youngestComfortableAge = row.youngestComfortableAge ?? inferredYoungLearner.youngestComfortableAge;
    youngLearnerNotes = row.youngLearnerNotes ?? inferredYoungLearner.youngLearnerNotes ?? "";
  }

  return {
    parentSafeSummary: clamp(parentSafeSummary, MAX_PARENT_SUMMARY),
    internalNotes: clamp(internalNotes.filter(Boolean).join("\n"), MAX_INTERNAL_NOTES),
    education,
    languages: englishProficiency === "unknown"
      ? []
      : [{ language: "English", proficiency: englishProficiency, verificationSource: "BeGifted Tutors-3.xlsx" }],
    englishProficiency,
    youngLearnerFit,
    youngestComfortableAge: youngestComfortableAge ?? null,
    youngLearnerNotes: clamp(youngLearnerNotes, MAX_NOTES),
    teachingStyleTags: [...teachingStyleTags],
    teachingStyleNotes: clamp(teachingStyleNotes, MAX_NOTES),
    strengthTags: [...strengthTags],
    curriculumExperience: [...curriculumExperience],
    studentFitNotes: clamp(studentFitNotes, MAX_NOTES),
    verifiedBy: verifiedBy ?? null,
    lastReviewedAt: lastReviewedAt ?? null,
    active: true,
  };
}

function mergeText(existing: string, incoming: string | undefined, max: number): string {
  const next = clean(incoming);
  if (!next) return existing;
  if (!existing) return clamp(next, max);
  if (existing.includes(next)) return existing;
  return clamp(`${existing}\n\n${next}`, max);
}

function mergeTags(existing: string[], incoming: string[] | undefined): string[] {
  const result = new Map(existing.map((tag) => [normalizeKey(tag), tag]));
  for (const tag of incoming ?? []) {
    const cleaned = compactSpaces(tag);
    if (cleaned) result.set(normalizeKey(cleaned), cleaned);
  }
  return [...result.values()];
}

function mergeEducation(
  existing: TutorBusinessProfileListItem["education"],
  incoming: TutorBusinessProfilePatch["education"],
): TutorBusinessProfileListItem["education"] {
  const result = [...existing];
  const keys = new Set(result.map((entry) => normalizeKey([entry.institution, entry.program].filter(Boolean).join("|"))));
  for (const entry of incoming ?? []) {
    const key = normalizeKey([entry.institution, entry.program].filter(Boolean).join("|"));
    if (!key || keys.has(key)) continue;
    keys.add(key);
    result.push(entry);
  }
  return result;
}

function mergeLanguages(
  existing: TutorBusinessProfileListItem["languages"],
  incoming: TutorBusinessProfilePatch["languages"],
): TutorBusinessProfileListItem["languages"] {
  const result = [...existing];
  const keys = new Set(result.map((entry) => normalizeKey([entry.language, entry.proficiency].join("|"))));
  for (const entry of incoming ?? []) {
    const key = normalizeKey([entry.language, entry.proficiency].join("|"));
    if (!key || keys.has(key)) continue;
    keys.add(key);
    result.push(entry);
  }
  return result;
}

function bestEnglish(existing: EnglishProficiency, incoming: EnglishProficiency | undefined): EnglishProficiency {
  if (!incoming) return existing;
  return ENGLISH_RANK[incoming] > ENGLISH_RANK[existing] ? incoming : existing;
}

function mergePatchWithExisting(
  existing: TutorBusinessProfileListItem,
  incoming: TutorBusinessProfilePatch,
): TutorBusinessProfilePatch {
  return {
    displayName: existing.displayName,
    parentSafeSummary: mergeText(existing.parentSafeSummary, incoming.parentSafeSummary, MAX_PARENT_SUMMARY),
    internalNotes: mergeText(existing.internalNotes, incoming.internalNotes, MAX_INTERNAL_NOTES),
    education: mergeEducation(existing.education, incoming.education),
    languages: mergeLanguages(existing.languages, incoming.languages),
    englishProficiency: bestEnglish(existing.englishProficiency, incoming.englishProficiency),
    youngLearnerFit: existing.youngLearnerFit !== "unknown" ? existing.youngLearnerFit : incoming.youngLearnerFit,
    youngestComfortableAge: existing.youngestComfortableAge ?? incoming.youngestComfortableAge ?? null,
    youngLearnerNotes: mergeText(existing.youngLearnerNotes, incoming.youngLearnerNotes, MAX_NOTES),
    teachingStyleTags: mergeTags(existing.teachingStyleTags, incoming.teachingStyleTags),
    teachingStyleNotes: mergeText(existing.teachingStyleNotes, incoming.teachingStyleNotes, MAX_NOTES),
    strengthTags: mergeTags(existing.strengthTags, incoming.strengthTags),
    curriculumExperience: mergeTags(existing.curriculumExperience, incoming.curriculumExperience),
    studentFitNotes: mergeText(existing.studentFitNotes, incoming.studentFitNotes, MAX_NOTES),
    doNotUseForNotes: existing.doNotUseForNotes,
    verifiedBy: existing.verifiedBy ?? incoming.verifiedBy ?? null,
    lastReviewedAt: existing.lastReviewedAt ?? incoming.lastReviewedAt ?? null,
    active: existing.active,
  };
}

function combineRows(
  educationRows: TutorEducationImportRow[],
  availabilityRows: TutorAvailabilityImportRow[],
): { combined: CombinedSource[]; duplicateSourceRows: string[]; availabilityOnlyRows: string[] } {
  const byKey = new Map<string, CombinedSource>();
  const duplicateSourceRows: string[] = [];

  for (const row of educationRows) {
    const key = sourceKey(row);
    if (byKey.has(key)) duplicateSourceRows.push(`Education row ${row.rowNumber}: ${sourceName(row)}`);
    const existing = byKey.get(key);
    byKey.set(key, {
      sourceKey: key,
      sourceName: existing?.sourceName ?? sourceName(row),
      education: row,
      availability: existing?.availability,
      sources: [...(existing?.sources ?? []), "BeGifted Tutors-3.xlsx"],
      warnings: existing?.warnings ?? [],
    });
  }

  for (const row of availabilityRows) {
    const key = sourceKey(row);
    if (byKey.has(key) && byKey.get(key)?.availability) {
      duplicateSourceRows.push(`Availability row ${row.rowNumber}: ${sourceName(row)}`);
    }
    const existing = byKey.get(key);
    byKey.set(key, {
      sourceKey: key,
      sourceName: existing?.sourceName ?? sourceName(row),
      education: existing?.education,
      availability: row,
      sources: [...(existing?.sources ?? []), "Availability.xlsx"],
      warnings: existing?.warnings ?? [],
    });
  }

  const availabilityOnlyRows = [...byKey.values()]
    .filter((entry) => entry.availability && !entry.education)
    .map((entry) => entry.sourceName);

  return {
    combined: [...byKey.values()],
    duplicateSourceRows,
    availabilityOnlyRows,
  };
}

function buildActiveLookup(activeProfiles: TutorBusinessProfileListItem[]) {
  const byCanonicalKey = new Map<string, TutorBusinessProfileListItem>();
  const byDisplayName = new Map<string, TutorBusinessProfileListItem>();
  for (const profile of activeProfiles) {
    byCanonicalKey.set(normalizeKey(profile.canonicalKey), profile);
    byDisplayName.set(normalizeKey(profile.displayName), profile);
  }
  return { byCanonicalKey, byDisplayName };
}

function resolveProfile(
  entry: CombinedSource,
  activeProfiles: TutorBusinessProfileListItem[],
): { profile: TutorBusinessProfileListItem; matchedBy: TutorProfileImportMatchedRow["matchedBy"] } | null {
  const { byCanonicalKey, byDisplayName } = buildActiveLookup(activeProfiles);
  const explicitKey = entry.education?.canonicalKey ?? entry.availability?.canonicalKey;
  if (explicitKey) {
    const profile = byCanonicalKey.get(normalizeKey(explicitKey));
    return profile ? { profile, matchedBy: "canonicalKey" } : null;
  }
  const nickname = entry.availability?.nickname;
  if (nickname) {
    const profile = byDisplayName.get(normalizeKey(nickname)) ?? byCanonicalKey.get(normalizeKey(nickname));
    if (profile) return { profile, matchedBy: "nickname" };
  }
  const name = fullName(entry.availability ?? entry.education ?? { rowNumber: 0 });
  if (name) {
    const profile = byDisplayName.get(normalizeKey(name));
    if (profile) return { profile, matchedBy: "fullName" };
  }
  return null;
}

function sourceWarnings(entry: CombinedSource, matchType: TutorProfileImportMatchedRow["matchedBy"]): string[] {
  const warnings = [...entry.warnings];
  if (!entry.education?.canonicalKey && !entry.availability?.canonicalKey) {
    warnings.push(`Missing canonicalKey; matched by ${matchType} for this import preview.`);
  }
  if (entry.availability && !entry.education) {
    warnings.push("Availability/profile row has no matching education row.");
  }
  return warnings;
}

export function buildTutorProfileImportPreview(input: BuildPreviewInput): TutorProfileImportPreview {
  const { combined, duplicateSourceRows, availabilityOnlyRows } = combineRows(input.educationRows, input.availabilityRows);
  const rows: TutorProfileImportMatchedRow[] = [];
  const unmatchedRows: TutorProfileImportUnmatchedRow[] = [];
  const invalidRows: string[] = [];

  for (const entry of combined) {
    const resolved = resolveProfile(entry, input.activeProfiles);
    if (!resolved) {
      const row = entry.education ?? entry.availability;
      unmatchedRows.push({
        source: entry.education ? "education" : "availability",
        rowNumber: row?.rowNumber ?? 0,
        sourceName: entry.sourceName,
        reason: "No active tutor matched by canonicalKey, nickname, or full name.",
      });
      continue;
    }

    const candidatePatch = buildCandidatePatch(entry, input.verifiedBy, input.lastReviewedAt);
    const patch = mergePatchWithExisting(resolved.profile, candidatePatch);
    if (entry.availability?.youngestComfortableAge === null) {
      invalidRows.push(`Availability row ${entry.availability.rowNumber}: invalid youngest comfortable age.`);
    }
    rows.push({
      canonicalKey: resolved.profile.canonicalKey,
      displayName: resolved.profile.displayName,
      matchedBy: resolved.matchedBy,
      sourceName: entry.sourceName,
      patch,
      warnings: sourceWarnings(entry, resolved.matchedBy),
      sources: [...new Set(entry.sources)],
    });
  }

  return {
    summary: {
      educationRows: input.educationRows.length,
      availabilityRows: input.availabilityRows.length,
      matchedRows: rows.length,
      unmatchedRows: unmatchedRows.length,
      duplicateSourceRows: duplicateSourceRows.length,
      availabilityOnlyRows: availabilityOnlyRows.length,
      invalidRows: invalidRows.length,
    },
    rows: rows.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    unmatchedRows,
    duplicateSourceRows,
    availabilityOnlyRows,
    invalidRows,
    vocabulary: {
      teachingStyleTags: TEACHING_STYLE_VOCABULARY,
      curriculumExperience: CURRICULUM_EXPERIENCE_VOCABULARY,
    },
  };
}

export function parseTutorProfileImportWorkbooks(input: {
  educationWorkbook?: Buffer;
  availabilityWorkbook?: Buffer;
}): {
  educationRows: TutorEducationImportRow[];
  availabilityRows: TutorAvailabilityImportRow[];
} {
  return {
    educationRows: input.educationWorkbook ? parseEducationWorkbook(input.educationWorkbook) : [],
    availabilityRows: input.availabilityWorkbook ? parseAvailabilityWorkbook(input.availabilityWorkbook) : [],
  };
}
