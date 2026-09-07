import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import { auth } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/admin-users/access";
import { isSuperAdminEmail } from "@/lib/admin-users/policy";

function fakeDb(rows: unknown[]) {
  const b: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit"]) b[method] = () => b;
  b.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return { select: () => b } as never;
}

const env = { SUPER_ADMIN_EMAILS: "  Kevin@example.com, other@example.com " };

describe("owner-only access management", () => {
  beforeEach(() => vi.resetAllMocks());

  it("normalizes configured emails and fails closed on missing configuration", () => {
    expect(isSuperAdminEmail(" KEVIN@EXAMPLE.COM ", env)).toBe(true);
    expect(isSuperAdminEmail("aoeng@example.com", env)).toBe(false);
    expect(isSuperAdminEmail("kevin@example.com", {})).toBe(false);
  });

  it("requires a session and rejects an ordinary website admin", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    await expect(requireSuperAdmin(fakeDb([]), env)).rejects.toMatchObject({ status: 401 });
    vi.mocked(auth).mockResolvedValue({ user: { email: "aoeng@example.com", role: "admin", adminAccessVersion: 0 } } as never);
    await expect(requireSuperAdmin(fakeDb([]), env)).rejects.toMatchObject({ status: 403 });
  });

  it("requires both owner configuration and current enabled admin status", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: "Kevin@example.com", role: "admin", adminAccessVersion: 0 } } as never);
    await expect(requireSuperAdmin(fakeDb([{ disabled: false, accessVersion: 0 }]), env)).resolves.toMatchObject({ email: "kevin@example.com", accessVersion: 0 });
    await expect(requireSuperAdmin(fakeDb([]), env)).rejects.toMatchObject({ status: 403 });
    await expect(requireSuperAdmin(fakeDb([{ disabled: true, accessVersion: 0 }]), env)).rejects.toMatchObject({ status: 403 });
    await expect(requireSuperAdmin(fakeDb([{ disabled: false, accessVersion: 2 }]), env)).rejects.toMatchObject({ status: 403 });
  });
});
