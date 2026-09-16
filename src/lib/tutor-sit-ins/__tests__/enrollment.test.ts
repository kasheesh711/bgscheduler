import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUserAccess } from "@/lib/auth-access";
import { sitInGrant } from "../access";
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/admissions/access", () => ({
  resolveAdmissionsRole: vi.fn(async () => null),
}));
vi.mock("@/lib/progress-tests/teacher-access", () => ({
  resolveTeacherCanonicalKeys: vi.fn(async () => []),
}));
vi.mock("@/lib/tutor-attendance/access", () => ({
  attendanceEnrollmentForEmail: vi.fn(async () => null),
}));
vi.mock("../access", () => ({ sitInGrant: vi.fn() }));
function database(adminRows: unknown[] = []) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => adminRows,
  };
  return { select: () => chain } as never;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TUTOR_SIT_INS_ENABLED", "true");
  vi.mocked(sitInGrant).mockResolvedValue({
    email: "head@hotmail.com",
    active: true,
    role: "observer",
  } as Awaited<ReturnType<typeof sitInGrant>>);
});
afterEach(() => vi.unstubAllEnvs());
describe("Google sign-in enrollment for observations", () => {
  it("enrolls an explicitly granted Google email only in Tutor Sit-ins", async () => {
    expect(await resolveUserAccess("Head@Hotmail.com ", database())).toEqual({
      role: "teacher",
      allowedPages: ["/tutor-sit-ins"],
    });
    expect(sitInGrant).toHaveBeenCalledWith(
      "head@hotmail.com",
      expect.anything(),
    );
  });
  it("does not bypass a disabled administrator or change an existing page restriction", async () => {
    expect(
      await resolveUserAccess(
        "head@hotmail.com",
        database([{ disabled: true, allowedPages: null, accessVersion: 2 }]),
      ),
    ).toBeNull();
    expect(sitInGrant).not.toHaveBeenCalled();
    expect(
      await resolveUserAccess(
        "head@hotmail.com",
        database([
          { disabled: false, allowedPages: ["/search"], accessVersion: 3 },
        ]),
      ),
    ).toEqual({
      role: "admin",
      allowedPages: ["/search"],
      adminAccessVersion: 3,
    });
  });
  it("denies ungranted identities and leaves enrollment off until enabled", async () => {
    vi.mocked(sitInGrant).mockResolvedValue(null);
    expect(await resolveUserAccess("head@hotmail.com", database())).toBeNull();
    vi.clearAllMocks();
    vi.stubEnv("TUTOR_SIT_INS_ENABLED", "false");
    expect(await resolveUserAccess("head@hotmail.com", database())).toBeNull();
    expect(sitInGrant).not.toHaveBeenCalled();
  });
});
