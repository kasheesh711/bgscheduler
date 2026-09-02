import { describe, expect, it } from "vitest";
import {
  hasLearningPlansAccess,
  LEARNING_PLANS_ROUTE,
} from "@/lib/learning-plans/access-policy";

describe("learning plans access policy", () => {
  it("allows full-access admins", () => {
    expect(hasLearningPlansAccess(null, "admin")).toBe(true);
    expect(hasLearningPlansAccess(undefined, "admin")).toBe(true);
  });

  it("allows restricted admins with the learning-plans page grant", () => {
    expect(hasLearningPlansAccess([LEARNING_PLANS_ROUTE], "admin")).toBe(true);
  });

  it("denies explicit non-admin roles", () => {
    expect(hasLearningPlansAccess(null, "teacher")).toBe(false);
    expect(hasLearningPlansAccess([LEARNING_PLANS_ROUTE], "viewer")).toBe(false);
  });

  it("denies restricted admins with the wrong prefix", () => {
    expect(hasLearningPlansAccess(["/progress-tests"], "admin")).toBe(false);
    expect(hasLearningPlansAccess(["/learning-plans/report"], "admin")).toBe(false);
    expect(hasLearningPlansAccess(["/learning-plans-extra"], "admin")).toBe(false);
  });
});
