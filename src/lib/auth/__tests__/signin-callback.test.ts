import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/sales-dashboard/google-oauth", () => ({
  storeGoogleOAuthTokenForUser: vi.fn(),
}));
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  }),
}));
vi.mock("next-auth/providers/google", () => ({
  default: () => ({
    id: "google",
    name: "Google",
    type: "oauth",
  }),
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();

  return {
    ...actual,
    eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  };
});

import { signInCallback } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { eq } from "drizzle-orm";

describe("signInCallback — TCOV-06 part 1 (allowlist)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([{ email: "kevhsh7@gmail.com" }]),
          }),
        }),
      }),
    } as never);
  });

  it("admits an allowlisted user", async () => {
    const ok = await signInCallback({ user: { email: "kevhsh7@gmail.com" } });

    expect(ok).toBe(true);
  });

  it("normalizes email casing and surrounding whitespace before allowlist lookup", async () => {
    const ok = await signInCallback({ user: { email: "  KevHSH7@Gmail.Com  " } });

    expect(ok).toBe(true);
    expect(eq).toHaveBeenCalledWith(expect.anything(), "kevhsh7@gmail.com");
  });

  it("rejects a non-allowlisted user", async () => {
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as never);

    const ok = await signInCallback({ user: { email: "evil@example.com" } });

    expect(ok).toBe(false);
  });

  it("rejects when email is missing without calling DB", async () => {
    const dbSpy = vi.fn(() => {
      throw new Error("getDb should not be called");
    });
    vi.mocked(getDb).mockImplementation(dbSpy);

    const ok = await signInCallback({ user: { email: null } });

    expect(ok).toBe(false);
    expect(dbSpy).not.toHaveBeenCalled();
  });
});
