import { describe, it, expect, beforeEach, vi } from "vitest";

// signInCallback now delegates the admin/teacher decision to resolveUserAccess;
// stub it (and NextAuth's instantiation) so we test the delegation contract.
vi.mock("@/lib/auth-access", () => ({ resolveUserAccess: vi.fn() }));
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  }),
}));
vi.mock("next-auth/providers/google", () => ({
  default: () => ({ id: "google", name: "Google", type: "oauth" }),
}));

import { signInCallback } from "@/lib/auth";
import { resolveUserAccess } from "@/lib/auth-access";

describe("signInCallback — TCOV-06 (admin allowlist + teacher access)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("admits a recognized admin", async () => {
    vi.mocked(resolveUserAccess).mockResolvedValue({ role: "admin", allowedPages: null });

    const ok = await signInCallback({ user: { email: "kevhsh7@gmail.com" } });

    expect(ok).toBe(true);
    expect(resolveUserAccess).toHaveBeenCalledWith("kevhsh7@gmail.com");
  });

  it("admits a recognized teacher", async () => {
    vi.mocked(resolveUserAccess).mockResolvedValue({ role: "teacher", allowedPages: ["/progress-tests"] });

    const ok = await signInCallback({ user: { email: "aey@example.com" } });

    expect(ok).toBe(true);
  });

  it("rejects a user resolveUserAccess denies", async () => {
    vi.mocked(resolveUserAccess).mockResolvedValue(null);

    const ok = await signInCallback({ user: { email: "evil@example.com" } });

    expect(ok).toBe(false);
  });

  it("rejects when the email is missing", async () => {
    vi.mocked(resolveUserAccess).mockResolvedValue(null);

    const ok = await signInCallback({ user: { email: null } });

    expect(ok).toBe(false);
  });
});
