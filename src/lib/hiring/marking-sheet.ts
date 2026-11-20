import { PAPER_LEVELS, type HiringConfig, type PaperLevel, type Subject } from "./model";

/** One answer as marked. `marks` is null only when the answer could not be read. */
export type PaperQuestion = {
  id: string;
  level: PaperLevel;
  marks: number | null;
  max: number;
  reason: string;
  attempted: boolean;
  readable: boolean;
  /** The scan page where the answer starts, from 1. Results marked before 13 November 2026 do not have it. */
  page?: number | null;
  /** What the marks were given for, one entry per mark scheme point or level. Older results do not have it. */
  points?: { point: string; awarded: number }[];
};
export type PaperMarks = { questions: PaperQuestion[]; comment: string; missingPages: string | null };
/** What the tracker holds for a past paper: an outcome and levels, with no question detail. */
export type PaperHistory = { outcome: string; passedSubjects: string; levels: string; date: string | null };
export type MockHistory = { score: number | null; outcome: string; comment: string; date: string | null; head: string };

export type LevelResult = "passed" | "not_passed" | "not_done" | "pass_mark_missing";
export type PaperSheet = {
  levels: { level: PaperLevel; scored: number; max: number; percent: number; passPercent: number | null; result: LevelResult }[];
  total: number;
  max: number;
  result: "passed" | "not_passed" | "pass_mark_missing";
  canTeachUpTo: string;
};

// A-Level, IB and AP are peers, so a pass in more than one shows them all.
const TOP = ["AS / A-Level", "IB SL / HL", "AP"] as const;

function highestPassed(passed: PaperLevel[]) {
  const top = TOP.filter((level) => passed.includes(level));
  if (top.length) return top.join(", ");
  for (const level of ["IGCSE / GCSE", "Key Stage 3", "Other"] as const) if (passed.includes(level)) return level;
  return null;
}
/**
 * The highest level passed. A failed lower level does not change it, and the sheet still shows the failure. A level
 * tried with no pass mark has no known result, so the words say that and do not guess.
 */
export function canTeachUpTo(passed: PaperLevel[], missing: PaperLevel[] = []) {
  const highest = highestPassed(passed);
  if (!missing.length) return highest ?? "None";
  const note = `pass mark missing for ${missing.join(", ")}`;
  return highest ? `${highest}; ${note}` : note[0].toUpperCase() + note.slice(1);
}

export const passRulesFor = (config: Pick<HiringConfig, "paperPassRules">, subject: Subject) =>
  new Map(config.paperPassRules.filter((rule) => rule.subject === subject).map((rule) => [rule.level, rule.percent]));

/**
 * The server and the screen both calculate the sheet from the marks and the current pass rules, so a rule saved later
 * applies at once. The AI never decides a total, a percentage or a result.
 */
export function computeSheet(marks: Pick<PaperMarks, "questions">, rules: Map<PaperLevel, number>): PaperSheet {
  const levels = PAPER_LEVELS.map((level) => {
    const questions = marks.questions.filter((q) => q.level === level);
    const scored = questions.reduce((sum, q) => sum + (q.marks ?? 0), 0);
    const max = questions.reduce((sum, q) => sum + q.max, 0);
    const exact = max ? (scored / max) * 100 : 0;
    const passPercent = rules.get(level) ?? null;
    const done = questions.some((q) => q.attempted);
    // The rounded figure is for the screen. A rounded 66.7 must not pass a score of 66.67.
    const result: LevelResult = !done ? "not_done" : passPercent === null ? "pass_mark_missing" : exact >= passPercent ? "passed" : "not_passed";
    return { level, scored, max, percent: Math.round(exact * 10) / 10, passPercent, result };
  });
  const passed = levels.filter((l) => l.result === "passed").map((l) => l.level);
  return {
    levels,
    total: levels.reduce((sum, l) => sum + l.scored, 0),
    max: levels.reduce((sum, l) => sum + l.max, 0),
    result: passed.length ? "passed" : levels.some((l) => l.result === "pass_mark_missing") ? "pass_mark_missing" : "not_passed",
    canTeachUpTo: canTeachUpTo(passed, levels.filter((l) => l.result === "pass_mark_missing").map((l) => l.level)),
  };
}

/** Marks that do not fit the marking sheet are refused, so a bad AI answer never reaches a result. */
export function checkPaperMarks(marks: PaperMarks) {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const q of marks.questions) {
    if (ids.has(q.id)) problems.push(`Question ${q.id} appears twice.`);
    ids.add(q.id);
    if (!(q.max > 0)) problems.push(`Question ${q.id} has no maximum.`);
    if (q.marks !== null && (q.marks < 0 || q.marks > q.max)) problems.push(`Question ${q.id} has ${q.marks} marks of ${q.max}.`);
    if (q.marks === null && q.readable) problems.push(`Question ${q.id} has no mark, but it could be read.`);
    if (!q.attempted && q.marks) problems.push(`Question ${q.id} was not tried, but it has ${q.marks} marks.`);
  }
  if (!marks.questions.length) problems.push("No questions were marked.");
  return problems;
}
export const paperNeedsCheck = (marks: PaperMarks) => !!marks.missingPages || marks.questions.some((q) => !q.readable);

