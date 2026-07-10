import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/progress-tests/teacher-access", () => ({ resolveTeacherCanonicalKeys: vi.fn() }));
// The real module pulls @/lib/auth (NextAuth instantiation) transitively; stub
// it so resolveUserAccess's resolution ORDER can be unit-tested in isolation.
vi.mock("@/lib/admissions/access", () => ({ resolveAdmissionsRole: vi.fn() }));

import { resolveUserAccess } from "@/lib/auth-access";
import { resolveAdmissionsRole } from "@/lib/admissions/access";
import { resolveTeacherCanonicalKeys } from "@/lib/progress-tests/teacher-access";

/** Chainable fake whose admin_users lookup resolves to `adminRows`. */
function fakeDb(adminRows: unknown[]) {
  const b: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit"]) b[method] = () => b;
  (b as { then: unknown }).then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve(adminRows).then(resolve, reject);
  return { select: () => b } as never;
}

describe("resolveUserAccess", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveAdmissionsRole).mockResolvedValue(null);
    vi.mocked(resolveTeacherCanonicalKeys).mockResolvedValue([]);
  });

  it("returns admin (full access) for an admin_users row with null allowedPages", async () => {
    const access = await resolveUserAccess("kevhsh7@gmail.com", fakeDb([{ allowedPages: null }]));

    expect(access).toEqual({ role: "admin", allowedPages: null });
    expect(resolveAdmissionsRole).not.toHaveBeenCalled();
    expect(resolveTeacherCanonicalKeys).not.toHaveBeenCalled();
  });

  it("returns admin restricted to its allowedPages (e.g. m.giftwan)", async () => {
    const access = await resolveUserAccess("m.giftwan@gmail.com", fakeDb([{ allowedPages: ["/progress-tests"] }]));

    expect(access).toEqual({ role: "admin", allowedPages: ["/progress-tests"] });
  });

  it("returns a counselor restricted to /admissions, without consulting the teacher lookup", async () => {
    vi.mocked(resolveAdmissionsRole).mockResolvedValue("counselor");

    const db = fakeDb([]);
    const access = await resolveUserAccess("Staff@Example.com ", db);

    expect(access).toEqual({ role: "counselor", allowedPages: ["/admissions"] });
    expect(resolveAdmissionsRole).toHaveBeenCalledWith("staff@example.com", db);
    expect(resolveTeacherCanonicalKeys).not.toHaveBeenCalled();
  });

  it("returns a teacher restricted to /progress-tests when a non-admin matches a tutor contact", async () => {
    vi.mocked(resolveTeacherCanonicalKeys).mockResolvedValue(["Aey"]);

    const access = await resolveUserAccess("aey@example.com", fakeDb([]));

    expect(access).toEqual({ role: "teacher", allowedPages: ["/progress-tests"] });
  });

  it("lets teacher win over an admissions student membership (design §2.1 step 3 before 4)", async () => {
    vi.mocked(resolveAdmissionsRole).mockResolvedValue("student");
    vi.mocked(resolveTeacherCanonicalKeys).mockResolvedValue(["Aey"]);

    const access = await resolveUserAccess("aey@example.com", fakeDb([]));

    expect(access).toEqual({ role: "teacher", allowedPages: ["/progress-tests"] });
  });

  it("returns a student restricted to /admissions from an active case membership", async () => {
    vi.mocked(resolveAdmissionsRole).mockResolvedValue("student");

    const access = await resolveUserAccess("kid@example.com", fakeDb([]));

    expect(access).toEqual({ role: "student", allowedPages: ["/admissions"] });
  });

  it("returns a parent restricted to /admissions from an active case membership", async () => {
    vi.mocked(resolveAdmissionsRole).mockResolvedValue("parent");

    const access = await resolveUserAccess("mom@example.com", fakeDb([]));

    expect(access).toEqual({ role: "parent", allowedPages: ["/admissions"] });
  });

  it("denies (null) when neither admin, counselor, tutor, nor case member", async () => {
    const access = await resolveUserAccess("stranger@example.com", fakeDb([]));

    expect(access).toBeNull();
  });

  it("denies an empty email without any lookup", async () => {
    const access = await resolveUserAccess("   ", fakeDb([]));

    expect(access).toBeNull();
    expect(resolveAdmissionsRole).not.toHaveBeenCalled();
    expect(resolveTeacherCanonicalKeys).not.toHaveBeenCalled();
  });
});
