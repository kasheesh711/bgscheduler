import type { Database } from "@/lib/db";
import { recordIncident, refreshOpenIncident } from "./incidents";
import { bangkokDateKey } from "./quality";

/**
 * OpenRouter credit watch. Two separate limits stop every model call when they run out (11 Oct 2026: the key's $20
 * monthly limit stopped both writers and the judges for 14 hours, and four classes were held):
 * - the key's own spending limit (`/api/v1/key`: `limit`, `limit_remaining`, reset monthly), and
 * - the account's prepaid balance every key draws on (`/api/v1/credits`), even with auto top-up on (a payment can fail).
 * The review job checks both hourly and pushes one incident a day while either is short, before it runs out.
 */

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

/** Warn while the key limit has less than this many days of spending left (at this month's daily rate). */
export const CREDIT_RUNWAY_WARN_DAYS = 7;
/**
 * Warn when the account balance falls below this. Auto top-up refills the balance from its own threshold (owner,
 * 12 Oct 2026), so a low balance is normal there and only a balance near zero means a top-up failed.
 */
export const ACCOUNT_FLOOR_USD = 1;

export interface OpenRouterBudget {
  /** The key's limit for its period and what is left of it; null when the key has no limit. */
  keyLimitUsd: number | null;
  keyRemainingUsd: number | null;
  /** `monthly`, `weekly`, `daily`, or null (a lifetime limit). */
  keyLimitReset: string | null;
  /** What the key spent this calendar month (UTC), the rate both projections use. */
  keyUsageMonthUsd: number;
  /** The account's prepaid balance; null when the account endpoint did not answer. */
  accountRemainingUsd: number | null;
}

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Both budgets, read together with the production key. Throws on a key read failure; a failed account read leaves
 * `accountRemainingUsd` null (the watch reports it as unread rather than as fine).
 */
export async function fetchOpenRouterBudget(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<OpenRouterBudget> {
  const get = async (url: string) => {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!response.ok) throw new Error(`OpenRouter ${url.split("/").pop()} read: HTTP ${response.status}`);
    return ((await response.json()) as { data?: Record<string, unknown> }).data ?? {};
  };
  const [keyRead, creditsRead] = await Promise.allSettled([get(OPENROUTER_KEY_URL), get(OPENROUTER_CREDITS_URL)]);
  if (keyRead.status === "rejected") throw keyRead.reason;
  const key = keyRead.value;
  const credits = creditsRead.status === "fulfilled" ? creditsRead.value : null;
  const total = finite(credits?.total_credits);
  const used = finite(credits?.total_usage);
  return {
    keyLimitUsd: finite(key.limit),
    keyRemainingUsd: finite(key.limit_remaining),
    keyLimitReset: typeof key.limit_reset === "string" ? key.limit_reset : null,
    keyUsageMonthUsd: finite(key.usage_monthly) ?? 0,
    accountRemainingUsd: total !== null && used !== null ? total - used : null,
  };
}

/**
 * This month's spending per day so far (UTC month). At least one day counts as elapsed, so the first hours of a month
 * read low (a monthly limit has just reset then, so nothing is short).
 */
function dailyRate(budget: OpenRouterBudget, now: Date): number {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return budget.keyUsageMonthUsd / Math.max(1, (now.getTime() - monthStart) / 86_400_000);
}

/** Days until the key's limit resets (OpenRouter resets at 00:00 UTC: daily, Mondays, the 1st); Infinity for none. */
export function daysUntilReset(reset: string | null, now: Date): number {
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  const at = reset === "daily" ? Date.UTC(y, m, d + 1)
    : reset === "weekly" ? Date.UTC(y, m, d + ((8 - now.getUTCDay()) % 7 || 7))
      : reset === "monthly" ? Date.UTC(y, m + 1, 1) : Infinity;
  return (at - now.getTime()) / 86_400_000;
}

/**
 * What is short, in plain words for the push; empty while nothing is. The key's limit warns when, at this month's
 * daily rate, it runs out within a week AND before it resets (a $60 monthly limit on the 27th with $12 left resets
 * first: no warning). The account balance warns only near zero.
 */
export function creditProblems(budget: OpenRouterBudget, now: Date): string[] {
  const rate = dailyRate(budget, now);
  const problems: string[] = [];
  if (budget.accountRemainingUsd !== null && budget.accountRemainingUsd < ACCOUNT_FLOOR_USD) {
    problems.push(`account balance $${Math.max(0, budget.accountRemainingUsd).toFixed(2)} left: add credits or check that auto top-up's payment works`);
  }
  if (budget.keyLimitUsd !== null && budget.keyRemainingUsd !== null) {
    const days = rate > 0 ? budget.keyRemainingUsd / rate : Infinity;
    if (budget.keyRemainingUsd <= 0 || (days < CREDIT_RUNWAY_WARN_DAYS && days < daysUntilReset(budget.keyLimitReset, now))) {
      const left = budget.keyRemainingUsd <= 0 ? "has run out"
        : `has $${budget.keyRemainingUsd.toFixed(2)} left, about ${days.toFixed(1)} days at $${rate.toFixed(2)}/day (around ${new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10)})`;
      problems.push(`the key's $${budget.keyLimitUsd.toFixed(2)}${budget.keyLimitReset ? ` ${budget.keyLimitReset}` : ""} limit ${left}: raise the key's limit`);
    }
  }
  return problems;
}

/**
 * One pushed incident a Bangkok day while credit is short, whichever saw it first: the hourly watch or a refused call.
 * A later sighting the same day refreshes its text (not pushed again). Returns whether this call raised it.
 */
export async function raiseCreditIncident(db: Database, input: { problems: string[]; now: Date; cause: "watch" | "exhausted"; detail?: Record<string, unknown> }): Promise<boolean> {
  if (input.problems.length === 0) return false;
  const lead = input.cause === "exhausted"
    ? "OpenRouter refused a model call for lack of credit. No feedback is written until it is topped up; classes retry every 10 minutes meanwhile."
    : "OpenRouter credit is running short. Feedback stops when it runs out.";
  const incident = {
    dedupeKey: `model-credit:${bangkokDateKey(input.now)}`,
    summary: `${lead} ${input.problems.join("; ")}.`,
    detail: { cause: input.cause, problems: input.problems, ...(input.detail ?? {}) },
  };
  if (await recordIncident(db, { ...incident, kind: "model_credit", severity: "critical" })) return true;
  await refreshOpenIncident(db, incident);
  return false;
}
