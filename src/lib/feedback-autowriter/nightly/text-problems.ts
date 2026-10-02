import type { PriorFeedbackComparison } from "@/lib/post-class-feedback/similarity";
import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { ISEB_FORMAT_GUIDE, type FeedbackFormatGuide } from "../format";
import { otherPeopleNamed, parseStudentName, redactForModel } from "../prompt";
import { MIMI_STYLE_GUIDE, MIMI_STYLE_GUIDE_V2, type FeedbackStyleGuide } from "../style";
import { validateFeedbackDraft, type ModelOutput } from "../validate";

/**
 * Deterministic problems with a feedback text, as the production pipeline would see them plus the nightly's own
 * meta-word and identity checks. Used by the nightly prechecks on the posted text and by the guarded correction on
 * any replacement text. Codes never contain a name or lesson text; the matching words go in `detail` (local only).
 */

export interface TextProblem {
  code: string;
  field: string | null;
  /** The matched word or name (local report only, never a commit, the ledger or a PR). */
  detail: string | null;
}

export interface TextProblemInput {
  wiseSessionId: string;
  fields: Record<string, string>;
  studentFullName: string;
  studentDisplayName: string;
  studentAliases?: readonly string[];
  tutorNames: readonly string[];
  classDetails?: readonly string[];
  /** The tutor's prior feedback (production: `loadTutorPriorFeedback`); this class's own post is left out. */
  priorFeedback: readonly PriorFeedbackComparison[];
  /** Display names of the tutor's other students. */
  otherStudentNames?: readonly string[];
  styleGuide?: FeedbackStyleGuide | null;
  formatGuide?: FeedbackFormatGuide | null;
  /** The lesson record the style check reads material labels from. */
  lessonRecord?: string;
}

/** Words that never belong in parent feedback (owner rules, writer rule 2) — or are lesson content a person must tell apart. */
export const META_WORDS: ReadonlyArray<{ word: string; pattern: RegExp }> = [
  { word: "zoom", pattern: /(?<!\p{L})zoom(?!\p{L})/iu },
  { word: "recording", pattern: /(?<!\p{L})recordings?(?!\p{L})/iu },
  { word: "transcript", pattern: /(?<!\p{L})transcri(?:pt|pts|bed|ption)(?!\p{L})/iu },
  { word: "ai", pattern: /(?<!\p{L})A\.?I\.?(?!\p{L})/u },
  { word: "summary", pattern: /(?<!\p{L})summar(?:y|ies)(?!\p{L})/iu },
  { word: "late", pattern: /(?<!\p{L})late(?:ness)?(?!\p{L})/iu },
  { word: "absent", pattern: /(?<!\p{L})absen(?:t|ce)(?!\p{L})/iu },
  { word: "technical", pattern: /(?<!\p{L})technical(?!\p{L})/iu },
  { word: "reschedul", pattern: /(?<!\p{L})reschedul/iu },
  { word: "cancel", pattern: /(?<!\p{L})cancel(?:s|led|ed|ling|ing|lation|ation)?(?!\p{L})/iu },
];

