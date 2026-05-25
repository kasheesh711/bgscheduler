import type { FilterOptions } from "@/lib/data/filters";
import type { SearchFilters } from "@/lib/search/types";

export type AcademicLevelResolutionStatus = "mapped" | "ambiguous" | "unknown";

export interface AcademicLevelResolution {
  rawLevelLabel: string;
  wiseLevel?: string;
  status: AcademicLevelResolutionStatus;
  candidates: string[];
  message: string;
}

interface ResolveAcademicLevelInput {
  rawLevel: string | undefined;
  subject?: string;
  curriculum?: string;
  activeLevels: string[];
}

export interface FilterResolutionResult {
  filters: SearchFilters;
  issues: string[];
  academicLevelResolution?: AcademicLevelResolution;
}

function normalizeLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function compact(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function findCaseInsensitiveOption(value: string | undefined, options: string[]): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeLookup(value);
  return options.find((option) => normalizeLookup(option) === normalized);
}

function findAliasOption(value: string | undefined, aliases: Record<string, string[]>, options: string[]): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeLookup(value).replace(/[._]/g, "").replace(/\s*-\s*/g, "-");
  for (const [canonical, patterns] of Object.entries(aliases)) {
    if (!options.some((option) => normalizeLookup(option) === normalizeLookup(canonical))) continue;
    if (patterns.some((pattern) => normalized === normalizeLookup(pattern).replace(/[._]/g, "").replace(/\s*-\s*/g, "-"))) {
      return options.find((option) => normalizeLookup(option) === normalizeLookup(canonical));
    }
  }
  return undefined;
}

function findSubjectOption(value: string | undefined, options: string[]): string | undefined {
  return findCaseInsensitiveOption(value, options) ??
    findAliasOption(value, {
      Econ: ["economics", "economic"],
      English: ["eng", "english writing", "writing english", "writing"],
      EnglishVR: ["english vr", "vr english", "11+ english", "13+ english", "entrance english"],
      NonVR: ["non vr", "non-vr", "nonverbal", "non verbal"],
      Math: ["maths", "mathematics"],
      Science: ["sci"],
    }, options) ??
    options.find((option) => normalizeLookup(value ?? "").startsWith(`${normalizeLookup(option)} `));
}

function findCurriculumOption(value: string | undefined, options: string[]): string | undefined {
  return findCaseInsensitiveOption(value, options) ??
    findAliasOption(value, {
      International: ["int", "int.", "international", "inter", "ib", "myp", "igcse", "a-level", "a level"],
      Thai: ["thai", "thai curriculum", "thai school"],
    }, options);
}

function available(candidates: string[], activeLevels: string[]): string[] {
  return candidates.filter((candidate) => activeLevels.some((level) => normalizeLookup(level) === normalizeLookup(candidate)));
}

function mapped(rawLevelLabel: string, wiseLevel: string): AcademicLevelResolution {
  return {
    rawLevelLabel,
    wiseLevel,
    status: "mapped",
    candidates: [wiseLevel],
    message: `Requested: ${rawLevelLabel} · Wise filter: ${wiseLevel}`,
  };
}

function ambiguous(rawLevelLabel: string, candidates: string[]): AcademicLevelResolution {
  return {
    rawLevelLabel,
    status: "ambiguous",
    candidates,
    message: `Level "${rawLevelLabel}" could mean ${candidates.join(" or ")}. Please clarify the curriculum or exact Wise level.`,
  };
}

function unknown(rawLevelLabel: string): AcademicLevelResolution {
  return {
    rawLevelLabel,
    status: "unknown",
    candidates: [],
    message: `Level "${rawLevelLabel}" is not an active Wise qualification. Please clarify the exact requirement.`,
  };
}

function yearBucket(year: number): string | undefined {
  if (year >= 2 && year <= 8) return "Y2-8";
  if (year >= 9 && year <= 11) return "Y9-11";
  if (year >= 12 && year <= 13) return "Y12-13";
  return undefined;
}

function thaiGradeBucket(grade: number): string | undefined {
  if (grade >= 1 && grade <= 9) return "G1-9";
  if (grade >= 10 && grade <= 12) return "G10-12";
  return undefined;
}

function curriculumKind(curriculum: string | undefined): "international" | "thai" | undefined {
  const normalized = normalizeLookup(curriculum ?? "");
  if (!normalized) return undefined;
  if (normalized.includes("thai")) return "thai";
  if (normalized.includes("international") || normalized === "int" || normalized === "int.") return "international";
  return undefined;
}

function parseRawLevel(raw: string): {
  kind: "year" | "grade" | "thai_secondary" | "thai_primary" | "plus" | "exam" | "unknown";
  number?: number;
  label?: string;
} {
  const normalized = normalizeLookup(raw)
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ");

  const plus = normalized.match(/^(\d{1,2})\+$/);
  if (plus) return { kind: "plus", number: Number(plus[1]) };

  const year = normalized.match(/^(?:y|year)\s*(\d{1,2})$/);
  if (year) return { kind: "year", number: Number(year[1]) };

  const grade = normalized.match(/^(?:g|grade)\s*(\d{1,2})$/);
  if (grade) return { kind: "grade", number: Number(grade[1]) };

  const thaiSecondary = normalized.match(/^ม\.?\s*(\d)$/);
  if (thaiSecondary) return { kind: "thai_secondary", number: Number(thaiSecondary[1]) };

  const thaiPrimary = normalized.match(/^ป\.?\s*(\d)$/);
  if (thaiPrimary) return { kind: "thai_primary", number: Number(thaiPrimary[1]) };

  const examAliases: Record<string, string[]> = {
    "AP": ["ap", "advanced placement"],
    "GED": ["ged"],
    "IELTS": ["ielts"],
    "SAT": ["sat"],
    "Uni": ["uni", "university", "undergraduate"],
    "IGCSE": ["igcse", "gcse"],
    "A-Level": ["a-level", "a level", "alevel", "ial"],
    "IB": ["ib", "international baccalaureate"],
    "MYP": ["myp", "ib myp"],
    "16+": ["16+"],
  };
  const exam = Object.entries(examAliases).find(([, aliases]) => aliases.some((label) => normalized === label));
  if (exam) return { kind: "exam", label: exam[0] };

  return { kind: "unknown" };
}

