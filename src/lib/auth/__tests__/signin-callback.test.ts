import { describe, it, expect, beforeEach, vi } from "vitest";

// signInCallback now delegates the admin/teacher decision to resolveUserAccess;
// stub it (and NextAuth's instantiation) so we test the delegation contract.
// The admissions invite-activation hook (PRD §3.7) is stubbed so its call
// order and failure isolation are observable without a database.
vi.mock("@/lib/auth-access", () => ({ resolveUserAccess: vi.fn() }));
vi.mock("@/lib/admissions/members", () => ({ activateMembershipsForEmail: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ validateSessionAccess: vi.fn() }));
vi.mock("@/lib/sales-dashboard/google-oauth", () => ({ storeGoogleOAuthTokenForUser: vi.fn() }));
const { rawAuth } = vi.hoisted(() => ({ rawAuth: vi.fn() }));
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: rawAuth,
  }),
}));
vi.mock("next-auth/providers/google", () => ({
  default: () => ({ id: "google", name: "Google", type: "oauth" }),
}));

import { auth, authConfig, signInCallback } from "@/lib/auth";
import { resolveUserAccess } from "@/lib/auth-access";
import { activateMembershipsForEmail } from "@/lib/admissions/members";
import { validateSessionAccess } from "@/lib/auth-session";
import { storeGoogleOAuthTokenForUser } from "@/lib/sales-dashboard/google-oauth";

describe("signInCallback — TCOV-06 (admin allowlist + teacher access)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(activateMembershipsForEmail).mockResolvedValue([]);
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
    expect(activateMembershipsForEmail).not.toHaveBeenCalled();
  });
});

describe("Auth.js revocation and preview callbacks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(activateMembershipsForEmail).mockResolvedValue([]);
  });

  it("sets an admin version only at fresh sign-in and preserves stale/unversioned tokens", async () => {
    vi.mocked(resolveUserAccess).mockResolvedValue({ role: "admin", allowedPages: null, adminAccessVersion: 4 });
    const signedIn = await authConfig.callbacks.jwt({ token: {}, user: { email: "owner@example.com" } } as never);
    expect(signedIn.adminAccessVersion).toBe(4);
    vi.mocked(resolveUserAccess).mockClear();
    const old = { role: "admin", adminAccessVersion: 0 };
    expect(await authConfig.callbacks.jwt({ token: old } as never)).toEqual(old);
    expect(await authConfig.callbacks.jwt({ token: { role: "admin" } } as never)).not.toHaveProperty("adminAccessVersion");
    expect(resolveUserAccess).not.toHaveBeenCalled();
  });

  it("passes the immutable access version into the session", async () => {
    const result = await authConfig.callbacks.session({ session: { user: {} }, token: { role: "admin", adminAccessVersion: 7 } } as never);
    expect(result.user).toMatchObject({ role: "admin", adminAccessVersion: 7 });
  });

  it("independently applies the fresh guard to every server auth call", async () => {
    const stale = { user: { email: "aoeng@example.com", role: "admin", adminAccessVersion: 0 } };
    rawAuth.mockResolvedValue(stale);
    vi.mocked(validateSessionAccess).mockResolvedValue(null);
    expect(await auth()).toBeNull();
    expect(validateSessionAccess).toHaveBeenCalledWith(stale);
  });

  it("never stores Google integration tokens in preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(resolveUserAccess).mockResolvedValue({ role: "admin", allowedPages: null, adminAccessVersion: 0 });
    expect(await authConfig.callbacks.signIn({ user: { email: "aoeng@example.com" }, account: { access_token: "preview-identity-token" } } as never)).toBe(true);
    expect(storeGoogleOAuthTokenForUser).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("signInCallback — admissions invite activation (PRD §3.7)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(activateMembershipsForEmail).mockResolvedValue([]);
  });

  it("activates invited memberships BEFORE resolving access, so a freshly invited member is admitted on their first sign-in", async () => {
    const order: string[] = [];
    vi.mocked(activateMembershipsForEmail).mockImplementation(async () => {
      order.push("activate");
      return [];
    });
    vi.mocked(resolveUserAccess).mockImplementation(async () => {
      order.push("resolve");
      return { role: "student", allowedPages: ["/admissions"] };
    });

    const ok = await signInCallback({ user: { email: "kid@example.com" } });

    expect(ok).toBe(true);
    expect(activateMembershipsForEmail).toHaveBeenCalledWith("kid@example.com");
    expect(order).toEqual(["activate", "resolve"]);
  });

  it("never blocks an existing user when activation throws (failure isolated)", async () => {
    vi.mocked(activateMembershipsForEmail).mockRejectedValue(new Error("db down"));
    vi.mocked(resolveUserAccess).mockResolvedValue({ role: "admin", allowedPages: null });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const ok = await signInCallback({ user: { email: "kevhsh7@gmail.com" } });

    expect(ok).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("still denies an invited-only email when activation fails (fail-closed)", async () => {
    vi.mocked(activateMembershipsForEmail).mockRejectedValue(new Error("db down"));
    vi.mocked(resolveUserAccess).mockResolvedValue(null);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const ok = await signInCallback({ user: { email: "kid@example.com" } });

    expect(ok).toBe(false);
    consoleError.mockRestore();
  });
});
