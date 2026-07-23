import { describe, expect, it } from "vitest";
import {
  hasLearningPlansAccess,
  LEARNING_PLANS_ROUTE,
} from "@/lib/learning-plans/access-policy";

describe("learning plans access policy", () => {
  it("keeps full-access admins automatic without a grant", () => {
    expect(hasLearningPlansAccess(null, "admin", false)).toBe(true);
    expect(hasLearningPlansAccess(undefined, "admin", false)).toBe(true);
  });

  it("keeps legacy full-admin sessions automatic", () => {
    expect(hasLearningPlansAccess(null, undefined, false)).toBe(true);
  });

  it("preserves the exact historical page grant for restricted admins", () => {
    expect(
      hasLearningPlansAccess([LEARNING_PLANS_ROUTE], "admin", false),
    ).toBe(true);
    expect(
      hasLearningPlansAccess([LEARNING_PLANS_ROUTE], undefined, false),
    ).toBe(true);
  });

  it("requires a fresh grant for restricted admins without that exact page", () => {
    expect(
      hasLearningPlansAccess(["/progress-tests"], "admin", true),
    ).toBe(true);
    expect(
      hasLearningPlansAccess(["/progress-tests"], "admin", false),
    ).toBe(false);
  });

  it("does not confuse nested or similarly prefixed legacy pages for the exact grant", () => {
    expect(
      hasLearningPlansAccess(["/learning-plans/report"], "admin", false),
    ).toBe(false);
    expect(
      hasLearningPlansAccess(["/learning-plans-extra"], "admin", false),
    ).toBe(false);
  });

  it("allows teachers only when the fresh grant is effective", () => {
    expect(
      hasLearningPlansAccess(["/progress-tests"], "teacher", false),
    ).toBe(false);
    expect(
      hasLearningPlansAccess(["/progress-tests"], "teacher", true),
    ).toBe(true);
  });

  it("denies every other role even when a grant row exists", () => {
    for (const role of ["viewer", "counselor", "student", "parent"]) {
      expect(hasLearningPlansAccess(null, role, true)).toBe(false);
    }
  });
});