export function resolveAcademicLevel(input: ResolveAcademicLevelInput): AcademicLevelResolution | undefined {
  const rawLevelLabel = compact(input.rawLevel);
  if (!rawLevelLabel) return undefined;

  const exact = findCaseInsensitiveOption(rawLevelLabel, input.activeLevels);
  if (exact) return mapped(rawLevelLabel, exact);

  const parsed = parseRawLevel(rawLevelLabel);
  const curriculum = curriculumKind(input.curriculum);

  if (parsed.kind === "year" && parsed.number !== undefined) {
    const bucket = yearBucket(parsed.number);
    const [candidate] = bucket ? available([bucket], input.activeLevels) : [];
    return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
  }

  if (parsed.kind === "plus" && parsed.number !== undefined) {
    if (parsed.number === 11 || parsed.number === 13) {
      const [candidate] = available(["11+/13+"], input.activeLevels);
      return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
    }
    if (parsed.number === 16) {
      const [candidate] = available(["16+"], input.activeLevels);
      return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
    }
  }

  if (parsed.kind === "thai_secondary" && parsed.number !== undefined) {
    const grade = parsed.number + 6;
    const bucket = thaiGradeBucket(grade);
    const [candidate] = bucket ? available([bucket], input.activeLevels) : [];
    return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
  }

  if (parsed.kind === "thai_primary" && parsed.number !== undefined) {
    const [candidate] = available(["G1-9"], input.activeLevels);
    return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
  }

  if (parsed.kind === "exam" && parsed.label) {
    const candidates = [parsed.label, parsed.label.toUpperCase()];
    const [candidate] = available(candidates, input.activeLevels);
    return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
  }

  if (parsed.kind === "grade" && parsed.number !== undefined) {
    const international = yearBucket(parsed.number);
    const thai = thaiGradeBucket(parsed.number);

    if (curriculum === "international" && international) {
      const [candidate] = available([international], input.activeLevels);
      return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
    }

    if (curriculum === "thai" && thai) {
      const [candidate] = available([thai], input.activeLevels);
      return candidate ? mapped(rawLevelLabel, candidate) : unknown(rawLevelLabel);
    }

    const candidates = available([international, thai].filter(Boolean) as string[], input.activeLevels);
    if (candidates.length === 1) return mapped(rawLevelLabel, candidates[0]);
    if (candidates.length > 1) return ambiguous(rawLevelLabel, candidates);
  }

  return unknown(rawLevelLabel);
}

export function recoverFiltersFromUnknowns(input: {
  filters: SearchFilters;
  explicitUnknownFilters: string[];
  options: FilterOptions;
}): {
  filters: SearchFilters;
  academicLevelResolution?: AcademicLevelResolution;
  remainingUnknowns: string[];
} {
  const filters: SearchFilters = { ...input.filters };
  const remainingUnknowns: string[] = [];
  let academicLevelResolution: AcademicLevelResolution | undefined;

  for (const unknownFilter of input.explicitUnknownFilters) {
    const trimmed = compact(unknownFilter);
    if (!trimmed) continue;

    const subject = findSubjectOption(trimmed, input.options.subjects);
    if (subject) {
      if (!filters.subject) filters.subject = subject;
      continue;
    }

    const curriculum = findCurriculumOption(trimmed, input.options.curriculums);
    if (curriculum) {
      if (!filters.curriculum) filters.curriculum = curriculum;
      continue;
    }

    const levelResolution = resolveAcademicLevel({
      rawLevel: trimmed,
      subject: filters.subject,
      curriculum: filters.curriculum,
      activeLevels: input.options.levels,
    });
    if (levelResolution?.status === "mapped" && levelResolution.wiseLevel) {
      if (!filters.level) filters.level = levelResolution.wiseLevel;
      academicLevelResolution = levelResolution;
      continue;
    }

    remainingUnknowns.push(trimmed);
  }

  return { filters, academicLevelResolution, remainingUnknowns };
}

export function resolveAcademicFilters(
  filters: SearchFilters,
  options: FilterOptions,
): FilterResolutionResult {
  const resolved: SearchFilters = {};
  const issues: string[] = [];

  const subject = findSubjectOption(filters.subject, options.subjects);
  if (filters.subject && !subject) issues.push(`Subject "${filters.subject}" is not an active Wise qualification.`);
  if (subject) resolved.subject = subject;

  const curriculum = findCurriculumOption(filters.curriculum, options.curriculums);
  if (filters.curriculum && !curriculum) issues.push(`Curriculum "${filters.curriculum}" is not an active Wise qualification.`);
  if (curriculum) resolved.curriculum = curriculum;

  const levelResolution = resolveAcademicLevel({
    rawLevel: filters.level,
    subject: resolved.subject,
    curriculum: resolved.curriculum,
    activeLevels: options.levels,
  });
  if (levelResolution?.status === "mapped" && levelResolution.wiseLevel) {
    resolved.level = levelResolution.wiseLevel;
  } else if (levelResolution) {
    issues.push(levelResolution.message);
  }

  return {
    filters: resolved,
    issues,
    academicLevelResolution: levelResolution,
  };
}
