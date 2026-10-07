import type { JudgeOutput } from "./judge";
import type { ModelOutput } from "./validate";

/**
 * Repair of a judged-unfaithful draft (owner decision, 7 Oct 2026: "drop the false claims"). Every problem the judges
 * quoted is cut from the draft — the sentence (or numbered line) that holds it, or the whole homework answer for
 * homework the tutor did not set — and the trimmed draft goes back to both judge levels like any new draft. Pure:
 * the caller re-validates and re-judges; nothing here decides that the result is true.
 *
 * Fails closed (null, the draft is not repaired) when a quote cannot be found in the draft, when a problem is a
 * source contradiction, or when the cuts would remove more than `MAX_REMOVED_SHARE` of the text: a draft that wrong
 * is rewritten or held, not patched.
 */

type DraftField = "topics" | "performance" | "improvement" | "homework";
const FIELDS: readonly DraftField[] = ["topics", "performance", "improvement", "homework"];

/** The labels the judge sees in front of each field (judge.ts `buildJudgeMessages`). */
const FIELD_LABELS: ReadonlyArray<[string, DraftField]> = [
  ["topics covered", "topics"],
  ["how the student did in class", "performance"],
  ["need more work on", "improvement"],
  ["homework and due date", "homework"],
];

/** More than this share of the draft's text cut: the draft is not repaired. */
export const MAX_REMOVED_SHARE = 0.35;

export interface DraftRepair {
  output: ModelOutput;
  /** Each cut: the field and the exact text removed. */
  removed: Array<{ field: DraftField; text: string }>;
}

function squash(value: string): string {
  return value.normalize("NFKC").replace(/[‘’]/gu, "'").replace(/[“”]/gu, "\"").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

/**
 * The quoted draft text and the field it names. Judges write `How the student did in class: "…" — the transcript
 * shows …`, `Feedback (Homework and due date): "…"`, or a bare quote: the field comes from a label before the first
 * quote, the text from inside the first quoted span (or, with no quotes, everything before " — ").
 */
export function parseProblemQuote(problem: string): { field: DraftField | null; text: string } {
  const value = problem.trim();
  const open = value.search(/["“]/u);
  const prefix = (open >= 0 ? value.slice(0, open) : value.split(/\s[—–-]\s/u)[0]).toLocaleLowerCase("en-US");
  const field = FIELD_LABELS.find(([label]) => prefix.includes(label))?.[1] ?? null;
  let text: string;
  if (open >= 0) {
    const closeChar = value[open] === "“" ? "”" : "\"";
    const close = value.indexOf(closeChar, open + 1);
    text = close > open ? value.slice(open + 1, close) : value.slice(open + 1);
  } else {
    text = value.split(/\s[—–-]\s/u)[0].replace(/^[^:]{0,60}:\s*/u, "");
  }
  // A quote the judge shortened: match on what it kept.
  text = text.replace(/(?:\.\.\.|…)+$/u, "").replace(/^(?:\.\.\.|…)+/u, "").trim();
  return { field, text };
}

/** Sentences, or numbered / bulleted lines, of one field, with their exact text. */
function units(value: string): string[] {
  const lines = value.split(/\n/u);
  const listLike = lines.filter((line) => /^\s*(?:\d+[.)]|[-•*])\s/u.test(line)).length >= 2;
  if (listLike) return lines.filter((line) => line.trim() !== "");
  return value.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/u).filter((part) => part.trim() !== "");
}

function locate(output: ModelOutput, quote: string, field: DraftField | null): { field: DraftField; unit: string } | null {
  const needle = squash(quote);
  if (needle.length < 8) return null;
  for (const name of field ? [field, ...FIELDS.filter((other) => other !== field)] : FIELDS) {
    const found = units(output[name]).find((unit) => squash(unit).includes(needle));
    if (found) return { field: name, unit: found };
  }
  return null;
}

function cut(value: string, unit: string): string {
  // A whole line goes with its line break.
  const target = [`${unit}\n`, `\n${unit}`, unit].find((candidate) => value.includes(candidate)) ?? unit;
  const index = value.indexOf(target);
  if (index < 0) return value;
  return (value.slice(0, index) + value.slice(index + target.length))
    .replace(/[ \t]{2,}/gu, " ").replace(/\n{3,}/gu, "\n\n").replace(/^\s+|\s+$/gu, "");
}

/** Renumber a numbered list after a line was cut ("1. a\n3. c" → "1. a\n2. c"). */
function renumber(value: string): string {
  let next = 0;
  return value.split("\n").map((line) => {
    const match = /^(\s*)\d+([.)])(\s)/u.exec(line);
    if (!match) return line;
    next += 1;
    return `${match[1]}${next}${match[2]}${match[3]}${line.slice(match[0].length)}`;
  }).join("\n");
}

export function repairRejectedDraft(output: ModelOutput, verdict: Pick<JudgeOutput, "unsupported" | "misattributed" | "homeworkNotSet">): DraftRepair | null {
  const problems: Array<{ kind: "homework" | "claim"; quote: string }> = [
    ...verdict.homeworkNotSet.map((quote) => ({ kind: "homework" as const, quote })),
    ...verdict.misattributed.map((quote) => ({ kind: "claim" as const, quote })),
    ...verdict.unsupported.map((quote) => ({ kind: "claim" as const, quote })),
  ];
  if (problems.length === 0) return null;
  if (problems.some((problem) => problem.quote.trim().startsWith("SOURCE_CONTRADICTION"))) return null;

  const next: ModelOutput = { ...output };
  const removed: DraftRepair["removed"] = [];
  for (const problem of problems) {
    const { field, text } = parseProblemQuote(problem.quote);
    // Homework the tutor did not set: the whole answer goes (the writer's own "none" is an empty string).
    if (problem.kind === "homework" && (field === "homework" || (field === null && squash(next.homework).includes(squash(text))))) {
      if (next.homework.trim() !== "") removed.push({ field: "homework", text: next.homework });
      next.homework = "";
      continue;
    }
    const found = locate(next, text, field);
    if (!found) {
      // Already cut with an earlier problem's sentence?
      if (removed.some((cutUnit) => squash(cutUnit.text).includes(squash(text)))) continue;
      return null;
    }
    if (found.field === "homework") {
      removed.push({ field: "homework", text: next.homework });
      next.homework = "";
      continue;
    }
    removed.push({ field: found.field, text: found.unit });
    next[found.field] = renumber(cut(next[found.field], found.unit));
  }
  const before = FIELDS.reduce((sum, name) => sum + output[name].length, 0) || 1;
  const cutChars = removed.reduce((sum, item) => sum + item.text.length, 0);
  if (cutChars / before > MAX_REMOVED_SHARE) return null;
  // Topics, performance and improvement must keep something to say.
  if (["topics", "performance", "improvement"].some((name) => next[name as DraftField].trim() === "")) return null;
  return { output: next, removed };
}
