import { describe, expect, it, vi } from "vitest";
import { atomFailureCause, isTransientAtomFailure } from "../atom/collector";
import { AtomCollectionError } from "../atom/normalize";
import { WiseApiError } from "@/lib/wise/client";
vi.mock("server-only", () => ({}));

describe("Atom failure cause labels", () => {
  it.each([
    [new AtomCollectionError("collection_failed", "sign_in_form"), "sign_in_form"],
    [new AtomCollectionError("authentication_failed"), "authentication_failed"],
    [new Error("Wise timetable occurrences conflict"), "timetable_conflict"],
    [new Error("Incomplete Wise day pagination for 2026-10-02 (PAST, page 2)"), "pagination_incomplete"],
    [new Error("Unable to verify complete Wise session pagination at page 3"), "pagination_incomplete"],
    [new Error("Wise returned an empty advertised session page"), "pagination_incomplete"],
    [new Error("Wise session page count contradicts its contents"), "pagination_incomplete"],
    [new Error("Wise session read contains a duplicate session (the listing changed between pages)"), "duplicate_session"],
    [new Error("Wise session read contains missing or invalid session data"), "invalid_session"],
    [new Error("Invalid Wise calendar date"), "invalid_date"],
    [new WiseApiError(429, "{\"secret\":\"body\"}", "https://api.wiseapp.live/x"), "wise_http_429"],
    [new Error("Wise session read exceeded its time budget"), "time_budget"],
    [new DOMException("Wise day read time budget exceeded", "TimeoutError"), "time_budget"],
    [new Error("Duplicate Wise session for 2026-10-02 (the listing changed between pages)"), "duplicate_session"],
    [new Error("Invalid or out-of-date Wise session for 2026-10-02"), "invalid_session"],
    [new TypeError("fetch failed: secret-value"), "TypeError"],
    ["a string", "unknown"],
  ])("labels %s as %s", (error, label) => {
    expect(atomFailureCause(error)).toBe(label);
  });
});

describe("isTransientAtomFailure (what may wait one run before paging)", () => {
  it.each([
    ["collection_failed", "wise_http_429", true],
    ["collection_failed", "wise_http_503", true],
    ["collection_failed", "time_budget", true],
    ["collection_failed", "duplicate_session", true],
    ["collection_failed", "pagination_incomplete", true],
    ["collection_failed", "wise_http_404", false],
    ["collection_failed", "invalid_session", false],
    ["collection_failed", "timetable_conflict", false],
    ["collection_failed", "run_deadline", false],
    ["collection_failed", null, false],
    ["response_changed", "time_budget", false],
    ["authentication_failed", "wise_http_429", false],
  ] as const)("%s / %s → %s", (code, cause, expected) => {
    expect(isTransientAtomFailure(code, cause)).toBe(expected);
  });
});
