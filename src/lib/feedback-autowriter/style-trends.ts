import { desc, gte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { recordIncident } from "./incidents";

/**
 * The style reviewer's findings, counted over a week, so a problem that keeps coming back becomes a writer rule or a
 * deterministic check instead of one dashboard item per post (7 Oct: "matched portion" / "assistance not marked" came
 * from the writer's own Atom rules; one rule change fixed every future post). Dashboard-only: info, never pushed.
 */

const SR = schema.feedbackIsebStyleReviews;

export const STYLE_TREND_DAYS = 7;
/** Posts with the same problem in the window before it is raised. */
export const STYLE_TREND_MIN_POSTS = 3;

/** Plain categories for the reviewer's free-text problems; the first match wins, in this order. */
const PROBLEM_CATEGORIES: ReadonlyArray<{ key: string; label: string; match: RegExp }> = [
  { key: "audit_wording", label: "audit or evidence wording in the post",
    match: /\b(?:audit[- ]style|matched portion|assistance (?:was |is )?not marked|not marked (?:as )?assisted|evidence wording)\b/iu },
  { key: "topic_repeat", label: "the performance paragraph repeats the topic list",
    match: /\b(?:repeats?|restates?|duplicates?)\b[^.]{0,40}\b(?:topic|inventory|list)|\btopic inventory\b/iu },
  { key: "homework", label: "homework wording", match: /\bhomework\b/iu },
  { key: "tone", label: "tone that is not warm or pupil-facing", match: /\b(?:warm(?:er)?|pupil-facing|tone|encouraging|clinical)\b/iu },
  { key: "length", label: "too long or wordy", match: /\b(?:too long|shorten|more concise|wordy)\b/iu },
  { key: "format", label: "numbering or layout", match: /\b(?:numbered|numbering|bullet(?:s|ed)?|layout)\b/iu },
];

export function styleProblemCategory(problem: string): { key: string; label: string } {
  const found = PROBLEM_CATEGORIES.find((category) => category.match.test(problem));
  return found ? { key: found.key, label: found.label } : { key: "other", label: "other style problems" };
}

export interface StyleTrend {
  key: string;
  label: string;
  posts: string[];
  /** The reviewer's own words for up to two posts (dashboard only). */
  examples: string[];
}

/** The latest review of each post in the window; categories found on at least `minPosts` posts, most posts first. */
export function recurringStyleProblems(reviews: ReadonlyArray<{ postId: string; status: string; result: unknown; createdAt: Date }>,
  options: { minPosts?: number } = {}): StyleTrend[] {
  const latest = new Map<string, (typeof reviews)[number]>();
  for (const review of [...reviews].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (!latest.has(review.postId)) latest.set(review.postId, review);
  }
  const trends = new Map<string, StyleTrend>();
  for (const review of latest.values()) {
    if (review.status !== "flagged") continue;
    const result = (review.result ?? {}) as { formatProblems?: unknown; verdict?: { problems?: unknown } | null };
    const found = new Map<string, { label: string; example: string }>();
    for (const code of Array.isArray(result.formatProblems) ? result.formatProblems : []) {
      if (typeof code !== "string") continue;
      // A deterministic check's own code, without the field it hit ("style:numbering:topics" → "style:numbering").
      const key = `check:${code.split(":").slice(0, 2).join(":")}`;
      if (!found.has(key)) found.set(key, { label: `the check ${code.split(":").slice(0, 2).join(":")}`, example: code });
    }
    for (const problem of Array.isArray(result.verdict?.problems) ? result.verdict.problems : []) {
      if (typeof problem !== "string") continue;
      const category = styleProblemCategory(problem);
      if (!found.has(category.key)) found.set(category.key, { label: category.label, example: problem.slice(0, 240) });
    }
    for (const [key, { label, example }] of found) {
      const trend = trends.get(key) ?? { key, label, posts: [], examples: [] };
      trend.posts.push(review.postId);
      if (trend.examples.length < 2) trend.examples.push(example);
      trends.set(key, trend);
    }
  }
  const minPosts = options.minPosts ?? STYLE_TREND_MIN_POSTS;
  return [...trends.values()].filter((trend) => trend.posts.length >= minPosts)
    .sort((a, b) => b.posts.length - a.posts.length || a.key.localeCompare(b.key));
}

/** ISO week key ("2026-W41") of a moment's Bangkok date, so a recurring problem is raised at most once a week. */
export function isoWeekKey(at: Date): string {
  const bangkok = new Date(at.getTime() + 7 * 3_600_000);
  const date = new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), bangkok.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Raise each recurring style problem of the last week once per ISO week (info, dashboard-only). */
export async function raiseRecurringStyleProblems(db: Database, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - STYLE_TREND_DAYS * 86_400_000);
  const reviews = await db.select({ postId: SR.postId, status: SR.status, result: SR.result, createdAt: SR.createdAt })
    .from(SR).where(gte(SR.createdAt, since)).orderBy(desc(SR.createdAt));
  let raised = 0;
  for (const trend of recurringStyleProblems(reviews)) {
    const created = await recordIncident(db, {
      dedupeKey: `style-recurring:${trend.key}:${isoWeekKey(now)}`,
      kind: "style_problem_recurring",
      severity: "info",
      summary: `The style reviewer flagged ${trend.label} on ${trend.posts.length} posts in the last ${STYLE_TREND_DAYS} days. ` +
        "If it is a real pattern, turn it into a writer rule or a deterministic check; otherwise acknowledge it.",
      detail: { category: trend.key, postIds: trend.posts, examples: trend.examples },
    });
    if (created) raised += 1;
  }
  return raised;
}
