import { describe, expect, it, vi } from "vitest";
import { creditProblems, daysUntilReset, fetchOpenRouterBudget, type OpenRouterBudget } from "../model-credit";

const NOW = new Date("2026-10-12T05:30:00Z"); // 11.23 days into October
const budget = (patch: Partial<OpenRouterBudget> = {}): OpenRouterBudget => ({
  keyLimitUsd: 50, keyRemainingUsd: 29.99, keyLimitReset: "monthly", keyUsageMonthUsd: 20.01, accountRemainingUsd: 12, ...patch,
});

describe("creditProblems", () => {
  it("is quiet while the key has a week or more left and the account is above the floor", () => {
    // $20.01 in 11.23 days = $1.78/day: $29.99 lasts ~16.8 days.
    expect(creditProblems(budget(), NOW)).toEqual([]);
    // A low balance alone is auto top-up's normal state (owner, 12 Oct 2026).
    expect(creditProblems(budget({ accountRemainingUsd: 2.56 }), NOW)).toEqual([]);
  });

  it("warns a week before the key's limit is reached at this month's pace", () => {
    // The 11 Oct outage: a $20 monthly limit with ~$1.8/day spent.
    const [problem, ...rest] = creditProblems(budget({ keyLimitUsd: 20, keyRemainingUsd: 7, keyUsageMonthUsd: 13 }), NOW);
    expect(rest).toEqual([]);
    expect(problem).toContain("$20.00 monthly limit has $7.00 left, about 6.0 days");
    expect(creditProblems(budget({ keyLimitUsd: 20, keyRemainingUsd: 5, keyUsageMonthUsd: 15 }), NOW)[0]).toMatch(/about 3\.7 days at \$1\.34\/day \(around 2026-10-15\)/u);
    expect(creditProblems(budget({ keyLimitUsd: 20, keyRemainingUsd: 0, keyUsageMonthUsd: 20 }), NOW)[0]).toContain("has run out: raise the key's limit");
  });

  it("warns when the account balance is near zero (a top-up that failed) and ignores a key with no limit", () => {
    const problems = creditProblems(budget({ keyLimitUsd: null, keyRemainingUsd: null, accountRemainingUsd: 0.4 }), NOW);
    expect(problems).toEqual(["account balance $0.40 left: add credits or check that auto top-up's payment works"]);
  });

  it("does not warn when the limit resets before the money runs out", () => {
    // Review of #198: a $60 monthly limit on 27 Oct with $12 left lasts 6.7 days at $1.78/day, past the 1 Nov reset.
    const late = new Date("2026-10-27T05:00:00Z");
    expect(creditProblems(budget({ keyLimitUsd: 60, keyRemainingUsd: 12, keyUsageMonthUsd: 48 }), late)).toEqual([]);
    // A daily or weekly limit is measured against its own reset, not the month's average.
    expect(creditProblems(budget({ keyLimitUsd: 10, keyRemainingUsd: 9, keyLimitReset: "daily" }), NOW)).toEqual([]);
    // Sunday 20:00 UTC: $1 left is ~0.5 days, but the weekly limit resets at midnight.
    expect(creditProblems(budget({ keyLimitUsd: 15, keyRemainingUsd: 1, keyLimitReset: "weekly" }), new Date("2026-10-11T20:00:00Z"))).toEqual([]);
    // A lifetime limit never resets: the runway alone decides.
    expect(creditProblems(budget({ keyLimitUsd: 30, keyRemainingUsd: 9, keyLimitReset: null }), NOW)).toHaveLength(1);
    // Spent before a reset still pages: it is an outage now.
    expect(creditProblems(budget({ keyLimitUsd: 10, keyRemainingUsd: 0, keyLimitReset: "daily" }), NOW)[0]).toContain("has run out");
  });

  it("knows when each kind of limit resets (00:00 UTC)", () => {
    const monday = new Date("2026-10-12T05:30:00Z"); // a Monday
    expect(daysUntilReset("daily", monday)).toBeCloseTo(18.5 / 24, 5);
    expect(daysUntilReset("weekly", monday)).toBeCloseTo(7 - 5.5 / 24, 5);
    expect(daysUntilReset("weekly", new Date("2026-10-11T23:00:00Z"))).toBeCloseTo(1 / 24, 5);
    expect(daysUntilReset("monthly", monday)).toBeCloseTo(19 + 18.5 / 24, 5);
    expect(daysUntilReset(null, monday)).toBe(Infinity);
  });

  it("does not divide by zero at the start of a month or with no spending", () => {
    expect(creditProblems(budget({ keyUsageMonthUsd: 0, keyRemainingUsd: 50 }), new Date("2026-11-01T00:10:00Z"))).toEqual([]);
  });
});

describe("fetchOpenRouterBudget", () => {
  it("reads the key limit and the account balance with the key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(String(url).endsWith("/key")
      ? { data: { limit: 50, limit_remaining: 29.99, limit_reset: "monthly", usage_monthly: 20.01 } }
      : { data: { total_credits: 30, total_usage: 27.44 } })));
    const result = await fetchOpenRouterBudget("sk-test", fetchImpl);
    expect(result).toEqual({ keyLimitUsd: 50, keyRemainingUsd: 29.99, keyLimitReset: "monthly", keyUsageMonthUsd: 20.01, accountRemainingUsd: expect.closeTo(2.56, 5) });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { authorization: "Bearer sk-test" } });
  });

  it("fails on a key read error but survives a missing account read", async () => {
    const failing = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(fetchOpenRouterBudget("sk", failing as unknown as typeof fetch)).rejects.toThrow("HTTP 401");
    const keyOnly = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/key")
      ? new Response(JSON.stringify({ data: { limit: null, limit_remaining: null, usage_monthly: 3 } }))
      : new Response("forbidden", { status: 403 }));
    expect(await fetchOpenRouterBudget("sk", keyOnly as unknown as typeof fetch)).toMatchObject({ keyLimitUsd: null, accountRemainingUsd: null });
  });
});
