import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { beginFeedbackEmailOAuth, verifyFeedbackEmailState } from "../gmail-connection";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-encryption-secret");
  vi.stubEnv("POST_CLASS_GMAIL_CLIENT_ID", "dedicated-client");
  vi.stubEnv("POST_CLASS_GMAIL_CLIENT_SECRET", "dedicated-secret");
  vi.stubEnv("POST_CLASS_GMAIL_WORKSPACE_TRUSTED", "true");
  vi.stubEnv("APP_BASE_URL", "https://bgscheduler.vercel.app");
});
afterEach(() => vi.unstubAllEnvs());
describe("dedicated Gmail OAuth", () => {
  it("requests only sender scopes, offline access and PKCE for the fixed mailbox", () => {
    const result = beginFeedbackEmailOAuth("owner@example.com", "https://bgscheduler.vercel.app") as { url: string; cookie: string };
    const p = new URL(result.url).searchParams;
    expect(p.get("scope")?.split(" ").sort()).toEqual(["email", "https://www.googleapis.com/auth/gmail.send", "openid"]);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("login_hint")).toBe("admin@begiftededucation.com");
    expect(p.get("redirect_uri")).toBe("https://bgscheduler.vercel.app/api/post-class-feedback/email/callback");
    const state = verifyFeedbackEmailState(result.cookie, p.get("state")!, "owner@example.com") as { verifier: string };
    expect(state.verifier.length).toBeGreaterThan(43);
  });
  it("binds state to the initiating manager and rejects tampering and expiry", () => {
    const result = beginFeedbackEmailOAuth("owner@example.com", "https://bgscheduler.vercel.app") as { url: string; cookie: string };
    const state = new URL(result.url).searchParams.get("state")!;
    expect(() => verifyFeedbackEmailState(result.cookie, state, "other@example.com")).toThrow();
    expect(() => verifyFeedbackEmailState(result.cookie, "different", "owner@example.com")).toThrow();
    expect(() => verifyFeedbackEmailState(result.cookie + "changed", state, "owner@example.com")).toThrow();
    expect(() => verifyFeedbackEmailState(result.cookie, state, "owner@example.com", Date.now() + 601_000)).toThrow();
  });
  it.each(["preview", "untrusted", "wrong-origin"])("refuses %s authorization before exposing an OAuth URL", (kind) => {
    if (kind === "preview") vi.stubEnv("VERCEL_ENV", "preview");
    if (kind === "untrusted") vi.stubEnv("POST_CLASS_GMAIL_WORKSPACE_TRUSTED", "false");
    expect(() => beginFeedbackEmailOAuth("owner@example.com", kind === "wrong-origin" ? "https://attacker.example" : "https://bgscheduler.vercel.app")).toThrow();
  });
});
