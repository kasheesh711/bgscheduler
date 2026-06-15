import { afterEach, describe, expect, it } from "vitest";
import {
  budgetUsageRatio,
  monthStartIso,
  providerHardCapUsd,
  wouldExceedBudget,
} from "@/lib/competitor-intelligence/budget";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("competitor intelligence budget caps", () => {
  it("uses the UTC month start as the usage bucket", () => {
    expect(monthStartIso(new Date("2026-06-15T12:00:00.000Z"))).toBe("2026-06-01");
  });

  it("supports scoped provider caps", () => {
    process.env.COMPETITOR_DATAFORSEO_MONTHLY_CAP_USD = "12.5";
    process.env.COMPETITOR_INTEL_MONTHLY_CAP_USD = "250";

    expect(providerHardCapUsd("dataforseo", "serp")).toBe(12.5);
    expect(providerHardCapUsd("apify", "instagram")).toBe(250);
  });

  it("blocks runs that would exceed hard caps", () => {
    expect(wouldExceedBudget({
      provider: "dataforseo",
      sourceType: "serp",
      usageMonth: "2026-06-01",
      hardCapUsd: 1,
      estimatedCostUsd: 0.99,
    }, 0.02)).toBe(true);
  });

  it("reports bounded usage ratios", () => {
    expect(budgetUsageRatio({ hardCapUsd: 100, estimatedCostUsd: 25 })).toBe(0.25);
    expect(budgetUsageRatio({ hardCapUsd: 100, estimatedCostUsd: 250 })).toBe(1);
    expect(budgetUsageRatio({ hardCapUsd: 0, estimatedCostUsd: 250 })).toBe(0);
  });
});
