import { describe, expect, it } from "vitest";
import { configuredAtomTrial } from "../atom/trial";
const now = new Date("2026-10-01T07:00:00Z");
const env = { FEEDBACK_ATOM_TRIAL_STUDENT_ID: "_123", FEEDBACK_ATOM_TRIAL_DATE: "2026-09-29", FEEDBACK_ATOM_TRIAL_EXPIRES_AT: "2026-10-02T06:00:00Z" };
describe("temporary scheduled Atom retrieval trial", () => {
  it("is absent by default and automatically expires", () => {
    expect(configuredAtomTrial({}, now)).toBeNull();
    expect(configuredAtomTrial(env, new Date("2026-10-02T06:00:00Z"))).toBeNull();
  });
  it("accepts a recent exact student and date for at most 24 hours", () => {
    expect(configuredAtomTrial(env, now)).toEqual({ studentId: "_123", date: "2026-09-29" });
  });
  it.each([
    { FEEDBACK_ATOM_TRIAL_STUDENT_ID: "a name" },
    { FEEDBACK_ATOM_TRIAL_DATE: "2026-09-31" },
    { FEEDBACK_ATOM_TRIAL_DATE: "2026-10-02" },
    { FEEDBACK_ATOM_TRIAL_DATE: "2026-08-01" },
    { FEEDBACK_ATOM_TRIAL_EXPIRES_AT: "2026-10-03T07:00:00Z" },
    { FEEDBACK_ATOM_TRIAL_EXPIRES_AT: undefined },
  ])("rejects invalid or unbounded trial configuration %#", overrides => {
    expect(() => configuredAtomTrial({ ...env, ...overrides }, now)).toThrow("collection_failed");
  });
});
