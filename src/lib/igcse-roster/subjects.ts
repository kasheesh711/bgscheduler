import { PROGRAM_MAP } from "@/lib/sales-dashboard/program-map";

const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** Class `subject` bands that Wise uses for IGCSE classes (every IGCSE row in PROGRAM_MAP, incl. 2-STU/3-STU/Master). */
const IGCSE_BANDS = new Set(
  Object.entries(PROGRAM_MAP)
    .filter(([program]) => /igcse/i.test(program))
    .flatMap(([program, band]) => [norm(program), norm(band)]),
);

export function isIgcseBand(subject: string | null | undefined): boolean {
  const value = (subject ?? "").trim();
  if (!value) return false;
  return IGCSE_BANDS.has(norm(value)) || /igcse/i.test(value);
}

/** Question-bank syllabus codes, keyed by the reviewed academic subject. */
const BANK_SYLLABI = {
  biology: ["0610"],
  chemistry: ["0620"],
  physics: ["0625"],
  maths: ["0580", "0607"],
  literature: ["0475"],
  english: ["0500"],
  economics: ["0455"],
  business: ["0450"],
} as const;

/**
 * Maps a reviewed academic subject label (free text such as "IGCSE Physics" or
 * "Math") to bank syllabus codes. Returns null for anything not in the bank:
 * other subjects, Further/Additional Maths, combined science, or a label that
 * names more than one bank subject.
 */
export function syllabiForAcademicSubject(subject: string | null | undefined): string[] | null {
  const label = norm(subject ?? "");
  if (!label) return null;
  if (/\b(further|additional|add\.?)\b|combined|co-?ordinated|\bscience\b|\b(esl|efl)\b|second language/.test(label)) return null;
  if (/\bliterature\b/.test(label) && /\blanguage\b/.test(label)) return null;

  const hits: Array<keyof typeof BANK_SYLLABI> = [];
  if (/\bbiology\b/.test(label)) hits.push("biology");
  if (/\bchemistry\b/.test(label)) hits.push("chemistry");
  if (/\bphysics\b/.test(label)) hits.push("physics");
  if (/\bmath(?:s|ematics)?\b/.test(label)) hits.push("maths");
  if (/\benglish literature\b/.test(label)) hits.push("literature");
  else if (/\benglish\b/.test(label) && (/\bfirst[ -]language\b/.test(label) || /\b0500\b/.test(label))) hits.push("english");
  if (/\becon(?:omic|omics)?\b/.test(label)) hits.push("economics");
  if (/\bbusiness(?: studies)?\b/.test(label)) hits.push("business");
  if (hits.length !== 1) return null;
  return [...BANK_SYLLABI[hits[0]]];
}

const SPECIFIC_SCIENCE_CODES: Array<[RegExp, string]> = [
  [/\bbiology\b/, "0610"],
  [/\bchemistry\b/, "0620"],
  [/\bphysics\b/, "0625"],
];

/** "Science", "Combined Science", "Co-ordinated Sci", ... but never Computer Science / Com-Sci. */
export function isGenericScienceLabel(value: string | null | undefined): boolean {
  const label = norm(value ?? "");
  if (!label || /\b(computer|comp|com)[\s-]*sci/.test(label)) return false;
  return /\b(combined\s+|co-?ordinated\s+)?sci(ence)?\b/.test(label);
}

/** Specific sciences named in a science label, e.g. "Science (Chemistry)" -> ["0620"]. Empty when none. */
export function namedScienceSyllabi(...labels: Array<string | null | undefined>): string[] {
  const text = norm(labels.map((l) => l ?? "").join(" "));
  return SPECIFIC_SCIENCE_CODES.filter(([pattern]) => pattern.test(text)).map(([, code]) => code);
}

/**
 * Syllabus codes from a tutor's Wise qualification tags for IGCSE-level science:
 * curriculum International, level Y9-11, subject Biology/Chemistry/Physics.
 * A generic "Science" tag does not count.
 */
export function scienceSyllabiFromTags(
  tags: Array<{ subject: string; curriculum: string; level: string }>,
): string[] {
  const codes = new Set<string>();
  for (const tag of tags) {
    if (norm(tag.curriculum) !== "international" || norm(tag.level) !== "y9-11") continue;
    const subject = norm(tag.subject);
    if (/^(biology|chemistry|physics)$/.test(subject)) namedScienceSyllabi(subject).forEach((c) => codes.add(c));
  }
  return [...codes].sort();
}

/**
 * Trial-class titles that no reviewed mapping covers, e.g. "Live Session - Chemistry Trial".
 * Returns bank codes when the title contains "trial" plus exactly one bank subject keyword.
 * Anything after the first Thai character is a booking note and is dropped first.
 * Statistics trials and other subjects outside the bank return null; a science
 * trial is handled by the generic-science rule before this runs.
 */
export function trialSyllabi(title: string | null | undefined): string[] | null {
  const text = (title ?? "").replace(/[\u0E00-\u0E7F][\s\S]*$/, "");
  if (!/trial/i.test(text) || /\bstat/i.test(text)) return null;
  return syllabiForAcademicSubject(text);
}
