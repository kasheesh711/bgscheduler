import { describe, expect, it } from "vitest";

import {
  completedMonthEndPeriods,
  unearnedRevenueLotLabel,
  unearnedRevenueModelPresentation,
  unearnedRevenuePeriodSuffix,
  unearnedRevenueWaterfall,
} from "@/lib/unearned-revenue/presentation";

describe("unearned revenue dashboard presentation", () => {
  it("clearly distinguishes legacy shadow mode from an approved FIFO cutover", () => {
    expect(unearnedRevenueModelPresentation("LEGACY_ACCOUNT_RATE")).toMatchObject({
      fifoCanonical: false,
      badgeLabel: "FIFO shadow · legacy canonical",
    });
    expect(unearnedRevenueModelPresentation("FIFO_PACKAGE_LOT_V1")).toMatchObject({
      fifoCanonical: true,
      badgeLabel: "FIFO canonical",
    });
  });

  it("labels actual-cutoff and month-end periods without inventing a future month-end", () => {
    expect(unearnedRevenuePeriodSuffix("LATEST")).toBe("latest completed day");
    expect(unearnedRevenuePeriodSuffix("MONTH_END")).toBe("month-end");
    expect(completedMonthEndPeriods([
      { periodKind: "MONTH_END", periodEnd: "2026-08-31" },
      { periodKind: "LATEST", periodEnd: "2026-09-03" },
    ] as never).map((period) => period.periodEnd)).toEqual(["2026-08-31"]);
  });

  it("constructs a true floating waterfall and preserves the accounting identity", () => {
    expect(unearnedRevenueWaterfall({ opening: 100, deferred: 40, recognized: 25, closing: 115 }))
      .toEqual([[0, 100], [100, 140], [115, 140], [0, 115]]);
  });

  it("never presents opening or residual lots as real package names", () => {
    expect(unearnedRevenueLotLabel({ lotKind: "OPENING", packageName: "", transactionNumber: "" }))
      .toContain("synthetic");
    expect(unearnedRevenueLotLabel({ lotKind: "AMBIGUOUS", packageName: "Candidate", transactionNumber: "T1" }))
      .toContain("residual");
    expect(unearnedRevenueLotLabel({ lotKind: "UNATTRIBUTED", packageName: "", transactionNumber: "" }))
      .toContain("residual");
  });
});
