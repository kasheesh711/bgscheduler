import { describe, expect, it } from "vitest";
import {
  shouldAutoFinalizePreviousMonth,
  sourceShouldRefresh,
  statusAfterSuccessfulImport,
} from "@/lib/sales-dashboard/lifecycle";
import type { SalesSourceStatus } from "@/lib/sales-dashboard/types";

function source(sourceMonth: string, status: SalesSourceStatus = "active") {
  return { sourceMonth, status };
}

describe("sales dashboard month lifecycle", () => {
  it("refreshes current month and previous month through Bangkok day 7", () => {
    const day7Bangkok = new Date("2026-05-06T17:00:00.000Z");

    expect(sourceShouldRefresh(source("2026-05-01"), day7Bangkok)).toBe(true);
    expect(sourceShouldRefresh(source("2026-04-01"), day7Bangkok)).toBe(true);
    expect(sourceShouldRefresh(source("2026-03-01"), day7Bangkok)).toBe(false);
    expect(sourceShouldRefresh(source("2026-04-01", "finalized"), day7Bangkok)).toBe(false);
  });

  it("stops refreshing previous month and auto-finalizes on Bangkok day 8", () => {
    const day8Bangkok = new Date("2026-05-07T17:00:00.000Z");

    expect(sourceShouldRefresh(source("2026-04-01"), day8Bangkok)).toBe(false);
    expect(shouldAutoFinalizePreviousMonth(source("2026-04-01"), day8Bangkok)).toBe(true);
    expect(shouldAutoFinalizePreviousMonth(source("2026-04-01", "reopened"), day8Bangkok)).toBe(false);
  });

  it("finalizes historical months after successful import while keeping reopened sources reopened", () => {
    const day8Bangkok = new Date("2026-05-07T17:00:00.000Z");

    expect(statusAfterSuccessfulImport("2026-03-01", "active", day8Bangkok)).toBe("finalized");
    expect(statusAfterSuccessfulImport("2026-04-01", "active", day8Bangkok)).toBe("finalized");
    expect(statusAfterSuccessfulImport("2026-05-01", "active", day8Bangkok)).toBe("active");
    expect(statusAfterSuccessfulImport("2026-03-01", "reopened", day8Bangkok)).toBe("reopened");
  });
});
