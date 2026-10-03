import { ATOM_MODEL_RULES } from "./atom/evidence";
import type { FeedbackFormatGuide } from "./format";
import { redactKnownNames } from "@/lib/post-class-feedback/similarity";
import { styleInstructions, type FeedbackStyleGuide } from "./style";
import type { AiSummary } from "./types";

/** v5 (owner decision, 30 Sep): the feedback names no one but the student (summary rule 12, transcript rule 13).
 * v6 (nightly audit 3 Oct): a STUDENT line that only echoes the tutor is not the student's own answer (transcript rule
 * 12, failure mode M07); careful summary mode (summary rule 13, owner decision 3 Oct; modes M05/M06/M08). */
export const PROMPT_VERSION = 6;
export const STUDENT_TOKEN = "[STUDENT_1]";
export const TUTOR_TOKEN = "[TUTOR]";

/**
 * Wise student names look like "Somchai (Tom.Ja) Jaidee". Copied from
 * student-schedule/data.ts `parseStudentDisplay` (importing it would pull the
 * DB and live fetchers into this module).
 */
export function parseStudentName(fullName: string): {
  firstName: string;
  nicknameCode: string | null;
  nickname: string | null;
} {
  const trimmed = fullName.trim();
  const code = /\(([^)]+)\)/u.exec(trimmed)?.[1]?.trim() || null;
  const firstName = trimmed.split(/\s+/u)[0] ?? trimmed;
  return {
    firstName,
    nicknameCode: code,
    nickname: code ? (code.split(".")[0]?.trim() || code) : null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function latinWord(value: string): RegExp {
  return new RegExp(`(?<!\\p{L})${escapeRegExp(value)}(?!\\p{L})`, "giu");
}

/** A word only where it is written exactly so (case-sensitive): "May" the name, not "may" the verb. */
function exactWord(value: string): RegExp {
  return new RegExp(`(?<!\\p{L})${escapeRegExp(value)}(?!\\p{L})`, "gu");
}

/**
 * The name the feedback calls the student by: always their nickname — the
 * part before the dot in the Wise name's brackets, "Somchai (Tom.Ja)
 * Jaidee" → "Tom" (owner decision, 29 Sep) — or the first name when the
 * Wise name has none.
 */
export function chooseStudentDisplayName(fullName: string): string {
  const { firstName, nickname } = parseStudentName(fullName);
  // Only a real one-word nickname ("Tom"); odd bracket contents ("(.Ja)", "(Tom Ja)", "(K.Ja)") use the first name.
  const usable = nickname !== null && [...nickname].length >= 2 && /^\p{L}[\p{L}\p{M}'-]*$/u.test(nickname);
  return usable ? nickname : firstName;
}

/**
 * Replace every student/tutor name variant with a placeholder before the text
 * leaves BGScheduler. `redactKnownNames` drops the bracketed nickname, so the
 * nickname code and its short form are replaced here as well.
 */
export function redactForModel(
  text: string,
  input: { studentFullName: string; tutorNames: readonly string[]; studentAliases?: readonly string[] },
): string {
  // Aliases (the name the student joined under as a guest) are the same student: the same [STUDENT_1].
  // Whole names first, so "Krit Kaewmanee" is one mention; single words last.
  const aliases = (input.studentAliases ?? []).map((alias) => alias.trim()).filter((alias) => [...alias].length >= 2);
  let result = text;
  for (const alias of aliases) result = result.replace(latinWord(alias), STUDENT_TOKEN);
  result = redactKnownNames(result, {
    studentNames: [input.studentFullName],
    tutorNames: [...input.tutorNames],
  });
  const { nicknameCode, nickname } = parseStudentName(input.studentFullName);
  for (const token of [nicknameCode, nickname].filter((value): value is string => Boolean(value && [...value].length >= 2))) {
    result = result.replace(latinWord(token), STUDENT_TOKEN);
  }
  // An odd code "(Tom Ja)" is replaced whole above, but a summary also writes "Tom" alone: its first word as well,
  // letters only and only where written as a name (capitalised, case-sensitive, like the guest-name words below).
  const codeWords = nicknameCode?.split(/\s+/u) ?? [];
  const firstCodeWord = codeWords.length > 1 ? codeWords[0].charAt(0).toLocaleUpperCase("en-US") + codeWords[0].slice(1) : "";
  if (/^\p{Lu}\p{L}+$/u.test(firstCodeWord)) result = result.replace(exactWord(firstCodeWord), STUDENT_TOKEN);
  // Each name-like word of an alias, only where it is written as a name (capitalised, case-sensitive: a guest
  // "May Win" must not turn "may need … a win" into placeholders). A possessive word stands for the bare name
  // ("Nathan’s iPad" → "Nathan", so "Nathan’s notes" → "[STUDENT_1]’s notes").
  for (const word of aliases.flatMap(guestNameWords)) {
    if (/^\p{Lu}[\p{L}\p{M}'’-]*$/u.test(word)) result = result.replace(exactWord(word), STUDENT_TOKEN);
  }
  return result;
}

/**
 * The words of a guest name that may be the student's own name, a possessive as the bare name ("Nathan’s iPad" →
 * "Nathan"). Never a device word ("Zoom", "iPad"), nor a family or place word: "Mom's iPad" or "Mae iPad" (Thai for
 * mother) means the student joined on someone else's device, and that someone is not the student.
 */
function guestNameWords(alias: string): string[] {
  return alias.split(/\s+/u)
    .map((word) => word.replace(/['’]s?$/u, ""))
    .filter((word) => [...word].length >= 2 && !GENERIC_GUEST_WORDS.has(word.toLocaleLowerCase("en-US")));
}

/** Words Zoom guest names are often made of that are not the student's name. */
export const GENERIC_GUEST_WORDS = new Set([
  "zoom", "user", "guest", "iphone", "ipad", "android", "phone", "tablet", "laptop", "desktop", "pc", "mac",
  "macbook", "samsung", "galaxy", "huawei", "oppo", "vivo", "xiaomi", "redmi", "pixel", "windows", "my", "the", "of",
  // Whose device it is, or where it is.
  "mom", "mum", "mommy", "mummy", "mother", "mama", "mae", "dad", "daddy", "father", "papa", "pa", "ma", "family",
  "home", "house", "sister", "sis", "brother", "bro", "aunt", "auntie", "uncle", "grandma", "grandpa", "granny",
  "nanny", "son", "daughter", "kid", "kids", "child", "office", "school", "work", "room", "teacher",
]);

// Same prefix pattern as student-schedule `deriveDisplaySubject` (copied for the
// same reason as parseStudentName): "Live Session-Non VR" → "Non VR".
const SESSION_TITLE_PREFIX = /^\s*(?:in[- ]?person|on[- ]?site|online|live)\s+session\s*[-–—:]\s*/iu;
const BARE_SESSION_TITLE = /^\s*(?:in[- ]?person|on[- ]?site|online|live)\s+session\s*$/iu;
const CANCELLED_SUFFIX = /\s*\((?:cancelled|canceled)\)\s*$/iu;

/**
 * BeGifted's class terms, as confirmed by the owner (2026-09-29). Only these are
 * expanded; any other wording reaches the models verbatim and is never guessed.
 */
const CLASS_TERMS: ReadonlyArray<{ pattern: RegExp; meaning: string }> = [
  { pattern: /(?<![\p{L}\p{N}])11\+\s*\/\s*13\+/u, meaning: "11+/13+ = the ISEB 11+/13+ entrance tests" },
  { pattern: /(?<!\p{L})(?:NVR|Non[- ]?VR)(?!\p{L})/iu, meaning: "NVR (Non VR) = Non-Verbal Reasoning" },
  // "VR" on its own: not the tail of "NVR" and not "Non VR".
  { pattern: /(?<!\p{L})(?<!Non[- ]?)VR(?!\p{L})/u, meaning: "VR = Verbal Reasoning" },
  { pattern: /(?<!\p{L})Sci(?!\p{L})/u, meaning: "Sci = Science" },
];

/** Our terms, given to Soniox as context (job.ts) and never taken for a person's name (`otherPeopleNamed`). */
export const SONIOX_TERMS: readonly string[] = ["ISEB", "11+", "13+", "NVR", "Non-Verbal Reasoning", "Verbal Reasoning", "IGCSE", "IB", "SAT", "A-level"];

/**
 * Class details from Wise that both the writer and the judge may rely on.
 * At BeGifted, Wise's `classSubject` holds the programme or level band
 * ("Y9-11 / G8-10 (Int.)", "11+/13+"); the subject itself is only in the
 * session title ("Live Session - Chemistry", "Live Session-Non VR").
 */
export function describeClass(input: { programme: string | null | undefined; title: string | null | undefined }): string[] {
  const programme = input.programme?.trim() || null;
  const title = input.title?.trim() ?? "";
  const stripped = title.replace(SESSION_TITLE_PREFIX, "").replace(CANCELLED_SUFFIX, "").trim();
  const subject = stripped && !BARE_SESSION_TITLE.test(stripped) ? stripped : null;
  const lines = [
    ...(programme ? [`Programme: ${programme}`] : []),
    ...(subject ? [`Class subject: ${subject}`] : []),
  ];
  const text = [programme, subject].filter(Boolean).join(" ");
  const terms = CLASS_TERMS.filter((term) => term.pattern.test(text)).map((term) => term.meaning);
  if (terms.length > 0) lines.push(`Terms: ${terms.join("; ")}`);
  return lines;
}

export function restoreStudentName(text: string, displayName: string): string {
  return text.replaceAll(STUDENT_TOKEN, displayName);
}

/** What a person in a summary says: "Nathan mentioned …". A month or day before one is a nickname ("May said …"). */
const SPEECH_VERBS = [
  "said", "says", "mentioned", "asked", "answered", "told", "explained", "noted", "reported", "shared", "stated",
  "indicated", "confirmed",
];
/** What a person in a summary does: "Ploy also finished …". */
const ACTION_VERBS = ["completed", "finished", "did", "didn't", "worked", "struggled", "solved", "wrote", "got", "scored", "submitted"];
/**
 * What a person is or has — but a sentence-initial noun takes these too ("Progress was steady", "Accuracy has
 * improved"), so their matches rank after the speech and action ones.
 */
const STATE_VERBS = ["is", "was", "has", "had", "does", "hadn't", "hasn't", "wasn't"];

/**
 * A capitalised word ("Nathan", not "NVR" or "[STUDENT_1]": the second letter must be lower case) directly before a
 * person verb, optionally with also/only/just/then/still in between. A contraction takes either apostrophe.
 */
const NAME_BEFORE_PERSON_VERB = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_-])(\\p{Lu}[\\p{Ll}\\p{M}][\\p{L}\\p{M}'’-]*)\\s+(?:(?:also|only|just|then|still)\\s+)?` +
    `(${[...SPEECH_VERBS, ...ACTION_VERBS, ...STATE_VERBS].map((verb) => verb.replace("'", "['’]")).join("|")})(?![\\p{L}\\p{M}])`,
  "gu",
);

/** Capitalised words before a person verb that are not someone's name (lower case). */
const NOT_A_NAME = new Set([
  "the", "they", "he", "she", "it", "we", "i", "you", "this", "that", "these", "those", "there", "here",
  "his", "her", "their", "our", "your", "its", "my", "who", "what", "which", "where", "when", "why", "how",
  "everyone", "everybody", "someone", "somebody", "anyone", "anybody", "nobody", "nothing", "everything", "something",
  "anything", "each", "both", "all", "most", "some", "many", "few", "several", "neither", "either", "another", "other",
  "one", "none", "overall", "also", "then", "now", "today", "tomorrow", "yesterday", "later", "next", "finally",
  "first", "second", "lastly", "however", "although", "because", "since", "while", "after", "before", "during", "if",
  "but", "and", "so", "as", "once", "students", "student", "mr", "mrs", "ms", "miss", "sir", "teacher", "teachers",
  "tutor", "tutors", "parent", "parents", "mother", "father", "mum", "mom", "dad", "homework", "lesson", "session",
  "class", "meeting", "summary", "overview", "question", "questions", "answer", "exam", "test", "quiz", "paper",
  "section", "page", "chapter", "unit", "topic", "task", "zoom",
  // Thai forms of address ("Nong said …" is the student, not someone else).
  "nong", "khun", "kru", "khru", "phi", "pee", "ajarn",
]);

/** Days and months: not a name ("April is exam month"), except right before a speech verb — "May", "June" and "April" are nicknames too. */
const DAYS_AND_MONTHS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
]);

/** Lower-case words of some lines, whole and split at hyphens ("non-verbal", "non", "verbal"), to match candidate names against. */
function lowerWords(lines: readonly string[]): Set<string> {
  const words = lines.flatMap((line) => line.toLocaleLowerCase("en-US").split(/[^\p{L}\p{M}'’-]+/u));
  return new Set(words.flatMap((word) => [word, ...word.split("-")]).filter(Boolean));
}

/**
 * Summary mode: the other people a redacted summary names, so the writer and the judge are told they are never
 * [STUDENT_1] (29 Sep: a summary said another student "mentioned only 8 pages"; that name was the only real one
 * left after redaction, and the draft gave those words to our student). A hint, never a gate: a capitalised word
 * directly before a person verb, minus common words, days and months (unless one reports speech: "May said"), the
 * class details and our terms, the name words of the student's guest aliases, and the student's own names — any
 * name that starts with their first name or nickname (a summary may write "Tommy" for a student called Tom), or
 * only that name itself when it has two letters (a student "Ma" is not "Marco").
 * Deduplicated; names seen before a speech or action verb come first, then those only seen before a state verb
 * ("was", "has": sentence-initial nouns like "Progress was steady" take those too), each in first-seen order; at most 8.
 */
export function otherPeopleNamed(
  redactedSummary: string,
  studentFullName: string,
  classDetails: readonly string[] = [],
  studentAliases: readonly string[] = [],
): string[] {
  const known = lowerWords([...classDetails, ...SONIOX_TERMS]);
  const aliasWords = new Set(studentAliases.flatMap(guestNameWords).map((word) => word.normalize("NFC").toLocaleLowerCase("en-US")));
  const { firstName, nickname } = parseStudentName(studentFullName);
  // The first word only: an odd bracket code "(Tom Ja)" still means "Tom".
  const studentPrefixes = [firstName, nickname?.split(/\s+/u)[0]]
    .filter((value): value is string => Boolean(value && [...value].length >= 2))
    .map((value) => value.toLocaleLowerCase("en-US"));
  const isStudent = (lower: string) => studentPrefixes.some((prefix) => ([...prefix].length >= 3 ? lower.startsWith(prefix) : lower === prefix));
  const active: string[] = [];
  const stated: string[] = [];
  for (const match of redactedSummary.normalize("NFC").matchAll(NAME_BEFORE_PERSON_VERB)) {
    const name = match[1].replace(/['’]s$/u, "");
    const verb = match[2].replace("’", "'");
    const lower = name.toLocaleLowerCase("en-US");
    if (NOT_A_NAME.has(lower) || known.has(lower) || aliasWords.has(lower) || isStudent(lower)) continue;
    if (DAYS_AND_MONTHS.has(lower) && !SPEECH_VERBS.includes(verb)) continue;
    (STATE_VERBS.includes(verb) ? stated : active).push(name);
  }
  return [...new Set([...active, ...stated])].slice(0, 8);
}

/** The line both the writer and the judge get before the lesson summary when it names other people. */
export function otherPeopleLine(people: readonly string[]): string | null {
  return people.length > 0 ? `Other people named in the summary (never ${STUDENT_TOKEN}): ${people.join(", ")}` : null;
}

export const FEEDBACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics", "performance", "improvement", "homework", "studentAttended", "lessonHappened"],
  properties: {
    topics: { type: "string", description: "Specific skills, question types, texts or papers covered." },
    performance: { type: "string", description: "Concrete observations of how the student did, with lesson examples." },
    improvement: { type: "string", description: "Weak areas plus 2-3 concrete next steps or strategies." },
    homework: { type: "string", description: "Only homework the tutor clearly set for after this lesson, with timing; empty string if none or unclear." },
    studentAttended: { type: "boolean", description: "True only if the summary shows the student actively took part." },
    lessonHappened: { type: "boolean", description: "True only if a real lesson took place." },
  },
} as const;

/** What the draft is written from. */
export type EvidenceKind = "summary" | "transcript";

/** How trustworthy the TUTOR/STUDENT labels of a transcript are (see `assignSpeakerRoles`). */
export type SpeakerLabels = "verified" | "inferred";

export function speakerLabelNote(labels: SpeakerLabels): string {
  return labels === "verified"
    ? "The speaker labels TUTOR and STUDENT are reliable."
    : "The speaker labels TUTOR and STUDENT were inferred from who talked most and may occasionally be wrong: " +
      "only treat something as the student's own answer when it clearly is.";
}

function systemPrompt(evidence: EvidenceKind, labels: SpeakerLabels, styleGuide: FeedbackStyleGuide | null, formatGuide: FeedbackFormatGuide | null, atomEvidence: string): string {
  const guided = !!styleGuide || !!formatGuide;
  const record = evidence === "summary" ? "the summary" : "the transcript";
  return [
    "You write the post-class feedback a tutor sends to a student's parents after a one-to-one online lesson.",
    evidence === "summary"
      ? "You are given an automatically generated summary of the lesson. Write as the tutor, in the first person"
      : "You are given an automatic transcript of the lesson. It may mix Thai and English; always write in English. " +
        `${speakerLabelNote(labels)} Write as the tutor, in the first person`,
    `("we" for work done together). Refer to the student only as ${STUDENT_TOKEN}. Never name the tutor or write ${TUTOR_TOKEN}.`,
    "",
    "Rules:",
    `1. Use only facts stated or clearly implied by ${record}. Never invent scores, topics, materials, homework, dates or events.`,
    "2. Never mention attendance, absence, lateness, cancellation, rescheduling, technical problems, recordings, transcripts, Zoom, AI or the summary itself.",
    guided ? "3. Follow the presentation guide below, using warm, clear, professional English that a parent can read."
      : "3. Warm, clear, professional English that a parent can read. Plain sentences in short paragraphs; no headings, no markdown, no bullet symbols.",
    "4. topics: the specific skills, sub-topics, question types, texts or papers covered.",
    `5. performance: concrete observations of what ${STUDENT_TOKEN} did well and found difficult, with examples from this lesson. ` +
      `Every judgement of how well ${STUDENT_TOKEN} did (confidently, well, engaged, quickly, struggled) must be stated in ${record}; ` +
      `when ${record} does not say how it went, describe what ${STUDENT_TOKEN} worked on and practised instead of judging it.`,
    // v4 (30 Sep): a summary's "problems still to complete" was posted as homework, and repeated under improvement.
    (guided ? "6. improvement: a short numbered list of specific skills to practise before the next lesson, "
      : "6. improvement: the specific weak areas and two or three concrete next steps or strategies to practise before the next lesson, ") +
      "written as suggestions — never as homework the tutor set, and never repeating the homework.",
    `7. homework: only work ${record} shows the tutor clearly setting ${STUDENT_TOKEN} to do after this lesson, with its timing if stated. ` +
      "Work only described as remaining, unfinished, left over or still to complete is not homework unless the tutor set it. " +
      // Owner decision (30 Sep): Wise's "Next steps: …" line (`extractAiSummary`) is the summary's advice, not the tutor's.
      (evidence === "summary" ? "A \"Next steps\" line in the summary is the summary's own suggestion, not homework the tutor set. " : "") +
      `If ${record} does not clearly show the tutor setting homework, return an empty string. ` +
      "Never repeat or restate the homework in topics, performance or improvement.",
    guided ? "8. Length: topics, performance and improvement together need at least 300 characters, with no per-field minimum; never pad sparse evidence."
      : "8. Length: topics, performance and improvement are each between 120 and 600 characters, and together at least 450 characters.",
    `9. studentAttended is true only if ${record} shows the student actively took part; lessonHappened is true only if a real lesson took place.`,
    `10. The class details come from the school's system and are accurate. Use them only to name the programme and subject correctly; everything about the lesson itself comes only from ${record}.`,
    // v4 (30 Sep): redaction leaves every other name in place, and a draft gave another student's words to ours.
    ...(evidence === "summary"
      ? [
        `11. Who did what: in the summary the student is always ${STUDENT_TOKEN} and the tutor ${TUTOR_TOKEN}. ` +
          "Any other name belongs to someone else — another student, a family member, a friend, or a person or character in the lesson material — " +
          `never to ${STUDENT_TOKEN}, even when the summary seems to be about them. ` +
          `Never give ${STUDENT_TOKEN} anything the summary says ${TUTOR_TOKEN} or another named person did, said, finished or did not finish.`,
        // v5 (owner decision, 30 Sep): a prompt rule only, no gate. The tutor is never named either (above).
        `12. Never name anyone but ${STUDENT_TOKEN}: refer to any other person generically — ` +
          "\"another student\", \"a classmate\", \"a family member\" — never by name.",
        // v6 careful summary mode (owner decision, 3 Oct): the first nightly audit found a major error in every one of the
        // five summary-only posts of 2 Oct — recap ranges and mis-heard terms copied, stock praise repeated.
        "13. The summary is a machine recap that can mishear and generalise. Prefer its detailed sections to its opening overview: " +
          "take ranges, levels, counts, question numbers and named question types only as the detailed sections state them, and leave a " +
          "detail out when the overview and the details disagree. List as a topic only what the summary describes being worked on, never a " +
          `term from one passing mention. Never repeat a generic line about ${STUDENT_TOKEN} (asked questions throughout, actively engaged, ` +
          "worked confidently) unless the summary reports a concrete exchange behind it. Never be more specific or more positive than the summary.",
      ]
      : [
        // Hedged ("clearly not the student"): Thai-script or mis-heard names of the student are not redacted in a transcript.
        `11. Who did what: only the lines labelled STUDENT are ${STUDENT_TOKEN}'s own words and work; the lines labelled TUTOR are the tutor's. ` +
          "Anyone named in the lesson who is clearly not the student — another student, a family member, a friend, or a person or character in the lesson material — " +
          `is never ${STUDENT_TOKEN}: never give ${STUDENT_TOKEN} what is said about them.`,
        `12. Something the tutor explained was covered, not mastered: only say ${STUDENT_TOKEN} understood, solved or explained something when the transcript shows ${STUDENT_TOKEN} doing it. ` +
          `A STUDENT line that only repeats, confirms or reads out what the tutor has just said (a number, an answer, a word), or a value the question gives, ` +
          `is not ${STUDENT_TOKEN}'s own answer: never write that ${STUDENT_TOKEN} found, gave or knew it.`,
        // v5 (owner decision, 30 Sep): other people too, referred to generically.
        `13. Names in the transcript may be written in Thai script; never repeat any name — write ${STUDENT_TOKEN} for the student ` +
          "and refer to anyone else generically (\"another student\", \"a classmate\", \"a family member\").",
      ]),
    ...(styleGuide ? ["", styleInstructions(styleGuide)] : []),
    ...(formatGuide ? ["", formatGuide.instructions] : []),
    ...(atomEvidence ? ["", ATOM_MODEL_RULES] : []),
  ].join("\n");
}

export interface PromptContext {
  formatGuide?: FeedbackFormatGuide | null;
  atomEvidence?: string;
  styleGuide?: FeedbackStyleGuide | null;
  studentFullName: string;
  /** Other names the student appeared under (a guest join); redacted like the full name. */
  studentAliases?: readonly string[];
  tutorNames: readonly string[];
  /** `describeClass` lines (programme, class subject, confirmed terms). */
  classDetails: readonly string[];
  scheduledMinutes: number;
  /** The lesson record: Wise's AI summary, or a rendered transcript (`evidence: "transcript"`). */
  summary: AiSummary;
  evidence?: EvidenceKind;
  /** Transcript mode only; default "inferred". */
  speakerLabels?: SpeakerLabels;
  /** Summary mode: `otherPeopleNamed` of the redacted summary (the pipeline passes the judge the same list); worked out here when absent. */
  otherPeople?: readonly string[];
}

/** Class-detail lines with names redacted, as a bullet block. */
export function classDetailsBlock(
  classDetails: readonly string[],
  names: { studentFullName: string; tutorNames: readonly string[]; studentAliases?: readonly string[] },
  extra: readonly string[] = [],
): string {
  return [...classDetails.map((line) => redactForModel(line, names)), ...extra].map((line) => `- ${line}`).join("\n");
}

/**
 * The writer's messages: the rules, then the class details, the other people the summary names (summary mode,
 * when there are any) and the redacted lesson record.
 */
export function buildFeedbackMessages(context: PromptContext): Array<{ role: "system" | "user"; content: string }> {
  const evidence = context.evidence ?? "summary";
  const record = redactForModel(context.summary.text, context);
  const details = classDetailsBlock(context.classDetails, context, [`Scheduled length: ${context.scheduledMinutes} minutes`]);
  const people = evidence === "summary"
    ? otherPeopleLine(context.otherPeople ?? otherPeopleNamed(record, context.studentFullName, context.classDetails, context.studentAliases))
    : null;
  return [
    // Fails closed: a transcript is only called reliable when Zoom confirmed the labels.
    { role: "system", content: systemPrompt(evidence, context.speakerLabels ?? "inferred", context.styleGuide ?? null, context.formatGuide ?? null, context.atomEvidence ?? "") },
    {
      role: "user",
      content: `Class details (from the school's system):\n${details}\n\n${people ? `${people}\n\n` : ""}` +
        `${evidence === "summary" ? "Lesson summary" : "Lesson transcript"}:\n${record}` +
        (context.atomEvidence ? `\n\nFrozen Atom lesson evidence:\n${context.atomEvidence}` : ""),
    },
  ];
}
