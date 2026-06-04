import { describe, expect, it, vi } from "vitest";

// `@/lib/auth` instantiates NextAuth at import time; stub it so the pure
// hasPageAccess helper can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { hasPageAccess } from "@/lib/progress-tests/api";

describe("hasPageAccess", () => {
  it("grants full access when allowedPages is null (existing admins)", () => {
    expect(hasPageAccess(null, "/progress-tests")).toBe(true);
    expect(hasPageAccess(null, "/credit-control")).toBe(true);
  });

  it("grants full access when allowedPages is undefined", () => {
    expect(hasPageAccess(undefined, "/progress-tests")).toBe(true);
  });

  it("allows an exact prefix match for restricted users", () => {
    expect(hasPageAccess(["/progress-tests"], "/progress-tests")).toBe(true);
  });

  it("allows a sub-path of an allowed prefix", () => {
    expect(hasPageAccess(["/progress-tests"], "/progress-tests/book")).toBe(true);
  });

  it("denies a route outside the allowed prefixes", () => {
    expect(hasPageAccess(["/progress-tests"], "/credit-control")).toBe(false);
  });

  it("does not treat a substring as a prefix match", () => {
    expect(hasPageAccess(["/progress-tests"], "/progress-tests-extra")).toBe(false);
  });

  it("denies all routes when allowedPages is empty", () => {
    expect(hasPageAccess([], "/progress-tests")).toBe(false);
  });
});
