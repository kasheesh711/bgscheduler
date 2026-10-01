import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../grants", async (original) => {
  const actual = await original<typeof import("../grants")>();
  return { ...actual, hasRemovalGrant: vi.fn() };
});

import { auth } from "@/lib/auth";
import { hasRemovalGrant } from "../grants";
import { requireTutorOffboardingAdmin, viewerForEmail } from "../access";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasRemovalGrant).mockResolvedValue(false);
});

describe("Tutor Offboarding access", () => {
  it("rejects signed-out and non-admin viewers before reading grants", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(requireTutorOffboardingAdmin()).rejects.toMatchObject({ status: 401 });
    vi.mocked(auth).mockResolvedValue({ user: { email: "student@example.com", role: "student" } } as never);
    await expect(requireTutorOffboardingAdmin()).rejects.toMatchObject({ status: 403 });
    expect(hasRemovalGrant).not.toHaveBeenCalled();
  });

  it("normalizes admin identity and keeps owner status separate from the removal grant", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { email: " OWNER@Example.com ", role: "admin" } } as never);
    expect(await requireTutorOffboardingAdmin(undefined, { SUPER_ADMIN_EMAILS: "owner@example.com" }))
      .toEqual({ email: "owner@example.com", isOwner: true, canRemove: false });
    vi.mocked(hasRemovalGrant).mockResolvedValue(true);
    expect(await viewerForEmail("ops@example.com", undefined, { SUPER_ADMIN_EMAILS: "owner@example.com" }))
      .toEqual({ email: "ops@example.com", isOwner: false, canRemove: true });
  });

  it("fails closed on missing grant schema and propagates other database failures", async () => {
    vi.mocked(hasRemovalGrant).mockRejectedValue({ cause: { code: "42P01" } });
    expect(await viewerForEmail("ops@example.com")).toMatchObject({ canRemove: false });
    const error = new Error("relation does not exist");
    vi.mocked(hasRemovalGrant).mockRejectedValue(error);
    await expect(viewerForEmail("ops@example.com")).rejects.toBe(error);
  });
});
