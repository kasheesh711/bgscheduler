import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

// `@/lib/auth` instantiates NextAuth at import time; stub it so the pure
// hasPageAccess helper + session guards can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import {
  hasPageAccess,
  requireProgressTestsSession,
  requireProgressTestsAdminSession,
} from "@/lib/progress-tests/api";

const authMock = auth as unknown as Mock;

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

describe("requireProgressTestsSession", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("returns the user with role 'admin' by default (no role on session)", async () => {
    authMock.mockResolvedValue({ user: { email: "Admin@Example.com", name: "Admin", allowedPages: null } });

    await expect(requireProgressTestsSession()).resolves.toEqual({
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
    });
  });

  it("carries role 'teacher' from the session", async () => {
    authMock.mockResolvedValue({
      user: { email: "aey@example.com", name: "Aey", allowedPages: ["/progress-tests"], role: "teacher" },
    });

    await expect(requireProgressTestsSession()).resolves.toMatchObject({ role: "teacher" });
  });

  it("throws Unauthorized when no email", async () => {
    authMock.mockResolvedValue(null);

    await expect(requireProgressTestsSession()).rejects.toThrow("Unauthorized");
  });

  it("throws Forbidden when allowedPages excludes /progress-tests", async () => {
    authMock.mockResolvedValue({ user: { email: "x@example.com", name: "X", allowedPages: ["/credit-control"] } });

    await expect(requireProgressTestsSession()).rejects.toThrow("Forbidden");
  });
});

describe("requireProgressTestsAdminSession", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("returns the user for an admin session", async () => {
    authMock.mockResolvedValue({ user: { email: "admin@example.com", name: "Admin", allowedPages: null, role: "admin" } });

    await expect(requireProgressTestsAdminSession()).resolves.toMatchObject({ role: "admin" });
  });

  it("throws Forbidden for a teacher session (read-only)", async () => {
    authMock.mockResolvedValue({
      user: { email: "aey@example.com", name: "Aey", allowedPages: ["/progress-tests"], role: "teacher" },
    });

    await expect(requireProgressTestsAdminSession()).rejects.toThrow("Forbidden");
  });
});
