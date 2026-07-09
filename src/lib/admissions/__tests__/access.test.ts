import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";

// `@/lib/auth` instantiates NextAuth at import time and `@/lib/db` pulls the
// Neon driver; stub both so the guards can be unit-tested in isolation.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import {
  admissionsErrorResponse,
  requireAdmissionsSession,
  requireCaseAccess,
  resolveAdmissionsRole,
} from "@/lib/admissions/access";
import { roleAtLeast } from "@/lib/admissions/config";

const authMock = auth as unknown as Mock;

const CASE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Minimal chainable Drizzle stand-in: each db.select() returns a builder whose
 * methods chain and which (when awaited) resolves to the next queued result.
 * Queue order must match the function's query order — for requireCaseAccess:
 * [adminUsers, admissionsCases, admissionsCaseMembers, (admissionsCounselors)].
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  const selectCalls: number[] = [];
  function builder(rows: unknown[]) {
    const b: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      b[method] = () => b;
    }
    (b as { then: unknown }).then = (
      resolve: (value: unknown) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject);
    return b;
  }
  const db = {
    select: () => {
      selectCalls.push(i);
      return builder(queue[i++] ?? []);
    },
  };
  return { db: db as never, selectCalls };
}

describe("roleAtLeast", () => {
  it("orders parent < student < counselor < admin", () => {
    expect(roleAtLeast("parent", "parent")).toBe(true);
    expect(roleAtLeast("parent", "student")).toBe(false);
    expect(roleAtLeast("student", "parent")).toBe(true);
    expect(roleAtLeast("student", "counselor")).toBe(false);
    expect(roleAtLeast("counselor", "student")).toBe(true);
    expect(roleAtLeast("counselor", "admin")).toBe(false);
    expect(roleAtLeast("admin", "counselor")).toBe(true);
  });
});

describe("resolveAdmissionsRole", () => {
  it("returns counselor from an active registry row without querying members", () => {
    const { db, selectCalls } = fakeDb([[{ id: "c1" }]]);

    return resolveAdmissionsRole("staff@example.com", db).then((role) => {
      expect(role).toBe("counselor");
      expect(selectCalls).toHaveLength(1);
    });
  });

  it("prefers student over parent when both memberships exist (global claim precedence)", async () => {
    const { db } = fakeDb([[], [{ role: "parent" }, { role: "student" }]]);

    await expect(resolveAdmissionsRole("dual@example.com", db)).resolves.toBe("student");
  });

  it("returns parent for a parent-only membership", async () => {
    const { db } = fakeDb([[], [{ role: "parent" }]]);

    await expect(resolveAdmissionsRole("mom@example.com", db)).resolves.toBe("parent");
  });

  it("does not grant a global role from a counselor member row alone (registry is authoritative)", async () => {
    const { db } = fakeDb([[], [{ role: "counselor" }]]);

    await expect(resolveAdmissionsRole("ghost@example.com", db)).resolves.toBeNull();
  });

  it("returns null when neither registry nor membership matches", async () => {
    const { db } = fakeDb([[], []]);

    await expect(resolveAdmissionsRole("stranger@example.com", db)).resolves.toBeNull();
  });

  it("returns null for an empty email without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(resolveAdmissionsRole("   ", db)).resolves.toBeNull();
    expect(selectCalls).toHaveLength(0);
  });

  it("normalizes the email before matching (trim + lowercase input accepted)", async () => {
    const { db } = fakeDb([[{ id: "c1" }]]);

    await expect(resolveAdmissionsRole("  STAFF@Example.com ", db)).resolves.toBe("counselor");
  });
});

describe("requireAdmissionsSession", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("returns role admin for a legacy full-access admin (no role claim)", async () => {
    authMock.mockResolvedValue({ user: { email: "Admin@Example.com", name: "Admin", allowedPages: null } });

    await expect(requireAdmissionsSession()).resolves.toEqual({
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
    });
  });

  it("carries counselor/student/parent role claims through", async () => {
    for (const role of ["counselor", "student", "parent"] as const) {
      authMock.mockResolvedValue({
        user: { email: "u@example.com", name: "U", allowedPages: ["/admissions"], role },
      });
      await expect(requireAdmissionsSession()).resolves.toMatchObject({ role });
    }
  });

  it("throws Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null);

    await expect(requireAdmissionsSession()).rejects.toThrow("Unauthorized");
  });

  it("throws Forbidden when allowedPages excludes /admissions", async () => {
    authMock.mockResolvedValue({
      user: { email: "x@example.com", name: "X", allowedPages: ["/progress-tests"] },
    });

    await expect(requireAdmissionsSession()).rejects.toThrow("Forbidden");
  });

  it("throws Forbidden for an unknown role claim (teacher never maps upward)", async () => {
    authMock.mockResolvedValue({
      user: { email: "t@example.com", name: "T", allowedPages: null, role: "teacher" },
    });

    await expect(requireAdmissionsSession()).rejects.toThrow("Forbidden");
  });
});

