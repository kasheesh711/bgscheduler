import { redactKnownNames } from "@/lib/post-class-feedback/similarity";
import type { AiSummary } from "./types";

export const PROMPT_VERSION = 2;
export const STUDENT_TOKEN = "[STUDENT_1]";
export const TUTOR_TOKEN = "[TUTOR]";

/**
 * Wise student names look like "Kittipat (Sean.As) Assaratnanon". Copied from
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

function countMatches(text: string, value: string): number {
  return value ? (text.match(latinWord(value)) ?? []).length : 0;
}

/**
 * The summary names the student the way the lesson did. Use whichever of the
 * first name or nickname it uses more (the tutor's own feedback mixes both).
 */
export function chooseStudentDisplayName(summaryText: string, fullName: string): string {
  const { firstName, nickname } = parseStudentName(fullName);
  if (nickname && countMatches(summaryText, nickname) > countMatches(summaryText, firstName)) return nickname;
  return firstName;
}

/**
 * Replace every student/tutor name variant with a placeholder before the text
 * leaves BGScheduler. `redactKnownNames` drops the bracketed nickname, so the
 * nickname code and its short form are replaced here as well.
 */
export function redactForModel(
  text: string,
  input: { studentFullName: string; tutorNames: readonly string[] },
): string {
  let result = redactKnownNames(text, {
    studentNames: [input.studentFullName],
    tutorNames: [...input.tutorNames],
  });
  const { nicknameCode, nickname } = parseStudentName(input.studentFullName);
  for (const token of [nicknameCode, nickname].filter((value): value is string => Boolean(value && [...value].length >= 2))) {
    result = result.replace(latinWord(token), STUDENT_TOKEN);
  }
  return result;
}

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

export const FEEDBACK_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topics", "performance", "improvement", "homework", "studentAttended", "lessonHappened"],
  properties: {
    topics: { type: "string", description: "Specific skills, question types, texts or papers covered." },
    performance: { type: "string", description: "Concrete observations of how the student did, with lesson examples." },
    improvement: { type: "string", description: "Weak areas plus 2-3 concrete next steps or strategies." },
    homework: { type: "string", description: "Homework the summary says was set, with timing; empty string if none." },
    studentAttended: { type: "boolean", description: "True only if the summary shows the student actively took part." },
    lessonHappened: { type: "boolean", description: "True only if a real lesson took place." },
  },
} as const;

const SYSTEM_PROMPT = [
  "You write the post-class feedback a tutor sends to a student's parents after a one-to-one online lesson.",
  "You are given an automatically generated summary of the lesson. Write as the tutor, in the first person",
  `("we" for work done together). Refer to the student only as ${STUDENT_TOKEN}. Never name the tutor or write ${TUTOR_TOKEN}.`,
  "",
  "Rules:",
  "1. Use only facts stated or clearly implied by the summary. Never invent scores, topics, materials, homework, dates or events.",
  "2. Never mention attendance, absence, lateness, cancellation, rescheduling, technical problems, recordings, transcripts, Zoom, AI or the summary itself.",
  "3. Warm, clear, professional English that a parent can read. Plain sentences in short paragraphs; no headings, no markdown, no bullet symbols.",
  "4. topics: the specific skills, sub-topics, question types, texts or papers covered.",
  `5. performance: concrete observations of what ${STUDENT_TOKEN} did well and found difficult, with examples from this lesson.`,
  "6. improvement: the specific weak areas and two or three concrete next steps or strategies to practise before the next lesson.",
  "7. homework: only homework or tasks the summary says were set, with timing if stated. If the summary mentions none, return an empty string.",
  "8. Length: topics, performance and improvement are each between 120 and 600 characters, and together at least 450 characters.",
  "9. studentAttended is true only if the summary shows the student actively took part; lessonHappened is true only if a real lesson took place.",
  "10. The class details come from the school's system and are accurate. Use them only to name the programme and subject correctly; everything about the lesson itself comes only from the summary.",
].join("\n");

export interface PromptContext {
  studentFullName: string;
  tutorNames: readonly string[];
  /** `describeClass` lines (programme, class subject, confirmed terms). */
  classDetails: readonly string[];
  scheduledMinutes: number;
  summary: AiSummary;
}

/** Class-detail lines with names redacted, as a bullet block. */
export function classDetailsBlock(
  classDetails: readonly string[],
  names: { studentFullName: string; tutorNames: readonly string[] },
  extra: readonly string[] = [],
): string {
  return [...classDetails.map((line) => redactForModel(line, names)), ...extra].map((line) => `- ${line}`).join("\n");
}

export function buildFeedbackMessages(context: PromptContext): Array<{ role: "system" | "user"; content: string }> {
  const summary = redactForModel(context.summary.text, context);
  const details = classDetailsBlock(context.classDetails, context, [`Scheduled length: ${context.scheduledMinutes} minutes`]);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Class details (from the school's system):\n${details}\n\nLesson summary:\n${summary}` },
  ];
}
