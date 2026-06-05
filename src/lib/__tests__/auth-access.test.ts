import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/progress-tests/teacher-access", () => ({ resolveTeacherCanonicalKeys: vi.fn() }));

import { resolveUserAccess } from "@/lib/auth-access";
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
  });

  it("returns admin (full access) for an admin_users row with null allowedPages", async () => {
    const access = await resolveUserAccess("kevhsh7@gmail.com", fakeDb([{ allowedPages: null }]));

    expect(access).toEqual({ role: "admin", allowedPages: null });
    expect(resolveTeacherCanonicalKeys).not.toHaveBeenCalled();
  });

  it("returns admin restricted to its allowedPages (e.g. m.giftwan)", async () => {
    const access = await resolveUserAccess("m.giftwan@gmail.com", fakeDb([{ allowedPages: ["/progress-tests"] }]));

    expect(access).toEqual({ role: "admin", allowedPages: ["/progress-tests"] });
  });

  it("returns a teacher restricted to /progress-tests when a non-admin matches a tutor contact", async () => {
    vi.mocked(resolveTeacherCanonicalKeys).mockResolvedValue(["Aey"]);

    const access = await resolveUserAccess("aey@example.com", fakeDb([]));

    expect(access).toEqual({ role: "teacher", allowedPages: ["/progress-tests"] });
  });

  it("denies (null) when neither an admin nor a known tutor", async () => {
    vi.mocked(resolveTeacherCanonicalKeys).mockResolvedValue([]);

    const access = await resolveUserAccess("stranger@example.com", fakeDb([]));

    expect(access).toBeNull();
  });

  it("denies an empty email without any lookup", async () => {
    const access = await resolveUserAccess("   ", fakeDb([]));

    expect(access).toBeNull();
    expect(resolveTeacherCanonicalKeys).not.toHaveBeenCalled();
  });
});