describe("requireCaseAccess", () => {
  it("grants admins access to any case without a membership row (admin bypass)", async () => {
    const { db, selectCalls } = fakeDb([[{ id: "a1" }], [{ id: CASE_ID }]]);

    await expect(requireCaseAccess("admin@example.com", CASE_ID, "counselor", db)).resolves.toEqual({
      caseId: CASE_ID,
      email: "admin@example.com",
      role: "admin",
      isAdmin: true,
    });
    expect(selectCalls).toHaveLength(2);
  });

  it("throws NotFound for admins when the case does not exist", async () => {
    const { db } = fakeDb([[{ id: "a1" }], []]);

    await expect(requireCaseAccess("admin@example.com", CASE_ID, "parent", db)).rejects.toThrow("NotFound");
  });

  it("throws Forbidden (not NotFound) for non-admins when the case does not exist", async () => {
    const { db } = fakeDb([[], []]);

    await expect(requireCaseAccess("mom@example.com", CASE_ID, "parent", db)).rejects.toThrow("Forbidden");
  });

  it("grants an active counselor member with an active registry row", async () => {
    const { db } = fakeDb([[], [{ id: CASE_ID }], [{ role: "counselor" }], [{ id: "c1" }]]);

    await expect(requireCaseAccess("staff@example.com", CASE_ID, "counselor", db)).resolves.toEqual({
      caseId: CASE_ID,
      email: "staff@example.com",
      role: "counselor",
      isAdmin: false,
    });
  });

  it("throws Forbidden for a counselor member whose registry row is inactive (fail-closed)", async () => {
    const { db } = fakeDb([[], [{ id: CASE_ID }], [{ role: "counselor" }], []]);

    await expect(requireCaseAccess("staff@example.com", CASE_ID, "counselor", db)).rejects.toThrow("Forbidden");
  });

  it("throws Forbidden when the member row is revoked (active-status filter yields no row)", async () => {
    const { db } = fakeDb([[], [{ id: CASE_ID }], []]);

    await expect(requireCaseAccess("revoked@example.com", CASE_ID, "parent", db)).rejects.toThrow("Forbidden");
  });

  it("throws Forbidden for a member of a different case (cross-case denial)", async () => {
    // The membership query is scoped to THIS caseId, so a membership on some
    // other case yields no row here.
    const { db } = fakeDb([[], [{ id: CASE_ID }], []]);

    await expect(requireCaseAccess("othercase@example.com", CASE_ID, "student", db)).rejects.toThrow("Forbidden");
  });

  it("throws Forbidden when the member role is below minRole", async () => {
    const { db } = fakeDb([[], [{ id: CASE_ID }], [{ role: "student" }]]);

    await expect(requireCaseAccess("kid@example.com", CASE_ID, "counselor", db)).rejects.toThrow("Forbidden");
  });

  it("grants a student member at minRole student and a parent member at minRole parent", async () => {
    const student = fakeDb([[], [{ id: CASE_ID }], [{ role: "student" }]]);
    await expect(requireCaseAccess("kid@example.com", CASE_ID, "student", student.db)).resolves.toMatchObject({
      role: "student",
      isAdmin: false,
    });

    const parent = fakeDb([[], [{ id: CASE_ID }], [{ role: "parent" }]]);
    await expect(requireCaseAccess("mom@example.com", CASE_ID, "parent", parent.db)).resolves.toMatchObject({
      role: "parent",
      isAdmin: false,
    });
  });

  it("throws Unauthorized for an empty email without querying", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(requireCaseAccess("  ", CASE_ID, "parent", db)).rejects.toThrow("Unauthorized");
    expect(selectCalls).toHaveLength(0);
  });

  it("throws Forbidden for a malformed caseId without querying (no 500 leak)", async () => {
    const { db, selectCalls } = fakeDb([]);

    await expect(requireCaseAccess("mom@example.com", "not-a-uuid", "parent", db)).rejects.toThrow("Forbidden");
    expect(selectCalls).toHaveLength(0);
  });

  it("normalizes the email onto the returned access", async () => {
    const { db } = fakeDb([[], [{ id: CASE_ID }], [{ role: "parent" }]]);

    const access = await requireCaseAccess("  MOM@Example.com ", CASE_ID, "parent", db);

    expect(access.email).toBe("mom@example.com");
  });
});

describe("admissionsErrorResponse", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("maps Unauthorized to 401", async () => {
    const response = admissionsErrorResponse("/api/admissions/cases", new Error("Unauthorized"), "fallback");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("maps Forbidden to 403", async () => {
    const response = admissionsErrorResponse("/api/admissions/cases", new Error("Forbidden"), "fallback");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("maps NotFound to 404", async () => {
    const response = admissionsErrorResponse("/api/admissions/cases", new Error("NotFound"), "fallback");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("maps Conflict to 409", async () => {
    const response = admissionsErrorResponse("/api/admissions/cases", new Error("Conflict"), "fallback");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Conflict" });
  });

  it("returns 500 with the error message for unexpected errors and logs them", async () => {
    const response = admissionsErrorResponse("/api/admissions/cases", new Error("boom"), "fallback");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "boom" });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 500 with the fallback message for non-Error values", async () => {
    const response = admissionsErrorResponse("/api/admissions/cases", "weird", "fallback");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "fallback" });
  });

  it("rethrows HANGING_PROMISE_REJECTION digests untouched", () => {
    const hanging = { digest: "HANGING_PROMISE_REJECTION" };

    expect(() => admissionsErrorResponse("/api/admissions/cases", hanging, "fallback")).toThrow();
  });
});
