import { POST_CLASS_FEEDBACK_FIELDS, type FeedbackFieldAnswers } from "@/lib/post-class-feedback/types";
import { tidyFeedbackText } from "../validate";
import type { AuditIssue } from "./audit-schema";

/**
 * Candidate B of a correction (quick 261003-12b): the posted text with the audit's minimal fixes applied, in the
 * audit's order, exactly — a fix whose `from` is not in its field exactly once (gone, or ambiguous) refuses the whole
 * candidate, and so does a result that changes more than a quarter of the post's words. A deletion leaves no doubled
 * space, no space before punctuation and no empty list line behind; whitespace is then tidied as every draft is.
 */

/** Most words a minimal fix may change, as a share of the posted words. */
export const MAX_MINIMAL_FIX_WORD_SHARE = 0.25;
/** A candidate's combined length must stay within these multiples of the post's. */
export const MIN_LENGTH_RATIO = 0.6;
export const MAX_LENGTH_RATIO = 1.6;

type Field = (typeof POST_CLASS_FEEDBACK_FIELDS)[number];

export type MinimalFixResult =
  | { ok: true; fields: FeedbackFieldAnswers; applied: number; wordShare: number }
  | { ok: false; reason: string };

/** Start offsets of every occurrence of `needle` in `haystack`, overlapping ones included. */
export function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) found.push(index);
  return found;
}

const BULLET_ONLY = /^[ \t]*(?:[-*•]|\d{1,2}[.)])?[ \t]*$/u;

/** Replace [start, end) with `insert`, tidying the gap a deletion leaves. */
function splice(text: string, start: number, end: number, insert: string): string {
  let before = text.slice(0, start);
  let after = text.slice(end);
  if (insert !== "") return before + insert + after;
  // A whole line's content (bullet included) went: the line goes too.
  const lineStart = before.lastIndexOf("\n") + 1;
  if (BULLET_ONLY.test(before.slice(lineStart)) && /^[ \t]*(?:\n|$)/u.test(after)) {
    before = before.slice(0, lineStart);
    after = after.replace(/^[ \t]*/u, "");
    if (after.startsWith("\n")) after = after.slice(1);
    else if (before.endsWith("\n")) before = before.slice(0, -1);
    return before + after;
  }
  if (/[ \t]$/u.test(before) && /^[ \t]/u.test(after)) after = after.replace(/^[ \t]+/u, "");
  if (/[ \t]$/u.test(before) && /^[.,;:!?)]/u.test(after)) before = before.replace(/[ \t]+$/u, "");
  if ((before === "" || before.endsWith("\n")) && /^[ \t]/u.test(after)) after = after.replace(/^[ \t]+/u, "");
  return before + after;
}

function words(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

/** Length of the longest common subsequence of two word lists. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Share of the original's words changed, field by field: per field, the larger of the words removed and the words
 * added against the longest common word sequence (a word replaced counts once), over all of the original's words.
 */
export function changedWordShare(before: FeedbackFieldAnswers, after: FeedbackFieldAnswers): number {
  let changed = 0;
  let total = 0;
  for (const field of POST_CLASS_FEEDBACK_FIELDS) {
    const a = words(before[field] ?? "");
    const b = words(after[field] ?? "");
    const common = lcsLength(a, b);
    changed += Math.max(a.length - common, b.length - common);
    total += a.length;
  }
  if (total === 0) return changed > 0 ? 1 : 0;
  return changed / total;
}

/** The candidate's combined length (characters, all four fields) over the post's. */
export function lengthRatio(before: FeedbackFieldAnswers, after: FeedbackFieldAnswers): number {
  const length = (fields: FeedbackFieldAnswers) => POST_CLASS_FEEDBACK_FIELDS.reduce((sum, field) => sum + [...(fields[field] ?? "")].length, 0);
  const base = length(before);
  return base === 0 ? Number.POSITIVE_INFINITY : length(after) / base;
}

/**
 * The posted text with each issue's minimal fix applied in order (see the module comment). Every issue must carry
 * a fix: an issue without one cannot be corrected by a minimal fix. Identical fixes (two issues on the same span) are
 * applied once.
 */
export function applyMinimalFixes(
  posted: FeedbackFieldAnswers,
  issues: ReadonlyArray<Pick<AuditIssue, "id" | "field" | "minimalFix">>,
): MinimalFixResult {
  const fields = { ...posted } as FeedbackFieldAnswers;
  const seen = new Set<string>();
  const touched = new Set<Field>();
  let applied = 0;
  for (const issue of issues) {
    const fix = issue.minimalFix;
    if (!fix) return { ok: false, reason: `no_minimal_fix:${issue.id}` };
    const key = JSON.stringify([issue.field, fix.action, fix.from, fix.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    const field = issue.field as Field;
    const text = fields[field] ?? "";
    const found = occurrences(text, fix.from);
    if (found.length === 0) return { ok: false, reason: `fix_no_match:${issue.id}` };
    if (found.length > 1) return { ok: false, reason: `fix_ambiguous:${issue.id}` };
    const start = found[0];
    const end = start + fix.from.length;
    if (fix.action === "clear_field") {
      fields[field] = "";
    } else if (fix.action === "delete_span") {
      fields[field] = splice(text, start, end, "");
    } else {
      if (fix.to === null) return { ok: false, reason: `fix_without_replacement:${issue.id}` };
      fields[field] = splice(text, start, end, fix.to);
    }
    touched.add(field);
    applied += 1;
  }
  for (const field of touched) fields[field] = tidyFeedbackText(fields[field]);
  if (POST_CLASS_FEEDBACK_FIELDS.every((field) => fields[field] === posted[field])) return { ok: false, reason: "no_change" };
  const wordShare = changedWordShare(posted, fields);
  if (wordShare > MAX_MINIMAL_FIX_WORD_SHARE) {
    return { ok: false, reason: `too_many_words_changed:${Math.round(wordShare * 100)}%` };
  }
  return { ok: true, fields, applied, wordShare };
}
