import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/tutor-sit-ins/calendar/connect/route";
import { GET as microsoftCallback } from "@/app/api/tutor-sit-ins/calendar/microsoft/callback/route";
import { GET as googleCallback } from "@/app/api/tutor-sit-ins/calendar/callback/route";
import { requireSitInAccess } from "../access";
import { beginCalendarOAuth, finishCalendarOAuth, OAUTH_COOKIE } from "../calendar";
vi.mock("../access", () => ({ requireSitInAccess: vi.fn() }));
vi.mock("../calendar", async (original) => ({ ...(await original<typeof import("../calendar")>()), finishCalendarOAuth: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSitInAccess).mockResolvedValue({ email: "head@hotmail.com", role: "observer", departments: ["physics"], canonicalKey: "head" });
  for (const [key, value] of Object.entries({ APP_BASE_URL: "https://app.test", AUTH_SECRET: "route-test-secret", AUTH_GOOGLE_ID: "google-client", AUTH_GOOGLE_SECRET: "google-secret", TUTOR_SIT_INS_ENABLED: "true", TUTOR_SIT_INS_MICROSOFT_ENABLED: "true", TUTOR_SIT_INS_MICROSOFT_CLIENT_ID: "ms-client", TUTOR_SIT_INS_MICROSOFT_CLIENT_SECRET: "ms-secret", VERCEL_ENV: "development", PREVIEW_SANDBOX_ENABLED: "false" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
function request(body: string, origin = "https://app.test") {
  return new Request("https://app.test/api/tutor-sit-ins/calendar/connect", { method: "POST", headers: { origin }, body });
}
function callbackRequest(provider: "google" | "microsoft", query: Record<string, string>) {
  const begin = beginCalendarOAuth("head@hotmail.com", "https://app.test", provider);
  const state = new URL(begin.url).searchParams.get("state")!;
  return new NextRequest("https://app.test/api/tutor-sit-ins/calendar/" + (provider === "microsoft" ? "microsoft/" : "") + "callback?" + new URLSearchParams({ state, ...query }), { headers: { cookie: OAUTH_COOKIE + "=" + begin.cookie } });
}
describe("provider-specific OAuth HTTP boundaries", () => {
  it.each(["", "{}"])("preserves Google compatibility for omitted provider (%s)", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect((await response.json()).url).toContain("accounts.google.com");
  });
  it("starts Microsoft common-tenant PKCE consent with a secure scoped cookie", async () => {
    const response = await POST(request('{"provider":"microsoft"}'));
    expect(response.status).toBe(200);
    expect((await response.json()).url).toContain("login.microsoftonline.com/common");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("Path=/api/tutor-sit-ins/calendar");
  });
  it("rejects cross-origin, unknown providers and preview connections", async () => {
    expect((await POST(request('{}', "https://evil.test"))).status).toBe(403);
    expect((await POST(request('{"provider":"unknown"}'))).status).toBe(400);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await POST(request('{"provider":"microsoft"}'))).status).toBe(503);
  });
  it("handles consent cancellation without storing credentials or leaking provider errors", async () => {
    const response = await microsoftCallback(callbackRequest("microsoft", { error: "access_denied", error_description: "private provider details" }));
    expect(finishCalendarOAuth).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("https://app.test/tutor-sit-ins?calendar=error");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("pins callback to provider, browser state and signed-in email", async () => {
    const wrongRoute = callbackRequest("microsoft", { code: "private-code" });
    expect((await googleCallback(wrongRoute)).headers.get("location")).toContain("calendar=error");
    vi.mocked(requireSitInAccess).mockResolvedValue({ email: "other@hotmail.com", role: "observer", departments: ["physics"], canonicalKey: "other" });
    expect((await microsoftCallback(callbackRequest("microsoft", { code: "private-code" }))).headers.get("location")).toContain("calendar=error");
    expect(finishCalendarOAuth).not.toHaveBeenCalled();
  });
  it("finishes verified consent without putting its code in the redirect", async () => {
    const response = await microsoftCallback(callbackRequest("microsoft", { code: "private-code" }));
    expect(finishCalendarOAuth).toHaveBeenCalledWith("head@hotmail.com", "private-code", expect.objectContaining({ provider: "microsoft" }));
    expect(response.headers.get("location")).toBe("https://app.test/tutor-sit-ins?calendar=connected");
  });
});