export const RUBRIC = [
  {
    part: "Content Knowledge",
    items: [
      ["accuracy", "Accuracy of Information"],
      ["concepts", "Conceptual Understanding"],
      ["clarity", "Clarity of Explanation"],
    ],
  },
  {
    part: "Teaching Delivery",
    items: [
      ["presentation", "Engaging Presentation"],
      ["interaction", "Interaction with Students"],
      ["pace", "Pace and Timing"],
    ],
  },
  {
    part: "Classroom Management",
    items: [
      ["organization", "Organization and Structure"],
      ["materials", "Use of Teaching Materials"],
    ],
  },
  {
    part: "Assessment and Feedback",
    items: [
      ["formative", "Formative Assessment"],
      ["feedback", "Feedback Quality"],
    ],
  },
  {
    part: "Professional Conduct",
    items: [
      ["hygiene", "Personal Hygiene"],
      ["stress", "Stress Test"],
      ["safeguarding", "Safeguarding and Student Security"],
      ["curiosity", "Nurture Curiosity"],
    ],
  },
] as const;
export const RUBRIC_ITEMS = RUBRIC.flatMap((part) => part.items.map(([id]) => id));
export type RubricItem = (typeof RUBRIC_ITEMS)[number];
export const ITEM_MAX = 10;
/** The 10 items of the form used before 20 November 2026 (out of 100). A stored result with only these stays valid. */
export const LEGACY_RUBRIC_ITEMS = RUBRIC_ITEMS.slice(0, 10);
/** The Stress Test sub-rubric: (A) listens and acknowledges, (B) explains without blaming, (C) gives a concrete plan. */
export type StressTicks = { listens: boolean; explains: boolean; plan: boolean };
/**
 * A blank item could not be read. A legacy result has no Professional Conduct items, no ticks and no checks answer.
 * `checksDone` is the school's required checks (not scored); null means the AI could not read it.
 */
type LegacyItem = Exclude<RubricItem, "hygiene" | "stress" | "safeguarding" | "curiosity">;
export type MockRubric = {
  items: Record<LegacyItem, number | null> & Partial<Record<RubricItem, number | null>>;
  comments: string;
  stressTest?: StressTicks;
  checksDone?: boolean | null;
};

const isLegacy = (rubric: MockRubric) => !("hygiene" in rubric.items);
/** The items this result was scored on. */
export const rubricItems = (rubric: MockRubric): readonly RubricItem[] => (isLegacy(rubric) ? LEGACY_RUBRIC_ITEMS : RUBRIC_ITEMS);

export function checkRubric(rubric: MockRubric) {
  const problems: string[] = [];
  for (const id of rubricItems(rubric)) {
    const score = rubric.items[id];
    if (score === undefined) problems.push(`${id} is missing.`);
    // Heads can write a score between the printed bands, so any whole number on the scale is kept.
    else if (score !== null && (!Number.isInteger(score) || score < 1 || score > ITEM_MAX)) problems.push(`${id} has the score ${score}.`);
  }
  if (!isLegacy(rubric) && rubric.checksDone === undefined) problems.push("checksDone is missing.");
  return problems;
}
export const rubricNeedsCheck = (rubric: MockRubric) =>
  rubricItems(rubric).some((id) => rubric.items[id] === null) || (!isLegacy(rubric) && rubric.checksDone === null);
export function rubricTotals(rubric: MockRubric) {
  const used = new Set<string>(rubricItems(rubric));
  const parts = RUBRIC.filter(({ items }) => items.some(([id]) => used.has(id))).map(({ part, items }) => ({
    part,
    scored: items.reduce((sum, [id]) => sum + (rubric.items[id] ?? 0), 0),
    max: items.length * ITEM_MAX,
  }));
  const total = parts.reduce((sum, part) => sum + part.scored, 0);
  const max = parts.reduce((sum, part) => sum + part.max, 0);
  return { parts, total, max, percent: Math.round((total / max) * 100), complete: !rubricNeedsCheck(rubric) };
}
/** The score the tick count suggests (interviewer guide). The head still chooses the score. */
export const stressSuggestion = (ticks?: StressTicks) => [1, 4, 7, 10][ticks ? [ticks.listens, ticks.explains, ticks.plan].filter(Boolean).length : 0];
/** Hire needs the school's required checks done (Kevin, 20 Nov 2026). Legacy results predate the rule, so they pass. */
export const hireChecksMissing = (rubric: MockRubric) => !isLegacy(rubric) && rubric.checksDone !== true;
