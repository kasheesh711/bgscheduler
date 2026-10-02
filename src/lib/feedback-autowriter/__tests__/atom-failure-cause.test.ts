import { describe, expect, it, vi } from "vitest";
import { atomFailureCause } from "../atom/collector";
import { AtomCollectionError } from "../atom/normalize";
vi.mock("server-only", () => ({}));

describe("Atom failure cause labels", () => {
  it.each([
    [new AtomCollectionError("collection_failed", "sign_in_form"), "sign_in_form"],
    [new AtomCollectionError("authentication_failed"), "authentication_failed"],
    [new Error("Wise timetable occurrences conflict"), "timetable_conflict"],
    [new Error("Incomplete Wise day pagination for 2026-10-02 (PAST, page 2)"), "pagination_incomplete"],
    [new Error("Unable to verify complete Wise session pagination at page 3"), "pagination_incomplete"],
    [new Error("Wise returned an empty advertised session page"), "pagination_incomplete"],
    [new Error("Wise session read exceeded its time budget"), "time_budget"],
    [new DOMException("Wise day read time budget exceeded", "TimeoutError"), "time_budget"],
    [new Error("Invalid, duplicate or out-of-date Wise session for 2026-10-02"), "invalid_session"],
    [new TypeError("fetch failed: secret-value"), "TypeError"],
    ["a string", "unknown"],
  ])("labels %s as %s", (error, label) => {
    expect(atomFailureCause(error)).toBe(label);
  });
});
