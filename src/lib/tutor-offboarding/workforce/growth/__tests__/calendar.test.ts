import { describe, expect, it } from "vitest";
import { addMonths, churnBaselineMonths, commonMatureWindow, historyCoversMonth } from "../calendar";
import type { WorkforceSourceCoverage } from "../../types";

describe("growth Bangkok calendar", () => {
  it("uses May–July before an August final class", () => {
    expect(churnBaselineMonths("2026-08-20T03:00:00Z")).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(churnBaselineMonths("2026-08-31T18:00:00Z")).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
  it("uses June–August as the common mature window on October 1", () => {
    expect(commonMatureWindow(new Date("2026-10-01T03:00:00Z"))).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(commonMatureWindow(new Date("2026-06-01T03:00:00Z"))).toEqual([]);
    expect(addMonths("2026-01", -2)).toBe("2025-11");
  });
  it("requires every day of history, preserving complete zero months", () => {
    const c = (from: string, to: string): WorkforceSourceCoverage => ({ source: "wise_history", requestedFrom: from, requestedTo: to, returnedFrom: null, returnedTo: null, pagesRequested: 1, pagesReturned: 1, recordsReturned: 0, truncated: false, completeness: "complete", issueCodes: [] });
    expect(historyCoversMonth([c("2026-05-01", "2026-05-31")], "2026-05")).toBe(true);
    expect(historyCoversMonth([c("2026-05-01", "2026-05-15"),c("2026-05-17", "2026-05-31")], "2026-05")).toBe(false);
    expect(historyCoversMonth([c("2026-05-01", "2026-05-15"),c("2026-05-16", "2026-05-31")], "2026-05")).toBe(true);
    expect(historyCoversMonth([{...c("2026-05-01", "2026-05-31"), truncated:true}], "2026-05")).toBe(false);
  });
});