/** Name parts that are not a person's own name (roster and Wise names carry them). */
const NOT_NAME_WORDS = new Set([
  "online", "onsite", "offline", "teacher", "tutor", "kru", "khru", "khun", "mr", "mrs", "ms", "miss", "dr", "sir", "the",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Case-sensitive whole word or phrase ("May" the name, never "may" the verb), every occurrence. */
function wordPattern(value: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * Nouns that make a name before them part of a named term, not a person: "Ohm's law", "Calvin cycle", "Newton's second
 * law". Kept to unmistakable ones, with at most an ordinal in between, so "Nok's maths test" is still a name.
 */
const TERM_NOUNS = [
  "law", "laws", "theorem", "theorems", "cycle", "principle", "constant", "equation", "equations", "effect", "paradox",
  "conjecture", "lemma", "formula", "triangle", "diagram", "sequence", "series", "rule", "process", "square",
];
const TERM_AFTER_NAME = new RegExp(
  `^(?:['’]s)?\\s+(?:(?:first|second|third|zeroth)\\s+)?(?:${TERM_NOUNS.join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

/** Whether the text uses the name for a person: any whole-word occurrence that is not part of a named term. */
function namedOutsideTerms(text: string, name: string): boolean {
  for (const match of text.matchAll(wordPattern(name))) {
    const end = (match.index ?? 0) + match[0].length;
    if (!TERM_AFTER_NAME.test(text.slice(end, end + 40))) return true;
  }
  return false;
}

function nameParts(name: string): string[] {
  return name.replace(/\([^)]*\)/gu, " ").split(/[\s,;/|_.–—-]+/u)
    .map((part) => part.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""))
    .filter((part) => [...part].length >= 2 && /^\p{L}/u.test(part) && !NOT_NAME_WORDS.has(part.toLocaleLowerCase("en-US")));
}

/** The style and format guides a post was written with, from its pipeline stamp (null when none or unknown). */
export function guidesFromStamp(pipeline: Record<string, unknown> | null): { styleGuide: FeedbackStyleGuide | null; formatGuide: FeedbackFormatGuide | null } {
  const style = pipeline?.styleGuide as { id?: unknown; version?: unknown } | null | undefined;
  const format = pipeline?.formatGuide as { id?: unknown; version?: unknown } | null | undefined;
  const styleGuide = style?.id === "mimi" && style.version === 1 ? MIMI_STYLE_GUIDE
    : style?.id === "mimi" && style.version === 2 ? MIMI_STYLE_GUIDE_V2 : null;
  const formatGuide = format?.id === ISEB_FORMAT_GUIDE.id && format.version === ISEB_FORMAT_GUIDE.version ? ISEB_FORMAT_GUIDE : null;
  return { styleGuide, formatGuide };
}

/** The student's other name forms the feedback must not use: full name, first name, nickname code, surname, guest names. */
function otherStudentForms(input: TextProblemInput): string[] {
  const display = input.studentDisplayName.trim();
  const { firstName, nicknameCode } = parseStudentName(input.studentFullName);
  const parts = nameParts(input.studentFullName);
  const surname = parts.length > 1 ? parts.at(-1) ?? null : null;
  const forms = [
    input.studentFullName.trim(),
    firstName,
    nicknameCode && nicknameCode !== display ? nicknameCode : null,
    surname,
    ...(input.studentAliases ?? []).map((alias) => alias.trim()),
  ];
  return [...new Set(forms.filter((form): form is string => Boolean(form && [...form].length >= 2 && form !== display)))];
}

/**
 * Every problem with a feedback text: production's own validator on a pseudo model output (each field redacted as
 * the writer's output would have been; the class's own prior post left out of the copy check), meta words, the
 * student called by anything but their display name, the tutor named, another person named, another student's name.
 * A name used as part of a named term ("Ohm's law", "Calvin cycle") is not a person and is not reported.
 */
export function correctionTextProblems(input: TextProblemInput): TextProblem[] {
  const problems: TextProblem[] = [];
  const names = { studentFullName: input.studentFullName, tutorNames: input.tutorNames, studentAliases: input.studentAliases ?? [] };
  const fields = Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) => [field, input.fields[field] ?? ""])) as unknown as FeedbackFieldAnswers;
  const redacted = Object.fromEntries(POST_CLASS_FEEDBACK_FIELDS.map((field) => [field, redactForModel(fields[field], names)])) as Record<string, string>;
  const output: ModelOutput = {
    topics: redacted.topics,
    performance: redacted.performance,
    improvement: redacted.improvement,
    homework: redacted.homework,
    studentAttended: true,
    lessonHappened: true,
  };
  const validation = validateFeedbackDraft({
    output,
    fields,
    studentFullName: input.studentFullName,
    tutorNames: input.tutorNames,
    priorFeedback: input.priorFeedback.filter((prior) => prior.key !== input.wiseSessionId),
    styleGuide: input.styleGuide ?? null,
    formatGuide: input.formatGuide ?? null,
    lessonRecord: input.lessonRecord ?? "",
  });
  if (!validation.ok) {
    for (const reason of validation.reasons) {
      const field = POST_CLASS_FEEDBACK_FIELDS.find((name) => reason.endsWith(`:${name}`)) ?? null;
      problems.push({ code: `validator:${reason}`, field, detail: null });
    }
  }

  const studentForms = otherStudentForms(input);
  const tutorWords = [...new Set(input.tutorNames.flatMap((name) => [name.trim(), ...nameParts(name)]))]
    .filter((word) => [...word].length >= 2 && !NOT_NAME_WORDS.has(word.toLocaleLowerCase("en-US")));
  const studentWords = new Set([input.studentDisplayName, ...studentForms, ...nameParts(input.studentFullName)].map((word) => word.toLocaleLowerCase("en-US")));
  const others = [...new Set((input.otherStudentNames ?? []).map((name) => name.trim()))]
    .filter((name) => [...name].length >= 2 && !studentWords.has(name.toLocaleLowerCase("en-US")));

  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const text = fields[field];
    if (!text) continue;
    for (const meta of META_WORDS) {
      const match = meta.pattern.exec(text);
      if (match) problems.push({ code: `meta_word:${meta.word}`, field, detail: match[0] });
    }
    for (const form of studentForms) {
      if (namedOutsideTerms(text, form)) problems.push({ code: "student_name_form", field, detail: form });
    }
    for (const word of tutorWords) {
      if (namedOutsideTerms(text, word)) problems.push({ code: "tutor_named", field, detail: word });
    }
    for (const name of others) {
      if (namedOutsideTerms(text, name)) problems.push({ code: "other_student_named", field, detail: name });
    }
    for (const person of otherPeopleNamed(redacted[field], input.studentFullName, input.classDetails ?? [], input.studentAliases ?? [])) {
      problems.push({ code: "other_person_named", field, detail: person });
    }
  }
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.code}|${problem.field}|${problem.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
