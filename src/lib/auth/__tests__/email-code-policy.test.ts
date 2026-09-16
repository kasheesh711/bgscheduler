import { afterEach, describe, expect, it, vi } from "vitest";
import { emailCodeBinding, emailCodeEnabled, emailCodeHash, emailCodeIp, emailCodeSameOrigin, equalDigest } from "../email-code-policy";
import { loginDestination } from "../login-destination";
afterEach(() => vi.unstubAllEnvs());
describe("email code boundaries", () => {
  it("requires enablement and excludes previews", () => {
    vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "false"); expect(emailCodeEnabled()).toBe(false);
    vi.stubEnv("AUTH_EMAIL_CODE_ENABLED", "true"); expect(emailCodeEnabled()).toBe(true);
    vi.stubEnv("VERCEL_ENV", "preview"); expect(emailCodeEnabled()).toBe(false);
    vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("PREVIEW_SANDBOX_ENABLED", "true"); expect(emailCodeEnabled()).toBe(false);
  });
  it("separates keyed digests by purpose and challenge", () => {
    vi.stubEnv("AUTH_SECRET", "test-only-email-key");
    const a = emailCodeHash("code", "a", "head@hotmail.com", "000001");
    expect(equalDigest(a, a)).toBe(true);
    expect(equalDigest(a, emailCodeHash("code", "b", "head@hotmail.com", "000001"))).toBe(false);
    expect(equalDigest(a, emailCodeHash("binding", "a", "head@hotmail.com", "000001"))).toBe(false);
    expect(equalDigest(a, "bad")).toBe(false);
  });
  it("requires an exact origin and browser binding", () => {
    const url = "https://bgscheduler.vercel.app/api/auth/email-code/request";
    expect(emailCodeSameOrigin(new Request(url))).toBe(false);
    expect(emailCodeSameOrigin(new Request(url, { headers: { origin: "https://evil.example" } }))).toBe(false);
    expect(emailCodeSameOrigin(new Request(url, { headers: { origin: "https://bgscheduler.vercel.app" } }))).toBe(true);
    expect(emailCodeBinding(new Request(url, { headers: { cookie: "bgs-email-code=" + "a".repeat(43) } }))).toBe("a".repeat(43));
    expect(emailCodeBinding(new Request(url, { headers: { cookie: "bgs-email-code=broken" } }))).toBeNull();
  });
  it("trusts only the Vercel-sanitized IP header on Vercel", () => {
    const request = new Request("https://test.local", { headers: { "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.8.8", "x-vercel-forwarded-for": "1.1.1.1" } });
    expect(emailCodeIp(request)).toBe("unknown"); vi.stubEnv("VERCEL", "1");
    expect(emailCodeIp(request)).toBe("1.1.1.1");
  });
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/\nevil.example", null])("rejects unsafe destination %s", (value) => {
    expect(loginDestination(value)).toBe("/");
  });
  it("preserves deep links", () => expect(loginDestination("/tutor-sit-ins?quarter=2026-Q4")).toBe("/tutor-sit-ins?quarter=2026-Q4"));
});
