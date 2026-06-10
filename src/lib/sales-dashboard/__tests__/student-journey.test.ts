import { describe, expect, it } from "vitest";
import { buildCoverageWindows } from "../student-journey";

describe("buildCoverageWindows", () => {
  it("returns no windows when no transaction carries validUntil", () => {
    expect(buildCoverageWindows([
      { date: "2026-01-05", validUntil: null },
      { date: "2026-01-12", validUntil: null },
    ], "2026-06-01")).toEqual([]);
  });

  it("chains back-to-back coverage with no gap", () => {
    const windows = buildCoverageWindows([
      { date: "2026-01-01", validUntil: "2026-02-28" },
      { date: "2026-02-20", validUntil: "2026-04-30" },
    ], "2026-06-01");

    expect(windows).toEqual([
      { from: "2026-01-01", until: "2026-02-28", status: "covered" },
      { from: "2026-02-20", until: "2026-04-30", status: "covered" },
    ]);
  });

  it("inserts a gap window when the renewal lands after coverage expired", () => {
    const windows = buildCoverageWindows([
      { date: "2026-01-01", validUntil: "2026-01-31" },
      { date: "2026-03-15", validUntil: "2026-04-30" },
    ], "2026-06-01");

    expect(windows).toEqual([
      { from: "2026-01-01", until: "2026-01-31", status: "covered" },
      { from: "2026-01-31", until: "2026-03-15", status: "gap" },
      { from: "2026-03-15", until: "2026-04-30", status: "covered" },
    ]);
  });

  it("marks the final window open while coverage is still running", () => {
    const windows = buildCoverageWindows([
      { date: "2026-01-01", validUntil: "2026-01-31" },
      { date: "2026-05-20", validUntil: "2026-07-31" },
    ], "2026-06-01");

    expect(windows).toEqual([
      { from: "2026-01-01", until: "2026-01-31", status: "covered" },
      { from: "2026-01-31", until: "2026-05-20", status: "gap" },
      { from: "2026-05-20", until: "2026-07-31", status: "open" },
    ]);
  });

  it("ignores trial rows mixed into the purchase list", () => {
    const windows = buildCoverageWindows([
      { date: "2026-01-01", validUntil: null },
      { date: "2026-01-10", validUntil: "2026-02-28" },
    ], "2026-02-01");

    expect(windows).toEqual([
      { from: "2026-01-10", until: "2026-02-28", status: "open" },
    ]);
  });

  it("sorts unsorted input by purchase date before chaining", () => {
    const windows = buildCoverageWindows([
      { date: "2026-03-15", validUntil: "2026-04-30" },
      { date: "2026-01-01", validUntil: "2026-01-31" },
    ], "2026-06-01");

    expect(windows.map((window) => window.status)).toEqual(["covered", "gap", "covered"]);
  });
});
